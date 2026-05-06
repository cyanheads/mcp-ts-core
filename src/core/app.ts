/**
 * @fileoverview Application composition root. Constructs all services in
 * dependency order, initializes telemetry/logger, starts transport, and
 * registers shutdown/signal handlers. Returns a ServerHandle for lifecycle
 * management.
 * @module src/core/app
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { config, resetConfig } from '@/config/index.js';
import {
  buildServerManifest,
  type LandingConfig,
  type ServerManifest,
} from '@/core/serverManifest.js';
import { validateDefinitions } from '@/linter/validate.js';
import { PromptRegistry } from '@/mcp-server/prompts/prompt-registration.js';
import type { AnyPromptDefinition } from '@/mcp-server/prompts/utils/promptDefinition.js';
import { ResourceRegistry } from '@/mcp-server/resources/resource-registration.js';
import type { AnyResourceDefinition } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { RootsRegistry } from '@/mcp-server/roots/roots-registration.js';
import { createMcpServerInstance } from '@/mcp-server/server.js';
import { TaskManager } from '@/mcp-server/tasks/core/taskManager.js';
import type { AnyToolDef } from '@/mcp-server/tools/tool-registration.js';
import { ToolRegistry } from '@/mcp-server/tools/tool-registration.js';
import { initHeartbeatMetrics } from '@/mcp-server/transports/heartbeat.js';
import { initSessionMetrics } from '@/mcp-server/transports/http/sessionStore.js';
import { TransportManager } from '@/mcp-server/transports/manager.js';
import { createCanvasService } from '@/services/canvas/core/canvasFactory.js';
import type { DataCanvas } from '@/services/canvas/core/DataCanvas.js';
import type { ILlmProvider } from '@/services/llm/core/ILlmProvider.js';
import { OpenRouterProvider } from '@/services/llm/providers/openrouter.provider.js';
import { SpeechService } from '@/services/speech/core/SpeechService.js';
import type { SpeechProviderConfig } from '@/services/speech/types.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { createStorageProvider } from '@/storage/core/storageFactory.js';
import type { Database } from '@/storage/providers/supabase/supabase.types.js';
import { configurationError, JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { initErrorMetrics } from '@/utils/internal/error-handler/errorHandler.js';
import { logger, type McpLogLevel } from '@/utils/internal/logger.js';
import { initHandlerMetrics, initHighResTimer } from '@/utils/internal/performance.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { initHttpClientMetrics } from '@/utils/network/fetchWithTimeout.js';
import { schedulerService } from '@/utils/scheduling/scheduler.js';
import { initRateLimitMetrics, RateLimiter } from '@/utils/security/rateLimiter.js';
import {
  initializeOpenTelemetry,
  shutdownOpenTelemetry,
} from '@/utils/telemetry/instrumentation.js';
import { createObservableGauge } from '@/utils/telemetry/metrics.js';
import { withSpan } from '@/utils/telemetry/trace.js';

/**
 * Options affecting the `Context` object passed to every handler.
 * Surfaced via {@link CreateAppOptions.context}.
 */
export interface ContextOptions {
  /**
   * When `true`, `ctx.sessionId` is populated in stateless HTTP mode using
   * the per-request token the SDK generates. Default `false` — `ctx.sessionId`
   * is only defined when there is a durable session (HTTP `stateful` / `auto`
   * mode). Stdio handlers always see `undefined`.
   *
   * Opt in only when downstream code is structured around `ctx.sessionId`
   * and accepts that the value changes per-request under stateless mode. For
   * generic per-request correlation, use `ctx.requestId` (always present).
   */
  exposeStatelessSessionId?: boolean;
}

/** Options for {@link createApp}. All arrays default to empty. */
export interface CreateAppOptions {
  /** Options affecting the `Context` object passed to handlers. */
  context?: ContextOptions;
  /**
   * SEP-2133 extensions to advertise in server capabilities.
   * Keys are extension identifiers (`vendor-prefix/extension-name`).
   */
  extensions?: Record<string, object>;
  /**
   * Landing page configuration. Applies to the HTTP transport only.
   * See {@link LandingConfig} for the full shape — all fields optional,
   * sane defaults for everything.
   */
  landing?: LandingConfig;
  /** Server name — overrides package.json and MCP_SERVER_NAME env var. */
  name?: string;
  /** Prompt definitions. */
  prompts?: AnyPromptDefinition[];
  /** Resource definitions. */
  resources?: AnyResourceDefinition[];
  /** Runs after core services are constructed, before transport starts. */
  setup?: (core: CoreServices) => void | Promise<void>;
  /** Tool definitions (legacy, new-style, or task). */
  tools?: AnyToolDef[];
  /** Server version — overrides package.json and MCP_SERVER_VERSION env var. */
  version?: string;
}

/** Services available in the `setup()` callback and on ServerHandle. */
export interface CoreServices {
  /**
   * Optional DataCanvas primitive (issue #97). Present when
   * `CANVAS_PROVIDER_TYPE` is set to a supported engine (`duckdb`).
   * `undefined` when canvas is disabled (`'none'`, the default) or when
   * running on Cloudflare Workers (DuckDB has no V8-isolate build).
   */
  canvas?: DataCanvas;
  config: typeof config;
  llmProvider?: ILlmProvider;
  logger: typeof logger;
  rateLimiter: RateLimiter;
  speechService?: SpeechService;
  storage: StorageService;
  supabase?: SupabaseClient<Database>;
}

/** Handle returned by {@link createApp} for controlling the server lifecycle. */
export interface ServerHandle {
  /** Read-only access to core services for integration testing or embedding. */
  readonly services: CoreServices;
  /** Initiates graceful shutdown (stops transport, flushes OTEL, closes logger). */
  shutdown(signal?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal: shared service composition
// ---------------------------------------------------------------------------

/** @internal Result of composeServices — used by createApp and createWorkerHandler. */
export interface ComposedApp {
  coreServices: CoreServices;
  createServer: () => Promise<McpServer>;
  /** Lint warnings from definition validation (callers should log after logger init). */
  lintWarnings: string[];
  /**
   * Server manifest — the single source of truth for the `/mcp` status JSON,
   * the SEP-1649 Server Card at `/.well-known/mcp.json`, and the HTML landing
   * page at `/`.
   */
  manifest: ServerManifest;
  taskManager: TaskManager;
}

/**
 * Constructs core services, registries, and server factory.
 * Shared by createApp() (Node) and createWorkerHandler() (Workers).
 * Does NOT start transport, register signal handlers, or init OTEL/logger.
 * @internal
 */
export async function composeServices(options: CreateAppOptions = {}): Promise<ComposedApp> {
  const {
    tools = [],
    resources = [],
    prompts = [],
    extensions,
    landing,
    setup,
    context: contextOptions,
  } = options;

  // Validate definitions against MCP spec before proceeding
  const lintReport = validateDefinitions({
    tools,
    resources,
    prompts,
    ...(landing && { landing }),
  });
  const lintWarnings = lintReport.warnings.map((w) => `[mcp-lint] ${w.rule}: ${w.message}`);
  if (!lintReport.passed) {
    const summary = lintReport.errors.map((e) => `  - [${e.rule}] ${e.message}`).join('\n');
    throw configurationError(
      `MCP definition validation failed with ${lintReport.errors.length} error(s):\n${summary}`,
      { errors: lintReport.errors },
    );
  }

  // Persist name/version overrides to process.env so they survive resetConfig()
  // and are visible to OTEL, logger, and transport throughout the process lifetime.
  if (options.name || options.version) {
    if (typeof process !== 'undefined' && process.env) {
      if (options.name) {
        process.env.MCP_SERVER_NAME = options.name;
        process.env.OTEL_SERVICE_NAME ??= options.name;
      }
      if (options.version) {
        process.env.MCP_SERVER_VERSION = options.version;
        process.env.OTEL_SERVICE_VERSION ??= options.version;
      }
    }
    resetConfig();
  }

  // --- Core services ---

  let supabaseClient: SupabaseClient<Database> | undefined;
  if (config.storage.providerType === 'supabase') {
    if (!config.supabase?.url || !config.supabase?.serviceRoleKey) {
      throw configurationError('Supabase URL or service role key is missing for admin client.');
    }
    const { createClient } = await import('@supabase/supabase-js').catch(() => {
      throw configurationError(
        'Install "@supabase/supabase-js" to use Supabase storage: bun add @supabase/supabase-js',
      );
    });
    supabaseClient = createClient<Database>(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  const storageProvider = createStorageProvider(config, {
    ...(supabaseClient && { supabaseClient }),
  });
  const storageService = new StorageService(storageProvider);
  const rateLimiter = new RateLimiter(config, logger);

  // --- Optional services (constructed when config is present) ---

  let llmProvider: ILlmProvider | undefined;
  if (config.openrouterApiKey) {
    llmProvider = new OpenRouterProvider(rateLimiter, config, logger);
  }

  let speechService: SpeechService | undefined;
  if (config.speech) {
    const ttsConfig: SpeechProviderConfig | undefined = config.speech.tts?.enabled
      ? (config.speech.tts as SpeechProviderConfig)
      : undefined;
    const sttConfig: SpeechProviderConfig | undefined = config.speech.stt?.enabled
      ? (config.speech.stt as SpeechProviderConfig)
      : undefined;
    if (ttsConfig || sttConfig) {
      speechService = new SpeechService(ttsConfig, sttConfig);
    }
  }

  const canvas = createCanvasService(config);

  const coreServices: CoreServices = {
    config,
    logger,
    rateLimiter,
    storage: storageService,
    ...(canvas && { canvas }),
    ...(llmProvider && { llmProvider }),
    ...(speechService && { speechService }),
    ...(supabaseClient && { supabase: supabaseClient }),
  };

  // --- Server-specific setup ---
  // If the server's setup() throws a raw ZodError (e.g., from a
  // ServerConfigSchema.parse() call without framework helpers), convert it to
  // a ConfigurationError so downstream handlers can format it cleanly instead
  // of dumping a raw stack trace at process start.
  if (setup) {
    try {
      await setup(coreServices);
    } catch (err) {
      if (err instanceof z.ZodError) {
        const lines = err.issues.map((issue) => {
          const path = issue.path.join('.');
          return `  - ${path}: ${issue.message}`;
        });
        throw configurationError(
          `Server setup failed — config validation error:\n${lines.join('\n')}`,
          { issues: err.issues },
          { cause: err },
        );
      }
      throw err;
    }
  }

  // --- MCP services ---

  const taskManager = new TaskManager(config, storageService);

  const exposeStatelessSessionId = contextOptions?.exposeStatelessSessionId === true;
  const toolRegistry = new ToolRegistry(tools, {
    logger,
    storage: storageService,
    exposeStatelessSessionId,
  });
  const resourceRegistry = new ResourceRegistry(resources, {
    logger,
    storage: storageService,
    exposeStatelessSessionId,
  });
  const promptRegistry = new PromptRegistry(prompts, logger);
  const rootsRegistry = new RootsRegistry(logger);

  const createServer = () =>
    createMcpServerInstance({
      config,
      ...(extensions && { extensions }),
      promptRegistry,
      resourceRegistry,
      rootsRegistry,
      taskStore: taskManager.getTaskStore(),
      taskMessageQueue: taskManager.getMessageQueue(),
      toolRegistry,
    });

  const manifest = buildServerManifest({
    config,
    tools,
    resources,
    prompts,
    ...(extensions && { extensions }),
    ...(landing && { landing }),
  });

  return {
    coreServices,
    createServer,
    manifest,
    lintWarnings,
    taskManager,
  };
}

// ---------------------------------------------------------------------------
// Public: createApp()
// ---------------------------------------------------------------------------

/**
 * Suppresses ANSI color codes for MCP client compatibility.
 */
function suppressColors(): void {
  const transportType = process.env.MCP_TRANSPORT_TYPE?.toLowerCase();
  const isStdioMode = !transportType || transportType === 'stdio';
  const isHttpModeWithoutTty = transportType === 'http' && !process.stdout.isTTY;

  if (isStdioMode || isHttpModeWithoutTty) {
    process.env.NO_COLOR = '1';
    process.env.FORCE_COLOR = '0';
  }
}

/**
 * Writes a user-friendly banner to stderr for startup-time configuration errors,
 * hiding the framework stack trace behind `DEBUG=true`. Meant to replace the raw
 * ZodError/stack dump that Node prints for unhandled rejections during `createApp`.
 */
function printStartupConfigError(err: McpError): void {
  const isDebug = !!process.env.DEBUG;
  const divider = '-'.repeat(60);
  const lines = [
    '',
    divider,
    ' Configuration error — server failed to start',
    divider,
    err.message,
    '',
    'Check your .env file or environment variables, then retry.',
  ];
  if (!isDebug) {
    lines.push('Set DEBUG=true for the full stack trace.');
  }
  lines.push(divider, '');

  process.stderr.write(`${lines.join('\n')}\n`);

  if (isDebug) {
    if (err.data) {
      process.stderr.write(`Data: ${JSON.stringify(err.data, null, 2)}\n`);
    }
    if (err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
  }
}

/**
 * Composes the application, initializes all services, starts transport,
 * and registers signal/error handlers. This is the complete entry point
 * for a Node.js MCP server process.
 *
 * @param options - Definition arrays, name/version overrides, and setup callback.
 *                  All arrays default to empty.
 * @returns A {@link ServerHandle} with `shutdown()` and `services`.
 * @throws {McpError} If config parsing or service construction fails.
 */
export async function createApp(options: CreateAppOptions = {}): Promise<ServerHandle> {
  suppressColors();

  // --- Compose services (handles env overrides internally for config parsing) ---
  // Configuration errors at this stage (from the definition linter, server
  // setup(), or missing required env vars) are startup-fatal. Print a clean
  // banner and exit rather than letting the raw error dump to stderr.
  let composed: ComposedApp;
  try {
    composed = await composeServices(options);
  } catch (err) {
    if (err instanceof McpError && err.code === JsonRpcErrorCode.ConfigurationError) {
      printStartupConfigError(err);
      process.exit(1);
    }
    throw err;
  }
  const { coreServices, createServer, manifest, lintWarnings, taskManager } = composed;
  const { definitionCounts } = manifest;

  // --- Initialize OTEL + high-res timer (independent, run in parallel) ---
  await Promise.all([
    initializeOpenTelemetry().catch((err: unknown) => {
      console.error('[Startup] Failed to initialize OpenTelemetry:', err);
    }),
    initHighResTimer(),
  ]);

  // --- Eager-init universal metrics so series exist from first export cycle ---
  initHeartbeatMetrics();
  initSessionMetrics();
  initErrorMetrics();
  initRateLimitMetrics();
  initHttpClientMetrics();
  initHandlerMetrics();

  // --- Process-level observable gauges (registered once after OTEL init) ---
  if (typeof process !== 'undefined' && typeof process.memoryUsage === 'function') {
    // Share a single memoryUsage() syscall across the three gauge callbacks per collection cycle. The snapshot is refreshed at most once per 100 ms.
    let memSnapshot: NodeJS.MemoryUsage | undefined;
    let memSnapshotTs = 0;
    const getMemSnapshot = (): NodeJS.MemoryUsage => {
      const now = Date.now();
      if (!memSnapshot || now - memSnapshotTs > 100) {
        memSnapshot = process.memoryUsage();
        memSnapshotTs = now;
      }
      return memSnapshot;
    };

    createObservableGauge(
      'process.memory.rss',
      'Process resident set size',
      () => getMemSnapshot().rss,
      'bytes',
    );
    createObservableGauge(
      'process.memory.heap_used',
      'V8 heap memory used',
      () => getMemSnapshot().heapUsed,
      'bytes',
    );
    createObservableGauge(
      'process.memory.heap_total',
      'V8 total heap size',
      () => getMemSnapshot().heapTotal,
      'bytes',
    );
  }
  if (typeof process !== 'undefined' && typeof process.uptime === 'function') {
    createObservableGauge(
      'process.uptime',
      'Process uptime in seconds',
      () => process.uptime(),
      's',
    );
  }

  // --- Event loop gauges (delay + utilization) ---
  if (typeof process !== 'undefined') {
    try {
      const { monitorEventLoopDelay, performance } = await import('node:perf_hooks');
      const eld = monitorEventLoopDelay({ resolution: 20 });
      eld.enable();
      createObservableGauge(
        'process.event_loop.delay',
        'Event loop delay p99 in milliseconds',
        () => eld.percentile(99) / 1e6, // ns → ms
        'ms',
      );
      let prevELU = performance.eventLoopUtilization();
      createObservableGauge(
        'process.event_loop.utilization',
        'Event loop utilization ratio (0 = idle, 1 = saturated)',
        () => {
          const current = performance.eventLoopUtilization();
          const delta = performance.eventLoopUtilization(prevELU, current);
          prevELU = current;
          return delta.utilization;
        },
        '1',
      );
    } catch {
      // perf_hooks unavailable in this runtime — skip silently
    }
  }

  // --- Initialize logger ---
  await logger.initialize(config.logLevel as McpLogLevel, config.mcpTransportType);

  for (const warning of lintWarnings) {
    logger.warning(warning);
  }

  logger.info(
    `Core services constructed — ${definitionCounts.tools} tool(s), ${definitionCounts.resources} resource(s), ${definitionCounts.prompts} prompt(s). Storage: ${config.storage.providerType}.`,
    requestContextService.createRequestContext({
      operation: 'ServerInit',
      additionalContext: {
        tools: (options.tools ?? []).map((t) => t.name),
        resources: (options.resources ?? []).map((r) => r.name ?? r.uriTemplate),
        prompts: (options.prompts ?? []).map((p) => p.name),
      },
    }),
  );

  // --- Transport ---
  const transportManager = new TransportManager(
    config,
    logger,
    createServer,
    taskManager,
    manifest,
  );

  // --- Startup context ---
  const startupContext = requestContextService.createRequestContext({
    operation: 'ServerStartup',
    applicationName: config.mcpServerName,
    applicationVersion: config.mcpServerVersion,
    nodeEnvironment: config.environment,
  });

  logger.info(`Starting ${config.mcpServerName} (v${config.mcpServerVersion})...`, startupContext);

  // --- Shutdown ---
  let isShuttingDown = false;

  const flushTelemetryAndLogger = async (): Promise<void> => {
    try {
      await shutdownOpenTelemetry();
      await logger.close();
    } catch {
      // Ignore errors during final cleanup
    }
  };

  const shutdown = async (signal = 'SHUTDOWN'): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    // Remove listeners to prevent re-entry and allow GC in tests
    process.removeListener('uncaughtException', onUncaughtException);
    process.removeListener('unhandledRejection', onUnhandledRejection);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);

    const shutdownContext = requestContextService.createRequestContext({
      operation: 'ServerShutdown',
      triggerEvent: signal,
    });

    logger.info(`Received ${signal}. Initiating graceful shutdown...`, shutdownContext);

    try {
      await withSpan('mcp.server.shutdown', async (span) => {
        span.setAttribute('mcp.server.shutdown.signal', signal);

        await withSpan('mcp.server.shutdown.transport', async () => {
          await transportManager.stop(signal);
        });

        taskManager.cleanup();
        coreServices.rateLimiter.dispose();
        schedulerService.destroyAll();

        if (coreServices.canvas) {
          await coreServices.canvas.shutdown(shutdownContext).catch((err) => {
            logger.warning('Canvas shutdown raised — continuing.', {
              ...shutdownContext,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }

        logger.info('Graceful shutdown completed successfully.', shutdownContext);
      });
      await flushTelemetryAndLogger();
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Critical error during shutdown process.', err, shutdownContext);
      await flushTelemetryAndLogger();
    }
  };

  // --- Named signal/error handlers (stored for cleanup in shutdown) ---

  const fatalShutdown = (signal: string) => {
    const backstop = setTimeout(() => process.exit(1), 10_000);
    backstop.unref();
    void shutdown(signal).finally(() => process.exit(1));
  };
  const onUncaughtException = (error: Error) => {
    const fatalContext = requestContextService.createRequestContext({
      operation: 'FatalError',
      triggerEvent: 'uncaughtException',
    });
    logger.fatal('FATAL: Uncaught exception detected.', error, fatalContext);
    fatalShutdown('uncaughtException');
  };
  const onUnhandledRejection = (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    const fatalContext = requestContextService.createRequestContext({
      operation: 'FatalError',
      triggerEvent: 'unhandledRejection',
    });
    logger.fatal('FATAL: Unhandled promise rejection detected.', err, fatalContext);
    fatalShutdown('unhandledRejection');
  };
  const onSigterm = () => void shutdown('SIGTERM');
  const onSigint = () => void shutdown('SIGINT');

  // --- Register error/signal handlers (before transport start so a SIGTERM
  //     during HTTP bind still triggers graceful shutdown) ---
  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  // --- Start transport (wrapped in startup span with phase breakdown) ---
  await withSpan('mcp.server.startup', async (span) => {
    span.setAttribute('mcp.server.name', config.mcpServerName);
    span.setAttribute('mcp.server.version', config.mcpServerVersion);
    span.setAttribute('mcp.server.transport', config.mcpTransportType);
    span.setAttribute('mcp.server.tools_count', definitionCounts.tools);
    span.setAttribute('mcp.server.resources_count', definitionCounts.resources);
    span.setAttribute('mcp.server.prompts_count', definitionCounts.prompts);

    await withSpan('mcp.server.startup.transport', async () => {
      await transportManager.start();
    });
  });

  logger.info(`${config.mcpServerName} is now running and ready.`, startupContext);

  return { services: coreServices, shutdown };
}

// ---------------------------------------------------------------------------
// Convenience re-exports from the main entry point
// ---------------------------------------------------------------------------

export { z } from 'zod';
export type { Context, ContextLogger, ContextProgress, ContextState } from '@/core/context.js';
export type { PromptDefinition } from '@/mcp-server/prompts/utils/promptDefinition.js';
export { prompt } from '@/mcp-server/prompts/utils/promptDefinition.js';
export type {
  AnyResourceDefinition,
  ResourceDefinition,
} from '@/mcp-server/resources/utils/resourceDefinition.js';
export { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
export type {
  AnyToolDefinition,
  DisabledMetadata,
  ToolAnnotations,
  ToolDefinition,
} from '@/mcp-server/tools/utils/toolDefinition.js';
export {
  disabledTool,
  tool,
} from '@/mcp-server/tools/utils/toolDefinition.js';

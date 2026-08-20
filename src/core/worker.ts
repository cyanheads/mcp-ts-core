/**
 * @fileoverview Cloudflare Worker entry point factory. `createWorkerHandler()`
 * returns a standard Workers export object (`{ fetch, scheduled }`) that handles
 * env injection, binding storage, singleton init caching, per-request server
 * creation (GHSA-345p-7cg4-v4c7), and error responses.
 *
 * Note: OpenTelemetry `NodeSDK` is unavailable in Workers (`canUseNodeSDK()`
 * returns false), so no telemetry flush is needed. If a Worker-compatible OTEL
 * exporter is added in the future, `ctx.waitUntil()` should be wired for flush.
 * @module src/core/worker
 */
import type {
  Ai,
  IncomingRequestCfProperties as CfProperties,
  D1Database,
  KVNamespace,
  R2Bucket,
  ScheduledController,
} from '@cloudflare/workers-types';
import type { Hono } from 'hono';
import { normalizeLogLevelAlias } from '@/config/logLevelAlias.js';
import { type CreateAppOptions, composeServices } from '@/core/app.js';
import { createHttpApp } from '@/mcp-server/transports/http/httpTransport.js';
import { logger, type McpLogLevel } from '@/utils/internal/logger.js';
import { requestContextService, withExtra } from '@/utils/internal/requestContext.js';

/**
 * Cloudflare Worker Bindings with proper type safety.
 * No index signature — servers extend via intersection types.
 */
export interface CloudflareBindings {
  AI?: Ai;
  /**
   * DataCanvas provider type. Surfaced here so an explicit
   * `CANVAS_PROVIDER_TYPE=duckdb` set in `wrangler.toml` triggers the
   * factory's fail-closed path (DuckDB has no V8-isolate build) instead
   * of silently no-opping.
   */
  CANVAS_PROVIDER_TYPE?: string;
  DB?: D1Database;
  ENVIRONMENT?: string;
  KV_NAMESPACE?: KVNamespace;
  LOG_LEVEL?: string;
  MCP_ALLOWED_ORIGINS?: string;
  MCP_AUTH_MODE?: string;
  MCP_AUTH_SECRET_KEY?: string;
  MCP_PUBLIC_URL?: string;
  OAUTH_AUDIENCE?: string;
  OAUTH_ISSUER_URL?: string;
  OAUTH_JWKS_URI?: string;
  OPENROUTER_API_KEY?: string;
  OTEL_ENABLED?: string;
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string;
  R2_BUCKET?: R2Bucket;
  SPEECH_STT_API_KEY?: string;
  SPEECH_STT_ENABLED?: string;
  SPEECH_TTS_API_KEY?: string;
  SPEECH_TTS_ENABLED?: string;
  STORAGE_PROVIDER_TYPE?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
}

/**
 * Options for {@link createWorkerHandler}.
 *
 * Worker-specific override on `instructions`: accepts a `(env)` resolver so
 * deployment env injected at request time can shape the orientation text
 * without eager top-level env reads. The resolver is invoked during
 * single-flight init the first time `fetch` is called, after binding
 * injection. A plain string is also accepted (same semantics as `createApp`).
 */
export interface WorkerHandlerOptions extends Omit<CreateAppOptions, 'instructions'> {
  /** Extra string CF bindings to inject into process.env (beyond the core set). */
  extraEnvBindings?: Array<[string, string]>;
  /** Extra object CF bindings (KV, R2, D1, etc.) to store on globalThis. */
  extraObjectBindings?: Array<[string, string]>;
  /**
   * Server-level orientation text — see {@link CreateAppOptions.instructions}.
   * Accepts a resolver function so env-derived instructions can be built from
   * `env` at the first request rather than at module load (env isn't
   * available until then in Workers).
   */
  instructions?: string | ((env: CloudflareBindings) => string);
  /** Handler for scheduled/cron events. Called after app init and binding refresh. */
  onScheduled?: (
    controller: ScheduledController,
    env: CloudflareBindings,
    ctx: ExecutionContext,
  ) => Promise<void>;
}

/** Hono env shape for Workers. */
type WorkerEnv = { Bindings: CloudflareBindings };

/** Core string bindings injected into process.env for config parsing. */
const CORE_ENV_BINDINGS: ReadonlyArray<[keyof CloudflareBindings, string]> = [
  ['ENVIRONMENT', 'NODE_ENV'],
  ['LOG_LEVEL', 'MCP_LOG_LEVEL'],
  ['MCP_AUTH_MODE', 'MCP_AUTH_MODE'],
  ['MCP_AUTH_SECRET_KEY', 'MCP_AUTH_SECRET_KEY'],
  ['MCP_PUBLIC_URL', 'MCP_PUBLIC_URL'],
  ['OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'],
  ['SUPABASE_URL', 'SUPABASE_URL'],
  ['SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
  ['STORAGE_PROVIDER_TYPE', 'STORAGE_PROVIDER_TYPE'],
  ['CANVAS_PROVIDER_TYPE', 'CANVAS_PROVIDER_TYPE'],
  ['OAUTH_ISSUER_URL', 'OAUTH_ISSUER_URL'],
  ['OAUTH_AUDIENCE', 'OAUTH_AUDIENCE'],
  ['OAUTH_JWKS_URI', 'OAUTH_JWKS_URI'],
  ['MCP_ALLOWED_ORIGINS', 'MCP_ALLOWED_ORIGINS'],
  ['SPEECH_TTS_ENABLED', 'SPEECH_TTS_ENABLED'],
  ['SPEECH_TTS_API_KEY', 'SPEECH_TTS_API_KEY'],
  ['SPEECH_STT_ENABLED', 'SPEECH_STT_ENABLED'],
  ['SPEECH_STT_API_KEY', 'SPEECH_STT_API_KEY'],
  ['OTEL_ENABLED', 'OTEL_ENABLED'],
  ['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'],
  ['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'],
] as const;

/** Core object bindings stored on globalThis for storage/AI providers. */
const CORE_OBJECT_BINDINGS: ReadonlyArray<[keyof CloudflareBindings, string]> = [
  ['KV_NAMESPACE', 'KV_NAMESPACE'],
  ['R2_BUCKET', 'R2_BUCKET'],
  ['DB', 'DB'],
  ['AI', 'AI'],
] as const;

const VALID_LOG_LEVELS: readonly McpLogLevel[] = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'crit',
  'alert',
  'emerg',
];

/**
 * Resolves a `LOG_LEVEL` binding to a level the config schema accepts, so an
 * invalid one cannot make `parseConfig` throw and fail the request. Aliases are
 * resolved through the schema's own table first — screening on the raw value
 * would discard `warn` as invalid and silently downgrade it to the fallback.
 */
function normalizeLogLevel(value: string | undefined): McpLogLevel {
  const normalized = value === undefined ? undefined : normalizeLogLevelAlias(value);
  return VALID_LOG_LEVELS.includes(normalized as McpLogLevel)
    ? (normalized as McpLogLevel)
    : 'info';
}

function requestUrlLogFields(requestUrl: string): { queryPresent: boolean; url: string } {
  const parsed = new URL(requestUrl);
  return {
    queryPresent: parsed.search.length > 0,
    url: `${parsed.origin}${parsed.pathname}`,
  };
}

function injectEnvVars(env: CloudflareBindings, extraBindings?: Array<[string, string]>): void {
  if (typeof process === 'undefined') return;
  for (const [bindingKey, processKey] of CORE_ENV_BINDINGS) {
    const value = env[bindingKey];
    if (typeof value === 'string' && value.trim() !== '') {
      process.env[processKey] = bindingKey === 'LOG_LEVEL' ? normalizeLogLevel(value) : value;
    }
  }
  if (extraBindings) {
    for (const [bindingKey, processKey] of extraBindings) {
      const value = (env as Record<string, unknown>)[bindingKey];
      if (typeof value === 'string' && value.trim() !== '') {
        process.env[processKey] = value;
      }
    }
  }
}

function storeBindings(env: CloudflareBindings, extraBindings?: Array<[string, string]>): void {
  for (const [bindingKey, globalKey] of CORE_OBJECT_BINDINGS) {
    const value = env[bindingKey];
    if (value != null) {
      Object.assign(globalThis, { [globalKey]: value });
    }
  }
  if (extraBindings) {
    for (const [bindingKey, globalKey] of extraBindings) {
      const value = (env as Record<string, unknown>)[bindingKey];
      if (value != null) {
        Object.assign(globalThis, { [globalKey]: value });
      }
    }
  }
}

/**
 * Returns a standard Cloudflare Workers export object (`{ fetch, scheduled }`).
 * Handles env injection, binding storage, singleton init caching, per-request
 * server creation, and error responses.
 */
export function createWorkerHandler(options: WorkerHandlerOptions = {}) {
  const {
    extraEnvBindings,
    extraObjectBindings,
    instructions: instructionsOption,
    onScheduled,
    ...appOptions
  } = options;

  let appPromise: Promise<Hono<WorkerEnv>> | null = null;

  function initializeApp(env: CloudflareBindings): Promise<Hono<WorkerEnv>> {
    if (appPromise) return appPromise;

    appPromise = (async () => {
      const initStartTime = Date.now();

      try {
        if (typeof process !== 'undefined' && process.env) {
          process.env.IS_SERVERLESS = 'true';
          process.env.MCP_TRANSPORT_TYPE = 'http'; // Workers are always HTTP — context.ts reads this for tenant isolation
        } else {
          Object.assign(globalThis, { IS_SERVERLESS: true });
        }

        const resolvedInstructions =
          typeof instructionsOption === 'function' ? instructionsOption(env) : instructionsOption;

        const { bus, createServer, manifest } = await composeServices({
          ...appOptions,
          ...(resolvedInstructions && { instructions: resolvedInstructions }),
        });

        await logger.initialize(normalizeLogLevel(env.LOG_LEVEL), 'http');

        const workerContext = requestContextService.createRequestContext({
          operation: 'WorkerInitialization',
          additionalContext: { isServerless: true },
        });

        logger.info(
          'Cloudflare Worker initializing...',
          withExtra(workerContext, {
            environment: env.ENVIRONMENT ?? 'production',
            storageProvider: env.STORAGE_PROVIDER_TYPE ?? 'in-memory',
          }),
        );

        const { app } = await createHttpApp<CloudflareBindings>(
          createServer,
          workerContext,
          manifest,
          bus,
        );

        const initDuration = Date.now() - initStartTime;
        logger.info(
          'Cloudflare Worker initialized successfully.',
          withExtra(workerContext, { initDurationMs: initDuration }),
        );

        return app;
      } catch (error: unknown) {
        const initDuration = Date.now() - initStartTime;
        const errorContext = requestContextService.createRequestContext({
          operation: 'WorkerInitialization',
          additionalContext: {
            isServerless: true,
            initDurationMs: initDuration,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
        });

        logger.crit(
          'Failed to initialize Cloudflare Worker.',
          error instanceof Error ? error : new Error(String(error)),
          errorContext,
        );

        appPromise = null;
        throw error;
      }
    })();

    return appPromise;
  }

  return {
    async fetch(
      request: Request,
      env: CloudflareBindings,
      ctx: ExecutionContext,
    ): Promise<Response> {
      try {
        injectEnvVars(env, extraEnvBindings);
        storeBindings(env, extraObjectBindings);

        const app = await initializeApp(env);

        type RequestWithCf = Request & { cf?: CfProperties };
        const cfProperties = (request as RequestWithCf).cf;
        const requestId = request.headers.get('cf-ray') ?? crypto.randomUUID();

        const requestContext = requestContextService.createRequestContext({
          operation: 'WorkerFetch',
          parentContext: { requestId },
          additionalContext: {
            isServerless: true,
            ...(cfProperties && {
              colo: cfProperties.colo,
              country: cfProperties.country,
              city: cfProperties.city,
            }),
          },
        });

        logger.debug(
          'Processing Worker fetch request.',
          withExtra(requestContext, {
            method: request.method,
            ...requestUrlLogFields(request.url),
          }),
        );

        return await app.fetch(request, env, ctx);
      } catch (error: unknown) {
        const requestId = request.headers.get('cf-ray');
        const errorContext = requestContextService.createRequestContext({
          operation: 'WorkerFetch',
          ...(requestId && { parentContext: { requestId } }),
          additionalContext: {
            isServerless: true,
            method: request.method,
            ...requestUrlLogFields(request.url),
          },
        });

        logger.error(
          'Worker fetch handler error.',
          error instanceof Error ? error : new Error(String(error)),
          errorContext,
        );

        return new Response(
          JSON.stringify({
            error: 'Internal Server Error',
            message: 'An internal error occurred.',
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
    },

    async scheduled(
      controller: ScheduledController,
      env: CloudflareBindings,
      ctx: ExecutionContext,
    ): Promise<void> {
      try {
        injectEnvVars(env, extraEnvBindings);
        storeBindings(env, extraObjectBindings);

        await initializeApp(env);

        if (onScheduled) {
          await onScheduled(controller, env, ctx);
          return;
        }

        const scheduledContext = requestContextService.createRequestContext({
          operation: 'WorkerScheduled',
          additionalContext: { isServerless: true, cron: controller.cron },
        });

        logger.info(
          'Processing scheduled event.',
          withExtra(scheduledContext, {
            scheduledTime: new Date(controller.scheduledTime).toISOString(),
          }),
        );

        logger.info('Scheduled event completed.', scheduledContext);
      } catch (error: unknown) {
        const errorContext = requestContextService.createRequestContext({
          operation: 'WorkerScheduled',
          additionalContext: { isServerless: true, cron: controller.cron },
        });

        logger.error(
          'Worker scheduled handler error.',
          error instanceof Error ? error : new Error(String(error)),
          errorContext,
        );
        throw error;
      }
    },
  };
}

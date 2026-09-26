/**
 * @fileoverview Unit tests for the application composition root.
 * @module tests/unit/core/app.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockConfig,
  mockCreateCanvasService,
  mockCreateMcpServerInstance,
  mockCreateObservableGauge,
  mockCreateStorageProvider,
  mockInitErrorMetrics,
  mockInitHandlerMetrics,
  mockInitHeartbeatMetrics,
  mockInitHttpClientMetrics,
  mockInitRateLimitMetrics,
  mockInitSessionMetrics,
  mockInitializeOpenTelemetry,
  mockLogger,
  mockObserveStdinEof,
  mockStopWatchingStdin,
  mockPromptRegistry,
  mockRateLimiter,
  mockRequestContextService,
  mockResetConfig,
  mockResourceRegistry,
  mockSchedulerService,
  mockShutdownOpenTelemetry,
  mockToolRegistry,
  mockTransportManager,
  mockWithSpan,
  MockOpenRouterProvider,
  MockPromptRegistry,
  MockRateLimiter,
  MockResourceRegistry,
  MockSpeechService,
  MockStorageService,
  MockToolRegistry,
  MockTransportManager,
} = vi.hoisted(() => {
  type MockStorageProvider = { provider: string };

  const mockConfig = {
    environment: 'test',
    logLevel: 'debug',
    mcpServerName: 'mock-server',
    mcpServerVersion: '1.0.0',
    mcpTransportType: 'stdio',
    openrouterApiKey: undefined as string | undefined,
    speech: undefined as
      | {
          stt?: { enabled?: boolean; provider?: string };
          tts?: { enabled?: boolean; provider?: string };
        }
      | undefined,
    storage: {
      providerType: 'in-memory',
    },
    canvas: {
      providerType: 'none',
      defaultMemoryLimitMb: 1024,
      exportRootPath: './.canvas-exports',
      maxCanvasesPerTenant: 100,
      ttlMs: 24 * 60 * 60 * 1000,
      absoluteCapMs: 7 * 24 * 60 * 60 * 1000,
      sweeperIntervalMs: 0,
      defaultRowLimit: 10_000,
      schemaSniffRows: 100,
    },
    supabase: undefined as
      | {
          serviceRoleKey?: string | undefined;
          url?: string | undefined;
        }
      | undefined,
  };

  const mockLogger = {
    close: vi.fn(async () => {}),
    drainPendingToStderr: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    initialize: vi.fn(async () => {}),
    warning: vi.fn(),
  };

  const mockResetConfig = vi.fn();
  const mockCreateCanvasService = vi.fn();
  const mockCreateStorageProvider = vi.fn(() => ({ provider: 'storage-provider' }));
  const mockStorageService = {
    instance: {
      provider: { provider: 'storage-provider' } as MockStorageProvider,
    },
  };
  const MockStorageService = vi.fn(function MockStorageService(provider: MockStorageProvider) {
    mockStorageService.instance = { provider };
    return mockStorageService.instance;
  });

  const mockRateLimiter = {
    instance: {
      dispose: vi.fn(),
    },
  };
  const MockRateLimiter = vi.fn(function MockRateLimiter() {
    return mockRateLimiter.instance;
  });

  const MockOpenRouterProvider = vi.fn(function MockOpenRouterProvider() {
    return { kind: 'llm-provider' };
  });
  const mockSpeechService = {
    instance: {
      kind: 'speech-service',
    },
  };
  const MockSpeechService = vi.fn(function MockSpeechService() {
    return mockSpeechService.instance;
  });

  const mockToolRegistry = { instance: { kind: 'tool-registry' } };
  const MockToolRegistry = vi.fn(function MockToolRegistry() {
    return mockToolRegistry.instance;
  });
  const mockResourceRegistry = { instance: { kind: 'resource-registry' } };
  const MockResourceRegistry = vi.fn(function MockResourceRegistry() {
    return mockResourceRegistry.instance;
  });
  const mockPromptRegistry = { instance: { kind: 'prompt-registry' } };
  const MockPromptRegistry = vi.fn(function MockPromptRegistry() {
    return mockPromptRegistry.instance;
  });

  const mockCreateMcpServerInstance = vi.fn(async () => ({ server: 'mcp-server' }));

  const mockInitHeartbeatMetrics = vi.fn();
  const mockInitSessionMetrics = vi.fn();
  const mockInitErrorMetrics = vi.fn();
  const mockInitRateLimitMetrics = vi.fn();
  const mockInitHttpClientMetrics = vi.fn();
  const mockInitHandlerMetrics = vi.fn();
  const mockInitializeOpenTelemetry = vi.fn(async () => {});
  const mockShutdownOpenTelemetry = vi.fn(async () => {});
  const mockCreateObservableGauge = vi.fn();
  const mockWithSpan = vi.fn(
    async (_name: string, fn: (span: { setAttribute: typeof vi.fn }) => unknown) => {
      const span = { setAttribute: vi.fn() };
      return await fn(span);
    },
  );

  const mockTransportManager = {
    instance: {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    },
  };
  const MockTransportManager = vi.fn(function MockTransportManager() {
    return mockTransportManager.instance;
  });

  const mockRequestContextService = {
    createRequestContext: vi.fn(
      (params?: {
        additionalContext?: Record<string, unknown>;
        operation?: string;
        parentContext?: Record<string, unknown>;
        tenantId?: string;
      }) => ({
        requestId: 'core-app-request',
        timestamp: '2026-03-30T00:00:00.000Z',
        ...params?.parentContext,
        ...(params?.operation && { operation: params.operation }),
        ...(params?.tenantId && { tenantId: params.tenantId }),
        ...(params?.additionalContext && { extra: { ...params.additionalContext } }),
      }),
    ),
  };

  const mockSchedulerService = {
    destroyAll: vi.fn(),
  };

  /**
   * The stdin EOF watcher is mocked rather than exercised: the real one binds
   * this process's stdin, and an EOF there would tear down the test runner
   * along with the app under test. Its own behavior is covered in
   * `tests/unit/mcp-server/transports/stdio/stdioTransport.test.ts`.
   */
  const mockStopWatchingStdin = vi.fn();
  const mockObserveStdinEof = vi.fn(
    (_options: { onEof: () => void }): (() => void) => mockStopWatchingStdin,
  );

  return {
    mockConfig,
    mockCreateCanvasService,
    mockCreateMcpServerInstance,
    mockCreateObservableGauge,
    mockCreateStorageProvider,
    mockInitErrorMetrics,
    mockInitHandlerMetrics,
    mockInitHeartbeatMetrics,
    mockInitHttpClientMetrics,
    mockInitRateLimitMetrics,
    mockInitSessionMetrics,
    mockInitializeOpenTelemetry,
    mockLogger,
    mockObserveStdinEof,
    mockStopWatchingStdin,
    mockPromptRegistry,
    mockRateLimiter,
    mockRequestContextService,
    mockResetConfig,
    mockResourceRegistry,
    mockSchedulerService,
    mockShutdownOpenTelemetry,
    mockToolRegistry,
    mockTransportManager,
    mockWithSpan,
    MockOpenRouterProvider,
    MockPromptRegistry,
    MockRateLimiter,
    MockResourceRegistry,
    MockSpeechService,
    MockStorageService,
    MockToolRegistry,
    MockTransportManager,
  };
});

vi.mock('@/config/index.js', () => ({
  config: mockConfig,
  resetConfig: mockResetConfig,
  FRAMEWORK_NAME: '@cyanheads/mcp-ts-core',
  FRAMEWORK_VERSION: '0.0.0-test',
}));

vi.mock('@/mcp-server/prompts/prompt-registration.js', () => ({
  PromptRegistry: MockPromptRegistry,
}));

vi.mock('@/mcp-server/resources/resource-registration.js', () => ({
  ResourceRegistry: MockResourceRegistry,
}));

vi.mock('@/mcp-server/server.js', () => ({
  createMcpServerInstance: mockCreateMcpServerInstance,
}));

vi.mock('@/mcp-server/tools/tool-registration.js', () => ({
  ToolRegistry: MockToolRegistry,
}));

vi.mock('@/mcp-server/transports/heartbeat.js', () => ({
  initHeartbeatMetrics: mockInitHeartbeatMetrics,
}));

vi.mock('@/mcp-server/transports/http/sessionStore.js', () => ({
  initSessionMetrics: mockInitSessionMetrics,
}));

vi.mock('@/mcp-server/transports/manager.js', () => ({
  TransportManager: MockTransportManager,
}));

vi.mock('@/mcp-server/transports/stdio/stdioTransport.js', () => ({
  observeStdinEof: mockObserveStdinEof,
}));

vi.mock('@/services/canvas/core/canvasFactory.js', () => ({
  createCanvasService: mockCreateCanvasService,
}));

vi.mock('@/services/llm/providers/openrouter.provider.js', () => ({
  OpenRouterProvider: MockOpenRouterProvider,
}));

vi.mock('@/services/speech/core/SpeechService.js', () => ({
  SpeechService: MockSpeechService,
}));

vi.mock('@/storage/core/StorageService.js', () => ({
  StorageService: MockStorageService,
}));

vi.mock('@/storage/core/storageFactory.js', () => ({
  createStorageProvider: mockCreateStorageProvider,
}));

vi.mock('@/utils/internal/error-handler/errorHandler.js', () => ({
  initErrorMetrics: mockInitErrorMetrics,
}));

vi.mock('@/utils/internal/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('@/utils/internal/performance.js', () => ({
  initHandlerMetrics: mockInitHandlerMetrics,
}));

vi.mock('@/utils/internal/requestContext.js', () => ({
  toCanonicalContext: (context: Record<string, unknown>) =>
    Object.fromEntries(
      [
        'auth',
        'extra',
        'operation',
        'requestId',
        'sessionId',
        'spanId',
        'tenantId',
        'timestamp',
        'traceId',
      ]
        .filter((k) => context[k] !== undefined)
        .map((k) => [k, context[k]]),
    ),
  withExtra: (ctx: { extra?: Record<string, unknown> }, fields: Record<string, unknown>) => ({
    ...ctx,
    extra: { ...ctx.extra, ...fields },
  }),
  requestContextService: mockRequestContextService,
}));

vi.mock('@/utils/network/fetchWithTimeout.js', () => ({
  initHttpClientMetrics: mockInitHttpClientMetrics,
}));

vi.mock('@/utils/scheduling/scheduler.js', () => ({
  schedulerService: mockSchedulerService,
}));

vi.mock('@/utils/security/rateLimiter.js', () => ({
  RateLimiter: MockRateLimiter,
  initRateLimitMetrics: mockInitRateLimitMetrics,
}));

vi.mock('@/utils/telemetry/instrumentation.js', () => ({
  initializeOpenTelemetry: mockInitializeOpenTelemetry,
  shutdownOpenTelemetry: mockShutdownOpenTelemetry,
}));

vi.mock('@/utils/telemetry/metrics.js', () => ({
  createObservableGauge: mockCreateObservableGauge,
}));

vi.mock('@/utils/telemetry/trace.js', () => ({
  withSpan: mockWithSpan,
  // Pass-through: the detach behavior itself is covered in trace.test.ts. Here
  // it only needs to not swallow the transport start it wraps.
  runDetached: <T>(fn: () => T): T => fn(),
}));

import { z } from 'zod';

import { composeServices, createApp } from '@/core/app.js';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { disabledTool, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';

describe('core/app', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalIsTTY: boolean;
  let processOnSpy: ReturnType<typeof vi.spyOn>;
  let processRemoveListenerSpy: ReturnType<typeof vi.spyOn>;

  const flushAsyncWork = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  const getProcessHandler = (eventName: string): ((...args: unknown[]) => void) => {
    const call = processOnSpy.mock.calls.find(
      (call: [string, ...unknown[]]) => call[0] === eventName,
    );
    expect(call).toBeDefined();
    return call?.[1] as (...args: unknown[]) => void;
  };

  const getGaugeCallback = (name: string): (() => number) => {
    const call = mockCreateObservableGauge.mock.calls.find(([gaugeName]) => gaugeName === name);
    expect(call).toBeDefined();
    return call?.[2] as () => number;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    originalEnv = { ...process.env };
    originalIsTTY = process.stdout.isTTY;
    process.env.MCP_SERVER_NAME = undefined;
    process.env.MCP_SERVER_VERSION = undefined;
    process.env.OTEL_SERVICE_NAME = undefined;
    process.env.OTEL_SERVICE_VERSION = undefined;
    process.env.NO_COLOR = undefined;
    process.env.FORCE_COLOR = undefined;
    process.env.MCP_TRANSPORT_TYPE = 'stdio';
    process.env.DEBUG = undefined;

    mockConfig.environment = 'test';
    mockConfig.logLevel = 'debug';
    mockConfig.mcpServerName = 'mock-server';
    mockConfig.mcpServerVersion = '1.0.0';
    mockConfig.mcpTransportType = 'stdio';
    mockConfig.openrouterApiKey = undefined;
    mockConfig.speech = undefined;
    mockConfig.storage.providerType = 'in-memory';
    mockConfig.supabase = undefined;
    mockInitializeOpenTelemetry.mockResolvedValue(undefined);
    mockCreateCanvasService.mockReturnValue(undefined);

    processOnSpy = vi.spyOn(process, 'on');
    processRemoveListenerSpy = vi.spyOn(process, 'removeListener');
  });

  afterEach(async () => {
    processOnSpy.mockRestore();
    processRemoveListenerSpy.mockRestore();
    process.env = originalEnv;
    process.stdout.isTTY = originalIsTTY;
  });

  it('converts ZodError thrown from setup() into a ConfigurationError', async () => {
    const { z } = await import('zod');
    const schema = z.object({ apiKey: z.string() });
    const setup = () => {
      schema.parse({ apiKey: undefined });
    };

    try {
      await composeServices({ setup });
      expect.fail('should have thrown');
    } catch (err) {
      const { JsonRpcErrorCode, McpError } = await import('@/types-global/errors.js');
      expect(err).toBeInstanceOf(McpError);
      expect((err as InstanceType<typeof McpError>).code).toBe(JsonRpcErrorCode.ConfigurationError);
      expect((err as Error).message).toContain('Server setup failed');
      expect((err as Error).message).toContain('apiKey');
    }
  });

  it('preserves non-Zod errors thrown from setup() without conversion', async () => {
    const original = new Error('database unreachable');
    const setup = () => {
      throw original;
    };

    await expect(composeServices({ setup })).rejects.toBe(original);
  });

  it('creates a Supabase admin client when Supabase storage is configured', async () => {
    mockConfig.storage.providerType = 'supabase';
    mockConfig.supabase = {
      serviceRoleKey: 'service-role-key',
      url: 'https://example.supabase.co',
    };

    const composed = await composeServices();

    expect(mockCreateStorageProvider).toHaveBeenCalledWith(
      mockConfig,
      expect.objectContaining({
        supabaseClient: expect.any(Object),
      }),
    );
    expect(composed.coreServices.supabase).toBeDefined();
  });

  it('composes services, applies name/version overrides, and builds the MCP server factory', async () => {
    mockConfig.openrouterApiKey = 'openrouter-key';
    mockConfig.speech = {
      stt: { enabled: true, provider: 'whisper' },
      tts: { enabled: true, provider: 'elevenlabs' },
    };

    const setup = vi.fn();
    const toolDefs = [{ name: 'tool-a' }] as never[];
    const resourceDefs = [{ uri: 'resource://a' }] as never[];
    const promptDefs = [{ name: 'prompt-a' }] as never[];

    const composed = await composeServices({
      name: 'override-server',
      prompts: promptDefs,
      resources: resourceDefs,
      setup,
      tools: toolDefs,
      version: '9.9.9',
    });

    expect(mockResetConfig).toHaveBeenCalledTimes(1);
    expect(process.env.MCP_SERVER_NAME).toBe('override-server');
    expect(process.env.MCP_SERVER_VERSION).toBe('9.9.9');
    expect(process.env.OTEL_SERVICE_NAME).toBe('override-server');
    expect(process.env.OTEL_SERVICE_VERSION).toBe('9.9.9');
    expect(MockOpenRouterProvider).toHaveBeenCalledWith(
      mockRateLimiter.instance,
      mockConfig,
      mockLogger,
    );
    expect(MockSpeechService).toHaveBeenCalledWith(mockConfig.speech.tts, mockConfig.speech.stt);
    expect(setup).toHaveBeenCalledWith(composed.coreServices);
    expect(composed.coreServices.llmProvider).toEqual({ kind: 'llm-provider' });
    expect(composed.coreServices.speechService).toEqual({ kind: 'speech-service' });
    expect(composed.manifest.definitionCounts).toEqual({
      prompts: 1,
      resources: 1,
      tools: 1,
    });

    await composed.createServer({ era: 'modern' });

    expect(mockCreateMcpServerInstance).toHaveBeenCalledWith({
      config: mockConfig,
      // Forwarded from the factory's McpRequestContext — it selects the
      // resource-subscription mechanism for the era being served (#354).
      era: 'modern',
      // The app owns the `subscriptions/listen` bus and hands every instance
      // its publish facade; `createMcpServerInstance` drops it for the legacy
      // era, which delivers over the live session instead (#193).
      notifier: composed.coreServices.notify,
      promptRegistry: mockPromptRegistry.instance,
      resourceRegistry: mockResourceRegistry.instance,
      toolRegistry: mockToolRegistry.instance,
    });
  });

  it('forwards server identity fields through composeServices to createMcpServerInstance (#213)', async () => {
    const icons = [{ src: 'https://example.com/icon.png', mimeType: 'image/png' }];
    const composed = await composeServices({
      title: 'My Server',
      websiteUrl: 'https://github.com/owner/repo',
      description: 'One-line description.',
      icons,
    });

    await composed.createServer({ era: 'modern' });

    expect(mockCreateMcpServerInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'My Server',
        websiteUrl: 'https://github.com/owner/repo',
        description: 'One-line description.',
        icons,
      }),
    );

    // Identity fields also surface on the manifest
    expect(composed.manifest.server.title).toBe('My Server');
    expect(composed.manifest.server.websiteUrl).toBe('https://github.com/owner/repo');
    expect(composed.manifest.server.description).toBe('One-line description.');
    expect(composed.manifest.server.icons).toEqual(icons);
  });

  it('starts the app, registers shutdown handlers, and performs graceful shutdown', async () => {
    const handle = await createApp({
      name: 'app-under-test',
      version: '2.0.0',
    });

    expect(process.env.NO_COLOR).toBe('1');
    expect(process.env.FORCE_COLOR).toBe('0');
    expect(mockInitializeOpenTelemetry).toHaveBeenCalledTimes(1);
    expect(mockInitHeartbeatMetrics).toHaveBeenCalledTimes(1);
    expect(mockInitSessionMetrics).toHaveBeenCalledTimes(1);
    expect(mockInitErrorMetrics).toHaveBeenCalledTimes(1);
    expect(mockInitRateLimitMetrics).toHaveBeenCalledTimes(1);
    expect(mockInitHttpClientMetrics).toHaveBeenCalledTimes(1);
    expect(mockInitHandlerMetrics).toHaveBeenCalledTimes(1);
    expect(mockLogger.initialize).toHaveBeenCalledWith('debug', 'stdio');
    expect(MockTransportManager).toHaveBeenCalledWith(
      mockConfig,
      mockLogger,
      expect.any(Function),
      expect.objectContaining({
        definitionCounts: { prompts: 0, resources: 0, tools: 0 },
        server: expect.objectContaining({ name: 'mock-server', version: '1.0.0' }),
      }),
      // The `subscriptions/listen` bus, so the HTTP handler's listen streams
      // subscribe to the same one background emitters publish on (#193).
      expect.objectContaining({ publish: expect.any(Function), subscribe: expect.any(Function) }),
    );
    expect(mockTransportManager.instance.start).toHaveBeenCalledTimes(1);
    expect(mockCreateObservableGauge.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([
        'process.memory.rss',
        'process.memory.heap_used',
        'process.memory.heap_total',
        'process.uptime',
      ]),
    );
    expect(processOnSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
    expect(processOnSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(handle.services.config).toBe(mockConfig);

    await handle.shutdown('SIGTERM');
    await handle.shutdown('SIGINT');

    expect(processRemoveListenerSpy).toHaveBeenCalledWith(
      'uncaughtException',
      expect.any(Function),
    );
    expect(processRemoveListenerSpy).toHaveBeenCalledWith(
      'unhandledRejection',
      expect.any(Function),
    );
    expect(processRemoveListenerSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(processRemoveListenerSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(mockTransportManager.instance.stop).toHaveBeenCalledTimes(1);
    expect(mockTransportManager.instance.stop).toHaveBeenCalledWith('SIGTERM');
    expect(mockRateLimiter.instance.dispose).toHaveBeenCalledTimes(1);
    expect(mockSchedulerService.destroyAll).toHaveBeenCalledTimes(1);
    expect(mockShutdownOpenTelemetry).toHaveBeenCalledTimes(1);
    expect(mockLogger.close).toHaveBeenCalledTimes(1);
  });

  it('exposes executable process gauge callbacks', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1_000).mockReturnValueOnce(1_000).mockReturnValueOnce(1_250);

    const memoryUsageSpy = vi.spyOn(process, 'memoryUsage').mockReturnValue({
      arrayBuffers: 50,
      external: 40,
      heapTotal: 30,
      heapUsed: 20,
      rss: 10,
    });
    const uptimeSpy = vi.spyOn(process, 'uptime').mockReturnValue(123);

    const handle = await createApp();

    const rssGauge = getGaugeCallback('process.memory.rss');
    const heapUsedGauge = getGaugeCallback('process.memory.heap_used');
    const heapTotalGauge = getGaugeCallback('process.memory.heap_total');
    const uptimeGauge = getGaugeCallback('process.uptime');
    const eventLoopDelayGauge = getGaugeCallback('process.event_loop.delay');
    const eventLoopUtilizationGauge = getGaugeCallback('process.event_loop.utilization');

    expect(rssGauge()).toBe(10);
    expect(heapUsedGauge()).toBe(20);
    expect(heapTotalGauge()).toBe(30);
    expect(memoryUsageSpy).toHaveBeenCalledTimes(2);
    expect(uptimeGauge()).toBe(123);
    expect(typeof eventLoopDelayGauge()).toBe('number');
    expect(typeof eventLoopUtilizationGauge()).toBe('number');

    await handle.shutdown();

    uptimeSpy.mockRestore();
    memoryUsageSpy.mockRestore();
    nowSpy.mockRestore();
  });

  it('logs shutdown errors and still flushes telemetry when transport stop fails', async () => {
    mockTransportManager.instance.stop.mockRejectedValueOnce('transport stop failed');

    const handle = await createApp();

    await handle.shutdown('MANUAL');

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Critical error during shutdown process.',
      expect.objectContaining({
        message: 'transport stop failed',
      }),
      expect.objectContaining({
        operation: 'ServerShutdown',
        extra: expect.objectContaining({ triggerEvent: 'MANUAL' }),
      }),
    );
    expect(mockShutdownOpenTelemetry).toHaveBeenCalledTimes(1);
    expect(mockLogger.close).toHaveBeenCalledTimes(1);
  });

  it('rolls back allocated resources and listeners when transport startup fails', async () => {
    const startupError = new Error('address already in use');
    mockTransportManager.instance.start.mockRejectedValueOnce(startupError);

    await expect(createApp()).rejects.toBe(startupError);

    expect(processRemoveListenerSpy).toHaveBeenCalledWith(
      'uncaughtException',
      expect.any(Function),
    );
    expect(processRemoveListenerSpy).toHaveBeenCalledWith(
      'unhandledRejection',
      expect.any(Function),
    );
    expect(processRemoveListenerSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(processRemoveListenerSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(mockTransportManager.instance.stop).toHaveBeenCalledOnce();
    expect(mockTransportManager.instance.stop).toHaveBeenCalledWith('STARTUP_FAILURE');
    expect(mockRateLimiter.instance.dispose).toHaveBeenCalledOnce();
    expect(mockSchedulerService.destroyAll).toHaveBeenCalledOnce();
    expect(mockShutdownOpenTelemetry).toHaveBeenCalledOnce();
    expect(mockLogger.close).toHaveBeenCalledOnce();
  });

  it('registered fatal handlers log errors and trigger exit backstops', async () => {
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_: number) => undefined as never) as typeof process.exit);
    const timeoutRefs: Array<{ unref: ReturnType<typeof vi.fn> }> = [];
    const timeoutCallbacks: Array<() => void> = [];
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: Parameters<typeof setTimeout>[0],
    ) => {
      if (typeof callback === 'function') {
        timeoutCallbacks.push(callback);
      }
      const ref = { unref: vi.fn() };
      timeoutRefs.push(ref);
      return ref as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    await createApp();

    const onUncaughtException = getProcessHandler('uncaughtException') as (error: Error) => void;
    const onUnhandledRejection = getProcessHandler('unhandledRejection') as (
      reason: unknown,
    ) => void;

    onUncaughtException(new Error('uncaught boom'));
    await flushAsyncWork();

    onUnhandledRejection('rejection boom');
    await flushAsyncWork();

    expect(mockLogger.fatal).toHaveBeenCalledWith(
      'FATAL: Uncaught exception detected.',
      expect.objectContaining({ message: 'uncaught boom' }),
      expect.objectContaining({
        extra: expect.objectContaining({ triggerEvent: 'uncaughtException' }),
      }),
    );
    expect(mockLogger.fatal).toHaveBeenCalledWith(
      'FATAL: Unhandled promise rejection detected.',
      expect.objectContaining({ message: 'rejection boom' }),
      expect.objectContaining({
        extra: expect.objectContaining({ triggerEvent: 'unhandledRejection' }),
      }),
    );
    expect(timeoutRefs).toHaveLength(2);
    expect(timeoutRefs[0]?.unref).toHaveBeenCalledTimes(1);
    expect(timeoutRefs[1]?.unref).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(1);

    timeoutCallbacks.forEach((callback) => {
      callback();
    });

    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(mockTransportManager.instance.stop).toHaveBeenCalledWith('uncaughtException');

    setTimeoutSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  it('continues startup when OpenTelemetry initialization fails', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockInitializeOpenTelemetry.mockRejectedValueOnce(new Error('otel init failed'));

    const handle = await createApp();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[Startup] Failed to initialize OpenTelemetry:',
      expect.any(Error),
    );

    await handle.shutdown();
    consoleErrorSpy.mockRestore();
  });

  it('applies only the name override when version is omitted', async () => {
    await composeServices({ name: 'name-only' });

    expect(mockResetConfig).toHaveBeenCalledTimes(1);
    expect(process.env.MCP_SERVER_NAME).toBe('name-only');
    expect(process.env.OTEL_SERVICE_NAME).toBe('name-only');
    expect(process.env.MCP_SERVER_VERSION).toBeUndefined();
    expect(process.env.OTEL_SERVICE_VERSION).toBeUndefined();
  });

  it('applies only the version override when name is omitted', async () => {
    await composeServices({ version: '3.3.3' });

    expect(mockResetConfig).toHaveBeenCalledTimes(1);
    expect(process.env.MCP_SERVER_VERSION).toBe('3.3.3');
    expect(process.env.OTEL_SERVICE_VERSION).toBe('3.3.3');
    expect(process.env.MCP_SERVER_NAME).toBeUndefined();
    expect(process.env.OTEL_SERVICE_NAME).toBeUndefined();
  });

  it('does not overwrite an already-set OTEL_SERVICE_NAME/VERSION when name/version overrides are applied', async () => {
    process.env.OTEL_SERVICE_NAME = 'preexisting-otel-name';
    process.env.OTEL_SERVICE_VERSION = 'preexisting-otel-version';

    await composeServices({ name: 'new-name', version: '9.9.9' });

    expect(process.env.MCP_SERVER_NAME).toBe('new-name');
    expect(process.env.MCP_SERVER_VERSION).toBe('9.9.9');
    expect(process.env.OTEL_SERVICE_NAME).toBe('preexisting-otel-name');
    expect(process.env.OTEL_SERVICE_VERSION).toBe('preexisting-otel-version');
  });

  it('does not call resetConfig or touch env when neither name nor version is provided', async () => {
    await composeServices({});

    expect(mockResetConfig).not.toHaveBeenCalled();
    expect(process.env.MCP_SERVER_NAME).toBeUndefined();
    expect(process.env.MCP_SERVER_VERSION).toBeUndefined();
  });

  it('throws when supabase serviceRoleKey is present but url is missing', async () => {
    mockConfig.storage.providerType = 'supabase';
    mockConfig.supabase = { serviceRoleKey: 'service-role-key', url: undefined };

    await expect(composeServices()).rejects.toThrow(
      'Supabase URL or service role key is missing for admin client.',
    );
  });

  it('throws when supabase url is present but serviceRoleKey is missing', async () => {
    mockConfig.storage.providerType = 'supabase';
    mockConfig.supabase = { serviceRoleKey: undefined, url: 'https://example.supabase.co' };

    await expect(composeServices()).rejects.toThrow(
      'Supabase URL or service role key is missing for admin client.',
    );
  });

  it('does not construct an llmProvider when openrouterApiKey is unset', async () => {
    const composed = await composeServices();

    expect(MockOpenRouterProvider).not.toHaveBeenCalled();
    expect(composed.coreServices).not.toHaveProperty('llmProvider');
  });

  it('does not construct speechService when config.speech is undefined', async () => {
    const composed = await composeServices();

    expect(MockSpeechService).not.toHaveBeenCalled();
    expect(composed.coreServices).not.toHaveProperty('speechService');
  });

  it('does not construct speechService when config.speech is set but neither tts nor stt is enabled', async () => {
    mockConfig.speech = {
      tts: { enabled: false, provider: 'elevenlabs' },
      stt: { enabled: false, provider: 'whisper' },
    };

    const composed = await composeServices();

    expect(MockSpeechService).not.toHaveBeenCalled();
    expect(composed.coreServices).not.toHaveProperty('speechService');
  });

  it('constructs speechService with only the tts config when only tts is enabled', async () => {
    mockConfig.speech = { tts: { enabled: true, provider: 'elevenlabs' } };

    const composed = await composeServices();

    expect(MockSpeechService).toHaveBeenCalledWith(mockConfig.speech.tts, undefined);
    expect(composed.coreServices.speechService).toBeDefined();
  });

  it('constructs speechService with only the stt config when only stt is enabled', async () => {
    mockConfig.speech = { stt: { enabled: true, provider: 'whisper' } };

    const composed = await composeServices();

    expect(MockSpeechService).toHaveBeenCalledWith(undefined, mockConfig.speech.stt);
    expect(composed.coreServices.speechService).toBeDefined();
  });

  it('exposes canvas on coreServices when createCanvasService returns an instance', async () => {
    const canvasInstance = { kind: 'canvas', shutdown: vi.fn(async () => {}) };
    mockCreateCanvasService.mockReturnValueOnce(canvasInstance);

    const composed = await composeServices();

    expect(mockCreateCanvasService).toHaveBeenCalledWith(mockConfig);
    expect(composed.coreServices.canvas).toBe(canvasInstance);
  });

  it('omits canvas from coreServices when createCanvasService returns undefined', async () => {
    const composed = await composeServices();

    expect(composed.coreServices).not.toHaveProperty('canvas');
  });

  it('calls canvas.shutdown during graceful app shutdown when canvas is present', async () => {
    const canvasShutdown = vi.fn(async () => {});
    mockCreateCanvasService.mockReturnValueOnce({ kind: 'canvas', shutdown: canvasShutdown });

    const handle = await createApp();
    await handle.shutdown('SIGTERM');

    expect(canvasShutdown).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'ServerShutdown',
        extra: expect.objectContaining({ triggerEvent: 'SIGTERM' }),
      }),
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Graceful shutdown completed successfully.',
      expect.objectContaining({ operation: 'ServerShutdown' }),
    );
  });

  it('logs a warning and completes shutdown when canvas.shutdown rejects', async () => {
    const canvasShutdown = vi.fn(async () => {
      throw new Error('canvas shutdown boom');
    });
    mockCreateCanvasService.mockReturnValueOnce({ kind: 'canvas', shutdown: canvasShutdown });

    const handle = await createApp();
    await handle.shutdown('SIGTERM');

    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Canvas shutdown raised — continuing.',
      expect.objectContaining({
        extra: expect.objectContaining({ error: 'canvas shutdown boom' }),
      }),
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Graceful shutdown completed successfully.',
      expect.objectContaining({ operation: 'ServerShutdown' }),
    );
    expect(mockLogger.error).not.toHaveBeenCalledWith(
      'Critical error during shutdown process.',
      expect.anything(),
      expect.objectContaining({ operation: 'ServerShutdown' }),
    );
  });

  describe('ServerInit startup line', () => {
    const makeTool = (name: string) =>
      tool(name, {
        description: `Tool ${name}.`,
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('Always true.') }),
        handler: () => ({ ok: true }),
      });
    const serverInitCall = () =>
      mockLogger.info.mock.calls.find(
        ([, context]) => (context as { operation?: string })?.operation === 'ServerInit',
      );

    it('reads exactly as before when no tool is disabled', async () => {
      const handle = await createApp({ tools: [makeTool('alpha'), makeTool('beta')] });

      const [message, context] = serverInitCall() ?? [];
      expect(message).toBe(
        'Core services constructed — 2 tool(s), 0 resource(s), 0 prompt(s). Storage: in-memory.',
      );
      expect((context as { extra: Record<string, unknown> }).extra).toEqual({
        prompts: [],
        resources: [],
        tools: ['alpha', 'beta'],
      });
      await handle.shutdown();
    });

    it('counts and lists a disabled tool apart from the registered ones', async () => {
      const spanAttributes = new Map<string, unknown>();
      const span = {
        setAttribute: vi.fn((key: string, value: unknown) => spanAttributes.set(key, value)),
      };
      // The startup span and its nested transport span.
      mockWithSpan
        .mockImplementationOnce(async (_name, fn) => await fn(span as never))
        .mockImplementationOnce(async (_name, fn) => await fn(span as never));

      const handle = await createApp({
        tools: [
          makeTool('alpha'),
          disabledTool(makeTool('gated'), { reason: 'Writes are off.' }),
          makeTool('beta'),
        ],
      });

      const [message, context] = serverInitCall() ?? [];
      expect(message).toBe(
        'Core services constructed — 2 tool(s) (+1 disabled: gated), 0 resource(s), 0 prompt(s). Storage: in-memory.',
      );
      expect((context as { extra: Record<string, unknown> }).extra).toMatchObject({
        disabledTools: ['gated'],
        tools: ['alpha', 'beta'],
      });
      // The manifest and the startup span keep counting every definition.
      expect(MockTransportManager).toHaveBeenCalledWith(
        mockConfig,
        mockLogger,
        expect.any(Function),
        expect.objectContaining({ definitionCounts: { prompts: 0, resources: 0, tools: 3 } }),
        expect.anything(),
      );
      expect(spanAttributes.get('mcp.server.tools_count')).toBe(3);
      await handle.shutdown();
    });

    it('reports zero registered tools when every tool is disabled', async () => {
      const handle = await createApp({
        tools: [
          disabledTool(makeTool('one'), { reason: 'Off.' }),
          disabledTool(makeTool('two'), { reason: 'Off.' }),
        ],
      });

      const [message, context] = serverInitCall() ?? [];
      expect(message).toBe(
        'Core services constructed — 0 tool(s) (+2 disabled: one, two), 0 resource(s), 0 prompt(s). Storage: in-memory.',
      );
      expect((context as { extra: Record<string, unknown> }).extra).toMatchObject({
        disabledTools: ['one', 'two'],
        tools: [],
      });
      await handle.shutdown();
    });
  });

  it('does not suppress colors when transport is http and stdout is a TTY', async () => {
    process.env.MCP_TRANSPORT_TYPE = 'http';
    mockConfig.mcpTransportType = 'http';
    process.stdout.isTTY = true;

    const handle = await createApp();

    expect(process.env.NO_COLOR).toBeUndefined();
    expect(process.env.FORCE_COLOR).toBeUndefined();

    await handle.shutdown();
  });

  it('suppresses colors when transport is http and stdout is not a TTY', async () => {
    process.env.MCP_TRANSPORT_TYPE = 'http';
    mockConfig.mcpTransportType = 'http';
    process.stdout.isTTY = false;

    const handle = await createApp();

    expect(process.env.NO_COLOR).toBe('1');
    expect(process.env.FORCE_COLOR).toBe('0');

    await handle.shutdown();
  });

  it('prints a startup config error banner and exits when composeServices throws a ConfigurationError (DEBUG unset)', async () => {
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_: number) => undefined as never) as typeof process.exit);
    const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { z } = await import('zod');
    const schema = z.object({ apiKey: z.string() });
    const setup = () => {
      schema.parse({ apiKey: undefined });
    };

    const { McpError } = await import('@/types-global/errors.js');
    await expect(createApp({ setup })).rejects.toBeInstanceOf(McpError);

    expect(processExitSpy).toHaveBeenCalledWith(1);
    const written = stderrWriteSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain('Configuration error — server failed to start');
    expect(written).toContain('Server setup failed');
    expect(written).toContain('Set DEBUG=true for the full stack trace.');
    expect(written).not.toContain('Data:');

    stderrWriteSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  it('prints config error data and stack trace to stderr when DEBUG=true', async () => {
    process.env.DEBUG = 'true';
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_: number) => undefined as never) as typeof process.exit);
    const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { z } = await import('zod');
    const schema = z.object({ apiKey: z.string() });
    const setup = () => {
      schema.parse({ apiKey: undefined });
    };

    const { McpError } = await import('@/types-global/errors.js');
    await expect(createApp({ setup })).rejects.toBeInstanceOf(McpError);

    const written = stderrWriteSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(written).not.toContain('Set DEBUG=true for the full stack trace.');
    expect(written).toContain('Data:');
    expect(written).toContain('issues');

    stderrWriteSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  it('surfaces records held from before logger initialization when startup fails', async () => {
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_: number) => undefined as never) as typeof process.exit);
    const setup = () => {
      throw new Error('mirror unreachable');
    };

    // Composition runs before the logger has sinks, so a `setup()` line
    // describing the failure is still buffered when the process gives up.
    await expect(createApp({ setup })).rejects.toThrow('mirror unreachable');

    expect(mockLogger.drainPendingToStderr).toHaveBeenCalledTimes(1);

    processExitSpy.mockRestore();
  });

  it('does not print a startup banner or exit when createApp fails with a non-configuration error', async () => {
    const original = new Error('database unreachable');
    const setup = () => {
      throw original;
    };
    const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_: number) => undefined as never) as typeof process.exit);

    await expect(createApp({ setup })).rejects.toBe(original);

    expect(processExitSpy).not.toHaveBeenCalled();
    expect(stderrWriteSpy).not.toHaveBeenCalled();

    stderrWriteSpy.mockRestore();
    processExitSpy.mockRestore();
  });
  // -------------------------------------------------------------------------
  // Stdin EOF (#322)
  // -------------------------------------------------------------------------

  describe('stdin EOF', () => {
    let processExitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      mockObserveStdinEof.mockReturnValue(mockStopWatchingStdin);
      processExitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(((_: number) => undefined as never) as typeof process.exit);
    });

    afterEach(() => {
      processExitSpy.mockRestore();
    });

    /** The `onEof` callback the app handed the watcher. */
    const getStdinEofHandler = (): (() => void) => {
      const call = mockObserveStdinEof.mock.calls.at(-1);
      expect(call).toBeDefined();
      return call![0].onEof;
    };

    it('watches stdin under the stdio transport and leaves it alone under http', async () => {
      const stdioHandle = await createApp();
      expect(mockObserveStdinEof).toHaveBeenCalledTimes(1);
      await stdioHandle.shutdown();

      mockObserveStdinEof.mockClear();
      mockConfig.mcpTransportType = 'http';

      const httpHandle = await createApp();
      expect(mockObserveStdinEof).not.toHaveBeenCalled();
      await httpHandle.shutdown();
    });

    it('runs the same cleanup path a signal runs, then exits', async () => {
      await createApp();

      getStdinEofHandler()();
      await flushAsyncWork();

      expect(mockTransportManager.instance.stop).toHaveBeenCalledTimes(1);
      expect(mockTransportManager.instance.stop).toHaveBeenCalledWith('STDIN_EOF');
      expect(mockShutdownOpenTelemetry).toHaveBeenCalledTimes(1);
      expect(mockLogger.close).toHaveBeenCalledTimes(1);
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('does not re-enter shutdown when a signal handler fires after EOF', async () => {
      await createApp();
      const onSigterm = getProcessHandler('SIGTERM') as () => void;

      getStdinEofHandler()();
      await flushAsyncWork();
      onSigterm();
      await flushAsyncWork();

      expect(mockTransportManager.instance.stop).toHaveBeenCalledTimes(1);
      expect(mockTransportManager.instance.stop).toHaveBeenCalledWith('STDIN_EOF');
      expect(mockLogger.close).toHaveBeenCalledTimes(1);
    });

    it('stops watching stdin when shutdown runs, so EOF after a signal cannot fire', async () => {
      const handle = await createApp();
      expect(mockObserveStdinEof).toHaveBeenCalledTimes(1);

      await handle.shutdown('SIGTERM');

      expect(mockStopWatchingStdin).toHaveBeenCalledTimes(1);
    });

    it('exits only after cleanup has settled', async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      mockTransportManager.instance.stop.mockReturnValueOnce(promise);

      await createApp();
      getStdinEofHandler()();
      await flushAsyncWork();

      expect(mockLogger.close).not.toHaveBeenCalled();
      expect(processExitSpy).not.toHaveBeenCalled();

      resolve();
      await flushAsyncWork();

      expect(mockLogger.close).toHaveBeenCalledTimes(1);
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('terminates the process even when a cleanup step never settles', async () => {
      const cleanup = Promise.withResolvers<void>();
      mockTransportManager.instance.stop.mockReturnValueOnce(cleanup.promise);

      await createApp();

      const backstops: Array<() => void> = [];
      const handles: Array<{ unref: ReturnType<typeof vi.fn> }> = [];
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        callback: Parameters<typeof setTimeout>[0],
      ) => {
        if (typeof callback === 'function') backstops.push(callback);
        const handle = { unref: vi.fn() };
        handles.push(handle);
        return handle as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);

      getStdinEofHandler()();
      await flushAsyncWork();

      expect(processExitSpy).not.toHaveBeenCalled();
      expect(backstops).toHaveLength(1);

      /**
       * Ref'd on purpose (#322), unlike `fatalShutdown`'s backstop: it holds the
       * event loop open across the drain, so the stdin EOF that started this
       * shutdown cannot drain-exit the process out from under the cleanup.
       */
      expect(handles[0]?.unref).not.toHaveBeenCalled();

      backstops[0]?.();
      expect(processExitSpy).toHaveBeenCalledWith(0);

      setTimeoutSpy.mockRestore();
      cleanup.resolve();
      await flushAsyncWork();
    });
  });

  // -------------------------------------------------------------------------
  // Signal shutdown and the teardown hook (#435)
  // -------------------------------------------------------------------------

  /** Captures every backstop timer a shutdown handler arms, without running it. */
  const captureBackstops = () => {
    const callbacks: Array<() => void> = [];
    const handles: Array<{ unref: ReturnType<typeof vi.fn> }> = [];
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: Parameters<typeof setTimeout>[0],
    ) => {
      if (typeof callback === 'function') callbacks.push(callback);
      const handle = { unref: vi.fn() };
      handles.push(handle);
      return handle as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    return { callbacks, handles, restore: () => spy.mockRestore() };
  };

  describe('signal shutdown', () => {
    let processExitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      processExitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(((_: number) => undefined as never) as typeof process.exit);
    });

    afterEach(() => {
      processExitSpy.mockRestore();
    });

    it.each(['SIGTERM', 'SIGINT'] as const)(
      '%s runs the cleanup path once and then exits 0',
      async (signal) => {
        await createApp();

        (getProcessHandler(signal) as () => void)();
        await flushAsyncWork();

        expect(mockTransportManager.instance.stop).toHaveBeenCalledTimes(1);
        expect(mockTransportManager.instance.stop).toHaveBeenCalledWith(signal);
        expect(mockShutdownOpenTelemetry).toHaveBeenCalledTimes(1);
        expect(mockLogger.close).toHaveBeenCalledTimes(1);
        expect(processExitSpy).toHaveBeenCalledWith(0);
        expect(processExitSpy).toHaveBeenCalledTimes(1);
      },
    );

    it('detaches its own listeners so a second signal keeps the default disposition', async () => {
      await createApp();
      const onSigterm = getProcessHandler('SIGTERM') as () => void;

      onSigterm();

      // Synchronously, before the handler yields: a signal arriving in the
      // window between `isShuttingDown = true` and the first await would
      // otherwise hit the re-entry guard and be swallowed instead of killing.
      expect(processRemoveListenerSpy).toHaveBeenCalledWith('SIGTERM', onSigterm);
      expect(processRemoveListenerSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));

      await flushAsyncWork();

      // Re-entry is a no-op regardless — the OS default is what kills a
      // second time, and this handler never gets it.
      onSigterm();
      await flushAsyncWork();
      expect(mockTransportManager.instance.stop).toHaveBeenCalledTimes(1);
    });

    it('does not cut off a cleanup step that is still progressing', async () => {
      const cleanup = Promise.withResolvers<void>();
      mockTransportManager.instance.stop.mockReturnValueOnce(cleanup.promise);
      const backstop = captureBackstops();

      await createApp();
      (getProcessHandler('SIGTERM') as () => void)();
      await flushAsyncWork();

      // Ceiling armed but not fired: nothing exits, and the flush has not run.
      expect(backstop.callbacks).toHaveLength(1);
      expect(mockShutdownOpenTelemetry).not.toHaveBeenCalled();
      expect(mockLogger.close).not.toHaveBeenCalled();
      expect(processExitSpy).not.toHaveBeenCalled();

      cleanup.resolve();
      await flushAsyncWork();

      expect(mockShutdownOpenTelemetry).toHaveBeenCalledTimes(1);
      expect(mockLogger.close).toHaveBeenCalledTimes(1);
      expect(processExitSpy).toHaveBeenCalledWith(0);
      expect(mockLogger.warning).not.toHaveBeenCalledWith(
        expect.stringContaining('did not settle'),
        expect.anything(),
      );

      backstop.restore();
    });

    it("arms a ref'd ceiling that exits 1 and names the step that never settled", async () => {
      const stuck = Promise.withResolvers<void>();
      mockTransportManager.instance.stop.mockReturnValueOnce(stuck.promise);
      const backstop = captureBackstops();

      await createApp();
      (getProcessHandler('SIGTERM') as () => void)();
      await flushAsyncWork();

      // Ref'd, like the EOF path's: the loop must stay open across the drain.
      expect(backstop.handles[0]?.unref).not.toHaveBeenCalled();

      backstop.callbacks[0]?.();

      expect(mockLogger.warning).toHaveBeenCalledWith(
        expect.stringContaining('did not settle'),
        expect.objectContaining({
          extra: expect.objectContaining({ cleanupStep: 'transport', triggerEvent: 'SIGTERM' }),
        }),
      );
      expect(processExitSpy).toHaveBeenCalledWith(1);

      backstop.restore();
      stuck.resolve();
      await flushAsyncWork();
    });

    it('leaves a direct shutdown() call and the startup-failure path exit-free', async () => {
      const handle = await createApp();
      await handle.shutdown();
      expect(processExitSpy).not.toHaveBeenCalled();

      vi.clearAllMocks();
      mockInitializeOpenTelemetry.mockResolvedValue(undefined);
      mockTransportManager.instance.start.mockRejectedValueOnce(new Error('bind failed'));

      await expect(createApp()).rejects.toThrow('bind failed');
      expect(mockTransportManager.instance.stop).toHaveBeenCalledWith('STARTUP_FAILURE');
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it('closes the logger after a rejected telemetry flush, logging the failure first', async () => {
      mockShutdownOpenTelemetry.mockRejectedValueOnce(
        new Error('OpenTelemetry SDK shutdown timeout'),
      );

      await createApp();
      (getProcessHandler('SIGTERM') as () => void)();
      await flushAsyncWork();

      expect(mockLogger.warning).toHaveBeenCalledWith(
        expect.stringContaining('OpenTelemetry flush failed'),
        expect.objectContaining({
          extra: expect.objectContaining({
            cleanupStep: 'telemetry-flush',
            error: 'OpenTelemetry SDK shutdown timeout',
          }),
        }),
      );
      expect(mockLogger.close).toHaveBeenCalledTimes(1);
      const warningOrder = mockLogger.warning.mock.invocationCallOrder.at(-1) as number;
      const [closeOrder] = mockLogger.close.mock.invocationCallOrder;
      expect(warningOrder).toBeLessThan(closeOrder as number);
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('names logger-close when the ceiling fires after a rejected telemetry flush', async () => {
      const stuck = Promise.withResolvers<void>();
      mockShutdownOpenTelemetry.mockRejectedValueOnce(new Error('flush failed'));
      mockLogger.close.mockReturnValueOnce(stuck.promise);
      const backstop = captureBackstops();

      await createApp();
      (getProcessHandler('SIGTERM') as () => void)();
      await flushAsyncWork();
      backstop.callbacks[0]?.();

      expect(mockLogger.warning).toHaveBeenCalledWith(
        expect.stringContaining('did not settle'),
        expect.objectContaining({
          extra: expect.objectContaining({ cleanupStep: 'logger-close' }),
        }),
      );
      expect(processExitSpy).toHaveBeenCalledWith(1);

      backstop.restore();
      stuck.resolve();
      await flushAsyncWork();
    });
  });

  describe('teardown hook', () => {
    let processExitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      mockObserveStdinEof.mockReturnValue(mockStopWatchingStdin);
      processExitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(((_: number) => undefined as never) as typeof process.exit);
    });

    afterEach(() => {
      processExitSpy.mockRestore();
    });

    it('runs once, after the transport stops and before the logger closes', async () => {
      const teardown = vi.fn();
      const handle = await createApp({ teardown });

      await handle.shutdown('SIGTERM');

      expect(teardown).toHaveBeenCalledTimes(1);
      expect(teardown).toHaveBeenCalledWith(handle.services);
      const [stopOrder] = mockTransportManager.instance.stop.mock.invocationCallOrder;
      const [teardownOrder] = teardown.mock.invocationCallOrder;
      const [closeOrder] = mockLogger.close.mock.invocationCallOrder;
      expect(stopOrder).toBeLessThan(teardownOrder as number);
      expect(teardownOrder).toBeLessThan(closeOrder as number);
    });

    it('runs on the signal path and on the stdin EOF path', async () => {
      const signalTeardown = vi.fn();
      await createApp({ teardown: signalTeardown });
      (getProcessHandler('SIGTERM') as () => void)();
      await flushAsyncWork();
      expect(signalTeardown).toHaveBeenCalledTimes(1);
      expect(processExitSpy).toHaveBeenCalledWith(0);

      vi.clearAllMocks();
      mockInitializeOpenTelemetry.mockResolvedValue(undefined);
      mockObserveStdinEof.mockReturnValue(mockStopWatchingStdin);

      const eofTeardown = vi.fn();
      await createApp({ teardown: eofTeardown });
      mockObserveStdinEof.mock.calls.at(-1)?.[0].onEof();
      await flushAsyncWork();
      expect(eofTeardown).toHaveBeenCalledTimes(1);
    });

    it('logs a throwing hook and completes the shutdown anyway', async () => {
      const boom = new Error('watcher close failed');
      await createApp({
        teardown: () => {
          throw boom;
        },
      });

      (getProcessHandler('SIGTERM') as () => void)();
      await flushAsyncWork();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'teardown() raised — continuing shutdown.',
        boom,
        expect.anything(),
      );
      expect(mockLogger.close).toHaveBeenCalledTimes(1);
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('is cut by the ceiling with exit code 1 when it never settles', async () => {
      const stuck = Promise.withResolvers<void>();
      const backstop = captureBackstops();

      await createApp({ teardown: () => stuck.promise });
      (getProcessHandler('SIGTERM') as () => void)();
      await flushAsyncWork();

      expect(mockLogger.close).not.toHaveBeenCalled();
      backstop.callbacks[0]?.();

      expect(mockLogger.warning).toHaveBeenCalledWith(
        expect.stringContaining('did not settle'),
        expect.objectContaining({ extra: expect.objectContaining({ cleanupStep: 'teardown' }) }),
      );
      expect(processExitSpy).toHaveBeenCalledWith(1);

      backstop.restore();
      stuck.resolve();
      await flushAsyncWork();
    });
  });

  // -------------------------------------------------------------------------
  // Cache hints (#359)
  // -------------------------------------------------------------------------

  describe('cache hints', () => {
    /** A resource carrying whatever hint a case wants to put on the wire. */
    const withHint = (cacheHint: { cacheScope?: 'public' | 'private'; ttlMs?: number }) =>
      resource('hinted://doc', {
        name: 'hinted_doc',
        description: 'A hinted document.',
        cacheHint,
        handler: () => ({ ok: true }),
      });

    it('forwards the per-operation map to createMcpServerInstance', async () => {
      const cacheHints = {
        'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' as const },
        'resources/read': { ttlMs: 0 },
      };

      const composed = await composeServices({ cacheHints });
      await composed.createServer({ era: 'modern' });

      expect(mockCreateMcpServerInstance).toHaveBeenCalledWith(
        expect.objectContaining({ cacheHints }),
      );
    });

    it('omits the option entirely when no hints are configured', async () => {
      const plain = resource('plain://doc', {
        name: 'plain_doc',
        description: 'A resource that declares no cache hint.',
        handler: () => ({ ok: true }),
      });

      const composed = await composeServices({ resources: [plain] });
      await composed.createServer({ era: 'modern' });

      expect(mockCreateMcpServerInstance).toHaveBeenCalledWith(
        expect.not.objectContaining({ cacheHints: expect.anything() }),
      );
    });

    it.each([
      ['negative', -1],
      ['fractional', 1.5],
      ['past the safe-integer range', Number.MAX_SAFE_INTEGER + 1],
      ['not a number at all', Number.NaN],
      ['infinite', Number.POSITIVE_INFINITY],
    ])('rejects a %s per-operation ttlMs by name', async (_label, ttlMs) => {
      // Without the framework's own check this resolves, and the bad value
      // surfaces later as a bare SDK RangeError from the McpServer constructor.
      const error = await composeServices({ cacheHints: { 'tools/list': { ttlMs } } }).then(
        () => undefined,
        (err: unknown) => err,
      );

      expect(error).toBeMcpError(JsonRpcErrorCode.ConfigurationError);
      expect((error as Error).message).toContain("cacheHints['tools/list'].ttlMs");
      expect((error as Error).message).toContain('non-negative safe integer');
    });

    it('rejects an invalid per-resource ttlMs by resource name', async () => {
      const error = await composeServices({ resources: [withHint({ ttlMs: -5 })] }).then(
        () => undefined,
        (err: unknown) => err,
      );

      expect(error).toBeMcpError(JsonRpcErrorCode.ConfigurationError);
      expect((error as Error).message).toContain("resource 'hinted_doc' cacheHint.ttlMs");
    });

    it('names an unnamed resource by its URI template', async () => {
      const anonymous = resource('anon://{id}', {
        description: 'A resource that never declared a name.',
        cacheHint: { ttlMs: -1 },
        handler: () => ({ ok: true }),
      });

      const error = await composeServices({ resources: [anonymous] }).then(
        () => undefined,
        (err: unknown) => err,
      );

      expect(error).toBeMcpError(JsonRpcErrorCode.ConfigurationError);
      expect((error as Error).message).toContain("resource 'anon://{id}' cacheHint.ttlMs");
    });

    it('accepts the boundary values the spec allows', async () => {
      await expect(
        composeServices({
          cacheHints: { 'tools/list': { ttlMs: 0 }, 'server/discover': { cacheScope: 'public' } },
          resources: [withHint({ ttlMs: Number.MAX_SAFE_INTEGER })],
        }),
      ).resolves.toBeDefined();
    });
  });
});

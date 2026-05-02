/**
 * @fileoverview Unit tests for the application composition root.
 * @module tests/unit/core/app.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LintReport } from '@/linter/types.js';

const {
  mockConfig,
  mockCreateMcpServerInstance,
  mockCreateObservableGauge,
  mockCreateStorageProvider,
  mockInitErrorMetrics,
  mockInitHandlerMetrics,
  mockInitHeartbeatMetrics,
  mockInitHighResTimer,
  mockInitHttpClientMetrics,
  mockInitRateLimitMetrics,
  mockInitSessionMetrics,
  mockInitializeOpenTelemetry,
  mockLogger,
  mockPromptRegistry,
  mockRateLimiter,
  mockRequestContextService,
  mockResetConfig,
  mockResourceRegistry,
  mockRootsRegistry,
  mockSchedulerService,
  mockShutdownOpenTelemetry,
  mockTaskManager,
  mockToolRegistry,
  mockTransportManager,
  mockValidateDefinitions,
  mockWithSpan,
  MockOpenRouterProvider,
  MockPromptRegistry,
  MockRateLimiter,
  MockResourceRegistry,
  MockRootsRegistry,
  MockSpeechService,
  MockStorageService,
  MockTaskManager,
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
    tasks: {
      defaultTtlMs: 60_000,
    },
  };

  const mockLogger = {
    close: vi.fn(async () => {}),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    initialize: vi.fn(async () => {}),
    warning: vi.fn(),
  };

  const mockValidateDefinitions = vi.fn<() => LintReport>(() => ({
    errors: [],
    passed: true,
    warnings: [],
  }));
  const mockResetConfig = vi.fn();
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

  const mockTaskManager = {
    instance: {
      cleanup: vi.fn(),
      getMessageQueue: vi.fn(() => 'task-message-queue'),
      getTaskStore: vi.fn(() => 'task-store'),
    },
  };
  const MockTaskManager = vi.fn(function MockTaskManager() {
    return mockTaskManager.instance;
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
  const mockRootsRegistry = { instance: { kind: 'roots-registry' } };
  const MockRootsRegistry = vi.fn(function MockRootsRegistry() {
    return mockRootsRegistry.instance;
  });

  const mockCreateMcpServerInstance = vi.fn(async () => ({ server: 'mcp-server' }));

  const mockInitHeartbeatMetrics = vi.fn();
  const mockInitSessionMetrics = vi.fn();
  const mockInitErrorMetrics = vi.fn();
  const mockInitRateLimitMetrics = vi.fn();
  const mockInitHttpClientMetrics = vi.fn();
  const mockInitHandlerMetrics = vi.fn();
  const mockInitHighResTimer = vi.fn(async () => {});
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
    createRequestContext: vi.fn((params?: Record<string, unknown>) => ({
      requestId: 'core-app-request',
      timestamp: '2026-03-30T00:00:00.000Z',
      ...params,
    })),
  };

  const mockSchedulerService = {
    destroyAll: vi.fn(),
  };

  return {
    mockConfig,
    mockCreateMcpServerInstance,
    mockCreateObservableGauge,
    mockCreateStorageProvider,
    mockInitErrorMetrics,
    mockInitHandlerMetrics,
    mockInitHeartbeatMetrics,
    mockInitHighResTimer,
    mockInitHttpClientMetrics,
    mockInitRateLimitMetrics,
    mockInitSessionMetrics,
    mockInitializeOpenTelemetry,
    mockLogger,
    mockPromptRegistry,
    mockRateLimiter,
    mockRequestContextService,
    mockResetConfig,
    mockResourceRegistry,
    mockRootsRegistry,
    mockSchedulerService,
    mockShutdownOpenTelemetry,
    mockTaskManager,
    mockToolRegistry,
    mockTransportManager,
    mockValidateDefinitions,
    mockWithSpan,
    MockOpenRouterProvider,
    MockPromptRegistry,
    MockRateLimiter,
    MockResourceRegistry,
    MockRootsRegistry,
    MockSpeechService,
    MockStorageService,
    MockTaskManager,
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

vi.mock('@/linter/validate.js', () => ({
  validateDefinitions: mockValidateDefinitions,
}));

vi.mock('@/mcp-server/prompts/prompt-registration.js', () => ({
  PromptRegistry: MockPromptRegistry,
}));

vi.mock('@/mcp-server/resources/resource-registration.js', () => ({
  ResourceRegistry: MockResourceRegistry,
}));

vi.mock('@/mcp-server/roots/roots-registration.js', () => ({
  RootsRegistry: MockRootsRegistry,
}));

vi.mock('@/mcp-server/server.js', () => ({
  createMcpServerInstance: mockCreateMcpServerInstance,
}));

vi.mock('@/mcp-server/tasks/core/taskManager.js', () => ({
  TaskManager: MockTaskManager,
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

vi.mock('@/types-global/errors.js', async () => {
  const actual = await vi.importActual<typeof import('@/types-global/errors.js')>(
    '@/types-global/errors.js',
  );
  return actual;
});

vi.mock('@/utils/internal/error-handler/errorHandler.js', () => ({
  initErrorMetrics: mockInitErrorMetrics,
}));

vi.mock('@/utils/internal/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('@/utils/internal/performance.js', () => ({
  initHandlerMetrics: mockInitHandlerMetrics,
  initHighResTimer: mockInitHighResTimer,
}));

vi.mock('@/utils/internal/requestContext.js', () => ({
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
}));

import { composeServices, createApp } from '@/core/app.js';

describe('core/app', () => {
  let originalEnv: NodeJS.ProcessEnv;
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
    process.env.MCP_SERVER_NAME = undefined;
    process.env.MCP_SERVER_VERSION = undefined;
    process.env.OTEL_SERVICE_NAME = undefined;
    process.env.OTEL_SERVICE_VERSION = undefined;
    process.env.NO_COLOR = undefined;
    process.env.FORCE_COLOR = undefined;
    process.env.MCP_TRANSPORT_TYPE = 'stdio';

    mockConfig.environment = 'test';
    mockConfig.logLevel = 'debug';
    mockConfig.mcpServerName = 'mock-server';
    mockConfig.mcpServerVersion = '1.0.0';
    mockConfig.mcpTransportType = 'stdio';
    mockConfig.openrouterApiKey = undefined;
    mockConfig.speech = undefined;
    mockConfig.storage.providerType = 'in-memory';
    mockConfig.supabase = undefined;
    mockValidateDefinitions.mockReturnValue({ errors: [], passed: true, warnings: [] });
    mockInitializeOpenTelemetry.mockResolvedValue(undefined);

    processOnSpy = vi.spyOn(process, 'on');
    processRemoveListenerSpy = vi.spyOn(process, 'removeListener');
  });

  afterEach(async () => {
    processOnSpy.mockRestore();
    processRemoveListenerSpy.mockRestore();
    process.env = originalEnv;
  });

  it('fails fast when MCP definition validation reports errors', async () => {
    mockValidateDefinitions.mockReturnValue({
      errors: [
        {
          definitionName: 'bad_tool',
          definitionType: 'tool',
          message: 'Bad tool schema',
          rule: 'tool-schema',
          severity: 'error',
        },
      ],
      passed: false,
      warnings: [],
    });

    await expect(composeServices()).rejects.toThrow(
      'MCP definition validation failed with 1 error(s)',
    );
    expect(mockCreateStorageProvider).not.toHaveBeenCalled();
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

  it('requires Supabase credentials when the Supabase storage provider is selected', async () => {
    mockConfig.storage.providerType = 'supabase';
    mockConfig.supabase = { serviceRoleKey: undefined, url: undefined };

    await expect(composeServices()).rejects.toThrow(
      'Supabase URL or service role key is missing for admin client.',
    );
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

    await composed.createServer();

    expect(mockCreateMcpServerInstance).toHaveBeenCalledWith({
      config: mockConfig,
      promptRegistry: mockPromptRegistry.instance,
      resourceRegistry: mockResourceRegistry.instance,
      rootsRegistry: mockRootsRegistry.instance,
      taskMessageQueue: 'task-message-queue',
      taskStore: 'task-store',
      toolRegistry: mockToolRegistry.instance,
    });
  });

  it('starts the app, registers shutdown handlers, and performs graceful shutdown', async () => {
    const handle = await createApp({
      name: 'app-under-test',
      version: '2.0.0',
    });

    expect(process.env.NO_COLOR).toBe('1');
    expect(process.env.FORCE_COLOR).toBe('0');
    expect(mockInitializeOpenTelemetry).toHaveBeenCalledTimes(1);
    expect(mockInitHighResTimer).toHaveBeenCalledTimes(1);
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
      mockTaskManager.instance,
      expect.objectContaining({
        definitionCounts: { prompts: 0, resources: 0, tools: 0 },
        server: expect.objectContaining({ name: 'mock-server', version: '1.0.0' }),
      }),
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
    expect(mockTaskManager.instance.cleanup).toHaveBeenCalledTimes(1);
    expect(mockRateLimiter.instance.dispose).toHaveBeenCalledTimes(1);
    expect(mockSchedulerService.destroyAll).toHaveBeenCalledTimes(1);
    expect(mockShutdownOpenTelemetry).toHaveBeenCalledTimes(1);
    expect(mockLogger.close).toHaveBeenCalledTimes(1);
  });

  it('logs lint warnings and exposes executable process gauge callbacks', async () => {
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

    mockValidateDefinitions.mockReturnValue({
      errors: [],
      passed: true,
      warnings: [
        {
          definitionName: 'tool_a',
          definitionType: 'tool',
          message: 'Warn once',
          rule: 'warning-rule',
          severity: 'warning',
        },
      ],
    });

    const handle = await createApp();

    expect(mockLogger.warning).toHaveBeenCalledWith('[mcp-lint] warning-rule: Warn once');

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
        triggerEvent: 'MANUAL',
      }),
    );
    expect(mockShutdownOpenTelemetry).toHaveBeenCalledTimes(1);
    expect(mockLogger.close).toHaveBeenCalledTimes(1);
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
      expect.objectContaining({ triggerEvent: 'uncaughtException' }),
    );
    expect(mockLogger.fatal).toHaveBeenCalledWith(
      'FATAL: Unhandled promise rejection detected.',
      expect.objectContaining({ message: 'rejection boom' }),
      expect.objectContaining({ triggerEvent: 'unhandledRejection' }),
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

  it('registered signal handlers delegate to graceful shutdown', async () => {
    await createApp();

    const onSigterm = getProcessHandler('SIGTERM') as () => void;
    onSigterm();
    await flushAsyncWork();

    expect(mockTransportManager.instance.stop).toHaveBeenCalledWith('SIGTERM');

    vi.clearAllMocks();
    mockInitializeOpenTelemetry.mockResolvedValue(undefined);
    processOnSpy.mockClear();
    processRemoveListenerSpy.mockClear();

    await createApp();

    const onSigint = getProcessHandler('SIGINT') as () => void;
    onSigint();
    await flushAsyncWork();

    expect(mockTransportManager.instance.stop).toHaveBeenCalledWith('SIGINT');
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
});

/**
 * @fileoverview Lifecycle tests for OpenTelemetry initialization and shutdown.
 * @module tests/utils/telemetry/instrumentation.lifecycle.test
 */

import { type DiagLogger, DiagLogLevel, diag } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const otelState = vi.hoisted(() => ({
  batchLogProcessorOptions: [] as Array<Record<string, unknown>>,
  batchSpanProcessorArgs: [] as unknown[],
  getLoggerSpy: vi.fn((name: string, version?: string) => ({ emit: vi.fn(), name, version })),
  httpInstrumentationOptions: [] as Array<Record<string, unknown>>,
  logExporterOptions: [] as Array<Record<string, unknown>>,
  logModulesLoaded: [] as string[],
  metricExporterOptions: [] as Array<Record<string, unknown>>,
  metricReaderOptions: [] as Array<Record<string, unknown>>,
  nodeSdkEnvLogLevel: [] as Array<string | undefined>,
  nodeSdkOptions: [] as Array<Record<string, unknown>>,
  pinoInstrumentationOptions: [] as Array<Record<string, unknown>>,
  resourceFromAttributesSpy: vi.fn((attrs: Record<string, unknown>) => ({ attrs })),
  sdkShutdownSpy: vi.fn().mockResolvedValue(undefined),
  sdkStartSpy: vi.fn(),
  setOtelLogSinkSpy: vi.fn(),
  traceExporterOptions: [] as Array<Record<string, unknown>>,
  traceIdSamplerRatios: [] as number[],
}));

const mockConfig = vi.hoisted(() => ({
  environment: 'test',
  openTelemetry: {
    enabled: true,
    logLevel: 'info',
    logsEndpoint: undefined as string | undefined,
    metricsEndpoint: 'http://localhost:4318/v1/metrics',
    samplingRatio: 0.5,
    serviceName: 'test-service',
    serviceVersion: '1.0.0',
    tracesEndpoint: 'http://localhost:4318/v1/traces',
  },
}));

const mockRuntimeCaps = vi.hoisted(() => ({
  hasBuffer: true,
  hasPerformanceNow: true,
  hasProcess: true,
  hasTextEncoder: true,
  isBrowserLike: false,
  isBun: false,
  isNode: true,
  isWorkerLike: false,
}));

vi.mock('@/config/index.js', () => ({
  config: mockConfig,
}));

vi.mock('@/utils/internal/runtime.js', () => ({
  runtimeCaps: mockRuntimeCaps,
}));

vi.mock('@/utils/internal/logger.js', () => ({
  setOtelLogSink: otelState.setOtelLogSinkSpy,
}));

vi.mock('@opentelemetry/sdk-logs', () => {
  otelState.logModulesLoaded.push('@opentelemetry/sdk-logs');
  return {
    BatchLogRecordProcessor: class BatchLogRecordProcessor {
      constructor(options: Record<string, unknown>) {
        otelState.batchLogProcessorOptions.push(options);
      }
    },
  };
});

vi.mock('@opentelemetry/exporter-logs-otlp-http', () => {
  otelState.logModulesLoaded.push('@opentelemetry/exporter-logs-otlp-http');
  return {
    OTLPLogExporter: class OTLPLogExporter {
      constructor(options: Record<string, unknown>) {
        otelState.logExporterOptions.push(options);
      }
    },
  };
});

vi.mock('@opentelemetry/api-logs', () => {
  otelState.logModulesLoaded.push('@opentelemetry/api-logs');
  return { logs: { getLogger: otelState.getLoggerSpy } };
});

vi.mock('@opentelemetry/instrumentation-http', () => ({
  HttpInstrumentation: class HttpInstrumentation {
    constructor(options: Record<string, unknown>) {
      otelState.httpInstrumentationOptions.push(options);
    }
  },
}));

vi.mock('@opentelemetry/exporter-metrics-otlp-http', () => ({
  OTLPMetricExporter: class OTLPMetricExporter {
    constructor(options: Record<string, unknown>) {
      otelState.metricExporterOptions.push(options);
    }
  },
}));

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class OTLPTraceExporter {
    constructor(options: Record<string, unknown>) {
      otelState.traceExporterOptions.push(options);
    }
  },
}));

vi.mock('@opentelemetry/instrumentation-pino', () => ({
  PinoInstrumentation: class PinoInstrumentation {
    constructor(options: Record<string, unknown>) {
      otelState.pinoInstrumentationOptions.push(options);
    }
  },
}));

vi.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: otelState.resourceFromAttributesSpy,
}));

vi.mock('@opentelemetry/sdk-metrics', () => ({
  PeriodicExportingMetricReader: class PeriodicExportingMetricReader {
    constructor(options: Record<string, unknown>) {
      otelState.metricReaderOptions.push(options);
    }
  },
}));

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class NodeSDK {
    constructor(options: Record<string, unknown>) {
      otelState.nodeSdkOptions.push(options);
      otelState.nodeSdkEnvLogLevel.push(process.env.OTEL_LOG_LEVEL);
    }

    shutdown() {
      return otelState.sdkShutdownSpy();
    }

    start() {
      otelState.sdkStartSpy();
    }
  },
}));

vi.mock('@opentelemetry/sdk-trace-node', () => ({
  BatchSpanProcessor: class BatchSpanProcessor {
    constructor(exporter: unknown) {
      otelState.batchSpanProcessorArgs.push(exporter);
    }
  },
  TraceIdRatioBasedSampler: class TraceIdRatioBasedSampler {
    constructor(ratio: number) {
      otelState.traceIdSamplerRatios.push(ratio);
    }
  },
}));

vi.mock('@opentelemetry/semantic-conventions', () => ({
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME: 'deployment.environment.name',
  ATTR_SERVICE_NAME: 'service.name',
  ATTR_SERVICE_VERSION: 'service.version',
}));

describe('OpenTelemetry instrumentation lifecycle', () => {
  const originalEnv = {
    AWS_LAMBDA_FUNCTION_NAME: process.env.AWS_LAMBDA_FUNCTION_NAME,
    AWS_REGION: process.env.AWS_REGION,
    FUNCTION_TARGET: process.env.FUNCTION_TARGET,
    GCP_REGION: process.env.GCP_REGION,
    K_SERVICE: process.env.K_SERVICE,
    OTEL_LOG_LEVEL: process.env.OTEL_LOG_LEVEL,
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    // The framework's diag logger writes straight to stderr; keep it out of the test output.
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    otelState.batchLogProcessorOptions.length = 0;
    otelState.batchSpanProcessorArgs.length = 0;
    otelState.httpInstrumentationOptions.length = 0;
    otelState.logExporterOptions.length = 0;
    otelState.logModulesLoaded.length = 0;
    otelState.metricExporterOptions.length = 0;
    otelState.metricReaderOptions.length = 0;
    otelState.nodeSdkEnvLogLevel.length = 0;
    otelState.nodeSdkOptions.length = 0;
    otelState.pinoInstrumentationOptions.length = 0;
    otelState.traceExporterOptions.length = 0;
    otelState.traceIdSamplerRatios.length = 0;
    otelState.sdkShutdownSpy.mockResolvedValue(undefined);
    otelState.sdkStartSpy.mockImplementation(() => {});

    mockConfig.environment = 'test';
    mockConfig.openTelemetry.enabled = true;
    mockConfig.openTelemetry.logLevel = 'info';
    mockConfig.openTelemetry.logsEndpoint = undefined;
    mockConfig.openTelemetry.metricsEndpoint = 'http://localhost:4318/v1/metrics';
    mockConfig.openTelemetry.samplingRatio = 0.5;
    mockConfig.openTelemetry.serviceName = 'test-service';
    mockConfig.openTelemetry.serviceVersion = '1.0.0';
    mockConfig.openTelemetry.tracesEndpoint = 'http://localhost:4318/v1/traces';

    mockRuntimeCaps.isBun = false;
    mockRuntimeCaps.isNode = true;
    mockRuntimeCaps.isWorkerLike = false;

    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.AWS_REGION;
    delete process.env.FUNCTION_TARGET;
    delete process.env.GCP_REGION;
    delete process.env.K_SERVICE;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('skips initialization when telemetry is disabled and stays idempotent', async () => {
    mockConfig.openTelemetry.enabled = false;

    const infoSpy = vi.spyOn(diag, 'info').mockImplementation(() => true);
    const instrumentation = await import('@/utils/telemetry/instrumentation.js');

    await instrumentation.initializeOpenTelemetry();
    await instrumentation.initializeOpenTelemetry();

    expect(instrumentation.sdk).toBeNull();
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith('OpenTelemetry disabled via configuration.');
    expect(otelState.sdkStartSpy).not.toHaveBeenCalled();
  });

  it('uses lightweight mode when the runtime cannot support NodeSDK', async () => {
    mockRuntimeCaps.isNode = false;

    const infoSpy = vi.spyOn(diag, 'info').mockImplementation(() => true);
    const instrumentation = await import('@/utils/telemetry/instrumentation.js');

    await instrumentation.initializeOpenTelemetry();

    expect(instrumentation.sdk).toBeNull();
    expect(infoSpy).toHaveBeenCalledWith(
      'NodeSDK unavailable in this runtime. Using lightweight telemetry mode.',
    );
    expect(otelState.sdkStartSpy).not.toHaveBeenCalled();
  });

  it('initializes NodeSDK with exporters, resource attributes, and instrumentations', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'test-function';
    process.env.AWS_REGION = 'us-west-2';

    const infoSpy = vi.spyOn(diag, 'info').mockImplementation(() => true);
    const setLoggerSpy = vi.spyOn(diag, 'setLogger').mockImplementation(() => true);
    const instrumentation = await import('@/utils/telemetry/instrumentation.js');

    await instrumentation.initializeOpenTelemetry();

    expect(instrumentation.sdk).not.toBeNull();
    expect(setLoggerSpy).toHaveBeenCalledOnce();
    expect(otelState.traceExporterOptions).toEqual([{ url: 'http://localhost:4318/v1/traces' }]);
    expect(otelState.metricExporterOptions).toEqual([{ url: 'http://localhost:4318/v1/metrics' }]);
    // A timeout within the interval, so the reader has nothing to clamp and no boot notice to print.
    expect(otelState.metricReaderOptions).toEqual([
      {
        exporter: expect.any(Object),
        exportIntervalMillis: 15000,
        exportTimeoutMillis: 15000,
      },
    ]);
    expect(otelState.traceIdSamplerRatios).toEqual([0.5]);
    expect(otelState.sdkStartSpy).toHaveBeenCalledOnce();
    expect(otelState.resourceFromAttributesSpy).toHaveBeenCalledWith({
      'cloud.platform': 'aws_lambda',
      'cloud.provider': 'aws',
      'cloud.region': 'us-west-2',
      'deployment.environment.name': 'test',
      'service.name': 'test-service',
      'service.version': '1.0.0',
    });

    const [nodeSdkOptions] = otelState.nodeSdkOptions;
    expect(nodeSdkOptions).toMatchObject({
      logRecordProcessors: [],
      metricReaders: [expect.any(Object)],
      resource: {
        attrs: expect.objectContaining({
          'cloud.provider': 'aws',
          'cloud.platform': 'aws_lambda',
        }),
      },
      sampler: expect.any(Object),
      spanProcessors: [expect.any(Object)],
    });

    const [httpInstrumentationOptions] = otelState.httpInstrumentationOptions;
    expect(httpInstrumentationOptions).toBeDefined();
    if (!httpInstrumentationOptions) {
      throw new Error('HttpInstrumentation options were not captured');
    }
    expect(httpInstrumentationOptions).toHaveProperty('ignoreIncomingRequestHook');
    expect(
      (httpInstrumentationOptions.ignoreIncomingRequestHook as (req: { url?: string }) => boolean)({
        url: '/healthz',
      }),
    ).toBe(true);
    expect(
      (httpInstrumentationOptions.ignoreIncomingRequestHook as (req: { url?: string }) => boolean)({
        url: '/mcp',
      }),
    ).toBe(false);

    const [pinoInstrumentationOptions] = otelState.pinoInstrumentationOptions;
    expect(pinoInstrumentationOptions).toBeDefined();
    if (!pinoInstrumentationOptions) {
      throw new Error('PinoInstrumentation options were not captured');
    }
    const record: Record<string, unknown> = {};
    (pinoInstrumentationOptions.logHook as (span: any, record: Record<string, unknown>) => void)(
      {
        spanContext: () => ({
          spanId: 'span-id',
          traceId: 'trace-id',
        }),
      },
      record,
    );
    expect(record).toEqual({
      span_id: 'span-id',
      trace_id: 'trace-id',
    });
    expect(infoSpy).toHaveBeenCalledWith(
      'Using OTLP exporter for traces, endpoint: http://localhost:4318/v1/traces',
    );
  });

  it('warns when no OTLP endpoints are configured and skips optional exporters', async () => {
    mockConfig.openTelemetry.tracesEndpoint = '';
    mockConfig.openTelemetry.metricsEndpoint = '';

    const infoSpy = vi.spyOn(diag, 'info').mockImplementation(() => true);
    const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => true);
    const { initializeOpenTelemetry } = await import('@/utils/telemetry/instrumentation.js');

    await initializeOpenTelemetry();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'OTEL_ENABLED is true, but no OTLP endpoint for traces, metrics, or logs is configured.',
      ),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      'No OTLP traces endpoint configured. Traces will not be exported.',
    );
    expect(infoSpy).toHaveBeenCalledWith(
      'No OTLP metrics endpoint configured. Metrics will not be exported.',
    );
    expect(otelState.traceExporterOptions).toHaveLength(0);
    expect(otelState.metricExporterOptions).toHaveLength(0);
    expect(otelState.metricReaderOptions).toHaveLength(0);
    // Every list is explicit and empty, so NodeSDK builds no env-default exporter.
    expect(otelState.nodeSdkOptions[0]).toMatchObject({
      logRecordProcessors: [],
      metricReaders: [],
      spanProcessors: [],
    });
  });

  it('passes an empty metric reader list when only a traces endpoint resolves', async () => {
    mockConfig.openTelemetry.metricsEndpoint = '';

    const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => true);
    const { initializeOpenTelemetry } = await import('@/utils/telemetry/instrumentation.js');

    await initializeOpenTelemetry();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(otelState.traceExporterOptions).toEqual([{ url: 'http://localhost:4318/v1/traces' }]);
    expect(otelState.nodeSdkOptions[0]).toMatchObject({
      logRecordProcessors: [],
      metricReaders: [],
      spanProcessors: [expect.any(Object)],
    });
  });

  it('reports only the signal that exports nothing', async () => {
    mockConfig.openTelemetry.tracesEndpoint = '';

    const infoSpy = vi.spyOn(diag, 'info').mockImplementation(() => true);
    const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => true);
    const { initializeOpenTelemetry } = await import('@/utils/telemetry/instrumentation.js');

    await initializeOpenTelemetry();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      'No OTLP traces endpoint configured. Traces will not be exported.',
    );
    expect(infoSpy).toHaveBeenCalledWith(
      'Using OTLP exporter for metrics, endpoint: http://localhost:4318/v1/metrics',
    );
    expect(infoSpy).not.toHaveBeenCalledWith(
      'No OTLP metrics endpoint configured. Metrics will not be exported.',
    );
  });

  it('falls back to lightweight mode under nodejs_compat in Workers', async () => {
    // Cloudflare Workers populate `process.versions.node`, so the legacy
    // `canUseNodeSDK()` returned `true` and tried to load `node:perf_hooks` /
    // `node:worker_threads` (unsupported in the isolate). The fix gates on
    // `!isWorkerLike`, so the NodeSDK path is skipped cleanly.
    mockRuntimeCaps.isNode = true;
    mockRuntimeCaps.isWorkerLike = true;

    const infoSpy = vi.spyOn(diag, 'info').mockImplementation(() => true);
    const instrumentation = await import('@/utils/telemetry/instrumentation.js');

    await instrumentation.initializeOpenTelemetry();

    expect(instrumentation.sdk).toBeNull();
    expect(infoSpy).toHaveBeenCalledWith(
      'NodeSDK unavailable in this runtime. Using lightweight telemetry mode.',
    );
    expect(otelState.sdkStartSpy).not.toHaveBeenCalled();
    expect(otelState.nodeSdkOptions).toHaveLength(0);
  });

  it('detects GCP Cloud Functions resource metadata', async () => {
    process.env.FUNCTION_TARGET = 'gcp-function';
    process.env.GCP_REGION = 'us-central1';

    const instrumentation = await import('@/utils/telemetry/instrumentation.js');

    await instrumentation.initializeOpenTelemetry();

    expect(otelState.resourceFromAttributesSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        'cloud.platform': 'gcp_cloud_functions',
        'cloud.provider': 'gcp',
        'cloud.region': 'us-central1',
      }),
    );
  });

  it('detects GCP Cloud Run resource metadata when only K_SERVICE is set', async () => {
    process.env.K_SERVICE = 'cloud-run-service';

    const instrumentation = await import('@/utils/telemetry/instrumentation.js');

    await instrumentation.initializeOpenTelemetry();

    expect(otelState.resourceFromAttributesSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        'cloud.platform': 'gcp_cloud_run',
        'cloud.provider': 'gcp',
      }),
    );
  });

  it('resets initialization state when startup fails', async () => {
    const failure = new Error('sdk start failed');
    otelState.sdkStartSpy.mockImplementationOnce(() => {
      throw failure;
    });

    const errorSpy = vi.spyOn(diag, 'error').mockImplementation(() => true);
    const instrumentation = await import('@/utils/telemetry/instrumentation.js');

    await expect(instrumentation.initializeOpenTelemetry()).rejects.toBe(failure);
    expect(errorSpy).toHaveBeenCalledWith('Error initializing OpenTelemetry', failure);
    expect(instrumentation.sdk).toBeNull();

    await instrumentation.initializeOpenTelemetry();
    expect(otelState.sdkStartSpy).toHaveBeenCalledTimes(2);
  });

  it('shuts down successfully and clears module state', async () => {
    const infoSpy = vi.spyOn(diag, 'info').mockImplementation(() => true);
    const instrumentation = await import('@/utils/telemetry/instrumentation.js');

    await instrumentation.initializeOpenTelemetry();
    await instrumentation.shutdownOpenTelemetry(50);

    expect(otelState.sdkShutdownSpy).toHaveBeenCalledOnce();
    expect(infoSpy).toHaveBeenCalledWith('OpenTelemetry SDK terminated successfully.');
    expect(instrumentation.sdk).toBeNull();
  });

  it('propagates shutdown failures and clears module state and deadline', async () => {
    vi.useFakeTimers();
    const failure = new Error('shutdown failed');
    const errorSpy = vi.spyOn(diag, 'error').mockImplementation(() => true);
    const instrumentation = await import('@/utils/telemetry/instrumentation.js');

    await instrumentation.initializeOpenTelemetry();
    otelState.sdkShutdownSpy.mockRejectedValueOnce(failure);

    await expect(instrumentation.shutdownOpenTelemetry(50)).rejects.toBe(failure);
    expect(errorSpy).toHaveBeenCalledWith('Error terminating OpenTelemetry SDK', failure);
    expect(vi.getTimerCount()).toBe(0);
    expect(instrumentation.sdk).toBeNull();
  });

  it('returns immediately when shutdown is requested before initialization', async () => {
    const instrumentation = await import('@/utils/telemetry/instrumentation.js');

    await expect(instrumentation.shutdownOpenTelemetry(25)).resolves.toBeUndefined();
    expect(otelState.sdkShutdownSpy).not.toHaveBeenCalled();
  });

  it('shares concurrent initialization and starts a fresh SDK after shutdown', async () => {
    const instrumentation = await import('@/utils/telemetry/instrumentation.js');
    await Promise.all(Array.from({ length: 8 }, () => instrumentation.initializeOpenTelemetry()));
    expect(otelState.nodeSdkOptions).toHaveLength(1);
    expect(otelState.sdkStartSpy).toHaveBeenCalledOnce();
    const firstSdk = instrumentation.sdk;
    await instrumentation.shutdownOpenTelemetry();
    await instrumentation.initializeOpenTelemetry();
    expect(otelState.sdkStartSpy).toHaveBeenCalledTimes(2);
    expect(instrumentation.sdk).not.toBe(firstSdk);
    await instrumentation.shutdownOpenTelemetry();
  });

  it('initializes NodeSDK under Bun when Node APIs are available', async () => {
    mockRuntimeCaps.isBun = true;
    const instrumentation = await import('@/utils/telemetry/instrumentation.js');
    await instrumentation.initializeOpenTelemetry();
    expect(otelState.sdkStartSpy).toHaveBeenCalledOnce();
    expect(instrumentation.sdk).not.toBeNull();
  });

  it.each([
    ['debug', DiagLogLevel.DEBUG],
    ['WARN', DiagLogLevel.WARN],
    ['not-a-level', DiagLogLevel.INFO],
  ])('applies diagnostic level %s', async (configured, expected) => {
    mockConfig.openTelemetry.logLevel = configured;
    const setLogger = vi.spyOn(diag, 'setLogger').mockImplementation(() => true);
    const { initializeOpenTelemetry } = await import('@/utils/telemetry/instrumentation.js');
    await initializeOpenTelemetry();
    expect(setLogger).toHaveBeenCalledWith(expect.any(Object), {
      logLevel: expected,
      suppressOverrideMessage: true,
    });
  });

  it('registers one diag logger that writes every level to stderr, never stdout', async () => {
    const setLogger = vi.spyOn(diag, 'setLogger').mockImplementation(() => true);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { initializeOpenTelemetry } = await import('@/utils/telemetry/instrumentation.js');

    await initializeOpenTelemetry();

    expect(setLogger).toHaveBeenCalledOnce();
    const diagLogger = setLogger.mock.calls[0]?.[0] as DiagLogger;
    for (const level of ['verbose', 'debug', 'info', 'warn', 'error'] as const) {
      diagLogger[level](`diag ${level} line`);
      expect(stderrWrite).toHaveBeenLastCalledWith(`diag ${level} line\n`);
    }
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it('hides OTEL_LOG_LEVEL from the NodeSDK constructor and restores it afterwards', async () => {
    process.env.OTEL_LOG_LEVEL = 'warning';
    const { initializeOpenTelemetry } = await import('@/utils/telemetry/instrumentation.js');

    await initializeOpenTelemetry();

    expect(otelState.nodeSdkEnvLogLevel).toEqual([undefined]);
    expect(process.env.OTEL_LOG_LEVEL).toBe('warning');
  });

  it('leaves OTEL_LOG_LEVEL unset when it was never set', async () => {
    delete process.env.OTEL_LOG_LEVEL;
    const { initializeOpenTelemetry } = await import('@/utils/telemetry/instrumentation.js');

    await initializeOpenTelemetry();

    expect('OTEL_LOG_LEVEL' in process.env).toBe(false);
  });

  describe('OTLP log export', () => {
    it('attaches a batch log processor and the logger sink when the logs endpoint is set', async () => {
      mockConfig.openTelemetry.logsEndpoint = 'http://collector:4318/v1/logs';
      const infoSpy = vi.spyOn(diag, 'info').mockImplementation(() => true);
      const { initializeOpenTelemetry } = await import('@/utils/telemetry/instrumentation.js');

      await initializeOpenTelemetry();

      expect(otelState.logExporterOptions).toEqual([{ url: 'http://collector:4318/v1/logs' }]);
      expect(otelState.batchLogProcessorOptions).toEqual([{ exporter: expect.any(Object) }]);
      expect(otelState.nodeSdkOptions[0]).toMatchObject({
        logRecordProcessors: [expect.any(Object)],
      });
      expect(otelState.getLoggerSpy).toHaveBeenCalledWith('test-service', '1.0.0');
      expect(otelState.setOtelLogSinkSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'test-service', version: '1.0.0' }),
      );
      expect(infoSpy).toHaveBeenCalledWith(
        'Using OTLP exporter for logs, endpoint: http://collector:4318/v1/logs',
      );
    });

    it('never loads the log packages or attaches a sink when the logs endpoint is unset', async () => {
      const { initializeOpenTelemetry } = await import('@/utils/telemetry/instrumentation.js');

      await initializeOpenTelemetry();

      expect(otelState.logModulesLoaded).toEqual([]);
      expect(otelState.setOtelLogSinkSpy).not.toHaveBeenCalled();
      expect(otelState.nodeSdkOptions[0]).toMatchObject({ logRecordProcessors: [] });
    });

    it('does not warn about missing endpoints when only the logs endpoint is set', async () => {
      mockConfig.openTelemetry.tracesEndpoint = '';
      mockConfig.openTelemetry.metricsEndpoint = '';
      mockConfig.openTelemetry.logsEndpoint = 'http://collector:4318/v1/logs';
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => true);
      const { initializeOpenTelemetry } = await import('@/utils/telemetry/instrumentation.js');

      await initializeOpenTelemetry();

      expect(warnSpy).not.toHaveBeenCalled();
      expect(otelState.nodeSdkOptions[0]).toMatchObject({
        logRecordProcessors: [expect.any(Object)],
        metricReaders: [],
        spanProcessors: [],
      });
    });

    it('detaches the logger sink on shutdown', async () => {
      mockConfig.openTelemetry.logsEndpoint = 'http://collector:4318/v1/logs';
      const instrumentation = await import('@/utils/telemetry/instrumentation.js');

      await instrumentation.initializeOpenTelemetry();
      await instrumentation.shutdownOpenTelemetry(50);

      expect(otelState.setOtelLogSinkSpy).toHaveBeenLastCalledWith(undefined);
    });
  });

  it('times out long-running shutdown attempts', async () => {
    vi.useFakeTimers();

    const instrumentation = await import('@/utils/telemetry/instrumentation.js');

    await instrumentation.initializeOpenTelemetry();
    const cleanup = Promise.withResolvers<void>();
    otelState.sdkShutdownSpy.mockReturnValueOnce(cleanup.promise);

    const shutdownPromise = instrumentation.shutdownOpenTelemetry(25);
    const rejection = expect(shutdownPromise).rejects.toThrow('OpenTelemetry SDK shutdown timeout');

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(instrumentation.sdk).toBeNull();
    cleanup.resolve();
    await cleanup.promise;
  });
});

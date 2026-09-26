/**
 * @fileoverview OpenTelemetry SDK initialization and lifecycle management.
 * Provides runtime-aware initialization with graceful degradation for Worker/Edge environments.
 * Supports both Node.js (full NodeSDK) and serverless runtimes (lightweight telemetry).
 * @module src/utils/telemetry/instrumentation
 */

import { type DiagLogger, DiagLogLevel, diag } from '@opentelemetry/api';
import type { LoggerProvider } from '@opentelemetry/api-logs';
import type { LogRecordProcessor } from '@opentelemetry/sdk-logs';
import type { NodeSDK } from '@opentelemetry/sdk-node';
import { config } from '@/config/index.js';

import { logger } from '@/utils/internal/logger.js';
import { runtimeCaps } from '@/utils/internal/runtime.js';

/**
 * Metric export cadence, and the per-export timeout. The reader clamps a
 * timeout longer than its interval down to it and logs a notice on every boot
 * saying so, so the timeout is set to the interval outright.
 */
const METRIC_EXPORT_INTERVAL_MS = 15_000;

/**
 * The active OpenTelemetry `NodeSDK` instance, or `null` when telemetry is disabled,
 * the runtime is not Node/Bun, or the SDK has been shut down.
 * Node-specific SDK modules are lazy-loaded inside `initializeOpenTelemetry` to prevent
 * crashes in Worker/Edge environments where those modules are unavailable.
 */
export let sdk: NodeSDK | null = null;

// Initialization state management
let isOtelInitialized = false;
let initializationPromise: Promise<void> | null = null;

/**
 * Determines if the NodeSDK can be used in the current runtime.
 * Returns false in Worker/Edge environments — Cloudflare Workers with
 * `nodejs_compat` populate `process.versions.node`, so we must explicitly
 * check `isWorkerLike` to avoid the SDK loading `node:perf_hooks` and
 * `node:worker_threads` that the polyfill does not provide.
 * Bun is allowed — auto-instrumentations that rely on Node http hooks silently
 * no-op, but manual spans, custom metrics, and OTLP export all work correctly.
 */
function canUseNodeSDK(): boolean {
  return (
    runtimeCaps.isNode &&
    !runtimeCaps.isWorkerLike &&
    typeof process?.versions?.node === 'string' &&
    typeof process.env === 'object'
  );
}

/**
 * Detects cloud platform and provider for resource attributes.
 * Enriches telemetry with deployment environment metadata.
 *
 * @returns Record of cloud-related resource attributes
 */
function detectCloudResource(): Record<string, string> {
  // cloud.* attrs remain in @opentelemetry/semantic-conventions/incubating, so
  // string literals are kept here. Stable attrs (service.*, deployment.*) are
  // applied at the resource construction site using their typed constants.
  const CLOUD_PROVIDER = 'cloud.provider';
  const CLOUD_PLATFORM = 'cloud.platform';
  const CLOUD_REGION = 'cloud.region';

  const attrs: Record<string, string> = {};

  // Cloudflare Workers
  if (runtimeCaps.isWorkerLike) {
    attrs[CLOUD_PROVIDER] = 'cloudflare';
    attrs[CLOUD_PLATFORM] = 'cloudflare_workers';
  }

  // AWS Lambda
  if (typeof process !== 'undefined' && process.env?.AWS_LAMBDA_FUNCTION_NAME) {
    attrs[CLOUD_PROVIDER] = 'aws';
    attrs[CLOUD_PLATFORM] = 'aws_lambda';
    if (process.env.AWS_REGION) {
      attrs[CLOUD_REGION] = process.env.AWS_REGION;
    }
  }

  // GCP Cloud Functions/Cloud Run
  if (typeof process !== 'undefined' && (process.env?.FUNCTION_TARGET || process.env?.K_SERVICE)) {
    attrs[CLOUD_PROVIDER] = 'gcp';
    attrs[CLOUD_PLATFORM] = process.env.FUNCTION_TARGET ? 'gcp_cloud_functions' : 'gcp_cloud_run';
    if (process.env.GCP_REGION) {
      attrs[CLOUD_REGION] = process.env.GCP_REGION;
    }
  }

  return attrs;
}

/**
 * A diag logger that writes every level to stderr. `DiagConsoleLogger` sends
 * `info` and `debug` to stdout, which the stdio transport reserves for JSON-RPC.
 */
function createStderrDiagLogger(format: (...args: unknown[]) => string): DiagLogger {
  const write = (message: string, ...args: unknown[]) => {
    process.stderr.write(`${format(message, ...args)}\n`);
  };
  return { debug: write, error: write, info: write, verbose: write, warn: write };
}

/**
 * Runs `construct` with `OTEL_LOG_LEVEL` absent from `process.env`, restoring
 * it afterwards. `NodeSDK`'s constructor registers a `DiagConsoleLogger` of its
 * own whenever the variable is set: it parses the raw value, so the
 * framework's aliases (`warning`, `err`) read as unknown; it writes info and
 * debug to stdout; and at `DEBUG` it announces its own registration there
 * before anything could replace it. The framework's diag logger already
 * carries the configured level, so the constructor never needs to see it.
 */
function withoutOtelLogLevelEnv<T>(construct: () => T): T {
  const level = process.env.OTEL_LOG_LEVEL;
  delete process.env.OTEL_LOG_LEVEL;
  try {
    return construct();
  } finally {
    if (level !== undefined) process.env.OTEL_LOG_LEVEL = level;
  }
}

/**
 * Initializes the OpenTelemetry SDK with runtime-appropriate configuration.
 * Idempotent — safe to call multiple times; subsequent calls return the existing promise or resolve immediately.
 * No-ops silently when telemetry is disabled (`OTEL_ENABLED=false`) or when running in a
 * Worker/Edge environment where `NodeSDK` is unavailable.
 *
 * In Node/Bun environments, all SDK modules (`@opentelemetry/sdk-node`, exporters,
 * auto-instrumentations) are **lazy-loaded** via `Promise.all(import(...))` to prevent
 * Worker bundle failures.
 *
 * Configures:
 * - OTLP trace exporter + `BatchSpanProcessor` (when a traces endpoint resolves:
 *   `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, else `OTEL_EXPORTER_OTLP_ENDPOINT` + `v1/traces`)
 * - OTLP metrics exporter + `PeriodicExportingMetricReader` at 15 s intervals (when a metrics
 *   endpoint resolves: `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, else the base + `v1/metrics`)
 * - OTLP log exporter + `BatchLogRecordProcessor` only when `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
 *   is set (never derived from the base), with the framework logger attached to the Logs API;
 *   otherwise no log record processors. Every list is passed explicitly, so `NodeSDK`'s
 *   env-driven defaults never export anything the framework config did not ask for
 * - `TraceIdRatioBasedSampler` using `config.openTelemetry.samplingRatio`
 * - Node auto-instrumentations (HTTP enabled, FS disabled)
 * - Pino instrumentation, which reaches only a `pino` loaded after `start()` — the framework
 *   logger's records carry `traceId`/`spanId` from the request context instead
 * - Cloud resource attributes via `detectCloudResource()`
 * - One diag logger: the framework's, writing every level to stderr at
 *   `config.openTelemetry.logLevel` (aliases resolved). `NodeSDK` would register a console
 *   logger of its own when `OTEL_LOG_LEVEL` is set, so its constructor never sees the variable.
 *
 * @returns Promise that resolves when initialization is complete (or was already complete)
 * @throws Error if `NodeSDK.start()` or any lazy import fails; re-thrown after resetting `sdk` to `null`
 *
 * @example
 * ```typescript
 * // In application entry point (src/index.ts)
 * await initializeOpenTelemetry();
 * ```
 */
export async function initializeOpenTelemetry(): Promise<void> {
  // Return existing promise if initialization in progress
  if (initializationPromise) {
    return await initializationPromise;
  }

  // Already initialized
  if (isOtelInitialized) {
    return;
  }

  initializationPromise = (async () => {
    if (!config.openTelemetry.enabled) {
      diag.info('OpenTelemetry disabled via configuration.');
      isOtelInitialized = true;
      return;
    }

    if (!canUseNodeSDK()) {
      diag.info('NodeSDK unavailable in this runtime. Using lightweight telemetry mode.');
      isOtelInitialized = true;
      return;
    }

    try {
      // Lazy-load Node-specific modules
      const [
        { HttpInstrumentation },
        { OTLPMetricExporter },
        { OTLPTraceExporter },
        { PinoInstrumentation },
        { resourceFromAttributes },
        { PeriodicExportingMetricReader },
        { NodeSDK },
        { BatchSpanProcessor, TraceIdRatioBasedSampler },
        { ATTR_DEPLOYMENT_ENVIRONMENT_NAME, ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
        { format },
      ] = await Promise.all([
        import('@opentelemetry/instrumentation-http'),
        import('@opentelemetry/exporter-metrics-otlp-http'),
        import('@opentelemetry/exporter-trace-otlp-http'),
        import('@opentelemetry/instrumentation-pino'),
        import('@opentelemetry/resources'),
        import('@opentelemetry/sdk-metrics'),
        import('@opentelemetry/sdk-node'),
        import('@opentelemetry/sdk-trace-node'),
        import('@opentelemetry/semantic-conventions'),
        import('node:util'),
      ]);

      const otelLogLevelString =
        config.openTelemetry.logLevel.toUpperCase() as keyof typeof DiagLogLevel;
      diag.setLogger(createStderrDiagLogger(format), {
        logLevel: DiagLogLevel[otelLogLevelString] ?? DiagLogLevel.INFO,
        // The framework owns diag once OTel is on; replacing an earlier registration
        // (a re-initialization after shutdown included) is not worth a stack trace.
        suppressOverrideMessage: true,
      });

      const tracesEndpoint = config.openTelemetry.tracesEndpoint;
      const metricsEndpoint = config.openTelemetry.metricsEndpoint;
      const logsEndpoint = config.openTelemetry.logsEndpoint;

      if (!tracesEndpoint && !metricsEndpoint && !logsEndpoint) {
        diag.warn(
          'OTEL_ENABLED is true, but no OTLP endpoint for traces, metrics, or logs is configured. OpenTelemetry will not export any telemetry. Set OTEL_EXPORTER_OTLP_ENDPOINT, or the signal-specific OTEL_EXPORTER_OTLP_TRACES_ENDPOINT / OTEL_EXPORTER_OTLP_METRICS_ENDPOINT / OTEL_EXPORTER_OTLP_LOGS_ENDPOINT.',
        );
      }

      const resource = resourceFromAttributes({
        [ATTR_SERVICE_NAME]: config.openTelemetry.serviceName,
        [ATTR_SERVICE_VERSION]: config.openTelemetry.serviceVersion,
        [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment,
        ...detectCloudResource(),
      });

      const spanProcessors: InstanceType<typeof BatchSpanProcessor>[] = [];
      if (tracesEndpoint) {
        diag.info(`Using OTLP exporter for traces, endpoint: ${tracesEndpoint}`);
        const traceExporter = new OTLPTraceExporter({ url: tracesEndpoint });
        spanProcessors.push(new BatchSpanProcessor(traceExporter));
      } else {
        diag.info('No OTLP traces endpoint configured. Traces will not be exported.');
      }

      const metricReaders: InstanceType<typeof PeriodicExportingMetricReader>[] = [];
      if (metricsEndpoint) {
        diag.info(`Using OTLP exporter for metrics, endpoint: ${metricsEndpoint}`);
        metricReaders.push(
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ url: metricsEndpoint }),
            exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
            exportTimeoutMillis: METRIC_EXPORT_INTERVAL_MS,
          }),
        );
      } else {
        diag.info('No OTLP metrics endpoint configured. Metrics will not be exported.');
      }

      /**
       * The log packages are optional peers loaded only when log export is
       * asked for, so a deployment without them never reaches these imports.
       */
      const logRecordProcessors: LogRecordProcessor[] = [];
      let loggerProvider: LoggerProvider | undefined;
      if (logsEndpoint) {
        const [{ BatchLogRecordProcessor }, { OTLPLogExporter }, { logs }] = await Promise.all([
          import('@opentelemetry/sdk-logs'),
          import('@opentelemetry/exporter-logs-otlp-http'),
          import('@opentelemetry/api-logs'),
        ]);
        diag.info(`Using OTLP exporter for logs, endpoint: ${logsEndpoint}`);
        logRecordProcessors.push(
          new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: logsEndpoint }) }),
        );
        loggerProvider = logs;
      }

      /**
       * All three lists are passed explicitly, empty or not: an omitted one
       * makes `NodeSDK` build its own OTLP exporter from `OTEL_*` env vars
       * (defaulting to localhost:4318), exporting outside the framework config.
       */
      sdk = withoutOtelLogLevelEnv(
        () =>
          new NodeSDK({
            resource,
            spanProcessors,
            metricReaders,
            logRecordProcessors,
            sampler: new TraceIdRatioBasedSampler(config.openTelemetry.samplingRatio),
            instrumentations: [
              new HttpInstrumentation({
                ignoreIncomingRequestHook: (req) => req.url === '/healthz',
              }),
              new PinoInstrumentation({
                logHook: (_span, record) => {
                  record.trace_id = _span.spanContext().traceId;
                  record.span_id = _span.spanContext().spanId;
                },
              }),
            ],
          }),
      );

      sdk.start();
      // `PinoInstrumentation` never sees the framework's `pino` (imported at module
      // load, before `start()`), so the logger forwards its records to the Logs API itself.
      if (loggerProvider) {
        logger.setOtelLogSink(
          loggerProvider.getLogger(
            config.openTelemetry.serviceName,
            config.openTelemetry.serviceVersion,
          ),
        );
      }
      isOtelInitialized = true;
      diag.info(
        `OpenTelemetry NodeSDK initialized for ${config.openTelemetry.serviceName} v${config.openTelemetry.serviceVersion}`,
      );
    } catch (error) {
      diag.error('Error initializing OpenTelemetry', error);
      sdk = null;
      isOtelInitialized = false;
      initializationPromise = null;
      throw error;
    }
  })();

  return initializationPromise;
}

/**
 * Gracefully shuts down the OpenTelemetry SDK with timeout protection.
 * This function is called during the application's shutdown sequence.
 * Prevents hung processes by racing shutdown against a timeout.
 *
 * @param timeoutMs - Maximum time to wait for shutdown in milliseconds (default: 5000)
 * @throws Error if shutdown times out or fails critically
 *
 * @example
 * ```typescript
 * // During application shutdown
 * try {
 *   await shutdownOpenTelemetry();
 * } catch (error) {
 *   console.error('Failed to shutdown telemetry:', error);
 * }
 * ```
 */
export async function shutdownOpenTelemetry(timeoutMs = 5000): Promise<void> {
  if (!sdk) {
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  logger.setOtelLogSink(undefined);
  try {
    const shutdownPromise = sdk.shutdown();
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('OpenTelemetry SDK shutdown timeout')), timeoutMs);
      shutdownPromise.then(resolve, reject);
    });
    diag.info('OpenTelemetry SDK terminated successfully.');
  } catch (error) {
    diag.error('Error terminating OpenTelemetry SDK', error);
    throw error; // Propagate for caller handling
  } finally {
    clearTimeout(timer);
    sdk = null;
    isOtelInitialized = false;
    initializationPromise = null;
  }
}

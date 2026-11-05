/**
 * @fileoverview OpenTelemetry metrics utilities for custom instrumentation.
 * Counters, up-down counters, and histograms bind to the global
 * `MeterProvider` on each record, so one created before the SDK starts (module
 * scope, `setup()`) still exports; observable gauges and raw meters bind when
 * called. Supports both Node and Worker environments.
 * @module src/utils/telemetry/metrics
 */
import {
  type Counter,
  type Histogram,
  type Meter,
  type MeterProvider,
  metrics,
  type ObservableGauge,
  type UpDownCounter,
} from '@opentelemetry/api';

import { config } from '@/config/index.js';

/**
 * Gets or creates a meter for custom metrics.
 * Uses application service name and version from config by default.
 *
 * Binds when called. `@opentelemetry/api` has no proxy meter: a meter taken
 * before the SDK registers its `MeterProvider` — at module scope or in
 * `setup()`, both of which run before `createApp()` starts telemetry — is the
 * API's no-op for the life of the process. Call it once the SDK is running, or
 * use {@link createCounter} / {@link createUpDownCounter} / {@link createHistogram},
 * which bind on each record instead.
 *
 * @param name - Optional custom meter name (defaults to service name)
 * @returns Meter instance for creating metrics
 *
 * @example
 * ```typescript
 * const meter = getMeter('database-metrics');
 * const queryCounter = meter.createCounter('db.queries');
 * ```
 */
export function getMeter(name?: string): Meter {
  return metrics.getMeter(
    name ?? config.openTelemetry.serviceName,
    config.openTelemetry.serviceVersion,
  );
}

/**
 * Returns a resolver for one instrument on the global `MeterProvider`: each
 * call reads the current provider and creates the instrument from it the first
 * time, then again only when the provider has changed since — an SDK started
 * after the instrument was created, or one restarted after a shutdown. While
 * no provider is registered it resolves the API's no-op instrument, replaced
 * on the first call after one registers. Per call: one global read and one
 * identity comparison, no allocation.
 */
function bindToGlobalProvider<T>(create: (meter: Meter) => T): () => T {
  let boundProvider: MeterProvider | undefined;
  let instrument: T;
  return () => {
    const provider = metrics.getMeterProvider();
    if (provider !== boundProvider) {
      instrument = create(getMeter());
      boundProvider = provider;
    }
    return instrument;
  };
}

/**
 * Creates a counter metric (monotonically increasing).
 * Counters are suitable for measuring event counts, request totals, errors, etc.
 *
 * Creating one has no side effects — it reads no config and looks up no meter.
 * The instrument is resolved from the global `MeterProvider` when a value is
 * recorded, so a counter created at module scope or in `setup()`, before the
 * SDK starts, exports what it records once the SDK is running.
 *
 * @param name - Metric name (should use dot notation, e.g., 'http.requests')
 * @param description - Human-readable description of what the metric measures
 * @param unit - Optional unit of measurement (e.g., '1', 'requests', 'bytes')
 * @returns Counter instance for recording values
 *
 * @example
 * ```typescript
 * const requestCounter = createCounter(
 *   'api.requests',
 *   'Total number of API requests',
 *   '1'
 * );
 *
 * // Later in code
 * requestCounter.add(1, {
 *   'http.method': 'GET',
 *   'http.route': '/api/users'
 * });
 * ```
 */
export function createCounter(name: string, description: string, unit = '1'): Counter {
  const counter = bindToGlobalProvider((meter) => meter.createCounter(name, { description, unit }));
  // The caller's own arguments, so the instrument sees exactly what was recorded.
  return { add: (...args) => counter().add(...args) };
}

/**
 * Creates an up-down counter metric (can increase or decrease).
 * Suitable for tracking values that fluctuate, like active connections or queue depth.
 *
 * Binds on each record, like {@link createCounter}: safe to create before the SDK starts.
 *
 * @param name - Metric name (should use dot notation, e.g., 'connections.active')
 * @param description - Human-readable description of what the metric measures
 * @param unit - Optional unit of measurement (default: '1')
 * @returns UpDownCounter instance for recording positive and negative deltas
 *
 * @example
 * ```typescript
 * const activeConnections = createUpDownCounter(
 *   'connections.active',
 *   'Number of active connections',
 *   '{connections}'
 * );
 *
 * activeConnections.add(1);  // New connection
 * activeConnections.add(-1); // Connection closed
 * ```
 */
export function createUpDownCounter(name: string, description: string, unit = '1'): UpDownCounter {
  const counter = bindToGlobalProvider((meter) =>
    meter.createUpDownCounter(name, { description, unit }),
  );
  return { add: (...args) => counter().add(...args) };
}

/**
 * Creates a histogram metric for recording distributions.
 * Histograms are ideal for latency, response times, payload sizes, etc.
 *
 * Binds on each record, like {@link createCounter}: safe to create before the SDK starts.
 *
 * @param name - Metric name (should use dot notation)
 * @param description - Human-readable description
 * @param unit - Optional unit (e.g., 'ms', 'bytes', 's')
 * @returns Histogram instance
 *
 * @example
 * ```typescript
 * const requestDuration = createHistogram(
 *   'http.request.duration',
 *   'HTTP request duration',
 *   'ms'
 * );
 *
 * const startTime = Date.now();
 * // ... handle request ...
 * requestDuration.record(Date.now() - startTime, {
 *   'http.method': 'POST',
 *   'http.status_code': 200
 * });
 * ```
 */
export function createHistogram(name: string, description: string, unit?: string): Histogram {
  const options = unit ? { description, unit } : { description };
  const histogram = bindToGlobalProvider((meter) => meter.createHistogram(name, options));
  return { record: (...args) => histogram().record(...args) };
}

/**
 * Creates an observable gauge for async/callback-based measurements.
 * Gauges are polled periodically by the metrics SDK and report current values.
 *
 * Binds when called, like {@link getMeter}: the callback registers with the
 * meter at creation and there is no record call to rebind on, so a gauge
 * created before the SDK starts is a no-op for the life of the process. Create
 * it after `createApp()` has started telemetry.
 *
 * @param name - Metric name (should use dot notation)
 * @param description - Human-readable description
 * @param callback - Async function returning the current metric value
 * @param unit - Optional unit of measurement
 * @returns ObservableGauge instance
 */
export function createObservableGauge(
  name: string,
  description: string,
  callback: () => Promise<number> | number,
  unit?: string,
): ObservableGauge {
  const meter = getMeter();
  const options = unit ? { description, unit } : { description };
  const gauge = meter.createObservableGauge(name, options);
  gauge.addCallback(async (result) => {
    result.observe(await callback());
  });
  return gauge;
}

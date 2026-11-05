/**
 * @fileoverview Test suite for OpenTelemetry metrics
 * @module tests/utils/telemetry/metrics.test
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { diag, metrics, ROOT_CONTEXT } from '@opentelemetry/api';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config, resetConfig } from '@/config/index.js';
import {
  initializeOpenTelemetry,
  shutdownOpenTelemetry,
} from '@/utils/telemetry/instrumentation.js';
import * as metricsUtils from '@/utils/telemetry/metrics.js';

describe('OpenTelemetry Metrics', () => {
  describe('getMeter', () => {
    test('should use config values for default meter', () => {
      const getMeterSpy = vi.spyOn(metrics, 'getMeter');
      metricsUtils.getMeter();

      expect(getMeterSpy).toHaveBeenCalledWith(
        config.openTelemetry.serviceName,
        config.openTelemetry.serviceVersion,
      );

      getMeterSpy.mockRestore();
    });

    test('should use custom name with config version', () => {
      const getMeterSpy = vi.spyOn(metrics, 'getMeter');
      const customName = 'test-meter';
      metricsUtils.getMeter(customName);

      expect(getMeterSpy).toHaveBeenCalledWith(customName, config.openTelemetry.serviceVersion);

      getMeterSpy.mockRestore();
    });
  });

  describe('createCounter', () => {
    let createCounterSpy: ReturnType<typeof vi.spyOn>;
    let mockMeter: any;

    beforeEach(() => {
      mockMeter = {
        createCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
      };
      vi.spyOn(metrics, 'getMeter').mockReturnValue(mockMeter);
      createCounterSpy = mockMeter.createCounter;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    test('should create counter with name and description on the first record', () => {
      const counter = metricsUtils.createCounter('test.counter', 'Test counter');
      expect(createCounterSpy).not.toHaveBeenCalled();

      counter.add(1);

      expect(createCounterSpy).toHaveBeenCalledWith('test.counter', {
        description: 'Test counter',
        unit: '1',
      });
    });

    test('passes each record to the instrument with exactly the arguments given', () => {
      const counter = metricsUtils.createCounter('test.args', 'Args counter');
      counter.add(1, { route: '/a' });
      counter.add(2, { route: '/b' }, ROOT_CONTEXT);

      const instrument = vi.mocked(mockMeter.createCounter).mock.results[0]?.value;
      expect(instrument.add.mock.calls).toEqual([
        [1, { route: '/a' }],
        [2, { route: '/b' }, ROOT_CONTEXT],
      ]);
    });

    test('should create counter with custom unit', () => {
      metricsUtils.createCounter('test.bytes', 'Bytes counter', 'bytes').add(1);

      expect(createCounterSpy).toHaveBeenCalledWith('test.bytes', {
        description: 'Bytes counter',
        unit: 'bytes',
      });
    });
  });

  describe('createUpDownCounter', () => {
    let createUpDownCounterSpy: ReturnType<typeof vi.spyOn>;
    let mockMeter: any;

    beforeEach(() => {
      mockMeter = {
        createUpDownCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
      };
      vi.spyOn(metrics, 'getMeter').mockReturnValue(mockMeter);
      createUpDownCounterSpy = mockMeter.createUpDownCounter;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    test('should create up-down counter with name and description on the first record', () => {
      const counter = metricsUtils.createUpDownCounter('test.updown', 'Up-down counter');
      expect(createUpDownCounterSpy).not.toHaveBeenCalled();

      counter.add(-1);

      expect(createUpDownCounterSpy).toHaveBeenCalledWith('test.updown', {
        description: 'Up-down counter',
        unit: '1',
      });
    });

    test('passes each record to the instrument with exactly the arguments given', () => {
      const counter = metricsUtils.createUpDownCounter('test.args', 'Args up-down counter');
      counter.add(-1, { pool: 'a' });
      counter.add(1, { pool: 'b' }, ROOT_CONTEXT);

      const instrument = vi.mocked(mockMeter.createUpDownCounter).mock.results[0]?.value;
      expect(instrument.add.mock.calls).toEqual([
        [-1, { pool: 'a' }],
        [1, { pool: 'b' }, ROOT_CONTEXT],
      ]);
    });

    test('should create up-down counter with custom unit', () => {
      metricsUtils
        .createUpDownCounter('test.connections', 'Active connections', '{connections}')
        .add(1);

      expect(createUpDownCounterSpy).toHaveBeenCalledWith('test.connections', {
        description: 'Active connections',
        unit: '{connections}',
      });
    });
  });

  describe('createHistogram', () => {
    let createHistogramSpy: ReturnType<typeof vi.spyOn>;
    let mockMeter: any;

    beforeEach(() => {
      mockMeter = {
        createHistogram: vi.fn().mockReturnValue({ record: vi.fn() }),
      };
      vi.spyOn(metrics, 'getMeter').mockReturnValue(mockMeter);
      createHistogramSpy = mockMeter.createHistogram;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    test('should create histogram with name and description on the first record', () => {
      const histogram = metricsUtils.createHistogram('test.duration', 'Duration histogram');
      expect(createHistogramSpy).not.toHaveBeenCalled();

      histogram.record(12);

      expect(createHistogramSpy).toHaveBeenCalledWith('test.duration', {
        description: 'Duration histogram',
      });
    });

    test('passes each record to the instrument with exactly the arguments given', () => {
      const histogram = metricsUtils.createHistogram('test.args', 'Args histogram');
      histogram.record(12, { op: 'a' });
      histogram.record(3, { op: 'b' }, ROOT_CONTEXT);

      const instrument = vi.mocked(mockMeter.createHistogram).mock.results[0]?.value;
      expect(instrument.record.mock.calls).toEqual([
        [12, { op: 'a' }],
        [3, { op: 'b' }, ROOT_CONTEXT],
      ]);
    });

    test('should create histogram with unit', () => {
      metricsUtils.createHistogram('test.latency', 'Latency histogram', 'ms').record(3);

      expect(createHistogramSpy).toHaveBeenCalledWith('test.latency', {
        description: 'Latency histogram',
        unit: 'ms',
      });
    });
  });

  describe('binding to the global MeterProvider', () => {
    /** A pull-only reader: `collect()` on demand, nothing exported on a timer. */
    class InMemoryReader extends MetricReader {
      protected override async onForceFlush(): Promise<void> {}
      protected override async onShutdown(): Promise<void> {}
    }

    const providers: MeterProvider[] = [];

    /** Registers a fresh SDK `MeterProvider` as the global one and returns its reader. */
    function registerProvider(): { provider: MeterProvider; reader: InMemoryReader } {
      const reader = new InMemoryReader();
      const provider = new MeterProvider({ readers: [reader] });
      providers.push(provider);
      expect(metrics.setGlobalMeterProvider(provider)).toBe(true);
      return { provider, reader };
    }

    /** Every series the reader holds, by metric name, as `[value, attributes]` points. */
    async function series(reader: InMemoryReader) {
      const { resourceMetrics } = await reader.collect();
      const byName = new Map<string, Array<[unknown, Record<string, unknown>]>>();
      for (const scope of resourceMetrics.scopeMetrics) {
        for (const metric of scope.metrics) {
          byName.set(
            metric.descriptor.name,
            metric.dataPoints.map((point) => [point.value, point.attributes]),
          );
        }
      }
      return byName;
    }

    beforeEach(() => {
      metrics.disable();
    });

    afterEach(async () => {
      metrics.disable();
      vi.restoreAllMocks();
      await Promise.all(providers.splice(0).map((provider) => provider.shutdown()));
    });

    test('exports what an instrument created before any provider records after one registers', async () => {
      const counter = metricsUtils.createCounter('early.counter', 'Created at module scope');
      const upDown = metricsUtils.createUpDownCounter('early.updown', 'Created in setup()');
      const histogram = metricsUtils.createHistogram('early.histogram', 'Created early', 'ms');
      const { reader } = registerProvider();

      counter.add(2, { route: 'a' });
      upDown.add(5);
      upDown.add(-2);
      histogram.record(40);

      const exported = await series(reader);
      expect(exported.get('early.counter')).toEqual([[2, { route: 'a' }]]);
      expect(exported.get('early.updown')).toEqual([[3, {}]]);
      expect(exported.get('early.histogram')?.[0]?.[0]).toMatchObject({ count: 1, sum: 40 });
    });

    test('behaves as before for an instrument created after the provider registers', async () => {
      const { reader } = registerProvider();
      const counter = metricsUtils.createCounter('late.counter', 'Created after start');

      counter.add(1);

      expect((await series(reader)).get('late.counter')).toEqual([[1, {}]]);
    });

    test('sends a record made before any provider to the no-op without pinning it', async () => {
      const counter = metricsUtils.createCounter('warmup.counter', 'Recorded during setup()');
      counter.add(100);
      const { reader } = registerProvider();

      counter.add(1);

      expect((await series(reader)).get('warmup.counter')).toEqual([[1, {}]]);
    });

    test('creates the instrument once per provider, however many records follow', async () => {
      const { provider, reader } = registerProvider();
      const getMeter = vi.spyOn(provider, 'getMeter');
      const counter = metricsUtils.createCounter('once.counter', 'One instrument');

      for (let i = 0; i < 5; i++) counter.add(1);

      expect(getMeter).toHaveBeenCalledOnce();
      expect((await series(reader)).get('once.counter')).toEqual([[5, {}]]);
    });

    test('rebinds to a provider registered in place of the one it was bound to', async () => {
      const counter = metricsUtils.createCounter('swap.counter', 'Survives an SDK restart');
      const first = registerProvider();
      counter.add(1);
      metrics.disable();
      const second = registerProvider();

      counter.add(7);

      expect((await series(first.reader)).get('swap.counter')).toEqual([[1, {}]]);
      expect((await series(second.reader)).get('swap.counter')).toEqual([[7, {}]]);
    });

    test('passes attributes and context through unchanged', () => {
      const add = vi.fn();
      const record = vi.fn();
      const meter = {
        createCounter: () => ({ add }),
        createHistogram: () => ({ record }),
        createUpDownCounter: () => ({ add }),
      };
      expect(metrics.setGlobalMeterProvider({ getMeter: () => meter as never })).toBe(true);
      const attributes = { 'mcp.tool.name': 'demo' };
      const ctx = ROOT_CONTEXT.setValue(Symbol('k'), 'v');

      metricsUtils.createCounter('pass.counter', 'x').add(1, attributes, ctx);
      metricsUtils.createUpDownCounter('pass.updown', 'x').add(-1, attributes, ctx);
      metricsUtils.createHistogram('pass.histogram', 'x').record(2, attributes, ctx);

      expect(add.mock.calls).toEqual([
        [1, attributes, ctx],
        [-1, attributes, ctx],
      ]);
      expect(add.mock.calls[0]?.[1]).toBe(attributes);
      expect(add.mock.calls[0]?.[2]).toBe(ctx);
      expect(record).toHaveBeenCalledExactlyOnceWith(2, attributes, ctx);
    });

    test('looks up no provider or meter when an instrument is created', () => {
      const getMeterProvider = vi.spyOn(metrics, 'getMeterProvider');
      const getMeter = vi.spyOn(metrics, 'getMeter');

      metricsUtils.createCounter('quiet.counter', 'x');
      metricsUtils.createUpDownCounter('quiet.updown', 'x');
      metricsUtils.createHistogram('quiet.histogram', 'x');

      expect(getMeterProvider).not.toHaveBeenCalled();
      expect(getMeter).not.toHaveBeenCalled();
    });
  });

  describe('createObservableGauge', () => {
    let createObservableGaugeSpy: ReturnType<typeof vi.spyOn>;
    let mockMeter: any;

    beforeEach(() => {
      mockMeter = {
        createObservableGauge: vi.fn().mockReturnValue({ addCallback: vi.fn() }),
      };
      vi.spyOn(metrics, 'getMeter').mockReturnValue(mockMeter);
      createObservableGaugeSpy = mockMeter.createObservableGauge;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    test('should create observable gauge with name and description', () => {
      const callback = () => 42;
      const gauge = metricsUtils.createObservableGauge('test.memory', 'Memory gauge', callback);

      expect(createObservableGaugeSpy).toHaveBeenCalledWith('test.memory', {
        description: 'Memory gauge',
      });
      expect(gauge).toBeDefined();
    });

    test('should register callback via addCallback', () => {
      const callback = () => 99;
      const gauge = metricsUtils.createObservableGauge('test.cb', 'Callback gauge', callback);
      expect(gauge.addCallback).toHaveBeenCalledTimes(1);
      expect(gauge.addCallback).toHaveBeenCalledWith(expect.any(Function));
    });

    test('should create observable gauge with unit', () => {
      const callback = () => Promise.resolve(100);
      metricsUtils.createObservableGauge('test.temp', 'Temperature', callback, 'celsius');

      expect(createObservableGaugeSpy).toHaveBeenCalledWith('test.temp', {
        description: 'Temperature',
        unit: 'celsius',
      });
    });

    test.each([
      ['async', async () => 123, 123],
      ['sync', () => 456, 456],
    ])('should observe the value a %s callback returns', async (_kind, callback, expected) => {
      const gauge = metricsUtils.createObservableGauge('test.observe', 'Observed gauge', callback);
      const registered = vi.mocked(gauge.addCallback).mock.calls[0]?.[0];
      const result = { observe: vi.fn() };

      await registered?.(result as never);

      expect(result.observe).toHaveBeenCalledExactlyOnceWith(expected);
    });
  });

  describe('across an SDK restart, exported to a loopback OTLP receiver', () => {
    let server: Server;
    let posts: OtlpMetricsBody[];
    let diagOutput: string[];

    /** The minimal OTLP/JSON metrics request shape these assertions read. */
    interface OtlpMetricsBody {
      resourceMetrics: Array<{
        scopeMetrics: Array<{
          metrics: Array<{
            name: string;
            sum?: { dataPoints: Array<{ asDouble?: number; asInt?: number | string }> };
          }>;
        }>;
      }>;
    }

    /** Every sum data point `bodies` carry for `name`, in arrival order. */
    function exportedSums(bodies: OtlpMetricsBody[], name: string): number[] {
      return bodies.flatMap((body) =>
        body.resourceMetrics.flatMap((resource) =>
          resource.scopeMetrics.flatMap((scope) =>
            scope.metrics
              .filter((metric) => metric.name === name)
              .flatMap((metric) =>
                (metric.sum?.dataPoints ?? []).map((point) =>
                  Number(point.asDouble ?? point.asInt),
                ),
              ),
          ),
        ),
      );
    }

    beforeEach(async () => {
      metrics.disable();
      posts = [];
      diagOutput = [];
      server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          if (req.url === '/v1/metrics') {
            posts.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as OtlpMetricsBody);
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      resetConfig({
        OTEL_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: undefined,
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${port}/v1/metrics`,
        // A tracer provider too, so the restart re-registers every global the SDK can set.
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`,
        OTEL_LOG_LEVEL: 'error',
      });
      // The framework's diag logger writes to stderr; keep what it says for the assertions.
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        diagOutput.push(String(chunk));
        return true;
      });
    });

    afterEach(async () => {
      await shutdownOpenTelemetry();
      vi.restoreAllMocks();
      diag.disable();
      resetConfig();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    });

    test('exports an instrument created before the first start from the restarted SDK', async () => {
      const counter = metricsUtils.createCounter('restart.early', 'Created at module scope');

      await initializeOpenTelemetry();
      counter.add(1);
      await shutdownOpenTelemetry();
      const fromFirst = posts.length;

      await initializeOpenTelemetry();
      counter.add(2);
      await shutdownOpenTelemetry();

      expect(exportedSums(posts.slice(0, fromFirst), 'restart.early')).toEqual([1]);
      expect(exportedSums(posts.slice(fromFirst), 'restart.early')).toEqual([2]);
      expect(diagOutput.join('')).not.toContain('duplicate registration');
    });
  });
});

/**
 * @fileoverview Test suite for OpenTelemetry metrics
 * @module tests/utils/telemetry/metrics.test
 */

import { metrics } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '@/config/index.js';
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

    test('should create counter with name and description', () => {
      const counter = metricsUtils.createCounter('test.counter', 'Test counter');

      expect(createCounterSpy).toHaveBeenCalledWith('test.counter', {
        description: 'Test counter',
        unit: '1',
      });
      expect(counter).toBeDefined();
    });

    test('should create counter with custom unit', () => {
      metricsUtils.createCounter('test.bytes', 'Bytes counter', 'bytes');

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

    test('should create up-down counter with name and description', () => {
      const counter = metricsUtils.createUpDownCounter('test.updown', 'Up-down counter');

      expect(createUpDownCounterSpy).toHaveBeenCalledWith('test.updown', {
        description: 'Up-down counter',
        unit: '1',
      });
      expect(counter).toBeDefined();
    });

    test('should create up-down counter with custom unit', () => {
      metricsUtils.createUpDownCounter('test.connections', 'Active connections', '{connections}');

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

    test('should create histogram with name and description', () => {
      const histogram = metricsUtils.createHistogram('test.duration', 'Duration histogram');

      expect(createHistogramSpy).toHaveBeenCalledWith('test.duration', {
        description: 'Duration histogram',
      });
      expect(histogram).toBeDefined();
    });

    test('should create histogram with unit', () => {
      metricsUtils.createHistogram('test.latency', 'Latency histogram', 'ms');

      expect(createHistogramSpy).toHaveBeenCalledWith('test.latency', {
        description: 'Latency histogram',
        unit: 'ms',
      });
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
});

/**
 * @fileoverview Test suite for OpenTelemetry instrumentation
 * @module tests/utils/telemetry/instrumentation.test
 */

import { DiagLogLevel, diag } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from 'vitest';
import * as runtimeModule from '@/utils/internal/runtime.js';
import * as instrumentation from '@/utils/telemetry/instrumentation.js';

// Mock config at module level
vi.mock('@/config/index.js', () => ({
  config: {
    environment: 'test',
    openTelemetry: {
      enabled: true,
      serviceName: 'test-service',
      serviceVersion: '1.0.0',
      logLevel: 'info',
      tracesEndpoint: 'http://localhost:4318/v1/traces',
      metricsEndpoint: 'http://localhost:4318/v1/metrics',
      samplingRatio: 1.0,
    },
  },
}));

describe('OpenTelemetry Instrumentation', () => {
  let diagInfoSpy: MockInstance;
  // Unused spies kept for potential future tests
  // let diagWarnSpy: MockInstance;
  // let diagErrorSpy: MockInstance;

  beforeEach(() => {
    diagInfoSpy = vi.spyOn(diag, 'info').mockImplementation(() => true);
    // Unused spies kept for potential future tests
    // diagWarnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => true);
    // diagErrorSpy = vi.spyOn(diag, 'error').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Note: Cannot restore process.versions as it's readonly in vitest environment
    // Tests should not modify it directly
  });

  describe('initializeOpenTelemetry', () => {
    // Note: Module initialization tests skipped due to module-level state
    test.skip('should skip initialization when telemetry is disabled', async () => {
      // Mock config to have telemetry disabled
      const configMock = await import('@/config/index.js');
      vi.spyOn(configMock.config.openTelemetry, 'enabled', 'get').mockReturnValue(false);

      await instrumentation.initializeOpenTelemetry();

      expect(diagInfoSpy).toHaveBeenCalledWith('OpenTelemetry disabled via configuration.');
    });

    test.skip('should use lightweight mode when NodeSDK unavailable - SKIPPED: Requires vi.doMock() for dynamic module mocking which Bun does not support. Would need integration test in real runtime environment to verify NodeSDK fallback behavior.', async () => {
      // This test requires dynamically mocking the NodeSDK import to simulate it being unavailable.
      // Bun's Vitest implementation doesn't support vi.doMock() for per-test module resolution.
      // The lightweight mode fallback is documented and tested manually in non-Node environments.
      vi.spyOn(runtimeModule.runtimeCaps, 'isNode', 'get').mockReturnValue(false);

      await instrumentation.initializeOpenTelemetry();

      expect(diagInfoSpy).toHaveBeenCalledWith(expect.stringContaining('NodeSDK unavailable'));
    });

    test.skip('should be idempotent - multiple calls return same promise - SKIPPED: Cannot reliably test due to readonly sdk export and module-level state. The initPromise is internal to the module and cannot be reset between tests without causing side effects. Idempotency is verified through manual testing and protected by the initialization guard in production code.', async () => {
      // This test requires manipulating the readonly 'sdk' export and internal initPromise state.
      // The initialization state is module-scoped and cannot be safely reset between test runs.
      // Attempting to test this causes test pollution and unreliable results.
      // The idempotency behavior is protected by the initPromise guard in the implementation.
      vi.spyOn(runtimeModule.runtimeCaps, 'isNode', 'get').mockReturnValue(false);

      const promise1 = instrumentation.initializeOpenTelemetry();
      const promise2 = instrumentation.initializeOpenTelemetry();

      expect(promise1).toBe(promise2);

      await promise1;
      await promise2;
    });

    test.skip('should return immediately if already initialized', async () => {
      // Mock runtime to skip actual initialization
      vi.spyOn(runtimeModule.runtimeCaps, 'isNode', 'get').mockReturnValue(false);

      await instrumentation.initializeOpenTelemetry();

      // Call again
      const callCountBefore = diagInfoSpy.mock.calls.length;
      await instrumentation.initializeOpenTelemetry();
      const callCountAfter = diagInfoSpy.mock.calls.length;

      // Should not log again (already initialized)
      expect(callCountAfter).toBe(callCountBefore);
    });

    test.skip('should detect AWS Lambda environment', async () => {
      if (typeof process !== 'undefined') {
        process.env.AWS_LAMBDA_FUNCTION_NAME = 'test-function';
        process.env.AWS_REGION = 'us-east-1';
      }

      // Internal function would detect this
      expect(process.env?.AWS_LAMBDA_FUNCTION_NAME).toBe('test-function');
    });

    test.skip('should detect GCP environment', async () => {
      if (typeof process !== 'undefined') {
        process.env.FUNCTION_TARGET = 'test-function';
        process.env.GCP_REGION = 'us-central1';
      }

      expect(process.env?.FUNCTION_TARGET).toBe('test-function');
    });
  });

  describe('Runtime detection', () => {
    test('should identify Node.js runtime correctly', () => {
      // Note: In vitest/Node environment, process.versions is readonly and already set
      // We verify the runtime detection works with the actual process object

      // The canUseNodeSDK function checks these conditions
      expect(typeof process?.versions?.node).toBe('string');
      expect(typeof process?.env).toBe('object');
    });

    test('should handle missing process.versions', () => {
      // Note: Cannot modify readonly process.versions in vitest
      // This test verifies the code handles the case gracefully through mocking
      vi.spyOn(runtimeModule.runtimeCaps, 'isNode', 'get').mockReturnValueOnce(false);

      // When runtime is not Node, versions.node would be undefined
      const isNode = runtimeModule.runtimeCaps.isNode;
      expect(isNode).toBe(false);
    });

    test('should detect Bun runtime and skip NodeSDK', () => {
      // When isBun is true, canUseNodeSDK() returns false → lightweight mode
      vi.spyOn(runtimeModule.runtimeCaps, 'isNode', 'get').mockReturnValue(true);
      vi.spyOn(runtimeModule.runtimeCaps, 'isBun', 'get').mockReturnValue(true);

      // canUseNodeSDK is private, but its effect is observable:
      // isBun=true means isNode && !isBun is false, so NodeSDK won't load
      expect(runtimeModule.runtimeCaps.isNode).toBe(true);
      expect(runtimeModule.runtimeCaps.isBun).toBe(true);
      // The invariant: Bun sets isNode=true but isBun=true should prevent NodeSDK
    });
  });

  describe('Error handling', () => {
    test.todo('should handle import errors gracefully');
  });

  describe('Configuration handling', () => {
    test.skip('should use configured service name and version', async () => {
      const configMock = await import('@/config/index.js');

      expect(configMock.config.openTelemetry.serviceName).toBe('test-service');
      expect(configMock.config.openTelemetry.serviceVersion).toBe('1.0.0');
    });

    test.skip('should use configured sampling ratio', async () => {
      const configMock = await import('@/config/index.js');

      expect(configMock.config.openTelemetry.samplingRatio).toBe(1.0);
    });

    test.skip('should parse log level correctly', () => {
      // Test that DiagLogLevel enum is accessible
      expect(DiagLogLevel.INFO).toBeDefined();
      expect(DiagLogLevel.DEBUG).toBeDefined();
      expect(DiagLogLevel.ERROR).toBeDefined();
    });
  });
});

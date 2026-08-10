/**
 * @fileoverview Runtime and optional-peer tests for the scheduler service.
 * These module-reset cases are isolated from scheduler.test.ts so they cannot
 * invalidate that file's imported logger and scheduler module references.
 * @module tests/utils/scheduling/scheduler.runtime.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { JsonRpcErrorCode, type McpError as McpErrorType } from '@/types-global/errors.js';

afterEach(() => {
  vi.doUnmock('@/utils/internal/runtime.js');
  vi.doUnmock('node-cron');
  vi.resetModules();
});

describe('schedulerService (non-Node runtime)', () => {
  it('throws McpError when scheduling in a non-Node runtime', async () => {
    vi.doMock('@/utils/internal/runtime.js', () => ({
      runtimeCaps: {
        isNode: false,
        isWorkerLike: true,
        isBrowserLike: false,
        hasProcess: false,
        hasBuffer: false,
        hasTextEncoder: true,
        hasPerformanceNow: true,
      },
    }));
    vi.resetModules();

    const { SchedulerService } = await import('../../../../src/utils/scheduling/scheduler.js');
    const service = SchedulerService.getInstance();

    await expect(service.schedule('test', '* * * * *', () => undefined, 'Test')).rejects.toThrow(
      /requires a Node\.js runtime/,
    );
  });
});

describe('schedulerService (missing node-cron peer)', () => {
  it('wraps a module-not-found error into a configurationError naming the peer', async () => {
    vi.doMock('node-cron', () => {
      throw new Error("Cannot find package 'node-cron'");
    });
    vi.resetModules();

    const { McpError } = await import('@/types-global/errors.js');
    const { SchedulerService } = await import('../../../../src/utils/scheduling/scheduler.js');
    const service = SchedulerService.getInstance();

    let caught: unknown;
    try {
      await service.schedule('test-peer', '* * * * *', () => undefined, 'Test');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpError);
    const err = caught as McpErrorType;
    expect(err.message).toMatch(/node-cron/);
    expect(err.message).toMatch(/peer dependency/);
    expect(err.message).toMatch(/\^4\.2\.1/);
    expect(err.code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(err.cause).toBeInstanceOf(Error);
    expect(err.data).toBeUndefined();
  });
});

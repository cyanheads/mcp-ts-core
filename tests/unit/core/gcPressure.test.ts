/**
 * @fileoverview Tests for the opt-in forced-GC pressure loop (issue #50).
 * @module tests/unit/core/gcPressure.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRuntimeCaps, mockLogger, mockRequestContextService } = vi.hoisted(() => ({
  mockRuntimeCaps: { isBun: true },
  mockLogger: {
    info: vi.fn(),
    debug: vi.fn(),
  },
  mockRequestContextService: {
    createRequestContext: vi.fn((params?: Record<string, unknown>) => ({
      requestId: 'gc-pressure-test-request',
      timestamp: '2026-05-22T00:00:00.000Z',
      ...params,
    })),
  },
}));

vi.mock('@/utils/internal/runtime.js', () => ({
  runtimeCaps: mockRuntimeCaps,
}));

vi.mock('@/utils/internal/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('@/utils/internal/requestContext.js', () => ({
  requestContextService: mockRequestContextService,
}));

import { _gcPressureInternals, startGcPressureLoop } from '@/core/gcPressure.js';

describe('startGcPressureLoop', () => {
  beforeEach(() => {
    mockRuntimeCaps.isBun = true;
    mockLogger.info.mockReset();
    mockLogger.debug.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns a no-op disposer when interval <= 0', () => {
    const gc = vi.fn();
    vi.spyOn(_gcPressureInternals, 'resolveBunGc').mockReturnValue(gc);
    const disposer = startGcPressureLoop(0);
    vi.advanceTimersByTime(60_000);
    expect(gc).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(() => disposer()).not.toThrow();
  });

  it('skips when not running on Bun', () => {
    mockRuntimeCaps.isBun = false;
    const gc = vi.fn();
    vi.spyOn(_gcPressureInternals, 'resolveBunGc').mockReturnValue(gc);
    const disposer = startGcPressureLoop(1_000);
    vi.advanceTimersByTime(60_000);
    expect(gc).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(mockLogger.info.mock.calls[0]?.[0]).toMatch(/not running on Bun/);
    disposer();
  });

  it('skips when Bun.gc is not resolvable', () => {
    vi.spyOn(_gcPressureInternals, 'resolveBunGc').mockReturnValue(undefined);
    const disposer = startGcPressureLoop(1_000);
    vi.advanceTimersByTime(60_000);
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(mockLogger.info.mock.calls[0]?.[0]).toMatch(/Bun\.gc is not a function/);
    disposer();
  });

  it('calls Bun.gc(true) on every tick', () => {
    const gc = vi.fn();
    vi.spyOn(_gcPressureInternals, 'resolveBunGc').mockReturnValue(gc);
    const disposer = startGcPressureLoop(1_000);
    vi.advanceTimersByTime(3_500);
    expect(gc).toHaveBeenCalledTimes(3);
    expect(gc).toHaveBeenLastCalledWith(true);
    disposer();
  });

  it('disposer clears the interval and is idempotent', () => {
    const gc = vi.fn();
    vi.spyOn(_gcPressureInternals, 'resolveBunGc').mockReturnValue(gc);
    const disposer = startGcPressureLoop(500);
    vi.advanceTimersByTime(1_500);
    expect(gc).toHaveBeenCalledTimes(3);
    disposer();
    vi.advanceTimersByTime(5_000);
    expect(gc).toHaveBeenCalledTimes(3);
    expect(() => disposer()).not.toThrow();
  });

  it('swallows Bun.gc throws and keeps the interval running', () => {
    let calls = 0;
    const gc = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
    });
    vi.spyOn(_gcPressureInternals, 'resolveBunGc').mockReturnValue(gc);
    const disposer = startGcPressureLoop(1_000);
    vi.advanceTimersByTime(3_000);
    expect(gc).toHaveBeenCalledTimes(3);
    expect(mockLogger.debug).toHaveBeenCalled();
    disposer();
  });
});

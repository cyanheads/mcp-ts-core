/**
 * @fileoverview Unit tests for OTel metrics emitted by the RateLimiter.
 * Verifies that the `mcp.ratelimit.rejections` counter is recorded with correct
 * attributes when a request exceeds the configured limit, and is NOT recorded
 * for requests within the limit.
 * @module tests/unit/utils/security/rateLimiter.metrics.test
 */

import { trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCounterAdd = vi.fn();
const mockCounter = { add: mockCounterAdd };

vi.mock('@/utils/telemetry/metrics.js', () => ({
  createCounter: vi.fn(() => mockCounter),
  createHistogram: vi.fn(() => ({ record: vi.fn() })),
  createObservableGauge: vi.fn(() => ({})),
}));

vi.mock('@/utils/internal/requestContext.js', () => ({
  requestContextService: {
    createRequestContext: vi.fn((params: Record<string, unknown> = {}) => ({
      requestId: 'mock-req',
      timestamp: new Date().toISOString(),
      operation: params.operation ?? 'mock',
      ...((params.additionalContext as Record<string, unknown>) ?? {}),
    })),
  },
  withExtra: (context: any, fields: any) => ({
    ...context,
    extra: { ...context?.extra, ...fields },
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type { RateLimiter as RateLimiterType } from '@/utils/security/rateLimiter.js';

describe('RateLimiter metrics', () => {
  let RateLimiter: typeof RateLimiterType;
  let limiter: RateLimiterType;

  const mockConfig = { environment: 'production' } as any;
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  } as any;

  const spanMock = {
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    addEvent: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(spanMock as any);

    const mod = await import('@/utils/security/rateLimiter.js');
    RateLimiter = mod.RateLimiter;

    limiter = new RateLimiter(mockConfig, mockLogger);
    // Disable cleanup timer to avoid dangling timers in tests
    const timer = (limiter as any).cleanupTimer;
    if (timer) clearInterval(timer);
    (limiter as any).cleanupTimer = null;
    limiter.configure({ cleanupInterval: 0, maxRequests: 2, windowMs: 60_000 });
  });

  afterEach(() => {
    const timer = (limiter as any).cleanupTimer;
    if (timer) clearInterval(timer);
  });

  it('does not record rejection counter for requests within the limit', () => {
    limiter.check('user:1');
    limiter.check('user:1');

    // Two calls, both within maxRequests=2 — no rejection counter recorded
    expect(mockCounterAdd).not.toHaveBeenCalled();
  });

  it('records rejection counter when the limit is exceeded', () => {
    limiter.check('user:2');
    limiter.check('user:2');

    // Third call exceeds maxRequests=2
    expect(() => limiter.check('user:2')).toThrow();

    expect(mockCounterAdd).toHaveBeenCalledTimes(1);
    expect(mockCounterAdd).toHaveBeenCalledWith(1);
  });

  it('does not attach the per-key attribute to the rejection counter', () => {
    // Unbounded cardinality fix — the rejection counter is intentionally
    // unlabelled. Per-key attribution lives on the span (verified below).
    limiter.check('my-key');
    limiter.check('my-key');
    expect(() => limiter.check('my-key')).toThrow();

    // No 2nd argument means no attributes — verifies the label was dropped.
    const firstCall = mockCounterAdd.mock.calls[0];
    expect(firstCall).toEqual([1]);
  });

  it('still records the key on the active span for per-request attribution', () => {
    limiter.configure({
      maxRequests: 1,
      windowMs: 60_000,
      keyGenerator: (id) => `custom:${id}`,
    });

    limiter.check('original');
    expect(() => limiter.check('original')).toThrow();

    // The span (per-request, bounded) carries the key; the metric (global) does not.
    expect(spanMock.setAttribute).toHaveBeenCalledWith('mcp.rate_limit.key', 'custom:original');
  });
});

/**
 * @fileoverview Quota, eviction, and timer bounds through the public RateLimiter API.
 * @module tests/unit/utils/security/rateLimiter.bounds.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '@/config/index.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { RateLimiter } from '@/utils/security/rateLimiter.js';

describe('RateLimiter resource bounds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => vi.useRealTimers());

  it('does not extend an exhausted window when rejected requests keep arriving', () => {
    using limiter = new RateLimiter(config, logger);
    limiter.configure({ maxRequests: 1, windowMs: 2_000, cleanupInterval: 0 });
    limiter.check('caller');
    for (const elapsed of [1, 999, 1_999]) {
      vi.setSystemTime(10_000 + elapsed);
      expect(() => limiter.check('caller')).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.RateLimited,
          data: expect.objectContaining({ waitTimeSeconds: Math.ceil((2_000 - elapsed) / 1_000) }),
        }),
      );
      expect(limiter.getStatus('caller')).toMatchObject({ remaining: 0, resetTime: 12_000 });
    }
    vi.setSystemTime(12_000);
    limiter.check('caller');
    expect(limiter.getStatus('caller')).toEqual({
      current: 1,
      limit: 1,
      remaining: 0,
      resetTime: 14_000,
    });
  });

  it.each(['hot', ''])('refreshes recency and preserves quotas for a surviving key: %j', (hot) => {
    using limiter = new RateLimiter(config, logger);
    limiter.configure({ maxTrackedKeys: 2, maxRequests: 2, cleanupInterval: 0 });
    limiter.check(hot);
    vi.advanceTimersByTime(1);
    limiter.check('cold');
    vi.advanceTimersByTime(1);
    limiter.check(hot);
    vi.advanceTimersByTime(1);
    limiter.check('new');
    expect(limiter.getStatus('cold')).toBeNull();
    expect(limiter.getStatus('new')).toMatchObject({ current: 1 });
    expect(limiter.getStatus(hot)).toMatchObject({ current: 2, remaining: 0 });
    expect(() => limiter.check(hot)).toThrow(
      expect.objectContaining({ code: JsonRpcErrorCode.RateLimited }),
    );
  });

  it('keeps only the configured number of keys under sustained identity churn', () => {
    using limiter = new RateLimiter(config, logger);
    limiter.configure({ maxTrackedKeys: 8, cleanupInterval: 0 });
    const keys = Array.from({ length: 1_000 }, (_, i) => `caller-${i}`);
    for (const key of keys) {
      vi.advanceTimersByTime(1);
      limiter.check(key);
    }
    expect(keys.filter((key) => limiter.getStatus(key) !== null)).toEqual(keys.slice(-8));
  });

  it.each([false, true])('evicts empty keys under sustained churn (generated: %s)', (generated) => {
    using limiter = new RateLimiter(config, logger);
    limiter.configure({
      maxTrackedKeys: 2,
      cleanupInterval: 0,
      ...(generated && { keyGenerator: (key: string) => (key === 'empty' ? '' : key) }),
    });
    const keys = ['', ...Array.from({ length: 100 }, (_, i) => `caller-${i}`)];
    for (const key of keys) {
      // Keep timestamps tied too: insertion order resolves equal recency.
      limiter.check(generated && key === '' ? 'empty' : key);
    }
    expect(keys.filter((key) => limiter.getStatus(key) !== null)).toEqual(keys.slice(-2));
  });

  it('characterizes a live capacity reduction pending #407', () => {
    using limiter = new RateLimiter(config, logger);
    limiter.configure({ maxTrackedKeys: 4, cleanupInterval: 0 });
    const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (const key of keys.slice(0, 4)) limiter.check(key);
    limiter.configure({ maxTrackedKeys: 2 });
    for (const key of keys.slice(4)) limiter.check(key);
    // #407: live reductions currently retain the old size; eviction timing needs a defined contract.
    expect(limiter.getConfig().maxTrackedKeys).toBe(2);
    expect(keys.filter((key) => limiter.getStatus(key) !== null)).toEqual(['c', 'd', 'e', 'f']);
  });

  it('replaces the cleanup timer and disposal removes the final timer and keys', () => {
    const limiter = new RateLimiter(config, logger);
    try {
      for (const interval of [100, 200, 300]) {
        limiter.configure({ cleanupInterval: interval, windowMs: 500 });
        expect(vi.getTimerCount()).toBe(1);
      }
      limiter.check('expired');
      vi.advanceTimersByTime(600);
      expect(limiter.getStatus('expired')).toBeNull();
      limiter.check('live');
    } finally {
      limiter.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(limiter.getStatus('live')).toBeNull();
  });
});

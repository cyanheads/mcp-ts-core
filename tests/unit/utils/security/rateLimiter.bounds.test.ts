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

  it('enforces a live capacity reduction before configure() returns (#407)', () => {
    using limiter = new RateLimiter(config, logger);
    limiter.configure({ maxTrackedKeys: 4, cleanupInterval: 0 });
    const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (const key of keys.slice(0, 4)) limiter.check(key);
    limiter.configure({ maxTrackedKeys: 2 });
    // The cap is a memory ceiling: it holds on return, not after unrelated churn.
    expect(limiter.getConfig().maxTrackedKeys).toBe(2);
    expect(keys.filter((key) => limiter.getStatus(key) !== null)).toEqual(['c', 'd']);
    for (const key of keys.slice(4)) limiter.check(key);
    expect(keys.filter((key) => limiter.getStatus(key) !== null)).toEqual(['e', 'f']);
  });

  it('holds the new cap under sustained churn after a reduction (#407)', () => {
    using limiter = new RateLimiter(config, logger);
    limiter.configure({ maxTrackedKeys: 20, cleanupInterval: 0 });
    for (let i = 0; i < 20; i++) limiter.check(`seed-${i}`);
    limiter.configure({ maxTrackedKeys: 3 });
    const churn = Array.from({ length: 50 }, (_, i) => `churn-${i}`);
    for (const key of churn) {
      vi.advanceTimersByTime(1);
      limiter.check(key);
    }
    expect(churn.filter((key) => limiter.getStatus(key) !== null)).toEqual(churn.slice(-3));
    expect(
      Array.from({ length: 20 }, (_, i) => `seed-${i}`).filter(
        (key) => limiter.getStatus(key) !== null,
      ),
    ).toEqual([]);
  });

  it('preserves the windows of the entries a reduction keeps (#407)', () => {
    using limiter = new RateLimiter(config, logger);
    limiter.configure({ maxTrackedKeys: 4, maxRequests: 5, windowMs: 4_000, cleanupInterval: 0 });
    limiter.check('a');
    vi.advanceTimersByTime(1);
    limiter.check('b');
    vi.advanceTimersByTime(1);
    limiter.check('c');
    limiter.check('c');
    limiter.check('d');
    const before = { c: limiter.getStatus('c'), d: limiter.getStatus('d') };

    limiter.configure({ maxTrackedKeys: 2 });

    expect(limiter.getStatus('a')).toBeNull();
    expect(limiter.getStatus('b')).toBeNull();
    expect(limiter.getStatus('c')).toEqual(before.c);
    expect(limiter.getStatus('d')).toEqual(before.d);
    expect(before.c).toMatchObject({ current: 2, resetTime: 10_002 + 4_000 });
  });

  it('drops expired entries before evicting live ones (#407)', () => {
    using limiter = new RateLimiter(config, logger);
    limiter.configure({ maxTrackedKeys: 4, windowMs: 10_000, cleanupInterval: 0 });
    limiter.check('long-1');
    limiter.check('long-2');
    // Shorter windows, entered later: expired, yet the most recently accessed.
    limiter.configure({ windowMs: 500 });
    vi.setSystemTime(11_000);
    limiter.check('short-1');
    limiter.check('short-2');
    vi.setSystemTime(12_000);

    limiter.configure({ maxTrackedKeys: 2 });

    // Pure LRU would have taken the long-window pair; expiry outranks recency.
    expect(limiter.getStatus('short-1')).toBeNull();
    expect(limiter.getStatus('short-2')).toBeNull();
    expect(limiter.getStatus('long-1')).toMatchObject({ current: 1, resetTime: 20_000 });
    expect(limiter.getStatus('long-2')).toMatchObject({ current: 1, resetTime: 20_000 });
  });

  it('trims nothing and resets nothing when the cap is raised or restated (#407)', () => {
    using limiter = new RateLimiter(config, logger);
    const debug = vi.spyOn(logger, 'debug');
    limiter.configure({ maxTrackedKeys: 3, maxRequests: 5, cleanupInterval: 0 });
    for (const key of ['a', 'b', 'c']) limiter.check(key);
    limiter.check('a');
    const before = ['a', 'b', 'c'].map((key) => limiter.getStatus(key));
    debug.mockClear();

    for (const cap of [3, 4, 10_000]) {
      limiter.configure({ maxTrackedKeys: cap });
      expect(['a', 'b', 'c'].map((key) => limiter.getStatus(key))).toEqual(before);
    }

    expect(debug).not.toHaveBeenCalled();
  });

  it('logs a reduction once with the removed count and the resulting size (#407)', () => {
    using limiter = new RateLimiter(config, logger);
    limiter.configure({ maxTrackedKeys: 5, cleanupInterval: 0 });
    for (const key of ['a', 'b', 'c', 'd', 'e']) limiter.check(key);
    const debug = vi.spyOn(logger, 'debug');

    limiter.configure({ maxTrackedKeys: 2 });

    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('3'),
      expect.objectContaining({ extra: { removedCount: 3, totalRemainingAfterTrim: 2 } }),
    );
  });

  it('treats the empty string as an ordinary key through a reduction (#407)', () => {
    using evicted = new RateLimiter(config, logger);
    evicted.configure({ maxTrackedKeys: 3, cleanupInterval: 0 });
    evicted.check('');
    vi.advanceTimersByTime(1);
    evicted.check('b');
    vi.advanceTimersByTime(1);
    evicted.check('c');
    evicted.configure({ maxTrackedKeys: 2 });
    expect(evicted.getStatus('')).toBeNull();
    expect(evicted.getStatus('b')).toMatchObject({ current: 1 });

    using survives = new RateLimiter(config, logger);
    survives.configure({ maxTrackedKeys: 3, cleanupInterval: 0 });
    survives.check('a');
    vi.advanceTimersByTime(1);
    survives.check('b');
    vi.advanceTimersByTime(1);
    survives.check('');
    survives.configure({ maxTrackedKeys: 2 });
    expect(survives.getStatus('a')).toBeNull();
    expect(survives.getStatus('')).toMatchObject({ current: 1 });
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

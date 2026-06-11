/**
 * @fileoverview Unit tests for the RateLimiter utility.
 * @module tests/utils/security/rateLimiter.test
 */

import { trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { z } from 'zod';
import type { ConfigSchema } from '../../../../src/config/index.js';
import { JsonRpcErrorCode } from '../../../../src/types-global/errors.js';
import { logger } from '../../../../src/utils/internal/logger.js';
import type { RateLimiter as RateLimiterType } from '../../../../src/utils/security/rateLimiter.js';

describe('RateLimiter', () => {
  let rateLimiter: RateLimiterType;
  let config: z.infer<typeof ConfigSchema>;
  let RateLimiter: typeof RateLimiterType;
  let debugSpy: MockInstance;
  let getActiveSpanSpy: MockInstance;
  const spanMock = {
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    addEvent: vi.fn(),
  };

  const originalEnv = { ...process.env };

  const createLimiter = () => {
    rateLimiter = new RateLimiter(config, logger as never);
    const timer = (rateLimiter as unknown as { cleanupTimer: NodeJS.Timeout | null }).cleanupTimer;
    if (timer) {
      clearInterval(timer);
      (rateLimiter as unknown as { cleanupTimer: NodeJS.Timeout | null }).cleanupTimer = null;
    }
    rateLimiter.configure({ cleanupInterval: 0 });
  };

  beforeEach(async () => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
    process.env.NODE_ENV = 'production';

    const configModule = await import('../../../../src/config/index.js');
    const rateLimiterModule = await import('../../../../src/utils/security/rateLimiter.js');
    config = configModule.config;
    RateLimiter = rateLimiterModule.RateLimiter;

    debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    getActiveSpanSpy = vi.spyOn(trace, 'getActiveSpan').mockReturnValue(spanMock as never);
    createLimiter();
  });

  afterEach(() => {
    const timer = (rateLimiter as unknown as { cleanupTimer: NodeJS.Timeout | null }).cleanupTimer;
    if (timer) {
      clearInterval(timer);
    }
    process.env = originalEnv;
    debugSpy.mockRestore();
    getActiveSpanSpy.mockRestore();
  });

  it('increments counts and throws an McpError after exceeding the limit', () => {
    const context = { requestId: 'req-1', timestamp: new Date().toISOString() };
    rateLimiter.configure({ windowMs: 1000, maxRequests: 1 });

    rateLimiter.check('user:1', context);
    expect(rateLimiter.getStatus('user:1')).toMatchObject({
      current: 1,
      remaining: 0,
    });

    let thrown: unknown;
    try {
      rateLimiter.check('user:1', context);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown as object).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
    });

    const status = rateLimiter.getStatus('user:1');
    expect(status).toMatchObject({ current: 2, limit: 1, remaining: 0 });
    expect(spanMock.addEvent).toHaveBeenCalledWith('rate_limit_exceeded', {
      'mcp.rate_limit.wait_time_seconds': expect.any(Number),
    });
  });

  it('skips rate limiting in development when configured to do so', async () => {
    process.env.NODE_ENV = 'development';
    // Re-import modules to get the updated config
    const configModule = await import('../../../../src/config/index.js');
    const rateLimiterModule = await import('../../../../src/utils/security/rateLimiter.js');
    config = configModule.parseConfig(); // Use parseConfig to get a fresh config
    RateLimiter = rateLimiterModule.RateLimiter;

    // Create a new limiter with the development config
    const devRateLimiter = new RateLimiter(config, logger as never);
    devRateLimiter.configure({
      windowMs: 1000,
      maxRequests: 1,
      skipInDevelopment: true,
    });

    const context = {
      requestId: 'dev-req',
      timestamp: new Date().toISOString(),
    };

    expect(() => {
      devRateLimiter.check('dev:key', context);
      devRateLimiter.check('dev:key', context);
    }).not.toThrow();

    expect(spanMock.setAttribute).toHaveBeenCalledWith('mcp.rate_limit.skipped', 'development');
  });

  it('resets internal state and logs the action', () => {
    rateLimiter.configure({ windowMs: 1000, maxRequests: 1 });
    rateLimiter.check('to-reset', {
      requestId: 'reset-req',
      timestamp: new Date().toISOString(),
    });

    rateLimiter.reset();

    expect(rateLimiter.getStatus('to-reset')).toBeNull();
    expect(debugSpy).toHaveBeenCalledWith(
      'Rate limiter reset, all limits cleared',
      expect.objectContaining({ operation: 'RateLimiter.reset' }),
    );
  });

  it('cleans up expired entries when the cleanup timer runs', () => {
    const now = Date.now();
    const entryKey = 'expired';
    (
      rateLimiter as unknown as {
        limits: Map<string, { count: number; resetTime: number }>;
      }
    ).limits.set(entryKey, { count: 1, resetTime: now - 1000 });

    (rateLimiter as unknown as { cleanupExpiredEntries: () => void }).cleanupExpiredEntries();

    expect(rateLimiter.getStatus(entryKey)).toBeNull();
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('Cleaned up 1 expired rate limit entries'),
      expect.objectContaining({
        operation: 'RateLimiter.cleanupExpiredEntries',
      }),
    );
  });

  it('should return null status for a key that has not been checked', () => {
    const status = rateLimiter.getStatus('never-checked');
    expect(status).toBeNull();
  });

  it('should allow configuring the rate limiter and return config', () => {
    rateLimiter.configure({ windowMs: 5000, maxRequests: 10 });
    const conf = rateLimiter.getConfig();
    expect(conf.windowMs).toBe(5000);
    expect(conf.maxRequests).toBe(10);
  });

  it('should start cleanup timer when cleanup interval is set', () => {
    rateLimiter.configure({ cleanupInterval: 1000 });
    const timer = (rateLimiter as unknown as { cleanupTimer: NodeJS.Timeout | null }).cleanupTimer;
    expect(timer).not.toBeNull();

    // Clean up timer
    if (timer) {
      clearInterval(timer);
    }
  });

  it('should unref the cleanup timer when supported by the environment', () => {
    const unrefSpy = vi.fn();
    const fakeTimer = {
      unref: unrefSpy,
      ref: vi.fn(),
    } as unknown as NodeJS.Timeout;

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(fakeTimer);

    rateLimiter.configure({ cleanupInterval: 250 });

    expect(unrefSpy).toHaveBeenCalled();

    setIntervalSpy.mockRestore();
    rateLimiter.configure({ cleanupInterval: 0 });
  });

  it('should dispose cleanup resources and clear tracked limits', () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const fakeTimer = {
      unref: vi.fn(),
      ref: vi.fn(),
    } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(fakeTimer);

    rateLimiter.configure({ cleanupInterval: 500 });
    setIntervalSpy.mockRestore();

    rateLimiter.configure({ windowMs: 1000, maxRequests: 2 });
    rateLimiter.check('dispose-key', {
      requestId: 'dispose-req',
      timestamp: new Date().toISOString(),
    });
    expect(rateLimiter.getStatus('dispose-key')).not.toBeNull();

    rateLimiter.dispose();

    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(rateLimiter.getStatus('dispose-key')).toBeNull();

    clearIntervalSpy.mockRestore();
  });

  it('should evict the least-recently-used entry when maxTrackedKeys is exceeded', () => {
    rateLimiter.configure({
      windowMs: 60_000,
      maxRequests: 100,
      maxTrackedKeys: 3,
    });
    const ctx = { requestId: 'lru', timestamp: new Date().toISOString() };

    rateLimiter.check('key-1', ctx);
    rateLimiter.check('key-2', ctx);
    rateLimiter.check('key-3', ctx);
    // All three slots full; adding key-4 should evict the oldest (key-1)
    rateLimiter.check('key-4', ctx);

    expect(rateLimiter.getStatus('key-1')).toBeNull();
    expect(rateLimiter.getStatus('key-4')).not.toBeNull();
    expect(spanMock.addEvent).toHaveBeenCalledWith('rate_limit_lru_eviction', {
      'mcp.rate_limit.size_before_eviction': expect.any(Number),
      'mcp.rate_limit.max_keys': 3,
    });
  });

  it('should use a custom keyGenerator when configured', () => {
    rateLimiter.configure({
      windowMs: 60_000,
      maxRequests: 1,
      keyGenerator: (id, ctx) => `custom:${id}:${ctx?.requestId ?? 'none'}`,
    });
    const ctx = { requestId: 'gen-req', timestamp: new Date().toISOString() };

    rateLimiter.check('user', ctx);

    // The entry should be stored under the generated key
    expect(rateLimiter.getStatus('custom:user:gen-req')).toMatchObject({
      current: 1,
    });
    // Original key should not exist
    expect(rateLimiter.getStatus('user')).toBeNull();
  });

  it('should substitute {waitTime} in custom error messages', () => {
    rateLimiter.configure({
      windowMs: 10_000,
      maxRequests: 1,
      errorMessage: 'Slow down! Retry in {waitTime}s.',
    });
    const ctx = { requestId: 'msg', timestamp: new Date().toISOString() };

    rateLimiter.check('err-key', ctx);

    let thrown: unknown;
    try {
      rateLimiter.check('err-key', ctx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { message: string }).message).toMatch(/^Slow down! Retry in \d+s\.$/);
  });

  it('resets the window when the reset time has elapsed', () => {
    rateLimiter.configure({ windowMs: 1, maxRequests: 1 });
    const ctx = { requestId: 'window', timestamp: new Date().toISOString() };

    rateLimiter.check('window-key', ctx);
    // Manually expire the entry
    const limits = (
      rateLimiter as unknown as {
        limits: Map<string, { count: number; resetTime: number }>;
      }
    ).limits;
    const entry = limits.get('window-key');
    if (entry) entry.resetTime = Date.now() - 1;

    // Should not throw — window has reset
    expect(() => rateLimiter.check('window-key', ctx)).not.toThrow();
    expect(rateLimiter.getStatus('window-key')).toMatchObject({ current: 1 });
  });

  it('[Symbol.dispose] is equivalent to dispose()', () => {
    rateLimiter.configure({ windowMs: 60_000, maxRequests: 10 });
    rateLimiter.check('sym-key', { requestId: 'sym-req', timestamp: new Date().toISOString() });

    expect(rateLimiter.getStatus('sym-key')).not.toBeNull();

    // Call via the well-known symbol
    (rateLimiter as unknown as { [Symbol.dispose](): void })[Symbol.dispose]();

    expect(rateLimiter.getStatus('sym-key')).toBeNull();
  });
});

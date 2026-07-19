/**
 * @fileoverview Unit tests for the retry helper.
 * @module tests/utils/network/retry.test
 */

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { JsonRpcErrorCode, McpError } from '../../../../src/types-global/errors.js';
import { logger } from '../../../../src/utils/internal/logger.js';
import { withRetry } from '../../../../src/utils/network/retry.js';

describe('withRetry', () => {
  const context = {
    requestId: 'retry-test-request',
    timestamp: new Date().toISOString(),
    operation: 'retry-test',
  };

  let debugSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns immediately when the operation succeeds on the first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    await expect(withRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('retries transient McpError failures and eventually succeeds', async () => {
    vi.useFakeTimers();

    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'upstream unavailable'),
      )
      .mockRejectedValueOnce(new McpError(JsonRpcErrorCode.Timeout, 'request timed out'))
      .mockResolvedValueOnce('recovered');

    const promise = withRetry(fn, {
      baseDelayMs: 10,
      jitter: 0,
      maxRetries: 2,
      operation: 'fetchStudy',
      context,
    });

    await vi.advanceTimersByTimeAsync(30);

    await expect(promise).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(debugSpy).toHaveBeenCalledTimes(2);
    expect(debugSpy).toHaveBeenNthCalledWith(
      1,
      'Retry 1/2 for fetchStudy: upstream unavailable — waiting 10ms',
      context,
    );
    expect(debugSpy).toHaveBeenNthCalledWith(
      2,
      'Retry 2/2 for fetchStudy: request timed out — waiting 20ms',
      context,
    );
  });

  it('applies jitter when computing retry delays', async () => {
    vi.useFakeTimers();

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new McpError(JsonRpcErrorCode.RateLimited, 'slow down'))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, {
      baseDelayMs: 100,
      jitter: 0.25,
      maxRetries: 1,
      operation: 'jitteredCall',
      context,
    });

    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).resolves.toBe('ok');
    expect(randomSpy).toHaveBeenCalledOnce();
    expect(debugSpy).toHaveBeenCalledWith(
      'Retry 1/1 for jitteredCall: slow down — waiting 100ms',
      context,
    );
  });

  it('fails immediately for non-transient McpError codes', async () => {
    const failure = new McpError(JsonRpcErrorCode.Forbidden, 'insufficient permissions');
    const fn = vi.fn().mockRejectedValue(failure);

    await expect(withRetry(fn, { maxRetries: 5 })).rejects.toBe(failure);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('supports a custom transient predicate', async () => {
    const failure = new Error('fatal');
    const fn = vi.fn().mockRejectedValue(failure);

    await expect(
      withRetry(fn, {
        isTransient: () => false,
        maxRetries: 3,
      }),
    ).rejects.toBe(failure);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('enriches exhausted McpError failures with retry metadata', async () => {
    vi.useFakeTimers();

    const failure = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'service still unavailable', {
      upstream: 'catalog',
    });
    const resultPromise = withRetry(() => Promise.reject(failure), {
      baseDelayMs: 5,
      jitter: 0,
      maxRetries: 1,
      operation: 'syncCatalog',
    }).catch((error) => error);

    await vi.advanceTimersByTimeAsync(5);

    const result = await resultPromise;

    expect(result).toBeInstanceOf(McpError);
    expect(result).not.toBe(failure);
    expect(result.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(result.message).toBe('service still unavailable (failed after 2 attempts)');
    expect(result.data).toEqual({
      operation: 'syncCatalog',
      retryAttempts: 2,
      upstream: 'catalog',
    });
    expect(result.cause).toBe(failure);
  });

  it('wraps exhausted generic Error failures while preserving name and cause', async () => {
    vi.useFakeTimers();

    const failure = new TypeError('socket closed');
    const resultPromise = withRetry(() => Promise.reject(failure), {
      baseDelayMs: 5,
      jitter: 0,
      maxRetries: 1,
    }).catch((error) => error);

    await vi.advanceTimersByTimeAsync(5);

    const result = await resultPromise;

    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBe(failure);
    expect(result.name).toBe('TypeError');
    expect(result.message).toBe('socket closed (failed after 2 attempts)');
    expect(result.cause).toBe(failure);
  });

  it('rethrows the original error when the signal is already aborted', async () => {
    const controller = new AbortController();
    const failure = new McpError(JsonRpcErrorCode.Timeout, 'caller cancelled');
    controller.abort(new Error('already aborted'));

    await expect(
      withRetry(() => Promise.reject(failure), {
        signal: controller.signal,
      }),
    ).rejects.toBe(failure);
  });

  it('rejects immediately when the retry sleep starts with an aborted signal', async () => {
    const controller = new AbortController();
    const reason = new Error('already aborted');
    controller.abort(reason);

    await expect(
      withRetry(() => Promise.reject(new Error('retry me')), {
        baseDelayMs: 100,
        jitter: 0,
        maxRetries: 2,
        isTransient: () => true,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('rejects with the abort reason when cancellation happens during backoff sleep', async () => {
    vi.useFakeTimers();

    const controller = new AbortController();
    const reason = new Error('cancelled during retry');
    const failure = new McpError(JsonRpcErrorCode.Timeout, 'slow upstream');
    const promise = withRetry(() => Promise.reject(failure), {
      baseDelayMs: 100,
      jitter: 0,
      maxRetries: 2,
      signal: controller.signal,
    });

    await Promise.resolve();
    controller.abort(reason);

    await expect(promise).rejects.toBe(reason);
    expect(debugSpy).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-Error values unchanged after retry exhaustion', async () => {
    vi.useFakeTimers();

    const resultPromise = withRetry(() => Promise.reject('boom'), {
      baseDelayMs: 5,
      jitter: 0,
      maxRetries: 1,
    }).catch((error) => error);

    await vi.advanceTimersByTimeAsync(5);

    await expect(resultPromise).resolves.toBe('boom');
  });

  // -----------------------------------------------------------------------
  // data.retryable opt-out (#174)
  // -----------------------------------------------------------------------

  it('fails fast for a transient-coded McpError when data.retryable === false', async () => {
    const failure = new McpError(JsonRpcErrorCode.Timeout, 'query too expensive', {
      retryable: false,
    });
    const fn = vi.fn().mockRejectedValue(failure);

    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toBe(failure);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('still retries a transient-coded McpError when data.retryable is absent', async () => {
    vi.useFakeTimers();

    const failure = new McpError(JsonRpcErrorCode.Timeout, 'ephemeral timeout');
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, { baseDelayMs: 10, jitter: 0, maxRetries: 1 });

    await vi.advanceTimersByTimeAsync(10);

    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('still retries a transient-coded McpError when data.retryable === true', async () => {
    vi.useFakeTimers();

    const failure = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'upstream down', {
      retryable: true,
    });
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce('recovered');

    const promise = withRetry(fn, { baseDelayMs: 10, jitter: 0, maxRetries: 1 });

    await vi.advanceTimersByTimeAsync(10);

    await expect(promise).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('custom isTransient option fully replaces the default predicate (including data.retryable)', async () => {
    vi.useFakeTimers();

    // Even with data.retryable === false, the custom predicate overrides.
    const failure = new McpError(JsonRpcErrorCode.Timeout, 'timed out', { retryable: false });
    const fn = vi.fn().mockRejectedValue(failure);

    const resultPromise = withRetry(fn, {
      baseDelayMs: 5,
      jitter: 0,
      isTransient: () => true,
      maxRetries: 3,
    }).catch((e) => e);

    await vi.advanceTimersByTimeAsync(200);

    const result = await resultPromise;
    expect(result).toMatchObject({ message: expect.stringContaining('failed after 4 attempts') });
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('non-McpError is still treated as transient regardless of any retryable property', async () => {
    vi.useFakeTimers();

    // A plain Error with a retryable-looking property — should still retry
    const failure = Object.assign(new Error('network blip'), { retryable: false });
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, { baseDelayMs: 10, jitter: 0, maxRetries: 1 });

    await vi.advanceTimersByTimeAsync(10);

    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // Retry-After honoring (#285)
  // -----------------------------------------------------------------------

  it('honors a delta-seconds Retry-After over exponential backoff, bounded by the cap', async () => {
    vi.useFakeTimers();

    // baseDelayMs 10 → exponential first retry would be ~10ms; Retry-After asks 5s.
    const failure = new McpError(JsonRpcErrorCode.RateLimited, 'slow down', { retryAfter: '5' });
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, {
      baseDelayMs: 10,
      jitter: 0,
      maxRetries: 2,
      maxDelayMs: 30_000,
      operation: 'rateLimited',
      context,
    });

    // Non-vacuity: after the 10ms exponential window it must NOT have retried yet —
    // it is waiting the full 5s the upstream asked for.
    await vi.advanceTimersByTimeAsync(4000);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(debugSpy).toHaveBeenCalledWith(
      'Retry 1/2 for rateLimited: slow down — waiting 5000ms (Retry-After)',
      context,
    );
  });

  it('honors an HTTP-date Retry-After', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    const retryAt = new Date('2026-06-01T00:00:03Z').toUTCString(); // +3s

    const failure = new McpError(JsonRpcErrorCode.RateLimited, 'slow', { retryAfter: retryAt });
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, {
      baseDelayMs: 10,
      jitter: 0,
      maxRetries: 1,
      operation: 'rateLimited',
      context,
    });

    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(1); // still waiting ~3s, not the 10ms exponential

    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(debugSpy).toHaveBeenCalledWith(
      'Retry 1/1 for rateLimited: slow — waiting 3000ms (Retry-After)',
      context,
    );
  });

  it('fails fast without retrying when Retry-After exceeds maxDelayMs', async () => {
    // 1h wait, cap 30s — the window cannot clear within the retry budget.
    const failure = new McpError(JsonRpcErrorCode.RateLimited, 'rate limited', {
      retryAfter: '3600',
    });
    const fn = vi.fn().mockRejectedValue(failure);

    await expect(
      withRetry(fn, { maxRetries: 5, maxDelayMs: 30_000, operation: 'rateLimited', context }),
    ).rejects.toBe(failure); // the original error surfaces, not an enriched/exhausted one
    expect(fn).toHaveBeenCalledTimes(1); // no attempts burned
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('exceeds maxDelayMs'), context);
  });

  it('uses exponential backoff (no Retry-After suffix) when the error carries no retryAfter', async () => {
    vi.useFakeTimers();

    const failure = new McpError(JsonRpcErrorCode.RateLimited, 'slow down'); // no data.retryAfter
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, {
      baseDelayMs: 100,
      jitter: 0,
      maxRetries: 1,
      operation: 'rateLimited',
      context,
    });

    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    // Exact message, without the "(Retry-After)" marker — proves the marker is
    // exclusive to the honored path, and that 429 still retries by default.
    expect(debugSpy).toHaveBeenCalledWith(
      'Retry 1/1 for rateLimited: slow down — waiting 100ms',
      context,
    );
  });
});

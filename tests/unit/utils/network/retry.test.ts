/**
 * @fileoverview Unit tests for the retry helper.
 * @module tests/utils/network/retry.test
 */

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { JsonRpcErrorCode, McpError } from '../../../../src/types-global/errors.js';
import { logger } from '../../../../src/utils/internal/logger.js';
import { fetchWithTimeout } from '../../../../src/utils/network/fetchWithTimeout.js';
import { defaultIsTransient, withRetry } from '../../../../src/utils/network/retry.js';

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

  // -----------------------------------------------------------------------
  // defaultIsTransient composition (#450)
  // -----------------------------------------------------------------------

  describe('composing off the exported defaultIsTransient', () => {
    /**
     * A local budget refusal that still carries the client-facing rate_limited
     * contract — the wire tells the caller to wait and retry, so
     * `data.retryable: false` is not available as the in-band opt-out.
     */
    const budgetExhausted = () =>
      new McpError(JsonRpcErrorCode.RateLimited, 'request budget exhausted', {
        reason: 'budget_exhausted',
        retryAfter: '30',
      });

    const exceptThisOne = (error: unknown) =>
      !(error instanceof McpError && error.data?.reason === 'budget_exhausted') &&
      defaultIsTransient(error);

    it('fails fast on the narrowed error without burning an attempt', async () => {
      const failure = budgetExhausted();
      const fn = vi.fn().mockRejectedValue(failure);

      await expect(withRetry(fn, { isTransient: exceptThisOne, maxRetries: 3 })).rejects.toBe(
        failure,
      );
      expect(fn).toHaveBeenCalledTimes(1);
      // Not the Retry-After-over-cap exit — the predicate rejected it first.
      expect(debugSpy).not.toHaveBeenCalled();
    });

    it('keeps the wire contract intact on the narrowed error', async () => {
      const failure = budgetExhausted();
      const error = (await withRetry(() => Promise.reject(failure), {
        isTransient: exceptThisOne,
      }).catch((e: unknown) => e)) as McpError;

      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data?.retryAfter).toBe('30');
      expect(error.data).not.toHaveProperty('retryable');
    });

    it('still retries a transient code the composition did not narrow', async () => {
      vi.useFakeTimers();

      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'upstream down'))
        .mockResolvedValueOnce('recovered');

      const promise = withRetry(fn, {
        baseDelayMs: 10,
        jitter: 0,
        maxRetries: 2,
        isTransient: exceptThisOne,
      });

      await vi.advanceTimersByTimeAsync(10);

      await expect(promise).resolves.toBe('recovered');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('still fails fast on a non-transient code through the composition', async () => {
      const failure = new McpError(JsonRpcErrorCode.Forbidden, 'insufficient permissions');
      const fn = vi.fn().mockRejectedValue(failure);

      await expect(withRetry(fn, { isTransient: exceptThisOne, maxRetries: 3 })).rejects.toBe(
        failure,
      );
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('still honors the in-band data.retryable opt-out through the composition', async () => {
      const failure = new McpError(JsonRpcErrorCode.Timeout, 'query too expensive', {
        retryable: false,
      });
      const fn = vi.fn().mockRejectedValue(failure);

      await expect(withRetry(fn, { isTransient: exceptThisOne, maxRetries: 3 })).rejects.toBe(
        failure,
      );
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('still treats a non-McpError throw as transient through the composition', async () => {
      vi.useFakeTimers();

      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new TypeError('socket closed'))
        .mockResolvedValueOnce('ok');

      const promise = withRetry(fn, {
        baseDelayMs: 10,
        jitter: 0,
        maxRetries: 1,
        isTransient: exceptThisOne,
      });

      await vi.advanceTimersByTimeAsync(10);

      await expect(promise).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});

describe('withRetry deadlineMs — one wall-clock budget across attempts (#455)', () => {
  const context = {
    requestId: 'retry-deadline-request',
    timestamp: new Date().toISOString(),
    operation: 'retry-deadline',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Tracks settlement so a test can prove a wait actually happened. */
  const track = <T>(promise: Promise<T>) => {
    const state = { settled: false };
    const tracked = promise.then(
      (value) => {
        state.settled = true;
        return value as T | unknown;
      },
      (error: unknown) => {
        state.settled = true;
        return error;
      },
    );
    return { state, tracked };
  };

  /** A fetch that never answers — it settles only when its signal aborts. */
  const hangingFetch = () =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason);
          });
        }),
    );

  it('aborts the in-flight attempt at the deadline and surfaces the expiry, not RequestCancelled', async () => {
    vi.useFakeTimers();
    const fetchMock = hangingFetch();

    // The attempt's own timeout (30s) is far beyond the 1s total budget, so only
    // the deadline can end this attempt.
    const { state, tracked } = track(
      withRetry(
        ({ signal }) => fetchWithTimeout('https://api.example.com/x', 30_000, context, { signal }),
        {
          deadlineMs: 1000,
          baseDelayMs: 10,
          jitter: 0,
          maxRetries: 3,
          operation: 'search',
          context,
        },
      ),
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const error = (await tracked) as McpError;

    // fetchWithTimeout classifies an external-signal abort as RequestCancelled;
    // the deadline normalization is what keeps that off the wire.
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data?.reason).toBe('retry_deadline_exceeded');
    expect(error.data?.deadlineMs).toBe(1000);
    expect(error.data?.retryAttempts).toBe(1);
    expect(error.data?.elapsedMs).toBe(1000);
    expect(error.data).not.toHaveProperty('retryable');
    expect(error.data).not.toHaveProperty('attempt');
    // The overshoot this guards: the attempt is aborted, never waited out.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((error.cause as McpError).code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('surfaces the same expiry when the deadline lands mid-backoff', async () => {
    vi.useFakeTimers();

    // The backoff lands exactly on the deadline, so it is scheduled rather than
    // failed fast — and the clock's timer, armed first, wins the tick.
    const fn = vi
      .fn<(attempt: { signal: AbortSignal; remainingMs: number }) => Promise<string>>()
      .mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'upstream down'));

    const { state, tracked } = track(
      withRetry(fn, {
        deadlineMs: 1000,
        baseDelayMs: 1000,
        jitter: 0,
        maxRetries: 5,
        operation: 'search',
        context,
      }),
    );

    // Non-vacuity: the fail-fast branch would have rejected without any clock
    // advance. This one is asleep in the backoff, waiting for the deadline.
    await vi.advanceTimersByTimeAsync(999);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const error = (await tracked) as McpError;

    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data?.reason).toBe('retry_deadline_exceeded');
    expect(error.data?.retryAttempts).toBe(1);
    // Not the raw abort reason the sleep rejects with.
    expect(error).toBeInstanceOf(McpError);
    expect((error.cause as McpError).message).toBe('upstream down');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails fast when the next exponential delay outlasts the budget', async () => {
    vi.useFakeTimers();

    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'upstream down'));

    const promise = withRetry(fn, {
      deadlineMs: 1000,
      baseDelayMs: 5000,
      jitter: 0,
      maxRetries: 5,
      operation: 'search',
      context,
    }).catch((e: unknown) => e);

    // Resolves without any clock advance at all — nothing was slept.
    const error = (await promise) as McpError;

    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data?.reason).toBe('retry_deadline_exceeded');
    expect(error.data?.retryAttempts).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('surfaces the attempt error unchanged when an honored Retry-After outlasts the budget', async () => {
    vi.useFakeTimers();

    // 5s wait, 1s budget, 30s cap — so this is the deadline exit, not the cap exit.
    const failure = new McpError(JsonRpcErrorCode.RateLimited, 'slow down', { retryAfter: '5' });
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(failure);

    const promise = withRetry(fn, {
      deadlineMs: 1000,
      baseDelayMs: 10,
      jitter: 0,
      maxDelayMs: 30_000,
      maxRetries: 5,
      operation: 'search',
      context,
    }).catch((e: unknown) => e);

    const error = await promise;

    // "Wait the window the upstream named" is still the caller's action, so the
    // rate-limit error reaches them intact rather than as an expiry.
    expect(error).toBe(failure);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.RateLimited);
    expect((error as McpError).data?.retryAfter).toBe('5');
    expect((error as McpError).data?.reason).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hands each attempt a remainingMs that decreases and never goes negative', async () => {
    vi.useFakeTimers();

    const seen: number[] = [];
    const fn = vi.fn(async ({ remainingMs }: { remainingMs: number }) => {
      seen.push(remainingMs);
      throw new McpError(JsonRpcErrorCode.ServiceUnavailable, 'upstream down');
    });

    const promise = withRetry(fn, {
      deadlineMs: 10_000,
      baseDelayMs: 100,
      jitter: 0,
      maxRetries: 3,
      operation: 'search',
      context,
    }).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    // 4 attempts, backoffs 100/200/400 — the budget is never exhausted here, so
    // every attempt runs and the sequence is strictly decreasing.
    expect(seen).toEqual([10_000, 9900, 9700, 9300]);
    expect(seen.every((ms) => ms >= 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives a zero-argument operation an unchanged run under a deadline', async () => {
    vi.useFakeTimers();

    const fn = vi.fn<() => Promise<string>>().mockResolvedValue('ok');

    await expect(withRetry(fn, { deadlineMs: 1000 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  // ---------------------------------------------------------------------
  // Negative — the caller's own abort is never relabelled as an expiry
  // ---------------------------------------------------------------------

  it('rejects with the caller signal reason when the abort lands mid-attempt', async () => {
    vi.useFakeTimers();
    hangingFetch();

    const controller = new AbortController();
    const promise = withRetry(
      ({ signal }) => fetchWithTimeout('https://api.example.com/x', 30_000, context, { signal }),
      {
        deadlineMs: 10_000,
        signal: controller.signal,
        baseDelayMs: 10,
        jitter: 0,
        operation: 'search',
        context,
      },
    ).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(10);
    controller.abort('client disconnected');

    const error = (await promise) as McpError;

    // fetchWithTimeout's own classification, passed through untouched.
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(error.data?.reason).not.toBe('retry_deadline_exceeded');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with the caller signal reason when the abort lands mid-backoff', async () => {
    vi.useFakeTimers();

    const controller = new AbortController();
    const reason = new Error('cancelled during retry');
    const promise = withRetry(
      () => Promise.reject(new McpError(JsonRpcErrorCode.Timeout, 'slow upstream')),
      {
        deadlineMs: 10_000,
        signal: controller.signal,
        baseDelayMs: 1000,
        jitter: 0,
        maxRetries: 3,
        operation: 'search',
        context,
      },
    ).catch((e: unknown) => e);

    await Promise.resolve();
    controller.abort(reason);

    await expect(promise).resolves.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer behind after a non-transient throw', async () => {
    vi.useFakeTimers();

    const failure = new McpError(JsonRpcErrorCode.Forbidden, 'insufficient permissions');

    await expect(withRetry(() => Promise.reject(failure), { deadlineMs: 5000 })).rejects.toBe(
      failure,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  // ---------------------------------------------------------------------
  // Negative — no deadlineMs leaves every observable unchanged
  // ---------------------------------------------------------------------

  it('leaves attempt count, delays, log lines and the exhausted shape untouched without a deadline', async () => {
    vi.useFakeTimers();
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    const failure = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'still down', {
      upstream: 'catalog',
    });
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(failure);

    const promise = withRetry(fn, {
      baseDelayMs: 10,
      jitter: 0,
      maxRetries: 2,
      operation: 'search',
      context,
    }).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(30);
    const error = (await promise) as McpError;

    expect(fn).toHaveBeenCalledTimes(3);
    expect(error.message).toBe('still down (failed after 3 attempts)');
    expect(error.data).toEqual({
      operation: 'search',
      retryAttempts: 3,
      upstream: 'catalog',
    });
    expect(error.data?.reason).toBeUndefined();
    expect(debugSpy).toHaveBeenNthCalledWith(
      1,
      'Retry 1/2 for search: still down — waiting 10ms',
      context,
    );
    expect(debugSpy).toHaveBeenNthCalledWith(
      2,
      'Retry 2/2 for search: still down — waiting 20ms',
      context,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hands an unbounded operation an infinite remainingMs without a deadline', async () => {
    const seen: number[] = [];

    await expect(
      withRetry(async ({ remainingMs }) => {
        seen.push(remainingMs);
        return 'ok';
      }),
    ).resolves.toBe('ok');

    // `Math.min(perAttemptMs, remainingMs)` stays correct with no deadline set.
    expect(seen).toEqual([Number.POSITIVE_INFINITY]);
    expect(Math.min(30_000, seen[0] as number)).toBe(30_000);
  });
});

describe('withRetry over fetchWithTimeout — upstream 5xx policy (#323)', () => {
  const context = {
    requestId: 'retry-http-request',
    timestamp: new Date().toISOString(),
    operation: 'retry-http',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('re-attempts an upstream 500 through the full retry budget', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('upstream boom', { status: 500 }));

    const promise = withRetry(() => fetchWithTimeout('https://api.example.com/x', 1000, context), {
      baseDelayMs: 10,
      jitter: 0,
      maxRetries: 3,
      operation: 'fetchThing',
      context,
    }).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(200);
    const error = (await promise) as McpError;

    // 1 initial attempt + 3 retries — a 500 that classified as InternalError
    // never entered the loop at all.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.retryAttempts).toBe(4);
  });

  it('recovers when the upstream 500 clears on a later attempt', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const promise = withRetry(() => fetchWithTimeout('https://api.example.com/x', 1000, context), {
      baseDelayMs: 10,
      jitter: 0,
      maxRetries: 3,
      operation: 'fetchThing',
      context,
    });

    await vi.advanceTimersByTimeAsync(200);
    await expect(promise).resolves.toMatchObject({ status: 200 });
  });

  it('fails fast on an upstream 501 without burning an attempt', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('not implemented', { status: 501 }));

    const error = (await withRetry(
      () => fetchWithTimeout('https://api.example.com/x', 1000, context),
      { baseDelayMs: 10, jitter: 0, maxRetries: 3, operation: 'fetchThing', context },
    ).catch((e: unknown) => e)) as McpError;

    // A 501 shares ServiceUnavailable's transient code, so only the in-band
    // `data.retryable: false` keeps it out of the loop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.retryable).toBe(false);
    expect(error.data).not.toHaveProperty('retryAttempts');
  });

  it('keeps a caller-initiated cancellation out of the retry loop', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const controller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );

    const promise = withRetry(
      () =>
        fetchWithTimeout('https://api.example.com/x', 30_000, context, {
          signal: controller.signal,
        }),
      { baseDelayMs: 10, jitter: 0, maxRetries: 3, operation: 'fetchThing', context },
    ).catch((e: unknown) => e);

    controller.abort('client disconnected');
    const error = (await promise) as McpError;

    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

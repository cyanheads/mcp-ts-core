/**
 * @fileoverview Unit tests for the outbound request pacer.
 * @module tests/utils/network/pacer.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonRpcErrorCode, McpError } from '../../../../src/types-global/errors.js';
import { createPacer } from '../../../../src/utils/network/pacer.js';
import { withRetry } from '../../../../src/utils/network/retry.js';

/**
 * Records the instant each task starts, relative to the suite's fake-clock
 * origin, and resolves immediately unless a body is supplied.
 */
function makeRecorder(origin: () => number) {
  const startedAt: number[] = [];
  const task = (label: string, body?: () => Promise<unknown>) => async () => {
    startedAt.push(Date.now() - origin());
    return body ? await body() : label;
  };
  return { startedAt, task };
}

describe('createPacer', () => {
  let origin = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    origin = Date.now();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Windows, start gap, FIFO
  // -----------------------------------------------------------------------

  it('holds the third start until the sliding window reopens', async () => {
    const pacer = createPacer({ name: 'w', limits: [{ requests: 2, perMs: 1000 }] });
    const { startedAt, task } = makeRecorder(() => origin);

    const all = Promise.all([pacer.run(task('a')), pacer.run(task('b')), pacer.run(task('c'))]);

    await vi.advanceTimersByTimeAsync(0);
    expect(startedAt).toEqual([0, 0]);

    await vi.advanceTimersByTimeAsync(999);
    expect(startedAt).toEqual([0, 0]);

    await vi.advanceTimersByTimeAsync(1);
    await expect(all).resolves.toEqual(['a', 'b', 'c']);
    expect(startedAt).toEqual([0, 0, 1000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('spaces starts by minStartGapMs inside a window that would permit the burst', async () => {
    // `{ requests: 10, perMs: 1000 }` alone permits ten starts in one millisecond
    // — the burst minStartGapMs exists to smooth.
    const pacer = createPacer({
      name: 'gap',
      limits: [{ requests: 10, perMs: 1000 }],
      minStartGapMs: 100,
    });
    const { startedAt, task } = makeRecorder(() => origin);

    const all = Promise.all(Array.from({ length: 10 }, (_, i) => pacer.run(task(String(i)))));

    await vi.advanceTimersByTimeAsync(900);
    await expect(all).resolves.toHaveLength(10);
    expect(startedAt).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dispatches in enqueue order under contention', async () => {
    const pacer = createPacer({ name: 'fifo', minStartGapMs: 50 });
    const order: string[] = [];
    const task = (label: string) => async () => {
      order.push(label);
      return label;
    };

    const all = Promise.all([
      pacer.run(task('first')),
      pacer.run(task('second')),
      pacer.run(task('third')),
    ]);

    await vi.advanceTimersByTimeAsync(200);
    await all;
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('caps in-flight tasks at maxConcurrent and releases on completion', async () => {
    const pacer = createPacer({ name: 'conc', maxConcurrent: 2 });
    let inFlight = 0;
    let peak = 0;

    const slow = () => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 100));
      inFlight--;
      return 'done';
    };

    const all = Promise.all(Array.from({ length: 5 }, () => pacer.run(slow())));

    await vi.advanceTimersByTimeAsync(0);
    expect(inFlight).toBe(2);

    await vi.advanceTimersByTimeAsync(400);
    await expect(all).resolves.toHaveLength(5);
    expect(peak).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Abort while queued
  // -----------------------------------------------------------------------

  it('rejects a queued entry with signal.reason, keeps its place free, and does not delay the next waiter', async () => {
    const pacer = createPacer({ name: 'abort', limits: [{ requests: 1, perMs: 1000 }] });
    const { startedAt, task } = makeRecorder(() => origin);
    const controller = new AbortController();
    const reason = new Error('caller went away');

    const first = pacer.run(task('first'));
    const cancelled = pacer.run(task('cancelled'), { signal: controller.signal });
    const third = pacer.run(task('third'));

    await vi.advanceTimersByTimeAsync(0);
    expect(startedAt).toEqual([0]);

    controller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);

    await vi.advanceTimersByTimeAsync(1000);
    await expect(Promise.all([first, third])).resolves.toEqual(['first', 'third']);
    // `third` inherited the slot at t=1000 rather than waiting out a ghost entry.
    expect(startedAt).toEqual([0, 1000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves an abort after dispatch to the task, which receives the signal', async () => {
    const pacer = createPacer({ name: 'dispatched' });
    const controller = new AbortController();
    const reason = new Error('mid-flight');

    const promise = pacer.run(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason);
          });
        }),
      { signal: controller.signal },
    );

    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);

    await expect(promise).rejects.toBe(reason);
  });

  // -----------------------------------------------------------------------
  // Shedding
  // -----------------------------------------------------------------------

  it('sheds at enqueue when maxWaitMs is below the window-derived earliest start, without invoking the task', async () => {
    const pacer = createPacer({ name: 'shed', limits: [{ requests: 1, perMs: 10_000 }] });
    const never = vi.fn(async () => 'never');

    await pacer.run(async () => 'first');
    await vi.advanceTimersByTimeAsync(0);

    // Next slot is 10s out; the caller will wait 1s at most.
    const error = (await pacer
      .run(never, { maxWaitMs: 1000 })
      .catch((e: unknown) => e)) as McpError;

    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data?.reason).toBe('pacer_shed');
    expect(error.data?.retryAfter).toBe(10);
    expect(error.data?.queueDepth).toBe(0);
    expect(error.data).not.toHaveProperty('retryable');
    expect(never).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not shed when the projected wait fits inside maxWaitMs', async () => {
    const pacer = createPacer({ name: 'fits', limits: [{ requests: 1, perMs: 1000 }] });

    await pacer.run(async () => 'first');
    await vi.advanceTimersByTimeAsync(0);

    const second = pacer.run(async () => 'second', { maxWaitMs: 5000 });
    await vi.advanceTimersByTimeAsync(1000);

    await expect(second).resolves.toBe('second');
  });

  it('sheds a still-queued entry at maxWaitMs when maxConcurrent is what binds', async () => {
    // Concurrency makes the wait unknowable, so the enqueue check cannot shed —
    // the deadline timer is the only thing that can.
    const pacer = createPacer({ name: 'conc-shed', maxConcurrent: 1 });

    const blocker = pacer.run(
      () => new Promise((resolve) => setTimeout(() => resolve('blocker'), 10_000)),
    );
    await vi.advanceTimersByTimeAsync(0);

    const never = vi.fn(async () => 'never');
    const queued = pacer.run(never, { maxWaitMs: 1000 }).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(999);
    expect(never).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const error = (await queued) as McpError;

    expect(error.data?.reason).toBe('pacer_shed');
    expect(never).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(blocker).resolves.toBe('blocker');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sheds on maxQueueDepth without arming a timer', async () => {
    const pacer = createPacer({
      name: 'depth',
      limits: [{ requests: 1, perMs: 10_000 }],
      maxQueueDepth: 1,
    });

    const first = pacer.run(async () => 'first');
    await vi.advanceTimersByTimeAsync(0);

    // One waiter fills the queue; no maxWaitMs anywhere, so no timer but the
    // pacer's own dispatch timer may exist.
    const queued = pacer.run(async () => 'queued');
    const timersBefore = vi.getTimerCount();

    const never = vi.fn(async () => 'never');
    const error = (await pacer.run(never).catch((e: unknown) => e)) as McpError;

    expect(error.data?.reason).toBe('pacer_shed');
    expect(error.data?.queueDepth).toBe(1);
    expect(never).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(timersBefore);

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(Promise.all([first, queued])).resolves.toEqual(['first', 'queued']);
  });

  // -----------------------------------------------------------------------
  // Cooldown gate
  // -----------------------------------------------------------------------

  const rateLimit = (retryAfter?: string) =>
    new McpError(JsonRpcErrorCode.RateLimited, 'upstream rate limited', {
      ...(retryAfter === undefined ? {} : { retryAfter }),
    });

  /**
   * The gate closes when the failing task settles, which is a microtask after it
   * was dispatched. Without a concurrency cap nothing is still *queued* by then,
   * so these cases use the serial shape the hand-rolled clients actually run.
   */
  const serial = (cooldown?: { baseMs: number; maxMs: number }) =>
    createPacer({ name: 'cool', maxConcurrent: 1, ...(cooldown ? { cooldown } : {}) });

  it('gates every queued caller until the instant an honored Retry-After names', async () => {
    const pacer = serial({ baseMs: 1000, maxMs: 60_000 });
    const { startedAt, task } = makeRecorder(() => origin);

    const limited = pacer
      .run(async () => {
        throw rateLimit('5');
      })
      .catch((e: unknown) => e);
    const queued = pacer.run(task('queued'));

    await vi.advanceTimersByTimeAsync(0);
    await limited;

    // The honored 5s wins over the 1s baseMs.
    await vi.advanceTimersByTimeAsync(4999);
    expect(startedAt).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await expect(queued).resolves.toBe('queued');
    expect(startedAt).toEqual([5000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('doubles the cooldown on consecutive rate limits and resets on the first success', async () => {
    const pacer = serial({ baseMs: 1000, maxMs: 60_000 });
    const { startedAt, task } = makeRecorder(() => origin);
    const fail = async () => {
      throw rateLimit();
    };

    // Three callers queued behind each other: fail, fail, probe.
    const first = pacer.run(fail).catch((e: unknown) => e);
    const second = pacer.run(fail).catch((e: unknown) => e);
    const probe = pacer.run(task('probe'));

    // 1st → baseMs (1000) → 2nd runs at t=1000 → 2nd → baseMs·2 (2000) → probe
    // at t=3000. A pacer that never doubled would have started it at t=2000.
    await vi.advanceTimersByTimeAsync(2999);
    expect(startedAt).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second, probe]);
    expect(startedAt).toEqual([3000]);

    // The probe succeeded, so the counter is back to zero: the next rate limit
    // gates by baseMs again, not by baseMs·2^3.
    const third = pacer.run(fail).catch((e: unknown) => e);
    const after = pacer.run(task('after'));

    await vi.advanceTimersByTimeAsync(999);
    expect(startedAt).toEqual([3000]);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([third, after]);
    expect(startedAt).toEqual([3000, 4000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps both the doubling and an honored Retry-After at maxMs', async () => {
    const pacer = serial({ baseMs: 1000, maxMs: 2000 });
    const { startedAt, task } = makeRecorder(() => origin);

    // A pathological Retry-After (1h) must not park the queue past maxMs.
    const limited = pacer
      .run(async () => {
        throw rateLimit('3600');
      })
      .catch((e: unknown) => e);
    const queued = pacer.run(task('queued'));

    await vi.advanceTimersByTimeAsync(0);
    await limited;

    await vi.advanceTimersByTimeAsync(1999);
    expect(startedAt).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await expect(queued).resolves.toBe('queued');
    expect(startedAt).toEqual([2000]);
  });

  it('caps the doubling at maxMs with no Retry-After in play', async () => {
    const pacer = serial({ baseMs: 1000, maxMs: 1500 });
    const { startedAt, task } = makeRecorder(() => origin);
    const fail = async () => {
      throw rateLimit();
    };

    const first = pacer.run(fail).catch((e: unknown) => e);
    const second = pacer.run(fail).catch((e: unknown) => e);
    const probe = pacer.run(task('probe'));

    // 1st → 1000 (under the cap), 2nd → min(2000, 1500) = 1500 → t=2500.
    await vi.advanceTimersByTimeAsync(2499);
    expect(startedAt).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second, probe]);
    expect(startedAt).toEqual([2500]);
  });

  it('falls back to baseMs when Retry-After is absent or unparseable', async () => {
    for (const retryAfter of [undefined, 'not-a-date']) {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      origin = Date.now();

      using pacer = serial({ baseMs: 1500, maxMs: 60_000 });
      const { startedAt, task } = makeRecorder(() => origin);

      const limited = pacer
        .run(async () => {
          throw rateLimit(retryAfter);
        })
        .catch((e: unknown) => e);
      const queued = pacer.run(task('queued'));

      await vi.advanceTimersByTimeAsync(0);
      await limited;
      await vi.advanceTimersByTimeAsync(1499);
      expect(startedAt).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      await queued;
      expect(startedAt).toEqual([1500]);
    }
  });

  it('leaves the gate open for a non-RateLimited throw', async () => {
    const pacer = serial({ baseMs: 10_000, maxMs: 60_000 });
    const { startedAt, task } = makeRecorder(() => origin);

    const failed = pacer
      .run(async () => {
        throw new McpError(JsonRpcErrorCode.ServiceUnavailable, 'upstream down');
      })
      .catch((e: unknown) => e);
    const next = pacer.run(task('next'));

    await vi.advanceTimersByTimeAsync(0);
    await failed;
    await expect(next).resolves.toBe('next');
    // No gate — the next caller ran without waiting the 10s a rate limit
    // would have imposed.
    expect(startedAt).toEqual([0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('paces nothing on a rate limit when no cooldown is configured', async () => {
    const pacer = serial();
    const { startedAt, task } = makeRecorder(() => origin);

    const limited = pacer
      .run(async () => {
        throw rateLimit('30');
      })
      .catch((e: unknown) => e);
    const next = pacer.run(task('next'));

    await vi.advanceTimersByTimeAsync(0);
    await limited;
    await expect(next).resolves.toBe('next');
    expect(startedAt).toEqual([0]);
  });

  // -----------------------------------------------------------------------
  // Composition with withRetry
  // -----------------------------------------------------------------------

  it('is not retried by withRetry, because a shed is non-transient to the default predicate', async () => {
    const pacer = createPacer({ name: 'no-retry', limits: [{ requests: 1, perMs: 10_000 }] });
    const task = vi.fn(async () => 'never');

    await pacer.run(async () => 'first');
    await vi.advanceTimersByTimeAsync(0);

    const error = (await withRetry(({ signal }) => pacer.run(task, { signal, maxWaitMs: 100 }), {
      baseDelayMs: 10,
      jitter: 0,
      maxRetries: 3,
      operation: 'paced',
    }).catch((e: unknown) => e)) as McpError;

    // A shed carries a transient CODE, so only the `reason` clause keeps it out
    // of the loop — and it must stay out, or the retry would sleep `retryAfter`
    // past the very deadline the shed enforces.
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data?.reason).toBe('pacer_shed');
    expect(error.data).not.toHaveProperty('retryAttempts');
    expect(error.data).not.toHaveProperty('retryable');
    expect(task).not.toHaveBeenCalled();
  });

  it('waits an upstream Retry-After once, not twice, with withRetry around run', async () => {
    const pacer = createPacer({ name: 'compose', cooldown: { baseMs: 5000, maxMs: 60_000 } });
    const attemptAt: number[] = [];

    const task = vi.fn(async () => {
      attemptAt.push(Date.now() - origin);
      if (attemptAt.length === 1) throw rateLimit('5');
      return 'recovered';
    });

    const promise = withRetry(({ signal }) => pacer.run(task, { signal }), {
      baseDelayMs: 10,
      jitter: 0,
      maxRetries: 2,
      maxDelayMs: 30_000,
      operation: 'paced',
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(attemptAt).toEqual([0]);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe('recovered');

    // The gate is an absolute instant, so withRetry's Retry-After sleep and the
    // cooldown overlap in wall-clock rather than summing to 10s.
    expect(attemptAt).toEqual([0, 5000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  it('dispose() clears the pending timer and rejects queued waiters', async () => {
    const pacer = createPacer({ name: 'dispose', limits: [{ requests: 1, perMs: 10_000 }] });
    const never = vi.fn(async () => 'never');

    const first = pacer.run(async () => 'first');
    await vi.advanceTimersByTimeAsync(0);

    const queued = pacer.run(never).catch((e: unknown) => e);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    pacer.dispose();

    const error = (await queued) as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(never).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await expect(first).resolves.toBe('first');
  });

  it('is idempotent on dispose and refuses further work', async () => {
    const pacer = createPacer({ name: 'disposed' });
    pacer.dispose();
    pacer.dispose();

    const error = (await pacer.run(async () => 'x').catch((e: unknown) => e)) as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
  });

  it('disposes through the explicit-resource-management protocol', async () => {
    const never = vi.fn(async () => 'never');
    let queued!: Promise<unknown>;

    {
      using pacer = createPacer({ name: 'using', limits: [{ requests: 1, perMs: 10_000 }] });
      await pacer.run(async () => 'first');
      await vi.advanceTimersByTimeAsync(0);
      queued = pacer.run(never).catch((e: unknown) => e);
    }

    expect(((await queued) as McpError).code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(never).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no pending timer once the last task settles', async () => {
    const pacer = createPacer({
      name: 'clean',
      limits: [{ requests: 2, perMs: 500 }],
      minStartGapMs: 50,
      maxConcurrent: 2,
    });

    const all = Promise.all(Array.from({ length: 6 }, (_, i) => pacer.run(async () => i)));

    await vi.advanceTimersByTimeAsync(5000);
    await expect(all).resolves.toEqual([0, 1, 2, 3, 4, 5]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects immediately when the caller signal is already aborted', async () => {
    const pacer = createPacer({ name: 'pre-aborted' });
    const controller = new AbortController();
    const reason = new Error('already gone');
    controller.abort(reason);

    const task = vi.fn(async () => 'never');
    await expect(pacer.run(task, { signal: controller.signal })).rejects.toBe(reason);
    expect(task).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies every configured window, not just the narrowest', async () => {
    // Per-2s and per-10s together: the first two go straight through, the third
    // waits the 2s window, and the fourth waits the 10s one.
    const pacer = createPacer({
      name: 'multi',
      limits: [
        { requests: 2, perMs: 2000 },
        { requests: 3, perMs: 10_000 },
      ],
    });
    const { startedAt, task } = makeRecorder(() => origin);

    const all = Promise.all(Array.from({ length: 4 }, (_, i) => pacer.run(task(String(i)))));

    await vi.advanceTimersByTimeAsync(10_000);
    await all;
    expect(startedAt).toEqual([0, 0, 2000, 10_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles a task that throws before returning a promise on its own caller, and frees the slot', async () => {
    const pacer = createPacer({ name: 'sync-throw', maxConcurrent: 1 });
    const boom = new Error('threw before any promise');
    const throwing = (() => {
      throw boom;
    }) as () => Promise<never>;

    // Queued behind an in-flight task, so the throw happens inside a pump that a
    // different caller's completion triggered.
    let release: (value: string) => void = () => {};
    const first = pacer.run(() => new Promise<string>((resolve) => (release = resolve)));
    const second = pacer.run(throwing);
    const third = pacer.run(async () => 'third');
    const settled = Promise.allSettled([first, second, third]);

    await vi.advanceTimersByTimeAsync(0);
    release('first');
    await vi.advanceTimersByTimeAsync(0);

    expect(await settled).toEqual([
      { status: 'fulfilled', value: 'first' },
      { status: 'rejected', reason: boom },
      { status: 'fulfilled', value: 'third' },
    ]);
  });
});

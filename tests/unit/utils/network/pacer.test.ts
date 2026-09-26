/**
 * @fileoverview Unit tests for the outbound request pacer.
 * @module tests/utils/network/pacer.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonRpcErrorCode, McpError } from '../../../../src/types-global/errors.js';
import { createPacer, type Pacer } from '../../../../src/utils/network/pacer.js';
import { defaultIsTransient, withRetry } from '../../../../src/utils/network/retry.js';

// The four `mcp.pacer.*` instruments are the pacer's only side effect outside
// the promises it settles, so every add is captured.
const { metricAdds } = vi.hoisted(() => ({
  metricAdds: [] as Array<{ attributes: Record<string, unknown>; metric: string; value: number }>,
}));

vi.mock('@/utils/telemetry/metrics.js', () => {
  const instrument = (metric: string) => ({
    add: (value: number, attributes: Record<string, unknown> = {}) => {
      metricAdds.push({ attributes, metric, value });
    },
    record: () => {},
  });
  return {
    getMeter: () => ({}),
    createCounter: instrument,
    createUpDownCounter: instrument,
    createHistogram: instrument,
    createObservableGauge: () => ({}),
  };
});

/** Every add on `metric` attributed to the pacer named `name`. */
const addsFor = (metric: string, name: string) =>
  metricAdds.filter((add) => add.metric === metric && add.attributes['mcp.pacer.name'] === name);

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
    metricAdds.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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
    expect(error.message).toBe("No shed request slot available within the caller's wait budget.");
    // Exact, so no `retryable` key either.
    expect(error.data).toEqual({
      reason: 'pacer_shed',
      shedKind: 'wait_projected',
      retryAfter: 10,
      queueDepth: 0,
    });
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

    expect(error.message).toBe(
      "The caller's wait budget ran out before a conc-shed request slot opened.",
    );
    // Nothing projects when a concurrency slot frees, so retryAfter is floored at
    // the second this caller already waited rather than reporting 0.
    expect(error.data).toEqual({
      reason: 'pacer_shed',
      shedKind: 'wait_elapsed',
      retryAfter: 1,
      queueDepth: 0,
    });
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

    expect(error.message).toBe('No depth request slot is open and the wait queue is full.');
    // Behind the one waiter (t=10s), then its own slot one window later.
    expect(error.data).toEqual({
      reason: 'pacer_shed',
      shedKind: 'queue_full',
      retryAfter: 20,
      queueDepth: 1,
    });
    expect(never).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(timersBefore);

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(Promise.all([first, queued])).resolves.toEqual(['first', 'queued']);
  });

  // -----------------------------------------------------------------------
  // Shed kinds and retryAfter
  // -----------------------------------------------------------------------

  /** A task that holds its concurrency slot for `ms`, then resolves `label`. */
  const holdFor =
    (ms: number, label = 'held') =>
    () =>
      new Promise<string>((resolve) => setTimeout(() => resolve(label), ms));

  it('projects a wait_elapsed retryAfter behind every waiter still queued', async () => {
    const pacer = createPacer({
      name: 'behind',
      maxConcurrent: 1,
      limits: [{ requests: 1, perMs: 2000 }],
    });

    const blocker = pacer.run(holdFor(10_000));
    await vi.advanceTimersByTimeAsync(0);

    // Projected start 2s (the window), inside the 3s budget: admitted.
    const shed = pacer.run(async () => 'never', { maxWaitMs: 3000 }).catch((e: unknown) => e);
    const behind = [1, 2, 3].map((i) => pacer.run(async () => i));

    await vi.advanceTimersByTimeAsync(3000);
    // A caller returning now joins behind the three: the window alone starts
    // them at 3, 5, and 7s, and the returning caller at 9s — 6s out.
    expect(((await shed) as McpError).data).toEqual({
      reason: 'pacer_shed',
      shedKind: 'wait_elapsed',
      retryAfter: 6,
      queueDepth: 3,
    });

    await vi.advanceTimersByTimeAsync(20_000);
    await expect(Promise.all([blocker, ...behind])).resolves.toEqual(['held', 1, 2, 3]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('floors a queue_full retryAfter at the longest queued wait while maxConcurrent binds', async () => {
    const pacer = createPacer({ name: 'full', maxConcurrent: 1, maxQueueDepth: 1 });

    const blocker = pacer.run(holdFor(10_000));
    await vi.advanceTimersByTimeAsync(4000);
    const waiter = pacer.run(async () => 'waiter');
    await vi.advanceTimersByTimeAsync(2500);

    const never = vi.fn(async () => 'never');
    const error = (await pacer.run(never).catch((e: unknown) => e)) as McpError;

    expect(error.message).toBe('No full request slot is open and the wait queue is full.');
    // The waiter has held its place 2.5s without a slot freeing: 3s, rounded up.
    expect(error.data).toEqual({
      reason: 'pacer_shed',
      shedKind: 'queue_full',
      retryAfter: 3,
      queueDepth: 1,
    });
    expect(never).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(Promise.all([blocker, waiter])).resolves.toEqual(['held', 'waiter']);
  });

  it('floors a wait_projected retryAfter at the queue head wait while maxConcurrent binds', async () => {
    const pacer = createPacer({
      name: 'projected-floor',
      maxConcurrent: 1,
      limits: [{ requests: 1, perMs: 2000 }],
    });

    const blocker = pacer.run(holdFor(10_000));
    await vi.advanceTimersByTimeAsync(0);
    const waiter = pacer.run(async () => 'waiter');
    await vi.advanceTimersByTimeAsync(5000);

    const error = (await pacer
      .run(async () => 'never', { maxWaitMs: 100 })
      .catch((e: unknown) => e)) as McpError;

    expect(error.message).toBe(
      "No projected-floor request slot available within the caller's wait budget.",
    );
    // The windows alone put this caller 2s out, but the head has already waited
    // 5s on a concurrency slot the projection cannot see.
    expect(error.data).toEqual({
      reason: 'pacer_shed',
      shedKind: 'wait_projected',
      retryAfter: 5,
      queueDepth: 1,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(Promise.all([blocker, waiter])).resolves.toEqual(['held', 'waiter']);
  });

  it('marks an enqueue projection over a closed gate wait_projected, sized to the gate', async () => {
    const pacer = serial({ baseMs: 5000, maxMs: 60_000 });

    await pacer
      .run(async () => {
        throw rateLimit();
      })
      .catch((e: unknown) => e);
    const error = (await pacer
      .run(async () => 'never', { maxWaitMs: 1000 })
      .catch((e: unknown) => e)) as McpError;

    expect(error.data).toEqual({
      reason: 'pacer_shed',
      shedKind: 'wait_projected',
      retryAfter: 5,
      queueDepth: 0,
    });
    expect(error.data?.retryAfter).toBe(Math.ceil(pacer.cooldown.remainingMs / 1000));
  });

  it('dispatches an entry whose slot opens the instant its maxWaitMs runs out', async () => {
    const pacer = createPacer({ name: 'edge', limits: [{ requests: 1, perMs: 1000 }] });
    const { startedAt, task } = makeRecorder(() => origin);

    await pacer.run(task('first'));
    // Projected wait equals the budget exactly, so enqueue admits it; its shed
    // timer and the dispatch timer then fall due together at 1s.
    const second = pacer.run(task('second'), { maxWaitMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(startedAt).toEqual([0, 1000]);
    await expect(second).resolves.toBe('second');
    expect(addsFor('mcp.pacer.sheds', 'edge')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dispatches a budgeted waiter queued behind others when its slot opens as the budget ends', async () => {
    const pacer = createPacer({ name: 'edge-deep', limits: [{ requests: 1, perMs: 1000 }] });
    const { startedAt, task } = makeRecorder(() => origin);

    const all = [
      pacer.run(task('a')),
      pacer.run(task('b')),
      // Projected 2s behind `b`, equal to its budget.
      pacer.run(task('c'), { maxWaitMs: 2000 }),
    ];

    await vi.advanceTimersByTimeAsync(2000);
    expect(startedAt).toEqual([0, 1000, 2000]);
    await expect(Promise.all(all)).resolves.toEqual(['a', 'b', 'c']);
    expect(addsFor('mcp.pacer.sheds', 'edge-deep')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  // -----------------------------------------------------------------------
  // maxQueueDepth bounds waiters, not arrivals
  // -----------------------------------------------------------------------

  it('runs an arrival on an idle pacer under maxQueueDepth: 0', async () => {
    const pacer = createPacer({ name: 'no-queue', maxQueueDepth: 0 });

    await expect(pacer.run(async () => 'ran')).resolves.toBe('ran');
    expect(addsFor('mcp.pacer.sheds', 'no-queue')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sheds, rather than queues, an arrival that would wait for a concurrency slot under maxQueueDepth: 0', async () => {
    const pacer = createPacer({ name: 'no-queue-conc', maxConcurrent: 1, maxQueueDepth: 0 });
    let release: (value: string) => void = () => {};
    const first = pacer.run(() => new Promise<string>((resolve) => (release = resolve)));

    const never = vi.fn(async () => 'never');
    const error = (await pacer.run(never).catch((e: unknown) => e)) as McpError;

    expect(error.message).toBe('No no-queue-conc request slot is open and the wait queue is full.');
    expect(error.data).toEqual({
      reason: 'pacer_shed',
      shedKind: 'queue_full',
      retryAfter: 1,
      queueDepth: 0,
    });
    expect(never).not.toHaveBeenCalled();

    release('first');
    await expect(first).resolves.toBe('first');
    // The slot is free again, so the next arrival starts at once.
    await expect(pacer.run(async () => 'third')).resolves.toBe('third');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sheds an arrival inside a closed window under maxQueueDepth: 0, sized to the window', async () => {
    const pacer = createPacer({
      name: 'no-queue-window',
      limits: [{ requests: 1, perMs: 2000 }],
      maxQueueDepth: 0,
    });

    await pacer.run(async () => 'first');
    await vi.advanceTimersByTimeAsync(500);

    const error = (await pacer.run(async () => 'never').catch((e: unknown) => e)) as McpError;
    expect(error.data).toEqual({
      reason: 'pacer_shed',
      shedKind: 'queue_full',
      retryAfter: 2,
      queueDepth: 0,
    });

    await vi.advanceTimersByTimeAsync(1500);
    await expect(pacer.run(async () => 'later')).resolves.toBe('later');
  });

  it('sheds an arrival behind a closed gate under maxQueueDepth: 0, sized to the gate', async () => {
    const pacer = createPacer({
      name: 'no-queue-gate',
      maxQueueDepth: 0,
      cooldown: { baseMs: 5000, maxMs: 60_000 },
    });

    await pacer
      .run(async () => {
        throw rateLimit();
      })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1200);

    const error = (await pacer.run(async () => 'never').catch((e: unknown) => e)) as McpError;
    expect(error.data).toEqual({
      reason: 'pacer_shed',
      shedKind: 'queue_full',
      retryAfter: 4,
      queueDepth: 0,
    });
    expect(error.data?.retryAfter).toBe(Math.ceil(pacer.cooldown.remainingMs / 1000));
  });

  // -----------------------------------------------------------------------
  // A dispatch timer that has not fired yet (event-loop lag)
  // -----------------------------------------------------------------------

  /**
   * `vi.setSystemTime` moves the clock without firing timers, which is the state
   * event-loop lag leaves behind: a waiter's slot is open, but the dispatch
   * timer that would start it has not run.
   */
  const labelled = (started: string[]) => (label: string) => async () => {
    started.push(`${label}@${Date.now() - origin}`);
    return label;
  };

  it('starts waiters already due before judging an arrival against maxQueueDepth', async () => {
    const pacer = createPacer({
      name: 'late-gate',
      maxQueueDepth: 2,
      cooldown: { baseMs: 5000, maxMs: 60_000 },
    });
    const started: string[] = [];
    const task = labelled(started);

    await pacer
      .run(async () => {
        throw rateLimit();
      })
      .catch((e: unknown) => e);
    // Both wait on the gate, which reopens at 5s; the queue is now full.
    const queued = [pacer.run(task('b')), pacer.run(task('c'))];
    vi.setSystemTime(origin + 5001);

    // Judged against the stale queue this arrival is shed as queue_full with
    // retryAfter 0 — a slot that is open this instant.
    await expect(pacer.run(task('d'))).resolves.toBe('d');
    await expect(Promise.all(queued)).resolves.toEqual(['b', 'c']);
    expect(started).toEqual(['b@5001', 'c@5001', 'd@5001']);
    expect(addsFor('mcp.pacer.sheds', 'late-gate')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts only the due head before judging an arrival, then queues it behind the rest', async () => {
    const pacer = createPacer({
      name: 'late-window',
      limits: [{ requests: 1, perMs: 1000 }],
      maxQueueDepth: 2,
    });
    const started: string[] = [];
    const task = labelled(started);

    // `a` starts at once; `b` is due at 1s and `c` at 2s, filling the queue.
    const all = [pacer.run(task('a')), pacer.run(task('b')), pacer.run(task('c'))];
    vi.setSystemTime(origin + 1000);

    // `b` is due and leaves the queue; `c` is not, so `d` waits behind it.
    all.push(pacer.run(task('d')));
    expect(started).toEqual(['a@0', 'b@1000']);

    await vi.advanceTimersByTimeAsync(2000);
    await expect(Promise.all(all)).resolves.toEqual(['a', 'b', 'c', 'd']);
    expect(started).toEqual(['a@0', 'b@1000', 'c@2000', 'd@3000']);
    expect(addsFor('mcp.pacer.sheds', 'late-window')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Cooldown gate
  // -----------------------------------------------------------------------

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

  it('keeps doubling to the maxMs clamp for serial callers rate-limited back to back', async () => {
    const pacer = serial({ baseMs: 5000, maxMs: 60_000 });
    const { startedAt, task } = makeRecorder(() => origin);
    const limited = task('limited', async () => {
      throw rateLimit();
    });

    const all = Array.from({ length: 7 }, () => pacer.run(limited).catch((e: unknown) => e));
    await vi.advanceTimersByTimeAsync(400_000);
    await Promise.all(all);

    // Closures of 5, 10, 20, 40, then 60 (80 clamped), 60 (160 clamped): each
    // caller lands as the gate reopens, so the streak never lapses.
    expect(startedAt).toEqual([0, 5000, 15_000, 35_000, 75_000, 135_000, 195_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('neither resets nor advances the streak on a non-RateLimited failure', async () => {
    const pacer = serial({ baseMs: 1000, maxMs: 60_000 });
    const { startedAt, task } = makeRecorder(() => origin);
    const limited = task('limited', async () => {
      throw rateLimit();
    });
    const down = task('down', async () => {
      throw new McpError(JsonRpcErrorCode.ServiceUnavailable, 'upstream down');
    });

    const all = [limited, down, limited, task('probe')].map((fn) =>
      pacer.run(fn).catch((e: unknown) => e),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(all);

    // 429 at 0 → 1s gate; the 503 at 1s leaves the count at 1; the 429 at 1s
    // is the streak's second → 2s → probe at 3s. A reset would start it at 2s,
    // an increment at 5s.
    expect(startedAt).toEqual([0, 1000, 1000, 3000]);
  });

  it('sheds a still-queued entry behind a closed gate with retryAfter covering the gate', async () => {
    const pacer = serial({ baseMs: 5000, maxMs: 60_000 });

    const limited = pacer
      .run(async () => {
        throw rateLimit();
      })
      .catch((e: unknown) => e);
    // Admitted: the gate was still open when it enqueued.
    const queued = pacer.run(async () => 'never', { maxWaitMs: 2000 }).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(0);
    await limited;
    await vi.advanceTimersByTimeAsync(2000);

    const error = (await queued) as McpError;
    expect(error.message).toBe(
      "The caller's wait budget ran out before a cool request slot opened.",
    );
    // The gate reopens at 5s, 3s after the shed.
    expect(error.data).toEqual({
      reason: 'pacer_shed',
      shedKind: 'wait_elapsed',
      retryAfter: 3,
      queueDepth: 0,
    });
    expect(error.data?.retryAfter).toBe(Math.ceil(pacer.cooldown.remainingMs / 1000));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts each upstream rate limit and each shed once, attributed by pacer name', async () => {
    const pacer = createPacer({
      name: 'metered',
      maxConcurrent: 1,
      cooldown: { baseMs: 5000, maxMs: 60_000 },
    });

    await pacer
      .run(async () => {
        throw rateLimit();
      })
      .catch((e: unknown) => e);
    // The closed gate puts the next slot 5s out; this caller waits 1s at most.
    await pacer.run(async () => 'never', { maxWaitMs: 1000 }).catch((e: unknown) => e);

    const attributes = { 'mcp.pacer.name': 'metered' };
    expect(addsFor('mcp.pacer.cooldowns', 'metered')).toEqual([
      { metric: 'mcp.pacer.cooldowns', value: 1, attributes },
    ]);
    expect(addsFor('mcp.pacer.sheds', 'metered')).toEqual([
      { metric: 'mcp.pacer.sheds', value: 1, attributes },
    ]);
  });

  // -----------------------------------------------------------------------
  // pacer.cooldown
  // -----------------------------------------------------------------------

  it("reads the gate and the streak in each caller's rejection handler, and clears both on success", async () => {
    const pacer = serial({ baseMs: 5000, maxMs: 60_000 });
    const seen: unknown[] = [];
    const read = () => {
      seen.push(pacer.cooldown);
    };

    const all = [
      pacer
        .run(async () => {
          throw rateLimit();
        })
        .catch(read),
      pacer
        .run(async () => {
          throw rateLimit();
        })
        .catch(read),
      pacer.run(async () => 'ok').then(read),
    ];
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.all(all);

    expect(seen).toEqual([
      { remainingMs: 5000, consecutive: 1 },
      { remainingMs: 10_000, consecutive: 2 },
      { remainingMs: 0, consecutive: 0 },
    ]);
  });

  it('reads an open gate on an idle pacer and the time left on a closing one', async () => {
    const pacer = serial({ baseMs: 5000, maxMs: 60_000 });
    expect(pacer.cooldown).toEqual({ remainingMs: 0, consecutive: 0 });

    await pacer
      .run(async () => {
        throw rateLimit();
      })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1200);
    expect(pacer.cooldown).toEqual({ remainingMs: 3800, consecutive: 1 });

    // Reopened, but the streak stands until the gate has been open for maxMs.
    await vi.advanceTimersByTimeAsync(3800);
    expect(pacer.cooldown).toEqual({ remainingMs: 0, consecutive: 1 });
  });

  it('reads the cooldown gate only: a window or a concurrency slot holding a waiter reads open', async () => {
    const pacer = createPacer({
      name: 'held',
      limits: [{ requests: 1, perMs: 10_000 }],
      maxConcurrent: 1,
      cooldown: { baseMs: 5000, maxMs: 60_000 },
    });

    // Concurrency-bound: the first holds the only slot, the second waits on it.
    const blocker = pacer.run(holdFor(2000));
    const waiter = pacer.run(async () => 'waiter');
    await vi.advanceTimersByTimeAsync(1000);
    expect(pacer.cooldown).toEqual({ remainingMs: 0, consecutive: 0 });

    // Window-bound: the slot is free at 2s, but the window holds the waiter to 10s.
    await vi.advanceTimersByTimeAsync(1000);
    await expect(blocker).resolves.toBe('held');
    expect(pacer.cooldown).toEqual({ remainingMs: 0, consecutive: 0 });

    await vi.advanceTimersByTimeAsync(8000);
    await expect(waiter).resolves.toBe('waiter');
  });

  it("reads the shared gate, not the caller's own doubling, when rate limits land together", async () => {
    const pacer = createPacer({
      name: 'shared',
      maxConcurrent: 2,
      cooldown: { baseMs: 5000, maxMs: 60_000 },
    });
    let readBySecond: unknown;

    const first = pacer
      .run(async () => {
        throw rateLimit('30');
      })
      .catch((e: unknown) => e);
    const second = pacer
      .run(async () => {
        throw rateLimit();
      })
      .catch(() => {
        readBySecond = pacer.cooldown;
      });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([first, second]);

    // The second's own doubling is 10s; the first's honored Retry-After closed
    // the one gate for 30s.
    expect(readBySecond).toEqual({ remainingMs: 30_000, consecutive: 2 });
  });

  it("hands the task's error through as the same instance, data unchanged, with or without a cooldown", async () => {
    for (const pacer of [serial({ baseMs: 5000, maxMs: 60_000 }), serial()]) {
      const thrown = rateLimit('30');
      const caught = await pacer
        .run(async () => {
          throw thrown;
        })
        .catch((e: unknown) => e);

      expect(caught).toBe(thrown);
      expect((caught as McpError).data).toEqual({ retryAfter: '30' });
    }
  });

  it('stays at zero without a cooldown option, even after a RateLimited throw', async () => {
    const pacer = serial();

    await pacer
      .run(async () => {
        throw rateLimit('30');
      })
      .catch((e: unknown) => e);

    expect(pacer.cooldown).toEqual({ remainingMs: 0, consecutive: 0 });
  });

  // -----------------------------------------------------------------------
  // Streak decay
  // -----------------------------------------------------------------------

  /**
   * Five back-to-back rate limits under `{ baseMs: 5000, maxMs: 60_000 }`:
   * closures of 5, 10, 20, 40, and 60s leave the gate reopening at t=135s, with
   * the clock advanced to that instant.
   */
  async function streakOfFive(pacer: Pacer): Promise<void> {
    const all = Array.from({ length: 5 }, () =>
      pacer
        .run(async () => {
          throw rateLimit();
        })
        .catch((e: unknown) => e),
    );
    await vi.advanceTimersByTimeAsync(135_000);
    await Promise.all(all);
    expect(pacer.cooldown).toEqual({ remainingMs: 0, consecutive: 5 });
  }

  it('restarts the streak at 1 for a rate limit once the gate has stood open for maxMs', async () => {
    const pacer = serial({ baseMs: 5000, maxMs: 60_000 });
    const { startedAt, task } = makeRecorder(() => origin);
    const limited = task('limited', async () => {
      throw rateLimit();
    });

    await streakOfFive(pacer);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pacer.cooldown).toEqual({ remainingMs: 0, consecutive: 0 });

    // A fresh streak: 5s, then doubling from there to 10s.
    const readings: unknown[] = [];
    const all = [
      pacer.run(limited).catch(() => readings.push(pacer.cooldown)),
      pacer.run(limited).catch(() => readings.push(pacer.cooldown)),
      pacer.run(task('probe')),
    ];
    await vi.advanceTimersByTimeAsync(15_000);

    expect(startedAt).toEqual([195_000, 200_000, 210_000]);
    expect(readings).toEqual([
      { remainingMs: 5000, consecutive: 1 },
      { remainingMs: 10_000, consecutive: 2 },
    ]);
    await Promise.all(all);
  });

  it('keeps the streak for a rate limit 1 ms short of the gate standing open for maxMs', async () => {
    const pacer = serial({ baseMs: 5000, maxMs: 60_000 });
    const { startedAt, task } = makeRecorder(() => origin);

    await streakOfFive(pacer);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(pacer.cooldown).toEqual({ remainingMs: 0, consecutive: 5 });

    let reading: unknown;
    const limited = pacer
      .run(async () => {
        throw rateLimit();
      })
      .catch(() => {
        reading = pacer.cooldown;
      });
    const probe = pacer.run(task('probe'));
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all([limited, probe]);

    expect(reading).toEqual({ remainingMs: 60_000, consecutive: 6 });
    expect(startedAt).toEqual([254_999]);
  });

  it('keeps pacing after a streak past 2^1024 with baseMs: 0', async () => {
    // Honor Retry-After only: each rate limit closes a 0 ms gate, which never
    // stands open for maxMs, so continuous demand carries the streak on.
    const pacer = createPacer({
      name: 'honor-only',
      maxConcurrent: 1,
      limits: [{ requests: 1, perMs: 100 }],
      cooldown: { baseMs: 0, maxMs: 60_000 },
    });

    const streak = Array.from({ length: 1030 }, () =>
      pacer
        .run(async () => {
          throw rateLimit();
        })
        .catch((e: unknown) => e),
    );
    await vi.advanceTimersByTimeAsync(1030 * 100);
    await Promise.all(streak);
    const afterStreak = pacer.cooldown;

    const base = Date.now();
    const startedAt: number[] = [];
    const burst = Array.from({ length: 5 }, () =>
      pacer.run(async () => {
        startedAt.push(Date.now() - base);
      }),
    );
    await vi.advanceTimersByTimeAsync(400);

    // The window still spaces the burst.
    expect(startedAt).toEqual([0, 100, 200, 300, 400]);
    expect(afterStreak).toEqual({ remainingMs: 0, consecutive: 1030 });
    await Promise.all(burst);
    expect(pacer.cooldown).toEqual({ remainingMs: 0, consecutive: 0 });
  });

  it('clamps baseMs > 0 at maxMs however long the streak runs', async () => {
    const pacer = serial({ baseMs: 1, maxMs: 100 });
    const { startedAt, task } = makeRecorder(() => origin);
    const limited = task('limited', async () => {
      throw rateLimit();
    });

    let last: unknown;
    const streak = Array.from({ length: 1030 }, (_, i) =>
      pacer.run(limited).catch(() => {
        if (i === 1029) last = pacer.cooldown;
      }),
    );
    const probe = pacer.run(task('probe'));
    await vi.advanceTimersByTimeAsync(110_000);
    await Promise.all([...streak, probe]);

    const gaps = startedAt.slice(1).map((at, i) => at - (startedAt[i] as number));
    // 1, 2, 4 … 64, then clamped at 100 for every remaining rate limit — past
    // exponent 52 and past 2^1024 alike.
    expect(gaps.slice(0, 7)).toEqual([1, 2, 4, 8, 16, 32, 64]);
    expect(gaps.slice(7)).toEqual(Array.from({ length: 1023 }, () => 100));
    expect(last).toEqual({ remainingMs: 100, consecutive: 1030 });
  });

  // -----------------------------------------------------------------------
  // Nested pacers
  // -----------------------------------------------------------------------

  it("passes a nested pacer's shed through the outer one untouched: no gate, no streak, no count", async () => {
    const outer = createPacer({
      name: 'outer',
      maxConcurrent: 1,
      cooldown: { baseMs: 5000, maxMs: 60_000 },
    });
    const inner = createPacer({ name: 'inner', maxConcurrent: 1 });
    const { startedAt, task } = makeRecorder(() => origin);

    const hold = inner.run(holdFor(1000));
    let innerError: unknown;
    const first = outer
      .run(async () => {
        try {
          return await inner.run(async () => 'never', { maxWaitMs: 100 });
        } catch (error) {
          innerError = error;
          throw error;
        }
      })
      .catch((e: unknown) => e);
    const next = outer.run(task('next'));

    await vi.advanceTimersByTimeAsync(100);
    const error = await first;
    expect(error).toBe(innerError);
    expect((error as McpError).data).toEqual({
      reason: 'pacer_shed',
      shedKind: 'wait_elapsed',
      retryAfter: 1,
      queueDepth: 0,
    });
    // `next` starts as the shed settles, not 5s later.
    expect(startedAt).toEqual([100]);
    expect(outer.cooldown).toEqual({ remainingMs: 0, consecutive: 0 });
    expect(addsFor('mcp.pacer.cooldowns', 'outer')).toEqual([]);

    await vi.advanceTimersByTimeAsync(900);
    await expect(Promise.all([next, hold])).resolves.toEqual(['next', 'held']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes no outer gate for any shed kind from a nested pacer', async () => {
    const innerSheds = {
      queue_full: () => {
        const inner = createPacer({ name: 'inner-full', maxConcurrent: 1, maxQueueDepth: 0 });
        void inner.run(holdFor(1000)).catch(() => {});
        return inner.run(async () => 'never');
      },
      wait_projected: () => {
        const inner = createPacer({
          name: 'inner-window',
          limits: [{ requests: 1, perMs: 10_000 }],
        });
        void inner.run(async () => 'first').catch(() => {});
        return inner.run(async () => 'never', { maxWaitMs: 100 });
      },
      wait_elapsed: () => {
        const inner = createPacer({ name: 'inner-conc', maxConcurrent: 1 });
        void inner.run(holdFor(1000)).catch(() => {});
        return inner.run(async () => 'never', { maxWaitMs: 100 });
      },
    };

    for (const [kind, innerShed] of Object.entries(innerSheds)) {
      const name = `outer-${kind}`;
      const outer = createPacer({
        name,
        maxConcurrent: 1,
        cooldown: { baseMs: 5000, maxMs: 60_000 },
      });

      const error = outer.run(innerShed).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(100);

      expect(((await error) as McpError).data?.shedKind).toBe(kind);
      expect(outer.cooldown).toEqual({ remainingMs: 0, consecutive: 0 });
      expect(addsFor('mcp.pacer.cooldowns', name)).toEqual([]);
    }
  });

  it('still closes both gates when an upstream rate limit propagates out of a nested pacer', async () => {
    const cooldown = { baseMs: 5000, maxMs: 60_000 };
    const outer = createPacer({ name: 'outer-upstream', maxConcurrent: 1, cooldown });
    const inner = createPacer({ name: 'inner-upstream', maxConcurrent: 1, cooldown });
    const thrown = rateLimit();

    const error = await outer
      .run(() =>
        inner.run(async () => {
          throw thrown;
        }),
      )
      .catch((e: unknown) => e);

    expect(error).toBe(thrown);
    expect(inner.cooldown).toEqual({ remainingMs: 5000, consecutive: 1 });
    expect(outer.cooldown).toEqual({ remainingMs: 5000, consecutive: 1 });
    expect(addsFor('mcp.pacer.cooldowns', 'outer-upstream')).toHaveLength(1);
    expect(addsFor('mcp.pacer.cooldowns', 'inner-upstream')).toHaveLength(1);
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

  it('fails fast out of withRetry on every shed kind', async () => {
    type Run = (task: () => Promise<string>, signal: AbortSignal) => Promise<string>;
    /** Each builds a pacer already holding its slot, and the call it will shed. */
    const setups: Record<string, () => Run> = {
      queue_full: () => {
        const pacer = createPacer({ name: 'retry-full', maxConcurrent: 1, maxQueueDepth: 0 });
        void pacer.run(holdFor(10_000)).catch(() => {});
        return (task, signal) => pacer.run(task, { signal });
      },
      wait_projected: () => {
        const pacer = createPacer({
          name: 'retry-window',
          limits: [{ requests: 1, perMs: 10_000 }],
        });
        void pacer.run(async () => 'first').catch(() => {});
        return (task, signal) => pacer.run(task, { signal, maxWaitMs: 100 });
      },
      wait_elapsed: () => {
        const pacer = createPacer({ name: 'retry-conc', maxConcurrent: 1 });
        void pacer.run(holdFor(10_000)).catch(() => {});
        return (task, signal) => pacer.run(task, { signal, maxWaitMs: 100 });
      },
    };

    for (const [kind, setup] of Object.entries(setups)) {
      const run = setup();
      const task = vi.fn(async () => 'never');
      const attempt = vi.fn(({ signal }: { signal: AbortSignal }) => run(task, signal));

      const promise = withRetry(attempt, {
        baseDelayMs: 10,
        jitter: 0,
        maxRetries: 3,
        operation: 'paced',
      }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(100);
      const error = (await promise) as McpError;

      expect(error.data?.shedKind).toBe(kind);
      expect(defaultIsTransient(error)).toBe(false);
      expect(attempt).toHaveBeenCalledTimes(1);
      expect(task).not.toHaveBeenCalled();
    }
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

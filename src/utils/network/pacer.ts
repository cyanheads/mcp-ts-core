/**
 * @fileoverview Outbound request pacer — a FIFO queue in front of a rate-limited
 * upstream. Holds work back until every configured window, the minimum start gap,
 * and the concurrency cap allow it; sheds callers the queue cannot hold or whose
 * wait budget cannot be met; and closes a shared cooldown gate when the upstream
 * answers 429.
 *
 * The inbound `RateLimiter` (`utils/security`) is the mirror image: it is keyed
 * per caller and rejects synchronously, so it cannot queue work against an
 * upstream budget.
 * @module src/utils/network/pacer
 */
import {
  JsonRpcErrorCode,
  McpError,
  rateLimited,
  requestCancelled,
} from '@/types-global/errors.js';
import { parseRetryAfterMs } from '@/utils/network/retry.js';
import { ATTR_MCP_PACER_NAME } from '@/utils/telemetry/attributes.js';
import { createCounter, createHistogram, createUpDownCounter } from '@/utils/telemetry/metrics.js';

/**
 * One sliding start-rate window, e.g. `{ requests: 5, perMs: 60_000 }` for five
 * requests a minute. Several may be declared together (per-minute and per-hour);
 * a start needs every one of them to allow it.
 */
export interface PacerLimit {
  /** Width of the sliding window in milliseconds. */
  perMs: number;
  /** Starts permitted within the window. */
  requests: number;
}

/** Back-off applied to the shared gate when the upstream answers with a rate limit. */
export interface PacerCooldownOptions {
  /** First cooldown, doubled on each consecutive rate limit. */
  baseMs: number;
  /**
   * Ceiling for both the doubling and an honored `Retry-After`, so a pathological
   * upstream value cannot park the queue. Also the streak's lifetime: once the
   * gate has stood open this long, the next rate limit starts over at `baseMs`.
   */
  maxMs: number;
}

/** The shared cooldown gate as {@link Pacer.cooldown} samples it. */
export interface PacerCooldownState {
  /**
   * Rate limits in the current streak — the count the next one doubles from.
   * 0 after a success, and from the instant the gate has stood open for
   * `cooldown.maxMs`.
   */
  consecutive: number;
  /** Milliseconds until the shared gate reopens; 0 while it is open. */
  remainingMs: number;
}

/**
 * Why {@link Pacer.run} shed a call, carried as `data.shedKind`:
 * - `queue_full` — the call could not start at once and `maxQueueDepth`
 *   callers were already waiting.
 * - `wait_projected` — at enqueue, the projected wait already exceeded `maxWaitMs`.
 * - `wait_elapsed` — `maxWaitMs` ran out while the call was queued.
 */
export type PacerShedKind = 'queue_full' | 'wait_elapsed' | 'wait_projected';

/** Configuration for {@link createPacer}. */
export interface PacerOptions {
  /** Shared 429 gate. Omitted, an upstream rate limit paces nothing by itself. */
  cooldown?: PacerCooldownOptions;
  /** Sliding start-rate windows. Every entry must allow a start. */
  limits?: PacerLimit[];
  /** In-flight ceiling. Unset, only the windows and the start gap bind. */
  maxConcurrent?: number;
  /**
   * Absolute backpressure on queue length, for callers that pass no
   * `maxWaitMs`. It bounds waiters only: an arrival whose slot is open that
   * instant starts without joining the queue, so `0` means "run when a slot is
   * free, never wait". An arrival that would wait behind this many is shed at
   * once.
   */
  maxQueueDepth?: number;
  /**
   * Minimum spacing between consecutive starts. Not expressible through
   * {@link PacerOptions.limits} once a window admits more than one request:
   * `{ requests: 10, perMs: 1000 }` permits ten starts in the same millisecond,
   * which is exactly the burst the SEC and NCBI clients space out by hand.
   */
  minStartGapMs?: number;
  /**
   * Author-set label for telemetry attribution. Bounded and never
   * caller-supplied — a metric attribute set lives until process restart.
   */
  name: string;
}

/** Per-call options for {@link Pacer.run}. */
export interface PacerRunOptions {
  /**
   * Ceiling on queue time — not on the task, which bounds itself. Enqueue
   * rejects when the projected wait already exceeds it, and a still-queued entry
   * rejects when it elapses, unless its slot opens that same instant.
   */
  maxWaitMs?: number;
  /**
   * Caller cancellation. While queued, an abort removes the entry and rejects
   * with `signal.reason`; once dispatched the signal is the task's own to honor,
   * and it is what {@link Pacer.run} hands the task.
   */
  signal?: AbortSignal;
}

/** A queue in front of one upstream. Process-local; timers and `AbortSignal` only. */
export interface Pacer extends Disposable {
  /**
   * The shared cooldown gate, sampled when read. `remainingMs` is the gate every
   * queued caller waits on, not the wait one rate limit computed — rate limits
   * that land together close one gate at the later of their instants — so read
   * in a task's rejection handler it is the wait a client can act on. Both fields
   * stay 0 without a `cooldown` option. The pacer never writes to a task's error.
   */
  readonly cooldown: PacerCooldownState;
  /**
   * Clears the dispatch timer and rejects every queued waiter with
   * `RequestCancelled`. In-flight tasks are left to finish. Idempotent; wire it
   * through `createApp({ teardown })`.
   */
  dispose(): void;
  /**
   * Queues `task` and runs it once a slot opens, handing it the caller's signal.
   *
   * @throws {McpError} `RateLimited` with `data: { reason: 'pacer_shed',
   *   shedKind, retryAfter, queueDepth }` when the call must wait behind a full
   *   queue, its projected wait exceeds `maxWaitMs`, or `maxWaitMs` runs out
   *   while it is queued — see {@link PacerShedKind}.
   */
  run<T>(task: (signal: AbortSignal) => Promise<T>, options?: PacerRunOptions): Promise<T>;
}

/** A waiter holding its place in line. */
interface QueueEntry {
  /** Runs the task and settles the caller's promise. */
  dispatch: (startedAt: number) => void;
  enqueuedAt: number;
  onAbort?: (() => void) | undefined;
  reject: (reason: unknown) => void;
  shedTimer?: ReturnType<typeof setTimeout> | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * The caller-facing message for each shed kind. A `queue_full` shed names the
 * full queue, not a wait budget the caller may never have set.
 */
const shedMessages: Record<PacerShedKind, (name: string) => string> = {
  queue_full: (name) => `No ${name} request slot is open and the wait queue is full.`,
  wait_elapsed: (name) => `The caller's wait budget ran out before a ${name} request slot opened.`,
  wait_projected: (name) => `No ${name} request slot available within the caller's wait budget.`,
};

let instruments:
  | {
      cooldowns: ReturnType<typeof createCounter>;
      queueDepth: ReturnType<typeof createUpDownCounter>;
      sheds: ReturnType<typeof createCounter>;
      wait: ReturnType<typeof createHistogram>;
    }
  | undefined;

/**
 * The four pacer instruments, shared across every pacer in the process and told
 * apart by `mcp.pacer.name`. Lazy: a server that never queues emits no series.
 */
function getPacerMetrics() {
  instruments ??= {
    cooldowns: createCounter(
      'mcp.pacer.cooldowns',
      'Cooldown gates closed by an upstream rate limit',
      '{cooldowns}',
    ),
    queueDepth: createUpDownCounter(
      'mcp.pacer.queue_depth',
      'Requests waiting for a pacer slot',
      '{requests}',
    ),
    sheds: createCounter(
      'mcp.pacer.sheds',
      'Requests shed before dispatch: the wait queue was full, or no slot fit the wait budget',
      '{requests}',
    ),
    wait: createHistogram('mcp.pacer.wait', 'Time a request spent waiting for a pacer slot', 'ms'),
  };
  return instruments;
}

/**
 * Creates a FIFO pacer for one upstream.
 *
 * A slot is granted when every {@link PacerOptions.limits} window,
 * {@link PacerOptions.minStartGapMs}, {@link PacerOptions.maxConcurrent}, and the
 * cooldown gate allow it. Each window is a sliding view over recorded *start*
 * times, so a slow response never widens the rate the upstream sees.
 *
 * **Composition with `withRetry`.** Retry outside, pacer inside —
 * `withRetry(({ signal }) => pacer.run(fn, { signal }), { signal, deadlineMs })` —
 * so each attempt re-queues and is re-paced. The cooldown gate is an absolute
 * instant rather than a duration counted from dequeue, so `withRetry`'s
 * `Retry-After` sleep and the gate overlap in wall-clock instead of summing: the
 * caller waits the window the upstream named once, not twice. Pass the retry
 * deadline's signal into `run` and the queue wait is charged to the same budget.
 *
 * **Runtime.** Process-local, so on Workers the limits bind per isolate, OTel is
 * off and the metrics are inert, and `createWorkerHandler` accepts no `teardown`
 * to call {@link Pacer.dispose} from.
 *
 * @example
 * ```ts
 * const pacer = createPacer({
 *   name: 'courtlistener',
 *   limits: [{ requests: 5, perMs: 60_000 }, { requests: 50, perMs: 3_600_000 }],
 *   minStartGapMs: 100,
 *   maxConcurrent: 2,
 *   maxQueueDepth: 100,
 *   cooldown: { baseMs: 5_000, maxMs: 60_000 },
 * });
 *
 * const res = await pacer.run(
 *   (signal) => fetchWithTimeout(url, 30_000, ctx, { signal }),
 *   { signal: ctx.signal, maxWaitMs: 45_000 },
 * );
 * ```
 */
export function createPacer(options: PacerOptions): Pacer {
  const { cooldown, limits = [], maxConcurrent, maxQueueDepth, minStartGapMs = 0, name } = options;

  const attributes = { [ATTR_MCP_PACER_NAME]: name };
  /** Recorded start instants, ascending. Pruned to the longest constraint. */
  const starts: number[] = [];
  const retentionMs = Math.max(minStartGapMs, ...limits.map((limit) => limit.perMs), 0);
  const queue: QueueEntry[] = [];

  let active = 0;
  let consecutiveRateLimits = 0;
  /** Absolute instant the shared gate reopens. */
  let gateOpensAt = 0;
  let dispatchTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  /**
   * The earliest instant a start is permitted given `history`, evaluated at
   * `at`. Exact over the cooldown gate, the start gap, and every window —
   * concurrency is deliberately not modelled here, since a slot frees on an
   * unknowable completion.
   */
  function earliestStart(history: readonly number[], at: number): number {
    let earliest = gateOpensAt;

    const last = history[history.length - 1];
    if (last !== undefined && minStartGapMs > 0) {
      earliest = Math.max(earliest, last + minStartGapMs);
    }

    for (const { requests, perMs } of limits) {
      if (requests <= 0) continue;
      let seen = 0;
      for (let i = history.length - 1; i >= 0; i--) {
        const start = history[i] as number;
        // A start exactly `perMs` old has already left the window.
        if (start <= at - perMs) break;
        seen++;
        if (seen === requests) {
          earliest = Math.max(earliest, start + perMs);
          break;
        }
      }
    }

    return earliest;
  }

  /**
   * When an arrival joining behind `ahead` waiters could start, by replaying the
   * windows forward. Exact while only the windows and the gap bind; a lower
   * bound once `maxConcurrent` does — which is what keeps a shed from ever being
   * a false one.
   */
  function projectedStart(now: number, ahead: number): number {
    const simulated = starts.slice();
    let at = now;
    for (let i = 0; i <= ahead; i++) {
      at = Math.max(at, earliestStart(simulated, at));
      simulated.push(at);
    }
    return at;
  }

  function atCapacity(): boolean {
    return maxConcurrent !== undefined && active >= maxConcurrent;
  }

  /** Whether an arrival at `now` would start at once rather than wait. */
  function canStartNow(now: number): boolean {
    return queue.length === 0 && !atCapacity() && earliestStart(starts, now) <= now;
  }

  /**
   * Rate limits in the current streak, as the next one doubles from them. The
   * streak lapses once the gate has stood open for `cooldown.maxMs` — one full
   * capped cooldown with no rate limit — and is keyed to the gate rather than
   * to the last rate limit, so continuous demand under a sustained limit, every
   * attempt landing as the gate reopens, keeps its capped backoff.
   */
  function streak(now: number): number {
    return cooldown && now - gateOpensAt < cooldown.maxMs ? consecutiveRateLimits : 0;
  }

  /**
   * The shed error, for a caller that enqueued at `enqueuedAt` — `now` when shed
   * on arrival — and has already left the queue. `retryAfter` projects a caller
   * joining behind every remaining waiter. That projection cannot see a
   * concurrency slot freeing, so while `maxConcurrent` is saturated it is floored
   * at the longest wait of any queued caller, the shed one included, and never
   * below 1s: the slots have been held at least that long.
   *
   * `rateLimited` with no `retryable: false`: to the calling agent this is an
   * ordinary rate limit — wait `retryAfter`, call again — and that flag would
   * tell them the opposite. `withRetry`'s default predicate reads `reason`
   * instead, so an enclosing retry fails fast rather than sleeping past the
   * deadline the shed exists to enforce.
   */
  function shed(shedKind: PacerShedKind, enqueuedAt: number): McpError {
    getPacerMetrics().sheds.add(1, attributes);

    const now = Date.now();
    const queueDepth = queue.length;
    let retryAfter = Math.ceil(Math.max(0, projectedStart(now, queueDepth) - now) / 1000);
    if (atCapacity()) {
      const oldest = Math.min(enqueuedAt, queue[0]?.enqueuedAt ?? enqueuedAt);
      retryAfter = Math.max(retryAfter, Math.ceil((now - oldest) / 1000), 1);
    }

    return rateLimited(shedMessages[shedKind](name), {
      reason: 'pacer_shed',
      shedKind,
      retryAfter,
      queueDepth,
    });
  }

  /**
   * Releases an entry that has left the queue: clears its shed timer and abort
   * listener, and settles the depth gauge. Leaving the line and the gauge are
   * the same event, so every exit — dequeued, removed, disposed — goes through
   * here.
   */
  function detach(entry: QueueEntry): void {
    if (entry.shedTimer !== undefined) {
      clearTimeout(entry.shedTimer);
      entry.shedTimer = undefined;
    }
    if (entry.onAbort && entry.signal) {
      entry.signal.removeEventListener('abort', entry.onAbort);
      entry.onAbort = undefined;
    }
    getPacerMetrics().queueDepth.add(-1, attributes);
  }

  /** Removes a waiter and settles the depth gauge. `false` if it already left. */
  function remove(entry: QueueEntry): boolean {
    const index = queue.indexOf(entry);
    if (index === -1) return false;
    queue.splice(index, 1);
    detach(entry);
    return true;
  }

  function clearDispatchTimer(): void {
    if (dispatchTimer === undefined) return;
    clearTimeout(dispatchTimer);
    dispatchTimer = undefined;
  }

  /**
   * Drains as much of the queue as the constraints allow, then either arms the
   * dispatch timer for the next opening or leaves no timer at all. FIFO: only
   * the head is ever considered, so a cheap arrival never overtakes.
   */
  function pump(): void {
    clearDispatchTimer();
    while (queue.length > 0) {
      if (atCapacity()) return;

      const now = Date.now();
      const earliest = earliestStart(starts, now);
      if (earliest > now) {
        dispatchTimer = setTimeout(() => {
          dispatchTimer = undefined;
          pump();
        }, earliest - now);
        (dispatchTimer as { unref?: () => void }).unref?.();
        return;
      }

      const entry = queue.shift();
      if (!entry) return;
      detach(entry);

      starts.push(now);
      while (starts.length > 0 && (starts[0] as number) <= now - retentionMs) starts.shift();

      entry.dispatch(now);
    }
  }

  /**
   * Closes the shared gate on an upstream rate limit:
   * `min(max(baseMs · 2^(consecutive−1), retryAfter), maxMs)`, as an absolute
   * instant. Any other error leaves it open and the count untouched; the first
   * success resets the count, and so does a gate left open for `maxMs`.
   *
   * A shed (`data.reason: 'pacer_shed'`) is excluded: raised by a pacer nested
   * inside this task, it is local backpressure, and no upstream answered.
   */
  function noteRateLimit(error: unknown): void {
    if (!cooldown) return;
    if (!(error instanceof McpError) || error.code !== JsonRpcErrorCode.RateLimited) return;
    if (error.data?.reason === 'pacer_shed') return;

    const now = Date.now();
    consecutiveRateLimits = streak(now) + 1;
    // The exponent is bounded so the product stays finite: past 2^1024 it is
    // Infinity, and `baseMs: 0` would make it `0 · Infinity` — NaN, which sticks
    // in `gateOpensAt` and stops every window and gap from binding. A positive
    // `baseMs · 2^52` still exceeds any practical `maxMs`, so it clamps as before.
    const doubled = cooldown.baseMs * 2 ** Math.min(consecutiveRateLimits - 1, 52);
    // An absent or unparseable hint contributes nothing, leaving the doubling.
    const honored = parseRetryAfterMs(error) ?? 0;
    const waitMs = Math.min(Math.max(doubled, honored), cooldown.maxMs);

    gateOpensAt = Math.max(gateOpensAt, now + waitMs);
    getPacerMetrics().cooldowns.add(1, attributes);
  }

  function run<T>(
    task: (signal: AbortSignal) => Promise<T>,
    runOptions: PacerRunOptions = {},
  ): Promise<T> {
    const { maxWaitMs, signal } = runOptions;

    if (disposed) {
      return Promise.reject(requestCancelled(`The ${name} pacer has been disposed.`));
    }
    if (signal?.aborted) return Promise.reject(signal.reason);

    // Start whoever is already due before judging this arrival: a dispatch
    // timer running late (event-loop lag) leaves a waiter whose slot is open
    // counted against `maxQueueDepth`, and would shed this call with a
    // `retryAfter` of 0.
    pump();
    const now = Date.now();

    // Absolute backpressure first, so it rejects without arming a timer. It
    // bounds waiters, so an arrival that can start this instant never counts.
    if (maxQueueDepth !== undefined && queue.length >= maxQueueDepth && !canStartNow(now)) {
      return Promise.reject(shed('queue_full', now));
    }
    if (maxWaitMs !== undefined && projectedStart(now, queue.length) - now > maxWaitMs) {
      return Promise.reject(shed('wait_projected', now));
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        enqueuedAt: now,
        reject,
        signal,
        dispatch: (startedAt) => {
          active++;
          getPacerMetrics().wait.record(startedAt - entry.enqueuedAt, attributes);
          // Called inside an async wrapper so a task that throws before returning
          // a promise rejects its own caller instead of escaping into `pump()`.
          void (async () => task(signal ?? new AbortController().signal))().then(
            (value) => {
              consecutiveRateLimits = 0;
              resolve(value);
              active--;
              pump();
            },
            (error: unknown) => {
              noteRateLimit(error);
              reject(error);
              active--;
              pump();
            },
          );
        },
      };

      if (maxWaitMs !== undefined) {
        entry.shedTimer = setTimeout(() => {
          entry.shedTimer = undefined;
          // This can fire ahead of a dispatch timer due the same instant, so
          // drain what is due first: a slot opening as the budget ends
          // dispatches the entry rather than shedding it.
          pump();
          if (!remove(entry)) return;
          reject(shed('wait_elapsed', entry.enqueuedAt));
          // The shed entry is gone; whoever is behind it should not wait on it.
          pump();
        }, maxWaitMs);
        (entry.shedTimer as { unref?: () => void }).unref?.();
      }

      if (signal) {
        entry.onAbort = () => {
          if (!remove(entry)) return;
          reject(signal.reason);
          pump();
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }

      queue.push(entry);
      getPacerMetrics().queueDepth.add(1, attributes);
      pump();
    });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clearDispatchTimer();
    for (const entry of queue.splice(0, queue.length)) {
      detach(entry);
      entry.reject(requestCancelled(`The ${name} pacer has been disposed.`));
    }
  }

  return {
    get cooldown(): PacerCooldownState {
      const now = Date.now();
      return { remainingMs: Math.max(0, gateOpensAt - now), consecutive: streak(now) };
    },
    dispose,
    run,
    [Symbol.dispose]: dispose,
  };
}

/**
 * @fileoverview Retry utility with exponential backoff for wrapping operations that
 * may fail transiently. Designed so the retry boundary covers the full pipeline
 * (HTTP fetch + response parsing/validation), not just the network call.
 * @module src/utils/network/retry
 */
import { JsonRpcErrorCode, McpError, timeout } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

/**
 * Error codes considered transient — eligible for retry.
 * Matches the framework's error classification in `mappings.ts`.
 */
const TRANSIENT_CODES = new Set<JsonRpcErrorCode>([
  JsonRpcErrorCode.ServiceUnavailable,
  JsonRpcErrorCode.Timeout,
  JsonRpcErrorCode.RateLimited,
]);

/**
 * The per-attempt handle {@link withRetry} passes to its operation.
 *
 * Both fields describe the *total* budget, not this attempt's: they exist so an
 * attempt can bound its own I/O against what is left, which is what keeps the
 * deadline from overshooting by one in-flight request.
 */
export interface RetryAttempt {
  /**
   * Milliseconds left on {@link RetryOptions.deadlineMs} as this attempt starts.
   * Never negative, and `Number.POSITIVE_INFINITY` when no deadline is set — so
   * `Math.min(perAttemptMs, remainingMs)` is correct either way.
   */
  readonly remainingMs: number;
  /**
   * `AbortSignal.any` over the deadline clock and {@link RetryOptions.signal}.
   * Thread it into the attempt's fetch: a deadline that only fires *between*
   * attempts cannot stop one already in flight.
   */
  readonly signal: AbortSignal;
}

/** Configuration for {@link withRetry}. */
export interface RetryOptions {
  /**
   * Base delay in milliseconds before the first retry.
   * Subsequent delays are `baseDelayMs * 2^attempt`. Default: `1000`.
   *
   * Calibrate to the upstream's recovery time:
   * - 200–500ms for ephemeral failures (connection pool)
   * - 1–2s for rate-limited APIs
   * - 2–5s for service degradation / outages
   */
  baseDelayMs?: number;

  /**
   * Log bindings for correlated logging. When provided, retry log entries
   * include `requestId`, `traceId`, etc. Passing the handler `Context` is
   * safe — the logger strips non-serializable fields (`signal`, `log`,
   * `state`, protocol method handles) before pino sees them.
   */
  context?: RequestContext;

  /**
   * Total wall-clock budget in milliseconds covering every attempt, every
   * backoff, and any honored `Retry-After` — the bound `maxRetries` and a
   * per-attempt timeout cannot express between them. Four 30s attempts plus
   * backoff outlast a client's 60s request timeout, so the caller gets a
   * transport timeout instead of this server's classified error.
   *
   * The clock is an `AbortController` + `setTimeout`, composed into
   * {@link RetryAttempt.signal}; pass that signal into the attempt's I/O or the
   * deadline overshoots by one in-flight request. Expiry rejects with a
   * `Timeout` `McpError` carrying
   * `data: { reason: 'retry_deadline_exceeded', deadlineMs, elapsedMs, retryAttempts }`
   * and the last attempt's error as `cause`.
   *
   * Unset (the default) leaves attempt counts, delays, logging, and the
   * exhausted-error shape exactly as they are.
   */
  deadlineMs?: number;

  /**
   * Custom predicate to determine if an error is transient and should be
   * retried. When provided, this **replaces** the default predicate entirely
   * (including the `data.retryable === false` opt-out). Return `true` to
   * retry, `false` to fail immediately.
   *
   * Use this only when you need fully custom classification logic. For the
   * common case of opting a single throw site out of retry, set
   * `data.retryable: false` on the thrown `McpError` instead — the default
   * predicate handles it automatically.
   */
  isTransient?: (error: unknown) => boolean;

  /**
   * Jitter factor applied to each delay. `0` = no jitter, `1` = full jitter
   * (delay randomized between 0 and calculated delay). Default: `0.25`.
   */
  jitter?: number;

  /**
   * Maximum delay cap in milliseconds. Prevents unbounded growth on high
   * retry counts. Default: `30000` (30s).
   *
   * Also the ceiling for an honored upstream `Retry-After`: when the error
   * carries `data.retryAfter` and the requested wait exceeds this cap, the
   * error is treated as non-transient and fails fast (see {@link withRetry}).
   */
  maxDelayMs?: number;
  /**
   * Maximum number of retry attempts after the initial call.
   * Total attempts = `maxRetries + 1`. Default: `3`.
   */
  maxRetries?: number;

  /**
   * Operation name for structured log messages. Used in log context and
   * enriched error messages on exhaustion.
   */
  operation?: string;

  /**
   * Optional AbortSignal. When aborted, the retry loop exits immediately
   * without further attempts, rethrowing unchanged — this is the caller-abort
   * passthrough and it outranks a {@link deadlineMs} expiry, so a cancelled
   * request is never relabelled as one that ran out of budget. Also composed
   * into {@link RetryAttempt.signal}.
   */
  signal?: AbortSignal;
}

/**
 * Computes the backoff delay for a given attempt with optional jitter.
 *
 * @param attempt - Zero-based attempt index (0 = first retry).
 * @param baseDelayMs - Base delay in milliseconds.
 * @param maxDelayMs - Maximum delay cap.
 * @param jitter - Jitter factor (0–1).
 * @returns Delay in milliseconds.
 */
function computeDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: number,
): number {
  const exponential = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  if (jitter <= 0) return exponential;
  const jitterRange = exponential * jitter;
  return exponential - jitterRange + Math.random() * jitterRange * 2;
}

/**
 * Parses an upstream `Retry-After` hint into milliseconds. The two HTTP helpers
 * (`fetchWithTimeout`, `httpErrorFromResponse`) capture the raw header value into
 * `error.data.retryAfter`; this reads it back so the retry delay can honor the
 * wait the upstream explicitly asked for instead of blind exponential backoff.
 *
 * Handles both RFC 9110 §10.2.3 forms:
 * - **delta-seconds** — a bare non-negative integer (`"30"` → `30_000`).
 * - **HTTP-date** — an absolute instant, converted to a wait from now and
 *   clamped at `0` (a past date means "retry now").
 *
 * A numeric `data.retryAfter` is also accepted and interpreted as delta-seconds,
 * matching the header's units. Returns `undefined` when the error carries no
 * parseable hint, so callers fall back to exponential backoff.
 *
 * Module-level, not public: the pacer's cooldown gate reads the same hint off
 * the same errors, and a second copy of the RFC 9110 forms would drift.
 */
export function parseRetryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof McpError)) return;
  const raw = error.data?.retryAfter;

  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? raw * 1000 : undefined;
  }
  if (typeof raw !== 'string') return;

  const trimmed = raw.trim();
  if (trimmed === '') return;

  // delta-seconds: a bare non-negative integer. Checked before Date.parse so a
  // value like "120" is never misread as a calendar year.
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;

  // HTTP-date: absolute instant → wait from now, clamped at 0.
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return;
  return Math.max(0, dateMs - Date.now());
}

/**
 * Default transient check: `McpError` with a transient code, or any non-McpError
 * (network failures, unexpected throws) which are assumed transient.
 *
 * **Per-error opt-out.** When a thrown `McpError` carries `data.retryable === false`,
 * the error is treated as non-transient and fails fast — even if its code is in
 * `TRANSIENT_CODES`. This is the in-band escape hatch for deterministic upstream
 * failures (e.g. a query too expensive to ever succeed surfaced as HTTP 200 +
 * error body) that arrive with a transient code but should never be retried.
 *
 * Absent the flag (or when it is `true`), behavior is unchanged — code-based
 * classification applies. Non-`McpError` throws (raw network errors, unexpected
 * throws) are always assumed transient regardless of the flag.
 *
 * **Composing rather than replacing.** {@link RetryOptions.isTransient} replaces
 * this predicate outright, so a caller that wants "the framework default, except
 * this one error" composes off this export instead of mirroring the transient
 * code set — a copy drifts silently when the framework's classification changes:
 *
 * ```ts
 * withRetry(fn, {
 *   isTransient: (error) =>
 *     !(error instanceof McpError && error.data?.reason === 'budget_exhausted') &&
 *     defaultIsTransient(error),
 * });
 * ```
 *
 * The inverse — treating one more shape as transient — composes the same way:
 * `defaultIsTransient(error) || isMyRetryableShape(error)`.
 */
export function defaultIsTransient(error: unknown): boolean {
  if (error instanceof McpError) {
    // Explicit opt-out wins over code-based classification.
    if (error.data?.retryable === false) return false;
    /**
     * A pacer shed is a `RateLimited` the *caller* should honor and this loop
     * should not: sleeping its `retryAfter` would burn the very deadline the
     * shed exists to enforce. It carries no `data.retryable: false`, because to
     * the calling agent a shed is an ordinary rate limit — wait, then call
     * again — and that flag on the wire would say the opposite.
     */
    if (error.data?.reason === 'pacer_shed') return false;
    return TRANSIENT_CODES.has(error.code);
  }
  // Non-McpError (raw network errors, unexpected throws) — assume transient
  return true;
}

/** The wall-clock budget {@link RetryOptions.deadlineMs} arms for one ladder. */
interface DeadlineClock {
  /** The one error an expiry surfaces, whatever shape it took on the way in. */
  exceeded(cause: unknown, retryAttempts: number): McpError;
  /** `true` once this clock's own timer fired — matched by reason identity. */
  expired(): boolean;
  /** Milliseconds left, never negative. */
  remainingMs(): number;
  /** Aborts when the budget runs out; composed into {@link RetryAttempt.signal}. */
  readonly signal: AbortSignal;
  /** Stops the timer. Nothing outlives the call. */
  stop(): void;
}

/**
 * Arms the total-deadline clock.
 *
 * `AbortController` + `setTimeout`, never `AbortSignal.timeout()` — which can
 * fail in Bun's stdio transport on a realm mismatch, the same reason
 * `fetchWithTimeout` avoids it. The reason instance is held so expiry is matched
 * by identity: a caller signal aborting with its own `TimeoutError` stays a
 * caller abort.
 *
 * `withRetry` cannot tell the three clocks apart from a caught error alone — a
 * deadline abort reaching `fetchWithTimeout` on its external signal arrives as
 * `RequestCancelled`, and one landing mid-backoff arrives as the raw abort
 * reason — so both normalize through {@link DeadlineClock.exceeded} and the
 * caller matches one shape.
 *
 * The expiry carries no `retryable` flag: a narrower call can still succeed, and
 * that flag is {@link defaultIsTransient}'s in-band opt-out rather than a
 * statement to the caller. No `attempt` index either — `data.retryAttempts`
 * already carries it.
 */
function createDeadlineClock(deadlineMs: number, operation?: string): DeadlineClock {
  const label = operation ?? 'operation';
  const controller = new AbortController();
  const reason = new DOMException(
    `${label} exceeded its ${deadlineMs}ms retry deadline.`,
    'TimeoutError',
  );
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(reason), deadlineMs);

  return {
    signal: controller.signal,
    expired: () => controller.signal.reason === reason,
    remainingMs: () => Math.max(0, deadlineMs - (Date.now() - startedAt)),
    stop: () => clearTimeout(timer),
    exceeded: (cause, retryAttempts) =>
      timeout(
        `${label} exceeded its ${deadlineMs}ms retry deadline after ${retryAttempts} attempt${retryAttempts > 1 ? 's' : ''}.`,
        {
          reason: 'retry_deadline_exceeded',
          deadlineMs,
          elapsedMs: Date.now() - startedAt,
          retryAttempts,
        },
        { cause },
      ),
  };
}

/**
 * Enriches an error with retry exhaustion context.
 * Appends attempt count to the message and to `data` for programmatic access.
 */
function enrichExhaustedError(error: unknown, totalAttempts: number, operation?: string): unknown {
  if (error instanceof McpError) {
    const suffix = `(failed after ${totalAttempts} attempt${totalAttempts > 1 ? 's' : ''})`;
    const enrichedMessage = error.message ? `${error.message} ${suffix}` : suffix;
    const enrichedData: Record<string, unknown> = {
      ...error.data,
      retryAttempts: totalAttempts,
      ...(operation ? { operation } : {}),
    };
    return new McpError(error.code, enrichedMessage, enrichedData, { cause: error });
  }

  if (error instanceof Error) {
    const suffix = `(failed after ${totalAttempts} attempt${totalAttempts > 1 ? 's' : ''})`;
    const wrapped = new Error(`${error.message} ${suffix}`, { cause: error });
    wrapped.name = error.name;
    return wrapped;
  }

  return error;
}

/**
 * Executes `fn` with retry logic and exponential backoff.
 *
 * The retry boundary should wrap the **full pipeline** — HTTP fetch, response
 * parsing, and validation — not just the network call. This ensures that
 * transient upstream errors (e.g., HTTP 200 with an error body) are retried.
 *
 * **Deterministic-failure opt-out.** When the thrown `McpError` carries
 * `data.retryable === false`, the default predicate treats it as non-transient
 * and fails immediately — even for `Timeout`/`ServiceUnavailable`/`RateLimited`
 * codes. Use this at the throw site (or let the error contract auto-populate it
 * via `ctx.fail`) for failures that can never succeed on retry (oversized query,
 * malformed request surfaced as HTTP 200 + error body, etc.).
 *
 * **Retry-After honoring.** When a transient error carries `data.retryAfter`
 * (captured by `fetchWithTimeout` / `httpErrorFromResponse` from the upstream
 * header), the retry delay honors it — parsing both delta-seconds and HTTP-date
 * forms (RFC 9110 §10.2.3) — instead of the exponential value. If the requested
 * wait exceeds `maxDelayMs`, the error is treated as non-transient and fails
 * fast: a window that won't clear within the retry budget is surfaced to the
 * caller immediately rather than burning attempts that cannot succeed.
 *
 * **Total deadline.** `deadlineMs` bounds the whole ladder — every attempt, every
 * backoff, every honored `Retry-After` — where `maxRetries` and a per-attempt
 * timeout together cannot. `fn` receives `{ signal, remainingMs }`; thread
 * `signal` into the attempt's I/O, or an expiry that fires mid-attempt overshoots
 * by one in-flight request. A backoff that would consume the remaining budget
 * fails fast rather than sleeping into a certain timeout, and expiry rejects with
 * a single `Timeout` error carrying `data.reason: 'retry_deadline_exceeded'` —
 * the `RequestCancelled` that an external-signal abort produces inside
 * `fetchWithTimeout` normalizes to it. A caller abort on `options.signal` keeps
 * precedence and is never relabelled. Without `deadlineMs`, behavior is
 * unchanged.
 *
 * When retries exhaust, the final error is enriched with attempt count in both
 * the message and structured data, so callers know retries were already attempted.
 *
 * @typeParam T - Return type of the operation.
 * @param fn - The async operation to execute with retries. Receives a
 *   {@link RetryAttempt}; a zero-argument operation is assignable unchanged.
 * @param options - Retry configuration. All fields optional with sensible defaults.
 * @returns The result of `fn` on success.
 * @throws The enriched final error when all attempts are exhausted, or the original
 *   error immediately if it is not classified as transient.
 *
 * @example
 * ```ts
 * // Service method — retry covers fetch + parse
 * async function fetchStudy(id: string, ctx: Context): Promise<Study> {
 *   return withRetry(
 *     async () => {
 *       const text = await apiClient.get(`/studies/${id}`);
 *       return responseHandler.parse<Study>(text);
 *     },
 *     { operation: 'fetchStudy', context: ctx, baseDelayMs: 1000 },
 *   );
 * }
 * ```
 *
 * @example Bounded by one wall-clock budget
 * ```ts
 * const data = await withRetry(
 *   async ({ signal, remainingMs }) => {
 *     const res = await fetchWithTimeout(url, Math.min(30_000, remainingMs), ctx, { signal });
 *     return parse(await res.text());
 *   },
 *   { operation: 'search', context: ctx, signal: ctx.signal, deadlineMs: 50_000 },
 * );
 * ```
 */
export async function withRetry<T>(
  fn: (attempt: RetryAttempt) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30_000,
    jitter = 0.25,
    operation,
    context,
    signal,
    deadlineMs,
    isTransient = defaultIsTransient,
  } = options;

  const totalAttempts = maxRetries + 1;
  const clock = deadlineMs === undefined ? undefined : createDeadlineClock(deadlineMs, operation);

  const attemptSignal =
    clock && signal
      ? AbortSignal.any([clock.signal, signal])
      : (clock?.signal ?? signal ?? new AbortController().signal);

  try {
    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      try {
        return await fn({
          signal: attemptSignal,
          remainingMs: clock?.remainingMs() ?? Number.POSITIVE_INFINITY,
        });
      } catch (error: unknown) {
        // Abort signal — exit immediately, no more retries. Outranks the
        // deadline so a cancelled request is never relabelled as an expiry.
        if (signal?.aborted) {
          throw error;
        }

        // The deadline fired inside the attempt. Whatever shape it took on the
        // way back (RequestCancelled from an external-signal abort, a raw abort
        // reason), the caller sees one error.
        if (clock?.expired()) {
          throw clock.exceeded(error, attempt + 1);
        }

        const isLastAttempt = attempt >= maxRetries;

        // Non-transient errors fail immediately
        if (!isTransient(error)) {
          throw error;
        }

        // Honor an upstream Retry-After hint over blind exponential backoff.
        const retryAfterMs = parseRetryAfterMs(error);

        // A requested wait longer than the cap can't clear within the retry budget —
        // surface the limit immediately instead of burning an attempt on a window
        // that won't open in time.
        if (retryAfterMs !== undefined && retryAfterMs > maxDelayMs) {
          logger.debug(
            `Retry-After ${Math.round(retryAfterMs)}ms exceeds maxDelayMs ${maxDelayMs}ms for ${operation ?? 'operation'} — failing fast`,
            context,
          );
          throw error;
        }

        if (isLastAttempt) {
          throw enrichExhaustedError(error, totalAttempts, operation);
        }

        // Log and backoff — the honored Retry-After wins over the exponential value.
        const delay = retryAfterMs ?? computeDelay(attempt, baseDelayMs, maxDelayMs, jitter);

        /**
         * A wait that would outlast the remaining budget leaves the next attempt
         * nothing, so sleeping it out only converts a fast failure into a certain
         * timeout. A wait landing exactly on the deadline still sleeps: the
         * clock's own timer was armed first and fires first, so the expiry
         * surfaces through the mid-backoff path below rather than here. The two
         * waits exit differently: an honored
         * `Retry-After` takes the same exit the `maxDelayMs` cap takes — the
         * attempt's own error, untouched, `data.retryAfter` intact, because
         * "wait the window the upstream named" is still the caller's action.
         * Blind exponential backoff has no such message for the caller, so it
         * surfaces the expiry.
         */
        if (clock && delay > clock.remainingMs()) {
          if (retryAfterMs !== undefined) {
            logger.debug(
              `Retry-After ${Math.round(retryAfterMs)}ms outlasts the ${Math.round(clock.remainingMs())}ms left of the ${deadlineMs}ms deadline for ${operation ?? 'operation'} — failing fast`,
              context,
            );
            throw error;
          }
          throw clock.exceeded(error, attempt + 1);
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        const delaySource = retryAfterMs === undefined ? '' : ' (Retry-After)';

        logger.debug(
          `Retry ${attempt + 1}/${maxRetries} for ${operation ?? 'operation'}: ${errorMessage} — waiting ${Math.round(delay)}ms${delaySource}`,
          context,
        );

        try {
          await sleep(delay, attemptSignal);
        } catch (sleepError: unknown) {
          // Same precedence as the attempt path: a caller abort rethrows its own
          // reason, an expiry landing mid-backoff normalizes.
          if (signal?.aborted) throw sleepError;
          if (clock?.expired()) throw clock.exceeded(error, attempt + 1);
          throw sleepError;
        }
      }
    }
  } finally {
    clock?.stop();
  }

  // Unreachable — the loop always returns or throws
  throw new McpError(JsonRpcErrorCode.InternalError, 'withRetry: unexpected loop exit');
}

/** Sleeps for the given duration, aborting early if the signal fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const controller = new AbortController();
    // AbortSignal.any is available on all supported floors (Node ≥24, Bun ≥1.4, workerd).
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

    const timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, ms);

    combined.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        // If the external signal fired, reject with its reason; otherwise the
        // timer already resolved (controller.abort() does not set a reason here).
        if (signal?.aborted) {
          reject(signal.reason);
        }
      },
      { once: true },
    );
  });
}

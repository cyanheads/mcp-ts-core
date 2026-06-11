/**
 * @fileoverview Retry utility with exponential backoff for wrapping operations that
 * may fail transiently. Designed so the retry boundary covers the full pipeline
 * (HTTP fetch + response parsing/validation), not just the network call.
 * @module src/utils/network/retry
 */
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
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
   * without further attempts.
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
 */
function defaultIsTransient(error: unknown): boolean {
  if (error instanceof McpError) {
    // Explicit opt-out wins over code-based classification.
    if (error.data?.retryable === false) return false;
    return TRANSIENT_CODES.has(error.code);
  }
  // Non-McpError (raw network errors, unexpected throws) — assume transient
  return true;
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
 * When retries exhaust, the final error is enriched with attempt count in both
 * the message and structured data, so callers know retries were already attempted.
 *
 * @typeParam T - Return type of the operation.
 * @param fn - The async operation to execute with retries.
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
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30_000,
    jitter = 0.25,
    operation,
    context,
    signal,
    isTransient = defaultIsTransient,
  } = options;

  const totalAttempts = maxRetries + 1;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      // Abort signal — exit immediately, no more retries
      if (signal?.aborted) {
        throw error;
      }

      const isLastAttempt = attempt >= maxRetries;

      // Non-transient errors fail immediately
      if (!isTransient(error)) {
        throw error;
      }

      if (isLastAttempt) {
        throw enrichExhaustedError(error, totalAttempts, operation);
      }

      // Log and backoff
      const delay = computeDelay(attempt, baseDelayMs, maxDelayMs, jitter);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.debug(
        `Retry ${attempt + 1}/${maxRetries} for ${operation ?? 'operation'}: ${errorMessage} — waiting ${Math.round(delay)}ms`,
        context,
      );

      await sleep(delay, signal);
    }
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
    // AbortSignal.any is available on all supported floors (Node ≥24, Bun ≥1.3, workerd).
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

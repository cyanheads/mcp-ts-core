/**
 * @fileoverview Provides a generic `RateLimiter` class for implementing rate limiting logic.
 * It supports configurable time windows, request limits, and automatic cleanup of expired entries.
 * @module src/utils/security/rateLimiter
 */
import { trace } from '@opentelemetry/api';
import type { config as ConfigType } from '@/config/index.js';
import { rateLimited } from '@/types-global/errors.js';
import type { logger as LoggerType } from '@/utils/internal/logger.js';
import { type RequestContext, requestContextService } from '@/utils/internal/requestContext.js';
import { createCounter } from '@/utils/telemetry/metrics.js';

let rejectionCounter: ReturnType<typeof createCounter> | undefined;

function getRateLimitMetrics() {
  rejectionCounter ??= createCounter(
    'mcp.ratelimit.rejections',
    'Rate limit rejections',
    '{rejections}',
  );
  return { rejectionCounter };
}

/** Eagerly creates the rate limit rejection counter so the series exists from startup. */
export function initRateLimitMetrics(): void {
  getRateLimitMetrics();
}

/**
 * Defines configuration options for the {@link RateLimiter}.
 */
export interface RateLimitConfig {
  /** How often, in milliseconds, to clean up expired entries. */
  cleanupInterval?: number;
  /** Custom error message template. Can include `{waitTime}` placeholder. */
  errorMessage?: string;
  /** Optional function to generate a custom key for rate limiting. */
  keyGenerator?: (identifier: string, context?: RequestContext) => string;
  /** Maximum number of requests allowed in the window. */
  maxRequests: number;
  /** Maximum number of tracked keys. When exceeded, oldest entries are evicted (LRU). Default: 10000 */
  maxTrackedKeys?: number;
  /** If true, skip rate limiting in development. */
  skipInDevelopment?: boolean;
  /** Time window in milliseconds. */
  windowMs: number;
}

/**
 * Represents an individual entry for tracking requests against a rate limit key.
 */
export interface RateLimitEntry {
  /** Current request count. */
  count: number;
  /** Last access timestamp for LRU eviction. */
  lastAccess: number;
  /** When the window resets (timestamp in milliseconds). */
  resetTime: number;
}

/**
 * A configurable, in-process rate limiter that enforces request quotas per key within a sliding
 * time window. Tracks request counts in a `Map`, evicts least-recently-used entries when the
 * tracked-key cap is reached, and periodically cleans up expired windows via a background timer.
 *
 * Throws {@link McpError} with {@link JsonRpcErrorCode.RateLimited} when the limit is exceeded.
 * Integrates with OpenTelemetry by annotating the active span with rate-limit attributes.
 *
 * @example
 * ```ts
 * const limiter = new RateLimiter(config, logger);
 * limiter.configure({ maxRequests: 60, windowMs: 60_000 });
 *
 * // In a request handler:
 * limiter.check(clientId, requestContext); // throws McpError if over limit
 * ```
 */
export class RateLimiter {
  private readonly limits: Map<string, RateLimitEntry>;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly effectiveConfig: RateLimitConfig;

  /**
   * Creates a new `RateLimiter` instance with sensible defaults:
   * - 100 requests per 15-minute window
   * - 5-minute cleanup interval
   * - Up to 10,000 tracked keys (LRU eviction beyond that)
   *
   * Call {@link configure} to override any of these defaults before first use.
   *
   * @param config - Application config, used to check `environment` when `skipInDevelopment` is set.
   * @param logger - Logger instance for debug output on cleanup and eviction events.
   */
  constructor(
    private config: typeof ConfigType,
    private logger: typeof LoggerType,
  ) {
    const defaultConfig: RateLimitConfig = {
      windowMs: 15 * 60 * 1000,
      maxRequests: 100,
      errorMessage: 'Rate limit exceeded. Please try again in {waitTime} seconds.',
      skipInDevelopment: false,
      cleanupInterval: 5 * 60 * 1000,
      maxTrackedKeys: 10000,
    };
    this.effectiveConfig = { ...defaultConfig };
    this.limits = new Map();
    this.startCleanupTimer();
  }

  /**
   * Evicts the least recently used entry from the limits Map.
   * This prevents unbounded memory growth in high-traffic scenarios.
   * @private
   */
  private evictLRUEntry(): void {
    if (this.limits.size === 0) return;

    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    // Find the entry with the oldest lastAccess time
    for (const [key, entry] of this.limits.entries()) {
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.limits.delete(oldestKey);
      const logContext = requestContextService.createRequestContext({
        operation: 'RateLimiter.evictLRUEntry',
        additionalContext: {
          evictedKey: oldestKey,
          remainingEntries: this.limits.size,
        },
      });
      this.logger.debug('Evicted LRU entry from rate limiter', logContext);
    }
  }

  /**
   * Starts (or restarts) the periodic cleanup interval using the current `cleanupInterval` config.
   * Clears any existing timer first. The timer is unref'd so it does not prevent Node.js from exiting.
   * No-ops if `cleanupInterval` is 0 or unset.
   * @private
   */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    const interval = this.effectiveConfig.cleanupInterval;
    if (interval && interval > 0) {
      this.cleanupTimer = setInterval(() => {
        this.cleanupExpiredEntries();
      }, interval);
      if (this.cleanupTimer.unref) {
        this.cleanupTimer.unref();
      }
    }
  }

  /**
   * Iterates all tracked entries and deletes any whose `resetTime` has passed.
   * Called automatically by the cleanup timer. Logs the number of removed entries at debug level.
   * @private
   */
  private cleanupExpiredEntries(): void {
    const now = Date.now();
    let expiredCount = 0;
    for (const [key, entry] of this.limits.entries()) {
      if (now >= entry.resetTime) {
        this.limits.delete(key);
        expiredCount++;
      }
    }
    if (expiredCount > 0) {
      const logContext = requestContextService.createRequestContext({
        operation: 'RateLimiter.cleanupExpiredEntries',
        additionalContext: {
          cleanedCount: expiredCount,
          totalRemainingAfterClean: this.limits.size,
        },
      });
      this.logger.debug(`Cleaned up ${expiredCount} expired rate limit entries`, logContext);
    }
  }

  /**
   * Merges the provided partial config into the current effective configuration.
   * If `cleanupInterval` is included, the background timer is restarted with the new interval.
   *
   * @param config - Partial {@link RateLimitConfig} fields to apply.
   *
   * @example
   * ```ts
   * limiter.configure({ maxRequests: 30, windowMs: 60_000, skipInDevelopment: true });
   * ```
   */
  public configure(config: Partial<RateLimitConfig>): void {
    Object.assign(this.effectiveConfig, config);
    if (config.cleanupInterval !== undefined) {
      this.startCleanupTimer();
    }
  }

  /**
   * Returns a shallow copy of the current effective {@link RateLimitConfig}.
   *
   * @returns A copy of the active rate limit configuration.
   */
  public getConfig(): RateLimitConfig {
    return { ...this.effectiveConfig };
  }

  /**
   * Clears all tracked rate limit entries, effectively resetting every key's counter.
   * Useful for testing or emergency bypass scenarios.
   */
  public reset(): void {
    this.limits.clear();
    const logContext = requestContextService.createRequestContext({
      operation: 'RateLimiter.reset',
    });
    this.logger.debug('Rate limiter reset, all limits cleared', logContext);
  }

  /**
   * Checks whether the given key has exceeded its rate limit and throws if so.
   *
   * On each call:
   * 1. No-ops if `skipInDevelopment` is `true` and `config.environment === 'development'`.
   * 2. Resolves the effective key via `keyGenerator` if configured, otherwise uses `key` as-is.
   * 3. Creates a new window entry on first call or after the previous window expired.
   *    If the tracked-key cap is reached, the least-recently-used entry is evicted first.
   * 4. Increments the count and updates the LRU timestamp.
   * 5. If count exceeds `maxRequests`, throws {@link McpError} with {@link JsonRpcErrorCode.RateLimited}
   *    and error data containing `waitTimeSeconds`, `key`, `limit`, and `windowMs`.
   *
   * The active OpenTelemetry span is annotated with rate-limit attributes on every call.
   *
   * @param key - The identifier to rate-limit (e.g., a client ID, IP address, or tool name).
   * @param context - Optional request context passed to the `keyGenerator`, if configured.
   * @throws {McpError} With code {@link JsonRpcErrorCode.RateLimited} when the limit is exceeded.
   *
   * @example
   * ```ts
   * // Basic usage
   * rateLimiter.check('client-abc');
   *
   * // With request context for custom key generation
   * rateLimiter.check('client-abc', requestContext);
   * ```
   */
  public check(key: string, context?: RequestContext): void {
    const activeSpan = trace.getActiveSpan();
    activeSpan?.setAttribute('mcp.rate_limit.checked', true);

    if (this.effectiveConfig.skipInDevelopment && this.config.environment === 'development') {
      activeSpan?.setAttribute('mcp.rate_limit.skipped', 'development');
      return;
    }

    const limitKey = this.effectiveConfig.keyGenerator
      ? this.effectiveConfig.keyGenerator(key, context)
      : key;
    activeSpan?.setAttribute('mcp.rate_limit.key', limitKey);

    const now = Date.now();
    let entry = this.limits.get(limitKey);

    if (!entry || now >= entry.resetTime) {
      // Check if we need to evict an entry before adding a new one
      const maxKeys = this.effectiveConfig.maxTrackedKeys ?? 10000;
      if (!entry && this.limits.size >= maxKeys) {
        this.evictLRUEntry();
        activeSpan?.addEvent('rate_limit_lru_eviction', {
          'mcp.rate_limit.size_before_eviction': this.limits.size + 1,
          'mcp.rate_limit.max_keys': maxKeys,
        });
      }

      entry = {
        count: 1,
        resetTime: now + this.effectiveConfig.windowMs,
        lastAccess: now,
      };
      this.limits.set(limitKey, entry);
    } else {
      entry.count++;
      entry.lastAccess = now; // Update LRU timestamp
    }

    const remaining = Math.max(0, this.effectiveConfig.maxRequests - entry.count);
    activeSpan?.setAttributes({
      'mcp.rate_limit.limit': this.effectiveConfig.maxRequests,
      'mcp.rate_limit.count': entry.count,
      'mcp.rate_limit.remaining': remaining,
      'mcp.rate_limit.tracked_keys': this.limits.size,
    });

    if (entry.count > this.effectiveConfig.maxRequests) {
      const waitTime = Math.ceil((entry.resetTime - now) / 1000);
      const errorMessage = (
        this.effectiveConfig.errorMessage ||
        'Rate limit exceeded. Please try again in {waitTime} seconds.'
      ).replace('{waitTime}', waitTime.toString());

      activeSpan?.addEvent('rate_limit_exceeded', {
        'mcp.rate_limit.wait_time_seconds': waitTime,
      });

      // No `mcp.rate_limit.key` attribute — `limitKey` is caller-supplied and
      // typically per-client, which would materialize an unbounded series in
      // the OTel meter. Per-key attribution lives on the span (line 268).
      getRateLimitMetrics().rejectionCounter.add(1);

      throw rateLimited(errorMessage, {
        waitTimeSeconds: waitTime,
        key: limitKey,
        limit: this.effectiveConfig.maxRequests,
        windowMs: this.effectiveConfig.windowMs,
      });
    }
  }

  /**
   * Returns the current rate limit status for a given key, or `null` if the key is not tracked
   * (i.e., no requests have been made in the current window).
   *
   * Note: This method does **not** apply the `keyGenerator` — pass the already-resolved key
   * if a custom generator is configured.
   *
   * @param key - The rate limit key to query.
   * @returns An object with `current` count, configured `limit`, `remaining` requests, and
   *   `resetTime` (ms epoch when the window resets), or `null` if the key has no active entry.
   *
   * @example
   * ```ts
   * const status = rateLimiter.getStatus('client-abc');
   * if (status) {
   *   console.log(`${status.remaining} requests remaining, resets at ${new Date(status.resetTime)}`);
   * }
   * ```
   */
  public getStatus(key: string): {
    current: number;
    limit: number;
    remaining: number;
    resetTime: number;
  } | null {
    const entry = this.limits.get(key);
    if (!entry) return null;
    return {
      current: entry.count,
      limit: this.effectiveConfig.maxRequests,
      remaining: Math.max(0, this.effectiveConfig.maxRequests - entry.count),
      resetTime: entry.resetTime,
    };
  }

  /**
   * Stops the background cleanup timer and clears all tracked entries.
   * Should be called during application shutdown to allow the process to exit cleanly
   * (even though the timer is unref'd, explicit disposal is good practice).
   */
  public dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.limits.clear();
  }

  /**
   * Alias for {@link dispose}. Enables `using limiter = new RateLimiter(...)` with
   * TypeScript's explicit resource management (ES2022 `using` declarations).
   */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

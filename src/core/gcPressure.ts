/**
 * @fileoverview Opt-in forced-GC pressure loop. Mitigates the per-request
 * heap retention scenario tracked in issue #50: per-request `McpServer` /
 * `McpSessionTransport` pairs reach `close()` cleanly, but the V8/JSC cycle
 * between `server.onmessage` and `transport` is only broken by a major GC.
 * Under sustained moderate HTTP load on a constrained host (~10 RPS for
 * hours), major GC fires too rarely to drain the backlog and old-gen
 * accumulates. A periodic `Bun.gc(true)` (synchronous, force-major) reclaims
 * the backlog cheaply — ~50 ms per call to clear dozens of pairs.
 *
 * Guards: only active on Bun with a callable `Bun.gc` and an interval > 0.
 * Returns a no-op disposer on Node, Workers, or when disabled, so callers
 * always have something safe to invoke in their shutdown path.
 * @module src/core/gcPressure
 */

import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { runtimeCaps } from '@/utils/internal/runtime.js';

type BunRuntime = {
  gc?: (sync?: boolean) => void;
};

type GlobalWithBun = typeof globalThis & { Bun?: BunRuntime };

/** @internal — indirection so tests can stub the gc lookup. */
export const _gcPressureInternals = {
  resolveBunGc(): ((sync?: boolean) => void) | undefined {
    const bun = (globalThis as GlobalWithBun).Bun;
    return typeof bun?.gc === 'function' ? bun.gc.bind(bun) : undefined;
  },
};

/**
 * Starts an interval that calls `Bun.gc(true)` every `intervalMs`.
 *
 * @param intervalMs - Interval in milliseconds. `0` (or negative) disables.
 * @returns Disposer that clears the interval. Safe to call when disabled —
 * the no-op disposer is returned in that case.
 */
export function startGcPressureLoop(intervalMs: number): () => void {
  const context = requestContextService.createRequestContext({ operation: 'GcPressureLoop' });

  if (intervalMs <= 0) return noop;
  if (!runtimeCaps.isBun) {
    logger.info(
      `MCP_GC_PRESSURE_INTERVAL_MS=${intervalMs} ignored — not running on Bun (Bun.gc is unavailable).`,
      context,
    );
    return noop;
  }

  const gc = _gcPressureInternals.resolveBunGc();
  if (!gc) {
    logger.info(
      `MCP_GC_PRESSURE_INTERVAL_MS=${intervalMs} ignored — Bun.gc is not a function on this runtime.`,
      context,
    );
    return noop;
  }

  const timer = setInterval(() => {
    try {
      gc(true);
    } catch (err) {
      logger.debug('Bun.gc threw during GC pressure tick — continuing.', {
        ...context,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();

  logger.info(
    `GC pressure loop started — calling Bun.gc(true) every ${intervalMs}ms (issue #50 mitigation).`,
    context,
  );

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    logger.info('GC pressure loop stopped.', context);
  };
}

function noop(): void {}

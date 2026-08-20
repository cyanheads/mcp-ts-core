/**
 * @fileoverview Connection heartbeat monitor for MCP transports.
 * Periodically pings the connected client to verify liveness and emits
 * an OTel failure counter for alerting on unresponsive connections.
 *
 * The MCP spec recommends periodic pings to detect connection health.
 * This module implements server-initiated pings with configurable interval
 * and miss threshold, triggering cleanup when a client becomes unresponsive.
 * @module src/mcp-server/transports/heartbeat
 */

import { logger } from '@/utils/internal/logger.js';
import {
  type RequestContext,
  requestContextService,
  withExtra,
} from '@/utils/internal/requestContext.js';
import { ATTR_MCP_CONNECTION_TRANSPORT } from '@/utils/telemetry/attributes.js';
import { createCounter } from '@/utils/telemetry/metrics.js';

/** Configuration for a {@link HeartbeatMonitor} instance. */
export interface HeartbeatOptions {
  /** Milliseconds between ping attempts. `0` disables heartbeat. */
  intervalMs: number;

  /** Consecutive ping failures before declaring the connection dead. */
  missThreshold: number;

  /**
   * Called when consecutive failures reach {@link missThreshold}.
   * Typically triggers graceful shutdown of the transport.
   */
  onDead: () => void;

  /**
   * Sends a ping to the connected client. Must reject/throw on failure
   * or timeout — the monitor counts consecutive rejections.
   */
  sendPing: () => Promise<unknown>;

  /** Transport type label for OTel metric attributes (e.g. `'stdio'`). */
  transport: string;
}

// ---------------------------------------------------------------------------
// Lazy OTel metric singletons
// ---------------------------------------------------------------------------

let heartbeatFailures: ReturnType<typeof createCounter> | undefined;

function getMetrics() {
  heartbeatFailures ??= createCounter(
    'mcp.heartbeat.failures',
    'Heartbeat ping failures',
    '{failures}',
  );
  return { heartbeatFailures };
}

/** Eagerly create metric series so they exist from the first export cycle. */
export function initHeartbeatMetrics(): void {
  getMetrics();
}

// ---------------------------------------------------------------------------
// HeartbeatMonitor
// ---------------------------------------------------------------------------

/**
 * Periodically pings the connected MCP client and tracks liveness.
 *
 * Uses a recursive `setTimeout` pattern (not `setInterval`) so pings
 * never overlap — each cycle waits for the previous ping to resolve
 * before scheduling the next one.
 *
 * On {@link HeartbeatOptions.missThreshold} consecutive failures the
 * monitor calls {@link HeartbeatOptions.onDead} and stops itself.
 */
export class HeartbeatMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private stopped = false;
  private readonly opts: HeartbeatOptions;
  private readonly context: RequestContext;
  private readonly attrs: Record<string, string>;

  constructor(opts: HeartbeatOptions, parentContext?: RequestContext) {
    this.opts = opts;
    this.context = requestContextService.createRequestContext({
      parentContext,
      additionalContext: { component: 'HeartbeatMonitor', transport: opts.transport },
    });
    this.attrs = { [ATTR_MCP_CONNECTION_TRANSPORT]: opts.transport };
  }

  /** Begin the ping cycle. No-op if `intervalMs <= 0`. */
  start(): void {
    if (this.opts.intervalMs <= 0) return;
    this.stopped = false;
    logger.info(
      `Heartbeat enabled (interval=${this.opts.intervalMs}ms, threshold=${this.opts.missThreshold})`,
      this.context,
    );
    this.scheduleNext();
  }

  /** Stop the ping cycle. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;

    try {
      await this.opts.sendPing();

      if (this.consecutiveFailures > 0) {
        logger.debug(
          `Heartbeat recovered after ${this.consecutiveFailures} failure(s)`,
          this.context,
        );
      }
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures++;
      getMetrics().heartbeatFailures.add(1, this.attrs);

      logger.warning(
        `Heartbeat ping failed (${this.consecutiveFailures}/${this.opts.missThreshold})`,
        withExtra(this.context, { error: err instanceof Error ? err.message : String(err) }),
      );

      if (this.consecutiveFailures >= this.opts.missThreshold) {
        logger.error(
          'Heartbeat: connection declared dead — initiating shutdown.',
          new Error(`${this.opts.missThreshold} consecutive heartbeat failures`),
          this.context,
        );
        this.opts.onDead();
        this.stop();
        return;
      }
    }

    this.scheduleNext();
  }
}

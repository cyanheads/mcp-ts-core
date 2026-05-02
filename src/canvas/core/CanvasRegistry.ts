/**
 * @fileoverview Canvas lifecycle registry. Keys canvases by (tenantId, canvasId),
 * generates crypto-secure 10-char URL-safe IDs, enforces a sliding 24h TTL with
 * a 7-day absolute cap, and runs a periodic sweeper that destroys expired
 * canvases via the underlying provider. Also enforces the per-tenant active
 * canvas cap (default 100).
 *
 * Public access is gated by {@link DataCanvas} — callers never see this class
 * directly. Tests construct it with a fake provider and a mock `Date.now` to
 * exercise expiry/sweep logic.
 * @module src/canvas/core/CanvasRegistry
 */

import { conflict, notFound, rateLimited } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { type RequestContext, requestContextService } from '@/utils/internal/requestContext.js';
import { IdGenerator } from '@/utils/security/idGenerator.js';
import type { IDataCanvasProvider } from './IDataCanvasProvider.js';

/**
 * Canvas ID character set — URL-safe alphabet matching `nanoid`'s default
 * (A-Z, a-z, 0-9, `-`, `_`). 10 chars × 64 alphabet ≈ 1.15 × 10^18 keyspace.
 */
const CANVAS_ID_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const CANVAS_ID_LENGTH = 10;
const CANVAS_ID_REGEX = /^[A-Za-z0-9_-]{10}$/;

/** Internal record tracking a single live canvas. */
interface CanvasRecord {
  canvasId: string;
  createdAt: number;
  /** Resolved `expiresAt` — recomputed on every touch. */
  expiresAt: number;
  lastAccessedAt: number;
  tenantId: string;
}

/** Tunable lifecycle constants for the registry. */
export interface CanvasRegistryOptions {
  /** Absolute cap from creation in milliseconds. Default 7d. */
  absoluteCapMs: number;
  /** Maximum active canvases per tenant. Default 100. */
  maxCanvasesPerTenant: number;
  /** Sweeper interval in milliseconds. Default 60s. Set to 0 to disable. */
  sweeperIntervalMs: number;
  /** Sliding TTL in milliseconds. Default 24h. */
  ttlMs: number;
}

/**
 * Default lifecycle constants. Mirrored in the config schema; exported so
 * tests and downstream tooling can reference the same numbers.
 */
export const DEFAULT_CANVAS_REGISTRY_OPTIONS: CanvasRegistryOptions = {
  ttlMs: 24 * 60 * 60 * 1000,
  absoluteCapMs: 7 * 24 * 60 * 60 * 1000,
  maxCanvasesPerTenant: 100,
  sweeperIntervalMs: 60 * 1000,
};

/** Result of {@link CanvasRegistry.acquire}. */
export interface AcquireResult {
  canvasId: string;
  /** Wall-clock expiry as ISO 8601, after the sliding extension. */
  expiresAt: string;
  /** True when the registry created the canvas during this acquire call. */
  isNew: boolean;
  tenantId: string;
}

/**
 * Tracks the active canvases for a single process. Not multi-process safe —
 * tokens issued by one process are not portable to another (matches v1 scope
 * in the issue).
 */
export class CanvasRegistry {
  private readonly idGenerator = new IdGenerator();
  private readonly canvases = new Map<string, CanvasRecord>();
  /** Per-tenant index for cap enforcement and listing. */
  private readonly byTenant = new Map<string, Set<string>>();
  private sweeperTimer: ReturnType<typeof setInterval> | undefined;
  private isShuttingDown = false;

  constructor(
    private readonly provider: IDataCanvasProvider,
    private readonly options: CanvasRegistryOptions = DEFAULT_CANVAS_REGISTRY_OPTIONS,
    /** Injected for tests. Defaults to `Date.now`. */
    private readonly clock: () => number = Date.now,
  ) {
    if (options.sweeperIntervalMs > 0) {
      this.sweeperTimer = setInterval(() => void this.sweep(), options.sweeperIntervalMs);
      // Don't keep the event loop alive solely for the sweeper.
      this.sweeperTimer.unref?.();
    }
  }

  /**
   * Resolve an existing canvas or create a new one when `maybeId` is omitted
   * or the supplied id is unknown for the caller's tenant.
   *
   * - Omitted id → create fresh, return `isNew: true`.
   * - Unknown id → throw `NotFound` (caller should retry without an id).
   * - Known id under wrong tenant → throw `NotFound` (uniform with unknown
   *   to avoid leaking existence across tenants).
   * - Known + own tenant → touch (extend TTL), return `isNew: false`.
   */
  async acquire(
    maybeId: string | undefined,
    tenantId: string,
    context: RequestContext,
  ): Promise<AcquireResult> {
    if (this.isShuttingDown) {
      throw notFound('Canvas registry is shutting down.', { tenantId });
    }

    if (maybeId !== undefined) {
      const record = this.lookup(maybeId, tenantId);
      if (!record) {
        throw notFound('Canvas not found or expired. Omit canvas_id to start a new canvas.', {
          canvasId: maybeId,
        });
      }
      this.touch(record);
      return {
        canvasId: record.canvasId,
        tenantId: record.tenantId,
        isNew: false,
        expiresAt: new Date(record.expiresAt).toISOString(),
      };
    }

    this.enforceTenantCap(tenantId);
    const canvasId = this.mintId();
    const now = this.clock();
    const record: CanvasRecord = {
      canvasId,
      tenantId,
      createdAt: now,
      lastAccessedAt: now,
      expiresAt: now + this.options.ttlMs,
    };
    this.canvases.set(canvasId, record);
    this.indexByTenant(tenantId, canvasId);

    await this.provider.initCanvas(canvasId, context);

    logger.debug('Canvas created.', {
      ...context,
      canvasId,
      tenantId,
      provider: this.provider.name,
    });

    return {
      canvasId,
      tenantId,
      isNew: true,
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
  }

  /**
   * Validate that `canvasId` belongs to `tenantId` and is not expired, then
   * extend its TTL and return the resolved expiry. Used by {@link CanvasInstance}
   * before every op so individual operations slide the window.
   */
  touchOrThrow(canvasId: string, tenantId: string): string {
    const record = this.lookup(canvasId, tenantId);
    if (!record) {
      throw notFound('Canvas not found or expired.', { canvasId });
    }
    this.touch(record);
    return new Date(record.expiresAt).toISOString();
  }

  /**
   * Drop a canvas explicitly (e.g. tenant-initiated cleanup). Returns true
   * when the canvas existed and was destroyed.
   */
  async drop(canvasId: string, tenantId: string, context: RequestContext): Promise<boolean> {
    const record = this.lookup(canvasId, tenantId);
    if (!record) return false;
    await this.destroy(record, context);
    return true;
  }

  /** Active canvas count for a tenant (used by tests and metrics surfaces). */
  countForTenant(tenantId: string): number {
    return this.byTenant.get(tenantId)?.size ?? 0;
  }

  /** Total active canvases (used by tests and metrics surfaces). */
  totalActive(): number {
    return this.canvases.size;
  }

  /** Stop the sweeper and tear down every active canvas. Idempotent. */
  async shutdown(context: RequestContext): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    if (this.sweeperTimer) {
      clearInterval(this.sweeperTimer);
      this.sweeperTimer = undefined;
    }
    const records = Array.from(this.canvases.values());
    await Promise.allSettled(records.map((r) => this.destroy(r, context)));
    await this.provider.shutdown();
  }

  /** @internal Test/diagnostic hook — runs one sweep pass synchronously. */
  async sweep(): Promise<void> {
    if (this.isShuttingDown) return;
    const now = this.clock();
    const expired: CanvasRecord[] = [];
    for (const record of this.canvases.values()) {
      if (now >= record.expiresAt || now - record.createdAt >= this.options.absoluteCapMs) {
        expired.push(record);
      }
    }
    if (expired.length === 0) return;
    const sweepContext = requestContextService.createRequestContext({
      operation: 'CanvasRegistry.sweep',
    });
    await Promise.allSettled(expired.map((r) => this.destroy(r, sweepContext)));
    logger.debug('Canvas sweeper destroyed expired canvases.', {
      ...sweepContext,
      destroyedCount: expired.length,
    });
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private lookup(canvasId: string, tenantId: string): CanvasRecord | undefined {
    if (!CANVAS_ID_REGEX.test(canvasId)) return;
    const record = this.canvases.get(canvasId);
    if (!record) return;
    if (record.tenantId !== tenantId) return;
    const now = this.clock();
    if (now >= record.expiresAt || now - record.createdAt >= this.options.absoluteCapMs) {
      return;
    }
    return record;
  }

  private touch(record: CanvasRecord): void {
    const now = this.clock();
    record.lastAccessedAt = now;
    const slidingExpiry = now + this.options.ttlMs;
    const absoluteExpiry = record.createdAt + this.options.absoluteCapMs;
    record.expiresAt = Math.min(slidingExpiry, absoluteExpiry);
  }

  private enforceTenantCap(tenantId: string): void {
    const count = this.byTenant.get(tenantId)?.size ?? 0;
    if (count >= this.options.maxCanvasesPerTenant) {
      throw rateLimited(
        `Tenant has reached the active canvas cap (${this.options.maxCanvasesPerTenant}). Drop unused canvases or wait for the sliding TTL to expire them.`,
        { tenantId, activeCount: count, cap: this.options.maxCanvasesPerTenant },
      );
    }
  }

  private mintId(): string {
    // Loop-mint to avoid the (vanishingly rare) collision case.
    for (let i = 0; i < 5; i += 1) {
      const id = this.idGenerator.generateRandomString(CANVAS_ID_LENGTH, CANVAS_ID_CHARSET);
      if (!this.canvases.has(id)) return id;
    }
    throw conflict('Failed to generate a unique canvas ID after 5 attempts.');
  }

  private indexByTenant(tenantId: string, canvasId: string): void {
    let set = this.byTenant.get(tenantId);
    if (!set) {
      set = new Set();
      this.byTenant.set(tenantId, set);
    }
    set.add(canvasId);
  }

  private async destroy(record: CanvasRecord, context: RequestContext): Promise<void> {
    this.canvases.delete(record.canvasId);
    const set = this.byTenant.get(record.tenantId);
    if (set) {
      set.delete(record.canvasId);
      if (set.size === 0) this.byTenant.delete(record.tenantId);
    }
    try {
      await this.provider.destroyCanvas(record.canvasId, context);
    } catch (err) {
      logger.warning('Provider destroyCanvas failed during sweep.', {
        ...context,
        canvasId: record.canvasId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

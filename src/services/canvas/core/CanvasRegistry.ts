/**
 * @fileoverview Canvas lifecycle registry. Keys canvases by (tenantId, canvasId),
 * generates crypto-secure 10-char URL-safe IDs, enforces a sliding 24h TTL
 * with a 7-day absolute cap, runs a periodic sweeper, and caps active canvases
 * per tenant (default 100). Also tracks per-table TTLs; the sweep loop drops
 * expired tables before evaluating canvas-level expiry. Public access is gated
 * by {@link DataCanvas}.
 * @module src/services/canvas/core/CanvasRegistry
 */

import { conflict, notFound, rateLimited } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { type RequestContextLike, requestContextService } from '@/utils/internal/requestContext.js';
import { IdGenerator } from '@/utils/security/idGenerator.js';
import type { TableInfo } from '../types.js';
import type { IDataCanvasProvider } from './IDataCanvasProvider.js';

/**
 * Canvas ID character set — URL-safe alphabet matching `nanoid`'s default
 * (A-Z, a-z, 0-9, `-`, `_`). 10 chars × 64 alphabet ≈ 1.15 × 10^18 keyspace.
 */
const CANVAS_ID_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const CANVAS_ID_LENGTH = 10;
const CANVAS_ID_REGEX = /^[A-Za-z0-9_-]{10}$/;

/** Per-table expiry bookkeeping entry (only present for tables registered with `ttlMs`). */
interface TableExpiryRecord {
  /** Resolved wall-clock expiry — recomputed on every table touch. */
  expiresAt: number;
  /** Sliding TTL value used when recomputing `expiresAt`. */
  ttlMs: number;
}

/** Internal record tracking a single live canvas. */
interface CanvasRecord {
  canvasId: string;
  createdAt: number;
  /** Resolved `expiresAt` — recomputed on every touch. */
  expiresAt: number;
  lastAccessedAt: number;
  /** Per-table expiry entries, keyed by table name. Only present for tables with a ttlMs. */
  tableTtl: Map<string, TableExpiryRecord>;
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
 * Tracks active canvases for a single process. Not multi-process safe — tokens
 * issued by one process are not portable to another.
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
    context: RequestContextLike,
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
      tableTtl: new Map(),
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
   * before every op so individual operations slide the canvas window.
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
   * Slide the canvas TTL **and** the per-table TTL for `tableName` (if it has
   * one). Throws `NotFound` when the canvas is gone or expired. Used by
   * {@link CanvasInstance} on table-scoped ops (`registerTable`, `query`).
   */
  touchWithTable(canvasId: string, tenantId: string, tableName: string): string {
    const record = this.lookup(canvasId, tenantId);
    if (!record) {
      throw notFound('Canvas not found or expired.', { canvasId });
    }
    this.touch(record);
    this.touchTableRecord(record, tableName);
    return new Date(record.expiresAt).toISOString();
  }

  /**
   * Slide per-table TTLs for every table name that appears as a word-boundary
   * match in `sqlText`, in addition to the canvas-level touch and an explicit
   * `primaryTable` slide. Used by `query()` to slide all tables referenced in
   * the SQL, not just the `registerAs` target.
   */
  touchWithSqlTables(
    canvasId: string,
    tenantId: string,
    primaryTable: string | undefined,
    sqlText: string,
  ): string {
    const record = this.lookup(canvasId, tenantId);
    if (!record) {
      throw notFound('Canvas not found or expired.', { canvasId });
    }
    this.touch(record);
    if (primaryTable !== undefined) {
      this.touchTableRecord(record, primaryTable);
    }
    for (const tableName of record.tableTtl.keys()) {
      if (tableName !== primaryTable && wordBoundaryMatch(sqlText, tableName)) {
        this.touchTableRecord(record, tableName);
      }
    }
    return new Date(record.expiresAt).toISOString();
  }

  /**
   * Register (or replace) a per-table TTL entry. Called by {@link CanvasInstance}
   * after a successful `registerTable` with `ttlMs` set.
   */
  registerTableTtl(canvasId: string, tenantId: string, tableName: string, ttlMs: number): void {
    const record = this.lookup(canvasId, tenantId);
    if (!record) return; // canvas gone between registerTable and this call — no-op
    const now = this.clock();
    record.tableTtl.set(tableName, { ttlMs, expiresAt: now + ttlMs });
  }

  /**
   * Remove per-table TTL bookkeeping for `tableName`. Called when a table is
   * explicitly dropped via {@link CanvasInstance.drop} so the sweep loop does
   * not attempt to drop a table that no longer exists.
   */
  dropTableBookkeeping(canvasId: string, tenantId: string, tableName: string): void {
    const record = this.lookup(canvasId, tenantId);
    if (!record) return;
    record.tableTtl.delete(tableName);
  }

  /**
   * Clear all per-table TTL bookkeeping for a canvas. Called when
   * {@link CanvasInstance.clear} drops all tables so stale entries don't
   * accumulate in the map.
   */
  clearTableBookkeeping(canvasId: string, tenantId: string): void {
    const record = this.lookup(canvasId, tenantId);
    if (!record) return;
    record.tableTtl.clear();
  }

  /**
   * Merge per-table `expiresAt` annotations into a `TableInfo[]` array
   * returned by the provider's `describe()`. Tables without a per-table TTL
   * are returned as-is; tables with one get an `expiresAt` field injected.
   */
  annotateDescribeResult(canvasId: string, tenantId: string, tables: TableInfo[]): TableInfo[] {
    const record = this.lookup(canvasId, tenantId);
    if (!record || record.tableTtl.size === 0) return tables;
    return tables.map((t) => {
      const entry = record.tableTtl.get(t.name);
      if (!entry) return t;
      return { ...t, expiresAt: new Date(entry.expiresAt).toISOString() };
    });
  }

  /**
   * Drop a canvas explicitly (e.g. tenant-initiated cleanup). Returns true
   * when the canvas existed and was destroyed.
   */
  async drop(canvasId: string, tenantId: string, context: RequestContextLike): Promise<boolean> {
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
  async shutdown(context: RequestContextLike): Promise<void> {
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

  /**
   * Run one sweep pass. Per-table expiry is checked first: expired tables are
   * dropped via `provider.drop()` and their bookkeeping cleared. Then the
   * existing canvas-level check runs — the two clocks are fully independent;
   * a canvas survives a table drop as long as its own window is still live.
   *
   * @internal Test/diagnostic hook — also called by the periodic sweeper timer.
   */
  async sweep(): Promise<void> {
    if (this.isShuttingDown) return;
    const now = this.clock();
    const sweepContext = requestContextService.createRequestContext({
      operation: 'CanvasRegistry.sweep',
    });

    // --- Pass 1: per-table expiry ---
    // Collect expired entries before mutating the map to avoid iterator skips.
    const expiredTables: Array<{ canvasId: string; tableName: string }> = [];
    for (const record of this.canvases.values()) {
      for (const [tableName, entry] of record.tableTtl) {
        if (now >= entry.expiresAt) {
          expiredTables.push({ canvasId: record.canvasId, tableName });
        }
      }
    }
    let droppedTableCount = 0;
    for (const { canvasId, tableName } of expiredTables) {
      const record = this.canvases.get(canvasId);
      if (!record) continue; // canvas already destroyed by an earlier iteration
      try {
        await this.provider.drop(canvasId, tableName, sweepContext);
        record.tableTtl.delete(tableName);
        droppedTableCount += 1;
      } catch (err) {
        // Bookkeeping is kept so the next sweep pass retries the drop.
        logger.warning('Provider drop failed during per-table sweep.', {
          ...sweepContext,
          canvasId,
          tableName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (droppedTableCount > 0) {
      logger.debug('Canvas sweeper dropped expired tables.', {
        ...sweepContext,
        droppedTableCount,
      });
    }

    // --- Pass 2: canvas-level expiry (unchanged semantics) ---
    const expired: CanvasRecord[] = [];
    for (const record of this.canvases.values()) {
      if (now >= record.expiresAt || now - record.createdAt >= this.options.absoluteCapMs) {
        expired.push(record);
      }
    }
    if (expired.length === 0) return;
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

  private touchTableRecord(record: CanvasRecord, tableName: string): void {
    const entry = record.tableTtl.get(tableName);
    if (!entry) return;
    entry.expiresAt = this.clock() + entry.ttlMs;
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

  private async destroy(record: CanvasRecord, context: RequestContextLike): Promise<void> {
    this.canvases.delete(record.canvasId);
    // Clear per-table bookkeeping so stale entries don't survive a re-use.
    record.tableTtl.clear();
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

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Return true when `tableName` appears in `sqlText` as a whole word (i.e.
 * surrounded by non-identifier characters or at text boundaries). A false
 * positive (a name appearing inside a string literal) merely slides the table
 * TTL unnecessarily — harmless. A SQL parser is not warranted.
 */
function wordBoundaryMatch(sqlText: string, tableName: string): boolean {
  // Word characters for SQL identifiers: letters, digits, underscore.
  const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(tableName)}(?![A-Za-z0-9_])`);
  return pattern.test(sqlText);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

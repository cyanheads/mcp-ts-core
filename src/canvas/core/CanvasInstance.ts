/**
 * @fileoverview Per-canvas handle returned by {@link DataCanvas.acquire}. Captures
 * `(canvasId, tenantId)` once so callers don't repeat them on every op, and
 * routes each call through the registry's TTL-touch + tenant validation gate
 * before delegating to the provider.
 * @module src/canvas/core/CanvasInstance
 */

import type { RequestContext } from '@/utils/internal/requestContext.js';
import type {
  DescribeOptions,
  ExportOptions,
  ExportResult,
  ExportTarget,
  QueryOptions,
  QueryResult,
  RegisterRows,
  RegisterTableOptions,
  RegisterTableResult,
  TableInfo,
} from '../types.js';
import type { CanvasRegistry } from './CanvasRegistry.js';
import type { IDataCanvasProvider } from './IDataCanvasProvider.js';

/** Handle bound to a single canvas. Returned from {@link DataCanvas.acquire}. */
export class CanvasInstance {
  /** True when {@link DataCanvas.acquire} created this canvas during the current call. */
  readonly isNew: boolean;
  /** ISO 8601 expiry after the most recent operation extended the sliding TTL. */
  expiresAt: string;

  constructor(
    /** Opaque canvas token. Surface this to callers; share it across agents. */
    readonly canvasId: string,
    /** Tenant the canvas is bound to. Resolved by the registry from `RequestContext`. */
    readonly tenantId: string,
    isNew: boolean,
    expiresAt: string,
    private readonly registry: CanvasRegistry,
    private readonly provider: IDataCanvasProvider,
    private readonly context: RequestContext,
  ) {
    this.isNew = isNew;
    this.expiresAt = expiresAt;
  }

  /** Register a table on the canvas. */
  async registerTable(
    name: string,
    rows: RegisterRows,
    options?: RegisterTableOptions,
  ): Promise<RegisterTableResult> {
    this.expiresAt = this.registry.touchOrThrow(this.canvasId, this.tenantId);
    return await this.provider.registerTable(this.canvasId, name, rows, this.context, options);
  }

  /** Run a SQL query against the canvas. */
  async query(sql: string, options?: QueryOptions): Promise<QueryResult> {
    this.expiresAt = this.registry.touchOrThrow(this.canvasId, this.tenantId);
    return await this.provider.query(this.canvasId, sql, this.context, options);
  }

  /** Export a canvas table to a path or stream target. */
  async export(
    tableName: string,
    target: ExportTarget,
    options?: ExportOptions,
  ): Promise<ExportResult> {
    this.expiresAt = this.registry.touchOrThrow(this.canvasId, this.tenantId);
    return await this.provider.export(this.canvasId, tableName, target, this.context, options);
  }

  /** Describe one or all canvas tables. */
  async describe(options?: DescribeOptions): Promise<TableInfo[]> {
    this.expiresAt = this.registry.touchOrThrow(this.canvasId, this.tenantId);
    return await this.provider.describe(this.canvasId, this.context, options);
  }

  /** Drop a single canvas table. Returns `true` when found and removed. */
  async drop(name: string): Promise<boolean> {
    this.expiresAt = this.registry.touchOrThrow(this.canvasId, this.tenantId);
    return await this.provider.drop(this.canvasId, name, this.context);
  }

  /** Drop every table on the canvas. Returns the number dropped. */
  async clear(): Promise<number> {
    this.expiresAt = this.registry.touchOrThrow(this.canvasId, this.tenantId);
    return await this.provider.clear(this.canvasId, this.context);
  }
}

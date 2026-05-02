/**
 * @fileoverview Engine-level provider interface for the DataCanvas primitive.
 * Implementations own the physical resources backing each canvas (e.g. one
 * DuckDB instance per canvasId) and expose register/query/export/describe
 * operations keyed by canvasId. The lifecycle wrapper ({@link CanvasRegistry})
 * keys these calls by `(tenantId, canvasId)` and enforces TTL/caps.
 * @module src/canvas/core/IDataCanvasProvider
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

/**
 * Engine-level contract. The lifecycle wrapper guarantees `canvasId` is
 * already validated and authorized for the caller's tenant before any of
 * these methods are invoked, so providers may treat `canvasId` as opaque
 * and trusted.
 */
export interface IDataCanvasProvider {
  /** Drop every table on the canvas. Returns the number dropped. */
  clear(canvasId: string, context: RequestContext): Promise<number>;

  /** Describe one or all tables on the canvas. */
  describe(
    canvasId: string,
    context: RequestContext,
    options?: DescribeOptions,
  ): Promise<TableInfo[]>;

  /**
   * Release engine resources for a canvas. After this call, further ops on
   * the canvas throw `NotFound`.
   */
  destroyCanvas(canvasId: string, context: RequestContext): Promise<void>;

  /** Drop a single canvas table. Returns `true` when found and removed. */
  drop(canvasId: string, name: string, context: RequestContext): Promise<boolean>;

  /** Export a canvas table to a file or stream target. */
  export(
    canvasId: string,
    tableName: string,
    target: ExportTarget,
    context: RequestContext,
    options?: ExportOptions,
  ): Promise<ExportResult>;

  /** Liveness check on the underlying engine. */
  healthCheck(): Promise<boolean>;

  /**
   * Allocate engine resources for a new canvas. Idempotent — calling twice
   * with the same id is a no-op.
   */
  initCanvas(canvasId: string, context: RequestContext): Promise<void>;
  /** Provider name (e.g. `'duckdb'`). Used in logs and health output. */
  readonly name: string;

  /** Run a SQL query against the canvas. Read-only enforcement is the gate's job. */
  query(
    canvasId: string,
    sql: string,
    context: RequestContext,
    options?: QueryOptions,
  ): Promise<QueryResult>;

  /** Register a table on the canvas from in-memory or async iterator rows. */
  registerTable(
    canvasId: string,
    name: string,
    rows: RegisterRows,
    context: RequestContext,
    options?: RegisterTableOptions,
  ): Promise<RegisterTableResult>;

  /** Tear down all engine resources. Called from `ServerHandle.shutdown()`. */
  shutdown(): Promise<void>;
}

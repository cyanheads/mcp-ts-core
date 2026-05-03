/**
 * @fileoverview Engine-level provider interface for the DataCanvas primitive.
 * Implementations own physical resources per canvas (e.g. one DuckDB instance
 * per canvasId) and expose register/query/export/describe keyed by canvasId.
 * The lifecycle wrapper ({@link CanvasRegistry}) handles TTL, caps, and the
 * tenant authorization check before any provider call.
 * @module src/services/canvas/core/IDataCanvasProvider
 */

import type { RequestContext } from '@/utils/internal/requestContext.js';
import type {
  DescribeOptions,
  ExportOptions,
  ExportResult,
  ExportTarget,
  ImportFromOptions,
  QueryOptions,
  QueryResult,
  RegisterRows,
  RegisterTableOptions,
  RegisterTableResult,
  RegisterViewOptions,
  RegisterViewResult,
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

  /**
   * Drop a single canvas table or view. Returns `true` when found and removed.
   * The provider determines the kind from the catalog; callers don't need to
   * distinguish.
   */
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
   * Copy a table from another canvas (`sourceCanvasId`) into this one as
   * `asName`. Both canvases must already be authorized for the caller —
   * the lifecycle wrapper validates tenancy on both ids before this call.
   * Idempotent: a pre-existing target table with the same name is replaced.
   */
  importFrom(
    targetCanvasId: string,
    sourceCanvasId: string,
    sourceTableName: string,
    asName: string,
    context: RequestContext,
    options?: ImportFromOptions,
  ): Promise<RegisterTableResult>;

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

  /**
   * Register a SQL view on the canvas. The provider gates `selectSql` through
   * the same read-only enforcement `query()` applies, then installs the view.
   * Re-registering an existing view replaces it; conflicting with a base
   * table of the same name throws `ValidationError`.
   */
  registerView(
    canvasId: string,
    name: string,
    selectSql: string,
    context: RequestContext,
    options?: RegisterViewOptions,
  ): Promise<RegisterViewResult>;

  /** Tear down all engine resources. Called from `ServerHandle.shutdown()`. */
  shutdown(): Promise<void>;
}

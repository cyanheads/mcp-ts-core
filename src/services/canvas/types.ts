/**
 * @fileoverview Public types for the DataCanvas primitive — column schemas,
 * table info, and option/result shapes for register/query/export/describe.
 * Engine-agnostic; DuckDB is the current implementation.
 * @module src/services/canvas/types
 */

/**
 * Column type tag used when an explicit schema is provided to
 * {@link IDataCanvasProvider.registerTable}. The DuckDB provider maps these
 * to native DuckDB types; future engines map to their nearest equivalents.
 */
export type ColumnType =
  | 'VARCHAR'
  | 'INTEGER'
  | 'BIGINT'
  | 'DOUBLE'
  | 'BOOLEAN'
  | 'TIMESTAMP'
  | 'DATE'
  | 'JSON'
  | 'BLOB';

/** Single column declaration in an explicit table schema. */
export interface ColumnSchema {
  /** Column name. Validated against the canvas identifier rules. */
  name: string;
  /** Whether NULL values are permitted. Defaults to `true`. */
  nullable?: boolean;
  /** Column type tag. */
  type: ColumnType;
}

/** Metadata returned by {@link CanvasInstance.describe}. */
export interface TableInfo {
  /** Approximate in-memory footprint in bytes (engine-specific estimate). */
  approxSizeBytes?: number;
  /** Resolved schema for the table. */
  columns: ColumnSchema[];
  /** Canvas-local table name. */
  name: string;
  /** Number of rows currently stored. */
  rowCount: number;
}

/** Options for {@link CanvasInstance.registerTable}. */
export interface RegisterTableOptions {
  /**
   * Explicit schema. When omitted, the provider sniffs the first N rows
   * (default 100) to infer types, falling back to `VARCHAR` for ambiguous
   * columns. **Required** when `rows` is an `AsyncIterable` — the provider
   * cannot peek without consuming.
   */
  schema?: ColumnSchema[];
  /** Cancellation signal forwarded to the provider. */
  signal?: AbortSignal;
}

/** Result of a successful {@link CanvasInstance.registerTable} call. */
export interface RegisterTableResult {
  /** Column names in declaration order. */
  columns: string[];
  /** Number of rows ingested. */
  rowCount: number;
  /** Resolved (validated, quoted-safe) table name. */
  tableName: string;
}

/** Options for {@link CanvasInstance.query}. */
export interface QueryOptions {
  /**
   * Number of rows to include in the immediate response. Defaults to
   * `rowLimit`. Use a smaller value (e.g. 50) when `registerAs` is set and
   * the caller only wants a sample.
   */
  preview?: number;
  /**
   * Persist the result set as a new canvas table. The returned `rows` is
   * still bounded by `preview`/`rowLimit`; the full result lives on-canvas
   * under this name. Throws `Conflict` if a table with this name already
   * exists.
   */
  registerAs?: string;
  /**
   * Hard cap on rows materialized into the response. Default 10_000. To keep
   * a full result set, use `registerAs` (canonical) rather than raising this.
   */
  rowLimit?: number;
  /** Cancellation signal — interrupts the underlying connection. */
  signal?: AbortSignal;
}

/** Result of a successful {@link CanvasInstance.query} call. */
export interface QueryResult {
  /** Column names in projection order. */
  columns: string[];
  /** Total rows the query produced (may exceed `rows.length` when capped). */
  rowCount: number;
  /** Materialized rows (bounded by `preview`/`rowLimit`). */
  rows: Record<string, unknown>[];
  /** Set when `registerAs` was supplied. */
  tableName?: string;
}

/** Supported export formats. */
export type ExportFormat = 'csv' | 'parquet' | 'json';

/**
 * Discriminated export target. Path-targeted exports are sandboxed to
 * `CANVAS_EXPORT_PATH`; absolute paths and `..` traversal are rejected.
 */
export type ExportTarget =
  | { format: ExportFormat; path: string }
  | { format: ExportFormat; stream: WritableStream<Uint8Array> };

/** Options for {@link CanvasInstance.export}. */
export interface ExportOptions {
  /** Cancellation signal. */
  signal?: AbortSignal;
}

/** Result of a successful {@link CanvasInstance.export} call. */
export interface ExportResult {
  /** Format that was written. */
  format: ExportFormat;
  /** Absolute path written, when the target was a path; undefined for streams. */
  path?: string;
  /** Rows written. */
  rowCount: number;
  /** Bytes written. */
  sizeBytes: number;
}

/** Options for {@link CanvasInstance.describe}. */
export interface DescribeOptions {
  /** When set, return only the named table. */
  tableName?: string;
}

/** Options for {@link DataCanvas.acquire}. */
export interface AcquireOptions {
  /** Cancellation signal for the acquire/init handshake. */
  signal?: AbortSignal;
}

/**
 * Async row iterator accepted by {@link CanvasInstance.registerTable}.
 * Materialized arrays are also accepted; iterables are forwarded row-by-row
 * to the provider's appender.
 */
export type RegisterRows =
  | AsyncIterable<Record<string, unknown>>
  | Iterable<Record<string, unknown>>;

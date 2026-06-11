/**
 * @fileoverview Public contracts for the MirrorService — the source-agnostic
 * machinery for a persistent, self-refreshing local mirror of a bulk upstream
 * dataset. The framework owns the store, the sync-state machine, and the runner;
 * each server supplies only the ingester (`sync` generator) and the schema.
 * @module services/mirror/types
 */

import type { SqliteHandle, SqlValue } from './sqlite/handle.js';

export type { SqliteHandle, SqliteStatement, SqlValue } from './sqlite/handle.js';

/** One mirrored record — a flat object keyed by declared column name. */
export type MirrorRow = Record<string, SqlValue>;

/** Lifecycle state of a mirror's local dataset. */
export type SyncStatus = 'pending' | 'in_progress' | 'complete' | 'error';

/**
 * Duck-typed logger consumed by the runner. A sync runs outside the MCP request
 * pipeline (cron job or CLI script), so it has no request `Context` — any
 * logger with these methods works (the framework `logger`, a `ctx.log`, or a
 * console wrapper). All methods are optional.
 */
export interface MirrorLogger {
  debug?(message: string, meta?: object): void;
  error?(message: string, meta?: object): void;
  info?(message: string, meta?: object): void;
  notice?(message: string, meta?: object): void;
  warning?(message: string, meta?: object): void;
}

/**
 * Persisted sync state — the resume-on-interrupt checkpoint store. The two
 * position fields are deliberately distinct:
 *
 * - `cursor` is the **volatile** intra-run resume position (e.g. an OAI-PMH
 *   resumption token). It is valid only within a single run, may expire, and is
 *   cleared on completion. The runner threads it back into `sync()` to resume an
 *   interrupted init.
 * - `checkpoint` is the **durable** high-water mark (e.g. the max record
 *   datestamp). It advances monotonically and only on success, and seeds the
 *   next incremental refresh.
 *
 * They cannot be merged: for a token-paged source the mid-run cursor is not a
 * valid refresh seed, and the high-water mark is not a valid mid-run resume
 * position.
 */
export interface SyncState {
  /** Durable incremental high-water mark; advances only on success. */
  checkpoint?: string | undefined;
  /** ISO 8601 timestamp the last run completed successfully. Drives readiness. */
  completedAt?: string | undefined;
  /** Volatile intra-run resume position; cleared on completion. */
  cursor?: string | undefined;
  /** Message from the last failed run, set when `status === 'error'`. */
  error?: string | undefined;
  /** ISO 8601 timestamp the current run started. */
  startedAt?: string | undefined;
  status: SyncStatus;
  /** Record count, set when a sync completes. */
  total?: number | undefined;
}

/** Context passed to a server's `sync` generator on each run. */
export interface SyncContext {
  /** Durable high-water mark to harvest from (refresh; also init-resume recovery). */
  checkpoint?: string | undefined;
  /** Volatile resume position from a prior interrupted run (init only). */
  cursor?: string | undefined;
  /** `init` for a full harvest, `refresh` for an incremental one. */
  mode: SyncMode;
  /** Aborts the run; the generator should stop and the runner persists state. */
  signal: AbortSignal;
}

export type SyncMode = 'init' | 'refresh';

/**
 * One page yielded by a server's `sync` generator. The framework upserts the
 * records, deletes the tombstones, and persists the cursor/checkpoint — all in
 * one transaction per page — so an interrupt resumes from the last yielded page.
 */
export interface SyncPage {
  /**
   * Updated durable high-water mark after this page. Must be lexicographically
   * monotonic (e.g. ISO 8601) — the runner advances the stored checkpoint only
   * when a page's value compares greater.
   */
  checkpoint?: string | undefined;
  /** Updated volatile resume position after this page. */
  cursor?: string | undefined;
  /** Records to upsert (keyed by column name). */
  records: MirrorRow[];
  /** Primary-key values to delete (deleted upstream records). */
  tombstones?: string[];
}

/** A server's ingester: an async generator of pages from the upstream source. */
export type SyncGenerator = (ctx: SyncContext) => AsyncGenerator<SyncPage>;

/** Progress hook invoked after each persisted page. */
export type SyncProgress = (info: {
  pages: number;
  records: number;
  tombstones: number;
  cursor?: string | undefined;
  checkpoint?: string | undefined;
}) => void;

/** Options for a single sync run. */
export interface RunSyncOptions {
  mode: SyncMode;
  onProgress?: SyncProgress;
}

/** Outcome of a completed sync run. */
export interface SyncResult {
  pagesFetched: number;
  recordsApplied: number;
  tombstonesApplied: number;
  total: number;
}

/** Public status of a mirror — what tools surface to agents. */
export interface MirrorStatus {
  checkpoint?: string | undefined;
  completedAt?: string | undefined;
  error?: string | undefined;
  /**
   * `true` once a full sync has ever completed (`completedAt != null`), NOT
   * `status === 'complete'`. The dataset stays queryable during a refresh, so
   * readiness keys off the durable completion marker — an in-progress or failed
   * refresh on top of a complete mirror is still ready.
   */
  ready: boolean;
  startedAt?: string | undefined;
  status: SyncStatus;
  total?: number | undefined;
}

/** Comparison operators for a {@link QueryFilter}. */
export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';

/** A single structured filter applied as an indexed `WHERE` clause. */
export interface QueryFilter {
  /** Column to filter — must be a declared column. */
  column: string;
  op: FilterOp;
  /** Scalar for scalar ops; array for `in`. */
  value: SqlValue | SqlValue[];
}

/** Sort directive: by a declared column, or `'relevance'` (FTS bm25, requires `match`). */
export type QuerySort = { column: string; direction: 'asc' | 'desc' } | 'relevance';

/** Options for the generic {@link MirrorStore.query}. */
export interface QueryOptions {
  /** Structured filters, AND-combined. */
  filters?: QueryFilter[];
  limit: number;
  /** FTS5 `MATCH` expression. The server translates its own query syntax to FTS5. */
  match?: string | undefined;
  offset: number;
  /** Sort directive. Defaults to insertion order (rowid) when omitted. */
  sort?: QuerySort | undefined;
}

/** Result of a {@link MirrorStore.query}. */
export interface QueryResult {
  rows: MirrorRow[];
  /** Total matches before `limit`/`offset`. */
  total: number;
}

/** A schema migration: bump `version` and apply `up` on open when the stored version is lower. */
export interface Migration {
  /** Apply the migration. Runs inside the open handle; should be idempotent. */
  up(handle: SqliteHandle): void;
  /** Target schema version this migration produces. */
  version: number;
}

/**
 * Pluggable backend contract — the embedded-store half of a mirror. The default
 * implementation is `sqliteMirrorStore`; the interface leaves a clean path to
 * other backends (DuckDB, Postgres) without re-architecting the runner. All
 * methods lazy-open the underlying store on first call (async per the Tier-3
 * convention) and are then backed by synchronous driver calls. Stores are
 * async-disposable (`await using store = ...`); `[Symbol.asyncDispose]`
 * aliases {@link MirrorStore.close}.
 */
export interface MirrorStore extends AsyncDisposable {
  /** Upsert records and delete tombstoned primary keys in one transaction. */
  applyBatch(records: MirrorRow[], tombstones: string[]): Promise<void>;
  /** Close the underlying store. */
  close(): Promise<void>;
  /** Total record count. */
  count(): Promise<number>;
  /** Fetch records by primary-key list, preserving input order; missing keys skipped. */
  getByIds(ids: string[]): Promise<MirrorRow[]>;
  /** `PRAGMA integrity_check` + `quick_check`. */
  integrityCheck(): Promise<{ ok: boolean; results: string[] }>;
  /** Generic flat query: FTS `MATCH` + indexed filters + sort + pagination. */
  query(options: QueryOptions): Promise<QueryResult>;
  /**
   * The opened runtime-agnostic handle — the escape hatch for server-specific
   * access paths (auxiliary tables, junctions, custom indexes, bespoke queries)
   * that the generic `query()` does not cover.
   */
  raw(): Promise<SqliteHandle>;
  /** Read the persisted sync state. */
  readState(): Promise<SyncState>;
  /** Write the persisted sync state. Durable fields (`completedAt`/`total`) are preserved when omitted. */
  writeState(state: SyncState): Promise<void>;
}

/** Definition passed to {@link defineMirror}. */
export interface MirrorDefinition {
  /** Logger for sync runs; defaults to the framework `logger`. */
  logger?: MirrorLogger;
  /** Stable name for logs and telemetry (e.g. `'arxiv-papers'`). */
  name: string;
  /** The backend store (e.g. from `sqliteMirrorStore({...})`). */
  store: MirrorStore;
  /** The ingester — the one irreducibly per-source part. */
  sync: SyncGenerator;
}

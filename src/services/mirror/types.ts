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
  debug?(message: string, meta?: Readonly<Record<string, unknown>>): void;
  error?(message: string, meta?: Readonly<Record<string, unknown>>): void;
  info?(message: string, meta?: Readonly<Record<string, unknown>>): void;
  notice?(message: string, meta?: Readonly<Record<string, unknown>>): void;
  warning?(message: string, meta?: Readonly<Record<string, unknown>>): void;
}

/**
 * Persisted sync state — the resume-on-interrupt checkpoint store. The two
 * position fields are deliberately distinct:
 *
 * - `cursor` is the **volatile** intra-run resume position (e.g. an OAI-PMH
 *   resumption token). It is valid only within a single run, may expire, and is
 *   cleared on completion. The runner threads it back into `sync()` to resume an
 *   interrupted run of the same `mode`.
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
  /**
   * Mode of the run that wrote this state. It scopes `cursor`: a run resumes an
   * interrupted state's cursor only when its own mode matches. A state without
   * one reads as an `init`'s, as every state did before runs recorded it, so a
   * store must persist it for an interrupted `refresh` to resume.
   */
  mode?: SyncMode | undefined;
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
  /**
   * Volatile resume position from an interrupted run (`in_progress` or `error`)
   * of the same mode; absent otherwise. The source owns its validity: when the
   * upstream rejects it (an expired OAI-PMH resumption token, say), continue
   * from `checkpoint` in the same run. When the source throws instead, the run
   * records the same cursor again, so every later run of this mode fails on it.
   */
  cursor?: string | undefined;
  /** `init` for a full harvest, `refresh` for an incremental one. */
  mode: SyncMode;
  /** Aborts the run; the generator should stop and the runner persists state. */
  signal: AbortSignal;
}

export type SyncMode = 'init' | 'refresh';

/**
 * One page yielded by a server's `sync` generator. The framework upserts the
 * records, deletes the tombstones, and persists the cursor/checkpoint, so an
 * interrupt resumes from the last yielded page. With a store that provides a
 * `syncLease` (the SQLite store does), the three commit in one transaction per
 * page; a store without one commits the records and the state as two writes.
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
  /**
   * Apply the migration. Runs on first creation as well as on upgrade, against
   * a database that already has the current declarative schema, which it must
   * tolerate. It runs exactly once per database, in one write transaction with
   * its version stamp: concurrent openers wait on the write lock and then skip
   * it, and a throw leaves nothing of it applied, so it need not be idempotent.
   * A `handle.transaction()` inside it runs as a savepoint of that transaction.
   */
  up(handle: SqliteHandle): void;
  /** Target schema version this migration produces. */
  version: number;
}

/** A sync run's hold on a store's sync lease, returned by {@link SyncLeaseStore.claim}. */
export interface SyncLease {
  /** Claim counter. Every claim advances it, so a holder whose lease was taken over no longer matches. */
  generation: number;
  /** Random id of the run that claimed it. */
  owner: string;
  /** How long, in ms, the lease stays live after each commit or renewal. */
  ttlMs: number;
}

/**
 * The cross-process sync lease a store can provide. `runSync` claims it before
 * a run, makes every write of the run through `commit`, renews it between
 * pages, and releases it when the run settles. Each write checks the lease's
 * owner and generation inside the transaction that makes it, so a run whose
 * lease another process or instance took over writes nothing more.
 */
export interface SyncLeaseStore {
  /**
   * Claim the lease for `owner`, taking it over once its holder's expiry has
   * passed. Resolves `undefined` while another holder's lease is live, and
   * when another connection holds the store's write lock past `busy_timeout`.
   */
  claim(owner: string, ttlMs: number): Promise<SyncLease | undefined>;
  /**
   * Commit `state`, with a page's records and tombstones when given, in one
   * transaction, and push the lease's expiry out from the moment it commits.
   * Resolves `false`, having written nothing, when `lease` no longer holds.
   */
  commit(
    lease: SyncLease,
    state: SyncState,
    records?: MirrorRow[],
    tombstones?: string[],
  ): Promise<boolean>;
  /** Release the lease if `lease` still holds it; a lease taken over stays with its new holder. */
  release(lease: SyncLease): Promise<void>;
  /** Push the lease's expiry out by its TTL. Resolves `false` when `lease` no longer holds. */
  renew(lease: SyncLease): Promise<boolean>;
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
  /**
   * Fetch, for each id in order, the row whose primary key matches it as the
   * key column compares values: the row an `eq` filter on the key, or a
   * tombstone with that id, hits. Against an `INTEGER` key, `'1'` and `'01'`
   * both find key 1; a `TEXT` key matches exactly. A repeated id returns its
   * row at each position; an id with no row is skipped.
   */
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
  /**
   * Cross-process sync lease. With it, `runSync` rejects `Conflict`
   * (`data.reason: 'sync_locked'`) while another process or instance holds a
   * live lease on the store, and fences every write of a run on the lease.
   * Each page and the run's state then commit through the lease, not through
   * {@link MirrorStore.applyBatch} or {@link MirrorStore.writeState}, so a
   * wrapper that overrides those to observe or alter sync writes must omit it
   * (`const { syncLease, ...rest } = store`). Optional: a store without it gets
   * only `defineMirror`'s per-instance guard.
   */
  syncLease?: SyncLeaseStore;
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
  /**
   * How long, in ms, a sync run's lease stays live after its last commit or
   * renewal; a run renews it every third of this between pages. Once it lapses,
   * another process or instance may take the lease over, and the lapsed run
   * writes nothing more. A positive integer; default 120000 (2 minutes). Used
   * with a store that provides `syncLease`, the SQLite store included.
   */
  syncLeaseTtlMs?: number;
}

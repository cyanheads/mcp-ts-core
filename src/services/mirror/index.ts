/**
 * @fileoverview Public barrel for the MirrorService primitive. Servers import
 * from `@cyanheads/mcp-ts-core/mirror` to stand up a persistent, self-refreshing
 * local mirror of a bulk upstream dataset: declare a store + a `sync` generator
 * via {@link defineMirror}, then `runSync` / `query` / `status`.
 *
 * The SQLite driver is loaded lazily on first use, so importing this barrel does
 * not pull in `bun:sqlite` / `better-sqlite3` until a mirror is actually opened.
 *
 * @module services/mirror
 */

export { defineMirror, type Mirror, type MirrorRunOptions } from './core/defineMirror.js';
export { type RunnerContext, runSync } from './core/runner.js';
export {
  type OpenHandleOptions,
  openSqliteHandle,
  type SqliteHandle,
  type SqliteStatement,
  type SqlValue,
} from './sqlite/handle.js';
export {
  buildSchemaSql,
  DEFAULT_FTS_TOKENIZER,
  type SchemaSpec,
  validateSchemaSpec,
} from './sqlite/schema.js';
export {
  type SqliteMirrorStoreSpec,
  sqliteMirrorStore,
} from './sqlite/sqliteMirrorStore.js';
export type {
  FilterOp,
  Migration,
  MirrorDefinition,
  MirrorLogger,
  MirrorRow,
  MirrorStatus,
  MirrorStore,
  QueryFilter,
  QueryOptions,
  QueryResult,
  QuerySort,
  RunSyncOptions,
  SyncContext,
  SyncGenerator,
  SyncMode,
  SyncPage,
  SyncProgress,
  SyncResult,
  SyncState,
  SyncStatus,
} from './types.js';

/**
 * @fileoverview Runtime-agnostic SQLite handle for the mirror store. Uses the
 * built-in `bun:sqlite` driver under Bun and the `better-sqlite3` optional peer
 * dependency on Node — both exposed through one synchronous handle interface
 * (the intersection of the two driver APIs).
 *
 * The drivers are loaded via variable-specifier dynamic imports so the
 * framework typechecks and builds without `bun-types` in scope or
 * `better-sqlite3` installed; both resolve at runtime on the matching runtime.
 * @module services/mirror/sqlite/handle
 */

import { mkdir } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { configurationError, databaseError, McpError } from '@/types-global/errors.js';
import { runtimeCaps } from '@/utils/internal/runtime.js';

/** Primitive value storable in a mirror column. Buffers/bigints are out of scope for v1. */
export type SqlValue = string | number | null;

/**
 * Runtime-agnostic prepared statement — the intersection of the `bun:sqlite`
 * and `better-sqlite3` statement APIs. Bound parameters are passed positionally.
 */
export interface SqliteStatement<TRow = unknown> {
  all(...params: SqlValue[]): TRow[];
  get(...params: SqlValue[]): TRow | undefined;
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
}

/** Runtime-agnostic database handle. Synchronous — both drivers are synchronous. */
export interface SqliteHandle {
  close(): void;
  exec(sql: string): void;
  prepare<TRow = unknown>(sql: string): SqliteStatement<TRow>;
  transaction<T>(fn: () => T): T;
}

/** Options for {@link openSqliteHandle}. */
export interface OpenHandleOptions {
  /** `PRAGMA busy_timeout` in ms — how long a writer waits on a locked DB. Default 5000. */
  busyTimeoutMs?: number;
}

/**
 * Variable-specifier module IDs. Annotating as `string` (not the string
 * literal) stops `tsc` from statically resolving the module, so the framework
 * compiles without `bun-types` or `better-sqlite3` present. Each resolves at
 * runtime only on the runtime that ships it.
 */
const BUN_SQLITE_SPECIFIER: string = 'bun:sqlite';
const BETTER_SQLITE3_SPECIFIER: string = 'better-sqlite3';

/** The surface `bun:sqlite` and `better-sqlite3` share, as far as the mirror store uses it. */
interface SqliteDriver {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...p: unknown[]): unknown[];
    get(...p: unknown[]): unknown;
    run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  };
  transaction<T>(fn: () => T): () => T;
}

interface BunDatabaseCtor {
  new (
    path: string,
    options?: { create?: boolean; readwrite?: boolean },
  ): SqliteDriver & {
    /**
     * `close(true)` finalizes every outstanding statement and releases the
     * connection at once; bare `close()` leaves `prepare()`-created statements
     * live, holding the file open until they are garbage collected.
     */
    close(throwOnError?: boolean): void;
  };
}

interface BetterSqlite3Ctor {
  /** `close()` invalidates every statement created from the connection. */
  new (path: string): SqliteDriver & { close(): void };
}

/** Adapts a driver to the runtime-neutral {@link SqliteHandle}; `close` is driver-specific. */
function wrapDriver(db: SqliteDriver, close: () => void): SqliteHandle {
  return {
    close,
    exec: (sql) => {
      db.exec(sql);
    },
    prepare: <TRow>(sql: string): SqliteStatement<TRow> => {
      const stmt = db.prepare(sql);
      return {
        all: (...params) => stmt.all(...(params as unknown[])) as TRow[],
        get: (...params) => stmt.get(...(params as unknown[])) as TRow | undefined,
        run: (...params) => stmt.run(...(params as unknown[])),
      };
    },
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
  };
}

/**
 * Open (or create) a SQLite database at `path`, picking the driver for the
 * current runtime. Creates the parent directory, enables WAL, and sets
 * `busy_timeout` so a refresh writer and reader processes coexist without
 * spurious `database is locked` errors.
 *
 * Throws `ConfigurationError` on Node when `better-sqlite3` is not installed,
 * and `DatabaseError` for any other open failure.
 */
export async function openSqliteHandle(
  path: string,
  options: OpenHandleOptions = {},
): Promise<SqliteHandle> {
  await mkdir(dirname(resolvePath(path)), { recursive: true });
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;

  let handle: SqliteHandle;
  try {
    handle = runtimeCaps.isBun ? await openBunHandle(path) : await openBetterSqlite3Handle(path);
  } catch (err) {
    // The Node path throws a ConfigurationError when better-sqlite3 is absent —
    // preserve it rather than masking it as a generic open failure.
    if (err instanceof McpError) throw err;
    throw databaseError(`Failed to open mirror store at ${path}`, { path }, { cause: err });
  }

  // Connection pragmas. WAL allows one writer + concurrent readers; NORMAL
  // synchronous is the WAL-recommended durability/throughput balance.
  handle.exec(
    `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${busyTimeoutMs};`,
  );
  return handle;
}

/**
 * Bun driver. Closes with `close(true)` so statements the store still holds
 * (`applyBatch`'s per-call upsert/remove) are finalized with the connection
 * rather than keeping the file open until garbage collection. Bun 1.4 is the
 * floor for that call: earlier versions threw `database is locked` instead.
 */
async function openBunHandle(path: string): Promise<SqliteHandle> {
  const mod = (await import(BUN_SQLITE_SPECIFIER)) as unknown as { Database: BunDatabaseCtor };
  const db = new mod.Database(path, { create: true });
  return wrapDriver(db, () => db.close(true));
}

async function openBetterSqlite3Handle(path: string): Promise<SqliteHandle> {
  let mod: { default: BetterSqlite3Ctor };
  try {
    mod = (await import(BETTER_SQLITE3_SPECIFIER)) as unknown as { default: BetterSqlite3Ctor };
  } catch (err) {
    /* istanbul ignore next -- missing-dep path; better-sqlite3 is installed in the test env */
    throw configurationError(
      'Install "better-sqlite3" to use the SQLite mirror store on Node: bun add better-sqlite3',
      { path },
      { cause: err },
    );
  }
  const db = new mod.default(path);
  return wrapDriver(db, () => db.close());
}

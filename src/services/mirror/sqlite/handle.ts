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
import { basename, dirname, resolve as resolvePath } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
  /**
   * How long, in ms, a statement waits on another connection's lock
   * (`PRAGMA busy_timeout`), and how long the open keeps retrying the switch
   * to WAL, counted from when the open began. Default 5000.
   */
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

/** Pause between attempts to switch a contended file to WAL. */
const WAL_RETRY_INTERVAL_MS = 10;

/**
 * The caller-facing `data.recovery.hint` on a store that fails to open or
 * initialize. Worded to hold for every cause — a lock another process still
 * holds (`SQLITE_BUSY`), missing permissions, a corrupted file, a failed
 * migration — since none of them is something the request can change.
 */
export const MIRROR_STORE_UNAVAILABLE_HINT =
  "The server could not use its local mirror store, and changing the request will not help. Try again later, and report the failure to the server's operator if it persists.";

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
 * current runtime. Creates the parent directory, sets `busy_timeout` before
 * anything reads the file, then enables WAL, so a refresh writer and reader
 * processes coexist without spurious `database is locked` errors. An open that
 * meets another connection's lock waits it out for up to `busyTimeoutMs`.
 *
 * Throws `ConfigurationError` on Node when `better-sqlite3` is not installed,
 * and `DatabaseError` for any other open failure — creating the parent
 * directory included — with the driver or filesystem error on `cause` and the
 * connection already closed. Neither error carries the path, since a handler
 * forwards message and `data` to the caller: the `DatabaseError` names the
 * store by its basename and its `data` holds only a recovery hint, and the
 * `ConfigurationError` carries no `data`.
 */
export async function openSqliteHandle(
  path: string,
  options: OpenHandleOptions = {},
): Promise<SqliteHandle> {
  const startedAt = performance.now();
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;

  let handle: SqliteHandle | undefined;
  try {
    await mkdir(dirname(resolvePath(path)), { recursive: true });
    handle = runtimeCaps.isBun ? await openBunHandle(path) : await openBetterSqlite3Handle(path);
    // One statement per call: bun:sqlite's multi-statement `exec` drops the
    // step error of a statement followed by more text (oven-sh/bun#37415).
    // NORMAL synchronous is the WAL-recommended durability/throughput balance.
    handle.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    await enableWal(handle, startedAt + busyTimeoutMs);
    handle.exec('PRAGMA synchronous = NORMAL');
    handle.exec('PRAGMA foreign_keys = ON');
    return handle;
  } catch (err) {
    handle?.close();
    // The Node path throws a ConfigurationError when better-sqlite3 is absent —
    // preserve it rather than masking it as a generic open failure.
    if (err instanceof McpError) throw err;
    throw databaseError(
      `Failed to open mirror store "${basename(path)}".`,
      { recovery: { hint: MIRROR_STORE_UNAVAILABLE_HINT } },
      { cause: err },
    );
  }
}

/**
 * Switch the connection to WAL, which lets one writer and concurrent readers
 * share the file. The switch is the open's first read of the file, and the
 * busy handler waits out a lock met there. Converting a rollback-mode file
 * also takes a RESERVED lock, which SQLite never waits for through the busy
 * handler (it fails at once to avoid deadlock), so a `SQLITE_BUSY*` result is
 * retried here until `deadline`. Runs through `prepare().get()` so a step
 * error always surfaces, on `bun:sqlite` too.
 */
async function enableWal(handle: SqliteHandle, deadline: number): Promise<void> {
  for (;;) {
    try {
      handle.prepare('PRAGMA journal_mode = WAL').get();
      return;
    } catch (err) {
      if (!isBusy(err) || performance.now() >= deadline) throw err;
      await delay(WAL_RETRY_INTERVAL_MS);
    }
  }
}

/** Both drivers name the extended result code on `code`: `SQLITE_BUSY`, `SQLITE_BUSY_RECOVERY`, … */
function isBusy(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('SQLITE_BUSY');
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
      undefined,
      { cause: err },
    );
  }
  const db = new mod.default(path);
  return wrapDriver(db, () => db.close());
}

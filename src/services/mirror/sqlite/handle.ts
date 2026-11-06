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
import {
  configurationError,
  databaseError,
  McpError,
  validationError,
} from '@/types-global/errors.js';
import { runtimeCaps } from '@/utils/internal/runtime.js';

/**
 * Primitive value storable in a mirror column. Values outside it that
 * unvalidated JSON or a source can still produce bind the same on both
 * drivers: a boolean as the integer `1`/`0` (`'1'`/`'0'` in a `TEXT` column),
 * a `bigint` in the signed 64-bit range as an integer, and a `Uint8Array` as a
 * blob. A `bigint` outside that range is refused with `ValidationError`, as is
 * an object, array, or `Date` in the store's records, tombstones, ids,
 * filters, and `match`.
 */
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
  /**
   * Run `fn` in a transaction: committed when it returns, rolled back when it
   * throws. `'deferred'` (the default) takes the write lock at its first
   * write; `'immediate'` takes it at `BEGIN`, waiting up to `busy_timeout` for
   * another connection's, so a read inside `fn` cannot go stale before `fn`
   * writes. Called inside another transaction, it runs as a savepoint of it.
   */
  transaction<T>(fn: () => T, mode?: 'deferred' | 'immediate'): T;
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
  /** Both drivers return a callable that begins `DEFERRED`, with `.immediate()` beginning `IMMEDIATE`. */
  transaction<T>(fn: () => T): (() => T) & { immediate(): T };
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

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * Give the positional parameters of a statement one binding on both drivers.
 * A boolean binds as the integer `1n`/`0n`: `bun:sqlite` already binds it as
 * an integer, `better-sqlite3` refuses it, and a JS number would bind as REAL
 * on `better-sqlite3`, storing `'1.0'` in a `TEXT` column. A bigint outside
 * the signed 64-bit range is refused, where `bun:sqlite` would wrap it and
 * `better-sqlite3` throw a `RangeError`. Objects pass through untouched: bound
 * alone, one is the driver's named-parameter list. `params` is the call's own
 * rest array, so a boolean is replaced in place and nothing is allocated.
 */
function bindParams(params: unknown[]): unknown[] {
  for (let i = 0; i < params.length; i++) {
    const value = params[i];
    if (typeof value === 'boolean') {
      params[i] = value ? 1n : 0n;
    } else if (typeof value === 'bigint' && (value < INT64_MIN || value > INT64_MAX)) {
      throw validationError(
        `Mirror SQL parameter ${i + 1} is a bigint outside the signed 64-bit range SQLite stores; pass it as a string instead.`,
        { parameter: i + 1 },
      );
    }
  }
  return params;
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
        all: (...params) => stmt.all(...bindParams(params)) as TRow[],
        get: (...params) => stmt.get(...bindParams(params)) as TRow | undefined,
        run: (...params) => stmt.run(...bindParams(params)),
      };
    },
    transaction: <T>(fn: () => T, mode: 'deferred' | 'immediate' = 'deferred'): T => {
      /**
       * The driver's own wrapper issues ROLLBACK only while a transaction is
       * still open, so an error that already ended it is the one that surfaces.
       */
      const run = db.transaction(fn);
      return mode === 'immediate' ? run.immediate() : run();
    },
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
export function isBusy(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
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

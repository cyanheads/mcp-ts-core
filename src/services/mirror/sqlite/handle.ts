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
import { enginesFloor, isBelow, parseVersionTriple } from '@/utils/internal/versionTriple.js';

import frameworkPackageJson from '../../../../package.json' with { type: 'json' };

/**
 * Primitive value storable in a mirror column. A number binds the same on both
 * drivers: a safe integer other than `-0` as an integer (`'2024'`, not
 * `'2024.0'`, in a `TEXT` column), any other number as REAL, and `NaN` as
 * NULL; an integer column reads back as a number either way. Values outside it
 * that unvalidated JSON or a source can still produce bind the same on both
 * drivers too: a boolean as the integer `1`/`0` (`'1'`/`'0'` in a `TEXT`
 * column), a `bigint` in the signed 64-bit range as an integer, and bytes (an
 * `ArrayBuffer`, `SharedArrayBuffer`, `DataView`, typed array, or `Buffer`) as
 * a blob of the bytes they view. A `bigint` outside that range is refused with
 * `ValidationError`, as is an object, array, or `Date` in the store's records,
 * tombstones, ids, filters, and `match`.
 */
export type SqlValue = string | number | null;

/**
 * Runtime-agnostic prepared statement — the intersection of the `bun:sqlite`
 * and `better-sqlite3` statement APIs. Parameters bind the same on both
 * drivers in two forms: positionally, for anonymous `?` placeholders, as
 * separate arguments or as one array passed alone (`get([a, b])` binds as
 * `get(a, b)`); or as one plain object passed alone, keyed by name without the
 * prefix, for `$name`, `:name`, and `@name` placeholders. An array's elements
 * and an object's values are mapped as positional values are, in a copy, so
 * the caller's array or object is never changed. Numbered `?NNN` placeholders,
 * prefixed keys, an object beside positional values, and an array beside other
 * arguments each bind differently on the two drivers.
 */
export interface SqliteStatement<TRow = unknown> {
  all(...params: SqlValue[]): TRow[];
  get(...params: SqlValue[]): TRow | undefined;
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
}

/** Runtime-agnostic database handle. Synchronous — both drivers are synchronous. */
export interface SqliteHandle {
  close(): void;
  /**
   * Run every statement in `sql`, in order, outside any transaction. The
   * first statement that fails throws, and nothing after it runs; the
   * statements before it stay applied.
   */
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

/** `data.reason` of the refusal an open on a Bun below the `engines.bun` floor throws. */
const UNSUPPORTED_BUN_REASON = 'unsupported_bun_version';

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
 * Give a statement's parameters one binding on both drivers. Each positional
 * value is mapped by {@link bindValue}, in place: `params` is the call's own
 * rest array. An array or a plain object is mapped into a copy, so the
 * caller's own is never changed. An array's elements are mapped as positional
 * values, since both drivers read an array passed alone as its elements bound
 * positionally; a plain object is the driver's named-parameter list, so its
 * own values are mapped keyed as the caller keyed them. Positions count an
 * array's elements where `better-sqlite3` spreads them, so a refusal names the
 * position that driver binds the value at, which is `bun:sqlite`'s too
 * wherever it binds the value: a leading array, whose elements alone it binds.
 */
function bindParams(params: unknown[]): unknown[] {
  let position = 0;
  for (let i = 0; i < params.length; i++) {
    const value = params[i];
    if (Array.isArray(value)) {
      const before = position;
      params[i] = Array.from(value, (element, j) => bindValue(element, before + j + 1));
      position += value.length;
      continue;
    }
    position += 1;
    params[i] = isPlainObject(value)
      ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, bindValue(v, key)]))
      : bindValue(value, position);
  }
  return params;
}

/**
 * The binding both drivers give `value`, the parameter at position or key
 * `parameter`. `better-sqlite3` binds every JS number as REAL and `bun:sqlite`
 * a safe integer as INTEGER, so a safe integer other than `-0` is passed as a
 * bigint: an INTEGER on both, storing `'5'`, not `'5.0'`, in a `TEXT` column.
 * Other numbers (`-0`, fractions, `±Infinity`, whole numbers past the safe
 * range) bind as REAL on both, and `NaN` as NULL; neither driver reads a bound
 * bigint back as anything but a number. A boolean binds as the integer
 * `1n`/`0n`, which `bun:sqlite` already does and `better-sqlite3` refuses. A
 * bigint outside the signed 64-bit range is refused, where `bun:sqlite` would
 * wrap it and `better-sqlite3` throw a `RangeError`. An `ArrayBuffer`,
 * `SharedArrayBuffer`, or `DataView` is passed as a `Uint8Array` over the same
 * bytes: `bun:sqlite` binds each as a blob of the bytes it views, while
 * `better-sqlite3` refuses them, and a `DataView` where it reads its
 * named-parameter object ends the process. Typed arrays already bind as a
 * blob of their viewed bytes on both.
 */
function bindValue(value: unknown, parameter: number | string): unknown {
  switch (typeof value) {
    case 'number':
      return Number.isSafeInteger(value) && !Object.is(value, -0) ? BigInt(value) : value;
    case 'boolean':
      return value ? 1n : 0n;
    case 'bigint':
      if (value < INT64_MIN || value > INT64_MAX) {
        const name = typeof parameter === 'number' ? parameter : JSON.stringify(parameter);
        throw validationError(
          `Mirror SQL parameter ${name} is a bigint outside the signed 64-bit range SQLite stores; pass it as a string instead.`,
          { parameter },
        );
      }
      return value;
    case 'object':
      if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
        return new Uint8Array(value);
      }
      if (value instanceof DataView) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      }
      return value;
    default:
      return value;
  }
}

/** An object whose prototype is `Object.prototype` or `null`: what `better-sqlite3` reads as named parameters. */
function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
        // bun:sqlite reports no row as null, better-sqlite3 as undefined; a row is always an object.
        get: (...params) => (stmt.get(...bindParams(params)) ?? undefined) as TRow | undefined,
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
 * Throws `ConfigurationError` on a Bun below the framework's `engines.bun`
 * floor (`data.reason: 'unsupported_bun_version'`) before it creates or opens
 * anything, on Node when `better-sqlite3` is not installed, and `DatabaseError`
 * for any other open failure — creating the parent directory included — with
 * the driver or filesystem error on `cause` and the connection already closed.
 * None of them carries the path, since a handler forwards message and `data`
 * to the caller: the `DatabaseError` names the store by its basename and its
 * `data` holds only a recovery hint, and a `ConfigurationError` carries at
 * most a `reason`.
 */
export async function openSqliteHandle(
  path: string,
  options: OpenHandleOptions = {},
): Promise<SqliteHandle> {
  assertSupportedBunVersion();
  const startedAt = performance.now();
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;

  let handle: SqliteHandle | undefined;
  try {
    await mkdir(dirname(resolvePath(path)), { recursive: true });
    handle = runtimeCaps.isBun ? await openBunHandle(path) : await openBetterSqlite3Handle(path);
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
 * Refuses a Bun below the framework's `engines.bun` floor. Before Bun 1.4.4,
 * `bun:sqlite`'s `exec` drops the error of a failing statement that more SQL
 * follows and runs the rest (oven-sh/bun#37415), so a migration that fails
 * partway would run its remaining statements and be recorded as applied.
 * `bun:sqlite` offers no way to step through a statement list, so `exec`
 * cannot be wrapped to catch it; and Bun enforces `engines` neither at install
 * nor at run, so the open checks the version itself. Node.js is never checked,
 * and neither is a Bun version with no leading `X.Y.Z`.
 *
 * @throws {McpError} `ConfigurationError` naming the floor and the running
 *   version, with `data.reason` `unsupported_bun_version`.
 */
function assertSupportedBunVersion(): void {
  if (!runtimeCaps.isBun) return;
  const floor = enginesFloor(frameworkPackageJson.engines.bun);
  const running = process.versions.bun;
  const version = running === undefined ? undefined : parseVersionTriple(running);
  if (!floor || !version || !isBelow(version, floor)) return;
  throw configurationError(
    `The SQLite mirror store needs Bun ${floor.join('.')} or later, but this server is running Bun ${running}. Upgrade Bun, or run the server on Node.js with the "better-sqlite3" peer dependency installed.`,
    { reason: UNSUPPORTED_BUN_REASON },
  );
}

/**
 * Bun driver. Closes with `close(true)` so statements the store still holds
 * (`applyBatch`'s per-call upsert/remove) are finalized with the connection
 * rather than keeping the file open until garbage collection; Bun before 1.4
 * threw `database is locked` on that call instead.
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
      'The SQLite mirror store on Node.js needs the optional peer dependency "better-sqlite3", which is not installed. Add it to the server\'s dependencies, or run the server on Bun, which has SQLite built in.',
      undefined,
      { cause: err },
    );
  }
  const db = new mod.default(path);
  return wrapDriver(db, () => db.close());
}

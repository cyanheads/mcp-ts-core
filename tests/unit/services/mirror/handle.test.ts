/**
 * @fileoverview Tests for the runtime-agnostic SQLite handle — prepare/exec/query
 * against the driver actually available on this test runtime, connection pragmas,
 * parameter binding of values the two drivers treat differently, open/close
 * lifecycle including statement finalization on close, and the driver-selection /
 * missing-driver branches.
 *
 * Runtime note: this suite runs under two configs with different SQLite drivers.
 * `bunx vitest` (pool: 'forks') executes under Node with `better-sqlite3`, while
 * `bun run test:all` (test:coverage) executes under Bun with `bun:sqlite` — so the
 * Bun driver branch is exercised on the release gate. The two drivers differ in
 * low-level behavior (no-match get() → undefined vs null, and parameter-mismatch
 * error text), so assertions here stay driver-agnostic and the
 * better-sqlite3-only driver-selection branches are gated to the Node runtime.
 * @module tests/unit/services/mirror/handle
 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MIRROR_STORE_UNAVAILABLE_HINT,
  type OpenHandleOptions,
  openSqliteHandle,
  type SqliteHandle,
} from '@/services/mirror/sqlite/handle.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { runtimeCaps } from '@/utils/internal/runtime.js';

/**
 * The active SQLite driver depends on the runtime: `bun:sqlite` under Bun
 * (test:coverage), `better-sqlite3` under Node (the forks pool). Branch tests
 * that are meaningful for only one driver are gated on this flag.
 */
const IS_BUN = runtimeCaps.isBun;

/** Root ignores file modes, so a `chmod` cannot make a path unreadable or unwritable. */
const RUNNING_AS_ROOT = process.getuid?.() === 0;

/** Variable specifiers, as in handle.ts, so neither tsc nor Vite resolves a driver statically. */
const BUN_SQLITE_SPECIFIER: string = 'bun:sqlite';
const BETTER_SQLITE3_SPECIFIER: string = 'better-sqlite3';

/** A driver connection opened outside the handle under test. */
interface RawConnection {
  close(): void;
  exec(sql: string): void;
}

/** The driver class `openSqliteHandle` constructs on this runtime. */
type DriverClass = (new (path: string) => RawConnection) & { prototype: RawConnection };

async function loadDriver(): Promise<DriverClass> {
  if (IS_BUN) {
    return ((await import(BUN_SQLITE_SPECIFIER)) as { Database: DriverClass }).Database;
  }
  return ((await import(BETTER_SQLITE3_SPECIFIER)) as { default: DriverClass }).default;
}

describe('openSqliteHandle', () => {
  let dir: string;
  let handles: SqliteHandle[];
  let holders: RawConnection[];
  /** Paths a test `chmod`ed, with the mode to put back before the temp dir is removed. */
  let modes: Array<[path: string, mode: number]>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mirror-handle-test-'));
    handles = [];
    holders = [];
    modes = [];
  });

  afterEach(async () => {
    for (const h of handles) {
      try {
        h.close();
      } catch {
        // Already closed by the test body — fine.
      }
    }
    // Closing rolls back whatever transaction a holder still has open.
    for (const holder of holders) holder.close();
    for (const [path, mode] of modes) await chmod(path, mode);
    await rm(dir, { recursive: true, force: true });
  });

  /** Opens a handle rooted under the temp dir and tracks it for cleanup. */
  async function open(relPath: string, options?: Parameters<typeof openSqliteHandle>[1]) {
    const handle = await openSqliteHandle(join(dir, relPath), options);
    handles.push(handle);
    return handle;
  }

  /** Sets `path`'s mode for the test body; `afterEach` puts `restore` back. */
  async function setMode(path: string, mode: number, restore: number) {
    await chmod(path, mode);
    modes.push([path, restore]);
  }

  /** Runs an open expected to reject and returns the rejection. */
  async function openFailure(path: string): Promise<unknown> {
    return openSqliteHandle(path).then(
      (handle) => {
        handles.push(handle);
        throw new Error(`Expected the open of ${path} to reject.`);
      },
      (err: unknown) => err,
    );
  }

  /**
   * What a failed open puts on the wire (#635): the store named by its
   * basename, `data` holding only the recovery hint, no host directory.
   */
  function expectStoreNamedByBasename(error: unknown, fileName: string) {
    expect(error).toBeInstanceOf(McpError);
    const { message, data } = error as McpError;
    expect(message).toBe(`Failed to open mirror store "${fileName}".`);
    expect(message).not.toContain(dir);
    expect(data).toEqual({ recovery: { hint: MIRROR_STORE_UNAVAILABLE_HINT } });
  }

  describe('driver selection on this runtime', () => {
    it.skipIf(IS_BUN)(
      'wraps a Bun-driver failure as a DatabaseError when runtimeCaps.isBun is forced true on this Node runtime',
      async () => {
        // No `bun:sqlite` module exists under Node, so forcing the Bun branch
        // exercises a real (not mocked) failure of openBunHandle(), proving the
        // top-level catch in openSqliteHandle correctly classifies a non-McpError
        // driver failure as a DatabaseError rather than letting it leak raw.
        const original = runtimeCaps.isBun;
        runtimeCaps.isBun = true;
        try {
          const error = await openFailure(join(dir, 'forced-bun.db'));
          expect(error).toMatchObject({ code: JsonRpcErrorCode.DatabaseError });
          expectStoreNamedByBasename(error, 'forced-bun.db');
        } finally {
          runtimeCaps.isBun = original;
        }
      },
    );

    /**
     * Bun selects bun:sqlite and cannot exercise a missing better-sqlite3 import.
     * The required test:node lane runs this failure-path assertion.
     */
    it.skipIf(IS_BUN)(
      'rejects with ConfigurationError when the better-sqlite3 dependency cannot be imported',
      async () => {
        vi.resetModules();
        vi.doMock('better-sqlite3', () => {
          throw new Error("Cannot find module 'better-sqlite3'");
        });
        try {
          const { openSqliteHandle: openWithMissingDriver } = await import(
            '@/services/mirror/sqlite/handle.js'
          );
          const error = await openWithMissingDriver(join(dir, 'missing-driver.db')).catch(
            (err: unknown) => err,
          );
          expect(error).toMatchObject({
            code: JsonRpcErrorCode.ConfigurationError,
            message:
              'Install "better-sqlite3" to use the SQLite mirror store on Node: bun add better-sqlite3',
            cause: expect.any(Error),
          });
          // No `data` at all, so the store's path never reaches the caller (#635).
          expect((error as { data?: unknown }).data).toBeUndefined();
        } finally {
          vi.doUnmock('better-sqlite3');
          vi.resetModules();
        }
      },
    );
  });

  describe('connection pragmas', () => {
    it('enables WAL journal mode, NORMAL synchronous, and foreign keys', async () => {
      const handle = await open('pragma.db');
      expect(
        handle.prepare<{ journal_mode: string }>('PRAGMA journal_mode').get()?.journal_mode,
      ).toBe('wal');
      // 1 = NORMAL, the WAL-recommended durability setting.
      expect(handle.prepare<{ synchronous: number }>('PRAGMA synchronous').get()?.synchronous).toBe(
        1,
      );
      expect(
        handle.prepare<{ foreign_keys: number }>('PRAGMA foreign_keys').get()?.foreign_keys,
      ).toBe(1);
    });

    it('applies a custom busy_timeout when provided', async () => {
      const handle = await open('pragma-custom.db', { busyTimeoutMs: 1234 });
      expect(handle.prepare<{ timeout: number }>('PRAGMA busy_timeout').get()?.timeout).toBe(1234);
    });

    it('defaults busy_timeout to 5000ms when not specified', async () => {
      const handle = await open('pragma-default.db');
      expect(handle.prepare<{ timeout: number }>('PRAGMA busy_timeout').get()?.timeout).toBe(5000);
    });
  });

  /**
   * Another connection holds a lock while the open runs. The holder sits in
   * this process, which SQLite's unix VFS locks per connection like separate
   * processes. Timing bounds are a lower bound at `busyTimeoutMs` plus a
   * generous ceiling that still sits below better-sqlite3's own 5000 ms
   * default, so they hold on a loaded machine.
   */
  describe('open under another connection lock', () => {
    /**
     * Creates a rollback-mode file at `path` holding one row, then leaves a
     * write transaction open on it at `lock` from a raw driver connection.
     */
    async function holdLock(path: string, lock: 'EXCLUSIVE' | 'IMMEDIATE') {
      const Driver = await loadDriver();
      const holder = new Driver(path);
      holders.push(holder);
      holder.exec('CREATE TABLE t (x)');
      holder.exec('INSERT INTO t VALUES (1)');
      holder.exec(`BEGIN ${lock}`);
      holder.exec('INSERT INTO t VALUES (2)');
      return holder;
    }

    /** Runs an open expected to reject; reports the rejection, its timing, and driver close() calls. */
    async function failedOpen(path: string, options: OpenHandleOptions) {
      const Driver = await loadDriver();
      const close = vi.spyOn(Driver.prototype, 'close');
      try {
        const started = performance.now();
        const error = await openSqliteHandle(path, options).then(
          (handle) => {
            handles.push(handle);
            throw new Error(`Expected the open of ${path} to reject.`);
          },
          (err: unknown) => err,
        );
        return {
          error,
          elapsedMs: performance.now() - started,
          closeCalls: close.mock.calls.length,
        };
      } finally {
        close.mockRestore();
      }
    }

    it('waits busyTimeoutMs on an exclusive lock, then rejects with DatabaseError and closes the connection', async () => {
      const path = join(dir, 'exclusive.db');
      await holdLock(path, 'EXCLUSIVE');

      const { error, elapsedMs, closeCalls } = await failedOpen(path, { busyTimeoutMs: 200 });

      expect(closeCalls).toBe(1);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.DatabaseError,
        cause: { code: 'SQLITE_BUSY' },
      });
      expectStoreNamedByBasename(error, 'exclusive.db');
      expect(elapsedMs).toBeGreaterThanOrEqual(200);
      expect(elapsedMs).toBeLessThan(2000);
    });

    it('switches to WAL once an immediate lock is released within busyTimeoutMs', async () => {
      // Converting a rollback-mode file to WAL needs a RESERVED lock, which
      // SQLite never waits for through the busy handler — only a retry does.
      const holder = await holdLock(join(dir, 'immediate-released.db'), 'IMMEDIATE');
      const release = setTimeout(() => holder.exec('ROLLBACK'), 100);
      try {
        const handle = await open('immediate-released.db', { busyTimeoutMs: 2000 });

        expect(
          handle.prepare<{ journal_mode: string }>('PRAGMA journal_mode').get()?.journal_mode,
        ).toBe('wal');
        // The pragmas after the WAL switch ran too.
        expect(
          handle.prepare<{ foreign_keys: number }>('PRAGMA foreign_keys').get()?.foreign_keys,
        ).toBe(1);
        expect(handle.prepare<{ timeout: number }>('PRAGMA busy_timeout').get()?.timeout).toBe(
          2000,
        );
        expect(handle.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM t').get()?.n).toBe(1);
      } finally {
        clearTimeout(release);
      }
    });

    it('rejects with DatabaseError once busyTimeoutMs passes under an immediate lock that is never released', async () => {
      const path = join(dir, 'immediate-held.db');
      await holdLock(path, 'IMMEDIATE');

      const { error, elapsedMs, closeCalls } = await failedOpen(path, { busyTimeoutMs: 300 });

      expect(closeCalls).toBe(1);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.DatabaseError,
        cause: { code: 'SQLITE_BUSY' },
      });
      expectStoreNamedByBasename(error, 'immediate-held.db');
      expect(elapsedMs).toBeGreaterThanOrEqual(300);
      expect(elapsedMs).toBeLessThan(3000);
    });

    it('rejects a non-SQLite file with DatabaseError without retrying, and closes the connection', async () => {
      const path = join(dir, 'not-a-database.db');
      await writeFile(path, 'x'.repeat(4096));

      const { error, elapsedMs, closeCalls } = await failedOpen(path, { busyTimeoutMs: 2000 });

      expect(closeCalls).toBe(1);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.DatabaseError,
        cause: { code: 'SQLITE_NOTADB' },
      });
      expectStoreNamedByBasename(error, 'not-a-database.db');
      // A retry would hold the open until the 2000 ms budget ran out.
      expect(elapsedMs).toBeLessThan(2000);
    });
  });

  /** A store the process cannot open or create. Root ignores file modes, so both cases skip there. */
  describe('unopenable store (#635)', () => {
    it.skipIf(RUNNING_AS_ROOT)(
      'rejects a store file with no permissions as a DatabaseError naming it by basename',
      async () => {
        const path = join(dir, 'store', 'records.db');
        (await open('store/records.db')).close();
        await setMode(path, 0o000, 0o644);

        const error = await openFailure(path);

        expect(error).toMatchObject({
          code: JsonRpcErrorCode.DatabaseError,
          cause: { code: 'SQLITE_CANTOPEN' },
        });
        expectStoreNamedByBasename(error, 'records.db');
      },
    );

    it.skipIf(RUNNING_AS_ROOT)(
      'rejects a store whose parent directory cannot be created as a DatabaseError, not a raw EACCES',
      async () => {
        const locked = join(dir, 'locked');
        await mkdir(locked);
        await setMode(locked, 0o555, 0o755);

        const error = await openFailure(join(locked, 'data', 'records.db'));

        // A raw `EACCES` would be classified Forbidden (-32005) at the handler.
        expect(error).toMatchObject({
          code: JsonRpcErrorCode.DatabaseError,
          cause: { code: 'EACCES' },
        });
        expectStoreNamedByBasename(error, 'records.db');
      },
    );
  });

  describe('prepare / exec / query', () => {
    it('creates a table, inserts a row, and reads it back via get() and all()', async () => {
      const handle = await open('crud.db');
      handle.exec('CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT)');
      const insert = handle.prepare('INSERT INTO t (id, name) VALUES (?, ?)');
      const result = insert.run('1', 'Alice');
      expect(result.changes).toBe(1);
      expect(['number', 'bigint']).toContain(typeof result.lastInsertRowid);

      const row = handle
        .prepare<{ id: string; name: string }>('SELECT * FROM t WHERE id = ?')
        .get('1');
      expect(row).toEqual({ id: '1', name: 'Alice' });

      const all = handle.prepare<{ id: string }>('SELECT id FROM t').all();
      expect(all).toEqual([{ id: '1' }]);
    });

    it('transaction() commits every write on success', async () => {
      const handle = await open('txn-commit.db');
      handle.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
      const insert = handle.prepare('INSERT INTO t (id) VALUES (?)');
      handle.transaction(() => {
        insert.run('1');
        insert.run('2');
      });
      expect(handle.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM t').get()?.n).toBe(2);
    });

    it('transaction() rolls back every write when the callback throws partway through', async () => {
      const handle = await open('txn-rollback.db');
      handle.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
      const insert = handle.prepare('INSERT INTO t (id) VALUES (?)');
      expect(() =>
        handle.transaction(() => {
          insert.run('1'); // succeeds
          insert.run('1'); // duplicate PK — throws mid-transaction
        }),
      ).toThrow(/UNIQUE constraint failed/);
      // The first insert.run('1') is rolled back too — atomicity, not partial apply.
      expect(handle.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM t').get()?.n).toBe(0);
    });

    it("transaction(fn, 'immediate') takes the write lock at BEGIN; a deferred one waits for its first write", async () => {
      const writer = await open('txn-immediate.db');
      writer.exec('CREATE TABLE t (id TEXT)');
      // A second connection that fails at once rather than waiting on a lock.
      const other = await open('txn-immediate.db', { busyTimeoutMs: 0 });
      const writeFromOther = (): string => {
        try {
          other.prepare('INSERT INTO t (id) VALUES (?)').run('other');
          return 'written';
        } catch (err) {
          return String((err as { code?: unknown }).code);
        }
      };

      expect(writer.transaction(writeFromOther, 'immediate')).toBe('SQLITE_BUSY');
      expect(writer.transaction(writeFromOther)).toBe('written');
      expect(writer.transaction(writeFromOther, 'deferred')).toBe('written');
    });

    it("transaction(fn, 'immediate') rolls back on a throw and nests an inner transaction as a savepoint", async () => {
      const handle = await open('txn-immediate-nested.db');
      handle.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
      const insert = handle.prepare('INSERT INTO t (id) VALUES (?)');
      const ids = () => handle.prepare<{ id: string }>('SELECT id FROM t ORDER BY id').all();

      handle.transaction(() => {
        insert.run('outer');
        handle.transaction(() => insert.run('inner-kept'));
        expect(() =>
          handle.transaction(() => {
            insert.run('inner-undone');
            throw new Error('inner rollback');
          }),
        ).toThrow('inner rollback');
      }, 'immediate');
      expect(ids()).toEqual([{ id: 'inner-kept' }, { id: 'outer' }]);

      expect(() =>
        handle.transaction(() => {
          insert.run('undone');
          throw new Error('outer rollback');
        }, 'immediate'),
      ).toThrow('outer rollback');
      expect(ids()).toEqual([{ id: 'inner-kept' }, { id: 'outer' }]);
    });

    it('creates missing parent directories before opening', async () => {
      const nested = join(dir, 'a', 'b', 'c', 'nested.db');
      const handle = await openSqliteHandle(nested);
      handles.push(handle);
      handle.exec('CREATE TABLE t (id TEXT)');
      expect(handle.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM t').get()?.n).toBe(0);
    });
  });

  /**
   * Values outside `SqlValue` that the two drivers would bind differently on
   * their own get one binding on both runtimes, through every statement method.
   */
  describe('parameter binding', () => {
    /** A runtime value outside the declared parameter type, as unvalidated JSON or a source produces. */
    const untyped = (value: unknown) => value as never;

    it('binds a boolean as the integer 1 or 0 in every column type, through run(), get(), and all()', async () => {
      const handle = await open('booleans.db');
      handle.exec('CREATE TABLE t (k TEXT, s TEXT, i INTEGER, r REAL, x)');
      const insert = handle.prepare('INSERT INTO t VALUES (?, ?, ?, ?, ?)');
      insert.run('true', untyped(true), untyped(true), untyped(true), untyped(true));
      insert.run('false', untyped(false), untyped(false), untyped(false), untyped(false));

      expect(
        handle
          .prepare(
            'SELECT k, s, typeof(s) AS ts, i, typeof(i) AS ti, r, typeof(r) AS tr, x, typeof(x) AS tx FROM t ORDER BY k DESC',
          )
          .all(),
      ).toEqual([
        {
          k: 'true',
          s: '1',
          ts: 'text',
          i: 1,
          ti: 'integer',
          r: 1,
          tr: 'real',
          x: 1,
          tx: 'integer',
        },
        {
          k: 'false',
          s: '0',
          ts: 'text',
          i: 0,
          ti: 'integer',
          r: 0,
          tr: 'real',
          x: 0,
          tx: 'integer',
        },
      ]);
      expect(
        handle.prepare('SELECT v, typeof(v) AS ty FROM (SELECT ? AS v)').get(untyped(true)),
      ).toEqual({ v: 1, ty: 'integer' });
      expect(handle.prepare('SELECT k FROM t WHERE x = ?').all(untyped(false))).toEqual([
        { k: 'false' },
      ]);
    });

    it.each([
      ['2n ** 63n', 2n ** 63n],
      ['2n ** 70n', 2n ** 70n],
      ['-(2n ** 63n) - 1n', -(2n ** 63n) - 1n],
    ])(
      'rejects the bigint %s, outside the signed 64-bit range, naming its parameter position, through run(), get(), and all()',
      async (_label, value) => {
        const handle = await open('bigint-out-of-range.db');
        handle.exec('CREATE TABLE t (a TEXT, n INTEGER)');
        const insert = handle.prepare('INSERT INTO t VALUES (?, ?)');
        const select = handle.prepare('SELECT a FROM t WHERE a = ? AND n = ?');
        const refusal = expect.objectContaining({
          code: JsonRpcErrorCode.ValidationError,
          message:
            'Mirror SQL parameter 2 is a bigint outside the signed 64-bit range SQLite stores; pass it as a string instead.',
          data: { parameter: 2 },
        });

        expect(() => insert.run('a', untyped(value))).toThrowError(refusal);
        expect(handle.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM t').get()?.n).toBe(0);
        expect(() => select.get('a', untyped(value))).toThrowError(refusal);
        expect(() => select.all('a', untyped(value))).toThrowError(refusal);
      },
    );

    it('binds both signed 64-bit bounds and a small bigint as integers', async () => {
      const handle = await open('bigint-bounds.db');
      expect(
        handle
          .prepare(
            'SELECT CAST(a AS TEXT) AS a, typeof(a) AS ta, CAST(b AS TEXT) AS b, typeof(b) AS tb, c, typeof(c) AS tc FROM (SELECT ? AS a, ? AS b, ? AS c)',
          )
          .get(untyped(2n ** 63n - 1n), untyped(-(2n ** 63n)), untyped(5n)),
      ).toEqual({
        a: '9223372036854775807',
        ta: 'integer',
        b: '-9223372036854775808',
        tb: 'integer',
        c: 5,
        tc: 'integer',
      });
    });

    it("passes a lone object through as the driver's named parameters", async () => {
      const handle = await open('named.db');
      // bun:sqlite keys named parameters with their prefix; better-sqlite3 without it.
      const named = IS_BUN ? { $a: 'seven' } : { a: 'seven' };
      expect(handle.prepare('SELECT $a AS v').get(untyped(named))).toEqual({ v: 'seven' });
    });
  });

  describe('lifecycle: open / close / use-after-close', () => {
    it('close() is idempotent — calling it a second time does not throw', async () => {
      const handle = await openSqliteHandle(join(dir, 'double-close.db'));
      handle.close();
      expect(() => handle.close()).not.toThrow();
    });

    it('finalizes a statement prepared before close() so it can no longer write', async () => {
      // bun:sqlite's bare close() leaves prepare()d statements live — a
      // pre-close statement could still insert into the "closed" database. The
      // handle closes with close(true) there; better-sqlite3 invalidates
      // statements on close already, so the contract holds on both drivers.
      const handle = await openSqliteHandle(join(dir, 'closed-statement.db'));
      handle.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
      const insert = handle.prepare('INSERT INTO t (id) VALUES (?)');
      insert.run('1');
      handle.close();
      expect(() => insert.run('2')).toThrow();
      expect(() => insert.all()).toThrow();
    });
  });
});

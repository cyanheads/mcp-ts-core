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
 * low-level behavior (parameter-mismatch error text, among others), so
 * assertions here stay driver-agnostic and the better-sqlite3-only
 * driver-selection branches are gated to the Node runtime.
 * @module tests/unit/services/mirror/handle
 */

import { existsSync } from 'node:fs';
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
import packageJson from '../../../../package.json' with { type: 'json' };
import { runMirrorProcess } from './mirror-process.js';

/**
 * The active SQLite driver depends on the runtime: `bun:sqlite` under Bun
 * (test:coverage), `better-sqlite3` under Node (the forks pool). Branch tests
 * that are meaningful for only one driver are gated on this flag.
 */
const IS_BUN = runtimeCaps.isBun;

/** Ceiling for a test that runs a child process, which loads `src/` before its first statement. */
const PROCESS_TIMEOUT_MS = 60_000;

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
              'The SQLite mirror store on Node.js needs the optional peer dependency "better-sqlite3", which is not installed. Add it to the server\'s dependencies, or run the server on Bun, which has SQLite built in.',
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

  /**
   * Bun below the floor drops the error of a failing statement that more SQL
   * follows in one `exec`, so the open refuses it. The version is stubbed, and
   * `runtimeCaps.isBun` forced on, so the refusal runs on both test lanes.
   */
  describe('Bun engines floor', () => {
    const versionsDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'versions',
    ) as PropertyDescriptor;
    const originalIsBun = runtimeCaps.isBun;

    /** Stubs what the check reads: the reported Bun version and the runtime flag. */
    function reportBun(bun: string, isBun = true): void {
      Object.defineProperty(process, 'versions', {
        ...versionsDescriptor,
        value: { ...versionsDescriptor.value, bun },
      });
      runtimeCaps.isBun = isBun;
    }

    afterEach(() => {
      Object.defineProperty(process, 'versions', versionsDescriptor);
      runtimeCaps.isBun = originalIsBun;
    });

    it('refuses to open on a Bun below the floor, naming both versions, before it creates anything', async () => {
      reportBun('1.4.3');
      const parent = join(dir, 'never-created');

      const error = await openFailure(join(parent, 'records.db'));

      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ConfigurationError,
        message:
          'The SQLite mirror store needs Bun 1.4.4 or later, but this server is running Bun 1.4.3. Upgrade Bun, or run the server on Node.js with the "better-sqlite3" peer dependency installed.',
        data: { reason: 'unsupported_bun_version' },
      });
      expect(existsSync(parent)).toBe(false);
    });

    it.runIf(IS_BUN).each([
      ['the floor itself', '1.4.4'],
      ['a version string with no X.Y.Z', 'custom-build'],
    ])('opens on %s (%s)', async (_label, bun) => {
      reportBun(bun);
      const handle = await open(`floor-${bun}.db`);
      handle.exec('CREATE TABLE t (id TEXT)');
      expect(handle.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM t').get()?.n).toBe(0);
    });

    it.skipIf(IS_BUN)('never checks Node.js, whatever Bun version a process reports', async () => {
      reportBun('1.0.0', false);
      const handle = await open('node-not-checked.db');
      handle.exec('CREATE TABLE t (id TEXT)');
      expect(handle.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM t').get()?.n).toBe(0);
    });

    it('reads its floor from an engines.bun that is a single >=X.Y.Z comparator', () => {
      expect(packageJson.engines.bun).toMatch(/^>=\d+\.\d+\.\d+$/);
    });
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

    it('get() returns undefined when no row matches, for a SELECT and for an UPDATE … RETURNING, and the row when its one column is NULL', async () => {
      const handle = await open('get-miss.db');
      handle.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)');
      handle.prepare('INSERT INTO t (id, n) VALUES (?, ?)').run('1', null);

      expect(handle.prepare('SELECT 1 AS n WHERE 0').get()).toBeUndefined();
      expect(handle.prepare('SELECT id FROM t WHERE id = ?').get('missing')).toBeUndefined();
      expect(
        handle.prepare('UPDATE t SET n = 1 WHERE id = ? RETURNING id').get('missing'),
      ).toBeUndefined();
      expect(handle.prepare('SELECT NULL AS n').get()).toEqual({ n: null });
      expect(handle.prepare('SELECT n FROM t WHERE id = ?').get('1')).toEqual({ n: null });
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

    /** The ids in `u`, ascending, as one comma-separated string. */
    const ids = (handle: SqliteHandle) =>
      handle
        .prepare<{ ids: string }>(
          'SELECT group_concat(id) AS ids FROM (SELECT id FROM u ORDER BY id)',
        )
        .get()?.ids;

    it('runs every statement of a multi-statement exec that succeeds', async () => {
      const handle = await open('multi-ok.db');
      handle.exec('CREATE TABLE u (id INTEGER PRIMARY KEY); INSERT INTO u VALUES (1);');
      handle.exec('INSERT INTO u VALUES (2); INSERT INTO u VALUES (3); INSERT INTO u VALUES (4);');
      expect(ids(handle)).toBe('1,2,3,4');
    });

    it.each([
      ['the first', 'INSERT INTO u VALUES (1); INSERT INTO u VALUES (2);', '1'],
      [
        'a middle',
        'INSERT INTO u VALUES (3); INSERT INTO u VALUES (1); INSERT INTO u VALUES (4);',
        '1,3',
      ],
    ])(
      'throws when %s statement of a multi-statement exec fails, and runs nothing after it',
      async (_label, sql, kept) => {
        const handle = await open('multi-fail.db');
        handle.exec('CREATE TABLE u (id INTEGER PRIMARY KEY); INSERT INTO u VALUES (1);');

        let error: unknown;
        try {
          handle.exec(sql);
        } catch (err) {
          error = err;
        }

        expect(error).toMatchObject({ code: expect.stringMatching(/^SQLITE_CONSTRAINT/) });
        // exec opens no transaction: a statement before the failure stays applied.
        expect(ids(handle)).toBe(kept);
      },
    );
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

    it('binds a safe integer as an integer in every column type, through run(), get(), and all()', async () => {
      const handle = await open('safe-integers.db');
      handle.exec('CREATE TABLE t (k TEXT, s TEXT, i INTEGER, r REAL, nu NUMERIC, b BLOB, x)');
      const insert = handle.prepare('INSERT INTO t VALUES (?, ?, ?, ?, ?, ?, ?)');
      insert.run('a-five', 5, 5, 5, 5, 5, 5);
      insert.run('b-year', 2024, 2024, 2024, 2024, 2024, 2024);

      const columns = (n: number, text: string) => ({
        s: text,
        ts: 'text',
        i: n,
        ti: 'integer',
        r: n,
        tr: 'real',
        nu: n,
        tnu: 'integer',
        b: n,
        tb: 'integer',
        x: n,
        tx: 'integer',
      });
      expect(
        handle
          .prepare(
            'SELECT k, s, typeof(s) AS ts, i, typeof(i) AS ti, r, typeof(r) AS tr, nu, typeof(nu) AS tnu, b, typeof(b) AS tb, x, typeof(x) AS tx FROM t ORDER BY k',
          )
          .all(),
      ).toEqual([
        { k: 'a-five', ...columns(5, '5') },
        { k: 'b-year', ...columns(2024, '2024') },
      ]);
      expect(handle.prepare('SELECT typeof(?) AS t, CAST(? AS TEXT) AS text').get(5, 5)).toEqual({
        t: 'integer',
        text: '5',
      });
      expect(handle.prepare('SELECT k FROM t WHERE s = ?').all('2024')).toEqual([{ k: 'b-year' }]);
    });

    it.each([
      ['-0', 'real', -0, '0.0'],
      ['1.5', 'real', 1.5, '1.5'],
      ['2 ** 53', 'real', 2 ** 53, '9007199254740992.0'],
      ['1e21', 'real', 1e21, '1.0e+21'],
      ['Infinity', 'real', Number.POSITIVE_INFINITY, 'Inf'],
      ['NaN', 'null', Number.NaN, null],
    ])(
      'binds the number %s as %s, outside the safe integers that bind as integers',
      async (_label, type, value, text) => {
        const handle = await open('non-integers.db');
        expect(
          handle.prepare('SELECT typeof(?) AS t, CAST(? AS TEXT) AS text').get(value, value),
        ).toEqual({ t: type, text });
      },
    );

    it('reads a bound or stored safe integer back as a number, not a bigint', async () => {
      const handle = await open('integer-readback.db');
      handle.exec('CREATE TABLE t (i INTEGER, x)');
      const result = handle.prepare('INSERT INTO t VALUES (?, ?)').run(2024, 7);
      expect(result.changes).toBe(1);

      expect(handle.prepare('SELECT ? AS v').get(5)).toEqual({ v: 5 });
      expect(handle.prepare('SELECT i, x FROM t').all()).toEqual([{ i: 2024, x: 7 }]);
      const row = handle.prepare<{ i: unknown; x: unknown }>('SELECT i, x FROM t').get();
      expect([typeof row?.i, typeof row?.x]).toEqual(['number', 'number']);
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

    it.each(['$', ':', '@'])(
      'binds a lone plain object by unprefixed key to %sa parameters, the spelling both drivers accept',
      async (prefix) => {
        const handle = await open('named.db');
        expect(handle.prepare(`SELECT ${prefix}a AS v`).get(untyped({ a: 'seven' }))).toEqual({
          v: 'seven',
        });
      },
    );

    it("maps a named-parameter object's values as it maps positional ones", async () => {
      const handle = await open('named-values.db');
      expect(
        handle
          .prepare(
            'SELECT $t AS t, typeof($t) AS tt, $f AS f, CAST($n AS TEXT) AS n, typeof($n) AS tn, CAST($big AS TEXT) AS big, $s AS s, $z AS z',
          )
          .get(untyped({ t: true, f: false, n: 2024, big: 2n ** 63n - 1n, s: 'text', z: null })),
      ).toEqual({
        t: 1,
        tt: 'integer',
        f: 0,
        n: '2024',
        tn: 'integer',
        big: '9223372036854775807',
        s: 'text',
        z: null,
      });
    });

    it('maps a null-prototype named-parameter object as it maps a plain one', async () => {
      const handle = await open('named-null-prototype.db');
      const nullPrototype = (fields: Record<string, unknown>) =>
        Object.assign(Object.create(null) as Record<string, unknown>, fields);

      expect(
        handle
          .prepare('SELECT $t AS t, typeof($t) AS tt, CAST($n AS TEXT) AS n')
          .get(untyped(nullPrototype({ t: true, n: 2024 }))),
      ).toEqual({ t: 1, tt: 'integer', n: '2024' });
      expect(() =>
        handle.prepare('SELECT $wide AS wide').get(untyped(nullPrototype({ wide: 2n ** 64n }))),
      ).toThrowError(
        expect.objectContaining({
          code: JsonRpcErrorCode.ValidationError,
          data: { parameter: 'wide' },
        }),
      );
    });

    it('rejects a bigint outside the signed 64-bit range in a named-parameter object, naming its key', async () => {
      const handle = await open('named-bigint.db');
      expect(() =>
        handle.prepare('SELECT $a AS a, $wide AS wide').get(untyped({ a: 1, wide: 2n ** 64n })),
      ).toThrowError(
        expect.objectContaining({
          code: JsonRpcErrorCode.ValidationError,
          message:
            'Mirror SQL parameter "wide" is a bigint outside the signed 64-bit range SQLite stores; pass it as a string instead.',
          data: { parameter: 'wide' },
        }),
      );
    });

    it('leaves the named-parameter object the caller passed unchanged', async () => {
      const handle = await open('named-unchanged.db');
      const view = new DataView(new Uint8Array([1, 2]).buffer);
      const named = { a: true, b: 7, c: view };
      expect(handle.prepare('SELECT $a AS a, $b AS b, hex($c) AS c').get(untyped(named))).toEqual({
        a: 1,
        b: 7,
        c: '0102',
      });
      expect(named).toStrictEqual({ a: true, b: 7, c: view });
      expect(named.c).toBe(view);
    });

    /**
     * Both drivers read one array passed alone as its elements bound
     * positionally. Beside other arguments they part ways: `bun:sqlite` binds a
     * leading array alone and ignores what follows, and refuses a later one,
     * while `better-sqlite3` spreads every array where it sits.
     */
    it('binds an array passed alone as its elements bound positionally, each mapped as a positional value is, through run(), get(), and all()', async () => {
      const handle = await open('array-alone.db');
      handle.exec('CREATE TABLE t (k TEXT, s TEXT, i INTEGER, x)');
      handle.prepare('INSERT INTO t VALUES (?, ?, ?, ?)').run(untyped(['a', 2024, true, 5]));

      expect(
        handle
          .prepare('SELECT k, s, typeof(s) AS ts, i, typeof(i) AS ti, x, typeof(x) AS tx FROM t')
          .all(),
      ).toEqual([{ k: 'a', s: '2024', ts: 'text', i: 1, ti: 'integer', x: 5, tx: 'integer' }]);
      expect(
        handle.prepare('SELECT v, typeof(v) AS t FROM (SELECT ? AS v)').get(untyped([5])),
      ).toEqual({ v: 5, t: 'integer' });
      expect(
        handle.prepare('SELECT k FROM t WHERE i = ? AND s = ?').all(untyped([true, 2024])),
      ).toEqual([{ k: 'a' }]);
    });

    it.each<[string, unknown[], number]>([
      ['passed alone', [[1, 2n ** 64n]], 2],
      ['after another argument', ['a', [true, 2n ** 64n]], 3],
      ['before another argument', [[2n ** 64n], 'a'], 1],
    ])(
      'rejects a bigint outside the signed 64-bit range in an array %s, naming the position better-sqlite3 binds it at',
      async (_label, args, parameter) => {
        const handle = await open('array-bigint.db');
        const select = handle.prepare('SELECT ? AS a, ? AS b, ? AS c');
        const refusal = expect.objectContaining({
          code: JsonRpcErrorCode.ValidationError,
          message: `Mirror SQL parameter ${parameter} is a bigint outside the signed 64-bit range SQLite stores; pass it as a string instead.`,
          data: { parameter },
        });
        expect(() => select.get(...args.map(untyped))).toThrowError(refusal);
        expect(() => select.all(...args.map(untyped))).toThrowError(refusal);
        expect(() => select.run(...args.map(untyped))).toThrowError(refusal);
      },
    );

    it('leaves the array the caller passed unchanged', async () => {
      const handle = await open('array-unchanged.db');
      const view = new DataView(new Uint8Array([1, 2]).buffer);
      const args = [true, 7, view];
      expect(
        handle.prepare('SELECT ? AS a, typeof(?) AS b, hex(?) AS c').get(untyped(args)),
      ).toEqual({ a: 1, b: 'integer', c: '0102' });
      expect(args).toStrictEqual([true, 7, view]);
      expect(args[2]).toBe(view);
    });

    /** Each value views the bytes `01 02`, whatever the platform's byte order. */
    const byteValues: Array<[string, () => unknown]> = [
      ['an ArrayBuffer', () => new Uint8Array([1, 2]).buffer],
      [
        'a SharedArrayBuffer',
        () => {
          const shared = new SharedArrayBuffer(2);
          new Uint8Array(shared).set([1, 2]);
          return shared;
        },
      ],
      ['a DataView', () => new DataView(new Uint8Array([1, 2]).buffer)],
      [
        'a DataView with a byte offset',
        () => new DataView(new Uint8Array([9, 1, 2, 9]).buffer, 1, 2),
      ],
      ['a Uint16Array', () => new Uint16Array(new Uint8Array([1, 2]).buffer)],
      ['a Buffer', () => Buffer.from([1, 2])],
      ['a Uint8Array with a byte offset', () => new Uint8Array([9, 1, 2, 9]).subarray(1, 3)],
    ];

    it.each(byteValues)(
      'binds %s as a blob of the bytes it views, positionally and in a named-parameter object, through run(), get(), and all()',
      async (_label, bytes) => {
        const handle = await open('bytes.db');
        handle.exec('CREATE TABLE t (k TEXT, b BLOB)');
        handle.prepare('INSERT INTO t VALUES (?, ?)').run('positional', untyped(bytes()));
        handle.prepare('INSERT INTO t VALUES ($k, $b)').run(untyped({ k: 'named', b: bytes() }));

        expect(
          handle
            .prepare('SELECT k, typeof(b) AS t, hex(b) AS h FROM t WHERE b = ? ORDER BY k')
            .all(untyped(bytes())),
        ).toEqual([
          { k: 'named', t: 'blob', h: '0102' },
          { k: 'positional', t: 'blob', h: '0102' },
        ]);
        expect(
          handle.prepare('SELECT typeof($v) AS t, hex($v) AS h').get(untyped({ v: bytes() })),
        ).toEqual({ t: 'blob', h: '0102' });
      },
    );

    it.each(byteValues)(
      'binds %s inside an array passed alone as a blob of the bytes it views',
      async (_label, bytes) => {
        const handle = await open('array-bytes.db');
        expect(
          handle.prepare('SELECT typeof(?) AS t, hex(?) AS h').get(untyped([bytes(), bytes()])),
        ).toEqual({ t: 'blob', h: '0102' });
      },
    );

    /**
     * Bound bare where a statement with named or numbered parameters reads its
     * named-parameter object, a `DataView` once ended a Node process inside
     * `better-sqlite3`, past any `try`; a child process stands in for the
     * runner's own.
     */
    it.each<[string, unknown[]]>([
      ['SELECT ?1 AS v', []],
      ['SELECT $a AS v', []],
      ['SELECT ? AS u, $a AS v', [1]],
    ])(
      'binds a bare DataView to %s as a Uint8Array there binds, and the process keeps running',
      async (sql, leading) => {
        const report = await runMirrorProcess({
          role: 'bind',
          path: join(dir, 'bare-dataview.db'),
          sql,
          leading,
        });
        expect(report.dataView).toEqual(report.uint8Array);
        // better-sqlite3 refuses bytes where it reads the named-parameter object, catchably.
        if (!IS_BUN) expect(report.dataView.ok).toBe(false);
      },
      PROCESS_TIMEOUT_MS,
    );
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

/**
 * @fileoverview Tests for the runtime-agnostic SQLite handle — prepare/exec/query
 * against the driver actually available on this test runtime, connection pragmas,
 * open/close lifecycle including statement finalization on close, and the
 * driver-selection / missing-driver branches.
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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHandle, type SqliteHandle } from '@/services/mirror/sqlite/handle.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { runtimeCaps } from '@/utils/internal/runtime.js';

/**
 * The active SQLite driver depends on the runtime: `bun:sqlite` under Bun
 * (test:coverage), `better-sqlite3` under Node (the forks pool). Branch tests
 * that are meaningful for only one driver are gated on this flag.
 */
const IS_BUN = runtimeCaps.isBun;

describe('openSqliteHandle', () => {
  let dir: string;
  let handles: SqliteHandle[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mirror-handle-test-'));
    handles = [];
  });

  afterEach(async () => {
    for (const h of handles) {
      try {
        h.close();
      } catch {
        // Already closed by the test body — fine.
      }
    }
    await rm(dir, { recursive: true, force: true });
  });

  /** Opens a handle rooted under the temp dir and tracks it for cleanup. */
  async function open(relPath: string, options?: Parameters<typeof openSqliteHandle>[1]) {
    const handle = await openSqliteHandle(join(dir, relPath), options);
    handles.push(handle);
    return handle;
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
          await expect(open('forced-bun.db')).rejects.toMatchObject({
            code: JsonRpcErrorCode.DatabaseError,
          });
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
          await expect(openWithMissingDriver(join(dir, 'missing-driver.db'))).rejects.toMatchObject(
            {
              code: JsonRpcErrorCode.ConfigurationError,
              message: expect.stringContaining('better-sqlite3'),
            },
          );
        } finally {
          vi.doUnmock('better-sqlite3');
          vi.resetModules();
        }
      },
    );
  });

  describe('connection pragmas', () => {
    it('enables WAL journal mode and foreign keys', async () => {
      const handle = await open('pragma.db');
      expect(
        handle.prepare<{ journal_mode: string }>('PRAGMA journal_mode').get()?.journal_mode,
      ).toBe('wal');
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

    it('creates missing parent directories before opening', async () => {
      const nested = join(dir, 'a', 'b', 'c', 'nested.db');
      const handle = await openSqliteHandle(nested);
      handles.push(handle);
      handle.exec('CREATE TABLE t (id TEXT)');
      expect(handle.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM t').get()?.n).toBe(0);
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

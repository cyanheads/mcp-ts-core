/**
 * @fileoverview Unit tests for the D1Provider.
 * @module tests/storage/providers/cloudflare/d1Provider.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { encodeCursor } from '../../../../../src/storage/core/storageValidation.js';
import { D1Provider } from '../../../../../src/storage/providers/cloudflare/d1Provider.js';
import { JsonRpcErrorCode, McpError } from '../../../../../src/types-global/errors.js';

// Mock D1Database
const createMockD1Database = () => ({
  prepare: vi.fn().mockReturnValue({
    bind: vi.fn().mockReturnValue({
      first: vi.fn(),
      run: vi.fn(),
      all: vi.fn(),
    }),
  }),
  batch: vi.fn(),
});

/** D1's per-statement bound-parameter limit: https://developers.cloudflare.com/d1/platform/limits/ */
const D1_BOUND_PARAMETER_LIMIT = 100;

interface StoredRow {
  expiresAt?: number | null;
  key: string;
  tenant: string;
  value: unknown;
}

interface FakeStatement {
  params: unknown[];
  sql: string;
}

/**
 * A D1 fake that answers the `getMany` SELECT (`tenant_id = ? AND key IN (…)
 * AND (expires_at IS NULL OR expires_at > ?)`) from stored rows and, like D1,
 * rejects any statement binding more than 100 parameters — on `all()` and inside
 * `batch()` alike, where one failing statement fails the whole batch.
 */
const createRowStoreD1 = (rows: StoredRow[]) => {
  const execute = (statement: FakeStatement) => {
    if (statement.params.length > D1_BOUND_PARAMETER_LIMIT) {
      throw new Error('D1_ERROR: too many SQL variables: SQLITE_ERROR');
    }
    const [tenant, ...rest] = statement.params;
    const now = rest.pop() as number;
    const keys = new Set(rest);
    return {
      results: rows
        .filter(
          (row) =>
            row.tenant === tenant &&
            keys.has(row.key) &&
            (row.expiresAt == null || row.expiresAt > now),
        )
        .map((row) => ({
          key: row.key,
          value: JSON.stringify(row.value),
          expires_at: row.expiresAt ?? null,
        })),
    };
  };
  const all = vi.fn(async (statement: FakeStatement) => execute(statement));
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: (...params: unknown[]) => {
        const statement: FakeStatement & { all: () => Promise<unknown> } = {
          sql,
          params,
          all: () => all(statement),
        };
        return statement;
      },
    })),
    batch: vi.fn(async (statements: FakeStatement[]) => statements.map(execute)),
  };
  return { all, db };
};

describe('D1Provider', () => {
  let d1Provider: D1Provider;
  let mockDb: ReturnType<typeof createMockD1Database>;
  let context: RequestContext;

  beforeEach(() => {
    mockDb = createMockD1Database();
    d1Provider = new D1Provider(mockDb as any);
    context = requestContextService.createRequestContext({
      operation: 'test-d1-provider',
    });
  });

  describe('constructor', () => {
    it('should throw McpError when db is not provided', () => {
      expect(() => new D1Provider(null as any)).toThrow(McpError);
      expect(() => new D1Provider(null as any)).toThrow(
        /D1Provider requires a valid D1Database instance/,
      );
    });

    it('should accept valid table names', () => {
      expect(() => new D1Provider(mockDb as any, 'kv_store')).not.toThrow();
      expect(() => new D1Provider(mockDb as any, '_private')).not.toThrow();
      expect(() => new D1Provider(mockDb as any, 'Table1')).not.toThrow();
      expect(() => new D1Provider(mockDb as any, 'a'.repeat(64))).not.toThrow();
    });

    it('should reject invalid table names (SQL injection prevention)', () => {
      // Starts with number
      expect(() => new D1Provider(mockDb as any, '1table')).toThrow(McpError);
      expect(() => new D1Provider(mockDb as any, '1table')).toThrow(/valid SQL identifier/);

      // Contains special characters
      expect(() => new D1Provider(mockDb as any, 'table; DROP TABLE')).toThrow(McpError);
      expect(() => new D1Provider(mockDb as any, "table' OR 1=1")).toThrow(McpError);
      expect(() => new D1Provider(mockDb as any, 'table-name')).toThrow(McpError);
      expect(() => new D1Provider(mockDb as any, 'table.name')).toThrow(McpError);

      // Empty string
      expect(() => new D1Provider(mockDb as any, '')).toThrow(McpError);

      // Too long (65 chars)
      expect(() => new D1Provider(mockDb as any, 'a'.repeat(65))).toThrow(McpError);
    });
  });

  describe('get', () => {
    it('should return null if key not found', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.first.mockResolvedValue(null);

      const result = await d1Provider.get('tenant-1', 'key-1', context);
      expect(result).toBeNull();
    });

    it('should return parsed JSON value if found and not expired', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.first.mockResolvedValue({
        value: JSON.stringify({ data: 'test' }),
        expires_at: null,
      });

      const result = await d1Provider.get<{ data: string }>('tenant-1', 'key-1', context);
      expect(result).toEqual({ data: 'test' });
    });

    it('should return null and lazy-delete expired entries', async () => {
      const prepared = mockDb.prepare();
      const stmt = prepared.bind();
      stmt.first.mockResolvedValue({
        value: JSON.stringify({ data: 'stale' }),
        expires_at: Date.now() - 1000,
      });
      stmt.run.mockResolvedValue({ meta: { changes: 1 } });

      const result = await d1Provider.get('tenant-1', 'key-1', context);
      expect(result).toBeNull();
      expect(mockDb.prepare).toHaveBeenLastCalledWith(
        'DELETE FROM kv_store WHERE tenant_id = ? AND key = ?',
      );
      expect(prepared.bind).toHaveBeenLastCalledWith('tenant-1', 'key-1');
      expect(stmt.run).toHaveBeenCalledOnce();
    });

    it('should throw McpError on JSON parse failure', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.first.mockResolvedValue({
        value: 'invalid-json{{{',
        expires_at: null,
      });

      await expect(d1Provider.get('tenant-1', 'key-1', context)).rejects.toThrow(McpError);
    });

    it('should propagate database errors from get', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.first.mockRejectedValue(new Error('D1_ERROR: no such table: kv_store'));

      await expect(d1Provider.get('tenant-1', 'key-1', context)).rejects.toThrow(McpError);
    });
  });

  describe('set', () => {
    it('should bind a null expires_at when no TTL is provided', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.run.mockResolvedValue({ meta: { changes: 1 } });
      const prepared = mockDb.prepare();

      await d1Provider.set('tenant-1', 'key-1', { data: 'test' }, context);

      expect(prepared.bind).toHaveBeenCalledWith(
        'tenant-1',
        'key-1',
        JSON.stringify({ data: 'test' }),
        null,
      );
    });

    it('should bind a computed expires_at when a TTL is provided', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.run.mockResolvedValue({ meta: { changes: 1 } });
      const prepared = mockDb.prepare();
      const before = Date.now();

      await d1Provider.set('tenant-1', 'key-1', { data: 'test' }, context, { ttl: 3600 });

      // The setup call above (`.bind()` with no args, to configure `stmt.run`) is
      // itself recorded on this shared mock — the real call from set() is the last one.
      const calls = prepared.bind.mock.calls as [string, string, string, number][];
      const call = calls[calls.length - 1] as [string, string, string, number];
      expect(call[3]).toBeGreaterThanOrEqual(before + 3600 * 1000);
      expect(call[3]).toBeLessThan(before + 3600 * 1000 + 1000);
    });

    it('should propagate database errors from set', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.run.mockRejectedValue(new Error('D1_ERROR: database is locked'));

      await expect(d1Provider.set('tenant-1', 'key-1', { data: 'test' }, context)).rejects.toThrow(
        McpError,
      );
    });
  });

  describe('delete', () => {
    it('should return true if row was deleted', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.run.mockResolvedValue({ meta: { changes: 1 } });

      const result = await d1Provider.delete('tenant-1', 'key-1', context);
      expect(result).toBe(true);
    });

    it('should return false if row did not exist', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.run.mockResolvedValue({ meta: { changes: 0 } });

      const result = await d1Provider.delete('tenant-1', 'key-1', context);
      expect(result).toBe(false);
    });

    it('should treat a missing meta as zero changes', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.run.mockResolvedValue({});

      const result = await d1Provider.delete('tenant-1', 'key-1', context);
      expect(result).toBe(false);
    });

    it('should propagate database errors from delete', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.run.mockRejectedValue(new Error('D1_ERROR: database is locked'));

      await expect(d1Provider.delete('tenant-1', 'key-1', context)).rejects.toThrow(McpError);
    });
  });

  describe('list', () => {
    /** The last statement's SQL with its whitespace collapsed. */
    const lastSql = () =>
      String(mockDb.prepare.mock.lastCall?.[0] ?? '')
        .replace(/\s+/g, ' ')
        .trim();

    it('should match the prefix with a key range, binding it and the default limit + 1 probe', async () => {
      const prepared = mockDb.prepare();
      prepared.bind().all.mockResolvedValue({ results: [{ key: 'key_1' }, { key: 'key_2' }] });

      const result = await d1Provider.list('tenant-1', 'key_', context);

      expect(result.keys).toEqual(['key_1', 'key_2']);
      expect(result.nextCursor).toBeUndefined();
      expect(lastSql()).toBe(
        'SELECT key FROM kv_store WHERE tenant_id = ? AND key >= ? AND key < ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?',
      );
      expect(prepared.bind).toHaveBeenLastCalledWith(
        'tenant-1',
        'key_',
        'key`',
        expect.any(Number),
        1001,
      );
    });

    it('should bind no key bounds for an empty prefix, and return a cursor when the limit + 1 probe finds more', async () => {
      const prepared = mockDb.prepare();
      prepared.bind().all.mockResolvedValue({
        results: [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
      });

      const result = await d1Provider.list('tenant-1', '', context, { limit: 2 });

      expect(result.keys).toEqual(['a', 'b']);
      expect(result.nextCursor).toBe(encodeCursor('b', 'tenant-1'));
      expect(lastSql()).toBe(
        'SELECT key FROM kv_store WHERE tenant_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?',
      );
      expect(prepared.bind).toHaveBeenLastCalledWith('tenant-1', expect.any(Number), 3);
    });

    it('should paginate after the decoded cursor key inside the prefix range', async () => {
      const prepared = mockDb.prepare();
      prepared.bind().all.mockResolvedValue({ results: [{ key: 'key-2' }, { key: 'key-3' }] });
      const cursor = encodeCursor('key-1', 'tenant-1');

      const result = await d1Provider.list('tenant-1', 'key', context, { cursor, limit: 10 });

      expect(result.keys).toEqual(['key-2', 'key-3']);
      expect(lastSql()).toBe(
        'SELECT key FROM kv_store WHERE tenant_id = ? AND key >= ? AND key < ? AND key > ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?',
      );
      expect(prepared.bind).toHaveBeenLastCalledWith(
        'tenant-1',
        'key',
        'kez',
        'key-1',
        expect.any(Number),
        11,
      );
    });

    it('should page an empty prefix after the cursor key alone', async () => {
      const prepared = mockDb.prepare();
      prepared.bind().all.mockResolvedValue({ results: [{ key: 'b' }] });
      const cursor = encodeCursor('a', 'tenant-1');

      await d1Provider.list('tenant-1', '', context, { cursor, limit: 1 });

      expect(lastSql()).toContain('WHERE tenant_id = ? AND key > ? AND (expires_at');
      expect(prepared.bind).toHaveBeenLastCalledWith('tenant-1', 'a', expect.any(Number), 2);
    });

    /**
     * The upper bound is the least string above every string that starts with
     * the prefix, in the code point order D1 compares TEXT in.
     */
    it.each([
      ['an ASCII prefix', 'user/', 'user0'],
      ['a prefix ending in _', 'lit_', 'lit`'],
      ['a prefix ending in z', 'z', '{'],
      ['a 512-character prefix', 'x'.repeat(512), `${'x'.repeat(511)}y`],
      ['a prefix ending in U+FFFF', 'a￿', 'a\u{10000}'],
      ['a prefix ending in a supplementary code point', 'a\u{1F600}', 'a\u{1F601}'],
      ['a prefix ending in U+10FFFF, carried to the code point before it', 'a\u{10FFFF}', 'b'],
      ['a carry past two U+10FFFF code points', 'ab\u{10FFFF}\u{10FFFF}', 'ac'],
      ['a prefix ending in U+D7FF', 'a퟿', 'a\uD800'],
      ['a prefix ending in a lone high surrogate', 'a\uD800', 'a\uD801'],
      ['a prefix ending in a lone low surrogate', 'a\uDFFF', 'a'],
      ['a lone high surrogate after a lone high surrogate', 'a\uD800\uDBFF', 'a\uD800'],
    ])('should bound %s', async (_label, prefix, upper) => {
      const prepared = mockDb.prepare();
      prepared.bind().all.mockResolvedValue({ results: [] });

      await d1Provider.list('tenant-1', prefix, context);

      expect(prepared.bind).toHaveBeenLastCalledWith(
        'tenant-1',
        prefix,
        upper,
        expect.any(Number),
        1001,
      );
    });

    it('should omit the upper bound for a prefix of U+10FFFF code points only', async () => {
      const prepared = mockDb.prepare();
      prepared.bind().all.mockResolvedValue({ results: [] });
      const prefix = '\u{10FFFF}\u{10FFFF}';

      await d1Provider.list('tenant-1', prefix, context);

      expect(lastSql()).toContain('WHERE tenant_id = ? AND key >= ? AND (expires_at');
      expect(prepared.bind).toHaveBeenLastCalledWith('tenant-1', prefix, expect.any(Number), 1001);
    });

    it('should reject a cursor issued for a different tenant', async () => {
      const cursor = encodeCursor('key-1', 'other-tenant');

      await expect(d1Provider.list('tenant-1', 'key', context, { cursor })).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
      });
    });

    it('should default to an empty result set when results is undefined', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.all.mockResolvedValue({});

      const result = await d1Provider.list('tenant-1', '', context);

      expect(result.keys).toEqual([]);
      expect(result.nextCursor).toBeUndefined();
    });

    it('should propagate database errors from list', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.all.mockRejectedValue(new Error('D1_ERROR: no such table: kv_store'));

      await expect(d1Provider.list('tenant-1', '', context)).rejects.toThrow(McpError);
    });
  });

  describe('batch operations', () => {
    it('setMany should use D1 batch API', async () => {
      mockDb.batch.mockResolvedValue([]);

      const entries = new Map<string, unknown>([
        ['k1', { data: 1 }],
        ['k2', { data: 2 }],
      ]);

      await d1Provider.setMany('tenant-1', entries, context);

      expect(mockDb.batch).toHaveBeenCalledTimes(1);
    });

    it('setMany should be a no-op for empty entries', async () => {
      await d1Provider.setMany('tenant-1', new Map(), context);

      expect(mockDb.batch).not.toHaveBeenCalled();
    });

    it('set and setMany should reject an unencodable value with a SerializationError before anything is written', async () => {
      await expect(d1Provider.set('tenant-1', 'k1', undefined, context)).rejects.toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
      });
      expect(mockDb.prepare).not.toHaveBeenCalled();
      await expect(
        d1Provider.setMany(
          'tenant-1',
          new Map<string, unknown>([
            ['k1', 1],
            ['k2', () => 1],
          ]),
          context,
        ),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.SerializationError });
      expect(mockDb.batch).not.toHaveBeenCalled();
    });

    it('deleteMany should use D1 batch API and return count', async () => {
      mockDb.batch.mockResolvedValue([
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
        { meta: { changes: 0 } },
      ]);

      const count = await d1Provider.deleteMany('tenant-1', ['k1', 'k2', 'k3'], context);

      expect(count).toBe(2);
      expect(mockDb.batch).toHaveBeenCalledTimes(1);
    });

    it('deleteMany should return 0 for empty keys', async () => {
      const count = await d1Provider.deleteMany('tenant-1', [], context);
      expect(count).toBe(0);
      expect(mockDb.batch).not.toHaveBeenCalled();
    });

    it('getMany should return 0 entries for empty keys without issuing a query', async () => {
      const result = await d1Provider.getMany('tenant-1', [], context);
      expect(result.size).toBe(0);
      expect(mockDb.prepare).not.toHaveBeenCalled();
      expect(mockDb.batch).not.toHaveBeenCalled();
    });

    it('setMany should bind a computed expires_at for every entry when a TTL is provided', async () => {
      mockDb.batch.mockResolvedValue([]);
      const prepared = mockDb.prepare();
      const before = Date.now();

      await d1Provider.setMany(
        'tenant-1',
        new Map<string, unknown>([
          ['k1', { data: 1 }],
          ['k2', { data: 2 }],
        ]),
        context,
        { ttl: 60 },
      );

      const calls = prepared.bind.mock.calls as [string, string, string, number][];
      for (const call of calls) {
        expect(call[3]).toBeGreaterThanOrEqual(before + 60 * 1000);
        expect(call[3]).toBeLessThan(before + 60 * 1000 + 1000);
      }
    });

    it('setMany should propagate database errors', async () => {
      mockDb.batch.mockRejectedValue(new Error('D1_ERROR: batch failed'));

      await expect(
        d1Provider.setMany('tenant-1', new Map<string, unknown>([['k1', 1]]), context),
      ).rejects.toThrow(McpError);
    });

    it('deleteMany should propagate database errors', async () => {
      mockDb.batch.mockRejectedValue(new Error('D1_ERROR: batch failed'));

      await expect(d1Provider.deleteMany('tenant-1', ['k1'], context)).rejects.toThrow(McpError);
    });

    it('getMany should retrieve and parse multiple keys', async () => {
      mockDb.batch.mockResolvedValue([
        {
          results: [
            { key: 'k1', value: JSON.stringify({ n: 1 }), expires_at: null },
            { key: 'k2', value: JSON.stringify({ n: 2 }), expires_at: null },
          ],
        },
      ]);

      const result = await d1Provider.getMany<{ n: number }>('tenant-1', ['k1', 'k2'], context);

      expect(result).toEqual(
        new Map([
          ['k1', { n: 1 }],
          ['k2', { n: 2 }],
        ]),
      );
    });

    it('getMany should throw McpError when a row fails JSON parsing', async () => {
      mockDb.batch.mockResolvedValue([
        { results: [{ key: 'bad', value: 'not-json{{', expires_at: null }] },
      ]);

      await expect(d1Provider.getMany('tenant-1', ['bad'], context)).rejects.toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
      });
    });

    it('getMany should default to an empty map when results is undefined', async () => {
      mockDb.batch.mockResolvedValue([{}]);

      const result = await d1Provider.getMany('tenant-1', ['a'], context);
      expect(result.size).toBe(0);
    });

    it('getMany should propagate database errors', async () => {
      mockDb.batch.mockRejectedValue(new Error('D1_ERROR: no such table'));

      await expect(d1Provider.getMany('tenant-1', ['a'], context)).rejects.toThrow(McpError);
    });
  });

  describe('getMany past the D1 bound-parameter limit', () => {
    const tenant = 'tenant-1';
    const NOW = 1_800_000_000_000;
    const keyAt = (index: number) => `k/${String(index).padStart(4, '0')}`;
    const keysUpTo = (count: number) => Array.from({ length: count }, (_, index) => keyAt(index));
    const storedRows = (count: number): StoredRow[] =>
      keysUpTo(count).map((key, index) => ({ key, tenant, value: { index } }));
    const batchedStatements = (db: ReturnType<typeof createRowStoreD1>['db']): FakeStatement[] =>
      db.batch.mock.calls[0]?.[0] ?? [];

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each([
      [98, [100]],
      [99, [100, 3]],
      [196, [100, 100]],
      [197, [100, 100, 3]],
    ])(
      'reads %i keys through one batch whose statements bind %j parameters',
      async (count, bindCounts) => {
        // Stored keys beyond the requested ones must stay out of the result.
        const { all, db } = createRowStoreD1(storedRows(count + 5));
        const provider = new D1Provider(db as any);
        const keys = keysUpTo(count);

        const result = await provider.getMany<{ index: number }>(tenant, keys, context);

        expect(result).toEqual(new Map(keys.map((key, index) => [key, { index }])));
        expect(db.batch).toHaveBeenCalledOnce();
        expect(all).not.toHaveBeenCalled();
        const statements = batchedStatements(db);
        expect(statements.map((statement) => statement.params.length)).toEqual(bindCounts);
        for (const statement of statements) {
          expect(statement.params[0]).toBe(tenant);
          expect(statement.sql.match(/\?/g)).toHaveLength(statement.params.length);
        }
        const boundKeys = statements.flatMap((statement) => statement.params.slice(1, -1));
        expect(boundKeys.sort()).toEqual(keys);
      },
    );

    it('binds one now to every chunk', async () => {
      let clock = NOW;
      vi.spyOn(Date, 'now').mockImplementation(() => clock++);
      const { db } = createRowStoreD1(storedRows(197));
      const provider = new D1Provider(db as any);

      await provider.getMany(tenant, keysUpTo(197), context);

      const statements = batchedStatements(db);
      expect(statements).toHaveLength(3);
      expect(new Set(statements.map((statement) => statement.params.at(-1)))).toEqual(
        new Set([NOW]),
      );
    });

    it('binds each distinct key once when the list repeats keys', async () => {
      const { db } = createRowStoreD1(storedRows(98));
      const provider = new D1Provider(db as any);
      const keys = keysUpTo(98);

      const result = await provider.getMany(tenant, [...keys, ...keys], context);

      expect(result.size).toBe(98);
      expect(batchedStatements(db).map((statement) => statement.params.length)).toEqual([100]);
    });

    it('omits missing keys and keys expired at the bound now, in every chunk', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW);
      const expired = new Set([keyAt(5), keyAt(120), keyAt(195)]);
      const missing = new Set([keyAt(10), keyAt(150), keyAt(196)]);
      /** Expiry at exactly `now` is expired; the rest are permanent or live one millisecond longer. */
      const expiresAtFor = (key: string, index: number): number | null => {
        if (expired.has(key)) return NOW;
        return index % 2 === 0 ? null : NOW + 1;
      };
      const rows = storedRows(197).flatMap((row, index) =>
        missing.has(row.key) ? [] : [{ ...row, expiresAt: expiresAtFor(row.key, index) }],
      );
      const { db } = createRowStoreD1(rows);
      const provider = new D1Provider(db as any);

      const result = await provider.getMany(tenant, keysUpTo(197), context);

      expect(batchedStatements(db)).toHaveLength(3);
      expect([...result.keys()].sort()).toEqual(
        keysUpTo(197).filter((key) => !expired.has(key) && !missing.has(key)),
      );
    });
  });

  describe('clear', () => {
    it('should delete all keys for tenant and return count', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.run.mockResolvedValue({ meta: { changes: 5 } });

      const count = await d1Provider.clear('tenant-1', context);
      expect(count).toBe(5);
    });

    it('should treat a missing meta as zero cleared rows', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.run.mockResolvedValue({});

      const count = await d1Provider.clear('tenant-1', context);
      expect(count).toBe(0);
    });

    it('should propagate database errors from clear', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.run.mockRejectedValue(new Error('D1_ERROR: database is locked'));

      await expect(d1Provider.clear('tenant-1', context)).rejects.toThrow(McpError);
    });
  });
});

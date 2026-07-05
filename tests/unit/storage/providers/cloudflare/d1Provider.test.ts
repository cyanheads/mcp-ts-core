/**
 * @fileoverview Unit tests for the D1Provider.
 * @module tests/storage/providers/cloudflare/d1Provider.test
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
      const stmt = mockDb.prepare().bind();
      stmt.first.mockResolvedValue({
        value: JSON.stringify({ data: 'stale' }),
        expires_at: Date.now() - 1000,
      });
      stmt.run.mockResolvedValue({ meta: { changes: 1 } });

      const result = await d1Provider.get('tenant-1', 'key-1', context);
      expect(result).toBeNull();
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
    it('should call run with correct parameters', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.run.mockResolvedValue({ meta: { changes: 1 } });

      await d1Provider.set('tenant-1', 'key-1', { data: 'test' }, context);

      expect(mockDb.prepare).toHaveBeenCalled();
    });

    it('should include expires_at when TTL is provided', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.run.mockResolvedValue({ meta: { changes: 1 } });

      await d1Provider.set('tenant-1', 'key-1', { data: 'test' }, context, {
        ttl: 3600,
      });

      expect(mockDb.prepare).toHaveBeenCalled();
    });

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
    it('should return keys matching prefix with pagination', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.all.mockResolvedValue({
        results: [{ key: 'key-1' }, { key: 'key-2' }],
      });

      const result = await d1Provider.list('tenant-1', 'key', context, {
        limit: 10,
      });

      expect(result.keys).toEqual(['key-1', 'key-2']);
      expect(result.nextCursor).toBeUndefined();
    });

    it('should use the default limit when no options are given', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.all.mockResolvedValue({ results: [{ key: 'only-key' }] });

      const result = await d1Provider.list('tenant-1', '', context);

      expect(result.keys).toEqual(['only-key']);
      expect(result.nextCursor).toBeUndefined();
    });

    it('should indicate more results and return a next cursor when hasMore', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.all.mockResolvedValue({
        results: [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
      });

      const result = await d1Provider.list('tenant-1', '', context, { limit: 2 });

      expect(result.keys).toEqual(['a', 'b']);
      expect(result.nextCursor).toBeDefined();
    });

    it('should paginate using a previously issued cursor', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.all.mockResolvedValue({ results: [{ key: 'key-2' }, { key: 'key-3' }] });
      const cursor = encodeCursor('key-1', 'tenant-1');

      const result = await d1Provider.list('tenant-1', 'key', context, { cursor, limit: 10 });

      expect(result.keys).toEqual(['key-2', 'key-3']);
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

    it('getMany should return 0 entries for empty keys', async () => {
      const result = await d1Provider.getMany('tenant-1', [], context);
      expect(result.size).toBe(0);
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
      const stmt = mockDb.prepare().bind();
      stmt.all.mockResolvedValue({
        results: [
          { key: 'k1', value: JSON.stringify({ n: 1 }), expires_at: null },
          { key: 'k2', value: JSON.stringify({ n: 2 }), expires_at: null },
        ],
      });

      const result = await d1Provider.getMany<{ n: number }>('tenant-1', ['k1', 'k2'], context);

      expect(result).toEqual(
        new Map([
          ['k1', { n: 1 }],
          ['k2', { n: 2 }],
        ]),
      );
    });

    it('getMany should throw McpError when a row fails JSON parsing', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.all.mockResolvedValue({
        results: [{ key: 'bad', value: 'not-json{{', expires_at: null }],
      });

      await expect(d1Provider.getMany('tenant-1', ['bad'], context)).rejects.toThrow(McpError);
    });

    it('getMany should default to an empty map when results is undefined', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.all.mockResolvedValue({});

      const result = await d1Provider.getMany('tenant-1', ['a'], context);
      expect(result.size).toBe(0);
    });

    it('getMany should propagate database errors', async () => {
      const stmt = mockDb.prepare().bind();
      stmt.all.mockRejectedValue(new Error('D1_ERROR: no such table'));

      await expect(d1Provider.getMany('tenant-1', ['a'], context)).rejects.toThrow(McpError);
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

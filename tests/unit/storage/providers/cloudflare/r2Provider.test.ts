/**
 * @fileoverview Unit tests for the R2Provider.
 * @module tests/storage/providers/cloudflare/r2Provider.test
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { encodeCursor } from '../../../../../src/storage/core/storageValidation.js';
import { R2Provider } from '../../../../../src/storage/providers/cloudflare/r2Provider.js';
import { McpError } from '../../../../../src/types-global/errors.js';

// Mock R2Bucket
const createMockR2Bucket = () => ({
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn().mockResolvedValue(undefined),
  list: vi.fn(),
  head: vi.fn(),
});

describe('R2Provider', () => {
  let r2Provider: R2Provider;
  let mockBucket: ReturnType<typeof createMockR2Bucket>;
  let context: RequestContext;

  beforeEach(() => {
    mockBucket = createMockR2Bucket();
    r2Provider = new R2Provider(mockBucket as any);
    context = requestContextService.createRequestContext({
      operation: 'test-r2-provider',
    });
  });

  describe('get', () => {
    it('should return null if object not found', async () => {
      mockBucket.get.mockResolvedValue(null);
      const result = await r2Provider.get('tenant-1', 'key-1', context);
      expect(result).toBeNull();
      expect(mockBucket.get).toHaveBeenCalledWith('tenant-1:key-1');
    });

    it('should return parsed JSON object if found', async () => {
      const storedObject = { data: 'test-data' };
      const envelope = {
        __mcp: { v: 1 },
        value: storedObject,
      };
      const mockR2Object = {
        text: async () => JSON.stringify(envelope),
      };
      mockBucket.get.mockResolvedValue(mockR2Object);
      const result = await r2Provider.get<{ data: string }>('tenant-1', 'key-1', context);
      expect(result).toEqual(storedObject);
    });

    it('should throw McpError on JSON parsing error', async () => {
      const mockR2Object = {
        text: async () => 'invalid-json',
      };
      mockBucket.get.mockResolvedValue(mockR2Object);
      await expect(r2Provider.get('tenant-1', 'key-1', context)).rejects.toThrow(McpError);
    });

    it('should delete expired keys and return null', async () => {
      const expiredEnvelope = {
        __mcp: { v: 1, expiresAt: Date.now() - 1_000 },
        value: { data: 'stale' },
      };
      const mockR2Object = {
        text: async () => JSON.stringify(expiredEnvelope),
      };
      mockBucket.get.mockResolvedValue(mockR2Object);

      const result = await r2Provider.get('tenant-1', 'key-1', context);

      expect(result).toBeNull();
      expect(mockBucket.delete).toHaveBeenCalledWith('tenant-1:key-1');
    });
  });

  describe('set', () => {
    it('should call put with the correct key and stringified envelope', async () => {
      const value = { data: 'test-data' };
      const expectedEnvelope = {
        __mcp: { v: 1 },
        value,
      };
      await r2Provider.set('tenant-1', 'key-1', value, context);
      expect(mockBucket.put).toHaveBeenCalledWith(
        'tenant-1:key-1',
        JSON.stringify(expectedEnvelope),
      );
    });

    it('should include a calculated expiresAt in envelope if ttl is provided', async () => {
      const value = { data: 'test' };
      const ttl = 3600;
      const now = Date.now();

      await r2Provider.set('tenant-1', 'key-1', value, context, { ttl });

      expect(mockBucket.put).toHaveBeenCalledTimes(1);
      const [key, body] = mockBucket.put.mock.calls[0]!;
      const envelope = JSON.parse(body);

      expect(key).toBe('tenant-1:key-1');
      expect(envelope.value).toEqual(value);
      expect(envelope.__mcp.v).toBe(1);
      expect(envelope.__mcp.expiresAt).toBeGreaterThanOrEqual(now + ttl * 1000);
      // Allow for a small delay in execution
      expect(envelope.__mcp.expiresAt).toBeLessThan(now + ttl * 1000 + 100);
    });
  });

  describe('delete', () => {
    it('should always return true (R2 delete is idempotent)', async () => {
      const result = await r2Provider.delete('tenant-1', 'key-1', context);
      expect(result).toBe(true);
      expect(mockBucket.delete).toHaveBeenCalledWith('tenant-1:key-1');
    });
  });

  describe('list', () => {
    it('should return a list of keys with tenant prefix stripped', async () => {
      mockBucket.list.mockResolvedValue({
        objects: [{ key: 'tenant-1:key-1' }, { key: 'tenant-1:key-2' }, { key: 'unrelated-key' }],
        truncated: false,
      });
      const result = await r2Provider.list('tenant-1', 'key', context);
      expect(result.keys).toEqual(['key-1', 'key-2', 'unrelated-key']);
      expect(result.nextCursor).toBeUndefined();
      expect(mockBucket.list).toHaveBeenCalledWith(
        expect.objectContaining({
          prefix: 'tenant-1:key',
          limit: 1000,
        }),
      );
    });

    it('should apply limit, cursor, and expose next cursor when truncated', async () => {
      // Implementation fetches limit+1 to detect more pages
      const listedResponse = {
        objects: [{ key: 'tenant-1:key-a' }, { key: 'tenant-1:key-b' }, { key: 'tenant-1:key-c' }],
        truncated: false,
      };
      mockBucket.list.mockResolvedValueOnce(listedResponse);

      // Pass a tenant-bound cursor (provider decodes and uses startAfter)
      const tenantBoundCursor = encodeCursor('incoming-cursor', 'tenant-1');
      const result = await r2Provider.list('tenant-1', 'key', context, {
        limit: 2,
        cursor: tenantBoundCursor,
      });

      expect(result.keys).toEqual(['key-a', 'key-b']);
      // nextCursor is built from the last result key, not R2's native cursor
      expect(result.nextCursor).toBe(encodeCursor('key-b', 'tenant-1'));
      expect(mockBucket.list).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          prefix: 'tenant-1:key',
          limit: 3,
          startAfter: 'tenant-1:incoming-cursor', // decoded cursor used as startAfter
        }),
      );
    });

    it('should clamp the +1 page probe at the R2 1000-key cap and use truncated for has-more', async () => {
      mockBucket.list.mockResolvedValueOnce({
        objects: [{ key: 'tenant-1:key-1' }],
        truncated: true,
      });

      const result = await r2Provider.list('tenant-1', 'key', context, { limit: 1000 });

      // 1001 would be rejected by R2 — the probe must clamp to 1000
      expect(mockBucket.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000 }));
      expect(result.keys).toEqual(['key-1']);
      // truncated response → cursor present even though fewer than limit keys came back
      expect(result.nextCursor).toBe(encodeCursor('key-1', 'tenant-1'));
    });
  });

  describe('getMany', () => {
    it('should aggregate non-null values into a map', async () => {
      const spy = vi
        .spyOn(r2Provider, 'get')
        .mockResolvedValueOnce({ payload: 1 })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ payload: 3 });

      const result = await r2Provider.getMany('tenant-1', ['key-1', 'key-2', 'key-3'], context);

      expect(result.size).toBe(2);
      expect(result.get('key-1')).toEqual({ payload: 1 });
      expect(result.get('key-3')).toEqual({ payload: 3 });
      expect(result.has('key-2')).toBe(false);
      expect(spy).toHaveBeenCalledTimes(3);
    });
  });

  describe('setMany', () => {
    it('should delegate to set for each entry and preserve options', async () => {
      const spy = vi.spyOn(r2Provider, 'set').mockResolvedValue();
      const entries = new Map<string, unknown>([
        ['key-1', { data: 1 }],
        ['key-2', { data: 2 }],
      ]);

      await r2Provider.setMany('tenant-1', entries, context, { ttl: 10 });

      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenNthCalledWith(1, 'tenant-1', 'key-1', { data: 1 }, context, {
        ttl: 10,
      });
      expect(spy).toHaveBeenNthCalledWith(2, 'tenant-1', 'key-2', { data: 2 }, context, {
        ttl: 10,
      });
    });
  });

  describe('deleteMany', () => {
    it('should batch delete all keys and return count', async () => {
      const count = await r2Provider.deleteMany('tenant-1', ['key-1', 'key-2', 'key-3'], context);

      expect(count).toBe(3);
      // Single batch delete call with all R2 keys
      expect(mockBucket.delete).toHaveBeenCalledTimes(1);
      expect(mockBucket.delete).toHaveBeenCalledWith([
        'tenant-1:key-1',
        'tenant-1:key-2',
        'tenant-1:key-3',
      ]);
    });

    it('should return 0 for empty key list', async () => {
      const count = await r2Provider.deleteMany('tenant-1', [], context);
      expect(count).toBe(0);
      expect(mockBucket.delete).not.toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('should iterate through pages and batch delete all keys for a tenant', async () => {
      mockBucket.list
        .mockResolvedValueOnce({
          objects: [{ key: 'tenant-1:key-1' }, { key: 'tenant-1:key-2' }],
          truncated: true,
          cursor: 'cursor-token',
        })
        .mockResolvedValueOnce({
          objects: [{ key: 'tenant-1:key-3' }],
          truncated: false,
        });

      const deletedCount = await r2Provider.clear('tenant-1', context);

      expect(deletedCount).toBe(3);
      // One batch delete per page
      expect(mockBucket.delete).toHaveBeenCalledTimes(2);
      expect(mockBucket.delete).toHaveBeenNthCalledWith(1, ['tenant-1:key-1', 'tenant-1:key-2']);
      expect(mockBucket.delete).toHaveBeenNthCalledWith(2, ['tenant-1:key-3']);
      expect(mockBucket.list).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ prefix: 'tenant-1:' }),
      );
      expect(mockBucket.list).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ cursor: 'cursor-token' }),
      );
    });
  });
});

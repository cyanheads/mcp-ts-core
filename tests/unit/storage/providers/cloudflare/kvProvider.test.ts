/**
 * @fileoverview Unit tests for the KvProvider.
 * @module tests/storage/providers/cloudflare/kvProvider.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { encodeCursor } from '../../../../../src/storage/core/storageValidation.js';
import { KvProvider } from '../../../../../src/storage/providers/cloudflare/kvProvider.js';
import { McpError } from '../../../../../src/types-global/errors.js';

// Mock KVNamespace
const createMockKvNamespace = () => ({
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
});

describe('KvProvider', () => {
  let kvProvider: KvProvider;
  let mockKv: ReturnType<typeof createMockKvNamespace>;
  let context: RequestContext;

  beforeEach(() => {
    mockKv = createMockKvNamespace();
    kvProvider = new KvProvider(mockKv as any);
    context = requestContextService.createRequestContext({
      operation: 'test-kv-provider',
    });
  });

  describe('constructor', () => {
    it('should throw McpError when kv is not provided', () => {
      expect(() => new KvProvider(null as any)).toThrow(McpError);
      expect(() => new KvProvider(null as any)).toThrow(
        /KvProvider requires a valid KVNamespace instance/,
      );
    });
  });

  describe('get', () => {
    it('should return null if key not found', async () => {
      mockKv.get.mockResolvedValue(null);
      const result = await kvProvider.get('tenant-1', 'key-1', context);
      expect(result).toBeNull();
      expect(mockKv.get).toHaveBeenCalledWith('tenant-1:key-1', 'json');
    });

    it('should return parsed JSON object if found', async () => {
      const storedObject = { data: 'test-data' };
      mockKv.get.mockResolvedValue(storedObject);
      const result = await kvProvider.get<{ data: string }>('tenant-1', 'key-1', context);
      expect(result).toEqual(storedObject);
    });

    it('should throw McpError on JSON parsing error', async () => {
      const parsingError = new Error('Invalid JSON');
      mockKv.get.mockRejectedValue(parsingError);

      await expect(kvProvider.get('tenant-1', 'key-1', context)).rejects.toThrow(McpError);
    });
  });

  describe('set', () => {
    it('should call put with correct key and value', async () => {
      const value = { data: 'test-data' };
      await kvProvider.set('tenant-1', 'key-1', value, context);
      expect(mockKv.put).toHaveBeenCalledWith('tenant-1:key-1', JSON.stringify(value), {
        expirationTtl: undefined,
      });
    });

    it('should include expirationTtl if ttl is provided', async () => {
      const value = { data: 'test' };
      await kvProvider.set('tenant-1', 'key-1', value, context, { ttl: 3600 });
      expect(mockKv.put).toHaveBeenCalledWith('tenant-1:key-1', JSON.stringify(value), {
        expirationTtl: 3600,
      });
    });

    it('should clamp expirationTtl to the Cloudflare-required 60s minimum', async () => {
      const value = { data: 'test' };
      await kvProvider.set('tenant-1', 'key-1', value, context, { ttl: 10 });
      expect(mockKv.put).toHaveBeenCalledWith('tenant-1:key-1', JSON.stringify(value), {
        expirationTtl: 60,
      });
    });

    it('should propagate errors from the underlying put call', async () => {
      mockKv.put.mockRejectedValue(new Error('KV unavailable'));

      await expect(kvProvider.set('tenant-1', 'key-1', { data: 'test' }, context)).rejects.toThrow(
        McpError,
      );
    });
  });

  describe('delete', () => {
    it('should call delete and return true (idempotent)', async () => {
      mockKv.delete.mockResolvedValue(undefined);
      const result = await kvProvider.delete('tenant-1', 'key-1', context);
      expect(result).toBe(true);
      expect(mockKv.delete).toHaveBeenCalledWith('tenant-1:key-1');
      // Should not check existence first — KV delete is idempotent
      expect(mockKv.get).not.toHaveBeenCalled();
    });

    it('should propagate errors from the underlying delete call', async () => {
      mockKv.delete.mockRejectedValue(new Error('KV unavailable'));

      await expect(kvProvider.delete('tenant-1', 'key-1', context)).rejects.toThrow(McpError);
    });
  });

  describe('list', () => {
    it('should return a list of keys with tenant prefix stripped', async () => {
      mockKv.list.mockResolvedValue({
        keys: [{ name: 'tenant-1:key-1' }, { name: 'tenant-1:key-2' }, { name: 'unrelated-key' }],
        list_complete: true,
      });
      const result = await kvProvider.list('tenant-1', 'key', context);
      expect(result.keys).toEqual(['key-1', 'key-2', 'unrelated-key']);
      expect(result.nextCursor).toBeUndefined();
      expect(mockKv.list).toHaveBeenCalledWith(
        expect.objectContaining({
          prefix: 'tenant-1:key',
          limit: 1000,
        }),
      );
    });

    it('should forward cursors when Cloudflare pagination continues', async () => {
      mockKv.list.mockResolvedValue({
        keys: [{ name: 'tenant-1:page-1' }],
        list_complete: false,
        cursor: 'next-cursor',
      });

      // Pass a tenant-bound cursor (as the provider now decodes before forwarding to KV)
      const tenantBoundCursor = encodeCursor('prev-cursor', 'tenant-1');
      const result = await kvProvider.list('tenant-1', 'page', context, {
        limit: 5,
        cursor: tenantBoundCursor,
      });

      expect(result.keys).toEqual(['page-1']);
      // nextCursor should now be tenant-bound encoded
      expect(result.nextCursor).toBe(encodeCursor('next-cursor', 'tenant-1'));
      expect(mockKv.list).toHaveBeenCalledWith(
        expect.objectContaining({
          prefix: 'tenant-1:page',
          limit: 5,
          cursor: 'prev-cursor', // decoded native cursor passed to KV
        }),
      );
    });

    it('should not forward a cursor when the list is already complete', async () => {
      mockKv.list.mockResolvedValue({
        keys: [{ name: 'tenant-1:key-1' }],
        list_complete: true,
        cursor: 'stale-cursor',
      });

      const result = await kvProvider.list('tenant-1', 'key', context);

      expect(result.nextCursor).toBeUndefined();
    });

    it('should propagate errors from the underlying list call', async () => {
      mockKv.list.mockRejectedValue(new Error('KV unavailable'));

      await expect(kvProvider.list('tenant-1', 'key', context)).rejects.toThrow(McpError);
    });
  });

  describe('batch operations', () => {
    it('getMany should aggregate non-null values', async () => {
      const getSpy = vi
        .spyOn(kvProvider, 'get')
        .mockResolvedValueOnce('value-1' as never)
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce('value-3' as never);

      const result = await kvProvider.getMany<string>('tenant-1', ['a', 'b', 'c'], context);

      expect(result).toBeInstanceOf(Map);
      expect(Array.from(result.entries())).toEqual([
        ['a', 'value-1'],
        ['c', 'value-3'],
      ]);
      expect(getSpy).toHaveBeenCalledTimes(3);
      getSpy.mockRestore();
    });

    it('setMany should delegate writes with provided options', async () => {
      const entries = new Map<string, unknown>([
        ['k1', { foo: 'bar' }],
        ['k2', { baz: 2 }],
      ]);

      await kvProvider.setMany('tenant-1', entries, context, { ttl: 120 });

      expect(mockKv.put).toHaveBeenCalledTimes(2);
      expect(mockKv.put).toHaveBeenCalledWith('tenant-1:k1', JSON.stringify({ foo: 'bar' }), {
        expirationTtl: 120,
      });
      expect(mockKv.put).toHaveBeenCalledWith('tenant-1:k2', JSON.stringify({ baz: 2 }), {
        expirationTtl: 120,
      });
    });

    it('deleteMany should return count of deleted keys', async () => {
      const deleteSpy = vi
        .spyOn(kvProvider, 'delete')
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      const deleted = await kvProvider.deleteMany('tenant-1', ['a', 'b', 'c'], context);

      expect(deleted).toBe(2);
      deleteSpy.mockRestore();
    });

    it('clear should iterate through pages and delete all keys', async () => {
      mockKv.list
        .mockResolvedValueOnce({
          keys: [{ name: 'tenant-1:k1' }, { name: 'tenant-1:k2' }],
          list_complete: false,
          cursor: 'cursor-1',
        })
        .mockResolvedValueOnce({
          keys: [{ name: 'tenant-1:k3' }],
          list_complete: true,
        });

      mockKv.delete.mockResolvedValue(undefined);

      const cleared = await kvProvider.clear('tenant-1', context);

      expect(cleared).toBe(3);
      expect(mockKv.delete).toHaveBeenCalledTimes(3);
      expect(mockKv.list).toHaveBeenNthCalledWith(1, {
        prefix: 'tenant-1:',
        limit: 1000,
      });
      expect(mockKv.list).toHaveBeenNthCalledWith(2, {
        prefix: 'tenant-1:',
        limit: 1000,
        cursor: 'cursor-1',
      });
    });

    it('getMany should return an empty map when no keys are requested', async () => {
      const result = await kvProvider.getMany('tenant-1', [], context);
      expect(result.size).toBe(0);
    });

    it('setMany should be a no-op for an empty entries map', async () => {
      await kvProvider.setMany('tenant-1', new Map(), context);
      expect(mockKv.put).not.toHaveBeenCalled();
    });

    it('deleteMany should return 0 for an empty key list', async () => {
      const deleted = await kvProvider.deleteMany('tenant-1', [], context);
      expect(deleted).toBe(0);
    });
  });
});

/**
 * @fileoverview Unit tests for the KvProvider.
 * @module tests/storage/providers/cloudflare/kvProvider.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { encodeCursor } from '../../../../../src/storage/core/storageValidation.js';
import { KvProvider } from '../../../../../src/storage/providers/cloudflare/kvProvider.js';
import { JsonRpcErrorCode, McpError } from '../../../../../src/types-global/errors.js';
import { defaultIsTransient } from '../../../../../src/utils/network/retry.js';

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
      expect(mockKv.get).toHaveBeenCalledWith('tenant-1:key-1', 'text');
    });

    it('should parse the stored JSON text', async () => {
      mockKv.get.mockResolvedValue('{"data":"stored"}');

      await expect(kvProvider.get('tenant-1', 'key-1', context)).resolves.toEqual({
        data: 'stored',
      });
    });

    it('should report a stored value that is not JSON as SerializationError', async () => {
      mockKv.get.mockResolvedValue('{invalid');

      const error = await kvProvider.get('tenant-1', 'key-1', context).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
        message: '[KvProvider] Failed to parse JSON for key: tenant-1:key-1',
      });
      expect(defaultIsTransient(error)).toBe(false);
    });

    it.each([
      ['KV GET failed: 503 Service Unavailable', JsonRpcErrorCode.ServiceUnavailable, true],
      ['KV GET failed: 429 Too Many Requests', JsonRpcErrorCode.RateLimited, true],
      [
        'KV GET failed: 414 UTF-8 encoded length of 513 exceeds key length limit of 512.',
        JsonRpcErrorCode.InternalError,
        false,
      ],
    ])(
      'should classify a rejected read (%s) as the other KV methods do',
      async (message, code, transient) => {
        mockKv.get.mockRejectedValue(new Error(message));
        mockKv.put.mockRejectedValue(new Error(message.replace('GET', 'PUT')));

        const getError = await kvProvider
          .get('tenant-1', 'key-1', context)
          .catch((e: unknown) => e);
        const getManyError = await kvProvider
          .getMany('tenant-1', ['key-1'], context)
          .catch((e: unknown) => e);
        const setError = await kvProvider
          .set('tenant-1', 'key-1', 1, context)
          .catch((e: unknown) => e);

        expect(getError).toMatchObject({ code });
        expect(defaultIsTransient(getError)).toBe(transient);
        expect(getManyError).toMatchObject({ code });
        expect(setError).toMatchObject({ code });
      },
    );
  });

  describe('set', () => {
    it('should call put with correct key and value, and no expirationTtl without a ttl', async () => {
      const value = { data: 'test-data' };
      await kvProvider.set('tenant-1', 'key-1', value, context);
      expect(mockKv.put).toHaveBeenCalledOnce();
      // toStrictEqual: toHaveBeenCalledWith treats `{ expirationTtl: undefined }` as equal to `{}`.
      expect(mockKv.put.mock.calls[0]).toStrictEqual(['tenant-1:key-1', JSON.stringify(value), {}]);
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

    it.each([
      ['undefined', undefined],
      ['function', () => 1],
      ['symbol', Symbol('s')],
    ])('should reject a top-level %s without calling put', async (_label, value) => {
      await expect(kvProvider.set('tenant-1', 'key-1', value, context)).rejects.toThrow(McpError);
      await expect(
        kvProvider.setMany(
          'tenant-1',
          new Map<string, unknown>([
            ['good', 1],
            ['bad', value],
          ]),
          context,
        ),
      ).rejects.toThrow(McpError);
      expect(mockKv.put).not.toHaveBeenCalled();
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
    it('getMany should read each tenant-prefixed key and omit misses', async () => {
      mockKv.get.mockImplementation(async (kvKey: string) =>
        kvKey === 'tenant-1:b' ? null : JSON.stringify(`value-of-${kvKey}`),
      );

      const result = await kvProvider.getMany<string>('tenant-1', ['a', 'b', 'c'], context);

      expect(result).toEqual(
        new Map([
          ['a', 'value-of-tenant-1:a'],
          ['c', 'value-of-tenant-1:c'],
        ]),
      );
      expect(mockKv.get).toHaveBeenCalledWith('tenant-1:b', 'text');
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

    it('deleteMany should delete each tenant-prefixed key and count every idempotent delete', async () => {
      mockKv.delete.mockResolvedValue(undefined);

      await expect(kvProvider.deleteMany('tenant-1', ['a', 'b'], context)).resolves.toBe(2);
      expect(mockKv.delete.mock.calls).toEqual([['tenant-1:a'], ['tenant-1:b']]);
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
  });
});

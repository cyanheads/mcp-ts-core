/**
 * @fileoverview Unit tests for InMemoryProvider-specific behavior (capacity bounds,
 * namespace cleanup, JSON round-trip edges). The shared provider contract runs in
 * `tests/compliance/storage-provider.test.ts`.
 * @module tests/storage/providers/inMemory/inMemoryProvider.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { createMockContext } from '@/testing/index.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

const createTestContext = () =>
  requestContextService.createRequestContext({
    operation: 'in-memory-provider-test',
  });

describe('InMemoryProvider (unit)', () => {
  let provider: InMemoryProvider;
  const tenantId = 'tenant-a';

  let nowSpy: { mockRestore: () => void } | undefined;
  let now = 0;

  beforeEach(() => {
    provider = new InMemoryProvider();
    now = Date.now();
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    nowSpy?.mockRestore();
  });

  it('does not retain empty tenant namespaces after read misses or cleanup', async () => {
    const context = createTestContext();
    for (let index = 0; index < 100; index++) {
      await provider.get(`missing-tenant-${index}`, 'missing', context);
      await provider.list(`missing-tenant-${index}`, '', context);
      await provider.delete(`missing-tenant-${index}`, 'missing', context);
      await provider.clear(`missing-tenant-${index}`, context);
    }

    const internalStore = (provider as unknown as { store: Map<string, unknown> }).store;
    expect(internalStore.size).toBe(0);

    await provider.set(tenantId, 'only-key', 'value', context);
    await provider.delete(tenantId, 'only-key', context);
    expect(internalStore.size).toBe(0);
  });

  it('does not allocate tenant namespaces for empty setMany calls', async () => {
    const context = createTestContext();
    for (let index = 0; index < 100; index++) {
      await provider.setMany(`empty-tenant-${index}`, new Map(), context);
    }

    const internalStore = (provider as unknown as { store: Map<string, unknown> }).store;
    expect(internalStore.size).toBe(0);
    expect(provider.size).toBe(0);
  });

  // #544 — set() and list() failures surface as rejected promises, like every
  // other provider and the IStorageProvider contract, so `.catch()` and
  // `Promise.allSettled` observe them instead of a throw escaping first.
  describe('failures reject rather than throw synchronously', () => {
    /** Calls `fn`, failing the test if it throws before returning a promise. */
    function call<T>(fn: () => Promise<T>): Promise<T> {
      let pending: Promise<T> | undefined;
      expect(() => {
        pending = fn();
      }).not.toThrow();
      expect(pending).toBeInstanceOf(Promise);
      return pending as Promise<T>;
    }

    it.each([
      ['a bigint value', { big: 10n }],
      ['a top-level undefined', undefined],
    ])('set() with %s rejects with SerializationError', async (_label, value) => {
      const context = createTestContext();
      await expect(
        call(() => provider.set(tenantId, 'item', value, context)),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.SerializationError });
    });

    it('set() of a new key at maxEntries rejects with the capacity error', async () => {
      const context = createTestContext();
      const boundedProvider = new InMemoryProvider({ maxEntries: 1 });
      await boundedProvider.set(tenantId, 'key1', 'v1', context);

      await expect(
        call(() => boundedProvider.set(tenantId, 'key2', 'v2', context)),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.InternalError,
        message: expect.stringContaining('capacity exceeded'),
      });
    });

    it('Promise.allSettled settles a rejected set() alongside a successful one', async () => {
      const context = createTestContext();
      const results = await Promise.allSettled([
        provider.set(tenantId, 'bad', { big: 10n }, context),
        provider.set(tenantId, 'good', 'value', context),
      ]);

      expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
      await expect(provider.get(tenantId, 'good', context)).resolves.toBe('value');
    });

    it('list() with a malformed cursor rejects with InvalidParams', async () => {
      const context = createTestContext();
      await provider.set(tenantId, 'a', 1, context);

      await expect(
        call(() => provider.list(tenantId, '', context, { cursor: 'garbage' })),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
    });

    it('list() with a cursor issued to another tenant rejects with InvalidParams', async () => {
      const context = createTestContext();
      for (const key of ['a', 'b', 'c']) await provider.set('tenant-b', key, key, context);
      const { nextCursor } = await provider.list('tenant-b', '', context, { limit: 1 });
      expect(nextCursor).toBeTypeOf('string');

      await expect(
        call(() => provider.list(tenantId, '', context, { cursor: nextCursor as string })),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
    });
  });

  describe('JSON round-trip', () => {
    it('returns the JSON form through ctx.state and rejects values JSON cannot encode', async () => {
      const ctx = createMockContext();
      const item = { at: new Date(now), tags: new Map([['a', 1]]), n: 1 };
      await ctx.state.set('item/1', item);
      item.n = 2;

      const got = await ctx.state.get<typeof item>('item/1');
      expect([got === item, got?.at instanceof Date, got?.tags instanceof Map, got?.n]).toEqual([
        false,
        false,
        false,
        1,
      ]);
      expect(got).toEqual({ at: new Date(now).toISOString(), tags: {}, n: 1 });

      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      for (const value of [{ big: 10n }, cyclic]) {
        await expect(ctx.state.set('item/2', value)).rejects.toMatchObject({
          code: JsonRpcErrorCode.SerializationError,
        });
      }
      await expect(ctx.state.get('item/2')).resolves.toBeNull();
    });

    it('keeps the prior value and TTL when a set over an existing key is rejected', async () => {
      const context = createTestContext();
      await provider.set(tenantId, 'item', 'original', context, { ttl: 5 });

      await expect(provider.set(tenantId, 'item', { big: 10n }, context)).rejects.toThrow(McpError);

      now += 4_000;
      await expect(provider.get(tenantId, 'item', context)).resolves.toBe('original');
      now += 1_001;
      await expect(provider.get(tenantId, 'item', context)).resolves.toBeNull();
    });

    it('rejects a setMany batch with one unencodable entry and commits none of it', async () => {
      const context = createTestContext();
      await provider.set(tenantId, 'existing', 'original', context);

      await expect(
        provider.setMany(
          tenantId,
          new Map<string, unknown>([
            ['existing', 'changed'],
            ['fresh', 'value'],
            ['bad', undefined],
          ]),
          context,
        ),
      ).rejects.toThrow(McpError);

      await expect(provider.get(tenantId, 'existing', context)).resolves.toBe('original');
      await expect(provider.get(tenantId, 'fresh', context)).resolves.toBeNull();
      expect(provider.size).toBe(1);
    });
  });

  describe('capacity management', () => {
    it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects invalid maxEntries configuration: %s',
      (maxEntries) => {
        expect(() => new InMemoryProvider({ maxEntries })).toThrow(McpError);
      },
    );

    it('supports a zero-entry provider that rejects writes without retaining a tenant', async () => {
      const context = createTestContext();
      const boundedProvider = new InMemoryProvider({ maxEntries: 0 });
      await expect(boundedProvider.set(tenantId, 'key', 'value', context)).rejects.toThrow(
        McpError,
      );
      const internalStore = (boundedProvider as unknown as { store: Map<string, unknown> }).store;
      expect(internalStore.size).toBe(0);
    });

    it('throws McpError when a new key would exceed maxEntries', async () => {
      const context = createTestContext();
      const boundedProvider = new InMemoryProvider({ maxEntries: 2 });
      await boundedProvider.set(tenantId, 'key1', 'v1', context);
      await boundedProvider.set(tenantId, 'key2', 'v2', context);

      await expect(boundedProvider.set(tenantId, 'key3', 'v3', context)).rejects.toThrow(McpError);
    });

    it('allows overwriting an existing key at capacity without throwing', async () => {
      const context = createTestContext();
      const boundedProvider = new InMemoryProvider({ maxEntries: 2 });
      await boundedProvider.set(tenantId, 'key1', 'v1', context);
      await boundedProvider.set(tenantId, 'key2', 'v2', context);

      await expect(
        boundedProvider.set(tenantId, 'key1', 'updated', context),
      ).resolves.toBeUndefined();
      await expect(boundedProvider.get(tenantId, 'key1', context)).resolves.toBe('updated');
    });

    it('reclaims expired entries via TTL sweep before rejecting a new write at capacity', async () => {
      const context = createTestContext();
      const boundedProvider = new InMemoryProvider({ maxEntries: 2 });
      await boundedProvider.set(tenantId, 'expiring', 'v1', context, { ttl: 1 });
      await boundedProvider.set(tenantId, 'permanent', 'v2', context);

      now += 1_100; // let 'expiring' pass its TTL

      // Capacity is nominally full (2/2), but the sweep should reclaim the
      // expired 'expiring' entry and make room for the new key.
      await expect(
        boundedProvider.set(tenantId, 'new-key', 'v3', context),
      ).resolves.toBeUndefined();
      await expect(boundedProvider.get(tenantId, 'new-key', context)).resolves.toBe('v3');
    });

    it('reattaches a tenant after a capacity sweep and releases its replacement normally (#403)', async () => {
      const context = createTestContext();
      const boundedProvider = new InMemoryProvider({ maxEntries: 1 });
      await boundedProvider.set(tenantId, 'expired', 'old', context, { ttl: 1 });
      now += 1_001;
      await expect(
        boundedProvider.set(tenantId, 'replacement', 'new', context),
      ).resolves.toBeUndefined();
      await expect(boundedProvider.get(tenantId, 'replacement', context)).resolves.toBe('new');
      await expect(boundedProvider.list(tenantId, '', context)).resolves.toMatchObject({
        keys: ['replacement'],
      });
      expect(boundedProvider.size).toBe(1);
      await expect(boundedProvider.set(tenantId, 'another', 'value', context)).rejects.toThrow(
        'capacity exceeded',
      );
      await expect(boundedProvider.delete(tenantId, 'replacement', context)).resolves.toBe(true);
      expect(boundedProvider.size).toBe(0);
      await boundedProvider.set(tenantId, 'another', 'value', context);
      await expect(boundedProvider.get(tenantId, 'another', context)).resolves.toBe('value');
      await expect(boundedProvider.clear(tenantId, context)).resolves.toBe(1);
      expect(boundedProvider.size).toBe(0);
    });

    it.each([false, true])(
      'commits a batch after reclaiming expired target entries (live sibling: %s)',
      async (liveSibling) => {
        const context = createTestContext();
        const boundedProvider = new InMemoryProvider({ maxEntries: liveSibling ? 3 : 2 });
        await boundedProvider.set(tenantId, 'expired', 'old', context, { ttl: 1 });
        if (liveSibling) await boundedProvider.set(tenantId, 'stable', 'stable', context);
        now += 1_001;
        const batch = new Map([
          ['expired', 'replacement'],
          ['new', 'new-value'],
        ]);
        await boundedProvider.setMany(tenantId, batch, context);
        await expect(
          boundedProvider.getMany(tenantId, [...batch.keys()], context),
        ).resolves.toEqual(batch);
        await expect(boundedProvider.list(tenantId, '', context)).resolves.toMatchObject({
          keys: liveSibling ? ['expired', 'new', 'stable'] : ['expired', 'new'],
        });
        expect(boundedProvider.size).toBe(liveSibling ? 3 : 2);
        await expect(boundedProvider.set(tenantId, 'overflow', 'value', context)).rejects.toThrow(
          McpError,
        );
        await expect(boundedProvider.clear(tenantId, context)).resolves.toBe(liveSibling ? 3 : 2);
        await boundedProvider.set(tenantId, 'after-clear', 'value', context);
        expect(boundedProvider.size).toBe(1);
      },
    );

    it.each([false, true])(
      'keeps batch preflight atomic across a TTL boundary (live sibling: %s)',
      async (liveSibling) => {
        const context = createTestContext();
        const boundedProvider = new InMemoryProvider({ maxEntries: liveSibling ? 2 : 1 });
        now = 1_000;
        await boundedProvider.set(tenantId, 'expiring', 'old', context, { ttl: 1 });
        if (liveSibling) await boundedProvider.set(tenantId, 'stable', 'stable', context);
        const batch = new Map([['new', 'new-value']]);
        if (liveSibling) batch.set('expiring', 'replacement');
        // #403: a second sweep at a later clock snapshot used to invalidate the preflight delta/map.
        vi.mocked(Date.now).mockReturnValueOnce(1_999).mockReturnValue(2_001);
        await expect(boundedProvider.setMany(tenantId, batch, context)).rejects.toThrow(McpError);
        await expect(boundedProvider.get(tenantId, 'new', context)).resolves.toBeNull();
        await expect(boundedProvider.get(tenantId, 'expiring', context)).resolves.toBeNull();
        await expect(boundedProvider.list(tenantId, '', context)).resolves.toMatchObject({
          keys: liveSibling ? ['stable'] : [],
        });
        expect(boundedProvider.size).toBe(liveSibling ? 1 : 0);
        await boundedProvider.setMany(tenantId, new Map([['new', 'retry']]), context);
        await expect(boundedProvider.get(tenantId, 'new', context)).resolves.toBe('retry');
        expect(boundedProvider.size).toBe(liveSibling ? 2 : 1);
      },
    );

    it('preflights setMany capacity so a rejected batch commits no partial entries', async () => {
      const context = createTestContext();
      const boundedProvider = new InMemoryProvider({ maxEntries: 2 });
      await boundedProvider.set(tenantId, 'existing', 'stable', context);

      await expect(
        boundedProvider.setMany(
          tenantId,
          new Map<string, unknown>([
            ['batch-a', 'a'],
            ['batch-b', 'b'],
          ]),
          context,
        ),
      ).rejects.toThrow(McpError);

      await expect(boundedProvider.get(tenantId, 'existing', context)).resolves.toBe('stable');
      await expect(boundedProvider.get(tenantId, 'batch-a', context)).resolves.toBeNull();
      await expect(boundedProvider.get(tenantId, 'batch-b', context)).resolves.toBeNull();
      expect(boundedProvider.size).toBe(1);
    });

    it('sweeps expired batch keys before calculating the atomic capacity delta', async () => {
      const context = createTestContext();
      const boundedProvider = new InMemoryProvider({ maxEntries: 2 });
      await boundedProvider.set(tenantId, 'expired', 'old', context, { ttl: 1 });
      await boundedProvider.set(tenantId, 'stable', 'stable', context);
      now += 1_100;

      await expect(
        boundedProvider.setMany(
          tenantId,
          new Map<string, unknown>([
            ['expired', 'replacement'],
            ['new-key', 'new'],
          ]),
          context,
        ),
      ).rejects.toThrow(McpError);

      await expect(boundedProvider.get(tenantId, 'stable', context)).resolves.toBe('stable');
      await expect(boundedProvider.get(tenantId, 'expired', context)).resolves.toBeNull();
      await expect(boundedProvider.get(tenantId, 'new-key', context)).resolves.toBeNull();
      expect(boundedProvider.size).toBe(1);
    });
  });
});

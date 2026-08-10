/**
 * @fileoverview Unit and compliance tests for the InMemoryProvider implementation.
 * @module tests/storage/providers/inMemory/inMemoryProvider.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeCursor } from '@/storage/core/storageValidation.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { McpError } from '@/types-global/errors.js';
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

  it('evicts entries that have passed their ttl', async () => {
    const context = createTestContext();
    await provider.set(tenantId, 'ephemeral', 'value', context, { ttl: 1 });

    const immediate = await provider.get(tenantId, 'ephemeral', context);
    expect(immediate).toBe('value');

    now += 1_100;
    const afterExpiry = await provider.get(tenantId, 'ephemeral', context);
    expect(afterExpiry).toBeNull();
  });

  it('removes expired entries lazily during list operations', async () => {
    const context = createTestContext();
    await provider.set(tenantId, 'prefix:active', 'active', context, {
      ttl: 5,
    });
    await provider.set(tenantId, 'prefix:expired', 'expired', context, {
      ttl: 1,
    });

    now += 1_100;
    const result = await provider.list(tenantId, 'prefix:', context);
    expect(result.keys).toEqual(['prefix:active']);

    const expiredValue = await provider.get(tenantId, 'prefix:expired', context);
    expect(expiredValue).toBeNull();
  });

  it('isolates data between tenants', async () => {
    const context = createTestContext();
    await provider.set('tenant-a', 'shared-key', 'value-a', context);
    await provider.set('tenant-b', 'shared-key', 'value-b', context);

    const tenantAValue = await provider.get('tenant-a', 'shared-key', context);
    const tenantBValue = await provider.get('tenant-b', 'shared-key', context);

    expect(tenantAValue).toBe('value-a');
    expect(tenantBValue).toBe('value-b');
  });

  it('stores ttl=0 as an immediately-expiring entry rather than a permanent one', async () => {
    const context = createTestContext();
    await provider.set(tenantId, 'immediate', 'value', context, { ttl: 0 });

    now += 1;
    const result = await provider.get(tenantId, 'immediate', context);
    expect(result).toBeNull();
  });

  it('resumes after the next surviving key when a list cursor key no longer exists', async () => {
    const context = createTestContext();
    await provider.set(tenantId, 'alpha', 1, context);
    await provider.set(tenantId, 'charlie', 3, context);
    const staleCursor = encodeCursor('bravo', tenantId);

    const result = await provider.list(tenantId, '', context, { cursor: staleCursor });

    expect(result.keys).toEqual(['charlie']);
  });

  it('getMany, setMany, and deleteMany no-op on empty input', async () => {
    const context = createTestContext();

    await expect(provider.getMany(tenantId, [], context)).resolves.toEqual(new Map());
    await expect(provider.setMany(tenantId, new Map(), context)).resolves.toBeUndefined();
    await expect(provider.deleteMany(tenantId, [], context)).resolves.toBe(0);
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

  describe('capacity management', () => {
    it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects invalid maxEntries configuration: %s',
      (maxEntries) => {
        expect(() => new InMemoryProvider({ maxEntries })).toThrow(McpError);
      },
    );

    it('supports a zero-entry provider that rejects writes without retaining a tenant', () => {
      const context = createTestContext();
      const boundedProvider = new InMemoryProvider({ maxEntries: 0 });
      expect(() => boundedProvider.set(tenantId, 'key', 'value', context)).toThrow(McpError);
      const internalStore = (boundedProvider as unknown as { store: Map<string, unknown> }).store;
      expect(internalStore.size).toBe(0);
    });

    it('throws McpError when a new key would exceed maxEntries', async () => {
      const context = createTestContext();
      const boundedProvider = new InMemoryProvider({ maxEntries: 2 });
      await boundedProvider.set(tenantId, 'key1', 'v1', context);
      await boundedProvider.set(tenantId, 'key2', 'v2', context);

      // set() is not declared `async`, so the capacity guard throws
      // synchronously rather than returning a rejected promise.
      expect(() => boundedProvider.set(tenantId, 'key3', 'v3', context)).toThrow(McpError);
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

    it('still throws when the sweep reclaims nothing and capacity remains full', async () => {
      const context = createTestContext();
      const boundedProvider = new InMemoryProvider({ maxEntries: 2 });
      await boundedProvider.set(tenantId, 'key1', 'v1', context);
      await boundedProvider.set(tenantId, 'key2', 'v2', context);

      // Neither entry has a TTL, so the sweep reclaims 0 and the write must fail
      // synchronously (set() is not declared `async`).
      expect(() => boundedProvider.set(tenantId, 'key3', 'v3', context)).toThrow(McpError);
    });

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

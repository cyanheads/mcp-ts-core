/**
 * @fileoverview Unit and compliance tests for the InMemoryProvider implementation.
 * @module tests/storage/providers/inMemory/inMemoryProvider.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeCursor } from '@/storage/core/storageValidation.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { McpError } from '@/types-global/errors.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

import { storageProviderTests } from '../../../../compliance/storage-provider.test.js';

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

  describe('capacity management', () => {
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
  });
});

// Run the generic compliance suite to ensure contract compatibility
storageProviderTests(() => new InMemoryProvider(), 'InMemoryProvider');

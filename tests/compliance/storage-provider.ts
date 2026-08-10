/**
 * @fileoverview Capability-aware compliance suite for shipped storage providers.
 * @module tests/compliance/storage-provider
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IStorageProvider } from '@/storage/core/IStorageProvider.js';
import { StorageService } from '@/storage/core/StorageService.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

export interface StorageProviderCapabilities {
  /** Provider can deterministically exercise TTL expiry through a mocked Date.now(). */
  deterministicTtl?: boolean;
  /** list() filters expired entries instead of relying on backend lifecycle cleanup. */
  listFiltersExpired?: boolean;
  /** Backend reports whether a deleted key actually existed. */
  preciseDeleteCounts?: boolean;
  /** Provider rejects values that cannot be serialized by its backend. */
  rejectsUnserializableValues?: boolean;
  /** A rejected setMany() leaves none of that batch committed. */
  setManyIsAtomic?: boolean;
}

export interface StorageProviderHarness {
  capabilities?: StorageProviderCapabilities;
  create: () => IStorageProvider | Promise<IStorageProvider>;
  name: string;
  setup?: () => void | Promise<void>;
  teardown?: (provider: IStorageProvider) => void | Promise<void>;
}

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function contextFor(tenantId: string): RequestContext {
  return requestContextService.createRequestContext({
    additionalContext: { tenantId },
    operation: 'storage-provider-compliance',
  });
}

/** Registers the common behavioral, isolation, resilience, and resource-bound contract. */
export function storageProviderTests(harness: StorageProviderHarness): void {
  describe(`Storage Provider Compliance: ${harness.name}`, () => {
    let now = 0;
    let nowSpy: ReturnType<typeof vi.spyOn> | undefined;
    let provider: IStorageProvider;
    let storageA: StorageService;
    let storageB: StorageService;
    let contextA: RequestContext;
    let contextB: RequestContext;

    const capabilities = {
      deterministicTtl: true,
      listFiltersExpired: true,
      preciseDeleteCounts: true,
      rejectsUnserializableValues: false,
      setManyIsAtomic: false,
      ...harness.capabilities,
    };

    beforeEach(async () => {
      now = Date.now();
      /** Only TTL-deterministic harnesses freeze the clock; real backends keep their own timing. */
      if (capabilities.deterministicTtl) {
        nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
      }
      await harness.setup?.();
      provider = await harness.create();
      storageA = new StorageService(provider);
      storageB = new StorageService(provider);
      contextA = contextFor(TENANT_A);
      contextB = contextFor(TENANT_B);
    });

    afterEach(async () => {
      try {
        await harness.teardown?.(provider);
      } finally {
        nowSpy?.mockRestore();
        nowSpy = undefined;
      }
    });

    it('supports CRUD, overwrite, missing-key, and complex-value semantics', async () => {
      const first = { nested: { ok: true }, values: [1, 2, 3] };
      await storageA.set('crud/item', first, contextA);
      await expect(storageA.get('crud/item', contextA)).resolves.toEqual(first);

      await storageA.set('crud/item', 'replacement', contextA);
      await expect(storageA.get('crud/item', contextA)).resolves.toBe('replacement');
      await expect(storageA.get('crud/missing', contextA)).resolves.toBeNull();

      await expect(storageA.delete('crud/item', contextA)).resolves.toBe(true);
      await expect(storageA.get('crud/item', contextA)).resolves.toBeNull();
      await expect(storageA.delete('crud/missing', contextA)).resolves.toBe(
        !capabilities.preciseDeleteCounts,
      );
    });

    it('isolates get, list, delete, and clear operations by tenant', async () => {
      await storageA.set('shared/key', 'value-a', contextA);
      await storageA.set('private/a', 'a-only', contextA);
      await storageB.set('shared/key', 'value-b', contextB);
      await storageB.set('private/b', 'b-only', contextB);

      await expect(storageA.get('shared/key', contextA)).resolves.toBe('value-a');
      await expect(storageB.get('shared/key', contextB)).resolves.toBe('value-b');
      await expect(storageA.get('private/b', contextA)).resolves.toBeNull();
      await expect(storageB.get('private/a', contextB)).resolves.toBeNull();
      await expect(storageA.list('', contextA)).resolves.toMatchObject({
        keys: ['private/a', 'shared/key'],
      });

      await storageA.delete('shared/key', contextA);
      await expect(storageB.get('shared/key', contextB)).resolves.toBe('value-b');
      const cleared = await storageA.clear(contextA);
      expect(cleared).toBeGreaterThanOrEqual(1);
      await expect(storageA.list('', contextA)).resolves.toMatchObject({ keys: [] });
      await storageA.set('after-clear/value', 'recreated', contextA);
      await expect(storageA.get('after-clear/value', contextA)).resolves.toBe('recreated');
      await expect(storageB.list('', contextB)).resolves.toMatchObject({
        keys: ['private/b', 'shared/key'],
      });
    });

    it('supports batch CRUD and stable missing-key semantics', async () => {
      const entries = new Map<string, unknown>([
        ['batch/a', { n: 1 }],
        ['batch/b', { n: 2 }],
        ['batch/c', { n: 3 }],
      ]);
      await storageA.setMany(entries, contextA);

      await expect(
        storageA.getMany(['batch/c', 'batch/missing', 'batch/a'], contextA),
      ).resolves.toEqual(
        new Map<string, unknown>([
          ['batch/c', { n: 3 }],
          ['batch/a', { n: 1 }],
        ]),
      );

      const deleted = await storageA.deleteMany(['batch/a', 'batch/missing', 'batch/c'], contextA);
      expect(deleted).toBe(capabilities.preciseDeleteCounts ? 2 : 3);
      await expect(storageA.getMany(['batch/a', 'batch/b', 'batch/c'], contextA)).resolves.toEqual(
        new Map([['batch/b', { n: 2 }]]),
      );

      await expect(storageA.getMany([], contextA)).resolves.toEqual(new Map());
      await expect(storageA.setMany(new Map(), contextA)).resolves.toBeUndefined();
      await expect(storageA.deleteMany([], contextA)).resolves.toBe(0);
    });

    it('lists in deterministic order with literal prefixes and tenant-bound cursors', async () => {
      await storageA.setMany(
        new Map<string, unknown>([
          ['order/c', 3],
          ['order/a', 1],
          ['order/b', 2],
          ['order-literal/a', 4],
        ]),
        contextA,
      );

      const first = await storageA.list('order/', contextA, { limit: 2 });
      expect(first.keys).toEqual(['order/a', 'order/b']);
      expect(first.nextCursor).toEqual(expect.any(String));
      const cursor = first.nextCursor;
      if (!cursor) throw new Error(`${harness.name} did not return a pagination cursor.`);

      const second = await storageA.list('order/', contextA, {
        cursor,
        limit: 2,
      });
      expect(second).toEqual(expect.objectContaining({ keys: ['order/c'] }));
      expect(second.nextCursor).toBeUndefined();

      await expect(storageB.list('order/', contextB, { cursor, limit: 2 })).rejects.toThrow();
      await expect(
        storageA.list('order/', contextA, { cursor: `${cursor}x`, limit: 2 }),
      ).rejects.toThrow();
      await expect(storageA.list('order-literal/', contextA)).resolves.toMatchObject({
        keys: ['order-literal/a'],
      });
    });

    it('resumes pagination without overlap when the cursor key is deleted', async () => {
      await storageA.setMany(
        new Map<string, unknown>([
          ['resume/a', 1],
          ['resume/b', 2],
          ['resume/c', 3],
        ]),
        contextA,
      );
      const first = await storageA.list('resume/', contextA, { limit: 2 });
      expect(first.keys).toEqual(['resume/a', 'resume/b']);
      const cursor = first.nextCursor;
      if (!cursor) throw new Error(`${harness.name} did not return a pagination cursor.`);
      await storageA.delete('resume/b', contextA);

      const second = await storageA.list('resume/', contextA, {
        cursor,
        limit: 2,
      });
      expect(second.keys).toEqual(['resume/c']);
    });

    if (capabilities.deterministicTtl) {
      it('expires individual and batched values against a deterministic clock', async () => {
        await storageA.set('ttl/single', 'single', contextA, { ttl: 1 });
        await storageA.setMany(
          new Map<string, unknown>([
            ['ttl/batch-a', 'a'],
            ['ttl/batch-b', 'b'],
          ]),
          contextA,
          { ttl: 1 },
        );
        await expect(storageA.get('ttl/single', contextA)).resolves.toBe('single');

        now += 500;
        await expect(storageA.get('ttl/single', contextA)).resolves.toBe('single');
        await expect(storageA.getMany(['ttl/batch-a', 'ttl/batch-b'], contextA)).resolves.toEqual(
          new Map<string, unknown>([
            ['ttl/batch-a', 'a'],
            ['ttl/batch-b', 'b'],
          ]),
        );

        now += 501;
        await expect(storageA.get('ttl/single', contextA)).resolves.toBeNull();
        await expect(storageA.getMany(['ttl/batch-a', 'ttl/batch-b'], contextA)).resolves.toEqual(
          new Map(),
        );
        if (capabilities.listFiltersExpired) {
          await expect(storageA.list('ttl/', contextA)).resolves.toMatchObject({ keys: [] });
        }
      });

      it('treats ttl=0 as immediate expiry rather than permanent storage', async () => {
        await storageA.set('ttl/zero', 'value', contextA, { ttl: 0 });
        now += 1;
        await expect(storageA.get('ttl/zero', contextA)).resolves.toBeNull();
      });
    }

    it('handles concurrent independent writes without loss or cross-tenant leakage', async () => {
      const writes = Array.from({ length: 24 }, (_, index) =>
        storageA.set(`concurrent/${index.toString().padStart(2, '0')}`, index, contextA),
      );
      await Promise.all(writes);

      const keys = Array.from(
        { length: 24 },
        (_, index) => `concurrent/${index.toString().padStart(2, '0')}`,
      );
      const [values, tenantBValues] = await Promise.all([
        storageA.getMany<number>(keys, contextA),
        storageB.getMany<number>(keys, contextB),
      ]);
      expect(values.size).toBe(24);
      expect([...values.values()].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 24 }, (_, index) => index),
      );
      expect(tenantBValues).toEqual(new Map());
    });

    if (capabilities.rejectsUnserializableValues) {
      it('rejects unserializable batches, preserves documented atomicity, and remains usable', async () => {
        const entries = new Map<string, unknown>([
          ['failure/good', 'value'],
          ['failure/bad', 1n],
        ]);
        await expect(storageA.setMany(entries, contextA)).rejects.toThrow();

        if (capabilities.setManyIsAtomic) {
          await expect(storageA.get('failure/good', contextA)).resolves.toBeNull();
        }
        await storageA.set('failure/recovery', 'ok', contextA);
        await expect(storageA.get('failure/recovery', contextA)).resolves.toBe('ok');
      });
    }

    it('rejects malformed cursors and unsafe list limits without touching another tenant', async () => {
      await storageB.set('sentinel/value', 'tenant-b', contextB);
      await expect(storageA.list('', contextA, { cursor: 'not-a-cursor' })).rejects.toThrow();
      await expect(storageA.list('', contextA, { limit: 0 })).rejects.toThrow();
      await expect(storageA.list('', contextA, { limit: 10_001 })).rejects.toThrow();
      await expect(storageB.get('sentinel/value', contextB)).resolves.toBe('tenant-b');
    });
  });
}

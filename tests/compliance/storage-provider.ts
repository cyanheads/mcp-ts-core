/**
 * @fileoverview Capability-aware compliance suite for shipped storage providers.
 * @module tests/compliance/storage-provider
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createContextState } from '@/core/context.js';
import type { IStorageProvider, ListResult } from '@/storage/core/IStorageProvider.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

export interface StorageProviderCapabilities {
  /** Provider can deterministically exercise TTL expiry through a mocked Date.now(). */
  deterministicTtl?: boolean;
  /** list() filters expired entries instead of relying on backend lifecycle cleanup. */
  listFiltersExpired?: boolean;
  /** Backend reports whether a deleted key actually existed. */
  preciseDeleteCounts?: boolean;
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

function cyclicValue(): Record<string, unknown> {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  return cyclic;
}

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

    /** Follows `nextCursor` from the first page to the last, bounded so a cursor loop fails fast. */
    async function walkPages(prefix: string, limit: number): Promise<ListResult[]> {
      const pages: ListResult[] = [];
      let cursor: string | undefined;
      do {
        const page = await storageA.list(prefix, contextA, { limit, ...(cursor && { cursor }) });
        pages.push(page);
        cursor = page.nextCursor;
      } while (cursor && pages.length < 10);
      return pages;
    }

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

    it('reads batches past 100 keys, and a 1,000-key ctx.state.list page, with every value', async () => {
      const keys = Array.from(
        { length: 1_000 },
        (_, index) => `bulk/${String(index).padStart(4, '0')}`,
      );
      const stored = new Map(keys.map((key, index) => [key, { index }]));
      await storageA.setMany(stored, contextA);
      const expectedFor = (wanted: string[]) =>
        new Map(wanted.map((key) => [key, stored.get(key)]));

      // D1 binds at most 100 parameters per statement; these straddle its chunk boundaries.
      for (const count of [98, 99, 196, 197, 1_000]) {
        const wanted = keys.slice(0, count);
        await expect(storageA.getMany(wanted, contextA)).resolves.toEqual(expectedFor(wanted));
      }

      // Repeated and missing keys interleaved across every chunk.
      const present = keys.slice(0, 250);
      const mixed = present.flatMap((key, index) =>
        index % 3 === 0 ? [key, `bulk-missing/${index}`, key] : [key],
      );
      await expect(storageA.getMany(mixed, contextA)).resolves.toEqual(expectedFor(present));

      // ctx.state.list reads the page's values through getMany when the provider lists keys only.
      const state = createContextState(storageA, contextA, new AbortController().signal);
      const page = await state.list('bulk/');
      expect(page.cursor).toBeUndefined();
      expect(page.items).toEqual(keys.map((key) => ({ key, value: stored.get(key) })));

      if (capabilities.deterministicTtl) {
        const shortLived = Array.from({ length: 50 }, (_, index) => `bulk-ttl/${index}`);
        await storageA.setMany(new Map(shortLived.map((key) => [key, 'short'])), contextA, {
          ttl: 1,
        });
        // One short-lived key before every four permanent ones, so each chunk holds some.
        const interleaved = shortLived.flatMap((key, index) => [
          key,
          ...keys.slice(index * 4, index * 4 + 4),
        ]);
        await expect(storageA.getMany(interleaved, contextA)).resolves.toHaveProperty('size', 250);
        now += 1_001;
        await expect(storageA.getMany(interleaved, contextA)).resolves.toEqual(
          expectedFor(keys.slice(0, 200)),
        );
      }
    });

    it('isolates batch reads, overwrites, and deletes for colliding tenant keys', async () => {
      await storageA.setMany(
        new Map([
          ['batch/shared', 'a'],
          ['batch/private', 'a-only'],
        ]),
        contextA,
      );
      await storageB.setMany(
        new Map([
          ['batch/shared', 'b'],
          ['batch/other', 'b-only'],
        ]),
        contextB,
      );
      await expect(storageB.getMany(['batch/shared', 'batch/private'], contextB)).resolves.toEqual(
        new Map([['batch/shared', 'b']]),
      );
      await storageA.setMany(new Map([['batch/shared', 'a-updated']]), contextA);
      await storageA.deleteMany(['batch/shared', 'batch/other'], contextA);
      await expect(storageB.getMany(['batch/shared', 'batch/other'], contextB)).resolves.toEqual(
        new Map([
          ['batch/shared', 'b'],
          ['batch/other', 'b-only'],
        ]),
      );
      await expect(storageA.get('batch/private', contextA)).resolves.toBe('a-only');
    });

    it('validates the entire batch before writing or deleting any entry', async () => {
      await storageA.set('preflight/stable', 'original', contextA);
      await expect(
        storageA.setMany(
          new Map([
            ['preflight/stable', 'changed'],
            ['../invalid', 'invalid'],
          ]),
          contextA,
        ),
      ).rejects.toMatchObject({ name: 'McpError', code: JsonRpcErrorCode.ValidationError });
      await expect(storageA.get('preflight/stable', contextA)).resolves.toBe('original');
      await expect(
        storageA.deleteMany(['preflight/stable', '../invalid'], contextA),
      ).rejects.toMatchObject({ name: 'McpError', code: JsonRpcErrorCode.ValidationError });
      await expect(storageA.get('preflight/stable', contextA)).resolves.toBe('original');
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

      await expect(storageB.list('order/', contextB, { cursor, limit: 2 })).rejects.toMatchObject({
        name: 'McpError',
        code: JsonRpcErrorCode.InvalidParams,
      });
      await expect(
        storageA.list('order/', contextA, { cursor: `${cursor}x`, limit: 2 }),
      ).rejects.toMatchObject({ name: 'McpError', code: JsonRpcErrorCode.InvalidParams });
      await expect(storageA.list('order-literal/', contextA)).resolves.toMatchObject({
        keys: ['order-literal/a'],
      });
    });

    it('matches list prefixes literally and only at the start of a key', async () => {
      await storageA.setMany(
        new Map<string, unknown>([
          ['lit/a', 1],
          ['x/lit/b', 2],
          ['lit_x/c', 3],
          ['litax/d', 4],
        ]),
        contextA,
      );

      await expect(storageA.list('lit/', contextA)).resolves.toMatchObject({ keys: ['lit/a'] });
      // `_` is a SQL LIKE wildcard; a provider that leaves it unescaped also matches `litax/d`.
      await expect(storageA.list('lit_x/', contextA)).resolves.toMatchObject({
        keys: ['lit_x/c'],
      });
    });

    it('matches list prefixes case-sensitively', async () => {
      await storageA.setMany(
        new Map<string, unknown>([
          ['case/item-1', 1],
          ['case/Item-2', 2],
          ['case/ITEM-3', 3],
          ['case/iTem-4', 4],
        ]),
        contextA,
      );

      await expect(storageA.list('case/item', contextA)).resolves.toMatchObject({
        keys: ['case/item-1'],
      });
      const pages = await walkPages('case/item', 1);
      expect(pages.map((page) => page.keys)).toEqual([['case/item-1']]);
      expect(pages.at(-1)?.nextCursor).toBeUndefined();
      await expect(storageA.list('case/I', contextA)).resolves.toMatchObject({
        keys: ['case/ITEM-3', 'case/Item-2'],
      });
    });

    it('keeps keys that differ only in case distinct', async () => {
      await storageA.setMany(
        new Map<string, unknown>([
          ['user/1', 'one'],
          ['User/2', 'two'],
          ['USER/3', 'three'],
        ]),
        contextA,
      );

      await expect(storageA.list('user/', contextA)).resolves.toMatchObject({ keys: ['user/1'] });
      await expect(storageA.list('User/', contextA)).resolves.toMatchObject({ keys: ['User/2'] });
      await expect(storageA.list('USER/', contextA)).resolves.toMatchObject({ keys: ['USER/3'] });
      await expect(storageA.get('user/2', contextA)).resolves.toBeNull();
      await expect(storageA.get('User/2', contextA)).resolves.toBe('two');

      await storageA.set('Rk', 'upper', contextA);
      await storageA.set('rk', 'lower', contextA);
      await expect(storageA.get('Rk', contextA)).resolves.toBe('upper');
      await storageA.delete('rk', contextA);
      await expect(storageA.getMany(['Rk', 'rk', 'USER/3'], contextA)).resolves.toEqual(
        new Map([
          ['Rk', 'upper'],
          ['USER/3', 'three'],
        ]),
      );
    });

    it('keeps a dot segment distinct from the key it would normalize to', async () => {
      await storageA.set('x/./y', 'dotted', contextA);
      await storageA.set('x/y', 'plain', contextA);

      await expect(storageA.get('x/./y', contextA)).resolves.toBe('dotted');
      await expect(storageA.get('x/y', contextA)).resolves.toBe('plain');
      await expect(storageA.list('x/./', contextA)).resolves.toMatchObject({ keys: ['x/./y'] });
      await expect(storageA.list('x/', contextA)).resolves.toMatchObject({
        keys: ['x/./y', 'x/y'],
      });
    });

    it.each([
      ['a', 'a/b'],
      ['a/b', 'a'],
    ])(
      'stores a key beside a key it prefixes when %s is written before %s',
      async (first, second) => {
        await storageA.set(first, `value of ${first}`, contextA);
        await storageA.set(second, `value of ${second}`, contextA);

        await expect(storageA.getMany(['a', 'a/b'], contextA)).resolves.toEqual(
          new Map([
            ['a', 'value of a'],
            ['a/b', 'value of a/b'],
          ]),
        );
        await expect(storageA.list('a', contextA)).resolves.toMatchObject({ keys: ['a', 'a/b'] });
        await storageA.delete('a', contextA);
        await expect(storageA.list('a', contextA)).resolves.toMatchObject({ keys: ['a/b'] });
      },
    );

    it('round-trips and lists empty, dot, and slash-edge segments as written', async () => {
      const edges = ['.', '/', '/lead', 'm//n', 't/'];
      await storageA.setMany(new Map(edges.map((key) => [key, `value of ${key}`])), contextA);

      for (const key of edges) {
        await expect(storageA.get(key, contextA)).resolves.toBe(`value of ${key}`);
      }
      // The spellings path normalization would collapse these keys into.
      await expect(storageA.getMany(['m/n', 't', 'lead'], contextA)).resolves.toEqual(new Map());
      await expect(storageA.list('', contextA)).resolves.toMatchObject({
        keys: ['.', '/', '/lead', 'm//n', 't/'],
      });
      await expect(storageA.list('/', contextA)).resolves.toMatchObject({ keys: ['/', '/lead'] });
      await expect(storageA.list('m/', contextA)).resolves.toMatchObject({ keys: ['m//n'] });
      await expect(storageA.list('t/', contextA)).resolves.toMatchObject({ keys: ['t/'] });
      await expect(storageA.deleteMany(['/', 't/'], contextA)).resolves.toBe(2);
      await expect(storageA.list('', contextA)).resolves.toMatchObject({
        keys: ['.', '/lead', 'm//n'],
      });
    });

    it('isolates every tenant ID from every other', async () => {
      const forTenant = (tenantId: string) => ({
        context: contextFor(tenantId),
        storage: new StorageService(provider),
        tenantId,
      });
      const mixed = forTenant('TenantA');
      const lower = forTenant('tenanta');
      const upper = forTenant('TENANTA');
      const tenants = [mixed, lower, upper];
      for (const { context, storage, tenantId } of tenants) {
        await storage.set('k', `value of ${tenantId}`, context);
      }

      for (const { context, storage, tenantId } of tenants) {
        await expect(storage.get('k', context)).resolves.toBe(`value of ${tenantId}`);
        await expect(storage.list('', context)).resolves.toMatchObject({ keys: ['k'] });
      }

      await lower.storage.delete('k', lower.context);
      await expect(lower.storage.get('k', lower.context)).resolves.toBeNull();
      await expect(mixed.storage.get('k', mixed.context)).resolves.toBe('value of TenantA');
      await expect(upper.storage.get('k', upper.context)).resolves.toBe('value of TENANTA');

      await expect(upper.storage.clear(upper.context)).resolves.toBe(1);
      await expect(upper.storage.list('', upper.context)).resolves.toMatchObject({ keys: [] });
      await expect(mixed.storage.get('k', mixed.context)).resolves.toBe('value of TenantA');
      await expect(mixed.storage.list('', mixed.context)).resolves.toMatchObject({ keys: ['k'] });
    });

    it('gives every valid tenant ID a keyspace of its own, the longest included', async () => {
      const forTenant = (tenantId: string) => ({
        context: contextFor(tenantId),
        storage: new StorageService(provider),
        tenantId,
      });
      const upper = forTenant('U'.repeat(86));
      const lower = forTenant('u'.repeat(86));
      const longest = forTenant('V'.repeat(128));
      const oneLetterApart = forTenant(`${'V'.repeat(127)}v`);
      const mixed = forTenant(`${'Ab.'.repeat(42)}Ab`);
      const tenants = [upper, lower, longest, oneLetterApart, mixed];
      for (const { context, storage, tenantId } of tenants) {
        await storage.set('one', `one of ${tenantId}`, context);
        await storage.setMany(
          new Map([
            ['batch/a', 'a'],
            ['batch/b', `b of ${tenantId}`],
          ]),
          context,
        );
      }

      for (const { context, storage, tenantId } of tenants) {
        await expect(storage.get('one', context)).resolves.toBe(`one of ${tenantId}`);
        await expect(storage.getMany(['batch/a', 'batch/b'], context)).resolves.toEqual(
          new Map([
            ['batch/a', 'a'],
            ['batch/b', `b of ${tenantId}`],
          ]),
        );
        await expect(storage.list('', context)).resolves.toMatchObject({
          keys: ['batch/a', 'batch/b', 'one'],
        });
      }

      await expect(upper.storage.delete('one', upper.context)).resolves.toBe(true);
      await expect(upper.storage.deleteMany(['batch/a'], upper.context)).resolves.toBe(1);
      await expect(longest.storage.clear(longest.context)).resolves.toBe(3);

      await expect(upper.storage.list('', upper.context)).resolves.toMatchObject({
        keys: ['batch/b'],
      });
      await expect(longest.storage.list('', longest.context)).resolves.toMatchObject({ keys: [] });
      for (const { context, storage, tenantId } of [lower, oneLetterApart, mixed]) {
        await expect(storage.get('one', context)).resolves.toBe(`one of ${tenantId}`);
        await expect(storage.list('', context)).resolves.toMatchObject({
          keys: ['batch/a', 'batch/b', 'one'],
        });
      }
    });

    it('lists a 60-character prefix holding underscores, page by page', async () => {
      const prefix = `long/${'a_'.repeat(26)}bc/`;
      expect(prefix).toHaveLength(60);
      const matching = [`${prefix}1`, `${prefix}2`, `${prefix}3`];
      await storageA.setMany(
        new Map<string, unknown>([
          ...matching.map((key, index): [string, unknown] => [key, index]),
          [`long/${'a_'.repeat(26)}bd/1`, 'sibling'],
          [prefix.slice(0, -2), 'shorter'],
          [`long/${'a-'.repeat(26)}bc/1`, 'underscore read as a wildcard'],
        ]),
        contextA,
      );

      await expect(storageA.list(prefix, contextA)).resolves.toMatchObject({ keys: matching });
      const pages = await walkPages(prefix, 1);
      expect(pages.flatMap((page) => page.keys)).toEqual(matching);
      expect(pages.at(-1)?.nextCursor).toBeUndefined();
    });

    it('walks every key exactly once and ends without a cursor on an exact-multiple page', async () => {
      const keys = Array.from(
        { length: 12 },
        (_, index) => `walk/${String(index).padStart(2, '0')}`,
      );
      await storageA.setMany(new Map(keys.map((key, index) => [key, { index }])), contextA);

      for (const [limit, pageSizes] of [
        [5, [5, 5, 2]],
        [4, [4, 4, 4]],
      ] as const) {
        const pages = await walkPages('walk/', limit);
        expect(pages.map((page) => page.keys.length)).toEqual(pageSizes);
        expect(pages.flatMap((page) => page.keys)).toEqual(keys);
        for (const page of pages) {
          // Pre-fetched values are optional; when a provider supplies them they must be the stored ones.
          if (page.values) {
            expect(page.values).toEqual(await storageA.getMany(page.keys, contextA));
          }
        }
      }
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

      it.each(['set', 'setMany'] as const)(
        'replaces and clears expiry when %s overwrites an entry',
        async (operation) => {
          const write = (value: string, ttl?: number) =>
            operation === 'set'
              ? storageA.set(
                  'ttl/overwrite',
                  value,
                  contextA,
                  ttl === undefined ? undefined : { ttl },
                )
              : storageA.setMany(
                  new Map([['ttl/overwrite', value]]),
                  contextA,
                  ttl === undefined ? undefined : { ttl },
                );
          await write('initial', 1);
          now += 500;
          await write('refreshed', 2);
          now += 501;
          await expect(storageA.get('ttl/overwrite', contextA)).resolves.toBe('refreshed');
          await write('permanent');
          now += 3_000;
          await expect(storageA.get('ttl/overwrite', contextA)).resolves.toBe('permanent');
        },
      );

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

    it('stores the JSON form of a value, not a reference to it', async () => {
      const stored = { at: '2026-01-01T00:00:00.000Z', n: 1, tags: ['a'] };
      const single = { at: new Date(stored.at), n: 1, tags: ['a'] };
      const batched = { at: new Date(stored.at), n: 1, tags: ['a'] };
      await storageA.set('json/single', single, contextA);
      await storageA.setMany(new Map([['json/batched', batched]]), contextA);
      single.n = 2;
      single.tags.push('b');
      batched.n = 2;

      const read = await storageA.get<typeof stored>('json/single', contextA);
      expect(read).toEqual(stored);
      if (read) {
        read.n = 3;
        read.tags.push('c');
      }
      await expect(storageA.get('json/single', contextA)).resolves.toEqual(stored);
      await expect(storageA.getMany(['json/batched'], contextA)).resolves.toEqual(
        new Map([['json/batched', stored]]),
      );
    });

    it.each([
      ['a top-level undefined', undefined],
      ['a top-level function', () => 1],
      ['a top-level symbol', Symbol('unencodable')],
      ['a nested bigint', { big: 10n }],
      ['a cyclic reference', cyclicValue()],
    ])('rejects %s on set and setMany without writing', async (_label, value) => {
      const unencodable = { name: 'McpError', code: JsonRpcErrorCode.SerializationError };
      await storageA.set('unencodable/existing', 'original', contextA);
      await expect(storageA.set('unencodable/existing', value, contextA)).rejects.toMatchObject(
        unencodable,
      );
      await expect(storageA.set('unencodable/new', value, contextA)).rejects.toMatchObject(
        unencodable,
      );
      await expect(
        storageA.setMany(
          new Map<string, unknown>([
            ['unencodable/batch-good', 'value'],
            ['unencodable/batch-bad', value],
          ]),
          contextA,
        ),
      ).rejects.toMatchObject(unencodable);

      await expect(storageA.get('unencodable/existing', contextA)).resolves.toBe('original');
      await expect(
        storageA.getMany(
          ['unencodable/new', 'unencodable/batch-good', 'unencodable/batch-bad'],
          contextA,
        ),
      ).resolves.toEqual(new Map());
      await expect(storageA.list('unencodable/', contextA)).resolves.toMatchObject({
        keys: ['unencodable/existing'],
      });
    });

    it('rejects malformed cursors and unsafe list limits without touching another tenant', async () => {
      await storageB.set('sentinel/value', 'tenant-b', contextB);
      const invalidListOption = { name: 'McpError', code: JsonRpcErrorCode.ValidationError };
      await expect(storageA.list('', contextA, { cursor: 'not-a-cursor' })).rejects.toMatchObject(
        invalidListOption,
      );
      await expect(storageA.list('', contextA, { limit: 0 })).rejects.toMatchObject(
        invalidListOption,
      );
      await expect(storageA.list('', contextA, { limit: 10_001 })).rejects.toMatchObject(
        invalidListOption,
      );
      await expect(storageB.get('sentinel/value', contextB)).resolves.toBe('tenant-b');
    });
  });
}

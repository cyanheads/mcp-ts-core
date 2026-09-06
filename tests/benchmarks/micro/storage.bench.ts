/**
 * @fileoverview Real storage-service overhead and namespace scaling, without external I/O.
 * @module tests/benchmarks/micro/storage.bench
 */
import { bench, describe, expect } from 'vitest';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { benchmarkOptions } from '../harness/options.js';

for (const size of [100, 1_000, 10_000]) {
  describe(`storage / ${size} resident keys / 128-character values`, () => {
    const provider = new InMemoryProvider({ maxEntries: size });
    const storage = new StorageService(provider);
    const context = requestContextService.createRequestContext({
      additionalContext: { tenantId: 'benchmark' },
    });
    const keys = Array.from({ length: size }, (_, i) => `row/${String(i).padStart(5, '0')}`);
    const value = 'x'.repeat(128);
    const entries = new Map(keys.map((key) => [key, value]));
    const batchKeys = keys.slice(0, 100);
    const batch = new Map(batchKeys.map((key) => [key, value]));
    let lastGet: unknown;
    let lastBatch = new Map<string, unknown>();
    let lastPage: string[] = [];

    const setup = async () => {
      await storage.clear(context);
      await storage.setMany(entries, context);
      expect(await storage.get(keys[0]!, context)).toBe(value);
      expect(await storage.getMany(batchKeys, context)).toEqual(batch);
      expect((await storage.list('row/', context, { limit: 50 })).keys).toEqual(keys.slice(0, 50));
    };
    bench(
      'get one existing key',
      async () => {
        lastGet = await storage.get(keys[0]!, context);
      },
      {
        ...benchmarkOptions,
        setup,
        teardown: () => {
          expect(lastGet).toBe(value);
        },
      },
    );
    bench(
      'getMany 100 existing keys',
      async () => {
        lastBatch = await storage.getMany(batchKeys, context);
      },
      {
        ...benchmarkOptions,
        setup,
        teardown: () => {
          expect(lastBatch).toEqual(batch);
        },
      },
    );
    bench(
      'setMany overwrite 100 existing keys',
      async () => {
        await storage.setMany(batch, context);
      },
      {
        ...benchmarkOptions,
        setup,
        teardown: () => {
          expect(provider.size).toBe(size);
        },
      },
    );
    bench(
      'list first 50 keys of full matching prefix',
      async () => {
        lastPage = (await storage.list('row/', context, { limit: 50 })).keys;
      },
      {
        ...benchmarkOptions,
        setup,
        teardown: () => {
          expect(lastPage).toEqual(keys.slice(0, 50));
        },
      },
    );
  });
}

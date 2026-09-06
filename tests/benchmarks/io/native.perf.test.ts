/** @fileoverview Real filesystem, SQLite mirror, and DuckDB query/export measurements. */
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CanvasRegistry } from '@/services/canvas/core/CanvasRegistry.js';
import { DataCanvas } from '@/services/canvas/core/DataCanvas.js';
import { DuckdbProvider } from '@/services/canvas/providers/duckdb/DuckdbProvider.js';
import { sqliteMirrorStore } from '@/services/mirror/sqlite/sqliteMirrorStore.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { FileSystemProvider } from '@/storage/providers/fileSystem/fileSystemProvider.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { measure } from './harness/measure.js';
import { type Measurement, writeReport } from './harness/report.js';

const context: RequestContext = {
  requestId: 'native-benchmark',
  timestamp: '2026-01-01T00:00:00.000Z',
  tenantId: 'benchmark',
};

it('measures filesystem read, overwrite, and TTL-aware listing at fixed occupancy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-file-bench-'));
  const measurements: Measurement[] = [];
  try {
    for (const size of [100, 1_000]) {
      const storage = new StorageService(new FileSystemProvider(join(root, String(size))));
      const keys = Array.from({ length: size }, (_, i) => `row/${String(i).padStart(5, '0')}`);
      const value = 'x'.repeat(1_024);
      // Seed in bounded batches; fixture creation is excluded from measurement.
      for (let offset = 0; offset < keys.length; offset += 50) {
        await storage.setMany(
          new Map(keys.slice(offset, offset + 50).map((key) => [key, value])),
          context,
        );
      }
      for (let round = 1; round <= 3; round++) {
        measurements.push({
          name: `filesystem get / ${size} keys / 1 KiB / concurrency 8`,
          round,
          result: await measure({
            concurrency: 8,
            operations: 128,
            warmup: 16,
            run: (i) => storage.get(keys[i % size]!, context),
            verify: (result) => expect(result).toBe(value),
          }),
        });
        measurements.push({
          name: `filesystem overwrite / ${size} keys / 1 KiB / concurrency 8`,
          round,
          result: await measure({
            concurrency: 8,
            operations: 64,
            warmup: 16,
            // One key per in-flight operation, with fixed occupancy and changing contents.
            run: (i) => storage.set(keys[i % size]!, `${round}-${i}-${value}`, context),
            verify: () => {},
          }),
        });
        const expected = new Map(keys.map((key) => [key, value]));
        for (let i = 0; i < 64; i++) expected.set(keys[i % size]!, `${round}-${i}-${value}`);
        expect(await storage.getMany(keys, context)).toEqual(expected);
        measurements.push({
          name: `filesystem list first 50 / ${size} matching keys`,
          round,
          result: await measure({
            concurrency: 1,
            operations: 32,
            warmup: 4,
            run: () => storage.list('row/', context, { limit: 50 }),
            verify: (result) => {
              expect(result.keys).toEqual(keys.slice(0, 50));
              expect(result.nextCursor).toBeTypeOf('string');
              expect(result.values).toEqual(
                new Map(keys.slice(0, 50).map((key) => [key, expected.get(key)])),
              );
            },
          }),
        });
        for (let offset = 0; offset < keys.length; offset += 50)
          await storage.setMany(
            new Map(keys.slice(offset, offset + 50).map((key) => [key, value])),
            context,
          );
      }
      expect(await readdir(join(root, String(size), 'benchmark', 'row'))).toHaveLength(size);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  await writeReport('native-filesystem', measurements, {
    cache: 'warm OS page cache; no fsync or cold-cache claim',
  });
});

it('measures SQLite mirror reads, indexed queries, FTS, and transactional batches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-sqlite-bench-'));
  const measurements: Measurement[] = [];
  try {
    for (const size of [1_000, 10_000]) {
      const store = sqliteMirrorStore({
        path: join(root, `${size}.sqlite`),
        table: 'items',
        primaryKey: 'id',
        columns: { id: 'TEXT', title: 'TEXT', category: 'TEXT', score: 'INTEGER' },
        indexes: [{ columns: ['category'] }],
        fts: ['title'],
      });
      try {
        const rows = Array.from({ length: size }, (_, i) => ({
          id: String(i),
          title: `fixture entry ${i}`,
          category: `group${i % 10}`,
          score: i,
        }));
        await store.applyBatch(rows, []);
        for (let round = 1; round <= 3; round++) {
          measurements.push({
            name: `SQLite getByIds 50 / ${size} rows`,
            round,
            result: await measure({
              concurrency: 1,
              operations: 128,
              warmup: 16,
              run: () => store.getByIds(rows.slice(0, 50).map(({ id }) => id)),
              verify: (result) => expect(result).toEqual(rows.slice(0, 50)),
            }),
          });
          measurements.push({
            name: `SQLite indexed query+count / ${size} rows`,
            round,
            result: await measure({
              concurrency: 1,
              operations: 128,
              warmup: 16,
              run: () =>
                store.query({
                  filters: [{ column: 'category', op: 'eq', value: 'group0' }],
                  limit: 50,
                  offset: 0,
                }),
              verify: (result) => {
                expect(result.total).toBe(size / 10);
                expect(result.rows).toEqual(
                  rows.filter(({ category }) => category === 'group0').slice(0, 50),
                );
              },
            }),
          });
          measurements.push({
            name: `SQLite FTS query+count / ${size} rows`,
            round,
            result: await measure({
              concurrency: 1,
              operations: 64,
              warmup: 8,
              run: () => store.query({ match: 'fixture', limit: 50, offset: 0 }),
              verify: (result) => {
                expect(result.total).toBe(size);
                expect(result.rows).toEqual(rows.slice(0, 50));
              },
            }),
          });
          let revision = 0;
          const updated = rows.slice(0, 100).map((row) => ({ ...row }));
          measurements.push({
            name: `SQLite transactional upsert 100+FTS / ${size} rows`,
            round,
            result: await measure({
              concurrency: 1,
              operations: 64,
              warmup: 8,
              run: () => {
                revision++;
                for (const row of updated) {
                  row.score = -revision;
                  row.title = `revision${revision}`;
                }
                return store.applyBatch(updated, []);
              },
              verify: () => {},
            }),
          });
          expect(await store.getByIds(updated.map(({ id }) => id))).toEqual(updated);
          expect(await store.count()).toBe(size);
          expect(
            (await store.query({ match: `revision${revision}`, limit: 100, offset: 0 })).rows,
          ).toEqual(updated);
          expect((await store.query({ match: 'fixture', limit: 1, offset: 0 })).total).toBe(
            size - 100,
          );
          await store.applyBatch(rows.slice(0, 100), []);
        }
        expect((await store.integrityCheck()).ok).toBe(true);
      } finally {
        await store.close();
      }
      // #364: Bun's driver may retain prepared statements after close. Process isolation
      // bounds their lifetime; this is not a connection-release or memory benchmark.
      expect((await stat(join(root, `${size}.sqlite`))).size).toBeGreaterThan(0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  await writeReport('native-sqlite', measurements, {
    driver: process.versions.bun ? 'bun:sqlite' : 'better-sqlite3',
    journal: 'WAL',
    synchronous: 'NORMAL',
    fts: 'unicode61 remove_diacritics 2',
  });
});

it('measures gated DuckDB queries and real CSV file exports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-duckdb-bench-'));
  const measurements: Measurement[] = [];
  const provider = new DuckdbProvider({
    memoryLimitMb: 256,
    exportRootPath: root,
    tempRootPath: join(root, 'scratch'),
    defaultRowLimit: 1_000,
    schemaSniffRows: 100,
  });
  const canvas = new DataCanvas(
    provider,
    new CanvasRegistry(provider, {
      ttlMs: 600_000,
      absoluteCapMs: 600_000,
      maxCanvasesPerTenant: 2,
      sweeperIntervalMs: 0,
    }),
  );
  try {
    for (const size of [1_000, 10_000]) {
      const instance = await canvas.acquire(undefined, context);
      // Materialize deterministic native rows without repeating table creation in timing.
      const values = Array.from({ length: size }, (_, i) => `(${i}, ${i % 10})`).join(',');
      await instance.query(`SELECT * FROM (VALUES ${values}) t(id, category)`, {
        registerAs: 'items',
        preview: 0,
      });
      for (let round = 1; round <= 3; round++) {
        measurements.push({
          name: `DuckDB gate+bounded read / ${size} rows`,
          round,
          result: await measure({
            concurrency: 1,
            operations: 64,
            warmup: 8,
            run: () => instance.query('SELECT id FROM items ORDER BY id', { rowLimit: 50 }),
            verify: (result) => {
              expect(result.rows).toEqual(Array.from({ length: 50 }, (_, id) => ({ id })));
              expect(result.truncated).toBe(true);
              expect(result.rowCount).toBe(50);
            },
          }),
        });
        measurements.push({
          name: `DuckDB gate+aggregation / ${size} rows`,
          round,
          result: await measure({
            concurrency: 1,
            operations: 64,
            warmup: 8,
            run: () =>
              instance.query(
                'SELECT category, count(*)::INTEGER AS n FROM items GROUP BY category ORDER BY category',
              ),
            verify: (result) =>
              expect(result.rows).toEqual(
                Array.from({ length: 10 }, (_, category) => ({ category, n: size / 10 })),
              ),
          }),
        });
        const path = join(root, `export-${size}.csv`);
        measurements.push({
          name: `DuckDB CSV file export / ${size} rows`,
          round,
          result: await measure({
            concurrency: 1,
            operations: 32,
            warmup: 4,
            run: () => instance.export('items', { path: `export-${size}.csv`, format: 'csv' }),
            verify: (result) => {
              expect(result.rowCount).toBe(size);
              expect(result.sizeBytes).toBeGreaterThan(0);
            },
          }),
        });
        const csv = await readFile(path, 'utf8');
        expect(csv).toBe(
          `id,category\n${Array.from({ length: size }, (_, id) => `${id},${id % 10}\n`).join('')}`,
        );
        // Exports reuse one file: no growth with the number of measured operations.
        expect((await readdir(root)).filter((name) => name.endsWith('.csv')).length).toBe(
          size === 1_000 ? 1 : 2,
        );
      }
    }
  } finally {
    try {
      await canvas.shutdown(context);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  expect(canvas.countForTenant(context)).toBe(0);
  await writeReport('native-duckdb', measurements, {
    database: 'in-memory DuckDB with native query execution and file exports',
    memoryLimitMb: 256,
    cache: 'warm; overwrite one CSV per size',
  });
});

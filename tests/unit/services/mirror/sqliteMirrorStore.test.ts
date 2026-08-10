/**
 * @fileoverview Tests for the SQLite mirror store — upsert/tombstone, generic
 * query (FTS, filters, sort, pagination), getByIds ordering, sync-state
 * round-trip with durable-marker preservation, the raw-handle escape hatch,
 * integrity check, and the schema-version migration runner.
 * @module tests/unit/services/mirror/sqliteMirrorStore
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type SqliteMirrorStoreSpec,
  sqliteMirrorStore,
} from '@/services/mirror/sqlite/sqliteMirrorStore.js';
import type { MirrorRow, MirrorStore } from '@/services/mirror/types.js';

function specFor(
  path: string,
  overrides: Partial<SqliteMirrorStoreSpec> = {},
): SqliteMirrorStoreSpec {
  return {
    path,
    table: 'papers',
    primaryKey: 'id',
    columns: {
      id: 'TEXT',
      title: 'TEXT',
      abstract: 'TEXT',
      category: 'TEXT',
      updated: 'TEXT',
      year: 'INTEGER',
    },
    fts: ['title', 'abstract'],
    indexes: [{ columns: ['category'] }, { columns: ['updated'] }],
    ...overrides,
  };
}

const rec = (id: string, over: Partial<MirrorRow> = {}): MirrorRow => ({
  id,
  title: 'Default title',
  abstract: 'Default abstract',
  category: 'cs.LG',
  updated: '2024-01-01',
  year: 2024,
  ...over,
});

describe('sqliteMirrorStore', () => {
  let dir: string;
  let store: MirrorStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mirror-store-test-'));
    store = sqliteMirrorStore(specFor(join(dir, 'mirror.db')));
  });
  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('[Symbol.asyncDispose] closes the store without error', async () => {
    await store.applyBatch([rec('asyncDispose1')], []);
    expect(await store.count()).toBe(1);

    const disposable = store as unknown as { [Symbol.asyncDispose](): Promise<void> };
    await expect(disposable[Symbol.asyncDispose]()).resolves.toBeUndefined();

    // Calling close() again on an already-closed store is a no-op
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('closes exactly once when close races the lazy asynchronous open', async () => {
    const opening = store.raw();
    const firstClose = store.close();
    const concurrentClose = store.close();
    const reopenDuringClose = store.raw();
    const handle = await opening;

    expect(concurrentClose).toBe(firstClose);
    await expect(Promise.all([firstClose, concurrentClose])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(() => handle.prepare('SELECT 1').get()).toThrow();
    const reopened = await reopenDuringClose;
    expect(reopened).not.toBe(handle);
    await expect(store.close()).resolves.toBeUndefined();
    expect(() => reopened.prepare('SELECT 1').get()).toThrow();
  });

  it('upserts records and counts them', async () => {
    await store.applyBatch([rec('1'), rec('2')], []);
    expect(await store.count()).toBe(2);
  });

  it('treats repeat upserts as idempotent (replace in place)', async () => {
    await store.applyBatch([rec('1', { title: 'first' })], []);
    await store.applyBatch([rec('1', { title: 'second' })], []);
    expect(await store.count()).toBe(1);
    const [row] = await store.getByIds(['1']);
    expect(row?.title).toBe('second');
  });

  it('deletes tombstoned records', async () => {
    await store.applyBatch([rec('1'), rec('2')], []);
    await store.applyBatch([], ['1']);
    expect(await store.count()).toBe(1);
    expect(await store.getByIds(['1'])).toHaveLength(0);
  });

  it('getByIds preserves input order and skips missing', async () => {
    await store.applyBatch([rec('a'), rec('b'), rec('c')], []);
    const rows = await store.getByIds(['c', 'missing', 'a']);
    expect(rows.map((r) => r.id)).toEqual(['c', 'a']);
  });

  it('matches via FTS and returns total', async () => {
    await store.applyBatch(
      [
        rec('1', { title: 'Transformers for protein folding' }),
        rec('2', { title: 'Cosmic microwave background survey' }),
      ],
      [],
    );
    const result = await store.query({ match: 'protein', limit: 10, offset: 0 });
    expect(result.total).toBe(1);
    expect(result.rows[0]?.id).toBe('1');
  });

  it('applies equality and IN filters', async () => {
    await store.applyBatch(
      [
        rec('1', { category: 'cs.LG' }),
        rec('2', { category: 'astro-ph' }),
        rec('3', { category: 'q-bio' }),
      ],
      [],
    );
    const eq = await store.query({
      filters: [{ column: 'category', op: 'eq', value: 'cs.LG' }],
      limit: 10,
      offset: 0,
    });
    expect(eq.rows.map((r) => r.id)).toEqual(['1']);
    const inList = await store.query({
      filters: [{ column: 'category', op: 'in', value: ['cs.LG', 'q-bio'] }],
      limit: 10,
      offset: 0,
    });
    expect(inList.total).toBe(2);
  });

  it('applies range filters and sorts by column', async () => {
    await store.applyBatch(
      [rec('1', { year: 2022 }), rec('2', { year: 2024 }), rec('3', { year: 2023 })],
      [],
    );
    const result = await store.query({
      filters: [{ column: 'year', op: 'gte', value: 2023 }],
      sort: { column: 'year', direction: 'desc' },
      limit: 10,
      offset: 0,
    });
    expect(result.rows.map((r) => r.year)).toEqual([2024, 2023]);
  });

  it('paginates with a stable total', async () => {
    await store.applyBatch([rec('1'), rec('2'), rec('3'), rec('4')], []);
    const page = await store.query({
      sort: { column: 'id', direction: 'asc' },
      limit: 2,
      offset: 2,
    });
    expect(page.total).toBe(4);
    expect(page.rows.map((r) => r.id)).toEqual(['3', '4']);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a malformed query limit (%s)',
    async (limit) => {
      await expect(store.query({ limit, offset: 0 })).rejects.toThrow(/limit must be an integer/);
    },
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a malformed query offset (%s)',
    async (offset) => {
      await expect(store.query({ limit: 1, offset })).rejects.toThrow(/offset must be an integer/);
    },
  );

  it('leaves query and batch cardinality unbounded unless the spec declares a ceiling', async () => {
    const largeIds = Array.from({ length: 501 }, (_, index) => `id-${index}`);
    const manyFilters = Array.from({ length: 33 }, () => ({
      column: 'category',
      op: 'eq' as const,
      value: 'cs.LG',
    }));
    const manyValues = Array.from({ length: 501 }, (_, index) => `category-${index}`);

    await expect(store.getByIds(largeIds)).resolves.toEqual([]);
    await expect(store.query({ limit: 50_000, offset: 2_000_000 })).resolves.toMatchObject({
      rows: [],
      total: 0,
    });
    await expect(store.query({ filters: manyFilters, limit: 1, offset: 0 })).resolves.toMatchObject(
      {
        rows: [],
        total: 0,
      },
    );
    await expect(
      store.query({
        filters: [{ column: 'category', op: 'in', value: manyValues }],
        limit: 1,
        offset: 0,
      }),
    ).resolves.toMatchObject({ rows: [], total: 0 });
  });

  it('enforces spec-declared ceilings at and past their boundary', async () => {
    const bounded = sqliteMirrorStore(
      specFor(join(dir, 'bounded.db'), {
        limits: { limit: 1_000, offset: 1_000_000, getByIds: 2, filters: 2, filterValues: 3 },
      }),
    );
    try {
      await expect(bounded.query({ limit: 1_000, offset: 1_000_000 })).resolves.toMatchObject({
        total: 0,
      });
      await expect(bounded.query({ limit: 1_001, offset: 0 })).rejects.toThrow(
        /limit must be an integer from 1 to 1000/,
      );
      await expect(bounded.query({ limit: 1, offset: 1_000_001 })).rejects.toThrow(
        /offset must be an integer from 0 to 1000000/,
      );
      await expect(bounded.getByIds(['a', 'b'])).resolves.toEqual([]);
      await expect(bounded.getByIds(['a', 'b', 'c'])).rejects.toThrow(/cannot exceed 2 values/);
      await expect(
        bounded.query({
          filters: [
            { column: 'category', op: 'eq', value: 'a' },
            { column: 'category', op: 'eq', value: 'b' },
            { column: 'category', op: 'eq', value: 'c' },
          ],
          limit: 1,
          offset: 0,
        }),
      ).rejects.toThrow(/cannot exceed 2 filters/);
      await expect(
        bounded.query({
          filters: [{ column: 'category', op: 'in', value: ['a', 'b', 'c', 'd'] }],
          limit: 1,
          offset: 0,
        }),
      ).rejects.toThrow(/cannot exceed 3 bound values/);
    } finally {
      await bounded.close();
    }
  });

  it('sorts by FTS relevance when match + relevance are given', async () => {
    await store.applyBatch(
      [
        rec('1', { title: 'neural networks', abstract: 'a brief mention of attention' }),
        rec('2', { title: 'attention attention attention', abstract: 'attention is all you need' }),
      ],
      [],
    );
    const result = await store.query({
      match: 'attention',
      sort: 'relevance',
      limit: 10,
      offset: 0,
    });
    expect(result.rows[0]?.id).toBe('2');
  });

  it('rejects match when the mirror has no FTS index', async () => {
    const noFts = sqliteMirrorStore(specFor(join(dir, 'noFts.db'), { fts: [] }));
    await expect(noFts.query({ match: 'x', limit: 1, offset: 0 })).rejects.toThrow(/no FTS index/);
    await noFts.close();
  });

  it('rejects an unknown filter or sort column', async () => {
    await expect(
      store.query({ filters: [{ column: 'ghost', op: 'eq', value: 1 }], limit: 1, offset: 0 }),
    ).rejects.toThrow(/Unknown mirror filter column/);
    await expect(
      store.query({ sort: { column: 'ghost', direction: 'asc' }, limit: 1, offset: 0 }),
    ).rejects.toThrow(/Unknown mirror sort column/);
  });

  it('round-trips sync state and preserves durable markers on omission', async () => {
    await store.writeState({
      status: 'complete',
      checkpoint: '2024-05-01',
      completedAt: '2024-05-01T00:00:00.000Z',
      total: 42,
    });
    // A later in-progress write omits completedAt/total — they must survive.
    await store.writeState({ status: 'in_progress', cursor: 'tok-1', checkpoint: '2024-05-02' });
    const state = await store.readState();
    expect(state.status).toBe('in_progress');
    expect(state.cursor).toBe('tok-1');
    expect(state.checkpoint).toBe('2024-05-02');
    expect(state.completedAt).toBe('2024-05-01T00:00:00.000Z');
    expect(state.total).toBe(42);
  });

  it('exposes the raw handle for custom access paths', async () => {
    await store.applyBatch([rec('1', { category: 'cs.LG' })], []);
    const handle = await store.raw();
    const row = handle
      .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM papers WHERE category = ?`)
      .get('cs.LG');
    expect(row?.n).toBe(1);
  });

  it('passes an integrity check', async () => {
    await store.applyBatch([rec('1')], []);
    const { ok } = await store.integrityCheck();
    expect(ok).toBe(true);
  });
});

describe('sqliteMirrorStore migrations', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mirror-migrate-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const schemaVersion = async (store: MirrorStore): Promise<number> => {
    const handle = await store.raw();
    return (
      handle.prepare<{ v: number }>(`SELECT MAX(version) AS v FROM schema_version`).get()?.v ?? 0
    );
  };
  const migLogCount = async (store: MirrorStore): Promise<number> => {
    const handle = await store.raw();
    const exists = handle
      .prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='mig_log'`,
      )
      .get();
    if ((exists?.n ?? 0) === 0) return -1; // table absent
    return handle.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM mig_log`).get()?.n ?? 0;
  };

  it('stamps a fresh database to the target version without running migrations', async () => {
    const path = join(dir, 'fresh.db');
    const store = sqliteMirrorStore(
      specFor(path, {
        version: 2,
        migrations: [
          {
            version: 2,
            up: (h) => h.exec('CREATE TABLE mig_log(x); INSERT INTO mig_log VALUES (1);'),
          },
        ],
      }),
    );
    await store.count(); // trigger open
    expect(await schemaVersion(store)).toBe(2);
    expect(await migLogCount(store)).toBe(-1); // migration skipped on fresh DB
    await store.close();
  });

  it('runs a pending migration once when upgrading an existing database', async () => {
    const path = join(dir, 'upgrade.db');
    const v1 = sqliteMirrorStore(specFor(path)); // version defaults to 1
    await v1.applyBatch([rec('1')], []);
    expect(await schemaVersion(v1)).toBe(1);
    await v1.close();

    const migration = {
      version: 2,
      up: (h: Awaited<ReturnType<MirrorStore['raw']>>) =>
        h.exec('CREATE TABLE mig_log(x); INSERT INTO mig_log VALUES (1);'),
    };

    const v2 = sqliteMirrorStore(specFor(path, { version: 2, migrations: [migration] }));
    await v2.count();
    expect(await schemaVersion(v2)).toBe(2);
    expect(await migLogCount(v2)).toBe(1);
    await v2.close();

    // Reopening at the same version must not re-run the migration.
    const again = sqliteMirrorStore(specFor(path, { version: 2, migrations: [migration] }));
    await again.count();
    expect(await migLogCount(again)).toBe(1);
    await again.close();
  });
});

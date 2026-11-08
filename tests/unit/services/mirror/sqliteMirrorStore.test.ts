/**
 * @fileoverview Tests for the SQLite mirror store — upsert/tombstone, generic
 * query (FTS, filters, sort, pagination), getByIds ordering, sync-state
 * round-trip with durable-marker preservation, the raw-handle escape hatch,
 * integrity check, and the schema-version migration runner.
 * @module tests/unit/services/mirror/sqliteMirrorStore
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineMirror } from '@/services/mirror/core/defineMirror.js';
import {
  MIRROR_STORE_UNAVAILABLE_HINT,
  openSqliteHandle,
} from '@/services/mirror/sqlite/handle.js';
import { buildSchemaSql } from '@/services/mirror/sqlite/schema.js';
import {
  type SqliteMirrorStoreSpec,
  sqliteMirrorStore,
} from '@/services/mirror/sqlite/sqliteMirrorStore.js';
import type {
  MirrorRow,
  MirrorStore,
  QueryFilter,
  SqliteHandle,
  SqlValue,
  SyncContext,
  SyncPage,
} from '@/services/mirror/types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { runtimeCaps } from '@/utils/internal/runtime.js';
import { runMirrorProcess } from './mirror-process.js';

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

/** A runtime value outside the declared type, as unvalidated JSON or a source produces. */
const untyped = (value: unknown) => value as never;

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

  /**
   * `getByIds` matches each id as the key column compares it: the row an `eq`
   * filter on the key, or a tombstone with that id, hits. Each case seeds its
   * own store keyed by the declared type under test.
   */
  describe('getByIds matching on the key column', () => {
    let keyed: MirrorStore[];

    beforeEach(() => {
      keyed = [];
    });
    afterEach(async () => {
      await Promise.all(keyed.map((s) => s.close()));
    });

    /** A store keyed by `id` declared as `decl`, holding one row per seed id titled `row <id>`. */
    async function storeKeyedBy(decl: string, ids: Array<string | number>): Promise<MirrorStore> {
      const keyedStore = sqliteMirrorStore({
        path: join(dir, `keyed-${keyed.length}.db`),
        table: 'items',
        primaryKey: 'id',
        columns: { id: decl, title: 'TEXT' },
      });
      keyed.push(keyedStore);
      await keyedStore.applyBatch(
        ids.map((id) => ({ id, title: `row ${id}` })),
        [],
      );
      return keyedStore;
    }

    const titles = (rows: MirrorRow[]): unknown[] => rows.map((r) => r.title);

    it('returns INTEGER-keyed rows for string ids, in the requested order', async () => {
      const integerKeyed = await storeKeyedBy('INTEGER', [1, 2]);
      expect(await integerKeyed.getByIds(['1', '2'])).toEqual([
        { id: 1, title: 'row 1' },
        { id: 2, title: 'row 2' },
      ]);
      expect(await integerKeyed.getByIds(['2', '1'])).toEqual([
        { id: 2, title: 'row 2' },
        { id: 1, title: 'row 1' },
      ]);
    });

    it.each([
      ['INTEGER', [1, 2], '01', 'row 1'],
      ['INTEGER', [1, 2], '1.0', 'row 1'],
      ['INTEGER', [1, 2], ' 1', 'row 1'],
      ['REAL', [1.5, 2], '1.5', 'row 1.5'],
      ['REAL', [1.5, 2], '2.0', 'row 2'],
      ['NUMERIC', [1, 1.5], '1.0', 'row 1'],
    ] as const)(
      'matches a %s key seeded %j with id %j, as an eq filter on the key does',
      async (decl, seed, id, title) => {
        const typed = await storeKeyedBy(decl, [...seed]);
        const rows = await typed.getByIds([id]);
        expect(titles(rows)).toEqual([title]);
        const viaEq = await typed.query({
          filters: [{ column: 'id', op: 'eq', value: id }],
          limit: 10,
          offset: 0,
        });
        expect(rows).toEqual(viaEq.rows);
      },
    );

    it('skips an id with no row and one the key affinity cannot equate', async () => {
      const integerKeyed = await storeKeyedBy('INTEGER', [1, 2]);
      expect(await integerKeyed.getByIds(['0x1'])).toEqual([]);
      expect(titles(await integerKeyed.getByIds(['1', '3', '2']))).toEqual(['row 1', 'row 2']);
    });

    // Ids are typed as strings; untyped code can still hand over a bigint.
    it.each([
      ['INTEGER', [1, 2]],
      ['TEXT', ['1', '2']],
    ] as const)('reads a bigint id against a %s key as its digits', async (decl, seed) => {
      const typed = await storeKeyedBy(decl, [...seed]);
      const ids = [2n, '1'] as never;
      expect(titles(await typed.getByIds(ids))).toEqual(['row 2', 'row 1']);
    });

    it('rejects a bigint id outside the signed 64-bit range, as an eq filter on the key does', async () => {
      const textKeyed = await storeKeyedBy('TEXT', ['1180591620717411303424']);
      const refusal = { code: JsonRpcErrorCode.ValidationError, data: { parameter: 1 } };
      await expect(textKeyed.getByIds(['1', 2n ** 70n] as never)).rejects.toMatchObject(refusal);
      await expect(
        textKeyed.query({
          filters: [{ column: 'id', op: 'eq', value: (2n ** 70n) as never }],
          limit: 10,
          offset: 0,
        }),
      ).rejects.toMatchObject(refusal);
    });

    // Untyped code can hand over ids of other kinds; each finds what an eq filter finds.
    it.each<[string, Array<string | number>, unknown, string[]]>([
      ['TEXT', ['2024', '2024.0'], 2024, ['row 2024']],
      ['TEXT', ['1', 'true'], true, ['row 1']],
      ['TEXT', ['5.5'], 5.5, ['row 5.5']],
      ['TEXT', ['9007199254740993'], 9007199254740993n, ['row 9007199254740993']],
      ['INTEGER', [5, 6], 5, ['row 5']],
      ['INTEGER', [1, 2], true, ['row 1']],
      ['REAL', [1.5, 2], 1.5, ['row 1.5']],
      ['REAL', [9007199254740992], '9007199254740993', []],
      ['NUMERIC', [2024], '2024.0', ['row 2024']],
    ])(
      'matches a %s key seeded %j with the untyped id %s, as an eq filter on the key does',
      async (decl, seed, id, expected) => {
        const typed = await storeKeyedBy(decl, seed);
        const rows = await typed.getByIds([id] as never);
        expect(titles(rows)).toEqual(expected);
        const viaEq = await typed.query({
          filters: [{ column: 'id', op: 'eq', value: id as never }],
          limit: 10,
          offset: 0,
        });
        expect(rows).toEqual(viaEq.rows);
      },
    );

    it("returns a BLOB key's row for its bytes at each position requested, as an eq filter on the key does", async () => {
      const bytes = () => Uint8Array.of(0x35);
      const blobKeyed = await storeKeyedBy('BLOB', [bytes() as never, '5']);
      const rows = await blobKeyed.getByIds([bytes(), '5', 'missing', bytes()] as never);
      expect(titles(rows)).toEqual(['row 53', 'row 5', 'row 53']);
      const viaEq = await blobKeyed.query({
        filters: [{ column: 'id', op: 'eq', value: bytes() as never }],
        limit: 10,
        offset: 0,
      });
      expect(rows[0]).toEqual(viaEq.rows[0]);
    });

    // Statistics on a store this small lead SQLite to read the table before the id list.
    it.each([
      ['INTEGER', [1, 2]],
      ['TEXT', ['1', '2']],
    ] as const)(
      'returns %s-keyed rows in the requested order after ANALYZE',
      async (decl, seed) => {
        const typed = await storeKeyedBy(decl, [...seed]);
        (await typed.raw()).exec('ANALYZE');
        expect(titles(await typed.getByIds(['2', '1']))).toEqual(['row 2', 'row 1']);
        expect(titles(await typed.getByIds(['1', '2', '1']))).toEqual(['row 1', 'row 2', 'row 1']);
      },
    );

    it("returns a repeated id's row at each position it is requested", async () => {
      const integerKeyed = await storeKeyedBy('INTEGER', [1, 2]);
      expect(titles(await integerKeyed.getByIds(['1', '2', '1']))).toEqual([
        'row 1',
        'row 2',
        'row 1',
      ]);
    });

    it('finds an INTEGER key above 2^53 by its exact digits, not its rounded neighbour', async () => {
      // INTEGER affinity stores each seed string as the exact 64-bit integer.
      const integerKeyed = await storeKeyedBy('INTEGER', ['9007199254740992', '9007199254740993']);
      expect(titles(await integerKeyed.getByIds(['9007199254740993']))).toEqual([
        'row 9007199254740993',
      ]);
    });

    it("accepts 32,767 ids, one past the bound-parameter ceiling of the Node driver's SQLite", async () => {
      const textKeyed = await storeKeyedBy('TEXT', ['a', 'b']);
      const ids = [...Array.from({ length: 32_765 }, (_, i) => `missing-${i}`), 'b', 'a'];
      expect(ids).toHaveLength(32_767);
      expect(titles(await textKeyed.getByIds(ids))).toEqual(['row b', 'row a']);
    });

    it('matches a TEXT key exactly, so 01 and 1 stay different rows', async () => {
      const textKeyed = await storeKeyedBy('TEXT', ['1', '01']);
      expect(titles(await textKeyed.getByIds(['01', '1', ' 1', '1.0']))).toEqual([
        'row 01',
        'row 1',
      ]);
    });

    it.each(['INTEGER', 'REAL', 'NUMERIC', 'TEXT'])(
      "looks each id up through the %s key's index rather than scanning the table",
      async (decl) => {
        const typed = await storeKeyedBy(decl, ['1']);
        const handle = await typed.raw();
        const prepare = vi.spyOn(handle, 'prepare');
        let prepared: string[];
        try {
          expect(titles(await typed.getByIds(['1']))).toEqual(['row 1']);
          prepared = prepare.mock.calls.map(([sql]) => sql);
        } finally {
          prepare.mockRestore();
        }
        expect(prepared).toHaveLength(1);
        const plan = handle
          .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${prepared[0]}`)
          .all('["1"]')
          .map((step) => step.detail);
        expect(plan).toContainEqual(
          expect.stringMatching(
            /^SEARCH items USING (?:INTEGER PRIMARY KEY|INDEX sqlite_autoindex_items_1) \(/,
          ),
        );
        expect(plan.filter((step) => /^SCAN items\b/.test(step))).toEqual([]);
      },
    );
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

  it('rejects a primary key that columns only inherits from Object.prototype at construction', () => {
    expect(() =>
      sqliteMirrorStore(specFor(join(dir, 'inherited.db'), { primaryKey: 'toString' })),
    ).toThrowError(expect.objectContaining({ code: JsonRpcErrorCode.ConfigurationError }));
  });

  it.each(['like', 'IN', 'toString', '__proto__', undefined])(
    'rejects the filter op %s with ValidationError before preparing any statement',
    async (op) => {
      const handle = await store.raw();
      const prepare = vi.spyOn(handle, 'prepare');
      try {
        const error = await store
          .query({
            filters: [
              { column: 'category', op: 'eq', value: 'cs.LG' },
              { column: 'title', op: op as never, value: 'x' },
            ],
            limit: 1,
            offset: 0,
          })
          .then(
            () => expect.unreachable('expected the query to reject'),
            (err: unknown) => err,
          );
        expect(error).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { field: 'filters[1].op', operators: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in'] },
        });
        if (typeof op === 'string') expect((error as McpError).message).toContain(`"${op}"`);
        expect(prepare).not.toHaveBeenCalled();
      } finally {
        prepare.mockRestore();
      }
    },
  );

  it.each(['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const)(
    'rejects an array value on the %s operator, naming filters[i].value',
    async (op) => {
      await store.applyBatch([rec('1', { year: 2022 }), rec('2', { year: 2023 })], []);
      for (const value of [[2023], [2023, 2024], []]) {
        await expect(
          store.query({
            filters: [
              { column: 'category', op: 'eq', value: 'cs.LG' },
              { column: 'year', op, value },
            ],
            limit: 10,
            offset: 0,
          }),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: `Mirror filters[1].value is an array; the ${op} operator takes a string, a number, or null, and only in takes a list.`,
          data: { field: 'filters[1].value' },
        });
      }
    },
  );

  it.each(['ascending', 'ASC', 'up', undefined])(
    'rejects the sort direction %s with ValidationError naming sort.direction',
    async (direction) => {
      await store.applyBatch([rec('1', { year: 2022 }), rec('2', { year: 2023 })], []);
      await expect(
        store.query({
          sort: { column: 'year', direction: direction as never },
          limit: 10,
          offset: 0,
        }),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: 'Mirror sort.direction must be "asc" or "desc".',
        data: { field: 'sort.direction' },
      });
    },
  );

  it.each(['"unbalanced', 'a OR', 'nosuchcol:x', 'AND', '(a', 'a)', 'NEAR(a b, x)', 'NEAR/3', '*'])(
    "rejects the malformed match %j with ValidationError carrying SQLite's message, under every sort",
    async (match) => {
      await store.applyBatch([rec('1', { title: 'hello world' })], []);
      for (const sort of [undefined, 'relevance', { column: 'year', direction: 'asc' }] as const) {
        const error = await store
          .query({ match, ...(sort !== undefined && { sort }), limit: 10, offset: 0 })
          .then(
            () => expect.unreachable('expected the query to reject'),
            (err: unknown) => err,
          );
        expect(error).toBeInstanceOf(McpError);
        expect(error).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { field: 'match' },
          cause: { code: 'SQLITE_ERROR' },
        });
        const { message, cause } = error as McpError & { cause: Error };
        expect(message).toBe(`Mirror match is not a valid FTS5 query: ${cause.message}.`);
      }
    },
  );

  it.each(['NEAR(a)', '^hello', '-title:abstract', 'title:hello', 'hel*', '"hello world"'])(
    'runs the valid match %j',
    async (match) => {
      await store.applyBatch([rec('1', { title: 'hello world' })], []);
      await expect(store.query({ match, limit: 10, offset: 0 })).resolves.toMatchObject({
        total: expect.any(Number),
      });
    },
  );

  it("passes a store's own failure under a valid match through unchanged: a dropped FTS table", async () => {
    await store.applyBatch([rec('1', { title: 'hello world' })], []);
    (await store.raw()).exec('DROP TABLE papers_fts');
    const error = await store.query({ match: 'hello', limit: 10, offset: 0 }).then(
      () => expect.unreachable('expected the query to reject'),
      (err: unknown) => err,
    );
    expect(error).not.toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: 'SQLITE_ERROR',
      message: expect.stringContaining('papers_fts'),
    });
  });

  it("passes a store's own failure under a valid match through unchanged: corrupted FTS pages", async () => {
    const path = join(dir, 'corrupt.db');
    const seeded = sqliteMirrorStore(specFor(path));
    await seeded.applyBatch(
      Array.from({ length: 4_000 }, (_, k) =>
        rec(`r${k}`, { title: `hello word${k} ${'lorem ipsum dolor '.repeat(8)}` }),
      ),
      [],
    );
    const seededHandle = await seeded.raw();
    const pageSize =
      seededHandle.prepare<{ page_size: number }>('PRAGMA page_size').get()?.page_size ?? 0;
    const roots = seededHandle
      .prepare<{ rootpage: number }>(
        `SELECT rootpage FROM sqlite_schema WHERE name IN ('papers_fts_data', 'papers_fts_idx')`,
      )
      .all();
    seededHandle.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    await seeded.close();
    expect(roots).toHaveLength(2);
    const file = await open(path, 'r+');
    try {
      for (const { rootpage } of roots) {
        await file.write(Buffer.alloc(pageSize, 0xff), 0, pageSize, (rootpage - 1) * pageSize);
      }
    } finally {
      await file.close();
    }

    const corrupted = sqliteMirrorStore(specFor(path));
    try {
      const error = await corrupted.query({ match: 'hello', limit: 10, offset: 0 }).then(
        () => expect.unreachable('expected the query to reject'),
        (err: unknown) => err,
      );
      expect(error).not.toBeInstanceOf(McpError);
      expect(error).toMatchObject({ code: expect.stringMatching(/^SQLITE_CORRUPT/) });
    } finally {
      await corrupted.close();
    }
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

  it('close() finalizes statements prepared through the raw handle', async () => {
    const handle = await store.raw();
    const insert = handle.prepare(`INSERT INTO papers (id) VALUES (?)`);
    insert.run('before-close');
    await store.close();
    // A statement kept across close() must not keep writing to the file.
    expect(() => insert.run('after-close')).toThrow();
  });

  it('passes an integrity check', async () => {
    await store.applyBatch([rec('1')], []);
    const { ok } = await store.integrityCheck();
    expect(ok).toBe(true);
  });

  /** FTS5's own consistency check of the index against the content table. */
  async function expectFtsConsistent(): Promise<void> {
    const handle = await store.raw();
    expect(() =>
      handle.exec(`INSERT INTO papers_fts(papers_fts) VALUES('integrity-check')`),
    ).not.toThrow();
  }

  const matchIds = async (match: string): Promise<unknown[]> =>
    (await store.query({ match, limit: 10, offset: 0 })).rows.map((r) => r.id);

  it('re-indexes an upsert that rewrites an indexed column', async () => {
    await store.applyBatch([rec('1', { title: 'quasar survey' })], []);
    await store.applyBatch([rec('1', { title: 'pulsar timing' })], []);
    expect(await matchIds('quasar')).toEqual([]);
    expect(await matchIds('pulsar')).toEqual(['1']);
    await expectFtsConsistent();
  });

  it('removes a tombstoned record from the index, so a reused rowid inherits none of its terms', async () => {
    await store.applyBatch(
      [rec('1', { title: 'quasar survey' }), rec('2', { title: 'pulsar timing' })],
      [],
    );
    // Deleting the highest rowid lets the next insert take that rowid again.
    await store.applyBatch([], ['2']);
    await store.applyBatch([rec('3', { title: 'nebula catalog' })], []);
    expect(await matchIds('pulsar')).toEqual([]);
    expect(await matchIds('nebula')).toEqual(['3']);
    await expectFtsConsistent();
  });

  it.each([
    ['eq', ['3']],
    ['ne', ['1', '2']],
    ['gt', ['2']],
    ['gte', ['2', '3']],
    ['lt', ['1']],
    ['lte', ['1', '3']],
  ] as const)('applies the %s filter operator', async (op, ids) => {
    await store.applyBatch(
      [rec('1', { year: 2022 }), rec('2', { year: 2024 }), rec('3', { year: 2023 })],
      [],
    );
    const result = await store.query({
      filters: [{ column: 'year', op, value: 2023 }],
      sort: { column: 'id', direction: 'asc' },
      limit: 10,
      offset: 0,
    });
    expect(result.rows.map((r) => r.id)).toEqual(ids);
    expect(result.total).toBe(ids.length);
  });

  it.each([
    ['insertion order', undefined],
    ['relevance', 'relevance'],
  ] as const)('combines a match with filters under %s sort', async (_label, sort) => {
    await store.applyBatch(
      [
        rec('1', { title: 'attention attention', category: 'cs.LG' }),
        rec('2', { title: 'attention', category: 'astro-ph' }),
        rec('3', { title: 'convolution', category: 'cs.LG' }),
        rec('4', { title: 'attention mechanisms', category: 'cs.LG' }),
      ],
      [],
    );
    const result = await store.query({
      match: 'attention',
      filters: [{ column: 'category', op: 'eq', value: 'cs.LG' }],
      ...(sort !== undefined && { sort }),
      limit: 10,
      offset: 0,
    });
    expect(result.total).toBe(2);
    expect(result.rows.map((r) => r.id)).toEqual(['1', '4']);
  });
});

/**
 * Values outside `SqlValue` reach the store from unvalidated JSON and source
 * code. Each kind binds the same on both runtimes or is refused naming where
 * it sat; the handle's own mapping is covered in `handle.test.ts`.
 */
describe('sqliteMirrorStore value binding', () => {
  let dir: string;
  let store: MirrorStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mirror-store-binding-test-'));
    store = sqliteMirrorStore({
      path: join(dir, 'binding.db'),
      table: 'items',
      primaryKey: 'id',
      columns: { id: 'TEXT', flag: 'INTEGER', note: 'TEXT', n: 'INTEGER', extra: '' },
      fts: ['note'],
    });
  });
  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** Each column of row `id` as text, with its SQLite storage class. */
  async function stored(id: string): Promise<unknown> {
    const handle = await store.raw();
    return handle
      .prepare(
        `SELECT CAST(flag AS TEXT) AS flag, typeof(flag) AS flagType,
                CAST(note AS TEXT) AS note, typeof(note) AS noteType,
                CAST(n AS TEXT) AS n, typeof(n) AS nType,
                hex(extra) AS extra, typeof(extra) AS extraType
         FROM items WHERE id = ?`,
      )
      .get(id);
  }

  /** Ids of the rows `filter` matches. */
  async function matching(filter: QueryFilter): Promise<unknown[]> {
    return (await store.query({ filters: [filter], limit: 10, offset: 0 })).rows.map((r) => r.id);
  }

  const validation = (field: string, kind: string) => ({
    code: JsonRpcErrorCode.ValidationError,
    message: `Mirror ${field} is ${kind}; it must be a string, a number, or null.`,
    data: { field },
  });

  it('stores a boolean from parsed JSON as the integer 1 or 0, and as the text 1 or 0 in a TEXT column', async () => {
    await store.applyBatch(
      JSON.parse(
        '[{"id":"a","flag":true,"note":true},{"id":"b","flag":false,"note":false}]',
      ) as MirrorRow[],
      [],
    );
    expect(await store.getByIds(['a', 'b'])).toEqual([
      { id: 'a', flag: 1, note: '1', n: null, extra: null },
      { id: 'b', flag: 0, note: '0', n: null, extra: null },
    ]);
  });

  it('binds true as the integer 1 as a filter value, a raw() parameter, and a tombstone', async () => {
    await store.applyBatch(
      [
        { id: '1', flag: 1 },
        { id: '2', flag: 0 },
      ],
      [],
    );
    const flagged = await store.query({
      filters: [{ column: 'flag', op: 'eq', value: untyped(true) }],
      limit: 10,
      offset: 0,
    });
    expect(flagged.rows.map((r) => r.id)).toEqual(['1']);

    const handle = await store.raw();
    expect(
      handle.prepare('SELECT v, typeof(v) AS ty FROM (SELECT ? AS v)').get(untyped(true)),
    ).toEqual({ v: 1, ty: 'integer' });

    // The TEXT key compares the integer 1 as the text '1'.
    await store.applyBatch([], [untyped(true)]);
    expect((await store.getByIds(['1', '2'])).map((r) => r.id)).toEqual(['2']);
  });

  it.each([
    ['above', 2n ** 63n],
    ['below', -(2n ** 63n) - 1n],
  ])(
    'rejects a bigint %s the signed 64-bit range in a record, a tombstone, and a raw() parameter',
    async (_side, value) => {
      await store.applyBatch([{ id: 'kept', n: 1 }], []);
      const bigintParameter = (parameter: number) => ({
        code: JsonRpcErrorCode.ValidationError,
        data: { parameter },
      });

      // `n` is the fourth column the upsert binds.
      await expect(store.applyBatch([{ id: 'big', n: untyped(value) }], [])).rejects.toMatchObject(
        bigintParameter(4),
      );
      await expect(store.applyBatch([], [untyped(value)])).rejects.toMatchObject(
        bigintParameter(1),
      );
      const handle = await store.raw();
      expect(() => handle.prepare('SELECT ? AS v').get(untyped(value))).toThrowError(
        expect.objectContaining(bigintParameter(1)),
      );
      expect((await store.getByIds(['kept', 'big'])).map((r) => r.id)).toEqual(['kept']);
    },
  );

  it('stores a safe integer as its digits in a TEXT column and as an integer in an untyped one, so a filter of its text or its number matches', async () => {
    await store.applyBatch([{ id: 'a', note: 2024, extra: 5 }], []);
    expect(await stored('a')).toMatchObject({
      note: '2024',
      noteType: 'text',
      extraType: 'integer',
    });

    expect(await matching({ column: 'note', op: 'eq', value: '2024' })).toEqual(['a']);
    expect(await matching({ column: 'note', op: 'eq', value: 2024 })).toEqual(['a']);
    expect(await matching({ column: 'note', op: 'in', value: [2024] })).toEqual(['a']);
    // The FTS index holds the token 2024 alone, with no fractional part.
    expect((await store.query({ match: '0', limit: 10, offset: 0 })).total).toBe(0);
  });

  it('binds a safe integer as an integer in raw() SQL, so integer arithmetic applies', async () => {
    const handle = await store.raw();
    expect(handle.prepare('SELECT ? / 2 AS v, typeof(?) AS t').get(5, 5)).toEqual({
      v: 2,
      t: 'integer',
    });
  });

  it('stores both signed 64-bit bounds and a small bigint in a record as integers', async () => {
    await store.applyBatch(
      [
        { id: 'max', n: untyped(2n ** 63n - 1n) },
        { id: 'min', n: untyped(-(2n ** 63n)) },
        { id: 'five', n: untyped(5n) },
      ],
      [],
    );
    expect(await stored('max')).toMatchObject({ n: '9223372036854775807', nType: 'integer' });
    expect(await stored('min')).toMatchObject({ n: '-9223372036854775808', nType: 'integer' });
    expect(await stored('five')).toMatchObject({ n: '5', nType: 'integer' });
  });

  it('rejects a record passed as a tombstone and keeps the row it named', async () => {
    await store.applyBatch([{ id: 'a', note: 'kept' }], []);
    await expect(store.applyBatch([], [untyped({ id: 'a' })])).rejects.toMatchObject(
      validation('tombstones[0]', 'an object'),
    );
    expect(await store.getByIds(['a'])).toEqual([
      { id: 'a', flag: null, note: 'kept', n: null, extra: null },
    ]);
  });

  it.each([
    ['an object', { token: 'secret-value-1' }],
    ['an array', ['secret-value-1']],
    ['a Date', new Date('2031-02-03T04:05:06.000Z')],
  ])(
    'rejects %s as a record value, naming its column without echoing it, and writes nothing of the batch',
    async (kind, value) => {
      const error = await store
        .applyBatch(
          [
            { id: 'first', note: 'fine' },
            { id: 'second', note: untyped(value) },
          ],
          [],
        )
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      expect(error).toMatchObject(validation('records[1].note', kind));
      const surface = JSON.stringify({
        message: (error as McpError).message,
        data: (error as McpError).data,
      });
      expect(surface).not.toContain('secret-value-1');
      expect(surface).not.toContain('2031');
      expect(await store.count()).toBe(0);
    },
  );

  it('rejects an object as a getByIds id, a filter value, an in-list element, and a match, naming each', async () => {
    await expect(store.getByIds(['a', untyped({ id: 'a' })])).rejects.toMatchObject(
      validation('ids[1]', 'an object'),
    );
    await expect(
      store.query({
        filters: [{ column: 'flag', op: 'eq', value: untyped({ flag: 1 }) }],
        limit: 1,
        offset: 0,
      }),
    ).rejects.toMatchObject(validation('filters[0].value', 'an object'));
    await expect(
      store.query({
        filters: [
          { column: 'note', op: 'eq', value: 'x' },
          { column: 'flag', op: 'in', value: [1, untyped([2])] },
        ],
        limit: 1,
        offset: 0,
      }),
    ).rejects.toMatchObject(validation('filters[1].value[1]', 'an array'));
    await expect(
      store.query({ match: untyped({ q: 'x' }), limit: 1, offset: 0 }),
    ).rejects.toMatchObject(validation('match', 'an object'));
  });

  it.each<[string, () => unknown]>([
    ['an ArrayBuffer', () => new Uint8Array([1, 2]).buffer],
    [
      'a SharedArrayBuffer',
      () => {
        const shared = new SharedArrayBuffer(2);
        new Uint8Array(shared).set([1, 2]);
        return shared;
      },
    ],
    [
      'a DataView with a byte offset',
      () => new DataView(new Uint8Array([9, 1, 2, 9]).buffer, 1, 2),
    ],
    ['a Uint16Array', () => new Uint16Array(new Uint8Array([1, 2]).buffer)],
    ['a Buffer', () => Buffer.from([1, 2])],
  ])(
    'stores %s as a blob of the bytes it views as a record field, and matches it as a filter value',
    async (_label, bytes) => {
      await store.applyBatch(
        [
          { id: 'a', extra: untyped(bytes()) },
          { id: 'b', extra: 'other' },
        ],
        [],
      );
      expect(await stored('a')).toMatchObject({ extra: '0102', extraType: 'blob' });

      expect(await matching({ column: 'extra', op: 'eq', value: untyped(bytes()) })).toEqual(['a']);
      expect(await matching({ column: 'extra', op: 'in', value: [untyped(bytes())] })).toEqual([
        'a',
      ]);
    },
  );

  it('stores undefined and NaN as NULL and a Uint8Array as a blob', async () => {
    await store.applyBatch(
      [
        {
          id: 'a',
          flag: Number.NaN,
          n: untyped(undefined),
          extra: untyped(new Uint8Array([1, 2])),
        },
      ],
      [],
    );
    expect(await stored('a')).toEqual({
      flag: null,
      flagType: 'null',
      note: null,
      noteType: 'null',
      n: null,
      nType: 'null',
      extra: '0102',
      extraType: 'blob',
    });
  });
});

/**
 * An `in` list binds as one parameter. It must match exactly the rows the same
 * list matches bound one parameter per value, which is how the raw handle binds
 * it here: on every column affinity, for every kind of value the store binds.
 */
describe('sqliteMirrorStore in filter', () => {
  let dir: string;
  let store: MirrorStore;

  /**
   * One column per SQLite affinity: TEXT, INTEGER, REAL, NUMERIC, BLOB, and
   * none, plus the two other spellings of REAL affinity (`FLOA`, `DOUB`).
   */
  const COLUMNS = ['t', 'i', 'r', 'nu', 'b', 'x', 'fl', 'db'] as const;
  type Column = (typeof COLUMNS)[number];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mirror-store-in-test-'));
    store = sqliteMirrorStore({
      path: join(dir, 'in.db'),
      table: 'items',
      primaryKey: 'id',
      columns: {
        id: 'TEXT',
        t: 'TEXT',
        i: 'INTEGER',
        r: 'REAL',
        nu: 'NUMERIC',
        b: 'BLOB',
        x: '',
        fl: 'FLOAT',
        db: 'DOUBLE PRECISION',
      },
      indexes: [{ columns: ['t'] }, { columns: ['r'] }],
    });
  });
  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** Ids of the rows an `in` filter on `column` matches, through the store. */
  async function matched(column: Column | 'id', value: unknown): Promise<unknown[]> {
    const { rows } = await store.query({
      filters: [{ column, op: 'in', value: untyped(value) }],
      sort: { column: 'id', direction: 'asc' },
      limit: 1_000,
      offset: 0,
    });
    return rows.map((r) => r.id);
  }

  /** Ids of the rows `column IN (?, …)` matches with each value its own parameter. */
  async function matchedPositionally(column: Column, values: unknown[]): Promise<unknown[]> {
    const handle = await store.raw();
    return handle
      .prepare<{ id: string }>(
        `SELECT id FROM items WHERE ${column} IN (${values.map(() => '?').join(', ')}) ORDER BY id`,
      )
      .all(...values.map(untyped))
      .map((r) => r.id);
  }

  /** Each value stored in every column of its own row. */
  const STORED: unknown[] = [
    '5',
    '05',
    '5.0',
    'abc',
    '2024',
    '1',
    '0',
    '0.0',
    'true',
    '9007199254740993',
    'x\ud800y',
    'a"b\\c\u0000d',
    5,
    5.5,
    2024,
    1,
    0,
    -0,
    0.1,
    2 ** 53,
    2 ** 53 + 2,
    1e21,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    null,
    9007199254740993n,
    2n ** 63n - 1n,
    Uint8Array.of(0x35),
  ];

  async function seedEveryColumn(): Promise<void> {
    await store.applyBatch(
      STORED.map((value, k) => {
        const row: Record<string, unknown> = { id: `row${String(k).padStart(2, '0')}` };
        for (const column of COLUMNS) row[column] = value;
        return row as MirrorRow;
      }),
      [],
    );
  }

  it.each<[string, unknown[], boolean]>([
    ['a numeric string', ['5'], true],
    ['a zero-padded numeric string', ['05'], true],
    ['a numeric string past 2^53', ['9007199254740993'], true],
    ['a string with a lone surrogate', ['x\ud800y'], true],
    ['a string with a quote, a backslash, and a NUL', ['a"b\\c\u0000d'], true],
    ['plain text', ['abc'], true],
    ['null', [null], false],
    ['undefined', [undefined], false],
    ['NaN', [Number.NaN], false],
    ['true', [true], true],
    ['false', [false], true],
    ['a safe integer', [2024], true],
    ['zero', [0], true],
    ['negative zero', [-0], true],
    ['a fraction', [5.5], true],
    ['a fraction with no exact decimal form', [0.1], true],
    ['a whole number past 2^53', [2 ** 53], true],
    ['a number past the signed 64-bit range', [1e21], true],
    ['Infinity', [Number.POSITIVE_INFINITY], true],
    ['-Infinity', [Number.NEGATIVE_INFINITY], true],
    ['a small bigint', [5n], true],
    ['a bigint past 2^53', [9007199254740993n], true],
    ['the largest signed 64-bit bigint', [2n ** 63n - 1n], true],
    ['bytes', [Uint8Array.of(0x35)], true],
    ['a repeated value', [5, 5], true],
    ['an empty list', [], false],
    [
      'a mixed list',
      [5, -0, 2 ** 53, Number.POSITIVE_INFINITY, true, 'a"b\\c\u0000d', null, 5n, 5.5, '1'],
      true,
    ],
    ['a mixed list holding bytes', ['abc', Uint8Array.of(0x35), 5], true],
  ])(
    'matches the rows %s matches bound one parameter per value, in every column affinity',
    async (_label, list, matchesSome) => {
      await seedEveryColumn();
      const positional: Array<{ column: Column; ids: unknown[] }> = [];
      const oneParameter: Array<{ column: Column; ids: unknown[] }> = [];
      for (const column of COLUMNS) {
        positional.push({ column, ids: await matchedPositionally(column, list) });
        oneParameter.push({ column, ids: await matched(column, list) });
      }
      expect(positional.some(({ ids }) => ids.length > 0)).toBe(matchesSome);
      expect(oneParameter).toEqual(positional);
    },
  );

  it('matches the rows each value names, once each', async () => {
    await store.applyBatch(
      [
        { id: 'year', t: '2024', i: 2024 },
        { id: 'five', t: '5', i: 5 },
        { id: 'one', t: '1', i: 1 },
        { id: 'bytes', b: untyped(Uint8Array.of(1, 2)) },
        { id: 'empty', t: null, i: null, b: null },
      ],
      [],
    );
    expect(await matched('t', [2024])).toEqual(['year']);
    expect(await matched('i', ['05'])).toEqual(['five']);
    expect(await matched('i', [true])).toEqual(['one']);
    expect(await matched('t', [null])).toEqual([]);
    expect(await matched('i', [])).toEqual([]);
    await expect(
      store.query({ filters: [{ column: 'i', op: 'in', value: [5, 5] }], limit: 10, offset: 0 }),
    ).resolves.toEqual({
      rows: [{ id: 'five', t: '5', i: 5, r: null, nu: null, b: null, x: null, fl: null, db: null }],
      total: 1,
    });
    expect(await matched('b', [Uint8Array.of(1, 2)])).toEqual(['bytes']);
  });

  it("returns the page of an in list of 40,000 values, past the bound-parameter ceiling of the Node driver's SQLite", async () => {
    await store.applyBatch(
      [
        { id: 'first', t: 'k1' },
        { id: 'last', t: 'k39999' },
        { id: 'outside', t: 'k40000' },
      ],
      [],
    );
    const value = Array.from({ length: 40_000 }, (_, k) => `k${k}`);
    const result = await store.query({
      filters: [{ column: 't', op: 'in', value }],
      sort: { column: 'id', direction: 'asc' },
      limit: 1,
      offset: 1,
    });
    expect(result).toEqual({
      rows: [
        {
          id: 'last',
          t: 'k39999',
          i: null,
          r: null,
          nu: null,
          b: null,
          x: null,
          fl: null,
          db: null,
        },
      ],
      total: 2,
    });
  });

  it.each<[Column | 'id', SqlValue[], RegExp]>([
    ['t', ['a', 'b'], /^SEARCH items USING (?:COVERING )?INDEX items_t_idx \(t=\?\)$/],
    ['r', [1.5, 2], /^SEARCH items USING (?:COVERING )?INDEX items_r_idx \(r=\?\)$/],
    [
      'id',
      ['a', 'b'],
      /^SEARCH items USING (?:COVERING )?INDEX sqlite_autoindex_items_1 \(id=\?\)$/,
    ],
  ])(
    "searches the %s column's index for each value of an in list rather than scanning the table",
    async (column, value, search) => {
      const handle = await store.raw();
      const prepare = vi.spyOn(handle, 'prepare');
      let prepared: string[];
      try {
        await store.query({ filters: [{ column, op: 'in', value }], limit: 1_000, offset: 0 });
        prepared = prepare.mock.calls.map(([sql]) => sql);
      } finally {
        prepare.mockRestore();
      }
      const rowStatement = prepared.find((sql) => sql.startsWith('SELECT items.'));
      expect(rowStatement).toBeDefined();
      const plan = handle
        .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${rowStatement}`)
        .all(JSON.stringify(value), 1_000, 0)
        .map((step) => step.detail);
      expect(plan).toContainEqual(expect.stringMatching(search));
      expect(plan.filter((step) => /^SCAN items\b/.test(step))).toEqual([]);
    },
  );

  it.each([
    ['a constraint name', 'REAL CONSTRAINT r_any CHECK (r IS NOT NULL OR 1)'],
    ['a default', "REAL DEFAULT 'TEXT'"],
    ['a check', "REAL CHECK (typeof(r) <> 'noblob')"],
  ])(
    'compares an integer past 2^53 exactly on a REAL column whose declaration names another type in %s',
    async (_label, declaration) => {
      const real = sqliteMirrorStore({
        path: join(dir, 'real.db'),
        table: 'items',
        primaryKey: 'id',
        columns: { id: 'TEXT', r: declaration },
      });
      try {
        // Stored as the double 2^53, which no integer past it equals.
        await real.applyBatch([{ id: 'two53', r: 2 ** 53 }], []);
        const handle = await real.raw();
        for (const value of [9007199254740993n, '9007199254740993']) {
          const positional = handle
            .prepare<{ id: string }>('SELECT id FROM items WHERE r IN (?)')
            .all(untyped(value))
            .map((row) => row.id);
          const { rows } = await real.query({
            filters: [{ column: 'r', op: 'in', value: untyped([value]) }],
            limit: 10,
            offset: 0,
          });
          expect(positional).toEqual([]);
          expect(rows.map((row) => row.id)).toEqual(positional);
        }
      } finally {
        await real.close();
      }
    },
  );
});

/**
 * The store's sync lease, two store instances (separate connections) on one
 * file, with expiry driven by the faked clock.
 */
describe('sqliteMirrorStore sync lease', () => {
  const TTL_MS = 1_000;
  let dir: string;
  let holder: MirrorStore;
  let other: MirrorStore;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    dir = await mkdtemp(join(tmpdir(), 'mirror-store-lease-test-'));
    holder = sqliteMirrorStore(specFor(join(dir, 'mirror.db')));
    other = sqliteMirrorStore(specFor(join(dir, 'mirror.db')));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all([holder.close(), other.close()]);
    await rm(dir, { recursive: true, force: true });
  });

  it('claims a free lease, refuses a second claim while it is live, and frees it on release', async () => {
    const lease = await holder.syncLease!.claim('holder', TTL_MS);
    expect(lease).toEqual({ owner: 'holder', generation: 1, ttlMs: TTL_MS });
    await expect(other.syncLease!.claim('other', TTL_MS)).resolves.toBeUndefined();

    await holder.syncLease!.release(lease!);
    await expect(other.syncLease!.claim('other', TTL_MS)).resolves.toEqual({
      owner: 'other',
      generation: 2,
      ttlMs: TTL_MS,
    });
  });

  it('keeps a lease live until its expiry and lets it be taken over from that instant, with the next generation', async () => {
    const lease = await holder.syncLease!.claim('holder', TTL_MS);
    vi.setSystemTime(Date.now() + TTL_MS - 1);
    await expect(other.syncLease!.claim('other', TTL_MS)).resolves.toBeUndefined();
    vi.setSystemTime(Date.now() + 1);
    const taken = await other.syncLease!.claim('other', TTL_MS);
    expect(taken).toEqual({ owner: 'other', generation: 2, ttlMs: TTL_MS });

    // The holder whose lease was taken over can no longer write, renew, or release.
    await expect(
      holder.syncLease!.commit(
        lease!,
        { status: 'in_progress', cursor: 'stale' },
        [rec('stale')],
        [],
      ),
    ).resolves.toBe(false);
    expect(await holder.getByIds(['stale'])).toEqual([]);
    expect(await holder.readState()).toEqual({ status: 'pending' });
    await expect(holder.syncLease!.renew(lease!)).resolves.toBe(false);
    await holder.syncLease!.release(lease!);
    await expect(other.syncLease!.renew(taken!)).resolves.toBe(true);
    await expect(holder.syncLease!.claim('third', TTL_MS)).resolves.toBeUndefined();
  });

  it('commits records, tombstones, and state together, and pushes the expiry out from the commit', async () => {
    const lease = (await holder.syncLease!.claim('holder', TTL_MS))!;
    const state = { status: 'in_progress' as const, cursor: 'c1', checkpoint: '2024-01-01' };
    await expect(holder.syncLease!.commit(lease, state, [rec('1'), rec('2')], [])).resolves.toBe(
      true,
    );
    await expect(
      holder.syncLease!.commit(lease, { ...state, cursor: 'c2' }, [], ['1']),
    ).resolves.toBe(true);
    expect((await holder.getByIds(['1', '2'])).map((r) => r.id)).toEqual(['2']);
    expect(await holder.readState()).toEqual({ ...state, cursor: 'c2' });

    // A state-only commit renews too: the expiry counts from the last commit.
    vi.setSystemTime(Date.now() + TTL_MS - 1);
    await expect(holder.syncLease!.commit(lease, { status: 'in_progress' })).resolves.toBe(true);
    vi.setSystemTime(Date.now() + TTL_MS - 1);
    await expect(other.syncLease!.claim('other', TTL_MS)).resolves.toBeUndefined();
    await expect(holder.syncLease!.renew(lease)).resolves.toBe(true);
    vi.setSystemTime(Date.now() + TTL_MS - 1);
    await expect(other.syncLease!.claim('other', TTL_MS)).resolves.toBeUndefined();
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

  it('runs every migration in ascending order on a fresh database, then stamps the target', async () => {
    const path = join(dir, 'fresh.db');
    const ran: number[] = [];
    const store = sqliteMirrorStore(
      specFor(path, {
        version: 3,
        // Declared out of order: the runner sorts by version.
        migrations: [
          {
            version: 3,
            up: (h) => {
              ran.push(3);
              h.exec('INSERT INTO mig_log VALUES (3);');
            },
          },
          {
            version: 2,
            up: (h) => {
              ran.push(2);
              h.exec('CREATE TABLE mig_log(x); INSERT INTO mig_log VALUES (1);');
            },
          },
        ],
      }),
    );
    await store.count(); // trigger open
    expect(ran).toEqual([2, 3]);
    expect(await schemaVersion(store)).toBe(3);
    expect(await migLogCount(store)).toBe(2);
    await store.close();

    // Reopening at the same version must not re-run anything.
    const again = sqliteMirrorStore(specFor(path, { version: 3 }));
    await again.count();
    expect(await schemaVersion(again)).toBe(3);
    expect(await migLogCount(again)).toBe(2);
    await again.close();
  });

  it('stamps a fresh database at the spec version when no migrations are declared', async () => {
    const store = sqliteMirrorStore(specFor(join(dir, 'plain.db'), { version: 4 }));
    await store.count();
    expect(await schemaVersion(store)).toBe(4);
    expect(await migLogCount(store)).toBe(-1);
    await store.close();
  });

  it('leaves no version stamp for a migration that throws', async () => {
    const path = join(dir, 'failing.db');
    const failing = sqliteMirrorStore(
      specFor(path, {
        version: 2,
        migrations: [
          {
            version: 2,
            up: () => {
              throw new Error('migration exploded');
            },
          },
        ],
      }),
    );
    await expect(failing.count()).rejects.toThrow(/Failed to initialize mirror store/);
    await failing.close();

    // The failed open stamped nothing, so a working migration for the same
    // version still runs on the next open instead of being skipped as applied.
    const repaired = sqliteMirrorStore(
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
    await repaired.count();
    expect(await schemaVersion(repaired)).toBe(2);
    expect(await migLogCount(repaired)).toBe(1);
    await repaired.close();
  });

  it('applies nothing of a migration whose multi-statement exec fails before its last statement', async () => {
    const path = join(dir, 'partial.db');
    const v1 = sqliteMirrorStore(specFor(path));
    await v1.count();
    await v1.close();

    const failing = sqliteMirrorStore(
      specFor(path, {
        version: 2,
        migrations: [
          {
            version: 2,
            up: (h) =>
              h.exec(
                'CREATE TABLE mig_log (x INTEGER PRIMARY KEY); INSERT INTO mig_log VALUES (1); INSERT INTO mig_log VALUES (1); CREATE TABLE never_created (x);',
              ),
          },
        ],
      }),
    );
    const error = await failing.count().catch((err: unknown) => err);
    await failing.close();

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.DatabaseError,
      cause: { code: expect.stringMatching(/^SQLITE_CONSTRAINT/) },
    });
    const handle = await openSqliteHandle(path);
    try {
      expect(
        handle.prepare<{ v: number }>(`SELECT MAX(version) AS v FROM schema_version`).get()?.v,
      ).toBe(1);
      expect(
        handle
          .prepare<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE name IN ('mig_log', 'never_created')`,
          )
          .all(),
      ).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it('names a store whose migration throws by its basename, with a recovery hint and no path (#635)', async () => {
    const failing = sqliteMirrorStore(
      specFor(join(dir, 'failing.db'), {
        version: 2,
        migrations: [
          {
            version: 2,
            up: () => {
              throw new Error('migration exploded');
            },
          },
        ],
      }),
    );

    const error = await failing.count().catch((err: unknown) => err);
    await failing.close();

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.DatabaseError,
      message: 'Failed to initialize mirror store "failing.db".',
      cause: { message: 'migration exploded' },
    });
    expect((error as McpError).message).not.toContain(dir);
    expect((error as McpError).data).toEqual({
      recovery: { hint: MIRROR_STORE_UNAVAILABLE_HINT },
    });
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

  /** Adds `meta.etag`, a migration that fails if it runs a second time. */
  const addEtag = (h: SqliteHandle): void => {
    h.exec('CREATE TABLE meta (k TEXT)');
    h.exec('ALTER TABLE meta ADD COLUMN etag TEXT');
  };

  it.each([
    [
      'its up() throws after writing, a committed inner transaction included',
      (h: SqliteHandle) => {
        h.transaction(() => addEtag(h));
        throw new Error('migration exploded');
      },
    ],
    [
      'its version stamp is refused after up() returns',
      (h: SqliteHandle) => {
        addEtag(h);
        h.exec(
          "CREATE TRIGGER refuse_stamp BEFORE INSERT ON schema_version BEGIN SELECT RAISE(ABORT, 'stamp refused'); END",
        );
      },
    ],
  ])('applies nothing and keeps the stored version when %s', async (_label, up) => {
    const path = join(dir, 'atomic.db');
    const v1 = sqliteMirrorStore(specFor(path));
    await v1.count();
    await v1.close();

    const failing = sqliteMirrorStore(
      specFor(path, { version: 2, migrations: [{ version: 2, up }] }),
    );
    await expect(failing.count()).rejects.toMatchObject({ code: JsonRpcErrorCode.DatabaseError });
    await failing.close();

    const handle = await openSqliteHandle(path);
    try {
      expect(
        handle.prepare<{ v: number }>(`SELECT MAX(version) AS v FROM schema_version`).get()?.v,
      ).toBe(1);
      expect(
        handle
          .prepare<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE name IN ('meta', 'refuse_stamp')`,
          )
          .all(),
      ).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it('nests a handle.transaction() inside up() as a savepoint of the migration transaction', async () => {
    const store = sqliteMirrorStore(
      specFor(join(dir, 'nested.db'), {
        version: 2,
        migrations: [
          {
            version: 2,
            up: (h) => {
              h.exec('CREATE TABLE mig_log (x TEXT)');
              const insert = h.prepare('INSERT INTO mig_log (x) VALUES (?)');
              h.transaction(() => insert.run('kept'));
              expect(() =>
                h.transaction(() => {
                  insert.run('undone');
                  throw new Error('inner rollback');
                }),
              ).toThrow('inner rollback');
            },
          },
        ],
      }),
    );
    await store.count();
    const handle = await store.raw();
    expect(handle.prepare<{ x: string }>('SELECT x FROM mig_log').all()).toEqual([{ x: 'kept' }]);
    expect(await schemaVersion(store)).toBe(2);
    await store.close();
  });

  it("holds the store's write lock from a migration's version re-read through its up(), so no other opener can write in between", async () => {
    const path = join(dir, 'locked.db');
    const v1 = sqliteMirrorStore(specFor(path));
    await v1.count();
    await v1.close();

    // Another connection that fails at once rather than waiting on a lock.
    const other = await openSqliteHandle(path, { busyTimeoutMs: 0 });
    const writeLock: string[] = [];
    try {
      const store = sqliteMirrorStore(
        specFor(path, {
          version: 2,
          migrations: [
            {
              version: 2,
              up: () => {
                try {
                  other.exec('BEGIN IMMEDIATE');
                  other.exec('ROLLBACK');
                  writeLock.push('free');
                } catch (err) {
                  writeLock.push(String((err as { code?: unknown }).code));
                }
              },
            },
          ],
        }),
      );
      await store.count();
      expect(await schemaVersion(store)).toBe(2);
      await store.close();
    } finally {
      other.close();
    }
    expect(writeLock).toEqual(['SQLITE_BUSY']);
  });
});

/** The handle's Bun floor, seen from the store: the refusal reaches the caller as thrown. */
describe('sqliteMirrorStore on a Bun below the engines floor', () => {
  const versionsDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'versions',
  ) as PropertyDescriptor;
  const originalIsBun = runtimeCaps.isBun;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mirror-bun-floor-test-'));
    Object.defineProperty(process, 'versions', {
      ...versionsDescriptor,
      value: { ...versionsDescriptor.value, bun: '1.4.3' },
    });
    runtimeCaps.isBun = true;
  });
  afterEach(async () => {
    Object.defineProperty(process, 'versions', versionsDescriptor);
    runtimeCaps.isBun = originalIsBun;
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects the first call with the ConfigurationError, unwrapped, and creates no file', async () => {
    const path = join(dir, 'store', 'records.db');
    const store = sqliteMirrorStore(specFor(path));

    const error = await store.count().catch((err: unknown) => err);
    await store.close();

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: expect.stringContaining(
        'needs Bun 1.4.4 or later, but this server is running Bun 1.4.3.',
      ),
      data: { reason: 'unsupported_bun_version' },
    });
    expect(existsSync(join(dir, 'store'))).toBe(false);
  });
});

/**
 * Two real processes on one store file, on this runtime's driver. The late
 * opener pauses after reading the stored version until the early opener's
 * open has finished, the window in which both read a version a migration
 * has not yet raised.
 */
describe('sqliteMirrorStore migrations across processes', () => {
  const PROCESS_TIMEOUT_MS = 60_000;
  let dir: string;
  let barriers: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mirror-migrate-process-test-'));
    barriers = join(dir, 'barriers');
    await mkdir(barriers);
    path = join(dir, 'shared.db');
    // The store at version 1, declared as the child declares it.
    const v1 = sqliteMirrorStore({
      path,
      table: 'items',
      primaryKey: 'id',
      columns: { id: 'TEXT' },
    });
    await v1.count();
    await v1.close();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function inspect() {
    const handle = await openSqliteHandle(path);
    try {
      const has = (name: string) =>
        (handle
          .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?`)
          .get(name)?.n ?? 0) > 0;
      return {
        version: handle.prepare<{ v: number }>(`SELECT MAX(version) AS v FROM schema_version`).get()
          ?.v,
        migLog: has('mig_log')
          ? handle
              .prepare<{ version: number }>(`SELECT version FROM mig_log ORDER BY rowid`)
              .all()
              .map((r) => r.version)
          : null,
        etagColumns: has('meta')
          ? handle
              .prepare<{ name: string }>(`PRAGMA table_info(meta)`)
              .all()
              .filter((c) => c.name === 'etag').length
          : 0,
      };
    } finally {
      handle.close();
    }
  }

  it.each([
    ['log', { version: 2, migLog: [2], etagColumns: 0 }],
    ['add-column', { version: 2, migLog: null, etagColumns: 1 }],
  ] as const)(
    'applies a pending %s migration once when two processes open the store together',
    async (kind, after) => {
      const migrations = [{ kind, version: 2 }];
      const [late, early] = await Promise.all([
        runMirrorProcess({
          role: 'open',
          barriers,
          path,
          version: 2,
          migrations,
          pauseAfterVersionRead: { signal: 'late-read', waitFor: 'early-open' },
        }),
        runMirrorProcess({
          role: 'open',
          barriers,
          path,
          version: 2,
          migrations,
          startAfter: 'late-read',
          signalWhenOpen: 'early-open',
        }),
      ]);

      expect(early).toEqual({ ok: true, upCalls: 1 });
      expect(late).toEqual({ ok: true, upCalls: 0 });
      expect(await inspect()).toEqual(after);
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    'never lowers the version a newer opener stamped',
    async () => {
      const [older, newer] = await Promise.all([
        runMirrorProcess({
          role: 'open',
          barriers,
          path,
          version: 2,
          migrations: [{ kind: 'log', version: 2 }],
          pauseAfterVersionRead: { signal: 'older-read', waitFor: 'newer-open' },
        }),
        runMirrorProcess({
          role: 'open',
          barriers,
          path,
          version: 3,
          migrations: [
            { kind: 'log', version: 2 },
            { kind: 'log', version: 3 },
          ],
          startAfter: 'older-read',
          signalWhenOpen: 'newer-open',
        }),
      ]);

      expect(newer).toEqual({ ok: true, upCalls: 2 });
      expect(older).toEqual({ ok: true, upCalls: 0 });
      expect(await inspect()).toEqual({ version: 3, migLog: [2, 3], etagColumns: 0 });
    },
    PROCESS_TIMEOUT_MS,
  );
});

describe('sqliteMirrorStore sync state mode', () => {
  let dir: string;
  let store: MirrorStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mirror-state-mode-test-'));
    store = sqliteMirrorStore(specFor(join(dir, 'mirror.db')));
  });
  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips the mode through writeState, and a write without one clears it', async () => {
    const written = {
      status: 'in_progress' as const,
      mode: 'refresh' as const,
      cursor: 'tok-1',
      checkpoint: '2024-05-02',
    };
    await store.writeState(written);
    expect(await store.readState()).toEqual(written);

    await store.writeState({ status: 'error', cursor: 'tok-2', error: 'upstream failed' });
    expect(await store.readState()).toEqual({
      status: 'error',
      cursor: 'tok-2',
      error: 'upstream failed',
    });
  });

  it('round-trips the mode through a sync lease commit', async () => {
    const lease = (await store.syncLease!.claim('holder', 1_000))!;
    const committed = { status: 'in_progress' as const, mode: 'init' as const, cursor: 'c1' };
    await expect(store.syncLease!.commit(lease, committed, [rec('1')], [])).resolves.toBe(true);
    expect(await store.readState()).toEqual(committed);
    await store.syncLease!.release(lease);
  });
});

/** `mirror_sync_state` as stores created before sync state recorded its run's mode declared it. */
const SYNC_STATE_WITHOUT_MODE_DDL = `CREATE TABLE mirror_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL,
  cursor TEXT,
  checkpoint TEXT,
  started_at TEXT,
  completed_at TEXT,
  total INTEGER,
  error TEXT
);`;

/** The row a refresh that failed on top of a complete mirror left in such a store. */
const FAILED_REFRESH_STATE = {
  status: 'error',
  cursor: 'REFRESH-TOKEN',
  checkpoint: '2026-01-02',
  startedAt: '2026-01-02T00:00:00.000Z',
  completedAt: '2026-01-01T00:00:00.000Z',
  total: 1,
  error: 'upstream failed',
} as const;

/**
 * Writes the store `spec` declares as one created before sync state recorded
 * its run's mode: the state table as those stores declared it, holding
 * {@link FAILED_REFRESH_STATE}, every other table from the generated DDL (which
 * leaves an existing state table alone), and version 1 stamped.
 */
async function writeStoreWithoutMode(spec: SqliteMirrorStoreSpec): Promise<void> {
  const handle = await openSqliteHandle(spec.path);
  try {
    handle.exec(SYNC_STATE_WITHOUT_MODE_DDL);
    handle.exec(buildSchemaSql(spec));
    handle
      .prepare(`INSERT INTO schema_version (version, applied_at) VALUES (1, ?)`)
      .run('2026-01-01T00:00:00.000Z');
    const s = FAILED_REFRESH_STATE;
    handle
      .prepare(
        `UPDATE mirror_sync_state
         SET status = ?, cursor = ?, checkpoint = ?, started_at = ?, completed_at = ?, total = ?, error = ?
         WHERE id = 1`,
      )
      .run(s.status, s.cursor, s.checkpoint, s.startedAt, s.completedAt, s.total, s.error);
  } finally {
    handle.close();
  }
}

const syncStateColumns = (handle: SqliteHandle): string[] =>
  handle
    .prepare<{ name: string }>(`PRAGMA table_info(mirror_sync_state)`)
    .all()
    .map((c) => c.name);

describe('sqliteMirrorStore schema upgrade', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mirror-upgrade-test-'));
    path = join(dir, 'older.db');
    await writeStoreWithoutMode(specFor(path));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('gives a store created without the mode column that column on open, once, keeping its state', async () => {
    const fresh = sqliteMirrorStore(specFor(join(dir, 'fresh.db')));
    const upgraded = sqliteMirrorStore(specFor(path));
    try {
      expect(await upgraded.readState()).toEqual(FAILED_REFRESH_STATE);
      const columns = syncStateColumns(await upgraded.raw());
      expect(columns.filter((name) => name === 'mode')).toEqual(['mode']);
      expect(columns).toEqual(syncStateColumns(await fresh.raw()));
      await upgraded.writeState({ status: 'in_progress', mode: 'refresh', cursor: 'c1' });
    } finally {
      await Promise.all([fresh.close(), upgraded.close()]);
    }

    // Opening it again finds the column and adds none.
    const reopened = sqliteMirrorStore(specFor(path));
    try {
      expect(await reopened.readState()).toEqual({
        status: 'in_progress',
        mode: 'refresh',
        cursor: 'c1',
        completedAt: FAILED_REFRESH_STATE.completedAt,
        total: FAILED_REFRESH_STATE.total,
      });
      expect(syncStateColumns(await reopened.raw()).filter((name) => name === 'mode')).toEqual([
        'mode',
      ]);
    } finally {
      await reopened.close();
    }
  });

  it.each([
    ['init', { mode: 'init', cursor: 'REFRESH-TOKEN', checkpoint: '2026-01-02' }],
    ['refresh', { mode: 'refresh', checkpoint: '2026-01-02' }],
  ] as const)(
    'hands a %s run what it received before the column existed: the error row reads as an init’s',
    async (mode, expected) => {
      const received: Array<Pick<SyncContext, 'checkpoint' | 'cursor' | 'mode'>> = [];
      const mirror = defineMirror({
        name: 'older',
        store: sqliteMirrorStore(specFor(path)),
        async *sync(ctx): AsyncGenerator<SyncPage> {
          received.push({ mode: ctx.mode, cursor: ctx.cursor, checkpoint: ctx.checkpoint });
          yield { records: [] };
        },
      });
      try {
        await mirror.runSync({ mode });
        expect(received).toEqual([expected]);
      } finally {
        await mirror.close();
      }
    },
  );
});

/**
 * Real processes opening one store created without the mode column, on this
 * runtime's driver.
 */
describe('sqliteMirrorStore schema upgrade across processes', () => {
  const PROCESS_TIMEOUT_MS = 60_000;
  const PROCESSES = 6;
  let dir: string;
  let barriers: string;
  let path: string;

  async function expectOneModeColumn(): Promise<void> {
    const handle = await openSqliteHandle(path);
    try {
      expect(syncStateColumns(handle).filter((name) => name === 'mode')).toEqual(['mode']);
      expect(handle.prepare('SELECT status, cursor, mode FROM mirror_sync_state').all()).toEqual([
        { status: 'error', cursor: 'REFRESH-TOKEN', mode: null },
      ]);
    } finally {
      handle.close();
    }
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mirror-upgrade-process-test-'));
    barriers = join(dir, 'barriers');
    await mkdir(barriers);
    path = join(dir, 'shared.db');
    // The store as the child declares it.
    await writeStoreWithoutMode({
      path,
      table: 'items',
      primaryKey: 'id',
      columns: { id: 'TEXT' },
    });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it(
    'opens in every process that opens it at once, and ends with one mode column',
    async () => {
      const reports = await Promise.all(
        Array.from({ length: PROCESSES }, () =>
          runMirrorProcess({
            role: 'open',
            barriers,
            path,
            version: 1,
            migrations: [],
            startWith: { barrier: 'start', processes: PROCESSES },
          }),
        ),
      );

      expect(reports).toEqual(Array.from({ length: PROCESSES }, () => ({ ok: true, upCalls: 0 })));
      await expectOneModeColumn();
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    'opens in a process that found no mode column just before another process added it',
    async () => {
      const [late, early] = await Promise.all([
        runMirrorProcess({
          role: 'open',
          barriers,
          path,
          version: 1,
          migrations: [],
          pauseAfterModeCheck: { signal: 'late-checked', waitFor: 'early-open' },
        }),
        runMirrorProcess({
          role: 'open',
          barriers,
          path,
          version: 1,
          migrations: [],
          startAfter: 'late-checked',
          signalWhenOpen: 'early-open',
        }),
      ]);

      expect(early).toEqual({ ok: true, upCalls: 0 });
      expect(late).toEqual({ ok: true, upCalls: 0 });
      await expectOneModeColumn();
    },
    PROCESS_TIMEOUT_MS,
  );
});

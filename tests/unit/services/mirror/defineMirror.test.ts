/**
 * @fileoverview Tests for `defineMirror` — the composition layer that assembles
 * a `MirrorStore`, a server's `sync` generator, and the runner into the `Mirror`
 * object a server holds. Most cases use a minimal in-memory fake `MirrorStore`
 * (spec-conformant with the documented `writeState`/`readState` durable-field
 * semantics — see `writeSyncState` in `sqliteMirrorStore.ts`) so defineMirror's
 * own delegation, `status()`/`ready()` derivation, and `runSync()` option wiring
 * are exercised in isolation from the real SQLite store (covered by
 * `sqliteMirrorStore.test.ts`) and the full init/refresh state machine (covered
 * by `runner.test.ts`). A couple of tests use a real `sqliteMirrorStore` where
 * the fake can't stand in: store-construction error propagation and one
 * end-to-end sanity check.
 * @module tests/unit/services/mirror/defineMirror
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineMirror } from '@/services/mirror/core/defineMirror.js';
import { sqliteMirrorStore } from '@/services/mirror/sqlite/sqliteMirrorStore.js';
import type {
  MirrorLogger,
  MirrorRow,
  MirrorStore,
  QueryOptions,
  QueryResult,
  SqliteHandle,
  SyncContext,
  SyncGenerator,
  SyncPage,
  SyncState,
} from '@/services/mirror/types.js';

/** A sync generator that yields nothing — a stand-in when a test doesn't care about sync itself. */
const emptySync: SyncGenerator = async function* (): AsyncGenerator<SyncPage> {};

/**
 * Minimal in-memory `MirrorStore` double. `writeState` mirrors the documented
 * durable-field semantics of the real `sqliteMirrorStore` (`completedAt`/`total`
 * preserved when a write omits them; every other field overwritten — see
 * `writeSyncState` in sqliteMirrorStore.ts) so defineMirror's `status()`/`ready()`
 * logic is exercised against realistic state transitions without real SQLite I/O.
 */
function makeFakeStore(initial: SyncState = { status: 'pending' }) {
  let state = initial;
  // Memoized like the real store's opened handle — raw() must return the same
  // reference across calls, not a fresh object each time.
  const rawHandle = {} as SqliteHandle;
  const store: MirrorStore & {
    applyBatchCalls: Array<{ records: MirrorRow[]; tombstones: string[] }>;
    queryCalls: QueryOptions[];
    getByIdsCalls: string[][];
    closeCalls: number;
  } = {
    applyBatchCalls: [] as Array<{ records: MirrorRow[]; tombstones: string[] }>,
    queryCalls: [] as QueryOptions[],
    getByIdsCalls: [] as string[][],
    closeCalls: 0,
    async applyBatch(records: MirrorRow[], tombstones: string[]) {
      store.applyBatchCalls.push({ records, tombstones });
    },
    async close() {
      store.closeCalls += 1;
    },
    async count() {
      return store.applyBatchCalls.reduce((n, c) => n + c.records.length, 0);
    },
    async getByIds(ids: string[]) {
      store.getByIdsCalls.push(ids);
      return [] as MirrorRow[];
    },
    async integrityCheck() {
      return { ok: true, results: [] as string[] };
    },
    async query(options: QueryOptions): Promise<QueryResult> {
      store.queryCalls.push(options);
      return { rows: [], total: 0 };
    },
    async raw() {
      return rawHandle;
    },
    async readState(): Promise<SyncState> {
      return state;
    },
    async writeState(next: SyncState) {
      state = {
        status: next.status,
        cursor: next.cursor,
        checkpoint: next.checkpoint,
        startedAt: next.startedAt,
        completedAt: next.completedAt ?? state.completedAt,
        total: next.total ?? state.total,
        error: next.error,
      };
    },
    async [Symbol.asyncDispose]() {
      await store.close();
    },
  };
  return store;
}

describe('defineMirror — delegation to the store', () => {
  it('exposes the definition name and the store instance as-is', () => {
    const store = makeFakeStore();
    const mirror = defineMirror({ name: 'my-mirror', store, sync: emptySync });
    expect(mirror.name).toBe('my-mirror');
    expect(mirror.store).toBe(store);
  });

  it('query() delegates to store.query with the same options object', async () => {
    const store = makeFakeStore();
    const mirror = defineMirror({ name: 'm', store, sync: emptySync });
    const options: QueryOptions = { match: 'x', limit: 5, offset: 0 };
    await mirror.query(options);
    expect(store.queryCalls).toEqual([options]);
  });

  it('getByIds() delegates to store.getByIds', async () => {
    const store = makeFakeStore();
    const mirror = defineMirror({ name: 'm', store, sync: emptySync });
    await mirror.getByIds(['a', 'b']);
    expect(store.getByIdsCalls).toEqual([['a', 'b']]);
  });

  it('raw() delegates to store.raw()', async () => {
    const store = makeFakeStore();
    const mirror = defineMirror({ name: 'm', store, sync: emptySync });
    await expect(mirror.raw()).resolves.toBe(await store.raw());
  });

  it('close() delegates to store.close()', async () => {
    const store = makeFakeStore();
    const mirror = defineMirror({ name: 'm', store, sync: emptySync });
    await mirror.close();
    expect(store.closeCalls).toBe(1);
  });
});

describe('defineMirror — status() and ready() derive from store.readState()', () => {
  it('reports pending/not-ready with no optional fields for a pristine (never-synced) store', async () => {
    const mirror = defineMirror({
      name: 'm',
      store: makeFakeStore({ status: 'pending' }),
      sync: emptySync,
    });
    expect(await mirror.status()).toEqual({ status: 'pending', ready: false });
    expect(await mirror.ready()).toBe(false);
  });

  it('reports ready=true once completedAt is set, independent of the live status value', async () => {
    const mirror = defineMirror({
      name: 'm',
      store: makeFakeStore({
        status: 'in_progress',
        completedAt: '2024-01-01T00:00:00.000Z',
        total: 3,
      }),
      sync: emptySync,
    });
    const status = await mirror.status();
    expect(status.ready).toBe(true);
    expect(status.status).toBe('in_progress');
    expect(status.total).toBe(3);
    expect(await mirror.ready()).toBe(true);
  });

  it('surfaces every optional field (error, checkpoint, startedAt) together and stays ready', async () => {
    const mirror = defineMirror({
      name: 'm',
      store: makeFakeStore({
        status: 'error',
        error: 'simulated upstream failure',
        completedAt: '2024-01-01T00:00:00.000Z',
        total: 8,
        startedAt: '2024-01-02T00:00:00.000Z',
        checkpoint: '2024-01-01',
      }),
      sync: emptySync,
    });
    expect(await mirror.status()).toEqual({
      status: 'error',
      ready: true,
      error: 'simulated upstream failure',
      completedAt: '2024-01-01T00:00:00.000Z',
      total: 8,
      startedAt: '2024-01-02T00:00:00.000Z',
      checkpoint: '2024-01-01',
    });
  });

  it('ready() is false when completedAt has never been set, even mid-progress', async () => {
    const mirror = defineMirror({
      name: 'm',
      store: makeFakeStore({ status: 'in_progress', cursor: 'tok-1' }),
      sync: emptySync,
    });
    expect(await mirror.ready()).toBe(false);
  });
});

describe('defineMirror — runSync() option wiring', () => {
  it('provides a fresh, non-aborted signal to the sync generator when none is given', async () => {
    let seenSignal: AbortSignal | undefined;
    const sync: SyncGenerator = async function* (ctx: SyncContext): AsyncGenerator<SyncPage> {
      seenSignal = ctx.signal;
      yield { records: [] };
    };
    const mirror = defineMirror({ name: 'm', store: makeFakeStore(), sync });
    await mirror.runSync({ mode: 'init' });
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(false);
  });

  it('threads a caller-provided signal through to the sync generator unchanged', async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const sync: SyncGenerator = async function* (ctx: SyncContext): AsyncGenerator<SyncPage> {
      seenSignal = ctx.signal;
      yield { records: [] };
    };
    const mirror = defineMirror({ name: 'm', store: makeFakeStore(), sync });
    await mirror.runSync({ mode: 'init', signal: controller.signal });
    expect(seenSignal).toBe(controller.signal);
  });

  it('does not throw when onProgress is omitted', async () => {
    const sync: SyncGenerator = async function* (): AsyncGenerator<SyncPage> {
      yield { records: [{ id: '1' }] };
    };
    const mirror = defineMirror({ name: 'm', store: makeFakeStore(), sync });
    await expect(mirror.runSync({ mode: 'init' })).resolves.toMatchObject({ recordsApplied: 1 });
  });

  it('invokes a provided onProgress callback once per yielded page, with running totals', async () => {
    const sync: SyncGenerator = async function* (): AsyncGenerator<SyncPage> {
      yield { records: [{ id: '1' }] };
      yield { records: [{ id: '2' }, { id: '3' }] };
    };
    const mirror = defineMirror({ name: 'm', store: makeFakeStore(), sync });
    const calls: Array<{ pages: number; records: number }> = [];
    await mirror.runSync({
      mode: 'init',
      onProgress: (info) => {
        calls.push({ pages: info.pages, records: info.records });
      },
    });
    expect(calls).toEqual([
      { pages: 1, records: 1 },
      { pages: 2, records: 3 },
    ]);
  });

  it('rejects overlapping scheduled sync invocations and permits the next run after completion', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let generatorRuns = 0;
    const sync: SyncGenerator = async function* (): AsyncGenerator<SyncPage> {
      generatorRuns += 1;
      entered.resolve();
      await release.promise;
      yield { records: [] };
    };
    const mirror = defineMirror({ name: 'scheduled-mirror', store: makeFakeStore(), sync });

    const firstRun = mirror.runSync({ mode: 'refresh' });
    await entered.promise;
    await expect(mirror.runSync({ mode: 'refresh' })).rejects.toThrow(/already in progress/);
    expect(generatorRuns).toBe(1);

    release.resolve();
    await expect(firstRun).resolves.toMatchObject({ pagesFetched: 1 });
    await expect(mirror.runSync({ mode: 'refresh' })).resolves.toMatchObject({ pagesFetched: 1 });
    expect(generatorRuns).toBe(2);
  });

  it('releases the single-flight guard after a failed sync', async () => {
    let attempts = 0;
    const sync: SyncGenerator = async function* (): AsyncGenerator<SyncPage> {
      attempts += 1;
      if (attempts === 1) throw new Error('scheduled refresh failed');
      yield { records: [] };
    };
    const mirror = defineMirror({ name: 'retryable-mirror', store: makeFakeStore(), sync });

    await expect(mirror.runSync({ mode: 'refresh' })).rejects.toThrow('scheduled refresh failed');
    await expect(mirror.runSync({ mode: 'refresh' })).resolves.toMatchObject({ pagesFetched: 1 });
    expect(attempts).toBe(2);
  });
});

describe('defineMirror — edge-shaped sync definitions', () => {
  it('completes successfully with zero pages when the sync generator yields nothing at all', async () => {
    const mirror = defineMirror({ name: 'm', store: makeFakeStore(), sync: emptySync });
    const result = await mirror.runSync({ mode: 'init' });
    expect(result).toEqual({ pagesFetched: 0, recordsApplied: 0, tombstonesApplied: 0, total: 0 });
    expect((await mirror.status()).ready).toBe(true);
  });

  it('handles a page with no records, tombstones, cursor, or checkpoint (a true no-op page)', async () => {
    const sync: SyncGenerator = async function* (): AsyncGenerator<SyncPage> {
      yield { records: [] };
    };
    const mirror = defineMirror({ name: 'm', store: makeFakeStore(), sync });
    const result = await mirror.runSync({ mode: 'init' });
    expect(result).toEqual({ pagesFetched: 1, recordsApplied: 0, tombstonesApplied: 0, total: 0 });
  });

  it('does not validate definition.name — an empty string is accepted as-is', () => {
    const mirror = defineMirror({ name: '', store: makeFakeStore(), sync: emptySync });
    expect(mirror.name).toBe('');
  });
});

describe('defineMirror — logger wiring', () => {
  it('routes sync completion logs to a custom logger when one is supplied', async () => {
    const calls: Array<{ level: string; message: string }> = [];
    const logger: MirrorLogger = {
      info: (message) => calls.push({ level: 'info', message }),
      error: (message) => calls.push({ level: 'error', message }),
    };
    const sync: SyncGenerator = async function* (): AsyncGenerator<SyncPage> {
      yield { records: [{ id: '1' }] };
    };
    const mirror = defineMirror({ name: 'm', store: makeFakeStore(), sync, logger });
    await mirror.runSync({ mode: 'init' });
    expect(calls).toEqual([{ level: 'info', message: 'Mirror sync complete' }]);
  });

  it('routes sync failure logs to a custom logger when one is supplied', async () => {
    const calls: Array<{ level: string; message: string }> = [];
    const logger: MirrorLogger = {
      info: (message) => calls.push({ level: 'info', message }),
      error: (message) => calls.push({ level: 'error', message }),
    };
    // biome-ignore lint/correctness/useYield: deliberately throws before ever yielding — that failure-before-any-page case is what this test covers.
    const sync: SyncGenerator = async function* (): AsyncGenerator<SyncPage> {
      throw new Error('boom');
    };
    const mirror = defineMirror({ name: 'm', store: makeFakeStore(), sync, logger });
    await expect(mirror.runSync({ mode: 'init' })).rejects.toThrow('boom');
    expect(calls).toEqual([{ level: 'error', message: 'Mirror sync failed' }]);
  });

  it('completes a successful sync without a custom logger (falls through to the framework default logger)', async () => {
    const sync: SyncGenerator = async function* (): AsyncGenerator<SyncPage> {
      yield { records: [{ id: '1' }] };
    };
    const mirror = defineMirror({ name: 'm', store: makeFakeStore(), sync }); // no `logger` passed
    await expect(mirror.runSync({ mode: 'init' })).resolves.toMatchObject({ recordsApplied: 1 });
  });

  it('completes a failing sync without a custom logger (exercises the default logger error path)', async () => {
    // biome-ignore lint/correctness/useYield: deliberately throws before ever yielding — that failure-before-any-page case is what this test covers.
    const sync: SyncGenerator = async function* (): AsyncGenerator<SyncPage> {
      throw new Error('boom-no-logger');
    };
    const mirror = defineMirror({ name: 'm', store: makeFakeStore(), sync }); // no `logger` passed
    await expect(mirror.runSync({ mode: 'init' })).rejects.toThrow('boom-no-logger');
  });
});

describe('defineMirror — error surfacing', () => {
  it('propagates a store-construction error synchronously (does not swallow or defer it)', () => {
    // validateSchemaSpec runs synchronously at sqliteMirrorStore() construction,
    // before any filesystem access, so no real path is needed here.
    expect(() =>
      defineMirror({
        name: 'bad-mirror',
        store: sqliteMirrorStore({
          path: '/nonexistent/does-not-matter.db',
          table: 'x',
          primaryKey: 'missing',
          columns: { id: 'TEXT' },
        }),
        sync: emptySync,
      }),
    ).toThrow(/primaryKey/);
  });

  it('propagates a synchronous throw from the sync generator through runSync()', async () => {
    // biome-ignore lint/correctness/useYield: deliberately throws before ever yielding — that failure-before-any-page case is what this test covers.
    const sync: SyncGenerator = async function* (): AsyncGenerator<SyncPage> {
      throw new Error('sync generator exploded before yielding anything');
    };
    const mirror = defineMirror({ name: 'm', store: makeFakeStore(), sync });
    await expect(mirror.runSync({ mode: 'init' })).rejects.toThrow(/exploded before yielding/);
  });

  it('leaves the store in an error state with the thrown message recorded after a failed run', async () => {
    const store = makeFakeStore();
    // biome-ignore lint/correctness/useYield: deliberately throws before ever yielding — that failure-before-any-page case is what this test covers.
    const sync: SyncGenerator = async function* (): AsyncGenerator<SyncPage> {
      throw new Error('recorded failure message');
    };
    const mirror = defineMirror({ name: 'm', store, sync });
    await expect(mirror.runSync({ mode: 'init' })).rejects.toThrow();
    const status = await mirror.status();
    expect(status.status).toBe('error');
    expect(status.error).toBe('recorded failure message');
  });
});

describe('defineMirror — end-to-end sanity with a real sqliteMirrorStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'define-mirror-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs a real sync end to end and exposes the raw handle', async () => {
    const mirror = defineMirror({
      name: 'sanity',
      store: sqliteMirrorStore({
        path: join(dir, 'sanity.db'),
        table: 'docs',
        primaryKey: 'id',
        columns: { id: 'TEXT', title: 'TEXT' },
      }),
      async *sync() {
        yield { records: [{ id: '1', title: 'hello' }] };
      },
    });
    const result = await mirror.runSync({ mode: 'init' });
    expect(result.recordsApplied).toBe(1);
    expect((await mirror.status()).ready).toBe(true);

    const handle = await mirror.raw();
    expect(handle.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM docs').get()?.n).toBe(1);
    await mirror.close();
  });
});

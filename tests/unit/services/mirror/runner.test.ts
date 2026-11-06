/**
 * @fileoverview Runner + defineMirror tests — the consumer-shape validation
 * harness. A fake token-paged source proves full init, interrupt-resume from a
 * persisted cursor, incremental refresh from the durable checkpoint, tombstone
 * application, and that a failed refresh keeps a complete mirror "ready".
 * @module tests/unit/services/mirror/runner
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineMirror, type Mirror } from '@/services/mirror/core/defineMirror.js';
import { runSync } from '@/services/mirror/core/runner.js';
import { sqliteMirrorStore } from '@/services/mirror/sqlite/sqliteMirrorStore.js';
import type {
  MirrorLogger,
  MirrorRow,
  MirrorStore,
  SqliteHandle,
  SyncContext,
  SyncGenerator,
  SyncMode,
  SyncPage,
  SyncState,
} from '@/services/mirror/types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { runMirrorProcess } from './mirror-process.js';

const stamp = (i: number): string => `2024-01-${String(i + 1).padStart(2, '0')}`;
const corpusOf = (n: number): MirrorRow[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, title: `paper ${i}`, stamp: stamp(i) }));

function maxStamp(rows: MirrorRow[]): string | undefined {
  const stamps = rows.map((r) => String(r.stamp)).sort();
  return stamps[stamps.length - 1];
}

interface FakeSource {
  /** Cursor the last page carries instead of none, like a feed's end-of-list token. */
  finalCursor?: string;
  pageSize: number;
  received: SyncContext[];
  records: MirrorRow[];
  refreshTombstones?: string[];
  throwAtPage?: number;
}

/**
 * A token-paged source over `src.records` in upstream order (ascending stamp).
 * The cursor is the index of the next record, so a run handed one continues
 * where the interrupted run stopped, whichever its mode; a refresh without one
 * starts at the first record past its checkpoint. The checkpoint is the max stamp.
 */
function makeSync(src: FakeSource): SyncGenerator {
  return async function* sync(ctx: SyncContext): AsyncGenerator<SyncPage> {
    src.received.push(ctx);
    const records = src.records;
    const since = ctx.mode === 'refresh' ? ctx.checkpoint : undefined;
    const pastSince = since ? records.findIndex((r) => String(r.stamp) > since) : 0;
    let offset = ctx.cursor ? Number(ctx.cursor) : pastSince === -1 ? records.length : pastSince;
    let pageIndex = 0;
    let tombstonesEmitted = false;

    while (offset < records.length) {
      if (src.throwAtPage !== undefined && pageIndex === src.throwAtPage) {
        throw new Error('simulated upstream failure');
      }
      const slice = records.slice(offset, offset + src.pageSize);
      offset += slice.length;
      const checkpoint = maxStamp(slice);
      const tombstones =
        !tombstonesEmitted && ctx.mode === 'refresh' ? (src.refreshTombstones ?? []) : [];
      tombstonesEmitted = true;
      yield {
        records: slice,
        ...(tombstones.length > 0 && { tombstones }),
        cursor: offset < records.length ? String(offset) : src.finalCursor,
        ...(checkpoint && { checkpoint }),
      };
      pageIndex += 1;
    }
    if (ctx.mode === 'refresh' && !tombstonesEmitted && (src.refreshTombstones?.length ?? 0) > 0) {
      yield { records: [], tombstones: src.refreshTombstones ?? [] };
    }
  };
}

describe('mirror runner / defineMirror', () => {
  let dir: string;
  let dbPath: string;
  const mirrors = new Set<ReturnType<typeof defineMirror>>();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mirror-runner-test-'));
    dbPath = join(dir, 'mirror.db');
  });
  afterEach(async () => {
    try {
      await Promise.all([...mirrors].map((mirror) => mirror.close()));
    } finally {
      mirrors.clear();
      await rm(dir, { recursive: true, force: true });
    }
  });

  const mirrorFor = (src: FakeSource) => {
    const mirror = defineMirror({
      name: 'test-mirror',
      store: sqliteMirrorStore({
        path: dbPath,
        table: 'docs',
        primaryKey: 'id',
        columns: { id: 'TEXT', title: 'TEXT', stamp: 'TEXT' },
        fts: ['title'],
        indexes: [{ columns: ['stamp'] }],
      }),
      sync: makeSync(src),
    });
    mirrors.add(mirror);
    return mirror;
  };

  it('runs a full init and reports ready with the high-water checkpoint', async () => {
    const src: FakeSource = {
      records: corpusOf(8),
      pageSize: 2,
      finalCursor: 'end-of-list',
      received: [],
    };
    const mirror = mirrorFor(src);
    const result = await mirror.runSync({ mode: 'init' });

    expect(result.recordsApplied).toBe(8);
    expect(await mirror.store.count()).toBe(8);

    const status = await mirror.status();
    expect(status.status).toBe('complete');
    expect(status.ready).toBe(true);
    expect(status.total).toBe(8);
    expect(status.checkpoint).toBe(stamp(7));
    // Volatile cursor is cleared on completion, even though the last page set one.
    expect((await mirror.store.readState()).cursor).toBeUndefined();
    await mirror.close();
  });

  it('resumes an interrupted init from the persisted cursor', async () => {
    // First run throws on page index 2 (after 2 pages of size 2 = offset 4).
    const failing: FakeSource = { records: corpusOf(8), pageSize: 2, throwAtPage: 2, received: [] };
    const m1 = mirrorFor(failing);
    await expect(m1.runSync({ mode: 'init' })).rejects.toThrow(/simulated/);
    const errored = await m1.store.readState();
    expect(errored.status).toBe('error');
    expect(errored.cursor).toBe('4');
    expect(errored.startedAt).toBeDefined();
    expect(await m1.store.count()).toBe(4);
    // Half the corpus is written, but no run has completed: not ready, no total.
    expect(errored.completedAt).toBeUndefined();
    expect(errored.total).toBeUndefined();
    expect((await m1.status()).ready).toBe(false);
    await m1.close();

    // Second run (no throw) must resume from cursor '4', not restart.
    const recovering: FakeSource = { records: corpusOf(8), pageSize: 2, received: [] };
    const m2 = mirrorFor(recovering);
    const result = await m2.runSync({ mode: 'init' });
    expect(recovering.received[0]?.cursor).toBe('4');
    expect(recovering.received[0]?.checkpoint).toBe(stamp(3));
    expect(result.recordsApplied).toBe(4); // only the remaining 4
    expect(await m2.store.count()).toBe(8); // all 8 present after resume
    expect((await m2.status()).ready).toBe(true);
    // The resumed run keeps the original startedAt (how long the run has truly
    // been going), not a fresh "now" timestamp from the recovering call.
    expect((await m2.store.readState()).startedAt).toBe(errored.startedAt);
    await m2.close();
  });

  // A killed process runs no catch block; what it leaves behind is whatever
  // was persisted after the last page it applied.
  it('resumes an init a crash left in_progress from the cursor persisted with its last page', async () => {
    const crashed: FakeSource = { records: corpusOf(8), pageSize: 2, received: [] };
    const m1 = mirrorFor(crashed);
    await m1.store.applyBatch(corpusOf(8).slice(0, 4), []);
    await m1.store.writeState({
      status: 'in_progress',
      startedAt: '2024-02-01T00:00:00.000Z',
      cursor: '4',
      checkpoint: stamp(3),
    });

    const result = await m1.runSync({ mode: 'init' });
    expect(crashed.received[0]).toMatchObject({ mode: 'init', cursor: '4', checkpoint: stamp(3) });
    expect(result.recordsApplied).toBe(4);
    expect(await m1.store.count()).toBe(8);
    expect(await m1.status()).toMatchObject({ status: 'complete', ready: true, total: 8 });
    expect((await m1.store.readState()).startedAt).toBe('2024-02-01T00:00:00.000Z');
    await m1.close();
  });

  it('persists in_progress state with each page before pulling the next one', async () => {
    const pages: SyncPage[] = [
      { records: [{ id: 'a', title: 'A', stamp: stamp(0) }], cursor: 'c1', checkpoint: stamp(0) },
      { records: [{ id: 'b', title: 'B', stamp: stamp(1) }], cursor: 'c2', checkpoint: stamp(1) },
    ];
    const store = sqliteMirrorStore({
      path: dbPath,
      table: 'docs',
      primaryKey: 'id',
      columns: { id: 'TEXT', title: 'TEXT', stamp: 'TEXT' },
    });
    const seen: SyncState[] = [];
    const sync: SyncGenerator = async function* (): AsyncGenerator<SyncPage> {
      seen.push(await store.readState());
      for (const page of pages) {
        yield page;
        // The runner resumes the generator only after persisting the page.
        seen.push(await store.readState());
      }
    };
    try {
      await runSync(
        store,
        sync,
        { log: {}, signal: new AbortController().signal },
        { mode: 'init' },
      );
      expect(
        seen.map(({ status, cursor, checkpoint }) => ({ status, cursor, checkpoint })),
      ).toEqual([
        { status: 'in_progress', cursor: undefined, checkpoint: undefined },
        { status: 'in_progress', cursor: 'c1', checkpoint: stamp(0) },
        { status: 'in_progress', cursor: 'c2', checkpoint: stamp(1) },
      ]);
      expect(new Set(seen.map((state) => state.startedAt)).size).toBe(1);
      expect(seen.every((state) => state.completedAt === undefined)).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('restarts a full init from scratch after a prior init completed, ignoring any stale cursor/checkpoint', async () => {
    const src: FakeSource = { records: corpusOf(4), pageSize: 4, received: [] };
    const mirror = mirrorFor(src);
    await mirror.runSync({ mode: 'init' });
    expect((await mirror.status()).ready).toBe(true);
    await mirror.close();

    // status is already 'complete', so this second init continues no run,
    // whatever checkpoint the first one left — it must restart from scratch,
    // not resume.
    const second: FakeSource = { records: corpusOf(4), pageSize: 4, received: [] };
    const mirror2 = mirrorFor(second);
    await mirror2.runSync({ mode: 'init' });
    expect(second.received[0]?.cursor).toBeUndefined();
    expect(second.received[0]?.checkpoint).toBeUndefined();
    expect(await mirror2.store.count()).toBe(4); // re-applied cleanly, not doubled
    await mirror2.close();
  });

  it('refreshes incrementally from the durable checkpoint', async () => {
    const corpus = corpusOf(6);
    const src: FakeSource = { records: corpus, pageSize: 3, received: [] };
    const mirror = mirrorFor(src);
    await mirror.runSync({ mode: 'init' });
    expect(await mirror.store.count()).toBe(6);

    // Two new upstream records arrive.
    corpus.push({ id: 'p6', title: 'paper 6', stamp: stamp(6) });
    corpus.push({ id: 'p7', title: 'paper 7', stamp: stamp(7) });
    const result = await mirror.runSync({ mode: 'refresh' });

    // The refresh saw only records past the checkpoint.
    const refreshCtx = src.received[src.received.length - 1];
    expect(refreshCtx?.mode).toBe('refresh');
    expect(refreshCtx?.checkpoint).toBe(stamp(5));
    expect(result.recordsApplied).toBe(2);
    expect(await mirror.store.count()).toBe(8);
    expect((await mirror.status()).checkpoint).toBe(stamp(7));
    await mirror.close();
  });

  it('applies tombstones during refresh', async () => {
    const corpus = corpusOf(4);
    const src: FakeSource = {
      records: corpus,
      pageSize: 4,
      refreshTombstones: ['p1'],
      received: [],
    };
    const mirror = mirrorFor(src);
    await mirror.runSync({ mode: 'init' });
    expect(await mirror.store.count()).toBe(4);

    corpus.push({ id: 'p4', title: 'paper 4', stamp: stamp(4) });
    const result = await mirror.runSync({ mode: 'refresh' });
    expect(result.tombstonesApplied).toBe(1);
    expect(await mirror.store.getByIds(['p1'])).toHaveLength(0);
    expect(await mirror.store.count()).toBe(4); // +1 new, -1 tombstoned
    await mirror.close();
  });

  it('keeps a complete mirror ready when a later refresh fails', async () => {
    const corpus = corpusOf(4);
    const ok: FakeSource = { records: corpus, pageSize: 4, received: [] };
    const mirror = mirrorFor(ok);
    await mirror.runSync({ mode: 'init' });
    expect((await mirror.status()).ready).toBe(true);

    // A new upstream record gives the refresh real work to do, so the
    // throw-at-first-page actually fires (an empty refresh would just succeed).
    corpus.push({ id: 'p4', title: 'paper 4', stamp: stamp(4) });
    // A failing refresh shares the same DB path via a fresh mirror instance.
    const failing: FakeSource = { records: corpus, pageSize: 2, throwAtPage: 0, received: [] };
    const mirror2 = mirrorFor(failing);
    await expect(mirror2.runSync({ mode: 'refresh' })).rejects.toThrow(/simulated/);
    const status = await mirror2.status();
    expect(status.status).toBe('error');
    expect(status.ready).toBe(true); // durable completion marker survives
    expect(status.total).toBe(4);
    expect(status.error).toBe('simulated upstream failure');
    await mirror2.close();
  });

  it('reports progress per page', async () => {
    const src: FakeSource = { records: corpusOf(6), pageSize: 2, received: [] };
    const mirror = mirrorFor(src);
    let calls = 0;
    await mirror.runSync({
      mode: 'init',
      onProgress: () => {
        calls += 1;
      },
    });
    expect(calls).toBe(3); // 6 records / pageSize 2
    await mirror.close();
  });

  it('never lets the durable checkpoint regress, and leaves it unchanged when a page omits it', async () => {
    const pages: SyncPage[] = [
      { records: [{ id: 'a', title: 'A', stamp: stamp(0) }], checkpoint: '2024-06-01' },
      // Out-of-order vs. the checkpoint already recorded — must not regress.
      { records: [{ id: 'b', title: 'B', stamp: stamp(1) }], checkpoint: '2024-01-01' },
      // No checkpoint at all — must leave the prior value untouched, not clear it.
      { records: [{ id: 'c', title: 'C', stamp: stamp(2) }] },
    ];
    const sync: SyncGenerator = async function* (): AsyncGenerator<SyncPage> {
      for (const page of pages) yield page;
    };
    const mirror = defineMirror({
      name: 'checkpoint-order',
      store: sqliteMirrorStore({
        path: dbPath,
        table: 'docs',
        primaryKey: 'id',
        columns: { id: 'TEXT', title: 'TEXT', stamp: 'TEXT' },
      }),
      sync,
    });
    await mirror.runSync({ mode: 'init' });
    expect((await mirror.status()).checkpoint).toBe('2024-06-01');
    await mirror.close();
  });

  it('records a String()-coerced message when the sync generator throws a non-Error value', async () => {
    // biome-ignore lint/correctness/useYield: deliberately throws before ever yielding — that failure-before-any-page case is what this test covers.
    const sync: SyncGenerator = async function* (): AsyncGenerator<SyncPage> {
      throw 'a plain string failure, not an Error instance';
    };
    const mirror = defineMirror({
      name: 'non-error-throw',
      store: sqliteMirrorStore({
        path: dbPath,
        table: 'docs',
        primaryKey: 'id',
        columns: { id: 'TEXT', title: 'TEXT', stamp: 'TEXT' },
      }),
      sync,
    });
    await expect(mirror.runSync({ mode: 'init' })).rejects.toBe(
      'a plain string failure, not an Error instance',
    );
    const state = await mirror.store.readState();
    expect(state.status).toBe('error');
    expect(state.error).toBe('a plain string failure, not an Error instance');
    await mirror.close();
  });

  it.each([
    ['init', 'its sync lease'],
    ['refresh', 'its sync lease'],
    ['init', 'writeState, on a store without a lease'],
    ['refresh', 'writeState, on a store without a lease'],
  ] as const)(
    'records mode %s on every state write a run makes through %s',
    async (mode, through) => {
      const sqlite = sqliteMirrorStore({
        path: dbPath,
        table: 'docs',
        primaryKey: 'id',
        columns: { id: 'TEXT', title: 'TEXT', stamp: 'TEXT' },
      });
      const { syncLease: _lease, ...leaseless } = sqlite;
      const store: MirrorStore = through === 'its sync lease' ? sqlite : leaseless;
      const seen: Array<Pick<SyncState, 'mode' | 'status'>> = [];
      const snapshot = async () => {
        const { mode: writer, status } = await store.readState();
        seen.push({ mode: writer, status });
      };
      // Reads the start-of-run write, then the page's write, then fails or returns.
      const run = (failing: boolean): SyncGenerator =>
        async function* (): AsyncGenerator<SyncPage> {
          await snapshot();
          yield { records: [{ id: 'a', title: 'A', stamp: stamp(0) }], cursor: 'c1' };
          await snapshot();
          if (failing) throw new Error('upstream failed after a page');
        };
      const ctx = { log: {}, signal: new AbortController().signal };
      try {
        await runSync(store, run(false), ctx, { mode });
        await snapshot();
        await expect(runSync(store, run(true), ctx, { mode })).rejects.toThrow(
          'upstream failed after a page',
        );
        await snapshot();
        expect(seen).toEqual([
          { status: 'in_progress', mode },
          { status: 'in_progress', mode },
          { status: 'complete', mode },
          { status: 'in_progress', mode },
          { status: 'in_progress', mode },
          { status: 'error', mode },
        ]);
      } finally {
        await sqlite.close();
      }
    },
  );

  /**
   * Which run's position a sync continues. Each case leaves the store the way
   * earlier runs did, its start recorded as STAGED_START, then runs `next` over
   * the full eight-record corpus with a source that does not fail.
   */
  describe('which interrupted run a sync resumes', () => {
    const STAGED_START = '2024-02-01T00:00:00.000Z';

    /** Runs `mode` over the first `upTo` records, two per page, failing at page `throwAtPage` when given. */
    const runOver = (mode: SyncMode, upTo: number, throwAtPage?: number) =>
      mirrorFor({
        records: corpusOf(upTo),
        pageSize: 2,
        received: [],
        ...(throwAtPage !== undefined && { throwAtPage }),
      }).runSync({ mode });
    const failing = (run: Promise<unknown>) => expect(run).rejects.toThrow(/simulated/);
    /** Rewrites the stored state with `change` applied, every other field as stored. */
    const restage = async (change: Partial<SyncState>) => {
      const { store } = mirrorFor({ records: [], pageSize: 1, received: [] });
      await store.writeState({ ...(await store.readState()), ...change });
    };
    const then =
      (...steps: Array<() => Promise<unknown>>) =>
      async () => {
        for (const step of steps) await step();
      };

    // Leaves error, cursor '4', checkpoint stamp(3): pages p0–p3 applied.
    const initFailed = () => failing(runOver('init', 8, 2));
    // After an init of p0–p3, leaves error, cursor '6', checkpoint stamp(5): pages p4–p5 applied.
    const refreshFailed = then(
      () => runOver('init', 4),
      () => failing(runOver('refresh', 8, 1)),
    );
    // After an init of p0–p3, leaves error with no cursor, checkpoint stamp(3): no page applied.
    const refreshFailedFirstPage = then(
      () => runOver('init', 4),
      () => failing(runOver('refresh', 8, 0)),
    );
    // A kill runs no catch block. It leaves the in_progress state its last page
    // committed, whose mode, cursor, checkpoint, and start the error state repeats.
    const killed = () => restage({ status: 'in_progress', error: undefined });
    // A store written before runs recorded their mode.
    const unrecorded = () => restage({ mode: undefined });

    interface ResumeCase {
      applied: number;
      checkpoint?: string;
      cursor?: string;
      keepsStart: boolean;
      next: SyncMode;
      prior: string;
      stage: () => Promise<unknown>;
    }

    it.each<ResumeCase>([
      {
        prior: 'a failed init',
        stage: initFailed,
        next: 'init',
        cursor: '4',
        checkpoint: stamp(3),
        applied: 4,
        keepsStart: true,
      },
      {
        prior: 'a killed init',
        stage: then(initFailed, killed),
        next: 'init',
        cursor: '4',
        checkpoint: stamp(3),
        applied: 4,
        keepsStart: true,
      },
      {
        prior: 'a failed init',
        stage: initFailed,
        next: 'refresh',
        checkpoint: stamp(3),
        applied: 4,
        keepsStart: false,
      },
      {
        prior: 'a killed init',
        stage: then(initFailed, killed),
        next: 'refresh',
        checkpoint: stamp(3),
        applied: 4,
        keepsStart: false,
      },
      {
        prior: 'a failed refresh',
        stage: refreshFailed,
        next: 'init',
        applied: 8,
        keepsStart: false,
      },
      {
        prior: 'a killed refresh',
        stage: then(refreshFailed, killed),
        next: 'init',
        applied: 8,
        keepsStart: false,
      },
      {
        prior: 'a failed refresh',
        stage: refreshFailed,
        next: 'refresh',
        cursor: '6',
        checkpoint: stamp(5),
        applied: 2,
        keepsStart: true,
      },
      {
        prior: 'a killed refresh',
        stage: then(refreshFailed, killed),
        next: 'refresh',
        cursor: '6',
        checkpoint: stamp(5),
        applied: 2,
        keepsStart: true,
      },
      // It continues that refresh, but with no cursor to resume the run starts afresh.
      {
        prior: 'a refresh that failed before its first page',
        stage: refreshFailedFirstPage,
        next: 'refresh',
        checkpoint: stamp(3),
        applied: 4,
        keepsStart: false,
      },
      {
        prior: 'a completed init',
        stage: () => runOver('init', 4),
        next: 'init',
        applied: 8,
        keepsStart: false,
      },
      {
        prior: 'a completed init',
        stage: () => runOver('init', 4),
        next: 'refresh',
        checkpoint: stamp(3),
        applied: 4,
        keepsStart: false,
      },
      {
        prior: 'a completed refresh',
        stage: then(
          () => runOver('init', 4),
          () => runOver('refresh', 6),
        ),
        next: 'init',
        applied: 8,
        keepsStart: false,
      },
      {
        prior: 'a completed refresh',
        stage: then(
          () => runOver('init', 4),
          () => runOver('refresh', 6),
        ),
        next: 'refresh',
        checkpoint: stamp(5),
        applied: 2,
        keepsStart: false,
      },
      // A state with no recorded mode reads as an init's, as every state did before modes were recorded.
      {
        prior: 'a failed refresh, its mode unrecorded',
        stage: then(refreshFailed, unrecorded),
        next: 'init',
        cursor: '6',
        checkpoint: stamp(5),
        applied: 2,
        keepsStart: true,
      },
      {
        prior: 'a killed refresh, its mode unrecorded',
        stage: then(refreshFailed, killed, unrecorded),
        next: 'init',
        cursor: '6',
        checkpoint: stamp(5),
        applied: 2,
        keepsStart: true,
      },
      {
        prior: 'a failed refresh, its mode unrecorded',
        stage: then(refreshFailed, unrecorded),
        next: 'refresh',
        checkpoint: stamp(5),
        applied: 2,
        keepsStart: false,
      },
      {
        prior: 'a killed refresh, its mode unrecorded',
        stage: then(refreshFailed, killed, unrecorded),
        next: 'refresh',
        checkpoint: stamp(5),
        applied: 2,
        keepsStart: false,
      },
    ])(
      'after $prior, a run of mode $next receives cursor $cursor and checkpoint $checkpoint',
      async ({ stage, next, cursor, checkpoint, applied, keepsStart }) => {
        await stage();
        await restage({ startedAt: STAGED_START });

        const src: FakeSource = { records: corpusOf(8), pageSize: 2, received: [] };
        const mirror = mirrorFor(src);
        const result = await mirror.runSync({ mode: next });

        expect(
          src.received.map(({ mode, cursor, checkpoint }) => ({ mode, cursor, checkpoint })),
        ).toEqual([{ mode: next, cursor, checkpoint }]);
        expect(result.recordsApplied).toBe(applied);
        expect(await mirror.store.count()).toBe(8);
        const state = await mirror.store.readState();
        expect(state.status).toBe('complete');
        expect(state.startedAt === STAGED_START).toBe(keepsStart);
      },
    );

    it('resumes an interrupted refresh from its own cursor, so a run of records sharing one checkpoint value all gets applied', async () => {
      const received: Array<Pick<SyncContext, 'checkpoint' | 'cursor' | 'mode'>> = [];
      const committed: string[][] = [];
      // A refresh pages through r0–r4, all stamped '2026-06-04', and its budget
      // allows two pages per run: it fails while pages remain.
      const sync: SyncGenerator = async function* (ctx): AsyncGenerator<SyncPage> {
        if (ctx.mode === 'init') {
          yield {
            records: [{ id: 'seed', title: 'seed', stamp: '2026-06-03' }],
            checkpoint: '2026-06-03',
          };
          return;
        }
        received.push({ mode: ctx.mode, cursor: ctx.cursor, checkpoint: ctx.checkpoint });
        const run: string[] = [];
        committed.push(run);
        let page = Number(ctx.cursor ?? 0);
        for (let pages = 0; pages < 2 && page < 5; pages += 1, page += 1) {
          const id = `r${page}`;
          yield {
            records: [{ id, title: id, stamp: '2026-06-04' }],
            cursor: String(page + 1),
            checkpoint: '2026-06-04',
          };
          // The runner resumes the generator only once the page has committed.
          run.push(id);
        }
        if (page < 5) throw new Error('refresh budget spent');
      };
      const mirror = defineMirror({
        name: 'shared-checkpoint',
        store: sqliteMirrorStore({
          path: dbPath,
          table: 'docs',
          primaryKey: 'id',
          columns: { id: 'TEXT', title: 'TEXT', stamp: 'TEXT' },
        }),
        sync,
      });
      mirrors.add(mirror);

      await mirror.runSync({ mode: 'init' });
      await expect(mirror.runSync({ mode: 'refresh' })).rejects.toThrow('refresh budget spent');
      await expect(mirror.runSync({ mode: 'refresh' })).rejects.toThrow('refresh budget spent');
      await expect(mirror.runSync({ mode: 'refresh' })).resolves.toMatchObject({
        recordsApplied: 1,
        total: 6,
      });

      expect(received).toEqual([
        { mode: 'refresh', cursor: undefined, checkpoint: '2026-06-03' },
        { mode: 'refresh', cursor: '2', checkpoint: '2026-06-04' },
        { mode: 'refresh', cursor: '4', checkpoint: '2026-06-04' },
      ]);
      expect(committed).toEqual([['r0', 'r1'], ['r2', 'r3'], ['r4']]);
      const state = await mirror.store.readState();
      expect(state).toMatchObject({ status: 'complete', checkpoint: '2026-06-04' });
      expect(state.cursor).toBeUndefined();
    });
  });
});

describe('runSync (direct) — defensive logger handling', () => {
  /** A minimal spec-conformant MirrorStore double — just enough state to drive runSync directly. */
  function makeMinimalStore(): MirrorStore {
    let state: SyncState = { status: 'pending' };
    const store: MirrorStore = {
      async applyBatch() {},
      async close() {},
      async count() {
        return 0;
      },
      async getByIds() {
        return [];
      },
      async integrityCheck() {
        return { ok: true, results: [] };
      },
      async query() {
        return { rows: [], total: 0 };
      },
      async raw() {
        return {} as SqliteHandle;
      },
      async readState() {
        return state;
      },
      async writeState(next) {
        state = next;
      },
      async [Symbol.asyncDispose]() {
        await store.close();
      },
    };
    return store;
  }

  it('completes a successful sync when the logger provides no methods at all', async () => {
    const sync: SyncGenerator = async function* (): AsyncGenerator<SyncPage> {
      yield { records: [{ id: '1' }] };
    };
    const result = await runSync(
      makeMinimalStore(),
      sync,
      { log: {}, signal: new AbortController().signal },
      { mode: 'init' },
    );
    expect(result.recordsApplied).toBe(1);
  });

  it('propagates a sync failure when the logger provides no methods at all (error path optional-chains safely too)', async () => {
    // biome-ignore lint/correctness/useYield: deliberately throws before ever yielding — that failure-before-any-page case is what this test covers.
    const sync: SyncGenerator = async function* (): AsyncGenerator<SyncPage> {
      throw new Error('boom');
    };
    await expect(
      runSync(
        makeMinimalStore(),
        sync,
        { log: {}, signal: new AbortController().signal },
        { mode: 'init' },
      ),
    ).rejects.toThrow('boom');
  });

  it('checks cancellation before applying a yielded page', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancel before apply'));
    const store = makeMinimalStore();
    const applyBatch = vi.spyOn(store, 'applyBatch');
    const writeState = vi.spyOn(store, 'writeState');
    const sync: SyncGenerator = async function* (): AsyncGenerator<SyncPage> {
      yield { records: [{ id: 'must-not-apply' }] };
    };

    await expect(
      runSync(store, sync, { log: {}, signal: controller.signal }, { mode: 'init' }),
    ).rejects.toThrow('cancel before apply');
    expect(applyBatch).not.toHaveBeenCalled();
    expect(writeState.mock.calls.at(-1)?.[0]).toMatchObject({
      status: 'error',
      error: 'cancel before apply',
    });
  });

  it('checks cancellation after the last page before terminal count and completion', async () => {
    const controller = new AbortController();
    const store = makeMinimalStore();
    const applyBatch = vi.spyOn(store, 'applyBatch');
    const count = vi.spyOn(store, 'count');
    const writeState = vi.spyOn(store, 'writeState');
    const sync: SyncGenerator = async function* (): AsyncGenerator<SyncPage> {
      yield { records: [{ id: 'applied-before-cancel' }] };
    };

    await expect(
      runSync(
        store,
        sync,
        { log: {}, signal: controller.signal },
        {
          mode: 'refresh',
          onProgress: () => controller.abort(new Error('cancel before completion')),
        },
      ),
    ).rejects.toThrow('cancel before completion');
    expect(applyBatch).toHaveBeenCalledOnce();
    expect(count).not.toHaveBeenCalled();
    expect(writeState.mock.calls.at(-1)?.[0]).toMatchObject({
      status: 'error',
      error: 'cancel before completion',
    });
    expect(writeState.mock.calls.some(([state]) => state.status === 'complete')).toBe(false);
  });
});

const SYNC_LOCKED_MESSAGE = 'Mirror sync is already in progress in another process or instance.';
const LEASE_LOST_MESSAGE =
  'Mirror sync lost its lease to another process or instance and wrote nothing after the takeover.';

const pageOf = (id: string, stampValue: string): SyncPage => ({
  records: [{ id, title: id, stamp: stampValue }],
  cursor: `after-${id}`,
  checkpoint: stampValue,
});

/**
 * Several mirrors, each over its own store instance (its own connection) on one
 * file — what separate processes see, minus the process boundary. Lease expiry
 * is driven by the faked clock: `Date` and the renewal timer are fake, so time
 * moves only when a test moves it.
 */
describe('mirror runner — sync lease across store instances on one file', () => {
  const TTL_MS = 60_000;
  let dir: string;
  let dbPath: string;
  const mirrors = new Set<Mirror>();

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    dir = await mkdtemp(join(tmpdir(), 'mirror-lease-test-'));
    dbPath = join(dir, 'mirror.db');
  });
  afterEach(async () => {
    vi.useRealTimers();
    try {
      await Promise.all([...mirrors].map((mirror) => mirror.close()));
    } finally {
      mirrors.clear();
      await rm(dir, { recursive: true, force: true });
    }
  });

  const instance = (
    sync: SyncGenerator,
    options: { busyTimeoutMs?: number; logger?: MirrorLogger } = {},
  ): Mirror => {
    const mirror = defineMirror({
      name: 'shared',
      logger: options.logger ?? {},
      syncLeaseTtlMs: TTL_MS,
      store: sqliteMirrorStore({
        path: dbPath,
        table: 'docs',
        primaryKey: 'id',
        columns: { id: 'TEXT', title: 'TEXT', stamp: 'TEXT' },
        ...(options.busyTimeoutMs !== undefined && { busyTimeoutMs: options.busyTimeoutMs }),
      }),
      sync,
    });
    mirrors.add(mirror);
    return mirror;
  };

  /** Yields `before`, then waits for `resume()` (signalling `paused`), then yields `after`. */
  function pausing(before: SyncPage[], after: SyncPage[] = [], ending?: Error) {
    const paused = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const sync: SyncGenerator = async function* (): AsyncGenerator<SyncPage> {
      for (const page of before) yield page;
      paused.resolve();
      await gate.promise;
      for (const page of after) yield page;
      if (ending) throw ending;
    };
    return { sync, paused: paused.promise, resume: () => gate.resolve() };
  }

  /** A sync that counts its runs, to show a rejected run never started it. */
  function counted(pages: SyncPage[] = []) {
    const counter = { runs: 0 };
    const sync: SyncGenerator = async function* (): AsyncGenerator<SyncPage> {
      counter.runs += 1;
      for (const page of pages) yield page;
    };
    return { sync, counter };
  }

  const rejection = (run: Promise<unknown>): Promise<unknown> =>
    run.then(
      () => {
        throw new Error('Expected the sync to reject.');
      },
      (err: unknown) => err,
    );

  function expectSyncLocked(error: unknown): void {
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.Conflict, message: SYNC_LOCKED_MESSAGE });
    // No host, pid, or path: a tool forwards message and data to its caller.
    expect((error as McpError).data).toEqual({ reason: 'sync_locked' });
  }

  function expectLeaseLost(error: unknown): void {
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.Conflict, message: LEASE_LOST_MESSAGE });
    expect((error as McpError).data).toEqual({ reason: 'sync_lease_lost' });
  }

  const ids = async (mirror: Mirror, wanted: string[]) =>
    (await mirror.getByIds(wanted)).map((row) => row.id);

  it('rejects a run while another instance holds a live lease, before its generator runs, and runs it once the lease is released', async () => {
    const holder = pausing([pageOf('a', stamp(0))], [pageOf('b', stamp(1))]);
    const holding = instance(holder.sync).runSync({ mode: 'init' });
    await holder.paused;

    const contender = counted([pageOf('c', stamp(2))]);
    const second = instance(contender.sync);
    expectSyncLocked(await rejection(second.runSync({ mode: 'refresh' })));
    expect(contender.counter.runs).toBe(0);

    holder.resume();
    await expect(holding).resolves.toMatchObject({ pagesFetched: 2 });
    await expect(second.runSync({ mode: 'refresh' })).resolves.toMatchObject({ pagesFetched: 1 });
    expect(contender.counter.runs).toBe(1);
  });

  it.each(['opened', 'not yet opened'])(
    'rejects sync_locked, not DatabaseError, when another connection holds the write lock past busyTimeoutMs (claiming store %s)',
    async (storeState) => {
      const writer = await instance(counted().sync).raw();
      const contender = counted([pageOf('c', stamp(0))]);
      const second = instance(contender.sync, { busyTimeoutMs: 0 });
      if (storeState === 'opened') await second.status();

      writer.exec('BEGIN IMMEDIATE');
      try {
        expectSyncLocked(await rejection(second.runSync({ mode: 'refresh' })));
      } finally {
        writer.exec('ROLLBACK');
      }
      expect(contender.counter.runs).toBe(0);
      await expect(second.runSync({ mode: 'refresh' })).resolves.toMatchObject({ pagesFetched: 1 });
    },
  );

  it('lets an expired lease be taken over; the stale holder then writes nothing, rejects sync_lease_lost, and leaves the new lease in place', async () => {
    const logged: Array<[string, string]> = [];
    const logger: MirrorLogger = {
      warning: (message) => logged.push(['warning', message]),
      error: (message) => logged.push(['error', message]),
    };
    const stale = pausing([pageOf('h1', stamp(0))], [pageOf('h2', stamp(1))]);
    const staleRun = rejection(instance(stale.sync, { logger }).runSync({ mode: 'init' }));
    await stale.paused;

    // Past the stale holder's expiry; its renewal timer never fired.
    vi.setSystemTime(Date.now() + TTL_MS + 1);
    const taker = pausing([pageOf('t1', stamp(5))], [pageOf('t2', stamp(6))]);
    const takerMirror = instance(taker.sync);
    const taking = takerMirror.runSync({ mode: 'refresh' });
    await taker.paused;

    stale.resume();
    expectLeaseLost(await staleRun);
    expect(logged).toEqual([['warning', 'Mirror sync lost its lease']]);
    expect(await ids(takerMirror, ['h1', 'h2', 't1'])).toEqual(['h1', 't1']);
    // No error state from the stale holder: the state is the taker's.
    expect(await takerMirror.store.readState()).toMatchObject({
      status: 'in_progress',
      cursor: 'after-t1',
      checkpoint: stamp(5),
    });
    // The stale holder's release left the taker's lease live.
    const third = counted();
    expectSyncLocked(await rejection(instance(third.sync).runSync({ mode: 'refresh' })));
    expect(third.counter.runs).toBe(0);

    taker.resume();
    await expect(taking).resolves.toMatchObject({ pagesFetched: 2 });
    expect(await takerMirror.status()).toMatchObject({ status: 'complete', checkpoint: stamp(6) });
  });

  it.each([
    ['complete', undefined],
    ['error', new Error('upstream failed after the takeover')],
  ] as const)(
    "rejects a stale holder's %s write after a takeover and keeps the new holder's state",
    async (_ending, failure) => {
      const stale = pausing([pageOf('h1', stamp(0))], [], failure);
      const staleRun = rejection(instance(stale.sync).runSync({ mode: 'init' }));
      await stale.paused;

      vi.setSystemTime(Date.now() + TTL_MS + 1);
      const takerMirror = instance(counted([pageOf('t1', stamp(5))]).sync);
      await expect(takerMirror.runSync({ mode: 'refresh' })).resolves.toMatchObject({ total: 2 });

      stale.resume();
      expectLeaseLost(await staleRun);
      const state = await takerMirror.store.readState();
      expect(state).toMatchObject({ status: 'complete', checkpoint: stamp(5), total: 2 });
      expect(state.error).toBeUndefined();
    },
  );

  it('renews a held lease on a timer between pages, so it stays live past the expiry its claim set', async () => {
    const holder = pausing([pageOf('a', stamp(0))]);
    const holding = instance(holder.sync).runSync({ mode: 'init' });
    await holder.paused;
    const committedAt = Date.now();

    await vi.advanceTimersByTimeAsync(TTL_MS / 3);
    vi.setSystemTime(committedAt + TTL_MS + 1);
    const contender = counted();
    expectSyncLocked(await rejection(instance(contender.sync).runSync({ mode: 'refresh' })));
    expect(contender.counter.runs).toBe(0);

    holder.resume();
    await expect(holding).resolves.toMatchObject({ pagesFetched: 1 });
  });

  it("aborts the stale holder's generator when its renewal finds the lease taken over, before any further page", async () => {
    const paused = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let abortReason: unknown;
    const staleRun = rejection(
      instance(async function* ({ signal }): AsyncGenerator<SyncPage> {
        yield pageOf('h1', stamp(0));
        signal.addEventListener('abort', () => {
          abortReason = signal.reason;
        });
        paused.resolve();
        await gate.promise;
        if (!signal.aborted) yield pageOf('h2', stamp(1));
      }).runSync({ mode: 'init' }),
    );
    await paused.promise;

    vi.setSystemTime(Date.now() + TTL_MS + 1);
    const taker = pausing([pageOf('t1', stamp(5))]);
    const taking = instance(taker.sync).runSync({ mode: 'refresh' });
    await taker.paused;

    await vi.advanceTimersByTimeAsync(TTL_MS / 3);
    await vi.waitFor(() => expectLeaseLost(abortReason));

    gate.resolve();
    expectLeaseLost(await staleRun);
    taker.resume();
    await expect(taking).resolves.toMatchObject({ pagesFetched: 1 });
  });

  it('aborts the generator and fails the run with the renewal error when a renewal cannot reach the store', async () => {
    const paused = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let abortReason: unknown;
    const holder = instance(
      async function* ({ signal }): AsyncGenerator<SyncPage> {
        yield pageOf('h1', stamp(0));
        signal.addEventListener('abort', () => {
          abortReason = signal.reason;
        });
        paused.resolve();
        await gate.promise;
        if (!signal.aborted) yield pageOf('h2', stamp(1));
      },
      { busyTimeoutMs: 0 },
    );
    const holding = rejection(holder.runSync({ mode: 'init' }));
    await paused.promise;

    const writer = await instance(counted().sync).raw();
    writer.exec('BEGIN IMMEDIATE');
    try {
      await vi.advanceTimersByTimeAsync(TTL_MS / 3);
      await vi.waitFor(() => expect(abortReason).toMatchObject({ code: 'SQLITE_BUSY' }));
    } finally {
      writer.exec('ROLLBACK');
    }

    gate.resolve();
    expect(await holding).toBe(abortReason);
    expect(await ids(holder, ['h1', 'h2'])).toEqual(['h1']);
    expect(await holder.store.readState()).toMatchObject({ status: 'error', cursor: 'after-h1' });
  });

  it('pushes the lease expiry out when a page commits, so a page that outlasts the TTL leaves the lease live', async () => {
    const start = Date.now();
    // Reading this record happens inside the page's commit; it moves the clock
    // the way a page that takes twice the TTL to write would.
    const slow = {
      id: 'slow',
      stamp: stamp(0),
      get title() {
        vi.setSystemTime(start + 2 * TTL_MS);
        return 'slow';
      },
    };
    const holder = pausing([{ records: [slow], cursor: 'after-slow', checkpoint: stamp(0) }]);
    const holding = instance(holder.sync).runSync({ mode: 'init' });
    await holder.paused;
    expect(Date.now()).toBe(start + 2 * TTL_MS);

    expectSyncLocked(await rejection(instance(counted().sync).runSync({ mode: 'refresh' })));

    holder.resume();
    await expect(holding).resolves.toMatchObject({ pagesFetched: 1 });
  });

  it("commits a page's records and its state in one transaction", async () => {
    const mirror = instance(async function* (): AsyncGenerator<SyncPage> {
      yield pageOf('kept', stamp(0));
      yield { records: [{ id: 'undone', title: 'undone', stamp: stamp(1) }], cursor: 'refused' };
    });
    (await mirror.raw()).exec(
      `CREATE TRIGGER refuse_state BEFORE UPDATE ON mirror_sync_state WHEN NEW.cursor = 'refused'
       BEGIN SELECT RAISE(ABORT, 'state write refused'); END`,
    );

    await expect(mirror.runSync({ mode: 'init' })).rejects.toThrow('state write refused');
    expect(await ids(mirror, ['kept', 'undone'])).toEqual(['kept']);
    // The failed run records the last page that committed, ready to resume from.
    expect(await mirror.store.readState()).toMatchObject({
      status: 'error',
      cursor: 'after-kept',
      checkpoint: stamp(0),
      error: 'state write refused',
    });
  });
});

/**
 * The lease between real processes on one store file, on this runtime's
 * driver. A process stands in for time passing by moving its own clock.
 */
describe('mirror runner — sync lease across processes', () => {
  const PROCESS_TIMEOUT_MS = 60_000;
  const TTL_MS = 60_000;
  let dir: string;
  let barriers: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mirror-lease-process-test-'));
    barriers = join(dir, 'barriers');
    await mkdir(barriers);
    path = join(dir, 'shared.db');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const read = async <T>(fn: (handle: SqliteHandle) => T): Promise<T> => {
    const store = sqliteMirrorStore({
      path,
      table: 'docs',
      primaryKey: 'id',
      columns: { id: 'TEXT', title: 'TEXT', stamp: 'TEXT' },
    });
    try {
      return fn(await store.raw());
    } finally {
      await store.close();
    }
  };

  it(
    'rejects a second process while the first holds the lease, and lets a later process sync once it is released',
    async () => {
      const [holder, contender] = await Promise.all([
        runMirrorProcess({
          role: 'sync',
          barriers,
          path,
          writer: 'holder',
          mode: 'init',
          syncLeaseTtlMs: TTL_MS,
          pages: [
            { ids: ['h1'], cursor: 'h1', checkpoint: '2026-01-01' },
            {
              ids: ['h2'],
              cursor: 'h2',
              checkpoint: '2026-01-02',
              before: { signal: 'holding', waitFor: 'contended' },
            },
          ],
        }),
        runMirrorProcess({
          role: 'sync',
          barriers,
          path,
          writer: 'contender',
          mode: 'refresh',
          syncLeaseTtlMs: TTL_MS,
          startAfter: 'holding',
          signalWhenSettled: 'contended',
          pages: [{ ids: ['c1'], cursor: 'c1', checkpoint: '2026-01-03' }],
        }),
      ]);

      expect(holder).toMatchObject({ ok: true, result: { pagesFetched: 2, total: 2 } });
      expect(contender).toEqual({
        ok: false,
        generatorRuns: 0,
        error: {
          code: JsonRpcErrorCode.Conflict,
          message: SYNC_LOCKED_MESSAGE,
          data: { reason: 'sync_locked' },
        },
      });

      const later = await runMirrorProcess({
        role: 'sync',
        barriers,
        path,
        writer: 'later',
        mode: 'refresh',
        syncLeaseTtlMs: TTL_MS,
        pages: [{ ids: ['l1'], cursor: 'l1', checkpoint: '2026-01-04' }],
      });
      expect(later).toMatchObject({ ok: true, generatorRuns: 1, result: { total: 3 } });
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    'lets a process take over an expired lease mid-run; the stale process then writes nothing and leaves the new lease in place',
    async () => {
      const [stale, taker] = await Promise.all([
        runMirrorProcess({
          role: 'sync',
          barriers,
          path,
          writer: 'stale',
          mode: 'init',
          syncLeaseTtlMs: TTL_MS,
          signalWhenSettled: 'stale-settled',
          pages: [
            { ids: ['s1'], cursor: 's1', checkpoint: '2026-01-01' },
            {
              ids: ['s2'],
              cursor: 's2',
              checkpoint: '2026-01-02',
              before: { signal: 'stale-paused', waitFor: 'taker-holding' },
            },
          ],
        }),
        runMirrorProcess({
          role: 'sync',
          barriers,
          path,
          writer: 'taker',
          mode: 'refresh',
          syncLeaseTtlMs: TTL_MS,
          // Two TTLs later by this process's clock: the stale lease has expired.
          clockOffsetMs: 2 * TTL_MS,
          startAfter: 'stale-paused',
          pages: [
            { ids: ['t1'], cursor: 't1', checkpoint: '2026-02-01' },
            {
              ids: ['t2'],
              cursor: 't2',
              checkpoint: '2026-02-02',
              before: { signal: 'taker-holding', waitFor: 'stale-settled' },
            },
          ],
        }),
      ]);

      expect(stale).toEqual({
        ok: false,
        generatorRuns: 1,
        error: {
          code: JsonRpcErrorCode.Conflict,
          message: LEASE_LOST_MESSAGE,
          data: { reason: 'sync_lease_lost' },
        },
      });
      // The taker's last page committed after the stale process released: its lease held.
      expect(taker).toMatchObject({ ok: true, result: { pagesFetched: 2, total: 3 } });
      expect(
        await read((handle) =>
          handle
            .prepare<{ id: string; title: string }>('SELECT id, title FROM docs ORDER BY id')
            .all(),
        ),
      ).toEqual([
        { id: 's1', title: 'stale' },
        { id: 't1', title: 'taker' },
        { id: 't2', title: 'taker' },
      ]);
      expect(
        await read((handle) =>
          handle
            .prepare<{ status: string; checkpoint: string }>(
              'SELECT status, checkpoint FROM mirror_sync_state',
            )
            .get(),
        ),
      ).toEqual({ status: 'complete', checkpoint: '2026-02-02' });
    },
    PROCESS_TIMEOUT_MS,
  );
});

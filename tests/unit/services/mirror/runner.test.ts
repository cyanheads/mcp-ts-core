/**
 * @fileoverview Runner + defineMirror tests — the consumer-shape validation
 * harness. A fake token-paged source proves full init, interrupt-resume from a
 * persisted cursor, incremental refresh from the durable checkpoint, tombstone
 * application, and that a failed refresh keeps a complete mirror "ready".
 * @module tests/unit/services/mirror/runner
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineMirror } from '@/services/mirror/core/defineMirror.js';
import { sqliteMirrorStore } from '@/services/mirror/sqlite/sqliteMirrorStore.js';
import type { MirrorRow, SyncContext, SyncGenerator, SyncPage } from '@/services/mirror/types.js';

const stamp = (i: number): string => `2024-01-${String(i + 1).padStart(2, '0')}`;
const corpusOf = (n: number): MirrorRow[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, title: `paper ${i}`, stamp: stamp(i) }));

function maxStamp(rows: MirrorRow[]): string | undefined {
  const stamps = rows.map((r) => String(r.stamp)).sort();
  return stamps[stamps.length - 1];
}

interface FakeSource {
  pageSize: number;
  received: SyncContext[];
  records: MirrorRow[];
  refreshTombstones?: string[];
  throwAtPage?: number;
}

/** A token-paged source: cursor is the record offset; checkpoint is the max stamp. */
function makeSync(src: FakeSource): SyncGenerator {
  return async function* sync(ctx: SyncContext): AsyncGenerator<SyncPage> {
    src.received.push(ctx);
    const visible =
      ctx.mode === 'refresh' && ctx.checkpoint
        ? src.records.filter((r) => String(r.stamp) > (ctx.checkpoint as string))
        : src.records;
    let offset = ctx.mode === 'init' && ctx.cursor ? Number(ctx.cursor) : 0;
    let pageIndex = 0;
    let tombstonesEmitted = false;

    while (offset < visible.length) {
      if (src.throwAtPage !== undefined && pageIndex === src.throwAtPage) {
        throw new Error('simulated upstream failure');
      }
      const slice = visible.slice(offset, offset + src.pageSize);
      offset += slice.length;
      const checkpoint = maxStamp(slice);
      const tombstones =
        !tombstonesEmitted && ctx.mode === 'refresh' ? (src.refreshTombstones ?? []) : [];
      tombstonesEmitted = true;
      yield {
        records: slice,
        ...(tombstones.length > 0 && { tombstones }),
        cursor: offset < visible.length ? String(offset) : undefined,
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

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mirror-runner-test-'));
    dbPath = join(dir, 'mirror.db');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const mirrorFor = (src: FakeSource) =>
    defineMirror({
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

  it('runs a full init and reports ready with the high-water checkpoint', async () => {
    const src: FakeSource = { records: corpusOf(8), pageSize: 2, received: [] };
    const mirror = mirrorFor(src);
    const result = await mirror.runSync({ mode: 'init' });

    expect(result.recordsApplied).toBe(8);
    expect(await mirror.store.count()).toBe(8);

    const status = await mirror.status();
    expect(status.status).toBe('complete');
    expect(status.ready).toBe(true);
    expect(status.total).toBe(8);
    expect(status.checkpoint).toBe(stamp(7));
    // Volatile cursor is cleared on completion.
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
    expect(await m1.store.count()).toBe(4);
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
    await m2.close();
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
});

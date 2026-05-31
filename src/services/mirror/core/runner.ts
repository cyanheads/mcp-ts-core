/**
 * @fileoverview Sync runner — drives a server's `sync` generator against a
 * {@link MirrorStore} for full init and incremental refresh. Owns the
 * cursor/checkpoint state machine, per-page persistence, resume-on-interrupt,
 * and terminal status transitions.
 * @module services/mirror/core/runner
 */

import type {
  MirrorLogger,
  MirrorStore,
  RunSyncOptions,
  SyncGenerator,
  SyncResult,
  SyncState,
} from '../types.js';

/** Minimal context the runner consumes — a duck-typed logger plus cancellation. */
export interface RunnerContext {
  log: MirrorLogger;
  signal: AbortSignal;
}

/**
 * Run one sync cycle.
 *
 * - `init` performs a full harvest. With no prior state it starts from scratch;
 *   if a previous init left an incomplete dataset (status `in_progress` from a
 *   crash, or `error` from a caught failure) and a `cursor` was persisted, it
 *   resumes from that cursor, with `checkpoint` available for recovery.
 * - `refresh` performs an incremental harvest from the durable `checkpoint`.
 *
 * State is persisted after every page, so an interrupt at any point resumes from
 * the last yielded page. On success the volatile `cursor` is cleared and
 * `completedAt`/`total` advance; on failure they are preserved (a failed
 * refresh on top of a complete mirror stays "ready").
 */
export async function runSync(
  store: MirrorStore,
  sync: SyncGenerator,
  ctx: RunnerContext,
  options: RunSyncOptions,
): Promise<SyncResult> {
  const existing = await store.readState();
  // An init re-runs from scratch only when the prior run completed; otherwise it
  // resumes from a persisted cursor (crash mid-write, or caught error mid-init).
  const incompleteInit = options.mode === 'init' && existing.status !== 'complete';
  const resuming = incompleteInit && existing.cursor !== undefined;

  const startCursor = resuming ? existing.cursor : undefined;
  const startCheckpoint =
    options.mode === 'refresh' || incompleteInit ? existing.checkpoint : undefined;
  const startedAt = (resuming && existing.startedAt) || new Date().toISOString();

  let cursor = startCursor;
  let checkpoint = startCheckpoint;

  await store.writeState({ status: 'in_progress', startedAt, cursor, checkpoint });

  let pagesFetched = 0;
  let recordsApplied = 0;
  let tombstonesApplied = 0;

  try {
    for await (const page of sync({
      mode: options.mode,
      cursor: startCursor,
      checkpoint: startCheckpoint,
      signal: ctx.signal,
    })) {
      const tombstones = page.tombstones ?? [];
      await store.applyBatch(page.records, tombstones);

      pagesFetched += 1;
      recordsApplied += page.records.length;
      tombstonesApplied += tombstones.length;

      cursor = page.cursor;
      // Durable high-water mark advances monotonically (lexicographic compare).
      if (page.checkpoint && (!checkpoint || page.checkpoint > checkpoint)) {
        checkpoint = page.checkpoint;
      }

      await store.writeState({ status: 'in_progress', startedAt, cursor, checkpoint });
      options.onProgress?.({
        pages: pagesFetched,
        records: recordsApplied,
        tombstones: tombstonesApplied,
        cursor,
        checkpoint,
      });
    }

    const total = await store.count();
    await store.writeState({
      status: 'complete',
      startedAt,
      checkpoint,
      cursor: undefined, // volatile cursor is meaningless once complete
      completedAt: new Date().toISOString(),
      total,
    });
    ctx.log.info?.('Mirror sync complete', {
      mode: options.mode,
      pagesFetched,
      recordsApplied,
      tombstonesApplied,
      total,
    });
    return { pagesFetched, recordsApplied, tombstonesApplied, total };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorState: SyncState = {
      status: 'error',
      startedAt,
      cursor,
      checkpoint,
      error: message,
    };
    await store.writeState(errorState);
    ctx.log.error?.('Mirror sync failed', { mode: options.mode, error: message });
    throw err;
  }
}

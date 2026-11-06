/**
 * @fileoverview Sync runner — drives a server's `sync` generator against a
 * {@link MirrorStore} for full init and incremental refresh. Owns the
 * cursor/checkpoint state machine, per-page persistence, resume-on-interrupt,
 * terminal status transitions, and, with a store that provides a `syncLease`,
 * the cross-process lease every write of a run is fenced on.
 * @module services/mirror/core/runner
 */

import { conflict, McpError } from '@/types-global/errors.js';
import type {
  MirrorLogger,
  MirrorRow,
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
  /**
   * How long, in ms, the run's sync lease stays live after its last commit or
   * renewal. Default 120000. Used only with a store that provides `syncLease`.
   */
  syncLeaseTtlMs?: number;
}

const DEFAULT_SYNC_LEASE_TTL_MS = 120_000;

/** How the run persists: fenced on a lease, or straight to a store without one. */
interface RunWrites {
  /** The caller's own signal: aborted when the caller stops the run. */
  caller: AbortSignal;
  commitPage(records: MirrorRow[], tombstones: string[], state: SyncState): Promise<void>;
  commitState(state: SyncState): Promise<void>;
  log: MirrorLogger;
  /** Aborted when the run loses its lease or cannot renew it; the reason says which. */
  lost?: AbortSignal;
  /** The generator's signal: the caller's, plus lease loss. */
  signal: AbortSignal;
}

/**
 * Run one sync cycle.
 *
 * - `init` performs a full harvest, from scratch unless it continues an
 *   interrupted init.
 * - `refresh` performs an incremental harvest from the durable `checkpoint`.
 *
 * Every state write records the run's mode. A run continues an interrupted run
 * (status `in_progress` from a crash, or `error` from a caught failure) only
 * when that run had the same mode: `sync()` then receives its persisted
 * `cursor` and `checkpoint`, and the run keeps its `startedAt` when it resumes
 * a cursor. Otherwise an `init` receives neither and a `refresh` only
 * `checkpoint`. A state with no recorded mode, written before runs recorded
 * one, reads as an init's.
 *
 * State is persisted after every page, so an interrupt at any point resumes from
 * the last yielded page. On success the volatile `cursor` is cleared and
 * `completedAt`/`total` advance; on failure they are preserved (a failed
 * refresh on top of a complete mirror stays "ready").
 *
 * A failure is recorded as status `error` with its message and rethrown, and
 * logged as `Mirror sync failed` at `error`. When the caller's signal has
 * aborted by then, whatever the generator threw, the run was stopped, not
 * failed: it logs `Mirror sync stopped` at `info` with the abort reason's
 * message instead, and records and rethrows the same way, so the next run of
 * its mode resumes from its last page.
 *
 * With a store that provides `syncLease`, the run first claims the lease and
 * rejects `Conflict` (`data.reason: 'sync_locked'`) while another process or
 * instance holds it live; the generator never runs then. Each page's records,
 * tombstones, and state commit in one transaction fenced on the lease, and a
 * timer renews it between pages. A run whose lease was taken over aborts its
 * generator, writes nothing more, and rejects `Conflict`
 * (`data.reason: 'sync_lease_lost'`). The lease is released when the run settles.
 */
export async function runSync(
  store: MirrorStore,
  sync: SyncGenerator,
  ctx: RunnerContext,
  options: RunSyncOptions,
): Promise<SyncResult> {
  const leases = store.syncLease;
  if (!leases) {
    return runPages(store, sync, options, {
      caller: ctx.signal,
      log: ctx.log,
      signal: ctx.signal,
      async commitPage(records, tombstones, state) {
        await store.applyBatch(records, tombstones);
        await store.writeState(state);
      },
      commitState: (state) => store.writeState(state),
    });
  }

  const lease = await leases.claim(
    crypto.randomUUID(),
    ctx.syncLeaseTtlMs ?? DEFAULT_SYNC_LEASE_TTL_MS,
  );
  if (!lease) {
    throw conflict('Mirror sync is already in progress in another process or instance.', {
      reason: 'sync_locked',
    });
  }

  const lost = new AbortController();
  const fenced = async (state: SyncState, records?: MirrorRow[], tombstones?: string[]) => {
    if (await leases.commit(lease, state, records, tombstones)) return;
    const error = leaseLost();
    lost.abort(error);
    throw error;
  };
  let renewal: Promise<void> | undefined;
  const renewTimer = setInterval(() => {
    renewal ??= leases
      .renew(lease)
      .then(
        (held) => {
          if (!held) lost.abort(leaseLost());
        },
        (err: unknown) => {
          lost.abort(err);
        },
      )
      .finally(() => {
        renewal = undefined;
      });
  }, lease.ttlMs / 3);

  try {
    return await runPages(store, sync, options, {
      caller: ctx.signal,
      log: ctx.log,
      lost: lost.signal,
      signal: AbortSignal.any([ctx.signal, lost.signal]),
      commitPage: (records, tombstones, state) => fenced(state, records, tombstones),
      commitState: (state) => fenced(state),
    });
  } finally {
    clearInterval(renewTimer);
    await renewal;
    await leases.release(lease);
  }
}

async function runPages(
  store: MirrorStore,
  sync: SyncGenerator,
  options: RunSyncOptions,
  run: RunWrites,
): Promise<SyncResult> {
  const { mode } = options;
  const existing = await store.readState();
  /**
   * A run continues the stored position only when a run of its own mode was
   * interrupted (killed mid-run, or failed): a cursor belongs to the query of
   * the run that wrote it. A state without a recorded mode was written before
   * runs recorded one, when only an init resumed, so it reads as an init's.
   */
  const continuing =
    (existing.status === 'in_progress' || existing.status === 'error') &&
    (existing.mode ?? 'init') === mode;
  const resuming = continuing && existing.cursor !== undefined;

  const startCursor = resuming ? existing.cursor : undefined;
  const startCheckpoint = mode === 'refresh' || continuing ? existing.checkpoint : undefined;
  const startedAt = (resuming && existing.startedAt) || new Date().toISOString();

  let cursor = startCursor;
  let checkpoint = startCheckpoint;

  await run.commitState({ status: 'in_progress', mode, startedAt, cursor, checkpoint });

  let pagesFetched = 0;
  let recordsApplied = 0;
  let tombstonesApplied = 0;

  try {
    for await (const page of sync({
      mode,
      cursor: startCursor,
      checkpoint: startCheckpoint,
      signal: run.signal,
    })) {
      run.signal.throwIfAborted();
      const tombstones = page.tombstones ?? [];
      // Durable high-water mark advances monotonically (lexicographic compare).
      const nextCheckpoint =
        page.checkpoint && (!checkpoint || page.checkpoint > checkpoint)
          ? page.checkpoint
          : checkpoint;
      await run.commitPage(page.records, tombstones, {
        status: 'in_progress',
        mode,
        startedAt,
        cursor: page.cursor,
        checkpoint: nextCheckpoint,
      });
      // Only a committed page moves the position a failure records.
      cursor = page.cursor;
      checkpoint = nextCheckpoint;

      pagesFetched += 1;
      recordsApplied += page.records.length;
      tombstonesApplied += tombstones.length;
      options.onProgress?.({
        pages: pagesFetched,
        records: recordsApplied,
        tombstones: tombstonesApplied,
        cursor,
        checkpoint,
      });
    }

    run.signal.throwIfAborted();
    const total = await store.count();
    run.signal.throwIfAborted();
    await run.commitState({
      status: 'complete',
      mode,
      startedAt,
      checkpoint,
      cursor: undefined, // volatile cursor is meaningless once complete
      completedAt: new Date().toISOString(),
      total,
    });
    run.log.info?.('Mirror sync complete', {
      mode,
      pagesFetched,
      recordsApplied,
      tombstonesApplied,
      total,
    });
    return { pagesFetched, recordsApplied, tombstonesApplied, total };
  } catch (err) {
    // After a lost lease the generator may stop with its own abort error; the loss is the cause.
    const failure: unknown = run.lost?.aborted ? run.lost.reason : err;
    if (isLeaseLost(failure)) {
      run.log.warning?.('Mirror sync lost its lease', { mode });
      throw failure;
    }
    const message = messageOf(failure);
    // The caller ended the run, whatever the generator threw on the way out.
    if (run.caller.aborted) {
      run.log.info?.('Mirror sync stopped', { mode, reason: messageOf(run.caller.reason) });
    } else {
      run.log.error?.('Mirror sync failed', { mode, error: message });
    }
    // Throws `sync_lease_lost` instead when the lease was taken over meanwhile.
    await run.commitState({ status: 'error', mode, startedAt, cursor, checkpoint, error: message });
    throw failure;
  }
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function leaseLost(): McpError {
  return conflict(
    'Mirror sync lost its lease to another process or instance and wrote nothing after the takeover.',
    { reason: 'sync_lease_lost' },
  );
}

function isLeaseLost(err: unknown): boolean {
  return err instanceof McpError && err.data?.reason === 'sync_lease_lost';
}

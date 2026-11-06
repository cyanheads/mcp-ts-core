/**
 * @fileoverview Runs `mirror-process-child.ts` as a separate OS process on the
 * runtime running the tests (`process.execPath`): Bun with `bun:sqlite`, Node
 * with `better-sqlite3`. Mirror tests use it to put two real processes on one
 * store file, and to run a bind that could end its process outside the test
 * runner's own. The children coordinate through barrier files in a directory the
 * test owns; the parent only waits for each child to exit and reads the one
 * JSON report line it prints.
 * @module tests/unit/services/mirror/mirror-process
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

/** A barrier step: create `signal`, then wait until `waitFor` exists (names inside the task's barrier directory). */
export interface BarrierStep {
  signal?: string;
  waitFor?: string;
}

/**
 * Processes that start together: each marks its arrival at `barrier` (a file
 * named `<barrier>-<pid>`), then waits until `processes` have arrived.
 */
export interface Rendezvous {
  barrier: string;
  processes: number;
}

/** A migration the child declares; `log` appends its version to `mig_log`, `add-column` adds `meta.etag`. */
export interface MigrationTask {
  kind: 'add-column' | 'log';
  version: number;
}

/** Open a store (table `items`) at `version` with `migrations`, report how many `up` calls ran. */
export interface OpenTask {
  barriers: string;
  migrations: MigrationTask[];
  path: string;
  /**
   * Runs once, right after the opener's first read of the sync state table's
   * columns returns: its check for the `mode` column, made before it takes the
   * write lock.
   */
  pauseAfterModeCheck?: BarrierStep;
  /**
   * Runs on the first read of the first migration's `version`. The migration
   * runner reads a migration's version only after it has read the stored
   * version, so this pauses the opener between that read and anything it applies.
   */
  pauseAfterVersionRead?: BarrierStep;
  role: 'open';
  /** Created once the open, migrations included, has completed. */
  signalWhenOpen?: string;
  startAfter?: string;
  /** Opens once every process of the rendezvous, this one included, has reached it. */
  startWith?: Rendezvous;
  version: number;
}

/** One page the child's `sync` generator yields; `before` runs before it is yielded. */
export interface PageTask {
  before?: BarrierStep;
  checkpoint: string;
  cursor: string;
  ids: string[];
}

/** Run `defineMirror(...).runSync()` over a store (table `docs`) with the given pages. */
export interface SyncTask {
  barriers: string;
  /** Moves this process's clock forward by this many ms, standing in for time passing. */
  clockOffsetMs?: number;
  /** Runs after the last page is committed, before the generator returns. */
  end?: BarrierStep;
  mode: 'init' | 'refresh';
  pages: PageTask[];
  path: string;
  role: 'sync';
  /** Created once `runSync` has settled, the lease released. */
  signalWhenSettled?: string;
  startAfter?: string;
  syncLeaseTtlMs: number;
  /** Written into each record's `title`, so the store shows which process wrote a row. */
  writer: string;
}

/**
 * Open a handle at `path` and run `sql` through `get()` twice: with a bare
 * `DataView`, then a bare `Uint8Array`, each over the bytes `01 02`, bound
 * after the `leading` values.
 */
export interface BindTask {
  leading: unknown[];
  path: string;
  role: 'bind';
  sql: string;
}

export type MirrorProcessTask = BindTask | OpenTask | SyncTask;

/** What a failed open or sync rejected with. */
export interface ProcessError {
  code?: number;
  data?: unknown;
  message: string;
}

export interface OpenReport {
  error?: ProcessError;
  ok: boolean;
  upCalls: number;
}

export interface SyncReport {
  error?: ProcessError;
  generatorRuns: number;
  ok: boolean;
  result?: { pagesFetched: number; recordsApplied: number; total: number };
}

/** What one `get()` call of a {@link BindTask} returned, or the class and message it threw. */
export type BindOutcome =
  | { ok: true; row: unknown }
  | { error: { message: string; name: string }; ok: false };

export interface BindReport {
  dataView: BindOutcome;
  uint8Array: BindOutcome;
}

type MirrorProcessReport = BindReport | OpenReport | SyncReport;

const CHILD = join(import.meta.dirname, 'mirror-process-child.ts');
const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

export function runMirrorProcess(task: BindTask): Promise<BindReport>;
export function runMirrorProcess(task: OpenTask): Promise<OpenReport>;
export function runMirrorProcess(task: SyncTask): Promise<SyncReport>;
/** Runs `task` in a child process and resolves its report; rejects when the child exits non-zero. */
export function runMirrorProcess(task: MirrorProcessTask): Promise<MirrorProcessReport> {
  const child = spawn(process.execPath, [CHILD, JSON.stringify(task)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      const report = stdout.trim().split('\n').at(-1);
      if (code !== 0 || !report) {
        reject(new Error(`Mirror process (${task.role}) exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(report) as MirrorProcessReport);
    });
  });
}

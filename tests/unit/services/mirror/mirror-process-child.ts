/**
 * @fileoverview Child-process entry for the mirror's multi-process tests. Runs
 * one task (argv[2], JSON; shapes in `mirror-process.ts`) against the
 * framework's own `src/` on the runtime that spawned it, and prints one JSON
 * report line. Barriers are files in the task's directory: a step signals by
 * creating one and waits by polling for one, synchronously where the wait sits
 * inside a synchronous driver call.
 *
 * Bun runs `src/` as it is. Node's built-in type stripping rejects the `enum`s
 * `src/` declares, so under Node the child first registers module hooks that
 * resolve `@/` and `.js` specifiers to `src/**\/*.ts` and transpile those files.
 * @module tests/unit/services/mirror/mirror-process-child
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type { Migration, SyncPage } from '@/services/mirror/types.js';
import type {
  BarrierStep,
  MigrationTask,
  MirrorProcessTask,
  OpenReport,
  OpenTask,
  ProcessError,
  Rendezvous,
  SyncReport,
  SyncTask,
} from './mirror-process.js';

/** How long any one barrier wait may take before the child gives up and fails. */
const BARRIER_DEADLINE_MS = 20_000;
const POLL_MS = 5;

const SRC = pathToFileURL(join(import.meta.dirname, '..', '..', '..', '..', 'src', '/')).href;

async function registerSourceHooks(): Promise<void> {
  const { registerHooks } = await import('node:module');
  const ts = (await import('typescript-v6')).default;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const target = specifier.startsWith('@/') ? SRC + specifier.slice(2) : specifier;
      if (target.endsWith('.js') && (target.startsWith('file:') || target.startsWith('.'))) {
        const source = new URL(target.replace(/\.js$/, '.ts'), context.parentURL);
        if (existsSync(source)) return nextResolve(source.href, context);
      }
      return nextResolve(target, context);
    },
    load(url, context, nextLoad) {
      if (!url.startsWith(SRC) || !url.endsWith('.ts')) return nextLoad(url, context);
      const { outputText } = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          verbatimModuleSyntax: true,
        },
      });
      return { format: 'module', source: outputText, shortCircuit: true };
    },
  });
}

if (!process.versions.bun) await registerSourceHooks();

const { defineMirror } = await import('@/services/mirror/core/defineMirror.js');
const { sqliteMirrorStore } = await import('@/services/mirror/sqlite/sqliteMirrorStore.js');

const task = JSON.parse(process.argv[2] ?? '') as MirrorProcessTask;
const cell = new Int32Array(new SharedArrayBuffer(4));

function signal(name: string | undefined): void {
  if (name) writeFileSync(join(task.barriers, name), '');
}

/** Blocks the thread until barrier `name` exists — for waits inside synchronous driver calls. */
function waitSync(name: string | undefined): void {
  if (!name) return;
  const deadline = performance.now() + BARRIER_DEADLINE_MS;
  while (!existsSync(join(task.barriers, name))) {
    if (performance.now() > deadline) throw new Error(`Barrier "${name}" never opened.`);
    Atomics.wait(cell, 0, 0, POLL_MS);
  }
}

/** Waits for barrier `name` without blocking the event loop, so timers keep firing. */
async function waitAsync(name: string | undefined): Promise<void> {
  if (!name) return;
  const deadline = performance.now() + BARRIER_DEADLINE_MS;
  while (!existsSync(join(task.barriers, name))) {
    if (performance.now() > deadline) throw new Error(`Barrier "${name}" never opened.`);
    await delay(POLL_MS);
  }
}

async function step(barrier: BarrierStep | undefined): Promise<void> {
  signal(barrier?.signal);
  await waitAsync(barrier?.waitFor);
}

/** Marks this process's arrival at the rendezvous, then waits until every expected process has arrived. */
async function rendezvous(meet: Rendezvous | undefined): Promise<void> {
  if (!meet) return;
  signal(`${meet.barrier}-${process.pid}`);
  const arrived = () =>
    readdirSync(task.barriers).filter((name) => name.startsWith(`${meet.barrier}-`)).length;
  const deadline = performance.now() + BARRIER_DEADLINE_MS;
  while (arrived() < meet.processes) {
    if (performance.now() > deadline) throw new Error(`Rendezvous "${meet.barrier}" never filled.`);
    await delay(POLL_MS);
  }
}

function describeError(err: unknown): ProcessError {
  if (!(err instanceof Error)) return { message: String(err) };
  const { code, data } = err as { code?: number; data?: unknown };
  return {
    message: err.message,
    ...(code !== undefined && { code }),
    ...(data !== undefined && { data }),
  };
}

function migrationFor(spec: MigrationTask, onUp: () => void): Migration {
  return {
    version: spec.version,
    up(handle) {
      onUp();
      if (spec.kind === 'log') {
        handle.exec('CREATE TABLE IF NOT EXISTS mig_log (version INTEGER NOT NULL)');
        handle.prepare('INSERT INTO mig_log (version) VALUES (?)').run(spec.version);
      } else {
        handle.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT)');
        handle.exec('ALTER TABLE meta ADD COLUMN etag TEXT');
      }
    },
  };
}

/** Variable specifiers, as `src/` loads the drivers, so `tsc` resolves neither. */
const BUN_SQLITE: string = 'bun:sqlite';
const BETTER_SQLITE3: string = 'better-sqlite3';

interface DriverStatement {
  get(...params: unknown[]): unknown;
}
interface DriverPrototype {
  prepare(this: unknown, sql: string, ...rest: unknown[]): DriverStatement;
}

/**
 * Runs `pause` once, right after the first read of the sync state table's
 * columns returns. The store makes that read through the runtime's driver, and
 * the driver's `prepare` is the one seam below the store, so this wraps it.
 */
async function pauseAfterModeCheck(pause: BarrierStep): Promise<void> {
  const driver: { prototype: DriverPrototype } = process.versions.bun
    ? (await import(BUN_SQLITE)).Database
    : (await import(BETTER_SQLITE3)).default;
  const prepare = driver.prototype.prepare;
  let paused = false;
  driver.prototype.prepare = function (sql, ...rest) {
    const statement = prepare.call(this, sql, ...rest);
    if (paused || !sql.includes('table_info') || !sql.includes('mirror_sync_state')) {
      return statement;
    }
    const get = statement.get.bind(statement);
    statement.get = (...params) => {
      const row = get(...params);
      if (!paused) {
        paused = true;
        signal(pause.signal);
        waitSync(pause.waitFor);
      }
      return row;
    };
    return statement;
  };
}

/** `migration` with `pause` run on the first read of its `version`. */
function pausedAtVersionRead(migration: Migration, pause: BarrierStep): Migration {
  let paused = false;
  return {
    up: migration.up,
    get version() {
      if (!paused) {
        paused = true;
        signal(pause.signal);
        waitSync(pause.waitFor);
      }
      return migration.version;
    },
  };
}

async function openStore(open: OpenTask): Promise<OpenReport> {
  await waitAsync(open.startAfter);
  await rendezvous(open.startWith);
  if (open.pauseAfterModeCheck) await pauseAfterModeCheck(open.pauseAfterModeCheck);
  let upCalls = 0;
  const migrations = open.migrations.map((spec, index) => {
    const migration = migrationFor(spec, () => {
      upCalls += 1;
    });
    return index === 0 && open.pauseAfterVersionRead
      ? pausedAtVersionRead(migration, open.pauseAfterVersionRead)
      : migration;
  });
  const store = sqliteMirrorStore({
    path: open.path,
    table: 'items',
    primaryKey: 'id',
    columns: { id: 'TEXT' },
    version: open.version,
    migrations,
  });
  try {
    await store.count();
    signal(open.signalWhenOpen);
    return { ok: true, upCalls };
  } catch (err) {
    return { ok: false, upCalls, error: describeError(err) };
  } finally {
    await store.close();
  }
}

async function runSyncTask(run: SyncTask): Promise<SyncReport> {
  await waitAsync(run.startAfter);
  if (run.clockOffsetMs) {
    const realNow = Date.now.bind(Date);
    const offset = run.clockOffsetMs;
    Date.now = () => realNow() + offset;
  }
  let generatorRuns = 0;
  const mirror = defineMirror({
    name: 'process-mirror',
    logger: {},
    syncLeaseTtlMs: run.syncLeaseTtlMs,
    store: sqliteMirrorStore({
      path: run.path,
      table: 'docs',
      primaryKey: 'id',
      columns: { id: 'TEXT', title: 'TEXT', stamp: 'TEXT' },
    }),
    async *sync(): AsyncGenerator<SyncPage> {
      generatorRuns += 1;
      for (const page of run.pages) {
        await step(page.before);
        yield {
          records: page.ids.map((id) => ({ id, title: run.writer, stamp: page.checkpoint })),
          cursor: page.cursor,
          checkpoint: page.checkpoint,
        };
      }
      await step(run.end);
    },
  });
  try {
    const { pagesFetched, recordsApplied, total } = await mirror.runSync({ mode: run.mode });
    return { ok: true, generatorRuns, result: { pagesFetched, recordsApplied, total } };
  } catch (err) {
    return { ok: false, generatorRuns, error: describeError(err) };
  } finally {
    await mirror.close();
    signal(run.signalWhenSettled);
  }
}

const report = task.role === 'open' ? await openStore(task) : await runSyncTask(task);
process.stdout.write(`${JSON.stringify(report)}\n`);

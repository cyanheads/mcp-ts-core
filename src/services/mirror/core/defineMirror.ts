/**
 * @fileoverview `defineMirror` — assembles a {@link MirrorStore}, a server's
 * `sync` generator, and the runner into a single owned mirror instance. The
 * returned object is what a server holds (one per mirror) and exposes to its
 * tools: `runSync`, `query`, `status`/`ready`, `getByIds`, and the raw handle.
 * @module services/mirror/core/defineMirror
 */

import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import type {
  MirrorDefinition,
  MirrorLogger,
  MirrorRow,
  MirrorStatus,
  MirrorStore,
  QueryOptions,
  QueryResult,
  RunSyncOptions,
  SqliteHandle,
  SyncResult,
} from '../types.js';
import { runSync as runSyncCore } from './runner.js';

/** Options for a single {@link Mirror.runSync} call. */
export type MirrorRunOptions = RunSyncOptions & {
  /** Cancels the run; the runner persists state before stopping. Defaults to a never-aborting signal. */
  signal?: AbortSignal;
};

/** An owned mirror instance — the return value of {@link defineMirror}. */
export interface Mirror {
  /** Close the underlying store. */
  close(): Promise<void>;
  /** Fetch records by primary-key list, preserving input order. */
  getByIds(ids: string[]): Promise<MirrorRow[]>;
  /** Stable name from the definition. */
  readonly name: string;
  /** Generic flat query over the mirror. */
  query(options: QueryOptions): Promise<QueryResult>;
  /** The opened runtime-agnostic handle for server-specific access paths. */
  raw(): Promise<SqliteHandle>;
  /** `true` once a full sync has ever completed (queryable even mid-refresh). */
  ready(): Promise<boolean>;
  /** Run a full (`init`) or incremental (`refresh`) sync. */
  runSync(options: MirrorRunOptions): Promise<SyncResult>;
  /** Current sync status, including the durable `ready` marker. */
  status(): Promise<MirrorStatus>;
  /** The backing store (escape hatch for advanced use). */
  readonly store: MirrorStore;
}

/**
 * Forwards sync logs to the framework logger when the definition supplies none.
 * Sync runs outside the request pipeline, so each call wraps `meta` in a fresh
 * `RequestContext` (the shape the framework logger expects); `error` takes a
 * `RequestContext` in the no-Error overload.
 */
const defaultLogger: MirrorLogger = {
  debug: (message, meta) => logger.debug(message, ctxFrom(meta)),
  info: (message, meta) => logger.info(message, ctxFrom(meta)),
  notice: (message, meta) => logger.notice(message, ctxFrom(meta)),
  warning: (message, meta) => logger.warning(message, ctxFrom(meta)),
  error: (message, meta) => logger.error(message, ctxFrom(meta)),
};

function ctxFrom(meta?: object) {
  return requestContextService.createRequestContext({
    operation: 'mirror.sync',
    ...(meta ?? {}),
  });
}

/**
 * Assemble a mirror from a store, a `sync` generator, and a name. Nothing opens
 * until the first call; construction is cheap and side-effect-free.
 *
 * @example
 * ```ts
 * const papers = defineMirror({
 *   name: 'arxiv-papers',
 *   store: sqliteMirrorStore({
 *     path: config.mirrorPath,
 *     primaryKey: 'id',
 *     columns: { id: 'TEXT', title: 'TEXT', abstract: 'TEXT', updated: 'TEXT' },
 *     fts: ['title', 'abstract'],
 *     indexes: [{ columns: ['updated'] }],
 *   }),
 *   async *sync({ mode, cursor, checkpoint, signal }) {
 *     for await (const page of harvest({ cursor, since: checkpoint, signal })) {
 *       yield { records: page.rows, cursor: page.token, checkpoint: page.maxStamp };
 *     }
 *   },
 * });
 *
 * await papers.runSync({ mode: 'init', signal: AbortSignal.timeout(3_600_000) });
 * const { rows, total } = await papers.query({ match: 'transformers', limit: 10, offset: 0 });
 * ```
 */
export function defineMirror(definition: MirrorDefinition): Mirror {
  const { name, store, sync } = definition;
  const log = definition.logger ?? defaultLogger;

  return {
    name,
    store,

    runSync(options: MirrorRunOptions): Promise<SyncResult> {
      const signal = options.signal ?? new AbortController().signal;
      const runOptions: RunSyncOptions = {
        mode: options.mode,
        ...(options.onProgress && { onProgress: options.onProgress }),
      };
      return runSyncCore(store, sync, { log, signal }, runOptions);
    },

    query(options: QueryOptions): Promise<QueryResult> {
      return store.query(options);
    },

    getByIds(ids: string[]): Promise<MirrorRow[]> {
      return store.getByIds(ids);
    },

    async status(): Promise<MirrorStatus> {
      const state = await store.readState();
      return {
        status: state.status,
        ready: state.completedAt != null,
        ...(state.checkpoint !== undefined && { checkpoint: state.checkpoint }),
        ...(state.total !== undefined && { total: state.total }),
        ...(state.startedAt !== undefined && { startedAt: state.startedAt }),
        ...(state.completedAt !== undefined && { completedAt: state.completedAt }),
        ...(state.error !== undefined && { error: state.error }),
      };
    },

    async ready(): Promise<boolean> {
      return (await store.readState()).completedAt != null;
    },

    raw(): Promise<SqliteHandle> {
      return store.raw();
    },

    close(): Promise<void> {
      return store.close();
    },
  };
}

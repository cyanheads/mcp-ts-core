/**
 * @fileoverview Embedded-SQLite implementation of {@link MirrorStore}. Owns the
 * primary table, optional FTS5 index, the `mirror_sync_state` row, schema
 * versioning + migration runner, generic flat queries, and the raw-handle
 * escape hatch. Lazy-opens on first use (memoized) and is then backed by
 * synchronous driver calls.
 * @module services/mirror/sqlite/sqliteMirrorStore
 */

import { databaseError, validationError } from '@/types-global/errors.js';
import type {
  FilterOp,
  Migration,
  MirrorRow,
  MirrorStore,
  QueryFilter,
  QueryOptions,
  QueryResult,
  SqlValue,
  SyncState,
} from '../types.js';
import { type OpenHandleOptions, openSqliteHandle, type SqliteHandle } from './handle.js';
import { buildSchemaSql, type SchemaSpec, validateSchemaSpec } from './schema.js';

/** Configuration for {@link sqliteMirrorStore}. */
export interface SqliteMirrorStoreSpec extends SchemaSpec {
  /** `PRAGMA busy_timeout` in ms. Default 5000. */
  busyTimeoutMs?: number;
  /** Migrations applied in order when the stored version is lower than `version`. */
  migrations?: Migration[];
  /** Filesystem path to the SQLite database (created if absent). */
  path: string;
  /** Current schema version. Default 1. */
  version?: number;
}

const SQL_OP: Record<Exclude<FilterOp, 'in'>, string> = {
  eq: '=',
  ne: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

/** Internal handle to an opened store plus its derived metadata. */
interface OpenStore {
  allColumns: string[];
  handle: SqliteHandle;
  hasFts: boolean;
}

/**
 * Create a SQLite-backed {@link MirrorStore} from a declarative spec. The store
 * is not opened until the first method call.
 */
export function sqliteMirrorStore(spec: SqliteMirrorStoreSpec): MirrorStore {
  // Fail fast on a malformed spec at construction time, not first query.
  const { ftsColumns } = validateSchemaSpec(spec);
  const allColumns = Object.keys(spec.columns);
  const ftsTable = `${spec.table}_fts`;

  let opened: OpenStore | undefined;
  let opening: Promise<OpenStore> | undefined;

  function open(): Promise<OpenStore> {
    if (opened) return Promise.resolve(opened);
    opening ??= (async () => {
      const handleOptions: OpenHandleOptions = {
        ...(spec.busyTimeoutMs !== undefined && { busyTimeoutMs: spec.busyTimeoutMs }),
      };
      const handle = await openSqliteHandle(spec.path, handleOptions);
      try {
        handle.exec(buildSchemaSql(spec));
        runMigrations(handle, spec.version ?? 1, spec.migrations ?? []);
      } catch (err) {
        handle.close();
        throw databaseError(
          `Failed to initialize mirror store at ${spec.path}`,
          { path: spec.path },
          { cause: err },
        );
      }
      opened = { handle, allColumns, hasFts: ftsColumns.length > 0 };
      return opened;
    })();
    return opening;
  }

  function assertColumn(column: string, role: string): void {
    if (!allColumns.includes(column)) {
      throw validationError(`Unknown mirror ${role} column "${column}".`, {
        column,
        columns: allColumns,
      });
    }
  }

  return {
    async applyBatch(records: MirrorRow[], tombstones: string[]): Promise<void> {
      if (records.length === 0 && tombstones.length === 0) return;
      const { handle } = await open();
      const cols = allColumns;
      const placeholders = cols.map(() => '?').join(', ');
      const updates = cols
        .filter((c) => c !== spec.primaryKey)
        .map((c) => `${c} = excluded.${c}`)
        .join(', ');
      // No non-PK columns → a bare PK table; ON CONFLICT DO NOTHING keeps upsert idempotent.
      const conflict = updates
        ? `ON CONFLICT(${spec.primaryKey}) DO UPDATE SET ${updates}`
        : `ON CONFLICT(${spec.primaryKey}) DO NOTHING`;
      const upsert = handle.prepare(
        `INSERT INTO ${spec.table}(${cols.join(', ')}) VALUES (${placeholders}) ${conflict}`,
      );
      const remove = handle.prepare(`DELETE FROM ${spec.table} WHERE ${spec.primaryKey} = ?`);
      handle.transaction(() => {
        for (const record of records) {
          upsert.run(...cols.map((c) => record[c] ?? null));
        }
        for (const id of tombstones) remove.run(id);
      });
    },

    async query(options: QueryOptions): Promise<QueryResult> {
      const store = await open();
      if (options.match && !store.hasFts) {
        throw validationError('This mirror has no FTS index; `match` is not supported.', {
          table: spec.table,
        });
      }
      for (const f of options.filters ?? []) assertColumn(f.column, 'filter');
      if (options.sort && options.sort !== 'relevance') assertColumn(options.sort.column, 'sort');

      const { handle } = store;
      const { clauses: filterClauses, params: filterParams } = buildFilterClauses(
        options.filters ?? [],
      );
      const relevance = options.sort === 'relevance' && Boolean(options.match);

      // COUNT never needs bm25, so the FTS predicate is always the rowid
      // subquery form — no join, no ordering.
      const countClauses = [...filterClauses];
      const countParams = [...filterParams];
      if (options.match) {
        countClauses.unshift(
          `${spec.table}.rowid IN (SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH ?)`,
        );
        countParams.unshift(options.match);
      }
      const countWhere = countClauses.length > 0 ? `WHERE ${countClauses.join(' AND ')}` : '';
      const total =
        handle
          .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${spec.table} ${countWhere}`)
          .get(...countParams)?.n ?? 0;

      // Row fetch. For relevance sort, apply MATCH on the JOINed FTS table so
      // `bm25()` is scored in that MATCH's context; the subquery form leaves
      // bm25 with no query to score against. Other sorts keep the subquery form
      // (no join needed). `ORDER BY` columns are table-qualified to avoid a
      // `rowid` ambiguity once the FTS table is joined in.
      const rowClauses = [...filterClauses];
      const rowParams = [...filterParams];
      let join = '';
      if (options.match) {
        if (relevance) {
          join = `JOIN ${ftsTable} ON ${spec.table}.rowid = ${ftsTable}.rowid`;
          rowClauses.unshift(`${ftsTable} MATCH ?`);
        } else {
          rowClauses.unshift(
            `${spec.table}.rowid IN (SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH ?)`,
          );
        }
        rowParams.unshift(options.match);
      }
      const rowWhere = rowClauses.length > 0 ? `WHERE ${rowClauses.join(' AND ')}` : '';
      const selectCols = store.allColumns.map((c) => `${spec.table}.${c}`).join(', ');
      const orderBy = relevance
        ? `ORDER BY bm25(${ftsTable}) ASC`
        : buildOrderBy(options.sort, spec.table);

      const rows = handle
        .prepare<MirrorRow>(
          `SELECT ${selectCols} FROM ${spec.table} ${join} ${rowWhere} ${orderBy} LIMIT ? OFFSET ?`,
        )
        .all(...rowParams, options.limit, options.offset);
      return { rows, total };
    },

    async getByIds(ids: string[]): Promise<MirrorRow[]> {
      if (ids.length === 0) return [];
      const { handle } = await open();
      const placeholders = ids.map(() => '?').join(', ');
      const rows = handle
        .prepare<MirrorRow>(
          `SELECT ${allColumns.join(', ')} FROM ${spec.table} WHERE ${spec.primaryKey} IN (${placeholders})`,
        )
        .all(...ids);
      const byId = new Map(rows.map((r) => [r[spec.primaryKey], r]));
      return ids.map((id) => byId.get(id)).filter((r): r is MirrorRow => r !== undefined);
    },

    async count(): Promise<number> {
      const { handle } = await open();
      const row = handle.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${spec.table}`).get();
      return row?.n ?? 0;
    },

    async readState(): Promise<SyncState> {
      const { handle } = await open();
      return readSyncState(handle);
    },

    async writeState(state: SyncState): Promise<void> {
      const { handle } = await open();
      writeSyncState(handle, state);
    },

    async raw(): Promise<SqliteHandle> {
      return (await open()).handle;
    },

    async integrityCheck(): Promise<{ ok: boolean; results: string[] }> {
      const { handle } = await open();
      const integrity = handle.prepare<{ integrity_check: string }>(`PRAGMA integrity_check`).all();
      const quick = handle.prepare<{ quick_check: string }>(`PRAGMA quick_check`).all();
      const results = [
        ...integrity.map((r) => `integrity_check: ${r.integrity_check}`),
        ...quick.map((r) => `quick_check: ${r.quick_check}`),
      ];
      return { ok: results.every((r) => r.endsWith('ok')), results };
    },

    close(): Promise<void> {
      if (opened) {
        opened.handle.close();
        opened = undefined;
        opening = undefined;
      }
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

function buildFilterClauses(filters: QueryFilter[]): { clauses: string[]; params: SqlValue[] } {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  for (const f of filters) {
    if (f.op === 'in') {
      const values = Array.isArray(f.value) ? f.value : [f.value];
      if (values.length === 0) {
        clauses.push('0'); // empty IN matches nothing
        continue;
      }
      clauses.push(`${f.column} IN (${values.map(() => '?').join(', ')})`);
      params.push(...values);
      continue;
    }
    clauses.push(`${f.column} ${SQL_OP[f.op]} ?`);
    params.push(Array.isArray(f.value) ? (f.value[0] ?? null) : f.value);
  }
  return { clauses, params };
}

function buildOrderBy(sort: QueryOptions['sort'], table: string): string {
  if (sort && sort !== 'relevance') {
    return `ORDER BY ${table}.${sort.column} ${sort.direction === 'asc' ? 'ASC' : 'DESC'}`;
  }
  return `ORDER BY ${table}.rowid ASC`;
}

// ---------------------------------------------------------------------------
// Sync state
// ---------------------------------------------------------------------------

interface SyncStateRow {
  checkpoint: string | null;
  completed_at: string | null;
  cursor: string | null;
  error: string | null;
  started_at: string | null;
  status: string;
  total: number | null;
}

function readSyncState(handle: SqliteHandle): SyncState {
  const row = handle
    .prepare<SyncStateRow>(
      `SELECT status, cursor, checkpoint, started_at, completed_at, total, error
       FROM mirror_sync_state WHERE id = 1`,
    )
    .get();
  if (!row) return { status: 'pending' };
  return {
    status: row.status as SyncState['status'],
    ...(row.cursor != null && { cursor: row.cursor }),
    ...(row.checkpoint != null && { checkpoint: row.checkpoint }),
    ...(row.started_at != null && { startedAt: row.started_at }),
    ...(row.completed_at != null && { completedAt: row.completed_at }),
    ...(row.total != null && { total: row.total }),
    ...(row.error != null && { error: row.error }),
  };
}

/**
 * Persist sync state. `completed_at` and `total` are durable "last successful
 * sync" markers — preserved via COALESCE when a write omits them — so an
 * in-progress or failed refresh on top of a complete mirror keeps the
 * completion marker that readiness keys off. Every other column is
 * current-run progress, overwritten on each write.
 */
function writeSyncState(handle: SqliteHandle, state: SyncState): void {
  handle
    .prepare(
      `UPDATE mirror_sync_state
       SET status = ?, cursor = ?, checkpoint = ?, started_at = ?,
           completed_at = COALESCE(?, completed_at),
           total = COALESCE(?, total),
           error = ?
       WHERE id = 1`,
    )
    .run(
      state.status,
      state.cursor ?? null,
      state.checkpoint ?? null,
      state.startedAt ?? null,
      state.completedAt ?? null,
      state.total ?? null,
      state.error ?? null,
    );
}

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

/**
 * Apply pending migrations. A brand-new database (no `schema_version` row) was
 * just built at the current schema by the DDL, so it is stamped to `target`
 * without running migrations (there is no older data to transform). An existing
 * database at a lower version runs each migration with `stored < version <=
 * target`, in order, stamping the version after each.
 */
function runMigrations(handle: SqliteHandle, target: number, migrations: Migration[]): void {
  const stored =
    handle.prepare<{ version: number }>(`SELECT MAX(version) AS version FROM schema_version`).get()
      ?.version ?? 0;

  if (stored === 0) {
    stampVersion(handle, target);
    return;
  }
  if (stored >= target) return;

  const pending = migrations
    .filter((m) => m.version > stored && m.version <= target)
    .sort((a, b) => a.version - b.version);
  for (const m of pending) {
    handle.transaction(() => {
      m.up(handle);
    });
    stampVersion(handle, m.version);
  }
  stampVersion(handle, target);
}

function stampVersion(handle: SqliteHandle, version: number): void {
  handle.transaction(() => {
    handle.prepare(`DELETE FROM schema_version`).run();
    handle
      .prepare(`INSERT INTO schema_version(version, applied_at) VALUES (?, ?)`)
      .run(version, new Date().toISOString());
  });
}

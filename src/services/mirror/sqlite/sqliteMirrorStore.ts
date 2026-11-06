/**
 * @fileoverview Embedded-SQLite implementation of {@link MirrorStore}. Owns the
 * primary table, optional FTS5 index, the `mirror_sync_state` row, the
 * cross-process sync lease (`mirror_sync_lease`), schema versioning + migration
 * runner, generic flat queries, and the raw-handle escape hatch. Lazy-opens on
 * first use (memoized) and is then backed by synchronous driver calls.
 * @module services/mirror/sqlite/sqliteMirrorStore
 */

import { basename } from 'node:path';
import { databaseError, type McpError, validationError } from '@/types-global/errors.js';
import type {
  FilterOp,
  Migration,
  MirrorRow,
  MirrorStore,
  QueryFilter,
  QueryOptions,
  QueryResult,
  SqlValue,
  SyncLease,
  SyncLeaseStore,
  SyncMode,
  SyncState,
} from '../types.js';
import {
  isBusy,
  MIRROR_STORE_UNAVAILABLE_HINT,
  type OpenHandleOptions,
  openSqliteHandle,
  type SqliteHandle,
} from './handle.js';
import { buildSchemaSql, type SchemaSpec, validateSchemaSpec } from './schema.js';

/**
 * Opt-in ceilings on {@link MirrorStore.query} and {@link MirrorStore.getByIds}.
 * Every field is unbounded unless the spec sets it — declare the ones that
 * matter on a store whose read shape a client can influence, and leave the rest
 * open for server-driven bulk reads.
 */
export interface SqliteMirrorStoreLimits {
  /** Maximum number of filters on one query. Unbounded when omitted. */
  filters?: number;
  /** Maximum bound values across all filters, counting each `in` element. Unbounded when omitted. */
  filterValues?: number;
  /** Maximum `ids` accepted by `getByIds`. Unbounded when omitted. */
  getByIds?: number;
  /** Maximum `limit` on one query. Unbounded when omitted. */
  limit?: number;
  /** Maximum `offset` on one query. Unbounded when omitted. */
  offset?: number;
}

/** Configuration for {@link sqliteMirrorStore}. */
export interface SqliteMirrorStoreSpec extends SchemaSpec {
  /**
   * How long, in ms, a statement waits on another connection's lock
   * (`PRAGMA busy_timeout`). It bounds the store's open too: the open retries
   * the switch to WAL under another connection's lock until this much time has
   * passed. Default 5000.
   */
  busyTimeoutMs?: number;
  /** Query and batch ceilings. Omitted fields stay unbounded. */
  limits?: SqliteMirrorStoreLimits;
  /** Migrations applied in order when the stored version is lower than `version`. */
  migrations?: Migration[];
  /** Filesystem path to the SQLite database (created if absent). */
  path: string;
  /** Current schema version. Default 1. */
  version?: number;
}

/**
 * The SQL operator of each scalar filter op. A Map, so an op a caller names
 * after an `Object.prototype` member (`toString`, `__proto__`) finds nothing.
 */
const SQL_OP: ReadonlyMap<string, string> = new Map(
  Object.entries({
    eq: '=',
    ne: '!=',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
  } satisfies Record<Exclude<FilterOp, 'in'>, string>),
);

/** Every filter op a query accepts. */
const FILTER_OPS = [...SQL_OP.keys(), 'in'];

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
  const realColumns = new Set(
    Object.entries(spec.columns)
      .filter(([, decl]) => hasRealAffinity(decl))
      .map(([name]) => name),
  );
  const ftsTable = `${spec.table}_fts`;
  const limits: SqliteMirrorStoreLimits = spec.limits ?? {};

  let opened: OpenStore | undefined;
  let opening: Promise<OpenStore> | undefined;
  let closing: Promise<void> | undefined;

  function open(): Promise<OpenStore> {
    if (closing) return closing.then(open);
    if (opened) return Promise.resolve(opened);
    if (opening) return opening;

    const attempt = (async () => {
      const handleOptions: OpenHandleOptions = {
        ...(spec.busyTimeoutMs !== undefined && { busyTimeoutMs: spec.busyTimeoutMs }),
      };
      const handle = await openSqliteHandle(spec.path, handleOptions);
      try {
        handle.exec(buildSchemaSql(spec));
        addSyncStateMode(handle);
        runMigrations(handle, spec.version ?? 1, spec.migrations ?? []);
      } catch (err) {
        handle.close();
        throw databaseError(
          `Failed to initialize mirror store "${basename(spec.path)}".`,
          { recovery: { hint: MIRROR_STORE_UNAVAILABLE_HINT } },
          { cause: err },
        );
      }
      opened = { handle, allColumns, hasFts: ftsColumns.length > 0 };
      return opened;
    })();
    opening = attempt;
    void attempt.catch(() => {
      if (opening === attempt) opening = undefined;
    });
    return attempt;
  }

  function assertColumn(column: string, role: string): void {
    if (!allColumns.includes(column)) {
      throw validationError(`Unknown mirror ${role} column "${column}".`, {
        column,
        columns: allColumns,
      });
    }
  }

  /** Upsert `records` and delete `tombstones`. Runs inside the caller's transaction. */
  function writeBatch(handle: SqliteHandle, records: MirrorRow[], tombstones: string[]): void {
    if (records.length === 0 && tombstones.length === 0) return;
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
    // The position in an error is looked up only on the failure path.
    for (const record of records) {
      upsert.run(
        ...cols.map((c) => {
          const value = record[c] ?? null;
          if (isObjectValue(value)) {
            throw objectValueError(value, `records[${records.indexOf(record)}].${c}`);
          }
          return value;
        }),
      );
    }
    for (const id of tombstones) {
      if (isObjectValue(id)) throw objectValueError(id, `tombstones[${tombstones.indexOf(id)}]`);
      remove.run(id);
    }
  }

  const syncLease: SyncLeaseStore = {
    async claim(owner: string, ttlMs: number): Promise<SyncLease | undefined> {
      try {
        const { handle } = await open();
        const now = Date.now();
        // One statement, so the expiry check and the takeover happen under one write lock.
        const claimed = handle
          .prepare<{ generation: number }>(
            `UPDATE mirror_sync_lease SET owner = ?, generation = generation + 1, expires_at = ?
             WHERE id = 1 AND (owner IS NULL OR expires_at <= ?)
             RETURNING generation`,
          )
          .get(owner, now + ttlMs, now);
        return claimed ? { owner, generation: claimed.generation, ttlMs } : undefined;
      } catch (err) {
        /**
         * A write lock held past `busy_timeout`, met by the claim or by the
         * open before it, belongs to a connection writing to the store right
         * now: the store is in use, not unavailable.
         */
        if (isBusy(err) || (err instanceof Error && isBusy(err.cause))) return undefined;
        throw err;
      }
    },

    async commit(
      lease: SyncLease,
      state: SyncState,
      records: MirrorRow[] = [],
      tombstones: string[] = [],
    ): Promise<boolean> {
      const { handle } = await open();
      return handle.transaction(() => {
        const held = handle
          .prepare(`SELECT 1 FROM mirror_sync_lease WHERE id = 1 AND owner = ? AND generation = ?`)
          .get(lease.owner, lease.generation);
        if (!held) return false;
        writeBatch(handle, records, tombstones);
        writeSyncState(handle, state);
        // Last, so the expiry counts from the commit, however long the page took.
        return stampLeaseExpiry(handle, lease);
      }, 'immediate');
    },

    async release(lease: SyncLease): Promise<void> {
      const { handle } = await open();
      handle
        .prepare(
          `UPDATE mirror_sync_lease SET owner = NULL, expires_at = NULL
           WHERE id = 1 AND owner = ? AND generation = ?`,
        )
        .run(lease.owner, lease.generation);
    },

    async renew(lease: SyncLease): Promise<boolean> {
      const { handle } = await open();
      return stampLeaseExpiry(handle, lease);
    },
  };

  const store: MirrorStore = {
    async applyBatch(records: MirrorRow[], tombstones: string[]): Promise<void> {
      if (records.length === 0 && tombstones.length === 0) return;
      const { handle } = await open();
      handle.transaction(() => writeBatch(handle, records, tombstones));
    },

    async query(options: QueryOptions): Promise<QueryResult> {
      validateQueryOptions(options, limits);
      if (isObjectValue(options.match)) throw objectValueError(options.match, 'match');
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
        realColumns,
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
      const countStatement = handle.prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${spec.table} ${countWhere}`,
      );

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

      const rowStatement = handle.prepare<MirrorRow>(
        `SELECT ${selectCols} FROM ${spec.table} ${join} ${rowWhere} ${orderBy} LIMIT ? OFFSET ?`,
      );

      try {
        const total = countStatement.get(...countParams)?.n ?? 0;
        const rows = rowStatement.all(...rowParams, options.limit, options.offset);
        return { rows, total };
      } catch (err) {
        /**
         * FTS5 parses `match` only when a statement steps, and every parse
         * error it raises carries SQLite's generic `SQLITE_ERROR` on both
         * drivers, so with `match` set that exact code here is the caller's
         * expression. The store's own failures are not: a missing FTS table or
         * schema drift fails at `prepare()` above, and corruption, I/O, and busy
         * errors carry other codes (`SQLITE_CORRUPT*`, `SQLITE_IOERR*`,
         * `SQLITE_BUSY*`); those pass through unchanged.
         */
        if (options.match && err instanceof Error && 'code' in err && err.code === 'SQLITE_ERROR') {
          throw validationError(
            `Mirror match is not a valid FTS5 query: ${err.message}.`,
            { field: 'match' },
            { cause: err },
          );
        }
        throw err;
      }
    },

    async getByIds(ids: string[]): Promise<MirrorRow[]> {
      if (limits.getByIds !== undefined && ids.length > limits.getByIds) {
        throw validationError(`Mirror ID list cannot exceed ${limits.getByIds} values.`, {
          count: ids.length,
          max: limits.getByIds,
        });
      }
      const objectAt = ids.findIndex(isObjectValue);
      if (objectAt !== -1) throw objectValueError(ids[objectAt], `ids[${objectAt}]`);
      if (ids.length === 0) return [];
      const { handle } = await open();
      /**
       * SQLite compares each id with the key as `pk = ?` would, so an INTEGER
       * key matches `'1'` and `'01'` alike and a TEXT key matches the number
       * `2024` as `'2024'`: each id is encoded as its bound value is, and the
       * unary `+` drops `json_each`'s BLOB affinity, as a bound parameter has
       * none. `json_each` carries each id's position: a repeated id returns its
       * row each time and a missing one drops out. The whole list binds as one
       * parameter, so its length never meets the driver's bound-variable
       * ceiling. Columns are table-qualified because `json_each` has its own
       * (`id`, `key`, `value`, …), and its alias extends the table name, so the
       * two never collide. A list holding an id JSON cannot carry (bytes, or
       * a bigint outside the signed 64-bit range, which binding refuses) looks
       * each id up on its own, as an `eq` filter on the key would.
       */
      const requested = `${spec.table}_ids`;
      const columns = allColumns.map((c) => `${spec.table}.${c}`).join(', ');
      const idList = jsonList(ids);
      if (idList === undefined) {
        const byId = handle.prepare<MirrorRow>(
          `SELECT ${columns} FROM ${spec.table} WHERE ${spec.primaryKey} = ?`,
        );
        return ids.flatMap((id) => byId.all(id));
      }
      return handle
        .prepare<MirrorRow>(
          `SELECT ${columns} FROM json_each(?) AS ${requested} JOIN ${spec.table} ON ${spec.table}.${spec.primaryKey} = +${requested}.value ORDER BY ${requested}.key`,
        )
        .all(idList);
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

    syncLease,

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
      if (closing) return closing;

      const pendingOpen = opening;
      const active = opened;
      const closeAttempt = (async () => {
        let target = active;
        if (!target && pendingOpen) {
          try {
            target = await pendingOpen;
          } catch {
            // Initialization already closes its handle before rejecting.
            return;
          }
        }

        if (opening === pendingOpen) opening = undefined;
        if (!target) return;
        if (opened === target) opened = undefined;
        target.handle.close();
      })();
      const trackedClose = closeAttempt.finally(() => {
        if (closing === trackedClose) closing = undefined;
      });
      closing = trackedClose;
      return trackedClose;
    },

    /** Alias for {@link close}. Enables `await using store = sqliteMirrorStore(spec)`. */
    async [Symbol.asyncDispose](): Promise<void> {
      await this.close();
    },
  };

  return store;
}

// ---------------------------------------------------------------------------
// Value binding
// ---------------------------------------------------------------------------

/**
 * Whether `value` is an object, array, or `Date`, which the store refuses
 * wherever it binds a value. Bound alone, an object is each driver's
 * named-parameter list, so `bun:sqlite` binds the `?` as NULL (a record passed
 * as a tombstone deletes nothing) while `better-sqlite3` throws; bound beside
 * other values, each driver fails with its own error. Bytes (typed arrays,
 * `DataView`, `ArrayBuffer`, `SharedArrayBuffer`) go to the handle, which
 * binds them as a blob.
 */
function isObjectValue(value: unknown): value is object {
  return (
    typeof value === 'object' &&
    value !== null &&
    !ArrayBuffer.isView(value) &&
    !(value instanceof ArrayBuffer) &&
    !(value instanceof SharedArrayBuffer)
  );
}

/**
 * `values` as one JSON array whose `json_each` values carry the storage class
 * each binds as positionally, or `undefined` when one has no such JSON form:
 * bytes, which JSON cannot carry, and a bigint outside the signed 64-bit range,
 * which binding refuses.
 */
function jsonList(values: readonly unknown[]): string | undefined {
  const elements: string[] = [];
  for (const value of values) {
    const element = jsonElement(value);
    if (element === undefined) return undefined;
    elements.push(element);
  }
  return `[${elements.join(',')}]`;
}

/**
 * The JSON text `json_each` reads back as `value` bound positionally: a safe
 * integer other than `-0`, a boolean, and an in-range bigint as INTEGER digits;
 * any other number through `toExponential()`, which reads back as REAL, with
 * `±Infinity` as `±9e999` and `NaN` as null. A string is made well-formed
 * first, since both drivers bind a lone surrogate as U+FFFD, where JSON's
 * `\ud800` escape would decode to the surrogate's own bytes.
 */
function jsonElement(value: unknown): string | undefined {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value.toWellFormed());
    case 'number':
      if (Number.isSafeInteger(value) && !Object.is(value, -0)) return String(value);
      if (Number.isNaN(value)) return 'null';
      if (!Number.isFinite(value)) return value > 0 ? '9e999' : '-9e999';
      return value.toExponential();
    case 'boolean':
      return value ? '1' : '0';
    case 'bigint':
      return BigInt.asIntN(64, value) === value ? String(value) : undefined;
    case 'undefined':
      return 'null';
    default:
      return value === null ? 'null' : undefined;
  }
}

/** The refusal of an {@link isObjectValue} value at `field`, naming its kind without echoing it. */
function objectValueError(value: unknown, field: string): McpError {
  const kind = Array.isArray(value) ? 'an array' : value instanceof Date ? 'a Date' : 'an object';
  return validationError(`Mirror ${field} is ${kind}; it must be a string, a number, or null.`, {
    field,
  });
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

/**
 * Reject a query SQLite cannot execute meaningfully, and enforce whichever
 * ceilings the spec declared. Pagination shape is always checked — a fractional
 * or negative `limit`/`offset` is a caller bug, not a workload choice — while
 * cardinality is bounded only where {@link SqliteMirrorStoreLimits} says so.
 */
function validateQueryOptions(options: QueryOptions, limits: SqliteMirrorStoreLimits): void {
  const { limit: maxLimit, offset: maxOffset, filters: maxFilters, filterValues } = limits;

  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    (maxLimit !== undefined && options.limit > maxLimit)
  ) {
    throw validationError(
      maxLimit === undefined
        ? 'Mirror query limit must be an integer of at least 1.'
        : `Mirror query limit must be an integer from 1 to ${maxLimit}.`,
      { limit: options.limit, ...(maxLimit !== undefined && { max: maxLimit }) },
    );
  }
  if (
    !Number.isSafeInteger(options.offset) ||
    options.offset < 0 ||
    (maxOffset !== undefined && options.offset > maxOffset)
  ) {
    throw validationError(
      maxOffset === undefined
        ? 'Mirror query offset must be an integer of at least 0.'
        : `Mirror query offset must be an integer from 0 to ${maxOffset}.`,
      { offset: options.offset, ...(maxOffset !== undefined && { max: maxOffset }) },
    );
  }

  const filters = options.filters ?? [];
  if (maxFilters !== undefined && filters.length > maxFilters) {
    throw validationError(`Mirror query cannot exceed ${maxFilters} filters.`, {
      count: filters.length,
      max: maxFilters,
    });
  }
  for (const [i, { op, value }] of filters.entries()) {
    if (op === 'in') continue;
    if (!SQL_OP.has(op)) {
      const named = typeof op === 'string' ? ` ${JSON.stringify(op)}` : '';
      throw validationError(
        `Unknown mirror filter operator${named} at filters[${i}].op; use one of ${FILTER_OPS.join(', ')}.`,
        { field: `filters[${i}].op`, operators: FILTER_OPS },
      );
    }
    if (Array.isArray(value)) {
      throw validationError(
        `Mirror filters[${i}].value is an array; the ${op} operator takes a string, a number, or null, and only in takes a list.`,
        { field: `filters[${i}].value` },
      );
    }
  }

  const { sort } = options;
  if (sort && sort !== 'relevance' && sort.direction !== 'asc' && sort.direction !== 'desc') {
    throw validationError('Mirror sort.direction must be "asc" or "desc".', {
      field: 'sort.direction',
    });
  }

  if (filterValues === undefined) return;
  const filterValueCount = filters.reduce((count, filter) => {
    if (filter.op !== 'in') return count + 1;
    return count + (Array.isArray(filter.value) ? filter.value.length : 1);
  }, 0);
  if (filterValueCount > filterValues) {
    throw validationError(`Mirror query filters cannot exceed ${filterValues} bound values.`, {
      count: filterValueCount,
      max: filterValues,
    });
  }
}

/**
 * The `WHERE` terms and parameters of `filters`. An `in` list binds as one
 * parameter however long it is, read back through `json_each`, so it never
 * meets the driver's bound-parameter ceiling. Its unary `+` drops `json_each`'s
 * BLOB affinity, as a bound parameter has none, so the column's own affinity
 * applies to each value: a `TEXT` column matches `2024` as `'2024'`. On a
 * `REAL` column (`realColumns`) that subquery would convert each value to REAL
 * before comparing, rounding an integer past 2^53 (a bigint, or text such as
 * `'9007199254740993'`) onto a stored double a bound parameter never equals;
 * plain `value` compares there as a bound parameter does. A list holding a
 * value with no JSON form keeps one parameter per value.
 */
function buildFilterClauses(
  filters: QueryFilter[],
  realColumns: ReadonlySet<string>,
): { clauses: string[]; params: SqlValue[] } {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  for (const [i, f] of filters.entries()) {
    // Where a refused value sat: an element of an array `value`, or `value` itself.
    const at = (j: number) =>
      Array.isArray(f.value) ? `filters[${i}].value[${j}]` : `filters[${i}].value`;
    if (f.op === 'in') {
      const values = Array.isArray(f.value) ? f.value : [f.value];
      if (values.length === 0) {
        clauses.push('0'); // empty IN matches nothing
        continue;
      }
      const objectAt = values.findIndex(isObjectValue);
      if (objectAt !== -1) throw objectValueError(values[objectAt], at(objectAt));
      const list = jsonList(values);
      if (list === undefined) {
        clauses.push(`${f.column} IN (${values.map(() => '?').join(', ')})`);
        params.push(...values);
      } else {
        const element = realColumns.has(f.column) ? 'value' : '+value';
        clauses.push(`${f.column} IN (SELECT ${element} FROM json_each(?))`);
        params.push(list);
      }
      continue;
    }
    // validateQueryOptions refused an unknown op and an array on a scalar one.
    const { value } = f;
    if (isObjectValue(value)) throw objectValueError(value, at(0));
    clauses.push(`${f.column} ${SQL_OP.get(f.op)} ?`);
    params.push(value);
  }
  return { clauses, params };
}

/**
 * Whether SQLite gives a column declared `decl` REAL affinity: its type name
 * names `REAL`, `FLOA`, or `DOUB` and none of `INT`, `CHAR`, `CLOB`, `TEXT`, or
 * `BLOB` (https://sqlite.org/datatype3.html#determination_of_column_affinity).
 * The type name is the declaration up to its first column constraint, so the
 * text of a constraint (its name, a `CHECK` expression, a `DEFAULT` string)
 * never counts.
 */
function hasRealAffinity(decl: string): boolean {
  const [type = ''] = decl
    .toUpperCase()
    .split(
      /\b(?:CONSTRAINT|PRIMARY|NOT|NULL|UNIQUE|CHECK|DEFAULT|COLLATE|REFERENCES|GENERATED|AS)\b/,
      1,
    );
  return /REAL|FLOA|DOUB/.test(type) && !/INT|CHAR|CLOB|TEXT|BLOB/.test(type);
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
  mode: string | null;
  started_at: string | null;
  status: string;
  total: number | null;
}

/**
 * Give a store created before sync state recorded its run's mode the `mode`
 * column. A store that has it takes no write lock; otherwise the check repeats
 * under the write lock before the `ALTER`, so processes opening such a store
 * together add the column once and every one of their opens succeeds.
 */
function addSyncStateMode(handle: SqliteHandle): void {
  const hasMode = () =>
    handle
      .prepare(`SELECT 1 FROM pragma_table_info('mirror_sync_state') WHERE name = 'mode'`)
      .get() != null;
  if (hasMode()) return;
  handle.transaction(() => {
    if (!hasMode()) handle.exec(`ALTER TABLE mirror_sync_state ADD COLUMN mode TEXT`);
  }, 'immediate');
}

function readSyncState(handle: SqliteHandle): SyncState {
  const row = handle
    .prepare<SyncStateRow>(
      `SELECT status, mode, cursor, checkpoint, started_at, completed_at, total, error
       FROM mirror_sync_state WHERE id = 1`,
    )
    .get();
  if (!row) return { status: 'pending' };
  return {
    status: row.status as SyncState['status'],
    ...(row.mode != null && { mode: row.mode as SyncMode }),
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
       SET status = ?, mode = ?, cursor = ?, checkpoint = ?, started_at = ?,
           completed_at = COALESCE(?, completed_at),
           total = COALESCE(?, total),
           error = ?
       WHERE id = 1`,
    )
    .run(
      state.status,
      state.mode ?? null,
      state.cursor ?? null,
      state.checkpoint ?? null,
      state.startedAt ?? null,
      state.completedAt ?? null,
      state.total ?? null,
      state.error ?? null,
    );
}

/** Push `lease`'s expiry out by its TTL from now; `false` when `lease` no longer holds. */
function stampLeaseExpiry(handle: SqliteHandle, lease: SyncLease): boolean {
  return (
    handle
      .prepare(
        `UPDATE mirror_sync_lease SET expires_at = ?
         WHERE id = 1 AND owner = ? AND generation = ?`,
      )
      .run(Date.now() + lease.ttlMs, lease.owner, lease.generation).changes === 1
  );
}

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

/**
 * Apply pending migrations: each one with `stored < version <= target`, in
 * ascending order, then a final stamp to `target`. A brand-new database (no
 * `schema_version` row) is at version 0 and takes the same path, so a migration
 * that owns auxiliary objects the declarative DDL knows nothing about (junction
 * tables, denormalized counters) creates them on first open as well as on
 * upgrade. `Migration.up` therefore runs against a database that already has
 * the current declarative shape and must tolerate it.
 *
 * Each migration runs exactly once per database, atomically with its stamp: one
 * `BEGIN IMMEDIATE` transaction re-reads the stored version under the write
 * lock, skips the migration when another opener already applied it, runs `up`,
 * and stamps its version. A concurrent opener waits on that lock (up to
 * `busy_timeout`) and then skips; a throw from `up` or from the stamp leaves
 * nothing of the migration applied and the version unchanged. The final stamp
 * re-reads the same way and only ever raises the version. An up-to-date store
 * takes no write lock: its version read is the fast path.
 */
function runMigrations(handle: SqliteHandle, target: number, migrations: Migration[]): void {
  const stored = readSchemaVersion(handle);
  if (stored >= target) return;

  const pending = migrations
    .filter((m) => m.version > stored && m.version <= target)
    .sort((a, b) => a.version - b.version);
  for (const m of pending) {
    handle.transaction(() => {
      if (readSchemaVersion(handle) >= m.version) return;
      m.up(handle);
      stampVersion(handle, m.version);
    }, 'immediate');
  }
  handle.transaction(() => {
    if (readSchemaVersion(handle) < target) stampVersion(handle, target);
  }, 'immediate');
}

function readSchemaVersion(handle: SqliteHandle): number {
  return (
    handle.prepare<{ version: number }>(`SELECT MAX(version) AS version FROM schema_version`).get()
      ?.version ?? 0
  );
}

/** Replace the stored version. Runs inside the caller's transaction. */
function stampVersion(handle: SqliteHandle, version: number): void {
  handle.prepare(`DELETE FROM schema_version`).run();
  handle
    .prepare(`INSERT INTO schema_version(version, applied_at) VALUES (?, ?)`)
    .run(version, new Date().toISOString());
}

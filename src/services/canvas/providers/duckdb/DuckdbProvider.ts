/**
 * @fileoverview DuckDB-backed {@link IDataCanvasProvider}. One in-memory
 * DuckDB instance per canvasId; a long-lived control connection for DDL and
 * describe operations, plus a per-query connection so cancellation interrupts
 * exactly the in-flight query. `@duckdb/node-api` is lazy-loaded so it stays
 * a true peer dependency.
 * @module src/services/canvas/providers/duckdb/DuckdbProvider
 */

import { unlink } from 'node:fs/promises';

import { databaseError, notFound, timeout, validationError } from '@/types-global/errors.js';
import { lazyImport } from '@/utils/internal/lazyImport.js';
import { logger } from '@/utils/internal/logger.js';
import { type RequestContext, requestContextService } from '@/utils/internal/requestContext.js';

import type { IDataCanvasProvider } from '../../core/IDataCanvasProvider.js';
import { sniffSchema } from '../../core/schemaSniffer.js';
import {
  assertNoDeniedFunctions,
  assertPlanReadOnly,
  assertSelectOnly,
  assertValidIdentifier,
  quoteIdentifier,
} from '../../core/sqlGate.js';
import type {
  CanvasObjectKind,
  ColumnSchema,
  ColumnType,
  DescribeOptions,
  ExportOptions,
  ExportResult,
  ExportTarget,
  ImportFromOptions,
  QueryOptions,
  QueryResult,
  RegisterRows,
  RegisterTableOptions,
  RegisterTableResult,
  RegisterViewOptions,
  RegisterViewResult,
  TableInfo,
} from '../../types.js';
import {
  copyFormatClause,
  isPathTarget,
  pipeFileToStream,
  resolveExportPath,
  safeSizeBytes,
  tempFilePathFor,
} from './exportWriter.js';

const importDuckDB = lazyImport(
  () => import('@duckdb/node-api'),
  'Install "@duckdb/node-api" to use the DuckDB canvas provider: bun add @duckdb/node-api',
);

type DuckDBModule = typeof import('@duckdb/node-api');
type DuckDBInstance = InstanceType<DuckDBModule['DuckDBInstance']>;
type DuckDBConnection = InstanceType<DuckDBModule['DuckDBConnection']>;
type DuckDBTimestampValue = InstanceType<DuckDBModule['DuckDBTimestampValue']>;
type DuckDBDateValue = InstanceType<DuckDBModule['DuckDBDateValue']>;

/** Configuration for {@link DuckdbProvider}. Mirrors the AppConfig.canvas block. */
export interface DuckdbProviderOptions {
  /** Default row cap for `query()` results. */
  defaultRowLimit: number;
  /** Sandbox root for path-targeted exports. */
  exportRootPath: string;
  /** Per-canvas `memory_limit` PRAGMA value, in MB. */
  memoryLimitMb: number;
  /** Number of rows to sniff for schema inference. */
  schemaSniffRows: number;
}

interface CanvasRecord {
  /** Long-lived connection for DDL/describe/drop operations. */
  controlConnection: DuckDBConnection;
  instance: DuckDBInstance;
}

export class DuckdbProvider implements IDataCanvasProvider {
  readonly name = 'duckdb';

  private readonly canvases = new Map<string, CanvasRecord>();

  constructor(private readonly options: DuckdbProviderOptions) {}

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  async initCanvas(canvasId: string, _context: RequestContext): Promise<void> {
    if (this.canvases.has(canvasId)) return;
    const duck = await importDuckDB();
    const instance = await duck.DuckDBInstance.create(':memory:', {
      memory_limit: `${this.options.memoryLimitMb}MB`,
      // Disable extension install/load paths in canvas mode.
      autoinstall_known_extensions: 'false',
      autoload_known_extensions: 'false',
    });
    const controlConnection = await instance.connect();
    await controlConnection.run(`SET memory_limit = '${this.options.memoryLimitMb}MB'`);
    this.canvases.set(canvasId, { instance, controlConnection });
  }

  // biome-ignore lint/suspicious/useAwait: async is required by IDataCanvasProvider; close is sync for DuckDB.
  async destroyCanvas(canvasId: string, _context: RequestContext): Promise<void> {
    const record = this.canvases.get(canvasId);
    if (!record) return;
    this.canvases.delete(canvasId);
    const closeContext = requestContextService.createRequestContext({
      operation: 'DuckdbProvider.destroyCanvas',
      canvasId,
    });
    try {
      record.controlConnection.closeSync();
    } catch (err) {
      logger.warning('DuckDB control connection close failed.', {
        ...closeContext,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      record.instance.closeSync();
    } catch (err) {
      logger.warning('DuckDB instance close failed.', {
        ...closeContext,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const duck = await importDuckDB();
      const instance = await duck.DuckDBInstance.create(':memory:');
      const conn = await instance.connect();
      await conn.run('SELECT 1');
      conn.closeSync();
      instance.closeSync();
      return true;
    } catch {
      return false;
    }
  }

  async shutdown(): Promise<void> {
    const context = requestContextService.createRequestContext({
      operation: 'DuckdbProvider.shutdown',
    });
    const ids = [...this.canvases.keys()];
    await Promise.allSettled(ids.map((id) => this.destroyCanvas(id, context)));
  }

  // ---------------------------------------------------------------------
  // Data plane
  // ---------------------------------------------------------------------

  async registerTable(
    canvasId: string,
    name: string,
    rows: RegisterRows,
    _context: RequestContext,
    options?: RegisterTableOptions,
  ): Promise<RegisterTableResult> {
    const record = this.requireCanvas(canvasId);
    const duck = await importDuckDB();
    assertValidIdentifier(name, 'table');
    options?.signal?.throwIfAborted();

    const isAsyncIterable =
      typeof (rows as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function';
    let schema: ColumnSchema[];
    let bufferedRows: Record<string, unknown>[] | undefined;
    let remainingSync: Iterator<Record<string, unknown>> | undefined;

    if (options?.schema) {
      schema = options.schema;
    } else if (isAsyncIterable) {
      throw validationError(
        'Schema must be provided explicitly when registering rows from an AsyncIterable.',
        { reason: 'async_iterable_requires_schema', tableName: name },
      );
    } else {
      const sniffed = sniffSchema(
        rows as Iterable<Record<string, unknown>>,
        this.options.schemaSniffRows,
      );
      schema = sniffed.schema;
      bufferedRows = sniffed.sniffedRows;
      remainingSync = sniffed.remaining;
    }

    for (const col of schema) assertValidIdentifier(col.name, 'column');

    // Drop+create makes register idempotent under re-registration of a name.
    const ddl = buildCreateTableSql(name, schema);
    await record.controlConnection.run(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`);
    await record.controlConnection.run(ddl);
    options?.signal?.throwIfAborted();

    const appender = await record.controlConnection.createAppender(name);
    let count = 0;
    try {
      const appendOne = (row: Record<string, unknown>) => {
        for (const col of schema) {
          appendValue(appender, col, row[col.name], duck);
        }
        appender.endRow();
        count += 1;
      };
      if (bufferedRows) {
        for (const row of bufferedRows) {
          options?.signal?.throwIfAborted();
          appendOne(row);
        }
      }
      if (isAsyncIterable) {
        for await (const row of rows as AsyncIterable<Record<string, unknown>>) {
          options?.signal?.throwIfAborted();
          appendOne(row);
        }
      } else if (remainingSync) {
        // Continuation iterator from the sniffer — picks up just past
        // bufferedRows so we don't re-iterate (which would drop data on
        // generators or duplicate rows from fresh-iterator iterables).
        let next = remainingSync.next();
        while (!next.done) {
          options?.signal?.throwIfAborted();
          appendOne(next.value);
          next = remainingSync.next();
        }
      } else {
        for (const row of rows as Iterable<Record<string, unknown>>) {
          options?.signal?.throwIfAborted();
          appendOne(row);
        }
      }
    } finally {
      appender.closeSync();
    }

    return {
      tableName: name,
      rowCount: count,
      columns: schema.map((c) => c.name),
    };
  }

  async query(
    canvasId: string,
    sql: string,
    _context: RequestContext,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const record = this.requireCanvas(canvasId);
    const duck = await importDuckDB();
    options?.signal?.throwIfAborted();

    await this.assertReadOnlySql(record, sql, duck);

    // Per-query connection so cancellation interrupts only this call.
    const conn = await record.instance.connect();
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      try {
        conn.interrupt();
      } catch {
        /* interrupt is best-effort; closeSync still cleans up. */
      }
    };
    options?.signal?.addEventListener('abort', onAbort, { once: true });

    const rowLimit = options?.rowLimit ?? this.options.defaultRowLimit;
    const preview = options?.preview ?? rowLimit;

    try {
      let registeredAs: string | undefined;
      let rowsToReturn: Record<string, unknown>[] = [];
      let columns: string[] = [];
      let totalRowCount = 0;

      if (options?.registerAs) {
        assertValidIdentifier(options.registerAs, 'table');
        await ensureTableMissing(record.controlConnection, options.registerAs);
        const ctas = `CREATE TABLE ${quoteIdentifier(options.registerAs)} AS ${sql}`;
        await conn.run(ctas);
        registeredAs = options.registerAs;
        const reader = await conn.runAndReadUntil(
          `SELECT * FROM ${quoteIdentifier(options.registerAs)} LIMIT ${preview}`,
          preview,
        );
        rowsToReturn = reader.getRowObjectsJson() as Record<string, unknown>[];
        columns = reader.columnNames();
        totalRowCount = await this.countRows(conn, options.registerAs);
      } else {
        const reader = await conn.runAndReadAll(sql);
        const allRows = reader.getRowObjectsJson() as Record<string, unknown>[];
        columns = reader.columnNames();
        totalRowCount = allRows.length;
        rowsToReturn = allRows.slice(0, Math.min(preview, rowLimit));
      }

      return {
        rows: rowsToReturn,
        columns,
        rowCount: totalRowCount,
        ...(registeredAs && { tableName: registeredAs }),
      };
    } catch (err) {
      if (cancelled) {
        throw timeout('Canvas query was cancelled.', { reason: 'cancelled' }, { cause: err });
      }
      throw classifyDuckdbError(err);
    } finally {
      options?.signal?.removeEventListener('abort', onAbort);
      try {
        conn.closeSync();
      } catch {
        /* Connection may already be torn down by interrupt. */
      }
    }
  }

  async export(
    canvasId: string,
    tableName: string,
    target: ExportTarget,
    _context: RequestContext,
    options?: ExportOptions,
  ): Promise<ExportResult> {
    const record = this.requireCanvas(canvasId);
    assertValidIdentifier(tableName, 'table');
    options?.signal?.throwIfAborted();

    const formatClause = copyFormatClause(target.format);
    const conn = await record.instance.connect();
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      try {
        conn.interrupt();
      } catch {
        /* interrupt is best-effort. */
      }
    };
    options?.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const rowCount = await this.countRows(conn, tableName);

      if (isPathTarget(target)) {
        const absolutePath = await resolveExportPath(this.options.exportRootPath, target.path);
        await conn.run(
          `COPY ${quoteIdentifier(tableName)} TO '${escapeSqlString(absolutePath)}' ${formatClause}`,
        );
        const sizeBytes = await safeSizeBytes(absolutePath);
        return {
          format: target.format,
          path: absolutePath,
          sizeBytes,
          rowCount,
        };
      }

      // Stream branch: COPY to a sandbox temp file, pipe to the caller's
      // stream, then unlink. pipeFileToStream owns cleanup once invoked; if
      // the COPY itself fails we must unlink here before re-throwing.
      const tempPath = await tempFilePathFor(this.options.exportRootPath, target.format);
      try {
        await conn.run(
          `COPY ${quoteIdentifier(tableName)} TO '${escapeSqlString(tempPath)}' ${formatClause}`,
        );
      } catch (copyErr) {
        await unlink(tempPath).catch(() => {});
        throw copyErr;
      }
      const { sizeBytes } = await pipeFileToStream(tempPath, target.stream);
      return {
        format: target.format,
        sizeBytes,
        rowCount,
      };
    } catch (err) {
      if (cancelled) {
        throw timeout('Canvas export was cancelled.', { reason: 'cancelled' }, { cause: err });
      }
      throw classifyDuckdbError(err);
    } finally {
      options?.signal?.removeEventListener('abort', onAbort);
      try {
        conn.closeSync();
      } catch {
        /* Already torn down by interrupt. */
      }
    }
  }

  async registerView(
    canvasId: string,
    name: string,
    selectSql: string,
    _context: RequestContext,
    options?: RegisterViewOptions,
  ): Promise<RegisterViewResult> {
    const record = this.requireCanvas(canvasId);
    const duck = await importDuckDB();
    assertValidIdentifier(name, 'table');
    options?.signal?.throwIfAborted();

    // Same four-layer gate `query()` enforces. View definitions inherit the
    // operator allowlist transitively at query time, but we also gate the
    // SELECT at registration so a malicious definition fails loud here, not
    // later when the view is referenced.
    await this.assertReadOnlySql(record, selectSql, duck);
    options?.signal?.throwIfAborted();

    // Block view-on-table-name collisions explicitly so the failure carries a
    // structured `reason` rather than a raw DuckDB catalog message.
    const existing = await this.lookupKind(record.controlConnection, name);
    if (existing === 'table') {
      throw validationError(
        `Canvas already contains a base table named "${name}". Drop the table or choose a different name.`,
        { reason: 'view_table_clash', name },
      );
    }

    try {
      await record.controlConnection.run(
        `CREATE OR REPLACE VIEW ${quoteIdentifier(name)} AS ${selectSql}`,
      );
    } catch (err) {
      throw classifyDuckdbError(err);
    }

    const colReader = await record.controlConnection.runAndReadAll(
      `SELECT column_name FROM information_schema.columns ` +
        `WHERE table_schema = 'main' AND table_name = '${escapeSqlString(name)}' ` +
        `ORDER BY ordinal_position`,
    );
    const columns = (colReader.getRowObjectsJson() as { column_name: string }[]).map(
      (r) => r.column_name,
    );

    return { viewName: name, columns };
  }

  async importFrom(
    targetCanvasId: string,
    sourceCanvasId: string,
    sourceTableName: string,
    asName: string,
    _context: RequestContext,
    options?: ImportFromOptions,
  ): Promise<RegisterTableResult> {
    if (sourceCanvasId === targetCanvasId) {
      throw validationError(
        'Source and target canvases must differ. Use registerAs in query() to materialize within a single canvas.',
        { reason: 'import_same_canvas' },
      );
    }

    const target = this.requireCanvas(targetCanvasId);
    const source = this.requireCanvas(sourceCanvasId);

    assertValidIdentifier(sourceTableName, 'table');
    assertValidIdentifier(asName, 'table');
    options?.signal?.throwIfAborted();

    const sourceKind = await this.lookupKind(source.controlConnection, sourceTableName);
    if (sourceKind === undefined) {
      throw notFound(`Source canvas does not contain a table or view named "${sourceTableName}".`, {
        sourceCanvasId,
        sourceTableName,
      });
    }

    const targetExisting = await this.lookupKind(target.controlConnection, asName);
    if (targetExisting === 'view') {
      throw validationError(
        `Target canvas already contains a view named "${asName}". Drop the view or choose a different name.`,
        { reason: 'import_view_clash', asName },
      );
    }

    // Drop+create makes import idempotent under re-imports of the same name,
    // matching registerTable's behavior.
    await target.controlConnection.run(`DROP TABLE IF EXISTS ${quoteIdentifier(asName)}`);

    // Round-trip through a sandbox-rooted temp Parquet file. Parquet is
    // built into DuckDB's core (no extension load needed even with
    // autoload disabled). All column types — including TIMESTAMP/DATE/BLOB
    // — round-trip losslessly, which an in-memory appender path can't
    // guarantee for native engine value types.
    const tempPath = await tempFilePathFor(this.options.exportRootPath, 'parquet');
    try {
      await source.controlConnection.run(
        `COPY ${quoteIdentifier(sourceTableName)} TO '${escapeSqlString(tempPath)}' (FORMAT 'parquet')`,
      );
      options?.signal?.throwIfAborted();
      await target.controlConnection.run(
        `CREATE TABLE ${quoteIdentifier(asName)} AS SELECT * FROM read_parquet('${escapeSqlString(tempPath)}')`,
      );
    } catch (err) {
      // Best-effort cleanup of a half-written target before surfacing.
      await target.controlConnection
        .run(`DROP TABLE IF EXISTS ${quoteIdentifier(asName)}`)
        .catch(() => {});
      throw classifyDuckdbError(err);
    } finally {
      await unlink(tempPath).catch(() => {});
    }

    const [colReader, rowCount] = await Promise.all([
      target.controlConnection.runAndReadAll(
        `SELECT column_name FROM information_schema.columns ` +
          `WHERE table_schema = 'main' AND table_name = '${escapeSqlString(asName)}' ` +
          `ORDER BY ordinal_position`,
      ),
      this.countRows(target.controlConnection, asName),
    ]);
    const columns = (colReader.getRowObjectsJson() as { column_name: string }[]).map(
      (r) => r.column_name,
    );

    return { tableName: asName, rowCount, columns };
  }

  async describe(
    canvasId: string,
    _context: RequestContext,
    options?: DescribeOptions,
  ): Promise<TableInfo[]> {
    const record = this.requireCanvas(canvasId);
    if (options?.tableName !== undefined) {
      assertValidIdentifier(options.tableName, 'table');
    }
    const filters = [`table_schema = 'main'`];
    if (options?.tableName) {
      filters.push(`table_name = '${escapeSqlString(options.tableName)}'`);
    }
    if (options?.kind === 'view') {
      filters.push(`table_type = 'VIEW'`);
    } else if (options?.kind === 'table') {
      filters.push(`table_type <> 'VIEW'`);
    }
    const reader = await record.controlConnection.runAndReadAll(
      `SELECT table_name, table_type FROM information_schema.tables WHERE ${filters.join(' AND ')} ORDER BY table_name`,
    );
    const tableRows = reader.getRowObjectsJson() as { table_name: string; table_type: string }[];
    return await Promise.all(
      tableRows.map((row) =>
        this.describeOne(
          record.controlConnection,
          row.table_name,
          row.table_type === 'VIEW' ? 'view' : 'table',
        ),
      ),
    );
  }

  private async describeOne(
    connection: DuckDBConnection,
    tableName: string,
    kind: CanvasObjectKind,
  ): Promise<TableInfo> {
    const [colReader, rowCount] = await Promise.all([
      connection.runAndReadAll(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns ` +
          `WHERE table_schema = 'main' AND table_name = '${escapeSqlString(tableName)}' ` +
          `ORDER BY ordinal_position`,
      ),
      this.countRows(connection, tableName),
    ]);
    const colRows = colReader.getRowObjectsJson() as {
      column_name: string;
      data_type: string;
      is_nullable: string;
    }[];
    const columns: ColumnSchema[] = colRows.map((c) => ({
      name: c.column_name,
      type: dataTypeToColumnType(c.data_type),
      nullable: c.is_nullable === 'YES',
    }));
    return {
      name: tableName,
      kind,
      rowCount,
      columns,
    };
  }

  async drop(canvasId: string, name: string, _context: RequestContext): Promise<boolean> {
    const record = this.requireCanvas(canvasId);
    assertValidIdentifier(name, 'table');
    const kind = await this.lookupKind(record.controlConnection, name);
    if (kind === undefined) return false;
    const dropKeyword = kind === 'view' ? 'VIEW' : 'TABLE';
    await record.controlConnection.run(`DROP ${dropKeyword} ${quoteIdentifier(name)}`);
    return true;
  }

  async clear(canvasId: string, _context: RequestContext): Promise<number> {
    const record = this.requireCanvas(canvasId);
    const reader = await record.controlConnection.runAndReadAll(
      `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'main'`,
    );
    const rows = reader.getRowObjectsJson() as { table_name: string; table_type: string }[];
    // Drop views before tables so a dependent view doesn't block its base table.
    const ordered = [...rows].sort((a, b) => {
      const aView = a.table_type === 'VIEW';
      const bView = b.table_type === 'VIEW';
      if (aView !== bView) return aView ? -1 : 1;
      return a.table_name.localeCompare(b.table_name);
    });
    for (const row of ordered) {
      const dropKeyword = row.table_type === 'VIEW' ? 'VIEW' : 'TABLE';
      await record.controlConnection.run(`DROP ${dropKeyword} ${quoteIdentifier(row.table_name)}`);
    }
    return rows.length;
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private requireCanvas(canvasId: string): CanvasRecord {
    const record = this.canvases.get(canvasId);
    if (!record) {
      throw notFound('Canvas not found in DuckDB provider.', { canvasId });
    }
    return record;
  }

  /**
   * Run the same four-layer read-only gate `query()` enforces, against an
   * arbitrary SELECT string. Used by `query()` and `registerView()` so view
   * definitions inherit query-level safety.
   */
  private async assertReadOnlySql(
    record: CanvasRecord,
    sql: string,
    duck: DuckDBModule,
  ): Promise<void> {
    // Layer 1: text-level deny-list. read_json/read_parquet/... lower into
    // generic scans that pass the operator allowlist, so reject by name first.
    assertNoDeniedFunctions(sql);

    // Layers 2-3: parse and type-check before EXPLAIN.
    const extracted = await record.controlConnection.extractStatements(sql);
    const statementCount = extracted.count;
    let statementType: number | undefined;
    if (statementCount === 1) {
      const prepared = await extracted.prepare(0);
      try {
        statementType = prepared.statementType;
      } finally {
        prepared.destroySync();
      }
    }
    assertSelectOnly({
      statementCount,
      statementType:
        statementType !== undefined ? (duck.StatementType[statementType] ?? 'UNKNOWN') : 'UNKNOWN',
    });

    // Layer 4: walk the plan with the allowlist + denied-function rescan.
    const planJson = await this.runExplain(
      record.controlConnection,
      `EXPLAIN (FORMAT JSON) ${sql}`,
    );
    assertPlanReadOnly(planJson);
  }

  /**
   * Resolve whether a name on the canvas refers to a base table, a view, or
   * nothing. Returns `undefined` when absent; used by drop/registerView/
   * importFrom to dispatch the right DDL.
   */
  private async lookupKind(
    connection: DuckDBConnection,
    name: string,
  ): Promise<CanvasObjectKind | undefined> {
    const reader = await connection.runAndReadAll(
      `SELECT table_type FROM information_schema.tables ` +
        `WHERE table_schema = 'main' AND table_name = '${escapeSqlString(name)}' LIMIT 1`,
    );
    const rows = reader.getRowObjectsJson() as { table_type: string }[];
    if (rows.length === 0) return;
    return rows[0]?.table_type === 'VIEW' ? 'view' : 'table';
  }

  /**
   * Materialize `COUNT(*)` against a (validated) table or view name. DuckDB
   * returns BIGINT as a JSON string; this helper centralizes the `Number(...)`
   * coercion so callers see a plain `number`.
   */
  private async countRows(connection: DuckDBConnection, name: string): Promise<number> {
    const reader = await connection.runAndReadAll(
      `SELECT COUNT(*) AS n FROM ${quoteIdentifier(name)}`,
    );
    const row = reader.getRowObjectsJson()[0] as { n: number | string } | undefined;
    return Number(row?.n ?? 0);
  }

  private async runExplain(connection: DuckDBConnection, explainSql: string): Promise<unknown> {
    const reader = await connection.runAndReadAll(explainSql);
    const rows = reader.getRowObjectsJson() as Record<string, unknown>[];
    // EXPLAIN returns one row with `explain_value` as the JSON tree string.
    // Fail loud if the shape changes — a silent fallback would let queries
    // bypass the plan-walk gate.
    const value = rows[0]?.explain_value;
    if (typeof value !== 'string') {
      throw databaseError(
        'EXPLAIN returned an unexpected shape; canvas plan-walk cannot run safely.',
        { rowCount: rows.length, hasExplainValue: rows[0]?.explain_value !== undefined },
      );
    }
    try {
      return JSON.parse(value);
    } catch (err) {
      throw databaseError('Failed to parse EXPLAIN plan JSON.', undefined, { cause: err });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCreateTableSql(tableName: string, schema: ColumnSchema[]): string {
  if (schema.length === 0) {
    throw validationError('Table schema must contain at least one column.', { tableName });
  }
  const cols = schema.map((c) => {
    const nullable = c.nullable === false ? ' NOT NULL' : '';
    return `${quoteIdentifier(c.name)} ${c.type}${nullable}`;
  });
  return `CREATE TABLE ${quoteIdentifier(tableName)} (${cols.join(', ')})`;
}

/** Map DuckDB `information_schema.columns.data_type` strings back to {@link ColumnType}. */
function dataTypeToColumnType(dataType: string): ColumnType {
  const upper = dataType.toUpperCase();
  if (upper.startsWith('VARCHAR') || upper === 'STRING' || upper === 'TEXT') return 'VARCHAR';
  if (upper === 'INTEGER' || upper === 'INT' || upper === 'INT4') return 'INTEGER';
  if (upper === 'BIGINT' || upper === 'INT8' || upper === 'LONG') return 'BIGINT';
  if (upper === 'DOUBLE' || upper === 'FLOAT8' || upper === 'REAL' || upper === 'FLOAT')
    return 'DOUBLE';
  if (upper === 'BOOLEAN' || upper === 'BOOL') return 'BOOLEAN';
  if (upper.startsWith('TIMESTAMP')) return 'TIMESTAMP';
  if (upper === 'DATE') return 'DATE';
  if (upper === 'JSON') return 'JSON';
  if (upper === 'BLOB' || upper === 'BYTEA') return 'BLOB';
  return 'VARCHAR';
}

/**
 * Append a value through the DuckDB appender, dispatched by column type.
 * `duck` carries the typed value constructors needed for TIMESTAMP/DATE.
 * Incompatible values fail fast with a structured `validationError` rather
 * than coercing through `String(value)` (which corrupts Dates and binary).
 */
function appendValue(
  appender: DuckDBAppenderLike,
  col: ColumnSchema,
  value: unknown,
  duck: DuckDBModule,
): void {
  if (value === null || value === undefined) {
    appender.appendNull();
    return;
  }
  switch (col.type) {
    case 'VARCHAR':
      appender.appendVarchar(String(value));
      return;
    case 'INTEGER':
      appender.appendInteger(Number(value));
      return;
    case 'BIGINT':
      appender.appendBigInt(toBigInt(value));
      return;
    case 'DOUBLE':
      appender.appendDouble(Number(value));
      return;
    case 'BOOLEAN':
      appender.appendBoolean(Boolean(value));
      return;
    case 'JSON':
      appender.appendVarchar(typeof value === 'string' ? value : JSON.stringify(value));
      return;
    case 'TIMESTAMP':
      appender.appendTimestamp(new duck.DuckDBTimestampValue(toTimestampMicros(value, col.name)));
      return;
    case 'DATE':
      appender.appendDate(new duck.DuckDBDateValue(toDateDays(value, col.name)));
      return;
    case 'BLOB':
      appender.appendBlob(toUint8Array(value, col.name));
      return;
  }
}

/** Minimal appender surface we use; keeps the type loose without `any`. */
interface DuckDBAppenderLike {
  appendBigInt(value: bigint): void;
  appendBlob(value: Uint8Array): void;
  appendBoolean(value: boolean): void;
  appendDate(value: DuckDBDateValue): void;
  appendDouble(value: number): void;
  appendInteger(value: number): void;
  appendNull(): void;
  appendTimestamp(value: DuckDBTimestampValue): void;
  appendVarchar(value: string): void;
  closeSync(): void;
  endRow(): void;
}

/**
 * Coerce a value to BigInt without precision loss. `BigInt(Number(value))`
 * round-trips through JS Number and truncates outside the 53-bit safe range,
 * silently corrupting BIGINT IDs returned as numeric strings.
 *
 * @internal Exported for unit testing.
 */
export function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return BigInt(Math.trunc(Number(value)));
}

const MS_PER_DAY = 86_400_000;

/**
 * Coerce to DuckDB's TIMESTAMP unit (micros since 1970-01-01 UTC, as `bigint`).
 * Accepts `Date`, `bigint` (already-micros), `number` (ms-since-epoch matching
 * `Date.getTime()`), and ISO 8601 strings. Throws `validationError` otherwise.
 *
 * @internal Exported for unit testing.
 */
export function toTimestampMicros(value: unknown, columnName: string): bigint {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) {
      throw validationError(`Invalid Date for TIMESTAMP column "${columnName}".`, {
        reason: 'invalid_value_for_type',
        column: columnName,
        type: 'TIMESTAMP',
      });
    }
    return BigInt(ms) * 1000n;
  }
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value)) * 1000n;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return BigInt(ms) * 1000n;
  }
  throw validationError(
    `Cannot append ${describeValueType(value)} to TIMESTAMP column "${columnName}". Expected Date, ISO 8601 string, number (ms epoch), or bigint (micros epoch).`,
    { reason: 'invalid_value_for_type', column: columnName, type: 'TIMESTAMP' },
  );
}

/**
 * Coerce to DuckDB's DATE unit (days since 1970-01-01 UTC, as `number`).
 * Accepts the same shapes as {@link toTimestampMicros}; throws otherwise.
 *
 * @internal Exported for unit testing.
 */
export function toDateDays(value: unknown, columnName: string): number {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) {
      throw validationError(`Invalid Date for DATE column "${columnName}".`, {
        reason: 'invalid_value_for_type',
        column: columnName,
        type: 'DATE',
      });
    }
    return Math.floor(ms / MS_PER_DAY);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value / MS_PER_DAY);
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return Math.floor(ms / MS_PER_DAY);
  }
  throw validationError(
    `Cannot append ${describeValueType(value)} to DATE column "${columnName}". Expected Date, ISO 8601 date string, or number (ms epoch).`,
    { reason: 'invalid_value_for_type', column: columnName, type: 'DATE' },
  );
}

/**
 * Coerce to `Uint8Array` for BLOB appends. Accepts `Uint8Array` (Node's
 * `Buffer` passes through as a subclass), `ArrayBuffer`, and any other
 * `ArrayBufferView`. Throws `validationError` for non-binary inputs.
 *
 * @internal Exported for unit testing.
 */
export function toUint8Array(value: unknown, columnName: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  throw validationError(
    `Cannot append ${describeValueType(value)} to BLOB column "${columnName}". Expected Uint8Array, Buffer, or ArrayBuffer.`,
    { reason: 'invalid_value_for_type', column: columnName, type: 'BLOB' },
  );
}

/** Tag describing a runtime value's type, for error messages. */
function describeValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'Date';
  if (value instanceof Uint8Array) return 'Uint8Array';
  if (value instanceof ArrayBuffer) return 'ArrayBuffer';
  return typeof value;
}

/** Escape a string literal for safe inclusion in `'...'` SQL contexts. */
function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

async function ensureTableMissing(connection: DuckDBConnection, tableName: string): Promise<void> {
  const reader = await connection.runAndReadAll(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'main' AND table_name = '${escapeSqlString(tableName)}' LIMIT 1`,
  );
  if (reader.getRowsJson().length > 0) {
    throw validationError(
      `Canvas table "${tableName}" already exists. Drop it before reusing the name.`,
      { reason: 'register_as_clash', tableName },
    );
  }
}

/**
 * Map a DuckDB-thrown error to a framework error class.
 * @internal Exported for unit testing.
 */
export function classifyDuckdbError(err: unknown): Error {
  if (err instanceof Error) {
    const msg = err.message;
    if (/parser error|syntax/i.test(msg)) {
      return validationError(
        `Canvas SQL rejected: ${msg}`,
        { reason: 'sql_parse_error' },
        { cause: err },
      );
    }
    if (/permission|read.?only/i.test(msg)) {
      return validationError(
        `Canvas SQL rejected: ${msg}`,
        { reason: 'sql_read_only' },
        { cause: err },
      );
    }
    return databaseError(msg, undefined, { cause: err });
  }
  return databaseError('DuckDB threw a non-Error value.', { value: String(err) });
}

/**
 * @fileoverview DuckDB-backed implementation of {@link IDataCanvasProvider}.
 * One DuckDB instance per canvasId for memory isolation; a shared connection
 * for control-plane work (DDL, describe, drop) and per-query connections for
 * data-plane work so that {@link DuckDBConnection.interrupt} cancels exactly
 * the in-flight query without disturbing concurrent ops on the same canvas.
 *
 * Lazy-loaded via {@link lazyImport} so `@duckdb/node-api` stays a true peer
 * dependency — servers that don't enable canvas pay no install cost.
 *
 * @module src/canvas/providers/duckdb/DuckdbProvider
 */

import { databaseError, notFound, validationError } from '@/types-global/errors.js';
import { lazyImport } from '@/utils/internal/lazyImport.js';
import { logger } from '@/utils/internal/logger.js';
import { type RequestContext, requestContextService } from '@/utils/internal/requestContext.js';

import type { IDataCanvasProvider } from '../../core/IDataCanvasProvider.js';
import {
  assertPlanReadOnly,
  assertSelectOnly,
  assertValidIdentifier,
  quoteIdentifier,
} from '../../core/sqlGate.js';
import type {
  ColumnSchema,
  ColumnType,
  DescribeOptions,
  ExportOptions,
  ExportResult,
  ExportTarget,
  QueryOptions,
  QueryResult,
  RegisterRows,
  RegisterTableOptions,
  RegisterTableResult,
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
import { sniffSchema } from './schemaSniffer.js';

/** Lazy import binding — preserves bundler-friendly module specifiers. */
const importDuckDB = lazyImport(
  () => import('@duckdb/node-api'),
  'Install "@duckdb/node-api" to use the DuckDB canvas provider: bun add @duckdb/node-api',
);

type DuckDBModule = typeof import('@duckdb/node-api');
type DuckDBInstance = InstanceType<DuckDBModule['DuckDBInstance']>;
type DuckDBConnection = InstanceType<DuckDBModule['DuckDBConnection']>;

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

/** DuckDB SELECT statement-type id (matches `StatementType.SELECT === 1`). */
const STATEMENT_TYPE_SELECT_ID = 1;

interface CanvasRecord {
  /** Long-lived connection for DDL/describe/drop operations. */
  controlConnection: DuckDBConnection;
  instance: DuckDBInstance;
}

export class DuckdbProvider implements IDataCanvasProvider {
  readonly name = 'duckdb';

  private duck: DuckDBModule | undefined;
  private readonly canvases = new Map<string, CanvasRecord>();

  constructor(private readonly options: DuckdbProviderOptions) {}

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  async initCanvas(canvasId: string, _context: RequestContext): Promise<void> {
    if (this.canvases.has(canvasId)) return;
    const duck = await this.getModule();
    const instance = await duck.DuckDBInstance.create(':memory:', {
      memory_limit: `${this.options.memoryLimitMb}MB`,
      // Disable secrets/extensions install paths for safety in canvas mode.
      autoinstall_known_extensions: 'false',
      autoload_known_extensions: 'false',
    });
    const controlConnection = await instance.connect();
    // Belt-and-suspenders — also set the limit on the connection.
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
      const duck = await this.getModule();
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
    for (const id of ids) {
      await this.destroyCanvas(id, context);
    }
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
    assertValidIdentifier(name, 'table');
    options?.signal?.throwIfAborted();

    const isAsyncIterable =
      typeof (rows as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function';
    let schema: ColumnSchema[];
    let bufferedRows: Record<string, unknown>[] | undefined;

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
    }

    for (const col of schema) assertValidIdentifier(col.name, 'column');

    // Re-create the table — the issue's lifecycle guarantees a fresh canvasId
    // per acquire, but explicit drop+create makes register idempotent under
    // re-registration of the same name.
    const ddl = buildCreateTableSql(name, schema);
    await record.controlConnection.run(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`);
    await record.controlConnection.run(ddl);
    options?.signal?.throwIfAborted();

    const appender = await record.controlConnection.createAppender(name);
    let count = 0;
    try {
      const appendOne = (row: Record<string, unknown>) => {
        for (const col of schema) {
          appendValue(appender, col, row[col.name]);
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
      // Drain whatever's left of the iterable.
      if (isAsyncIterable) {
        for await (const row of rows as AsyncIterable<Record<string, unknown>>) {
          options?.signal?.throwIfAborted();
          appendOne(row);
        }
      } else if (!bufferedRows) {
        for (const row of rows as Iterable<Record<string, unknown>>) {
          options?.signal?.throwIfAborted();
          appendOne(row);
        }
      } else {
        // Sniffer consumed bufferedRows but the iterable may have more.
        for (const row of skipFirst(
          rows as Iterable<Record<string, unknown>>,
          bufferedRows.length,
        )) {
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
    options?.signal?.throwIfAborted();

    // Step 1: parse and type-check before invoking EXPLAIN.
    const extracted = await record.controlConnection.extractStatements(sql);
    const statementCount = extracted.count;
    let statementType: number | undefined;
    if (statementCount === 1) {
      const prepared = await extracted.prepare(0);
      try {
        statementType = (prepared as unknown as { statementType: number }).statementType;
      } finally {
        prepared.destroySync();
      }
    }
    assertSelectOnly({
      statementCount,
      statementType: statementTypeIdToString(statementType),
    });

    // Step 2: walk the plan with the allowlist (defense in depth).
    const planJson = await this.runExplain(
      record.controlConnection,
      `EXPLAIN (FORMAT JSON) ${sql}`,
    );
    assertPlanReadOnly(planJson);

    // Step 3: per-query connection so cancellation is scoped to this call.
    const conn = await record.instance.connect();
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      try {
        conn.interrupt();
      } catch {
        // interrupt is best-effort; closeSync still cleans up.
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
        // Reject clash with existing canvas table.
        await ensureTableMissing(record.controlConnection, options.registerAs);
        const ctas = `CREATE TABLE ${quoteIdentifier(options.registerAs)} AS ${sql}`;
        await conn.run(ctas);
        registeredAs = options.registerAs;
        // Read a preview off the new table (cheap because rows are local).
        const reader = await conn.runAndReadUntil(
          `SELECT * FROM ${quoteIdentifier(options.registerAs)} LIMIT ${preview}`,
          preview,
        );
        rowsToReturn = reader.getRowObjectsJson() as Record<string, unknown>[];
        columns = reader.columnNames();
        const countReader = await conn.runAndReadAll(
          `SELECT COUNT(*) AS n FROM ${quoteIdentifier(options.registerAs)}`,
        );
        const countRow = countReader.getRowObjectsJson()[0] as { n: number | string } | undefined;
        totalRowCount = Number(countRow?.n ?? 0);
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
        throw validationError(
          'Canvas query was cancelled.',
          { reason: 'cancelled' },
          { cause: err },
        );
      }
      throw classifyDuckdbError(err);
    } finally {
      options?.signal?.removeEventListener('abort', onAbort);
      try {
        conn.closeSync();
      } catch {
        // Connection may already be torn down by interrupt — ignore.
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
    const onAbort = () => {
      try {
        conn.interrupt();
      } catch {
        /* noop */
      }
    };
    options?.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      // Row count from the table — cheap, used for the result payload.
      const countReader = await conn.runAndReadAll(
        `SELECT COUNT(*) AS n FROM ${quoteIdentifier(tableName)}`,
      );
      const countRow = countReader.getRowObjectsJson()[0] as { n: number | string } | undefined;
      const rowCount = Number(countRow?.n ?? 0);

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

      // Stream branch: copy to temp file in sandbox, pipe to caller's stream,
      // then unlink. tempFilePathFor() creates the sandbox root if missing.
      const tempPath = await tempFilePathFor(this.options.exportRootPath, target.format);
      await conn.run(
        `COPY ${quoteIdentifier(tableName)} TO '${escapeSqlString(tempPath)}' ${formatClause}`,
      );
      const { sizeBytes } = await pipeFileToStream(tempPath, target.stream);
      return {
        format: target.format,
        sizeBytes,
        rowCount,
      };
    } catch (err) {
      throw classifyDuckdbError(err);
    } finally {
      options?.signal?.removeEventListener('abort', onAbort);
      try {
        conn.closeSync();
      } catch {
        /* noop */
      }
    }
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
    const filter = options?.tableName
      ? ` AND table_name = '${escapeSqlString(options.tableName)}'`
      : '';
    const reader = await record.controlConnection.runAndReadAll(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'${filter} ORDER BY table_name`,
    );
    const tableRows = reader.getRowObjectsJson() as { table_name: string }[];
    const result: TableInfo[] = [];
    for (const row of tableRows) {
      const tableName = row.table_name;
      const colReader = await record.controlConnection.runAndReadAll(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns ` +
          `WHERE table_schema = 'main' AND table_name = '${escapeSqlString(tableName)}' ` +
          `ORDER BY ordinal_position`,
      );
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
      const countReader = await record.controlConnection.runAndReadAll(
        `SELECT COUNT(*) AS n FROM ${quoteIdentifier(tableName)}`,
      );
      const countRow = countReader.getRowObjectsJson()[0] as { n: number | string } | undefined;
      result.push({
        name: tableName,
        rowCount: Number(countRow?.n ?? 0),
        columns,
      });
    }
    return result;
  }

  async drop(canvasId: string, name: string, _context: RequestContext): Promise<boolean> {
    const record = this.requireCanvas(canvasId);
    assertValidIdentifier(name, 'table');
    const checkReader = await record.controlConnection.runAndReadAll(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'main' AND table_name = '${escapeSqlString(name)}' LIMIT 1`,
    );
    if (checkReader.getRowsJson().length === 0) return false;
    await record.controlConnection.run(`DROP TABLE ${quoteIdentifier(name)}`);
    return true;
  }

  async clear(canvasId: string, _context: RequestContext): Promise<number> {
    const record = this.requireCanvas(canvasId);
    const reader = await record.controlConnection.runAndReadAll(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'`,
    );
    const rows = reader.getRowObjectsJson() as { table_name: string }[];
    for (const row of rows) {
      await record.controlConnection.run(`DROP TABLE ${quoteIdentifier(row.table_name)}`);
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

  private async getModule(): Promise<DuckDBModule> {
    if (!this.duck) this.duck = await importDuckDB();
    return this.duck;
  }

  private async runExplain(connection: DuckDBConnection, explainSql: string): Promise<unknown> {
    const reader = await connection.runAndReadAll(explainSql);
    const rows = reader.getRowObjectsJson() as Record<string, unknown>[];
    // EXPLAIN returns a single row with an `explain_value` column containing
    // the JSON tree as a string.
    const value = rows[0]?.explain_value;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch (err) {
        throw databaseError('Failed to parse EXPLAIN plan JSON.', undefined, { cause: err });
      }
    }
    return rows;
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
    return `${quoteIdentifier(c.name)} ${columnTypeToSql(c.type)}${nullable}`;
  });
  return `CREATE TABLE ${quoteIdentifier(tableName)} (${cols.join(', ')})`;
}

function columnTypeToSql(type: ColumnType): string {
  switch (type) {
    case 'VARCHAR':
      return 'VARCHAR';
    case 'INTEGER':
      return 'INTEGER';
    case 'BIGINT':
      return 'BIGINT';
    case 'DOUBLE':
      return 'DOUBLE';
    case 'BOOLEAN':
      return 'BOOLEAN';
    case 'TIMESTAMP':
      return 'TIMESTAMP';
    case 'DATE':
      return 'DATE';
    case 'JSON':
      return 'JSON';
    case 'BLOB':
      return 'BLOB';
  }
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

/** Convert a DuckDB `StatementType` numeric id to a string the gate can match. */
function statementTypeIdToString(id: number | undefined): string {
  switch (id) {
    case 1:
      return 'SELECT';
    case 2:
      return 'INSERT';
    case 3:
      return 'UPDATE';
    case 4:
      return 'EXPLAIN';
    case 5:
      return 'DELETE';
    case 6:
      return 'PREPARE';
    case 7:
      return 'CREATE';
    case 8:
      return 'EXECUTE';
    case 9:
      return 'ALTER';
    case 10:
      return 'TRANSACTION';
    case 11:
      return 'COPY';
    case 12:
      return 'ANALYZE';
    case 13:
      return 'VARIABLE_SET';
    case 14:
      return 'CREATE_FUNC';
    case 15:
      return 'DROP';
    case 16:
      return 'EXPORT';
    case 17:
      return 'PRAGMA';
    case 18:
      return 'VACUUM';
    case 19:
      return 'CALL';
    case 20:
      return 'SET';
    case 21:
      return 'LOAD';
    case 22:
      return 'RELATION';
    case 23:
      return 'EXTENSION';
    case 24:
      return 'LOGICAL_PLAN';
    case 25:
      return 'ATTACH';
    case 26:
      return 'DETACH';
    case 27:
      return 'MULTI';
    default:
      return 'UNKNOWN';
  }
}

/** Re-export for tests and consumer-side parsing. */
export { STATEMENT_TYPE_SELECT_ID };

/** Append a single value via the DuckDB appender, dispatched on column type. */
function appendValue(appender: DuckDBAppenderLike, col: ColumnSchema, value: unknown): void {
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
      appender.appendBigInt(typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value))));
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
    case 'DATE':
    case 'BLOB':
      // Use varchar fallback; DuckDB casts on insert when the schema allows.
      appender.appendVarchar(String(value));
      return;
  }
}

/** Minimal subset of the DuckDB appender we use — keeps types loose without `any`. */
interface DuckDBAppenderLike {
  appendBigInt(value: bigint): void;
  appendBoolean(value: boolean): void;
  appendDouble(value: number): void;
  appendInteger(value: number): void;
  appendNull(): void;
  appendVarchar(value: string): void;
  closeSync(): void;
  endRow(): void;
}

function* skipFirst<T>(iter: Iterable<T>, n: number): Iterable<T> {
  let skipped = 0;
  for (const item of iter) {
    if (skipped < n) {
      skipped += 1;
      continue;
    }
    yield item;
  }
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
 * @internal Exported for unit testing — not re-exported from the canvas barrel.
 */
export function classifyDuckdbError(err: unknown): Error {
  if (err instanceof Error) {
    const msg = err.message;
    // DuckDB tends to throw `Error` with a descriptive message; keep its
    // identity as the cause and attach a structured message.
    if (/parser error|syntax/i.test(msg)) {
      return validationError(
        `Canvas SQL rejected: ${msg}`,
        { reason: 'sql_parse_error' },
        {
          cause: err,
        },
      );
    }
    if (/permission|read.?only/i.test(msg)) {
      return validationError(
        `Canvas SQL rejected: ${msg}`,
        { reason: 'sql_read_only' },
        {
          cause: err,
        },
      );
    }
    return databaseError(msg, undefined, { cause: err });
  }
  return databaseError('DuckDB threw a non-Error value.', { value: String(err) });
}

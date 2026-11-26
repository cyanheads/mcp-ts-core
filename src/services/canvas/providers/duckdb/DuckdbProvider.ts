/**
 * @fileoverview DuckDB-backed {@link IDataCanvasProvider}. One in-memory
 * DuckDB instance per canvasId, reading and writing files only under the
 * export root and the provider's scratch directory, with its configuration
 * locked; a long-lived control connection for DDL and catalog lookups, plus a
 * connection per query, export, import, and describe so cancellation interrupts
 * exactly the in-flight call. `@duckdb/node-api` is lazy-loaded so it stays a
 * true peer dependency.
 * @module src/services/canvas/providers/duckdb/DuckdbProvider
 */

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  configurationError,
  databaseError,
  McpError,
  notFound,
  serviceUnavailable,
  timeout,
  validationError,
} from '@/types-global/errors.js';
import { lazyImport } from '@/utils/internal/lazyImport.js';
import { logger } from '@/utils/internal/logger.js';
import {
  type RequestContext,
  requestContextService,
  withExtra,
} from '@/utils/internal/requestContext.js';

import { canvasNotFound } from '../../core/CanvasRegistry.js';
import type { IDataCanvasProvider } from '../../core/IDataCanvasProvider.js';
import { sniffSchema } from '../../core/schemaSniffer.js';
import {
  assertNoDeniedFunctions,
  assertNoDeniedParsedFunctions,
  assertNoPivot,
  assertNoSystemCatalogs,
  assertPlanReadOnly,
  assertQueryNesting,
  assertSelectOnly,
  assertValidIdentifier,
  findFileReference,
  gateRecovery,
  isReadShaped,
  quoteIdentifier,
  SQL_GATE_REASONS,
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
  catalogMissName,
  classifyDuckdbError,
  DUCKDB_ERROR_REASONS,
  exportOutOfMemory,
  isCtasNameTaken,
  isDropOverView,
  isViewOverTable,
  missingTableError,
  prepareFailureRecovery,
  redactPaths,
  registerAsClash,
  SQL_READ_ONLY_RECOVERY,
  VIEW_READ_FAILURE,
  viewTableClash,
  viewUnreadableError,
} from './duckdbErrors.js';
import {
  copyFormatClause,
  exportStagingPath,
  isPathTarget,
  pipeFileToStream,
  resolveExportPath,
  singleWriterCopySource,
  tempFilePathFor,
} from './exportWriter.js';

const importDuckDB = lazyImport(
  () => import('@duckdb/node-api'),
  'The DuckDB canvas provider needs the optional peer dependency "@duckdb/node-api", which is not installed. Add it to the server\'s dependencies.',
);

type DuckDBModule = typeof import('@duckdb/node-api');
type DuckDBInstance = InstanceType<DuckDBModule['DuckDBInstance']>;
type DuckDBConnection = InstanceType<DuckDBModule['DuckDBConnection']>;
type DuckDBPendingResult = InstanceType<DuckDBModule['DuckDBPendingResult']>;
type DuckDBResultReader = InstanceType<DuckDBModule['DuckDBResultReader']>;
type DuckDBTimestampValue = InstanceType<DuckDBModule['DuckDBTimestampValue']>;
type DuckDBDateValue = InstanceType<DuckDBModule['DuckDBDateValue']>;

/**
 * `memory_limit` budgeted per engine thread. A query, and the `registerAs`
 * that keeps its result, runs on every engine thread, each holding working
 * memory inside `memory_limit`. An export, and the copy an `importFrom()`
 * stages, runs on one thread whatever the count — see
 * {@link singleWriterCopySource}. The cap sets `threads`, which DuckDB 2's
 * asynchronous I/O pool does not follow; `initCanvas` sizes that pool at
 * create (#870).
 */
const MEMORY_MB_PER_THREAD = 64;

/** Configuration for {@link DuckdbProvider}. Mirrors the AppConfig.canvas block. */
export interface DuckdbProviderOptions {
  /** Default row cap for `query()` results. */
  defaultRowLimit: number;
  /**
   * Sandbox root for path-targeted exports, and one of the two directory
   * trees a canvas's engine can read and write — the scratch directory is the
   * other — so a broad root widens what the engine itself can reach.
   */
  exportRootPath: string;
  /** Per-canvas `memory_limit` PRAGMA value, in MB. */
  memoryLimitMb: number;
  /** Number of rows to sniff for schema inference. */
  schemaSniffRows: number;
  /**
   * Parent of the provider's private scratch directory. On first use the
   * provider creates `mcp-canvas-XXXXXX` inside it with `mkdtemp` (mode
   * `0700` on POSIX) and keeps every scratch path there: each canvas's DuckDB
   * `temp_directory` and the transient files behind stream exports and
   * `importFrom`. `shutdown()` removes it once the calls still running
   * against it settle. Defaults to `os.tmpdir()`, never the process cwd. A
   * configured parent is created if missing and gets no ownership or mode
   * check, so it must not be a directory another local user controls. On
   * Windows the private directory inherits the parent's ACL, so there the
   * parent must also not grant other users access.
   */
  tempRootPath?: string | undefined;
}

/** A connection that can run one statement and read its result back. */
interface StatementReader {
  runAndReadAll(sql: string): Promise<DuckDBResultReader>;
}

/**
 * The statements a {@link DuckdbProvider.withConnection} callback runs on its
 * call's own connection. Each is started on the engine before it runs, so an
 * abort that arrived first still interrupts it.
 */
interface CallConnection extends StatementReader {
  run(sql: string): Promise<void>;
  runAndReadUntil(sql: string, targetRowCount: number): Promise<DuckDBResultReader>;
  streamAndReadUntil(sql: string, targetRowCount: number): Promise<DuckDBResultReader>;
}

interface CanvasRecord {
  /** Long-lived connection for DDL, catalog lookups, and the SQL gate's parse and EXPLAIN. */
  controlConnection: DuckDBConnection;
  /** The canvas database's own name, `current_database()` — see {@link ownTableName}. */
  database: string;
  /** This canvas's share of the provider's holds, one per call still running on it — see {@link DuckdbProvider.holdCanvas}. */
  holds: Set<Promise<void>>;
  instance: DuckDBInstance;
  /** The provider's private scratch directory this canvas was created under; export and import staging go here. */
  scratchDir: string;
  /** This canvas's own DuckDB `temp_directory`, inside `scratchDir`. DuckDB creates it on the first spill. */
  spillDir: string;
}

export class DuckdbProvider implements IDataCanvasProvider {
  readonly name = 'duckdb';

  private readonly canvases = new Map<string, CanvasRecord>();
  /** One pending promise per held canvas record, resolved on release — see {@link holdCanvas}. */
  private readonly holds = new Set<Promise<void>>();
  /** Each destroyed canvas's close still waiting on a call in flight, settled once it has run — see {@link destroyCanvas}. */
  private readonly closing = new Set<Promise<void>>();
  /** The private scratch directory once first requested — see {@link ensureTempRoot}. */
  private tempRoot: Promise<string> | undefined;

  constructor(private readonly options: DuckdbProviderOptions) {}

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  /**
   * The provider's private scratch directory, created once on first use.
   *
   * `mkdtemp` makes a directory no other local user can have pre-created,
   * planted links in, or read (`0700` on POSIX; on Windows it inherits the
   * parent's ACL, so there the parent must not grant other users access), so
   * no scratch path resolves through a fixed shared name (#554). It also
   * keeps scratch off the process cwd: DuckDB defaults an in-memory
   * database's `temp_directory` to a cwd-relative `.tmp`, which fails on a
   * non-root or read-only rootfs. Concurrent first calls share one directory;
   * a failed attempt is dropped so the next call retries.
   */
  private ensureTempRoot(): Promise<string> {
    if (!this.tempRoot) {
      const pending = this.createTempRoot();
      this.tempRoot = pending;
      pending.catch(() => {
        if (this.tempRoot === pending) this.tempRoot = undefined;
      });
    }
    return this.tempRoot;
  }

  private async createTempRoot(): Promise<string> {
    const parent = resolve(this.options.tempRootPath ?? tmpdir());
    try {
      await mkdir(parent, { recursive: true });
      return await mkdtemp(join(parent, 'mcp-canvas-'));
    } catch (err) {
      throw configurationError(
        'Canvas scratch directory could not be created: CANVAS_TEMP_PATH (the OS temp directory when unset) must be writable by the server process.',
        undefined,
        { cause: err },
      );
    }
  }

  async initCanvas(canvasId: string, _context: RequestContext): Promise<void> {
    if (this.canvases.has(canvasId)) return;
    const duck = await importDuckDB();
    const root = this.ensureTempRoot();
    const scratchDir = await root;
    // DuckDB v1.5 names spill files by block size alone, so instances sharing
    // a temp_directory overwrite each other's evicted blocks (#561).
    const spillDir = join(scratchDir, randomUUID());
    const instance = await duck.DuckDBInstance.create(':memory:', {
      memory_limit: `${this.options.memoryLimitMb}MB`,
      temp_directory: spillDir,
      // Disable extension install/load paths in canvas mode.
      autoinstall_known_extensions: 'false',
      autoload_known_extensions: 'false',
      // DuckDB v2.0 refuses the `x -> x + 1` lambda arrow by default; this keeps
      // it beside `lambda x: x + 1`, as v1.5 accepts both.
      lambda_syntax: 'ENABLE_SINGLE_ARROW',
      // DuckDB v2.0 adds an asynchronous I/O pool of four threads per detected
      // thread, which `SET threads` does not reach, held by every canvas
      // engine. Canvas I/O is local spill and staging files, so one thread
      // serves it (#870). v1.5 has no such option and refuses it.
      ...(duck.version().startsWith('v1.') ? {} : { async_threads: '1' }),
    });
    const controlConnection = await instance.connect();
    await controlConnection.run(`SET memory_limit = '${this.options.memoryLimitMb}MB'`);
    // DuckDB's own thread count (the cores, or a container's CPU quota) stays
    // the ceiling; the cap only lowers it on a small memory_limit.
    const threadCap = Math.max(1, Math.floor(this.options.memoryLimitMb / MEMORY_MB_PER_THREAD));
    const detected = await controlConnection.runAndReadAll(
      "SELECT current_setting('threads')::INTEGER AS n, current_database() AS database",
    );
    const { n: detectedThreads, database } = detected.getRowObjectsJson()[0] as {
      database: string;
      n: number;
    };
    if (detectedThreads > threadCap) {
      await controlConnection.run(`SET threads = ${threadCap}`);
    }
    // The engine reads and writes only under the export root and the scratch
    // directory (DuckDB adds the spill directory itself). An extension
    // INSTALL/LOAD would have to run before external access goes off.
    const allowed = [resolve(this.options.exportRootPath), scratchDir]
      .map((dir) => `'${escapeSqlString(dir)}'`)
      .join(', ');
    await controlConnection.run(`SET allowed_directories = [${allowed}]`);
    await controlConnection.run('SET enable_external_access = false');
    await controlConnection.run('SET lock_configuration = true');
    // A shutdown that began meanwhile retired `scratchDir` and may already
    // have removed it, freeing the name for another local user to re-create;
    // DuckDB creates only the leaf of its temp_directory and would spill into
    // whatever sits there. The check and the insert share one synchronous run,
    // so no shutdown can begin between them.
    if (this.tempRoot !== root) {
      controlConnection.closeSync();
      instance.closeSync();
      throw serviceUnavailable('Canvas provider shut down while the canvas was being created.');
    }
    this.canvases.set(canvasId, {
      instance,
      controlConnection,
      database,
      holds: new Set(),
      scratchDir,
      spillDir,
    });
  }

  /**
   * Remove the canvas, so a call made after this one rejects
   * `canvas_not_found`, then close its control connection and instance and
   * remove its spill directory once every call already running on it
   * settles. Closing either under a call in flight crashes the process or
   * fails the call (#893); each such call settles with its own result
   * instead, reading back any blocks it spilled, and this does not wait for
   * it. With none in flight, the canvas is closed and its directory gone
   * before this resolves. DuckDB removes a `temp_directory` it created when
   * the database closes; the removal here covers every other case, so
   * nothing of the canvas outlives it.
   */
  async destroyCanvas(canvasId: string, _context: RequestContext): Promise<void> {
    const record = this.canvases.get(canvasId);
    if (!record) return;
    this.canvases.delete(canvasId);
    const closeContext = requestContextService.createRequestContext({
      operation: 'DuckdbProvider.destroyCanvas',
      additionalContext: { canvasId },
    });
    const warn = (message: string, err: unknown) =>
      logger.warning(
        message,
        withExtra(closeContext, { error: err instanceof Error ? err.message : String(err) }),
      );
    const close = async () => {
      try {
        record.controlConnection.closeSync();
      } catch (err) {
        warn('DuckDB control connection close failed.', err);
      }
      try {
        record.instance.closeSync();
      } catch (err) {
        warn('DuckDB instance close failed.', err);
      }
      await rm(record.spillDir, { recursive: true, force: true }).catch((err: unknown) =>
        warn('Canvas spill directory removal failed.', err),
      );
    };
    if (record.holds.size > 0) {
      const closed: Promise<void> = Promise.all(record.holds)
        .then(close)
        .finally(() => this.closing.delete(closed));
      this.closing.add(closed);
      return;
    }
    await close();
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

  /**
   * Destroy every canvas, then remove the private scratch directory. A call
   * that reached a canvas before shutdown began keeps that canvas open (see
   * {@link destroyCanvas}) and can still be writing there, so the directory
   * goes once the last such call settles, and shutdown does not wait for it;
   * each call honors its caller's `signal`, so none needs a bound of its own
   * here. Until then the directory stays in place and private, which
   * keeps another local user from re-creating its name while that call still
   * writes inside it. A canvas whose creation straddles the shutdown is
   * refused rather than bound to the retired directory. A provider used
   * again afterwards creates a fresh one. After an abnormal exit the
   * directory stays behind, still private; nothing sweeps it on the next
   * start.
   */
  async shutdown(): Promise<void> {
    const context = requestContextService.createRequestContext({
      operation: 'DuckdbProvider.shutdown',
    });
    const ids = [...this.canvases.keys()];
    const held = [...this.holds];
    const tempRoot = this.tempRoot;
    this.tempRoot = undefined;
    await Promise.allSettled(ids.map((id) => this.destroyCanvas(id, context)));
    const dir = await tempRoot?.catch(() => undefined);
    if (!dir) return;
    const remove = () =>
      rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
        logger.warning(
          'Canvas scratch directory removal failed; it stays in place, still private.',
          withExtra(context, { error: err instanceof Error ? err.message : String(err) }),
        );
      });
    // After each canvas's own deferred close and spill removal, never beside
    // them: on Bun, a recursive `rm` that races the removal of an entry inside
    // it can resolve with the directory still in place.
    const pending = [...held.filter((hold) => this.holds.has(hold)), ...this.closing];
    if (pending.length > 0) {
      void Promise.all(pending).then(remove);
      return;
    }
    await remove();
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
    using record = this.holdCanvas(canvasId);
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

    /**
     * Drop, create, and append run in one transaction on a connection of the
     * call's own, so a re-registration replaces the table whole or not at all
     * (#659): every other connection reads the previous table until the commit,
     * and a source, conversion, or cancellation failure rolls back to it — or,
     * on a first registration, to no table. A concurrent write to the same
     * table fails this call with DuckDB's write-write conflict, a
     * `DatabaseError`.
     */
    const ddl = buildCreateTableSql(name, schema);
    const conn = await record.instance.connect();
    // The engine's own steps fail classified; the caller's row source, which
    // runs between them, fails as it threw.
    const engine = async <T>(step: Promise<T>): Promise<T> => {
      try {
        return await step;
      } catch (err) {
        throw this.classify(err, record);
      }
    };
    let count = 0;
    try {
      await engine(conn.run('BEGIN TRANSACTION'));
      try {
        await engine(conn.run(`DROP TABLE IF EXISTS ${ownTableName(record, name)}`));
        await engine(conn.run(ddl));
        options?.signal?.throwIfAborted();
        const appender = await engine(conn.createAppender(name));
        // The appender writes its rows to the table as a chunk fills and as it
        // closes; a failure there, out of memory included, is the engine's.
        const flush = (step: () => void) => {
          try {
            step();
          } catch (err) {
            throw this.classify(err, record);
          }
        };
        try {
          const appendOne = (row: Record<string, unknown>) => {
            for (const col of schema) {
              appendValue(appender, col, row[col.name], duck);
            }
            flush(() => appender.endRow());
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
          flush(() => appender.closeSync());
        }
        await engine(conn.run('COMMIT'));
      } catch (err) {
        // The source stopped early is closed so its `finally` runs (#661); the
        // loops above close theirs, the sniffer's continuation is closed here.
        // Neither that nor the rollback replaces the error that ended the call.
        try {
          remainingSync?.return?.();
        } catch {
          /* the original error wins */
        }
        await conn.run('ROLLBACK').catch(() => {});
        throw err;
      }
    } catch (err) {
      // The caller's own row source runs in the same block, so apart from the
      // engine's statements and the appender's failures, classified where they
      // are raised, only errors naming a host path change.
      throw this.redactHostPaths(err, record);
    } finally {
      conn.closeSync();
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
    using record = this.holdCanvas(canvasId);
    throwIfCancelled(options?.signal, QUERY_CANCELLED);

    const rowLimit = options?.rowLimit ?? this.options.defaultRowLimit;
    if (
      !Number.isSafeInteger(rowLimit) ||
      rowLimit < 1 ||
      rowLimit > this.options.defaultRowLimit
    ) {
      throw validationError(
        `rowLimit must be a positive safe integer no greater than ${this.options.defaultRowLimit}.`,
        { reason: 'invalid_query_bounds', field: 'rowLimit' },
      );
    }
    const preview = options?.preview ?? rowLimit;
    if (!Number.isSafeInteger(preview) || preview < 0 || preview > rowLimit) {
      throw validationError(
        'preview must be a non-negative safe integer no greater than rowLimit.',
        { reason: 'invalid_query_bounds', field: 'preview' },
      );
    }

    const duck = await importDuckDB();
    await this.assertReadOnlySql(record, sql, duck, options);

    // Set once the CTAS has created the table, which a call that then rejects
    // drops again, so it never leaves a table its caller was not told about.
    let registeredAs: string | undefined;
    try {
      return await this.withConnection(record, options?.signal, QUERY_CANCELLED, async (conn) => {
        let rowsToReturn: Record<string, unknown>[] = [];
        let columns: string[] = [];
        let totalRowCount = 0;
        let truncated: boolean | undefined;

        if (options?.registerAs) {
          assertValidIdentifier(options.registerAs, 'table');
          await ensureTableMissing(record.controlConnection, options.registerAs);
          const ctas = `CREATE TABLE ${quoteIdentifier(options.registerAs)} AS ${sql}`;
          try {
            await conn.run(ctas);
          } catch (err) {
            // The name was free when checked, but the engine refused it: another
            // call staged it since, or it is staged in another letter case,
            // which the check reads exactly and the engine does not (#891).
            if (isCtasNameTaken(err)) throw registerAsClash(options.registerAs, err);
            throw err;
          }
          registeredAs = options.registerAs;
          const reader = await conn.runAndReadUntil(
            `SELECT * FROM ${quoteIdentifier(options.registerAs)} LIMIT ${preview}`,
            preview,
          );
          rowsToReturn = reader.getRowObjectsJson() as Record<string, unknown>[];
          columns = reader.columnNames();
          totalRowCount = await this.countRows(conn, options.registerAs);
          // truncated is false on the registerAs path — rowCount is exact.
        } else {
          // Use streamAndReadUntil to keep the engine pipeline lazy: reads at
          // most rowLimit+1 rows without materializing the full result in JS.
          const reader = await conn.streamAndReadUntil(sql, rowLimit + 1);
          const fetched = reader.getRowObjectsJson() as Record<string, unknown>[];
          columns = reader.columnNames();
          if (fetched.length > rowLimit) {
            // More rows exist beyond the cap.
            rowsToReturn = fetched.slice(0, rowLimit);
            totalRowCount = rowLimit;
            truncated = true;
          } else {
            rowsToReturn = fetched;
            totalRowCount = fetched.length;
          }
          // Apply preview cap (may be smaller than rowLimit when caller requests a smaller slice).
          if (rowsToReturn.length > preview) {
            rowsToReturn = rowsToReturn.slice(0, preview);
          }
        }

        return {
          rows: rowsToReturn,
          columns,
          rowCount: totalRowCount,
          ...(truncated && { truncated }),
          ...(registeredAs && { tableName: registeredAs }),
        };
      });
    } catch (err) {
      if (registeredAs !== undefined) {
        await record.controlConnection
          .run(`DROP TABLE IF EXISTS ${ownTableName(record, registeredAs)}`)
          .catch(() => {});
      }
      throw err;
    }
  }

  async export(
    canvasId: string,
    tableName: string,
    target: ExportTarget,
    _context: RequestContext,
    options?: ExportOptions,
  ): Promise<ExportResult> {
    using record = this.holdCanvas(canvasId);
    const duck = await importDuckDB();
    assertValidIdentifier(tableName, 'table');
    const signal = options?.signal;
    throwIfCancelled(signal, EXPORT_CANCELLED);

    const formatClause = copyFormatClause(target.format, duck.version());
    /**
     * Opens the export's transaction and reads the row count and the COPY
     * source inside it. One transaction, so the count, the column list, and
     * the COPY read one version of the object: another call can stage it again
     * between two statements, and a union over a stale column count fails to
     * bind. Every format runs the single-writer source (see
     * singleWriterCopySource).
     */
    const begin = async (conn: CallConnection) => {
      await conn.run('BEGIN TRANSACTION');
      const rowCount = await this.countRows(conn, tableName);
      const columnCount = (await this.columnNames(conn, tableName)).length;
      return { rowCount, source: singleWriterCopySource(tableName, columnCount) };
    };

    try {
      if (isPathTarget(target)) {
        /**
         * The COPY writes a staging file beside the target, renamed over it
         * once the transaction commits, so a call that rejects leaves the
         * target as it found it. The rename is the commit point: the target's
         * path is checked again, since the filesystem can change while the
         * COPY runs, and the last cancellation check follows with nothing
         * between it and the rename.
         */
        const root = this.options.exportRootPath;
        const staging: { path?: string } = {};
        try {
          const written = await this.withConnection(
            record,
            signal,
            EXPORT_CANCELLED,
            async (conn) => {
              const { rowCount, source } = await begin(conn);
              const path = await resolveExportPath(root, target.path);
              const file = await resolveExportPath(root, exportStagingPath(target.path));
              staging.path = file;
              try {
                await conn.run(`COPY ${source} TO '${escapeSqlString(file)}' ${formatClause}`);
                await conn.run('COMMIT');
                return { file, rowCount, sizeBytes: (await stat(file)).size };
              } catch (err) {
                // An engine message quoting the staging file names the target the caller asked for.
                if (!(err instanceof Error) || !err.message.includes(file)) throw err;
                throw new Error(err.message.replaceAll(file, path), { cause: err });
              }
            },
          );
          const path = await resolveExportPath(root, target.path);
          throwIfCancelled(signal, EXPORT_CANCELLED);
          await rename(written.file, path).catch((err: NodeJS.ErrnoException) => {
            throw databaseError(
              `Canvas export could not be written to "${redactPaths(path, this.hostPaths(record))}" (${err.code}).`,
              undefined,
              { cause: err },
            );
          });
          return {
            format: target.format,
            path,
            sizeBytes: written.sizeBytes,
            rowCount: written.rowCount,
          };
        } catch (err) {
          if (staging.path !== undefined) await unlink(staging.path).catch(() => {});
          throw this.classify(err, record);
        }
      }

      // Stream branch: COPY to a scratch file, pipe to the caller's stream,
      // then unlink. pipeFileToStream owns cleanup once invoked; if the COPY
      // itself fails we must unlink here before re-throwing.
      return await this.withConnection(record, signal, EXPORT_CANCELLED, async (conn) => {
        const { rowCount, source } = await begin(conn);
        const tempPath = tempFilePathFor(record.scratchDir, target.format);
        try {
          await conn.run(`COPY ${source} TO '${escapeSqlString(tempPath)}' ${formatClause}`);
          await conn.run('COMMIT');
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
      });
    } catch (err) {
      throw exportOutOfMemory(err, target.format);
    }
  }

  async registerView(
    canvasId: string,
    name: string,
    selectSql: string,
    _context: RequestContext,
    options?: RegisterViewOptions,
  ): Promise<RegisterViewResult> {
    using record = this.holdCanvas(canvasId);
    const duck = await importDuckDB();
    assertValidIdentifier(name, 'table');
    throwIfCancelled(options?.signal, VIEW_CANCELLED);

    // Same five-layer gate `query()` enforces. View definitions inherit the
    // operator allowlist transitively at query time, but we also gate the
    // SELECT at registration so a malicious definition fails loud here, not
    // later when the view is referenced.
    await this.assertReadOnlySql(record, selectSql, duck, options);

    // Block view-on-table-name collisions explicitly so the failure carries a
    // structured `reason` rather than a raw DuckDB catalog message.
    const existing = await this.lookupKind(record.controlConnection, name);
    if (existing === 'table') throw viewTableClash(name);

    // The last point an abort is honored: the definition is catalog-only DDL
    // on the shared control connection, which is not interrupted on one call's
    // behalf, and `OR REPLACE` cannot be undone once it commits.
    throwIfCancelled(options?.signal, VIEW_CANCELLED);
    try {
      await record.controlConnection.run(
        `CREATE OR REPLACE VIEW ${quoteIdentifier(name)} AS ${selectSql}`,
      );
    } catch (err) {
      // A table the check above did not see: staged since, or staged in another
      // letter case, which the check reads exactly and the engine does not.
      if (isViewOverTable(err)) throw viewTableClash(name, err);
      throw this.classify(err, record);
    }

    return { viewName: name, columns: await this.columnNames(record.controlConnection, name) };
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
        'Source and target canvases must differ. Importing copies a table between two canvases.',
        {
          reason: 'import_same_canvas',
          recovery: {
            hint: 'Pass the canvas id of a different canvas as the source — the table is already on this one.',
          },
        },
      );
    }

    using target = this.holdCanvas(targetCanvasId);
    using source = this.holdCanvas(sourceCanvasId);

    assertValidIdentifier(sourceTableName, 'table');
    assertValidIdentifier(asName, 'table');
    throwIfCancelled(options?.signal, IMPORT_CANCELLED);

    const sourceMissing = () =>
      notFound(
        `Source canvas does not contain a table or view named "${sourceTableName}".`,
        {
          reason: 'missing_table',
          sourceCanvasId,
          sourceTableName,
          recovery: {
            hint: "Re-check the source table name, or list the tables staged on the source canvas with this server's dataframe-describe tool.",
          },
        },
        { literals: [sourceTableName] },
      );
    if ((await this.lookupKind(source.controlConnection, sourceTableName)) === undefined) {
      throw sourceMissing();
    }

    const viewClash = (cause?: unknown) =>
      validationError(
        `Target canvas already contains a view named "${asName}". Drop the view or choose a different name.`,
        {
          reason: 'import_view_clash',
          asName,
          recovery: {
            hint: 'Drop the existing view first, or choose a different destination name for the imported table.',
          },
        },
        cause === undefined ? { literals: [asName] } : { cause, literals: [asName] },
      );
    if ((await this.lookupKind(target.controlConnection, asName)) === 'view') throw viewClash();

    // Round-trip through a scratch Parquet file. Parquet is
    // built into DuckDB's core (no extension load needed even with
    // autoload disabled). All column types — including TIMESTAMP/DATE/BLOB
    // — round-trip losslessly, which an in-memory appender path can't
    // guarantee for native engine value types. Each side runs on a connection
    // of its own, so an abort interrupts the copy without touching either
    // canvas's other calls. The source side writes as a Parquet export does:
    // from the single-writer source, in capped row groups, inside one
    // transaction so the column count and the COPY read one version of it.
    const duck = await importDuckDB();
    const tempPath = tempFilePathFor(target.scratchDir, 'parquet');
    try {
      await this.withConnection(source, options?.signal, IMPORT_CANCELLED, async (conn) => {
        await conn.run('BEGIN TRANSACTION');
        const columnCount = (await this.columnNames(conn, sourceTableName)).length;
        // No columns: another call dropped the source since it was looked up.
        if (columnCount === 0) throw sourceMissing();
        await conn.run(
          `COPY ${singleWriterCopySource(sourceTableName, columnCount)} TO '${escapeSqlString(tempPath)}' ${copyFormatClause('parquet', duck.version())}`,
        );
        await conn.run('COMMIT');
      });
      /**
       * Drop and create run in one transaction, as in `registerTable`: a
       * re-import replaces the destination whole, and a failed or cancelled
       * copy rolls back to the previous table, or to none (#659).
       */
      return await this.withConnection(target, options?.signal, IMPORT_CANCELLED, async (conn) => {
        await conn.run('BEGIN TRANSACTION');
        try {
          try {
            await conn.run(`DROP TABLE IF EXISTS ${ownTableName(target, asName)}`);
          } catch (err) {
            // A view the check above did not see: staged since, or staged in
            // another letter case, which the check reads exactly and the engine does not.
            if (isDropOverView(err)) throw viewClash(err);
            throw err;
          }
          await conn.run(
            `CREATE TABLE ${quoteIdentifier(asName)} AS SELECT * FROM read_parquet('${escapeSqlString(tempPath)}')`,
          );
          const columns = await this.columnNames(conn, asName);
          const rowCount = await this.countRows(conn, asName);
          await conn.run('COMMIT');
          return { tableName: asName, rowCount, columns };
        } catch (err) {
          await conn.run('ROLLBACK').catch(() => {});
          throw err;
        }
      });
    } catch (err) {
      throw this.classify(err, target);
    } finally {
      await unlink(tempPath).catch(() => {});
    }
  }

  /**
   * Lists the objects in scope, then reads each on a connection of the call's
   * own, so an abort interrupts exactly this call and a describe in progress
   * holds up no other call on the canvas. A view is counted by reading it; one
   * whose read fails on its own definition against the tables as now staged is
   * set aside, and once every object has been read the call rejects with one
   * `view_unreadable` naming each such view, rather than answer an entry whose
   * count was not taken. Any other engine failure is classified as it is
   * everywhere else.
   */
  async describe(
    canvasId: string,
    _context: RequestContext,
    options?: DescribeOptions,
  ): Promise<TableInfo[]> {
    using record = this.holdCanvas(canvasId);
    if (options?.tableName !== undefined) {
      assertValidIdentifier(options.tableName, 'table');
    }
    throwIfCancelled(options?.signal, DESCRIBE_CANCELLED);
    // Every pushed filter stays qualified with the `o` alias, so a second
    // source joined here cannot silently resurrect the ambiguous-column
    // Binder Error of #235.
    const filters: string[] = [];
    if (options?.tableName) {
      filters.push(`o.name = '${escapeSqlString(options.tableName)}'`);
    }
    if (options?.kind === 'view') {
      filters.push(`o.kind = 'view'`);
    } else if (options?.kind === 'table') {
      filters.push(`o.kind = 'table'`);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    return await this.withConnection(record, options?.signal, DESCRIBE_CANCELLED, async (conn) => {
      // No size column: `duckdb_tables().estimated_size` is an estimated row
      // count, not a byte footprint, so reporting it as `approxSizeBytes` sent a
      // caller choosing an eviction victim after the wrong table. DuckDB
      // exposes no per-table byte column at all (#324), so describe() reports none.
      const reader = await conn.runAndReadAll(
        `SELECT o.name, o.kind FROM ${STAGED_OBJECTS} o ${where} ORDER BY o.name`,
      );
      const objects = reader.getRowObjectsJson() as { kind: CanvasObjectKind; name: string }[];

      // One object after another: the call's connection runs one statement at a time.
      const described: TableInfo[] = [];
      const unreadable: { error: Error; name: string }[] = [];
      for (const { kind, name } of objects) {
        try {
          described.push(await this.describeOne(conn, name, kind));
        } catch (err) {
          if (kind === 'table' || !(err instanceof Error) || !VIEW_READ_FAILURE.test(err.message)) {
            throw err;
          }
          unreadable.push({ error: err, name });
        }
      }
      if (unreadable.length > 0) throw viewUnreadableError(unreadable, this.hostPaths(record));
      return described;
    });
  }

  /** One object's columns and row count, read one statement after the other. */
  private async describeOne(
    connection: StatementReader,
    tableName: string,
    kind: CanvasObjectKind,
  ): Promise<TableInfo> {
    const colRows = await this.columnRows(connection, tableName);
    const rowCount = await this.countRows(connection, tableName);
    const columns: TableInfo['columns'] = colRows.map((c) => ({
      name: c.column_name,
      type: dataTypeToColumnType(c.data_type),
      engineType: c.data_type,
      nullable: c.is_nullable,
    }));
    return {
      name: tableName,
      kind,
      rowCount,
      columns,
    };
  }

  async drop(canvasId: string, name: string, _context: RequestContext): Promise<boolean> {
    using record = this.holdCanvas(canvasId);
    assertValidIdentifier(name, 'table');
    try {
      const kind = await this.lookupKind(record.controlConnection, name);
      if (kind === undefined) return false;
      const dropKeyword = kind === 'view' ? 'VIEW' : 'TABLE';
      await record.controlConnection.run(`DROP ${dropKeyword} ${quoteIdentifier(name)}`);
      return true;
    } catch (err) {
      // A concurrent write to the same object fails with the engine's write-write conflict.
      throw this.classify(err, record);
    }
  }

  async clear(canvasId: string, _context: RequestContext): Promise<number> {
    using record = this.holdCanvas(canvasId);
    const reader = await record.controlConnection.runAndReadAll(
      `SELECT name, kind FROM ${STAGED_OBJECTS} o`,
    );
    const rows = reader.getRowObjectsJson() as { kind: CanvasObjectKind; name: string }[];
    // Drop views before tables so a dependent view doesn't block its base table.
    const ordered = [...rows].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'view' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const row of ordered) {
      const dropKeyword = row.kind === 'view' ? 'VIEW' : 'TABLE';
      await record.controlConnection.run(`DROP ${dropKeyword} ${quoteIdentifier(row.name)}`);
    }
    return rows.length;
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /**
   * `canvasId`'s record, held until the caller's `using` scope exits, on
   * return or throw. {@link destroyCanvas} closes the canvas's control
   * connection and instance, and removes its spill directory, only once every
   * hold on that canvas is released, so a call already running keeps both
   * open and can still read back the blocks it spilled. {@link shutdown}
   * removes the scratch directory only once every hold taken before it began
   * is released, so a call already running finishes inside the private
   * directory, never in one another local user re-created under its name.
   * Every data-plane call reaches its record through a hold.
   */
  private holdCanvas(canvasId: string): CanvasRecord & Disposable {
    const record = this.canvases.get(canvasId);
    // Defensive — CanvasInstance touches the registry first, which throws the
    // same structured canvas_not_found before the provider is reached (#261).
    if (!record) throw canvasNotFound(canvasId);
    const { promise, resolve } = Promise.withResolvers<void>();
    this.holds.add(promise);
    record.holds.add(promise);
    return {
      ...record,
      [Symbol.dispose]: () => {
        this.holds.delete(promise);
        record.holds.delete(promise);
        resolve();
      },
    };
  }

  /** Host directories an engine message can quote and a caller must not see. */
  private hostPaths(record: CanvasRecord): string[] {
    return [resolve(this.options.exportRootPath), record.scratchDir];
  }

  /** {@link classifyDuckdbError} with this canvas's host directories redacted. */
  private classify(err: unknown, record: CanvasRecord): Error {
    return classifyDuckdbError(err, this.hostPaths(record));
  }

  /**
   * `err` classified and redacted when it is an engine error naming a host
   * directory; anything else as it came. For blocks that also run code other
   * than the engine's — a caller's row source, a cancellation check — whose
   * failures must reach the caller as thrown.
   */
  private redactHostPaths(err: unknown, record: CanvasRecord): unknown {
    if (!(err instanceof Error) || err instanceof McpError) return err;
    const paths = this.hostPaths(record);
    return redactPaths(err.message, paths) === err.message ? err : classifyDuckdbError(err, paths);
  }

  /**
   * Runs `fn` on a connection of its own, so an abort interrupts only this
   * call. DuckDB honors an interrupt only for a statement it has already
   * begun and discards one that arrives sooner, so the abort is also checked
   * where the listener cannot reach: once the listener is attached (an abort
   * that came first never fires it), as each statement starts — after the
   * engine has begun it and before it runs, re-issuing the interrupt — and
   * once `fn` returns. Any failure after the abort surfaces as `Timeout`
   * (cancelled); any other failure is classified from the engine error. The
   * connection is always closed, even when the interrupt already tore it down.
   */
  private async withConnection<T>(
    record: CanvasRecord,
    signal: AbortSignal | undefined,
    cancelledMessage: string,
    fn: (conn: CallConnection) => Promise<T>,
  ): Promise<T> {
    const conn = await record.instance.connect();
    const interrupt = () => {
      try {
        conn.interrupt();
      } catch {
        /* interrupt is best-effort; closeSync still cleans up. */
      }
    };
    const start = async (sql: string, stream: boolean): Promise<DuckDBPendingResult> => {
      const pending = stream ? await conn.startStream(sql) : await conn.start(sql);
      if (signal?.aborted) interrupt();
      return pending;
    };
    const call: CallConnection = {
      run: async (sql) => {
        await (await start(sql, false)).getResult();
      },
      runAndReadAll: async (sql) => await (await start(sql, false)).readAll(),
      runAndReadUntil: async (sql, rows) => await (await start(sql, false)).readUntil(rows),
      streamAndReadUntil: async (sql, rows) => await (await start(sql, true)).readUntil(rows),
    };
    signal?.addEventListener('abort', interrupt, { once: true });

    try {
      signal?.throwIfAborted();
      const result = await fn(call);
      signal?.throwIfAborted();
      return result;
    } catch (err) {
      if (signal?.aborted) throw cancelledError(cancelledMessage, err);
      throw this.classify(err, record);
    } finally {
      signal?.removeEventListener('abort', interrupt);
      try {
        conn.closeSync();
      } catch {
        /* Connection may already be torn down by interrupt. */
      }
    }
  }

  /**
   * The columns of the staged object `tableName`, in declaration order, read
   * from `duckdb_columns()` for the reason {@link STAGED_OBJECTS} gives: the
   * rows `information_schema.columns` holds for it.
   */
  private async columnRows(
    connection: StatementReader,
    tableName: string,
  ): Promise<{ column_name: string; data_type: string; is_nullable: boolean }[]> {
    const reader = await connection.runAndReadAll(
      `SELECT column_name, data_type, is_nullable FROM duckdb_columns() WHERE schema_name = 'main' AND NOT internal AND table_name = '${escapeSqlString(tableName)}' ORDER BY column_index`,
    );
    return reader.getRowObjectsJson() as {
      column_name: string;
      data_type: string;
      is_nullable: boolean;
    }[];
  }

  private async columnNames(connection: StatementReader, tableName: string): Promise<string[]> {
    return (await this.columnRows(connection, tableName)).map((c) => c.column_name);
  }

  /**
   * The rejection for a statement that failed to parse or prepare, `read`
   * whether it is a read: the engine's refusal of a file outside the canvas's
   * directories is `sql_read_only` whatever the statement, a read surfaces the
   * engine message (the SQL itself is probably wrong) with the recovery its
   * error class calls for, anything else is rejected as non-SELECT. Host
   * directories are redacted throughout.
   */
  private prepareFailure(err: unknown, record: CanvasRecord, read: boolean): McpError {
    const classified = this.classify(err, record);
    if (
      classified instanceof McpError &&
      classified.data?.reason === DUCKDB_ERROR_REASONS.sqlReadOnly
    ) {
      return classified;
    }
    if (read && err instanceof Error) {
      const binderMessage = redactPaths(err.message.trim(), this.hostPaths(record));
      return validationError(
        `Canvas query failed to prepare: ${binderMessage}`,
        {
          reason: SQL_GATE_REASONS.invalidSql,
          statementType: 'UNKNOWN',
          binderMessage,
          recovery: { hint: prepareFailureRecovery(binderMessage) },
        },
        { cause: err },
      );
    }
    return validationError(
      'Canvas query must be SELECT; the statement could not be parsed or prepared.',
      {
        reason: SQL_GATE_REASONS.nonSelectStatement,
        statementType: 'UNKNOWN',
        ...gateRecovery(SQL_GATE_REASONS.nonSelectStatement),
      },
    );
  }

  /**
   * Run the same five-layer read-only gate `query()` enforces, against an
   * arbitrary SELECT string. Used by `query()` and `registerView()` so view
   * definitions inherit query-level safety.
   */
  private async assertReadOnlySql(
    record: CanvasRecord,
    sql: string,
    duck: DuckDBModule,
    options?: { denySystemCatalogs?: boolean },
  ): Promise<void> {
    const statementType = await this.assertStatementGated(record, sql, duck, options, 0);

    // Layer 5: walk the plan with the allowlist + denied-function rescan. The
    // plan of a statement holds the plan of each query() literal it runs.
    // Fail closed: EXPLAIN itself can throw for statements that parse as SELECT
    // but cannot produce a plan (e.g. bare `PRAGMA show_tables`). Treat any
    // EXPLAIN failure as a non-SELECT rejection rather than letting the raw
    // engine error escape as InternalError (-32603).
    let planJson: unknown;
    try {
      planJson = await this.runExplain(record.controlConnection, `EXPLAIN (FORMAT JSON) ${sql}`);
    } catch {
      throw validationError('Canvas query must be SELECT; the statement could not be explained.', {
        reason: SQL_GATE_REASONS.nonSelectStatement,
        statementType,
        ...gateRecovery(SQL_GATE_REASONS.nonSelectStatement),
      });
    }
    assertPlanReadOnly(planJson);
  }

  /**
   * Gate layers 0-4 over `sql`, `depth` `query()` string literals below the
   * statement the caller sent, then over the SQL of each `query()` literal it
   * holds, one level deeper. The text layers cannot see inside a literal, so
   * its SQL passes every layer here as a statement of its own. Returns the
   * statement type of `sql`.
   */
  private async assertStatementGated(
    record: CanvasRecord,
    sql: string,
    duck: DuckDBModule,
    options: { denySystemCatalogs?: boolean } | undefined,
    depth: number,
  ): Promise<string> {
    assertTextGated(sql, options);

    // Layers 2-3: parse and type-check before EXPLAIN. Fail closed: a statement
    // that cannot be parsed or prepared is rejected (see `prepareRejection`).
    // A PIVOT without an IN list creates a type before its SELECT runs, so it
    // is never one SELECT: refused before it is prepared, naming the list.
    let statementCount: number;
    let statementType: string;
    let tree: unknown;
    try {
      const extracted = await record.controlConnection.extractStatements(sql);
      statementCount = extracted.count;
      if (statementCount === 1) {
        // DuckDB's serializer represents only a SELECT, so a statement it cannot
        // represent is refused here, before it is prepared, with one refusal.
        tree = await this.parseTree(record.controlConnection, sql);
        if (tree === undefined) {
          assertNoPivot(sql);
          throw validationError('Canvas query must be SELECT.', {
            reason: SQL_GATE_REASONS.nonSelectStatement,
            statementType: 'UNKNOWN',
            ...gateRecovery(SQL_GATE_REASONS.nonSelectStatement),
          });
        }
        let prepared: { statementType: number; destroySync(): void } | undefined;
        try {
          prepared = await extracted.prepare(0);
          const typeInt = prepared.statementType;
          statementType = duck.StatementType[typeInt] ?? 'UNKNOWN';
        } catch (prepErr) {
          throw await this.prepareRejection(record, tree, prepErr, options, depth);
        } finally {
          prepared?.destroySync();
        }
      } else {
        assertNoPivot(sql);
        statementType = 'UNKNOWN';
      }
    } catch (err) {
      // Re-throw NotFound (missing_table) and any ValidationError we just threw;
      // only fall through to the generic non-SELECT path for unexpected errors.
      // instanceof McpError, not a loose `'code' in err` — engine/Node errors
      // can carry errno-style `code` props and must not escape the gate raw.
      // What remains is a statement DuckDB failed to extract: with no parse
      // tree to say whether it is a read, its opening does.
      if (err instanceof McpError) throw err;
      throw this.prepareFailure(err, record, isReadShaped(sql));
    }
    assertSelectOnly({ statementCount, statementType });

    // Layer 4: DuckDB resolves setting reads, SQL or a table named in a
    // string, and a file named as a table while binding, so none of them need
    // leave a plan node; they are refused in its own parse of the statement.
    // query() over a plain string literal is admitted here, its SQL gated below.
    for (const literal of this.parsedLiterals(tree, record)) {
      assertQueryNesting(depth + 1);
      await this.assertStatementGated(record, literal, duck, options, depth + 1);
    }
    return statementType;
  }

  /**
   * The rejection for a single statement that failed to prepare, `tree` its
   * parse tree. DuckDB's serializer represents only a SELECT, so holding a tree
   * makes the statement a read, whatever it opens with. Layer 4 reads the
   * statement first, so a statement it refuses fails the same way whether or
   * not it prepares, and whatever the engine said: a file reference fails alike
   * whether the file is inside the engine's directories or outside them, and
   * whether or not it exists, can be read, or holds what its reader expects.
   * The name a catalog miss reports is the one reference layer 4 passes over,
   * since DuckDB looked it up as a table rather than reading it as a file —
   * unless it holds a path separator, which no staged name can. What remains is
   * the engine's refusal of a file outside its directories, a missing table,
   * then {@link prepareFailure}.
   */
  private async prepareRejection(
    record: CanvasRecord,
    tree: unknown,
    err: unknown,
    options: { denySystemCatalogs?: boolean } | undefined,
    depth: number,
  ): Promise<McpError> {
    const missing = err instanceof Error ? catalogMissName(err.message) : undefined;
    const skip = missing !== undefined && !/[/\\]/.test(missing) ? missing : undefined;
    await this.assertParsedGated(record, tree, options, depth, skip);
    const classified = this.classify(err, record);
    if (
      classified instanceof McpError &&
      classified.data?.reason === DUCKDB_ERROR_REASONS.sqlReadOnly
    ) {
      return classified;
    }
    // DuckDB raises a Catalog error at prepare time when the referenced table
    // doesn't exist. Surface a structured NotFound so the agent knows to
    // re-stage rather than blaming the SQL shape. Only the table form
    // qualifies: a missing function, table function, type, collation, or
    // schema is a Catalog error too, but the SQL is what is wrong, so it falls
    // through to invalid_sql with the binder detail (#484). A schema miss is
    // phrased "Table with name "s.t" does not exist because schema …", without
    // the closing `!`. The name is captured whole, since a quoted one can
    // contain spaces. A DROP/DELETE/INSERT/UPDATE/ALTER naming a missing table
    // never gets here: the serializer cannot represent it, so it is refused
    // before it is prepared. A name holding a path separator can never be
    // staged: it names a file, and is refused as one whether or not anything
    // is there.
    if (err instanceof Error) {
      const tableName = err.message.match(
        /Catalog Error: Table with name (.+?) does not exist!/,
      )?.[1];
      if (tableName?.includes('/') || tableName?.includes('\\')) {
        return this.fileReferenceRejection(tableName, record);
      }
      if (tableName) return missingTableError(tableName, err);
    }
    return this.prepareFailure(err, record, true);
  }

  /**
   * Every gate layer that does not need a statement to prepare: layer 4 over
   * `tree`, then layers 0, 1, and 4 over each `query()` literal it holds, one
   * level deeper. A literal the serializer cannot represent holds nothing for
   * layer 4 to read. `skip` is the name a catalog miss reported, at any depth.
   */
  private async assertParsedGated(
    record: CanvasRecord,
    tree: unknown,
    options: { denySystemCatalogs?: boolean } | undefined,
    depth: number,
    skip: string | undefined,
  ): Promise<void> {
    for (const literal of this.parsedLiterals(tree, record, skip)) {
      assertQueryNesting(depth + 1);
      assertTextGated(literal, options);
      const literalTree = await this.parseTree(record.controlConnection, literal);
      if (literalTree !== undefined) {
        await this.assertParsedGated(record, literalTree, options, depth + 1, skip);
      }
    }
  }

  /**
   * Layer 4 over `tree`: refuses a denied call and a table reference that
   * names a file, passing over references named `skip`; returns the SQL of
   * each admitted `query()` literal, in walk order, for the caller to gate.
   */
  private parsedLiterals(tree: unknown, record: CanvasRecord, skip?: string): string[] {
    const literals = assertNoDeniedParsedFunctions(tree);
    const file = findFileReference(tree, skip);
    if (file !== undefined) throw this.fileReferenceRejection(file, record);
    return literals;
  }

  /**
   * The refusal of a table reference that names a file: the reason the engine
   * gives a file outside its directories, host directories redacted.
   */
  private fileReferenceRejection(name: string, record: CanvasRecord): McpError {
    return validationError(
      `Canvas SQL rejected: "${redactPaths(name, this.hostPaths(record))}" names a file, not a staged table.`,
      {
        reason: DUCKDB_ERROR_REASONS.sqlReadOnly,
        recovery: { hint: SQL_READ_ONLY_RECOVERY },
      },
    );
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
      `SELECT o.kind FROM ${STAGED_OBJECTS} o WHERE o.name = '${escapeSqlString(name)}' LIMIT 1`,
    );
    const rows = reader.getRowObjectsJson() as { kind: CanvasObjectKind }[];
    return rows[0]?.kind;
  }

  /**
   * Materialize `COUNT(*)` against a (validated) table or view name. DuckDB
   * returns BIGINT as a JSON string; this helper centralizes the `Number(...)`
   * coercion so callers see a plain `number`.
   */
  private async countRows(connection: StatementReader, name: string): Promise<number> {
    const reader = await connection.runAndReadAll(
      `SELECT COUNT(*) AS n FROM ${quoteIdentifier(name)}`,
    );
    const row = reader.getRowObjectsJson()[0] as { n: number | string } | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * `sql` as DuckDB's own parser reads it, via `json_serialize_sql`;
   * `undefined` when the serializer cannot represent it, as it cannot
   * represent anything but a SELECT.
   */
  private async parseTree(connection: DuckDBConnection, sql: string): Promise<unknown> {
    const reader = await connection.runAndReadAll(
      'SELECT json_serialize_sql($1::VARCHAR) AS tree',
      [sql],
    );
    const tree = reader.getRowObjectsJson()[0]?.tree;
    if (typeof tree !== 'string') {
      throw databaseError(
        'json_serialize_sql returned an unexpected shape; the canvas parse-tree check cannot run safely.',
      );
    }
    const parsed = JSON.parse(tree) as { error?: unknown };
    return parsed.error === false ? parsed : undefined;
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

/**
 * Map DuckDB `duckdb_columns().data_type` strings back to
 * {@link ColumnType}. A numeric type takes the tag that holds every one of its
 * values exactly; one no tag holds (`UBIGINT`, `HUGEINT`, `UHUGEINT`,
 * `DECIMAL`, `BIGNUM`) falls to `VARCHAR`, the form its query values take.
 */
function dataTypeToColumnType(dataType: string): ColumnType {
  const upper = dataType.toUpperCase();
  if (upper.startsWith('VARCHAR') || upper === 'STRING' || upper === 'TEXT') return 'VARCHAR';
  if (upper === 'INTEGER' || upper === 'INT' || upper === 'INT4') return 'INTEGER';
  if (upper === 'TINYINT' || upper === 'SMALLINT' || upper === 'UTINYINT' || upper === 'USMALLINT')
    return 'INTEGER';
  if (upper === 'BIGINT' || upper === 'INT8' || upper === 'LONG' || upper === 'UINTEGER')
    return 'BIGINT';
  if (upper === 'DOUBLE' || upper === 'FLOAT8' || upper === 'REAL' || upper === 'FLOAT')
    return 'DOUBLE';
  if (upper === 'BOOLEAN' || upper === 'BOOL') return 'BOOLEAN';
  // Every TIMESTAMP variant (`_S`, `_MS`, `_NS`, `WITH TIME ZONE`), but not a list or array of one.
  if (upper.startsWith('TIMESTAMP') && !upper.endsWith(']')) return 'TIMESTAMP';
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

/**
 * Gate layers 0 and 1, the text scans. Optional layer 0 rejects system catalog
 * references on shared canvases where handle possession is the access
 * boundary. Layer 1 rejects deny-listed calls by name: read_json/read_parquet/…
 * lower into generic scans that pass the operator allowlist.
 */
function assertTextGated(sql: string, options: { denySystemCatalogs?: boolean } | undefined): void {
  if (options?.denySystemCatalogs) assertNoSystemCatalogs(sql);
  assertNoDeniedFunctions(sql);
}

const QUERY_CANCELLED = 'Canvas query was cancelled.';
const EXPORT_CANCELLED = 'Canvas export was cancelled.';
const VIEW_CANCELLED = 'Canvas view registration was cancelled.';
const IMPORT_CANCELLED = 'Canvas import was cancelled.';
const DESCRIBE_CANCELLED = 'Canvas describe was cancelled.';

/** `Timeout` with reason `cancelled`: how a canvas call rejects once its caller aborts. */
function cancelledError(message: string, cause?: unknown): McpError {
  return timeout(message, { reason: 'cancelled' }, cause === undefined ? undefined : { cause });
}

/** Rejects a call whose caller already aborted the same way an abort mid-execution does. */
function throwIfCancelled(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) throw cancelledError(message, signal.reason);
}

/**
 * The canvas's staged tables and views, one row each with its `name` and
 * `kind`: the rows `information_schema.tables` holds for schema `main`, every
 * table and every view DuckDB did not create itself. Read from DuckDB's
 * catalog table functions because `information_schema` reads the
 * `duckdb_views` and `duckdb_columns` views by bare name, which an object
 * staged under either name shadows (#862); no staged name shadows a table
 * function call.
 */
const STAGED_OBJECTS = `(SELECT table_name AS name, 'table' AS kind FROM duckdb_tables() WHERE schema_name = 'main' UNION ALL SELECT view_name, 'view' FROM duckdb_views() WHERE schema_name = 'main' AND NOT internal)`;

/**
 * `name` as a table of the canvas's own database, for a drop that may find
 * nothing there: a bare or `main.`-qualified name with no staged object
 * behind it resolves to the DuckDB system view of that name, if there is one,
 * and the drop fails on it (#862).
 */
function ownTableName(record: CanvasRecord, name: string): string {
  return `${quoteIdentifier(record.database)}.main.${quoteIdentifier(name)}`;
}

/**
 * Rejects a `registerAs` onto a name a staged table or view holds exactly. A
 * name staged after this check, or in another letter case, fails the CTAS
 * itself, which `query()` maps to the same rejection.
 */
async function ensureTableMissing(connection: DuckDBConnection, tableName: string): Promise<void> {
  const reader = await connection.runAndReadAll(
    `SELECT 1 FROM ${STAGED_OBJECTS} o WHERE o.name = '${escapeSqlString(tableName)}' LIMIT 1`,
  );
  if (reader.getRowsJson().length > 0) throw registerAsClash(tableName);
}

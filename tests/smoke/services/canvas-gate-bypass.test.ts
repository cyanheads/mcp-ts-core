/**
 * @fileoverview The canvas SQL gate against real DuckDB, for reads the text
 * deny-list cannot see: quoted table-function names, replacement scans over a
 * quoted path, functions that run a SQL string, smuggling through LATERAL /
 * CTE / UNION, catalog views referenced without parentheses, and functions
 * that read engine settings. A planted file outside the canvas holds a marker
 * no refusal may echo, and every entry point that runs the gate — `query()`,
 * `registerView()`, and `query({ registerAs })` — must refuse every input
 * before creating anything. The engine reads and writes only under the export
 * root and the canvas scratch directory, so a read naming any other path is
 * refused by the engine itself, as `sql_read_only`, before the plan walk.
 * @module tests/smoke/services/canvas-gate-bypass.test
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CanvasInstance } from '@/services/canvas/core/CanvasInstance.js';
import { CanvasRegistry } from '@/services/canvas/core/CanvasRegistry.js';
import { DataCanvas } from '@/services/canvas/core/DataCanvas.js';
import {
  classifyDuckdbError,
  DuckdbProvider,
} from '@/services/canvas/providers/duckdb/DuckdbProvider.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

const ctx: RequestContext = {
  requestId: 'smoke-canvas-gate-bypass',
  timestamp: '2026-01-01T00:00:00.000Z',
  tenantId: 'smoke-tenant',
};

/** Written into the planted file's data row; no refusal may contain it. */
const MARKER = 'CANVAS_GATE_MARKER_7f3a';

/** The header of a file under the export root; no refusal may contain it. */
const INSIDE_MARKER = 'canvas_inside_column_9c1e';

let canvas: DataCanvas;
let provider: DuckdbProvider;
let instance: CanvasInstance;
let exportRoot: string;
let inside: string;
let siblingDir: string;
let plantedDir: string;
let planted: string;
let scratchParent: string;

beforeAll(async () => {
  exportRoot = await mkdtemp(join(tmpdir(), 'canvas-gate-export-'));
  // Stands in for an earlier export, which the engine may read.
  inside = join(exportRoot, 'inside.csv');
  await writeFile(inside, `${INSIDE_MARKER},n\n${MARKER},1\n`);
  // Shares the export root's name as a prefix: an allow-list matched on the
  // string rather than on whole directories would admit it.
  siblingDir = `${exportRoot}-sibling`;
  await mkdir(siblingDir);
  await writeFile(join(siblingDir, 'planted.csv'), `label,n\n${MARKER},1\n`);
  plantedDir = await mkdtemp(join(tmpdir(), 'canvas-gate-planted-'));
  planted = join(plantedDir, 'planted.csv');
  await writeFile(planted, `label,n\n${MARKER},1\n`);
  scratchParent = await mkdtemp(join(tmpdir(), 'canvas-gate-scratch-'));

  provider = new DuckdbProvider({
    memoryLimitMb: 128,
    exportRootPath: exportRoot,
    defaultRowLimit: 100,
    schemaSniffRows: 10,
    tempRootPath: scratchParent,
  });
  const registry = new CanvasRegistry(provider, {
    ttlMs: 60_000,
    absoluteCapMs: 600_000,
    maxCanvasesPerTenant: 10,
    sweeperIntervalMs: 0,
  });
  canvas = new DataCanvas(provider, registry);
  instance = await canvas.acquire(undefined, ctx);
  await instance.registerTable('t', [{ x: 1 }]);
});

afterAll(async () => {
  if (canvas) await canvas.shutdown(ctx);
  await rm(exportRoot, { recursive: true, force: true });
  await rm(siblingDir, { recursive: true, force: true });
  await rm(plantedDir, { recursive: true, force: true });
  await rm(scratchParent, { recursive: true, force: true });
});

/** The canvas's DuckDB record, reached past the gate for the ungated controls. */
function recordOf(canvasId: string) {
  // biome-ignore lint/complexity/useLiteralKeys: deliberate access to the private record to bypass the gate for the control read.
  const record = provider['canvases'].get(canvasId);
  if (!record) throw new Error(`No canvas record for ${canvasId}.`);
  return record;
}

type Corpus = ReadonlyArray<readonly [label: string, sql: () => string]>;

/** Reads naming a path outside the export root and scratch directory. Builders, so each SQL string is formed once the paths exist. */
const OUTSIDE_PATH_READS: Corpus = [
  ['a replacement scan over a quoted path', () => `SELECT * FROM '${planted}'`],
  ['a FROM-first replacement scan', () => `FROM '${planted}'`],
  ['a replacement scan over a glob', () => `SELECT * FROM '${plantedDir}/*.csv'`],
  ['a quoted read_csv', () => `SELECT * FROM "read_csv"('${planted}')`],
  ['a quoted, uppercase READ_CSV', () => `SELECT * FROM "READ_CSV"('${planted}')`],
  ['a quoted read_csv_auto', () => `SELECT * FROM "read_csv_auto"('${planted}')`],
  ['a quoted read_text', () => `SELECT * FROM "read_text"('${planted}')`],
  ['a quoted read_blob', () => `SELECT * FROM "read_blob"('${planted}')`],
  ['a quoted read_json_objects', () => `SELECT * FROM "read_json_objects"('${planted}')`],
  ['a quoted glob', () => `SELECT * FROM "glob"('${plantedDir}/*')`],
  ['a quoted parquet_metadata', () => `SELECT * FROM "parquet_metadata"('${planted}')`],
  [
    'query() running a deny-listed call inside a string',
    () => `SELECT * FROM query('SELECT * FROM read_csv(''${planted}'')')`,
  ],
  ['query_table() over a path', () => `SELECT * FROM query_table('${planted}')`],
  [
    'a quoted read_csv behind LATERAL',
    () => `SELECT * FROM t, LATERAL (SELECT * FROM "read_csv"('${planted}'))`,
  ],
  [
    'a quoted read_csv inside a CTE',
    () => `WITH s AS (SELECT * FROM "read_csv"('${planted}')) SELECT * FROM s`,
  ],
  [
    'a quoted read_csv joined by UNION ALL BY NAME',
    () => `SELECT * FROM t UNION ALL BY NAME SELECT * FROM "read_csv"('${planted}')`,
  ],
  ['SUMMARIZE over a replacement scan', () => `SUMMARIZE SELECT * FROM '${planted}'`],
  [
    'a .. traversal out of the export root',
    () => `SELECT * FROM '${exportRoot}/../${basename(plantedDir)}/planted.csv'`,
  ],
  [
    'a sibling directory sharing the export root as a name prefix',
    () => `SELECT * FROM '${siblingDir}/planted.csv'`,
  ],
  [
    'a replacement scan inside a query() literal',
    () => `SELECT * FROM query('SELECT * FROM ''${planted}''')`,
  ],
];

/**
 * Reads of a file under the export root, which the engine may open. Each binds
 * the file's columns while no plan node names a reader — a DESCRIBE, or a scan
 * the optimizer removes — so the parse tree is the layer that refuses them.
 */
const INSIDE_ROOT_FILE_REFERENCES: Corpus = [
  ['DESCRIBE over a quoted path', () => `DESCRIBE '${inside}'`],
  ['SHOW over a quoted path', () => `SHOW '${inside}'`],
  ['DESCRIBE over a SELECT', () => `DESCRIBE SELECT * FROM '${inside}'`],
  ['a DESCRIBE subquery', () => `SELECT column_name FROM (DESCRIBE '${inside}')`],
  ['DESCRIBE over a glob', () => `DESCRIBE '${exportRoot}/*.csv'`],
  ['a replacement scan the optimizer removes', () => `SELECT * FROM '${inside}' WHERE false`],
  ['a replacement scan under LIMIT 0', () => `SELECT * FROM '${inside}' LIMIT 0`],
  [
    'a double-quoted path with column aliases',
    () => `SELECT * FROM "${inside}" AS f(a) WHERE 1 = 0`,
  ],
  [
    'a path split into a schema and a table name',
    () => `SELECT * FROM "${exportRoot}/inside".csv WHERE false`,
  ],
  [
    'a replacement scan inside a query() literal',
    () => `SELECT * FROM query('SELECT * FROM ''${inside}'' WHERE false')`,
  ],
  [
    'DESCRIBE of a quoted path inside a query() literal',
    () => `SELECT * FROM query('DESCRIBE ''${inside}''')`,
  ],
  [
    'a replacement scan two query() literals deep',
    () => `SELECT * FROM query('SELECT * FROM query(''SELECT * FROM ''''${inside}'''' LIMIT 0'')')`,
  ],
];

/** Named readers of a file under the export root, spelled past the text scan. */
const INSIDE_ROOT_NAMED_READS: ReadonlyArray<
  readonly [label: string, fn: string, sql: () => string]
> = [
  [
    'a quoted read_csv the optimizer removes',
    'read_csv',
    () => `SELECT * FROM "read_csv"('${inside}') WHERE false`,
  ],
  [
    'DESCRIBE over a quoted read_csv_auto',
    'read_csv_auto',
    () => `DESCRIBE SELECT * FROM "read_csv_auto"('${inside}')`,
  ],
  [
    'query_table() over a quoted path',
    'query_table',
    () => `SELECT * FROM query_table('"${inside}"') WHERE false`,
  ],
  [
    'a quoted read_csv inside a query() literal',
    'read_csv',
    () => `SELECT * FROM query('SELECT * FROM "read_csv"(''${inside}'') WHERE false')`,
  ],
];

/** Plan-walk refusals: catalog and metadata reads that name no file. */
const PLAN_WALK_READS: Corpus = [
  ['the duckdb_tables view without parentheses', () => 'SELECT * FROM duckdb_tables'],
  ['the sqlite_schema view', () => 'SELECT * FROM sqlite_schema'],
  ['the pragma_database_list view without parentheses', () => 'SELECT * FROM pragma_database_list'],
  ['SHOW TABLES', () => 'SHOW TABLES'],
  ['a quoted duckdb_settings()', () => 'SELECT * FROM "duckdb_settings"()'],
  ['a quoted duckdb_temporary_files()', () => 'SELECT * FROM "duckdb_temporary_files"()'],
  ['duckdb_profiling_settings()', () => 'SELECT * FROM duckdb_profiling_settings()'],
  ['a quoted pragma_version()', () => 'SELECT * FROM "pragma_version"()'],
  ['a quoted pragma_table_info()', () => `SELECT * FROM "pragma_table_info"('t')`],
  ['SHOW TABLES inside a query() literal', () => `SELECT * FROM query('SHOW TABLES')`],
  [
    'a catalog view inside a query() literal',
    () => `SELECT * FROM query('SELECT * FROM duckdb_tables')`,
  ],
];

/**
 * Calls the parse tree refuses by name: functions DuckDB resolves while
 * binding — a settings read folds to a constant, `query()` inlines the plan of
 * its string, `query_table()` takes its table name from a string — so no plan
 * node names them, and a quoted file reader the text scan cannot see.
 */
const PARSED_FUNCTION_CALLS: ReadonlyArray<readonly [label: string, fn: string, sql: string]> = [
  ['current_setting()', 'current_setting', `SELECT current_setting('temp_directory') AS v`],
  [
    'current_setting() on the allow-list',
    'current_setting',
    `SELECT current_setting('allowed_directories') AS v`,
  ],
  ['a quoted current_setting()', 'current_setting', `SELECT "current_setting"('temp_directory')`],
  [
    'a quoted, uppercase CURRENT_SETTING()',
    'current_setting',
    `SELECT "CURRENT_SETTING"('temp_directory')`,
  ],
  [
    'a schema-qualified current_setting()',
    'current_setting',
    `SELECT system.main.current_setting('temp_directory')`,
  ],
  [
    'current_setting() after an escape string holding a quote',
    'current_setting',
    String.raw`SELECT E'\'' AS a, current_setting('temp_directory') AS v`,
  ],
  [
    'current_setting() after a string holding a comment opener',
    'current_setting',
    `SELECT '--' AS a, current_setting('temp_directory') AS v`,
  ],
  [
    'current_setting() behind a comment before the parenthesis',
    'current_setting',
    `SELECT current_setting/* x */('temp_directory') AS v`,
  ],
  ['current_schema()', 'current_schema', 'SELECT current_schema() AS v'],
  ['current_schemas()', 'current_schemas', 'SELECT current_schemas(true) AS v'],
  ['in_search_path()', 'in_search_path', `SELECT in_search_path('memory', 'main') AS v`],
  [
    'query() over a concatenated settings read',
    'query',
    `SELECT * FROM query('SELECT current_' || 'setting(''temp_directory'') AS v')`,
  ],
  ['a quoted query() over a cast literal', 'query', `SELECT * FROM "query"('SELECT 1'::VARCHAR)`],
  ['query() over a parameter', 'query', 'SELECT * FROM query($1)'],
  ['query() over a cast literal', 'query', `SELECT * FROM query('SELECT x FROM t'::VARCHAR)`],
  [
    'a concatenated query() nested inside a literal one',
    'query',
    `SELECT * FROM query('SELECT * FROM query(''SELECT current_'' || ''setting(''''temp_directory'''')'')')`,
  ],
  [
    'a settings read inside a query() literal',
    'current_setting',
    `SELECT * FROM query('SELECT current_setting(''temp_directory'') AS v')`,
  ],
  [
    'a settings read two query() literals deep',
    'current_setting',
    `SELECT * FROM query('SELECT * FROM query(''SELECT current_setting(''''temp_directory'''') AS v'')')`,
  ],
  [
    'query_table() inside a query() literal',
    'query_table',
    `SELECT * FROM query('SELECT * FROM query_table(''t'')')`,
  ],
  [
    'a pragma_* call inside a query() literal',
    'pragma_version',
    `SELECT * FROM query('SELECT * FROM pragma_version()')`,
  ],
  ['query_table()', 'query_table', `SELECT * FROM query_table('t')`],
  // sniff_csv opens its file only when it runs, so preparing it reaches no
  // engine refusal; the parse tree refuses it before anything opens the file.
  [
    'a quoted sniff_csv over an outside path',
    'sniff_csv',
    `SELECT * FROM "sniff_csv"('/no-such-dir/planted.csv')`,
  ],
];

/**
 * `query()` calls DuckDB itself refuses while preparing: a string that is not
 * one SELECT, a column argument, a second argument. Each is refused before the
 * parse-tree check runs, and carries only the binder's message.
 */
const QUERY_PREPARE_REFUSALS: Corpus = [
  ['query() over a DROP literal', () => `SELECT * FROM query('DROP TABLE t')`],
  ['query() over a SET literal', () => `SELECT * FROM query('SET threads = 1')`],
  ['query() over a two-statement literal', () => `SELECT * FROM query('SELECT 1; SELECT 2')`],
  ['query() over a column', () => 'SELECT * FROM t, query(x::VARCHAR)'],
  ['query() over two literals', () => `SELECT * FROM query('SELECT 1', 'SELECT 2')`],
];

/** `SELECT x FROM t` inside `levels` nested `query()` string literals. */
function nestedQuery(levels: number): string {
  let sql = 'SELECT x FROM t';
  for (let level = 0; level < levels; level++) {
    sql = `SELECT x FROM query('${sql.replaceAll("'", "''")}')`;
  }
  return sql;
}

/** Settles `run` and returns its rejection, failing the test when it resolves. */
async function refusalOf(run: () => Promise<unknown>): Promise<McpError> {
  const outcome = await run().then(
    (value) => ({ resolved: true as const, value }),
    (err: unknown) => ({ resolved: false as const, err }),
  );
  if (outcome.resolved) {
    throw new Error(
      `Expected the gate to refuse, but it resolved: ${JSON.stringify(outcome.value)}`,
    );
  }
  expect(outcome.err).toBeInstanceOf(McpError);
  return outcome.err as McpError;
}

/** The serialized refusal both client surfaces are built from. */
function surfaceOf(err: McpError): string {
  return JSON.stringify({ message: err.message, data: err.data });
}

const SQL_READ_ONLY_HINT =
  "Send a read-only SELECT over the staged tables — list them with this server's dataframe-describe tool. This surface reads no files and cannot create, alter, or drop anything.";

/**
 * The engine's refusal of an outside path: `sql_read_only`, the export root and
 * scratch directory redacted, nothing read from the planted file, and a hint
 * steering the caller back to the staged tables.
 */
function expectEngineRefusal(err: McpError): void {
  expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
  expect(err.data?.reason).toBe('sql_read_only');
  expect(err.message).toMatch(
    /^Canvas SQL rejected: Permission Error: Cannot access file ".*" - file system operations are disabled by configuration/,
  );
  expect((err.data?.recovery as { hint?: string } | undefined)?.hint).toBe(SQL_READ_ONLY_HINT);
  const surface = surfaceOf(err);
  expect(surface).not.toContain(MARKER);
  expect(surface).not.toContain(exportRoot);
  expect(surface).not.toContain(recordOf(instance.canvasId).scratchDir);
}

/**
 * The parse-tree refusal of a file reference: the engine's reason and hint,
 * the export root redacted, and nothing read from the file.
 */
function expectFileReferenceRefusal(err: McpError): void {
  expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
  expect(err.data?.reason).toBe('sql_read_only');
  expect(err.message).toMatch(
    /^Canvas SQL rejected: "\[path\]\/.+" names a file, not a staged table\.$/,
  );
  expect((err.data?.recovery as { hint?: string } | undefined)?.hint).toBe(SQL_READ_ONLY_HINT);
  const surface = surfaceOf(err);
  expect(surface).not.toContain(INSIDE_MARKER);
  expect(surface).not.toContain(MARKER);
  expect(surface).not.toContain(exportRoot);
}

/** The plan-walk refusal, carrying nothing read from the planted file. */
function expectPlanWalkRefusal(err: McpError): void {
  expect(err.data?.reason).toBe('plan_operator_not_allowed');
  expect(surfaceOf(err)).not.toContain(MARKER);
}

/** The parse-tree refusal naming the function, carrying no host directory. */
function expectParsedFunctionRefusal(err: McpError, fn: string): void {
  expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
  expect(err.data?.reason).toBe('denied_function');
  expect(err.data?.function).toBe(fn);
  const surface = surfaceOf(err);
  expect(surface).not.toContain(INSIDE_MARKER);
  expect(surface).not.toContain(exportRoot);
  expect(surface).not.toContain(scratchParent);
}

/**
 * Runs one refusal check through every entry point that gates SQL. `prefix`
 * keeps each group's view and table names apart on the shared canvas.
 */
function acrossEntryPoints<Row extends readonly [string, ...unknown[]]>(
  title: string,
  prefix: string,
  rows: ReadonlyArray<Row>,
  sqlOf: (row: Row) => string,
  check: (err: McpError, row: Row) => void,
): void {
  describe(title, () => {
    const cases = rows.map((row, i) => [row[0], row, i] as const);

    it.each(cases)('query() refuses %s', async (_label, row) => {
      check(await refusalOf(() => instance.query(sqlOf(row))), row);
    });

    it.each(cases)('registerView() refuses %s and creates no view', async (_label, row, i) => {
      const viewName = `${prefix}_v_${i}`;
      check(await refusalOf(() => instance.registerView(viewName, sqlOf(row))), row);
      expect(await instance.describe({ tableName: viewName })).toEqual([]);
    });

    it.each(cases)(
      'query({ registerAs }) refuses %s and materializes nothing',
      async (_label, row, i) => {
        const tableName = `${prefix}_ra_${i}`;
        check(await refusalOf(() => instance.query(sqlOf(row), { registerAs: tableName })), row);
        expect(await instance.describe({ tableName })).toEqual([]);
      },
    );
  });
}

describe('canvas · the engine reads only the export root and scratch directory', () => {
  // Control: the planted file is readable by a DuckDB instance configured as
  // the engine ships, so the refusals below are the canvas's configuration,
  // not an unreadable path.
  it('plants a file a default DuckDB instance can read', async () => {
    const plain = await DuckDBInstance.create(':memory:');
    const connection = await plain.connect();
    try {
      const reader = await connection.runAndReadAll(`SELECT * FROM '${planted}'`);
      expect(reader.getRowObjectsJson()).toEqual([{ label: MARKER, n: '1' }]);
    } finally {
      connection.closeSync();
      plain.closeSync();
    }
  });

  it('refuses the planted file on the canvas itself, with the gate not consulted', async () => {
    const record = recordOf(instance.canvasId);
    for (const sql of [
      `SELECT * FROM '${planted}'`,
      `SELECT * FROM read_text('${planted}')`,
      `SELECT * FROM '${siblingDir}/planted.csv'`,
    ]) {
      const failure = await record.controlConnection.runAndReadAll(sql).then(
        (reader) => reader.getRowObjectsJson(),
        (err: unknown) => err,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/^Permission Error: Cannot access file/);
      expect((failure as Error).message).not.toContain(MARKER);
    }
  });

  // sniff_csv opens its file only when it runs, so this refusal comes from
  // execution rather than prepare — the path `withConnection` classifies.
  it('classifies a refusal raised while executing as sql_read_only, host paths redacted', async () => {
    const record = recordOf(instance.canvasId);
    const sql = `SELECT * FROM sniff_csv('${exportRoot}/../${basename(plantedDir)}/planted.csv')`;
    const prepared = await record.controlConnection.prepare(sql);
    prepared.destroySync();
    const raw = await record.controlConnection.runAndReadAll(sql).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect((raw as Error).message).toContain(exportRoot);

    const classified = classifyDuckdbError(raw, [exportRoot, record.scratchDir]) as McpError;
    expectEngineRefusal(classified);
    expect(classified.cause).toBe(raw);
  });

  // Control for the file references the gate refuses: the engine itself binds
  // the columns of a file under the export root while planning no reader.
  it('binds the header of a file under the export root, with the gate not consulted', async () => {
    const record = recordOf(instance.canvasId);
    const emptied = await record.controlConnection.runAndReadAll(
      `SELECT * FROM '${inside}' WHERE false`,
    );
    expect(emptied.columnNames()).toEqual([INSIDE_MARKER, 'n']);
    const described = await record.controlConnection.runAndReadAll(`DESCRIBE '${inside}'`);
    expect(described.getRowObjectsJson().map((row) => row.column_name)).toEqual([
      INSIDE_MARKER,
      'n',
    ]);
  });

  it('refuses a COPY to an outside path through query() as sql_read_only and writes nothing', async () => {
    const target = join(plantedDir, 'copied.csv');
    const err = await refusalOf(() => instance.query(`COPY t TO '${target}'`));
    expect(err.data?.reason).toBe('sql_read_only');
    expect(existsSync(target)).toBe(false);
  });

  it('refuses an ATTACH outside those directories and creates no database file', async () => {
    const record = recordOf(instance.canvasId);
    const target = join(plantedDir, 'attached.duckdb');
    const failure = await record.controlConnection.run(`ATTACH '${target}' AS outside_db`).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/^Permission Error/);
    expect(existsSync(target)).toBe(false);
  });
});

describe('canvas · SQL gate refuses reads only the engine or the plan walk can see', () => {
  acrossEntryPoints(
    'outside-path reads',
    'outside',
    OUTSIDE_PATH_READS,
    ([, sql]) => sql(),
    (err) => expectEngineRefusal(err),
  );

  acrossEntryPoints(
    'file references under the export root',
    'inside',
    INSIDE_ROOT_FILE_REFERENCES,
    ([, sql]) => sql(),
    (err) => expectFileReferenceRefusal(err),
  );

  acrossEntryPoints(
    'named readers under the export root',
    'reader',
    INSIDE_ROOT_NAMED_READS,
    ([, , sql]) => sql(),
    (err, [, fn]) => expectParsedFunctionRefusal(err, fn),
  );

  acrossEntryPoints(
    'plan-walk reads',
    'plan',
    PLAN_WALK_READS,
    ([, sql]) => sql(),
    (err) => expectPlanWalkRefusal(err),
  );

  acrossEntryPoints(
    'functions resolved while binding',
    'parsed',
    PARSED_FUNCTION_CALLS,
    ([, , sql]) => sql,
    (err, [, fn]) => expectParsedFunctionRefusal(err, fn),
  );

  acrossEntryPoints(
    'query() over a string DuckDB refuses to prepare',
    'qprep',
    QUERY_PREPARE_REFUSALS,
    ([, sql]) => sql(),
    (err) => {
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data?.reason).toBe('invalid_sql');
      const surface = surfaceOf(err);
      expect(surface).not.toContain(exportRoot);
      expect(surface).not.toContain(scratchParent);
    },
  );

  acrossEntryPoints(
    'query() nested past the cap',
    'qnest',
    [['five nested query() literals', nestedQuery(5)] as const],
    ([, sql]) => sql,
    (err) => {
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data?.reason).toBe('denied_function');
      expect(err.data?.function).toBe('query');
      expect(err.message).toBe('Canvas query nests query() more than 4 levels deep.');
      expect((err.data?.recovery as { hint?: string } | undefined)?.hint).toBe(
        'Remove the function the message names — only the staged tables are queryable.',
      );
    },
  );

  it.each([
    ['query', (sql: string) => instance.query(sql, { denySystemCatalogs: true })],
    [
      'registerView',
      (sql: string) => instance.registerView('qcat_v', sql, { denySystemCatalogs: true }),
    ],
    [
      'query({ registerAs })',
      (sql: string) => instance.query(sql, { denySystemCatalogs: true, registerAs: 'qcat_ra' }),
    ],
  ])(
    '%s refuses a system catalog inside a query() literal under denySystemCatalogs',
    async (_entry, run) => {
      const err = await refusalOf(() =>
        run(`SELECT * FROM query('SELECT table_name FROM information_schema.tables')`),
      );
      expect(err.data?.reason).toBe('system_catalog_access');
      expect(err.data?.catalog).toBe('information_schema');
    },
  );

  it('runs up to four nested query() literals', async () => {
    expect((await instance.query(nestedQuery(4))).rows).toEqual([{ x: '1' }]);
  });

  it('passes a function name that appears only as data or as a column name', async () => {
    const result = await instance.query(
      `SELECT 'current_setting(''temp_directory'')' AS s, 'query(x)' AS q, x AS current_setting FROM t`,
    );
    expect(result.rows).toEqual([
      { s: "current_setting('temp_directory')", q: 'query(x)', current_setting: '1' },
    ]);
  });

  it.each([
    ['a schema-qualified table', 'SELECT x FROM main.t', '1'],
    ['a catalog-qualified table', 'SELECT x FROM memory.main.t', '1'],
    [
      'a quoted CTE name',
      'WITH "staged rows" AS (SELECT x FROM t) SELECT x FROM "staged rows"',
      '1',
    ],
    ['DESCRIBE over a staged table', 'SELECT column_name AS x FROM (DESCRIBE t)', 'x'],
    ['a quoted query() over a literal', `SELECT x FROM "query"('SELECT x FROM t')`, '1'],
    ['a dollar-quoted query() literal', 'SELECT x FROM query($$SELECT x FROM t$$)', '1'],
    ['a schema-qualified query() literal', `SELECT x FROM main.query('SELECT x FROM t')`, '1'],
  ])('passes %s', async (_label, sql, x) => {
    expect((await instance.query(sql)).rows).toEqual([{ x }]);
  });
});

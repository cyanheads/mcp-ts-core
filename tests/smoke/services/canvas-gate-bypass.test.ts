/**
 * @fileoverview The canvas SQL gate against real DuckDB, for reads the text
 * deny-list cannot see: quoted table-function names, replacement scans over a
 * quoted path, functions that run a SQL string, smuggling through LATERAL /
 * CTE / UNION, catalog views referenced without parentheses, and functions
 * that read engine settings, called or written bare. A planted file outside the canvas holds a marker
 * no refusal may echo, and every entry point that runs the gate — `query()`,
 * `registerView()`, and `query({ registerAs })` — must refuse every input
 * before creating anything. The engine reads and writes only under the export
 * root and the canvas scratch directory and refuses any other path itself, but
 * the parse-tree layer answers first: a statement naming a file fails the same
 * way wherever the file is and whatever state it is in. SHOW over staged
 * tables, the internal metadata views under `denySystemCatalogs`, and the text
 * scans' reading of string literals and comments are pinned here too.
 * @module tests/smoke/services/canvas-gate-bypass.test
 */

import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { DuckDBInstance, version as duckdbVersion } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CanvasInstance } from '@/services/canvas/core/CanvasInstance.js';
import { CanvasRegistry } from '@/services/canvas/core/CanvasRegistry.js';
import { DataCanvas } from '@/services/canvas/core/DataCanvas.js';
import {
  assertNoDeniedFunctions,
  BARE_FUNCTION_KEYWORDS,
  collectPlanViolations,
  INTERNAL_METADATA_VIEWS,
} from '@/services/canvas/core/sqlGate.js';
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
  // Columns named after denied functions, one of which DuckDB also binds bare.
  await instance.registerTable('c', [{ current_schema: 'staged' }]);
  await instance.registerTable('q', [{ query: 'q1', current_setting: 's1' }]);
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

/**
 * Reads naming a path outside the export root and scratch directory, each with
 * the function its refusal names, if it is refused by name rather than as a
 * file reference. The engine refuses every one of these paths, but the
 * parse-tree layer answers first, so each statement fails as it would naming a
 * file inside those directories. Builders, so each SQL string is formed once
 * the paths exist.
 */
const OUTSIDE_PATH_READS: ReadonlyArray<readonly [label: string, sql: () => string, fn?: string]> =
  [
    ['a replacement scan over a quoted path', () => `SELECT * FROM '${planted}'`],
    ['a FROM-first replacement scan', () => `FROM '${planted}'`],
    ['a replacement scan over a glob', () => `SELECT * FROM '${plantedDir}/*.csv'`],
    ['a quoted read_csv', () => `SELECT * FROM "read_csv"('${planted}')`, 'read_csv'],
    ['a quoted, uppercase READ_CSV', () => `SELECT * FROM "READ_CSV"('${planted}')`, 'read_csv'],
    [
      'a quoted read_csv_auto',
      () => `SELECT * FROM "read_csv_auto"('${planted}')`,
      'read_csv_auto',
    ],
    ['a quoted read_text', () => `SELECT * FROM "read_text"('${planted}')`, 'read_text'],
    ['a quoted read_blob', () => `SELECT * FROM "read_blob"('${planted}')`, 'read_blob'],
    [
      'a quoted read_json_objects',
      () => `SELECT * FROM "read_json_objects"('${planted}')`,
      'read_json_objects',
    ],
    ['a quoted glob', () => `SELECT * FROM "glob"('${plantedDir}/*')`, 'glob'],
    [
      'a quoted parquet_metadata',
      () => `SELECT * FROM "parquet_metadata"('${planted}')`,
      'parquet_metadata',
    ],
    [
      'a quoted read_single_csv_file',
      () => `SELECT * FROM "read_single_csv_file"('${planted}')`,
      'read_single_csv_file',
    ],
    [
      'query() running a deny-listed call inside a string',
      () => `SELECT * FROM query('SELECT * FROM read_csv(''${planted}'')')`,
      'read_csv',
    ],
    ['query_table() over a path', () => `SELECT * FROM query_table('${planted}')`, 'query_table'],
    [
      'a quoted read_csv behind LATERAL',
      () => `SELECT * FROM t, LATERAL (SELECT * FROM "read_csv"('${planted}'))`,
      'read_csv',
    ],
    [
      'a quoted read_csv inside a CTE',
      () => `WITH s AS (SELECT * FROM "read_csv"('${planted}')) SELECT * FROM s`,
      'read_csv',
    ],
    [
      'a quoted read_csv joined by UNION ALL BY NAME',
      () => `SELECT * FROM t UNION ALL BY NAME SELECT * FROM "read_csv"('${planted}')`,
      'read_csv',
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
 * the file's columns while no plan node names a reader — a DESCRIBE, a SHOW, or
 * a scan the optimizer removes — so the parse tree is the layer that refuses
 * them. DuckDB v2.0 fails `SHOW '<path>'` as a catalog lookup before any file
 * opens; a name holding a path separator is still a file reference.
 */
const INSIDE_ROOT_FILE_REFERENCES: Corpus = [
  ['SHOW over a quoted path', () => `SHOW '${inside}'`],
  ['DESCRIBE over a quoted path', () => `DESCRIBE '${inside}'`],
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
  // DuckDB v2.0 binds the file's columns here and plans the scan away to
  // EMPTY_RESULT, so only the deny-list refuses it.
  [
    'a quoted read_single_csv_file the optimizer removes',
    'read_single_csv_file',
    () => `SELECT * FROM "read_single_csv_file"('${inside}') WHERE false`,
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
  ['SHOW ALL TABLES', () => 'SHOW ALL TABLES'],
  ['SHOW DATABASES', () => 'SHOW DATABASES'],
  ['a quoted duckdb_settings()', () => 'SELECT * FROM "duckdb_settings"()'],
  ['a quoted duckdb_temporary_files()', () => 'SELECT * FROM "duckdb_temporary_files"()'],
  ['duckdb_profiling_settings()', () => 'SELECT * FROM duckdb_profiling_settings()'],
  ['SHOW TABLES inside a query() literal', () => `SELECT * FROM query('SHOW TABLES')`],
  [
    'a catalog view inside a query() literal',
    () => `SELECT * FROM query('SELECT * FROM duckdb_tables')`,
  ],
];

/**
 * Series called with a column or a subquery argument, each with an operator its
 * refusal must name. Only a constant-argument call plans as `RANGE` or
 * `GENERATE_SERIES`; these plan as `INOUT_FUNCTION`, and a subquery's own
 * operators stay in the plan the walk reads.
 */
const SERIES_PLAN_REFUSALS: ReadonlyArray<readonly [label: string, sql: string, operator: string]> =
  [
    ['a lateral range(t.x)', 'SELECT t.x, r.range FROM t, range(t.x) r', 'INOUT_FUNCTION'],
    [
      'a lateral generate_series(1, t.x)',
      'SELECT * FROM t, generate_series(1, t.x)',
      'INOUT_FUNCTION',
    ],
    ['a subquery argument', 'SELECT * FROM range((SELECT max(x) FROM t))', 'INOUT_FUNCTION'],
    [
      'a catalog read in a subquery argument',
      'SELECT * FROM range((SELECT count(*) FROM duckdb_settings()))',
      'DUCKDB_SETTINGS',
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
    'current_setting() in a range() argument',
    'current_setting',
    `SELECT * FROM range(length(current_setting('temp_directory')))`,
  ],
  [
    'query() over a concatenated settings read',
    'query',
    `SELECT * FROM query('SELECT current_' || 'setting(''temp_directory'') AS v')`,
  ],
  ['a quoted query() over a cast literal', 'query', `SELECT * FROM "query"('SELECT 1'::VARCHAR)`],
  ['query() over a parameter', 'query', 'SELECT * FROM query($1)'],
  // DuckDB refuses these two while preparing; the parse tree refuses them first.
  ['query() over a column', 'query', 'SELECT * FROM t, query(x::VARCHAR)'],
  ['query() over two literals', 'query', `SELECT * FROM query('SELECT 1', 'SELECT 2')`],
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
  ['a quoted pragma_version()', 'pragma_version', 'SELECT * FROM "pragma_version"()'],
  ['a quoted pragma_table_info()', 'pragma_table_info', `SELECT * FROM "pragma_table_info"('t')`],
  ['a quoted pragma_show()', 'pragma_show', `SELECT * FROM "pragma_show"('t')`],
  ['a quoted, uppercase PRAGMA_SHOW()', 'pragma_show', `SELECT * FROM "PRAGMA_SHOW"('t')`],
  ['a schema-qualified pragma_show()', 'pragma_show', `SELECT * FROM main."pragma_show"('t')`],
  [
    'a quoted pragma_show() inside a query() literal',
    'pragma_show',
    `SELECT * FROM query('SELECT * FROM "pragma_show"(''t'')')`,
  ],
  ['query_table()', 'query_table', `SELECT * FROM query_table('t')`],
  [
    'deregister_external_resource()',
    'deregister_external_resource',
    `SELECT * FROM deregister_external_resource('x')`,
  ],
  // sniff_csv opens its file only when it runs, so preparing it reaches no
  // engine refusal; the parse tree refuses it before anything opens the file.
  [
    'a quoted sniff_csv over an outside path',
    'sniff_csv',
    `SELECT * FROM "sniff_csv"('/no-such-dir/planted.csv')`,
  ],
];

/**
 * Unqualified `current_schema` references, which DuckDB binds to the function
 * when no column of that name is in scope. The parse tree cannot tell the two
 * apart, so the bare reference is refused too — even where a staged column of
 * that name is in scope.
 */
const BARE_CURRENT_SCHEMA_REFERENCES: Corpus = [
  ['a bare current_schema', () => 'SELECT current_schema'],
  ['a quoted, uppercase bare CURRENT_SCHEMA', () => 'SELECT "CURRENT_SCHEMA" AS v'],
  [
    'a bare current_schema in a WHERE clause',
    () => `SELECT x FROM t WHERE current_schema = 'main'`,
  ],
  [
    'a bare current_schema inside a query() literal',
    () => `SELECT * FROM query('SELECT current_schema AS v')`,
  ],
  ['an unqualified staged column named current_schema', () => 'SELECT current_schema FROM c'],
];

const BARE_CURRENT_SCHEMA_MESSAGE =
  'Canvas query references current_schema unqualified. DuckDB reads that as the current_schema() function unless a column of that name is in scope, so the canvas refuses it either way.';
const BARE_CURRENT_SCHEMA_HINT =
  'Qualify a column named current_schema with its table (<table>.current_schema), or remove the reference — the current_schema() function is not available.';

/** The `denied_function` reason's own hint, which every refusal by name but the bare `current_schema` carries. */
const DENIED_FUNCTION_HINT =
  'Remove the function the message names — only the staged tables are queryable.';

/**
 * `query()` calls DuckDB itself refuses while preparing: a string that is not
 * one SELECT. The parse tree admits the literal and finds nothing in it to
 * refuse, so each carries only the binder's message.
 */
const QUERY_PREPARE_REFUSALS: Corpus = [
  ['query() over a DROP literal', () => `SELECT * FROM query('DROP TABLE t')`],
  ['query() over a SET literal', () => `SELECT * FROM query('SET threads = 1')`],
  ['query() over a two-statement literal', () => `SELECT * FROM query('SELECT 1; SELECT 2')`],
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

/**
 * The refusal of a read naming an outside path: by name when it calls a denied
 * function, else as a file reference, carrying nothing read from the planted
 * file and no host directory.
 */
function expectOutsidePathRefusal(err: McpError, fn: string | undefined): void {
  if (fn !== undefined) {
    expectParsedFunctionRefusal(err, fn);
  } else {
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data?.reason).toBe('sql_read_only');
    expect(err.message).toMatch(/^Canvas SQL rejected: ".+" names a file, not a staged table\.$/);
    expect((err.data?.recovery as { hint?: string } | undefined)?.hint).toBe(SQL_READ_ONLY_HINT);
  }
  const surface = surfaceOf(err);
  expect(surface).not.toContain(MARKER);
  expect(surface).not.toContain(exportRoot);
  expect(surface).not.toContain(recordOf(instance.canvasId).scratchDir);
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
  options: { denySystemCatalogs?: boolean } = {},
): void {
  describe(title, () => {
    const cases = rows.map((row, i) => [row[0], row, i] as const);

    it.each(cases)('query() refuses %s', async (_label, row) => {
      check(await refusalOf(() => instance.query(sqlOf(row), options)), row);
    });

    it.each(cases)('registerView() refuses %s and creates no view', async (_label, row, i) => {
      const viewName = `${prefix}_v_${i}`;
      check(await refusalOf(() => instance.registerView(viewName, sqlOf(row), options)), row);
      expect(await instance.describe({ tableName: viewName })).toEqual([]);
    });

    it.each(cases)(
      'query({ registerAs }) refuses %s and materializes nothing',
      async (_label, row, i) => {
        const tableName = `${prefix}_ra_${i}`;
        check(
          await refusalOf(() => instance.query(sqlOf(row), { ...options, registerAs: tableName })),
          row,
        );
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

  it('refuses a COPY to an outside path through query() as non_select_statement and writes nothing', async () => {
    const target = join(plantedDir, 'copied.csv');
    const err = await refusalOf(() => instance.query(`COPY t TO '${target}'`));
    expect(err.data?.reason).toBe('non_select_statement');
    expect(existsSync(target)).toBe(false);
  });

  it('refuses a COPY to an outside path on the canvas itself, with the gate not consulted', async () => {
    const target = join(plantedDir, 'copied_direct.csv');
    const failure = await recordOf(instance.canvasId)
      .controlConnection.run(`COPY t TO '${target}'`)
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expect((failure as Error).message).toMatch(/^Permission Error/);
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

describe('canvas · names DuckDB binds as a function without parentheses', () => {
  // Re-derives BARE_FUNCTION_KEYWORDS on the installed engine: every function
  // name it lists, plus the documented set (the clock keywords bind functions
  // of other names), written bare in a scope with no column of that name.
  it('binds exactly BARE_FUNCTION_KEYWORDS, and current_schema reads the schema setting', async () => {
    const plain = await DuckDBInstance.create(':memory:');
    const connection = await plain.connect();
    try {
      await connection.run('CREATE TABLE t AS SELECT 1 AS x');
      const listed = (
        await connection.runAndReadAll('SELECT DISTINCT function_name FROM duckdb_functions()')
      ).getRowObjectsJson() as { function_name: string }[];
      const candidates = new Set([
        ...listed.map((row) => row.function_name),
        ...BARE_FUNCTION_KEYWORDS,
      ]);
      const bound: string[] = [];
      for (const name of candidates) {
        if (!/^[a-z_][a-z0-9_]*$/.test(name)) continue;
        const binds = await connection.runAndReadAll(`SELECT "${name}" FROM t`).then(
          () => true,
          () => false,
        );
        if (binds) bound.push(name);
      }
      expect(bound.sort()).toEqual([...BARE_FUNCTION_KEYWORDS].sort());

      await connection.run('CREATE SCHEMA s2');
      await connection.run('SET schema = s2');
      const reader = await connection.runAndReadAll('SELECT current_schema AS v');
      expect(reader.getRowObjectsJson()).toEqual([{ v: 's2' }]);
    } finally {
      connection.closeSync();
      plain.closeSync();
    }
  });
});

describe('canvas · SHOW over a staged table or view (#800)', () => {
  beforeAll(async () => {
    await instance.registerView('tv', 'SELECT x FROM t');
  });

  it.each([
    'SHOW t',
    'SHOW "t"',
    'show T',
    'SHOW main.t',
    'SHOW tv',
    `SELECT * FROM query('SHOW t')`,
  ])('answers %s with the column listing', async (sql) => {
    const result = await instance.query(sql);
    expect(result.rows.map((row) => row.column_name)).toEqual(['x']);
  });

  it('refuses SHOW of a name nothing staged as non_select_statement', async () => {
    const err = await refusalOf(() => instance.query('SHOW missing_tbl'));
    expect(err.data?.reason).toBe('non_select_statement');
  });

  it.each([
    ['SHOW sqlite_master', 'sqlite_master'],
    ['SHOW information_schema.tables', 'information_schema'],
  ])('refuses %s under denySystemCatalogs', async (sql, catalog) => {
    const err = await refusalOf(() => instance.query(sql, { denySystemCatalogs: true }));
    expect(err.data?.reason).toBe('system_catalog_access');
    expect(err.data?.catalog).toBe(catalog);
  });
});

describe('canvas · every pragma_* function, however its name is written (#800)', () => {
  it('refuses each pragma_* table function the engine lists, by name, as denied_function', async () => {
    const plain = await DuckDBInstance.create(':memory:');
    const connection = await plain.connect();
    let functions: { function_name: string; parameters: string[] }[];
    try {
      const reader = await connection.runAndReadAll(
        String.raw`SELECT function_name, arg_min(parameters, len(parameters)) AS parameters FROM duckdb_functions() WHERE function_type = 'table' AND function_name LIKE 'pragma\_%' ESCAPE '\' GROUP BY function_name ORDER BY function_name`,
      );
      functions = reader.getRowObjectsJson() as typeof functions;
    } finally {
      connection.closeSync();
      plain.closeSync();
    }
    expect(functions.map((row) => row.function_name)).toContain('pragma_show');
    for (const { function_name: fn, parameters } of functions) {
      // The first parameter, where there is one, is a table name; the rest are named.
      const args = parameters.length === 0 ? '' : "'t'";
      for (const spelling of [`"${fn}"`, `"${fn.toUpperCase()}"`, `main."${fn}"`]) {
        const err = await refusalOf(() => instance.query(`SELECT * FROM ${spelling}(${args})`));
        expectParsedFunctionRefusal(err, fn);
      }
    }
  });
});

/**
 * DuckDB's internal metadata views, referenced in every form the engine
 * resolves. Each answers with the view's columns, so `denySystemCatalogs`
 * refuses the name itself.
 */
const INTERNAL_VIEW_READS: Corpus = [
  ['DESCRIBE of a view', () => 'DESCRIBE duckdb_tables'],
  ['DESCRIBE of a quoted view', () => 'DESCRIBE "duckdb_tables"'],
  ['DESCRIBE of a view in another case', () => 'DESCRIBE "DuckDB_Columns"'],
  ['DESCRIBE of a catalog-qualified view', () => 'DESCRIBE system.main.duckdb_columns'],
  ['SHOW of a view', () => 'SHOW duckdb_tables'],
  ['a view scan the optimizer removes', () => 'SELECT * FROM duckdb_tables WHERE false'],
  ['a view scan under LIMIT 0', () => 'SELECT * FROM sqlite_schema LIMIT 0'],
  ['a DESCRIBE subquery', () => 'SELECT column_name FROM (DESCRIBE duckdb_views)'],
  ['DESCRIBE inside a query() literal', () => `SELECT * FROM query('DESCRIBE duckdb_tables')`],
  ['a pg_catalog view without its schema', () => 'DESCRIBE pg_class'],
  ['the pragma_database_list view', () => 'SELECT * FROM pragma_database_list WHERE false'],
  ['the sqlite_temp_master view', () => 'DESCRIBE sqlite_temp_master'],
  ['a column the view lacks', () => 'SELECT nope FROM pg_type'],
];

describe('canvas · denySystemCatalogs refuses the internal metadata views, schema-qualified or not', () => {
  it('names exactly the internal views the engine resolves without a schema', async () => {
    const plain = await DuckDBInstance.create(':memory:');
    const connection = await plain.connect();
    try {
      const views = (
        await connection.runAndReadAll(
          `SELECT view_name FROM duckdb_views() WHERE internal AND database_name = 'system'`,
        )
      ).getRowObjectsJson() as { view_name: string }[];
      const resolved: string[] = [];
      for (const { view_name: view } of views) {
        const resolves = await connection.runAndReadAll(`SELECT * FROM "${view}" LIMIT 0`).then(
          () => true,
          () => false,
        );
        if (resolves) resolved.push(view);
      }
      expect(resolved.sort()).toEqual([...INTERNAL_METADATA_VIEWS].sort());
    } finally {
      connection.closeSync();
      plain.closeSync();
    }
  });

  acrossEntryPoints(
    'under denySystemCatalogs',
    'iview',
    INTERNAL_VIEW_READS,
    ([, sql]) => sql(),
    (err) => {
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data?.reason).toBe('system_catalog_access');
    },
    { denySystemCatalogs: true },
  );

  it.each([...INTERNAL_METADATA_VIEWS])('refuses DESCRIBE of %s, naming the view', async (view) => {
    const err = await refusalOf(() =>
      instance.query(`DESCRIBE "${view}"`, { denySystemCatalogs: true }),
    );
    expect(err.data?.reason).toBe('system_catalog_access');
    expect(err.data?.catalog).toBe(view);
  });

  it.each(['DESCRIBE duckdb_tables', 'DESCRIBE pg_class', 'SELECT * FROM sqlite_schema LIMIT 0'])(
    'answers %s without the option',
    async (sql) => {
      expect((await instance.query(sql)).columns.length).toBeGreaterThan(0);
    },
  );

  it.each([
    ['an alias', 'SELECT x AS duckdb_tables FROM t'],
    ['an alias of the existing name', 'SELECT x AS sqlite_master FROM t'],
  ])('refuses %s spelled like a view, as for sqlite_master', async (_label, sql) => {
    const err = await refusalOf(() => instance.query(sql, { denySystemCatalogs: true }));
    expect(err.data?.reason).toBe('system_catalog_access');
  });

  it('answers a string literal that spells a view', async () => {
    const result = await instance.query(`SELECT 'duckdb_tables' AS s, 'pg_class' AS p FROM t`, {
      denySystemCatalogs: true,
    });
    expect(result.rows).toEqual([{ s: 'duckdb_tables', p: 'pg_class' }]);
  });
});

const B = '\\';

/**
 * Statements whose string literals, comments, and quoted names the text scans
 * must divide where the installed engine's tokenizer does, each holding a
 * `read_text` call or the text of one.
 */
const TOKENIZER_FORMS: ReadonlyArray<readonly [label: string, sql: string]> = [
  ['an escape string ending in an escaped quote', `SELECT E'a${B}'' AS q, read_text('x') AS v`],
  ['a lowercase escape string', `SELECT e'${B}'' AS q, read_text('x') AS v`],
  ['a dollar-quoted string holding a quote', `SELECT $$it's$$ AS q, read_text('x') AS v`],
  ['a tagged dollar-quoted string', `SELECT $t$it's$t$ AS q, read_text('x') AS v`],
  ['a string holding a line-comment opener', `SELECT '--' AS q, read_text('x') AS v`],
  ['a string holding a block-comment opener', `SELECT '/*' AS q, read_text('x') AS v, '*/' AS w`],
  ['a line comment ended by a carriage return', `SELECT 1 AS q -- note\r, read_text('x') AS v`],
  [
    'a nested comment holding a quote',
    `SELECT 1 /* a /* b */ it's */ AS q, read_text('x') AS v, 'y' AS w`,
  ],
  ['a quoted name holding a quote', `SELECT 1 AS "it's", read_text('x') AS v, 'y' AS w`],
  ['a backtick-quoted name holding a quote', "SELECT 1 AS `it's`, read_text('x') AS v, 'y' AS w"],
  ['an escape string continued on the next line', `SELECT E'a'\n'${B}'' AS q, read_text('x') AS v`],
  ['a doubled quote', `SELECT 'read_text(''x'')' AS q`],
  ['an escaped quote in an escape string', `SELECT E'it${B}'s read_text(x)' AS q`],
  ['a dollar-quoted call', `SELECT $$read_text('x')$$ AS q`],
  ['a dollar-quoted string whose tag differs in case', `SELECT $T$ $t$ read_text('x') $T$ AS q`],
  ['a closed nested comment', `SELECT 1 /* a /* read_text('x') */ b */ AS q`],
  ['a line comment', `SELECT 1 AS q -- read_text('x')`],
  ['a name holding dollar signs', `SELECT 1 AS a$$b, 'read_text(x)' AS q`],
  ['a parameter', `SELECT $1 AS p, 'read_text(x)' AS q`],
  ['a typed string after a name ending in E', `SELECT xE'${B}' AS q, 'read_text(x)' AS r`],
  ['a quoted name holding a doubled quote', `SELECT 1 AS "a""b", 'read_text(x)' AS q`],
  ['a string continued on the next line', `SELECT 'a'\n'read_text(x)' AS q`],
  ['a string continued past a line comment', `SELECT 'a' -- c\n'read_text(x)' AS q`],
  ['a string ending in a backslash', `SELECT 'C:${B}' AS p, 'read_text(x)' AS q`],
  ['a plain backtick-quoted name', "SELECT `x`, 'read_text(x)' AS q FROM t"],
];

/** The functions DuckDB's own parse of `sql` calls; `undefined` when it cannot parse it. */
async function parsedCalls(sql: string): Promise<string[] | undefined> {
  const reader = await recordOf(instance.canvasId).controlConnection.runAndReadAll(
    'SELECT json_serialize_sql($1::VARCHAR) AS tree',
    [sql],
  );
  const tree = JSON.parse(String(reader.getRowObjectsJson()[0]?.tree)) as { error?: unknown };
  if (tree.error !== false) return;
  const calls: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const call = node as { class?: unknown; function_name?: unknown };
    if (call.class === 'FUNCTION' && typeof call.function_name === 'string') {
      calls.push(call.function_name);
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(tree);
  return calls;
}

describe('canvas · the text scans read string literals and comments as the engine does', () => {
  it.each(TOKENIZER_FORMS)(
    'scans the read_text call after %s exactly when the engine parses one',
    async (_label, sql) => {
      const calls = await parsedCalls(sql);
      let scanned = false;
      try {
        assertNoDeniedFunctions(sql);
      } catch {
        scanned = true;
      }
      // A statement the engine cannot parse never runs; the scan refuses it too.
      expect(scanned).toBe(calls?.includes('read_text') ?? true);
    },
  );

  acrossEntryPoints(
    'refuses a system catalog read the engine sees as code, under denySystemCatalogs',
    'tokenizer',
    [
      [
        'after an escape string ending in an escaped quote',
        `SELECT E'${B}'' AS q, table_name FROM information_schema.tables, (SELECT 'x') s`,
      ],
      [
        'after a dollar-quoted string holding a quote',
        `SELECT $$it's$$ AS q, table_name FROM information_schema.tables, (SELECT 'x') s`,
      ],
      [
        'after a string holding a line-comment opener',
        `SELECT '--' AS q, table_name FROM information_schema.tables`,
      ],
      [
        'after a string holding a block-comment opener',
        `SELECT '/*' AS q, table_name FROM information_schema.tables, (SELECT '*/') s`,
      ],
      [
        'after a line comment ended by a carriage return',
        `SELECT 1 AS q -- note\r, table_name FROM information_schema.tables`,
      ],
      [
        'after a nested comment holding a quote',
        `SELECT 1 /* a /* b */ it's */ AS q, table_name FROM information_schema.tables, (SELECT 'x') s`,
      ],
      [
        'after a quoted name holding a quote',
        `SELECT 1 AS "it's", table_name FROM information_schema.tables, (SELECT 'x') s`,
      ],
      [
        'after a backtick-quoted name holding a quote',
        "SELECT 1 AS `it's`, table_name FROM information_schema.tables, (SELECT 'x') s",
      ],
    ] as const,
    ([, sql]) => sql,
    (err) => {
      expect(err.data?.reason).toBe('system_catalog_access');
      expect(err.data?.catalog).toBe('information_schema');
    },
    { denySystemCatalogs: true },
  );
});

/**
 * Table references the catalog cannot hold: a name with a path separator is a
 * file path, never a staged table, whether or not anything exists there.
 */
const PATH_NAMED_TABLES: ReadonlyArray<
  readonly [label: string, sql: () => string, name: () => string]
> = [
  ['a quoted absolute path', () => `SELECT * FROM '/etc/hosts'`, () => '/etc/hosts'],
  ['a double-quoted absolute path', () => `SELECT * FROM "/etc/hosts"`, () => '/etc/hosts'],
  ['a directory', () => `SELECT * FROM '/etc'`, () => '/etc'],
  ['a FROM-first path', () => `FROM '/etc/hosts'`, () => '/etc/hosts'],
  ['a path beside a staged table', () => `SELECT * FROM t, '/etc/hosts'`, () => '/etc/hosts'],
  [
    'a backslash path',
    () => String.raw`SELECT * FROM 'C:\Windows\win'`,
    () => String.raw`C:\Windows\win`,
  ],
  [
    'a file under the export root with no extension',
    () => `SELECT * FROM '${exportRoot}/noext'`,
    () => '[path]/noext',
  ],
  [
    'a missing file under the export root with no extension',
    () => `SELECT * FROM '${exportRoot}/missing_noext'`,
    () => '[path]/missing_noext',
  ],
];

describe('canvas · a table reference that holds a path separator names a file', () => {
  beforeAll(async () => {
    await writeFile(join(exportRoot, 'noext'), `${INSIDE_MARKER},n\n${MARKER},1\n`);
  });

  acrossEntryPoints(
    'refused as sql_read_only',
    'pathname',
    PATH_NAMED_TABLES,
    ([, sql]) => sql(),
    (err, [, , name]) => {
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data?.reason).toBe('sql_read_only');
      expect(err.message).toBe(
        `Canvas SQL rejected: "${name()}" names a file, not a staged table.`,
      );
      expect((err.data?.recovery as { hint?: string } | undefined)?.hint).toBe(SQL_READ_ONLY_HINT);
      const surface = surfaceOf(err);
      expect(surface).not.toContain(INSIDE_MARKER);
      expect(surface).not.toContain(MARKER);
      expect(surface).not.toContain(exportRoot);
    },
  );

  it.each([
    ['a quoted name holding a dot', 'SELECT * FROM "a.b"', 'a.b'],
    ['a quoted qualified name', 'SELECT * FROM "main.gone"', 'main.gone'],
    ['a name nothing staged', 'SELECT * FROM gone', 'gone'],
  ])('keeps %s a missing table', async (_label, sql, tableName) => {
    const err = await refusalOf(() => instance.query(sql));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data?.reason).toBe('missing_table');
    expect(err.data?.tableName).toBe(tableName);
  });
});

/**
 * States one path under the export root can be in. A statement naming the path
 * must fail identically in each: the refusal says what the statement names, not
 * what is on disk.
 */
const FILE_STATES: ReadonlyArray<readonly [state: string, set: (path: string) => Promise<void>]> = [
  ['absent', async () => {}],
  ['a CSV file', (path) => writeFile(path, `${INSIDE_MARKER},n\n${MARKER},1\n`)],
  ['an empty file', (path) => writeFile(path, '')],
  [
    'an unreadable file',
    async (path) => {
      await writeFile(path, `${INSIDE_MARKER},n\n${MARKER},1\n`);
      await chmod(path, 0o000);
    },
  ],
  ['a directory', (path) => mkdir(path)],
];

/** Statements naming one path, each with the refusal every file state must get. */
const FILE_STATE_STATEMENTS: ReadonlyArray<
  readonly [label: string, sql: (path: string) => string, reason: string, fn?: string]
> = [
  ['a replacement scan', (p) => `SELECT * FROM '${p}'`, 'sql_read_only'],
  [
    'a replacement scan the optimizer removes',
    (p) => `SELECT * FROM '${p}' WHERE false`,
    'sql_read_only',
  ],
  ['a column the file may lack', (p) => `SELECT nope FROM '${p}'`, 'sql_read_only'],
  ['DESCRIBE', (p) => `DESCRIBE '${p}'`, 'sql_read_only'],
  ['SUMMARIZE', (p) => `SUMMARIZE SELECT * FROM '${p}'`, 'sql_read_only'],
  ['a query() literal', (p) => `SELECT * FROM query('SELECT * FROM ''${p}''')`, 'sql_read_only'],
  [
    'two query() literals deep',
    (p) => `SELECT * FROM query('SELECT * FROM query(''SELECT nope FROM ''''${p}'''''')')`,
    'sql_read_only',
  ],
  ['a quoted read_csv', (p) => `SELECT * FROM "read_csv"('${p}')`, 'denied_function', 'read_csv'],
  [
    'a quoted read_json',
    (p) => `SELECT * FROM "read_json"('${p}')`,
    'denied_function',
    'read_json',
  ],
  [
    'a quoted read_parquet',
    (p) => `SELECT * FROM "read_parquet"('${p}')`,
    'denied_function',
    'read_parquet',
  ],
  [
    'query_table() over the path',
    (p) => `SELECT * FROM query_table('"${p}"')`,
    'denied_function',
    'query_table',
  ],
  [
    'query() over a computed string',
    (p) => `SELECT * FROM query('SELECT * FROM ''${p}''' || '')`,
    'denied_function',
    'query',
  ],
  ['SHOW', (p) => `SHOW '${p}'`, 'sql_read_only'],
  ['the path beside an outside path', (p) => `SELECT * FROM '${p}', '${planted}'`, 'sql_read_only'],
  ['the path beside a missing table', (p) => `SELECT * FROM '${p}', gone`, 'sql_read_only'],
  ['a missing table beside the path', (p) => `SELECT * FROM gone, '${p}'`, 'sql_read_only'],
  ['the path beside a missing dotted name', (p) => `SELECT * FROM '${p}', "a.b"`, 'sql_read_only'],
  ['the path beside a missing schema', (p) => `SELECT * FROM '${p}', nos.t`, 'sql_read_only'],
  [
    'a query() literal naming the path beside a missing table',
    (p) => `SELECT * FROM query('SELECT * FROM ''${p}'', gone')`,
    'sql_read_only',
  ],
  [
    'a quoted read_csv beside an outside path',
    (p) => `SELECT * FROM "read_csv"('${p}'), '${planted}'`,
    'denied_function',
    'read_csv',
  ],
];

describe('canvas · a file reference fails the same way whether or not the file exists', () => {
  const probe = () => join(exportRoot, 'state_probe.csv');

  afterAll(async () => {
    await chmod(probe(), 0o644).catch(() => undefined);
    await rm(probe(), { recursive: true, force: true });
  });

  it.each(
    FILE_STATE_STATEMENTS.map(([label, sqlOf, reason, fn]) => ({ label, sqlOf, reason, fn })),
  )(
    'refuses $label identically in every file state, through every entry point',
    async ({ sqlOf, reason, fn }) => {
      const sql = sqlOf(probe());
      const outcomes: { state: string; entry: string; surface: string }[] = [];
      for (const [state, set] of FILE_STATES) {
        await chmod(probe(), 0o644).catch(() => undefined);
        await rm(probe(), { recursive: true, force: true });
        await set(probe());
        for (const [entry, run] of [
          ['query', () => instance.query(sql)],
          ['registerView', () => instance.registerView('state_v', sql)],
          ['registerAs', () => instance.query(sql, { registerAs: 'state_ra' })],
        ] as const) {
          const err = await refusalOf(run);
          expect(err.data?.reason, `${state} via ${entry}`).toBe(reason);
          if (fn !== undefined) expect(err.data?.function).toBe(fn);
          else expectFileReferenceRefusal(err);
          outcomes.push({ state, entry, surface: surfaceOf(err) });
        }
        expect(await instance.describe({ tableName: 'state_v' })).toEqual([]);
        expect(await instance.describe({ tableName: 'state_ra' })).toEqual([]);
      }
      const [first] = outcomes;
      for (const outcome of outcomes) {
        expect(outcome.surface, `${outcome.state} via ${outcome.entry}`).toBe(first?.surface);
      }
    },
  );
});

/** Statements that are not a SELECT, each naming one path. */
const NON_SELECT_STATEMENTS: ReadonlyArray<
  readonly [label: string, sql: (path: string) => string]
> = [
  ['CREATE TABLE AS', (p) => `CREATE TABLE ns_t AS SELECT * FROM '${p}'`],
  ['CREATE VIEW AS', (p) => `CREATE VIEW ns_v AS SELECT * FROM '${p}'`],
  ['INSERT … SELECT', (p) => `INSERT INTO t SELECT n FROM '${p}'`],
  ['DELETE … WHERE IN (SELECT)', (p) => `DELETE FROM t WHERE x IN (SELECT n FROM '${p}')`],
  ['EXPLAIN', (p) => `EXPLAIN SELECT * FROM '${p}'`],
  ['COPY TO', (p) => `COPY t TO '${p}'`],
];

const NON_SELECT_SURFACE = JSON.stringify({
  message: 'Canvas query must be SELECT.',
  data: {
    reason: 'non_select_statement',
    statementType: 'UNKNOWN',
    recovery: {
      hint: 'Rewrite as a single SELECT — this surface is read-only and cannot create, alter, or drop tables.',
    },
  },
});

describe('canvas · a non-SELECT statement is refused before it is prepared', () => {
  const probe = () => join(exportRoot, 'non_select_probe.csv');

  afterAll(async () => {
    await chmod(probe(), 0o644).catch(() => undefined);
    await rm(probe(), { recursive: true, force: true });
  });

  it.each(NON_SELECT_STATEMENTS.map(([label, sqlOf]) => ({ label, sqlOf })))(
    'refuses $label with one refusal in every file state, through every entry point',
    async ({ sqlOf }) => {
      const sql = sqlOf(probe());
      for (const [state, set] of FILE_STATES) {
        await chmod(probe(), 0o644).catch(() => undefined);
        await rm(probe(), { recursive: true, force: true });
        await set(probe());
        for (const [entry, run] of [
          ['query', () => instance.query(sql)],
          ['registerView', () => instance.registerView('ns_state_v', sql)],
          ['registerAs', () => instance.query(sql, { registerAs: 'ns_state_ra' })],
        ] as const) {
          const err = await refusalOf(run);
          expect(err.code, `${state} via ${entry}`).toBe(JsonRpcErrorCode.ValidationError);
          expect(surfaceOf(err), `${state} via ${entry}`).toBe(NON_SELECT_SURFACE);
        }
        expect(await instance.describe({ tableName: 'ns_t' })).toEqual([]);
        expect(await instance.describe({ tableName: 'ns_v' })).toEqual([]);
      }
    },
  );

  it.each(['DROP TABLE t', 'CREATE TABLE ns_plain (a INTEGER)', 'PRAGMA version'])(
    'refuses %s, which names no file, the same way',
    async (sql) => {
      const err = await refusalOf(() => instance.query(sql));
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(surfaceOf(err)).toBe(NON_SELECT_SURFACE);
      expect(await instance.describe({ tableName: 't' })).toHaveLength(1);
    },
  );
});

describe('canvas · the plan walk reads the function each real scan names', () => {
  let insideParquet: string;

  beforeAll(async () => {
    insideParquet = join(exportRoot, 'inside.parquet');
    const plain = await DuckDBInstance.create(':memory:');
    const connection = await plain.connect();
    try {
      await connection.run(`COPY (SELECT 1 AS a) TO '${insideParquet}' (FORMAT parquet)`);
    } finally {
      connection.closeSync();
      plain.closeSync();
    }
  });

  /** The plan DuckDB builds for `sql`, read past the gate. */
  async function planOf(sql: string): Promise<unknown> {
    const reader = await recordOf(instance.canvasId).controlConnection.runAndReadAll(
      `EXPLAIN (FORMAT JSON) ${sql}`,
    );
    return JSON.parse(String(reader.getRowObjectsJson()[0]?.explain_value));
  }

  it.each([
    ['read_csv', () => `SELECT * FROM read_csv('${inside}')`],
    ['read_csv_auto', () => `SELECT * FROM '${inside}'`],
    ['read_text', () => `SELECT * FROM read_text('${inside}')`],
    ['read_parquet', () => `SELECT * FROM read_parquet('${insideParquet}')`],
    ['pragma_version', () => 'SELECT * FROM pragma_version()'],
  ])('reports %s from the plan DuckDB builds for it', async (fn, sql) => {
    expect([...collectPlanViolations(await planOf(sql())).deniedFunctions]).toEqual([fn]);
  });

  it.each([
    'SELECT x FROM t',
    `SELECT 'read_csv(x)' AS read_json, x AS pragma_version FROM t WHERE 'glob(x)' <> ''`,
    'SHOW t',
    'DESCRIBE t',
    'SUMMARIZE t',
  ])('reports nothing in the plan of %s', async (sql) => {
    expect(collectPlanViolations(await planOf(sql))).toEqual({
      offending: new Set(),
      deniedFunctions: new Set(),
    });
  });
});

describe('canvas · SQL gate refuses reads only the engine or the plan walk can see', () => {
  acrossEntryPoints(
    'outside-path reads',
    'outside',
    OUTSIDE_PATH_READS,
    ([, sql]) => sql(),
    (err, [, , fn]) => expectOutsidePathRefusal(err, fn),
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

  // DuckDB v2.0 plans duckdb_external_resources() as its own scan, which the
  // plan walk refuses; v1.5 has no such function and refuses the call itself.
  acrossEntryPoints(
    'duckdb_external_resources()',
    'extres',
    [['duckdb_external_resources()', () => 'SELECT * FROM duckdb_external_resources()']] as const,
    ([, sql]) => sql(),
    (err) =>
      expect(err.data?.reason).toBe(
        duckdbVersion().startsWith('v1.') ? 'invalid_sql' : 'plan_operator_not_allowed',
      ),
  );

  acrossEntryPoints(
    'series over a column or a subquery',
    'series',
    SERIES_PLAN_REFUSALS,
    ([, sql]) => sql,
    (err, [, , operator]) => {
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data?.reason).toBe('plan_operator_not_allowed');
      expect(err.data?.operators).toContain(operator);
    },
  );

  acrossEntryPoints(
    'functions resolved while binding',
    'parsed',
    PARSED_FUNCTION_CALLS,
    ([, , sql]) => sql,
    (err, [, fn]) => {
      expectParsedFunctionRefusal(err, fn);
      expect((err.data?.recovery as { hint?: string } | undefined)?.hint).toBe(
        DENIED_FUNCTION_HINT,
      );
    },
  );

  acrossEntryPoints(
    'an unqualified current_schema',
    'bare',
    BARE_CURRENT_SCHEMA_REFERENCES,
    ([, sql]) => sql(),
    (err) => {
      expectParsedFunctionRefusal(err, 'current_schema');
      expect(err.message).toBe(BARE_CURRENT_SCHEMA_MESSAGE);
      expect((err.data?.recovery as { hint?: string } | undefined)?.hint).toBe(
        BARE_CURRENT_SCHEMA_HINT,
      );
    },
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
        DENIED_FUNCTION_HINT,
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

  it('refuses an unqualified current_schema column with a hint to qualify it', async () => {
    const err = await refusalOf(() => instance.query('SELECT current_schema FROM c'));
    expect(err.message).toBe(BARE_CURRENT_SCHEMA_MESSAGE);
    expect((err.data?.recovery as { hint?: string } | undefined)?.hint).toBe(
      BARE_CURRENT_SCHEMA_HINT,
    );
  });

  it('reads a staged current_schema column qualified with its table', async () => {
    expect((await instance.query('SELECT c.current_schema FROM c')).rows).toEqual([
      { current_schema: 'staged' },
    ]);
  });

  it('reads unqualified columns named after the other denied functions', async () => {
    expect((await instance.query('SELECT query, current_setting FROM q')).rows).toEqual([
      { query: 'q1', current_setting: 's1' },
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
    ['an arrow lambda', 'SELECT list_transform([x], y -> y + 1)[1] AS x FROM t', '2'],
    ['a lambda keyword', 'SELECT list_transform([x], lambda y: y + 1)[1] AS x FROM t', '2'],
  ])('passes %s', async (_label, sql, x) => {
    expect((await instance.query(sql)).rows).toEqual([{ x }]);
  });
});

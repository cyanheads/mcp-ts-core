/**
 * @fileoverview The canvas SQL gate against real DuckDB, for reads the text
 * deny-list cannot see: quoted table-function names, replacement scans over a
 * quoted path, functions that run a SQL string, smuggling through LATERAL /
 * CTE / UNION, and catalog views referenced without parentheses. Each one
 * reaches a non-allowlisted plan operator, so the plan walk is the layer that
 * refuses it. A planted file outside the canvas holds a marker no refusal may
 * echo, and every entry point that runs the gate — `query()`, `registerView()`,
 * and `query({ registerAs })` — must refuse every input before creating
 * anything.
 * @module tests/smoke/services/canvas-gate-bypass.test
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CanvasInstance } from '@/services/canvas/core/CanvasInstance.js';
import { CanvasRegistry } from '@/services/canvas/core/CanvasRegistry.js';
import { DataCanvas } from '@/services/canvas/core/DataCanvas.js';
import { DuckdbProvider } from '@/services/canvas/providers/duckdb/DuckdbProvider.js';
import { McpError } from '@/types-global/errors.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

const ctx: RequestContext = {
  requestId: 'smoke-canvas-gate-bypass',
  timestamp: '2026-01-01T00:00:00.000Z',
  tenantId: 'smoke-tenant',
};

/** Written into the planted file's data row; no refusal may contain it. */
const MARKER = 'CANVAS_GATE_MARKER_7f3a';

let canvas: DataCanvas;
let provider: DuckdbProvider;
let instance: CanvasInstance;
let exportRoot: string;
let plantedDir: string;
let planted: string;

beforeAll(async () => {
  exportRoot = await mkdtemp(join(tmpdir(), 'canvas-gate-export-'));
  plantedDir = await mkdtemp(join(tmpdir(), 'canvas-gate-planted-'));
  planted = join(plantedDir, 'planted.csv');
  await writeFile(planted, `label,n\n${MARKER},1\n`);

  provider = new DuckdbProvider({
    memoryLimitMb: 128,
    exportRootPath: exportRoot,
    defaultRowLimit: 100,
    schemaSniffRows: 10,
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
  await rm(plantedDir, { recursive: true, force: true });
});

/** Builders, so each SQL string is formed once the planted path exists. */
const CORPUS: ReadonlyArray<readonly [label: string, sql: () => string]> = [
  ['a replacement scan over a quoted path', () => `SELECT * FROM '${planted}'`],
  ['a FROM-first replacement scan', () => `FROM '${planted}'`],
  ['a replacement scan over a glob', () => `SELECT * FROM '${plantedDir}/*.csv'`],
  ['a quoted read_csv', () => `SELECT * FROM "read_csv"('${planted}')`],
  ['a quoted, uppercase READ_CSV', () => `SELECT * FROM "READ_CSV"('${planted}')`],
  ['a quoted read_csv_auto', () => `SELECT * FROM "read_csv_auto"('${planted}')`],
  ['a quoted read_text', () => `SELECT * FROM "read_text"('${planted}')`],
  ['a quoted read_blob', () => `SELECT * FROM "read_blob"('${planted}')`],
  ['a quoted read_json_objects', () => `SELECT * FROM "read_json_objects"('${planted}')`],
  ['a quoted sniff_csv', () => `SELECT * FROM "sniff_csv"('${planted}')`],
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
  ['the duckdb_tables view without parentheses', () => 'SELECT * FROM duckdb_tables'],
  ['the sqlite_schema view', () => 'SELECT * FROM sqlite_schema'],
  ['the pragma_database_list view without parentheses', () => 'SELECT * FROM pragma_database_list'],
  ['SHOW TABLES', () => 'SHOW TABLES'],
  ['a quoted duckdb_settings()', () => 'SELECT * FROM "duckdb_settings"()'],
  ['a quoted pragma_version()', () => 'SELECT * FROM "pragma_version"()'],
  ['a quoted pragma_table_info()', () => `SELECT * FROM "pragma_table_info"('t')`],
];

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

/** The plan-walk refusal, carrying nothing read from the planted file. */
function expectPlanWalkRefusal(err: McpError): void {
  expect(err.data?.reason).toBe('plan_operator_not_allowed');
  expect(JSON.stringify({ message: err.message, data: err.data })).not.toContain(MARKER);
}

describe('canvas · SQL gate refuses reads only the plan walk can see', () => {
  // Control: the planted file is readable by the engine itself, so a refusal
  // below is the gate's doing, not an unreadable path.
  it('plants a file the engine can read when the gate is not consulted', async () => {
    // biome-ignore lint/complexity/useLiteralKeys: deliberate access to the private record to bypass the gate for the control read.
    const record = provider['canvases'].get(instance.canvasId);
    const reader = await record!.controlConnection.runAndReadAll(`SELECT * FROM '${planted}'`);
    expect(reader.getRowObjectsJson()).toEqual([{ label: MARKER, n: '1' }]);
  });

  it.each(CORPUS)('query() refuses %s', async (_label, sql) => {
    expectPlanWalkRefusal(await refusalOf(() => instance.query(sql())));
  });

  it.each(CORPUS.map(([label, sql], i) => [label, sql, `v_${i}`] as const))(
    'registerView() refuses %s and creates no view',
    async (_label, sql, viewName) => {
      expectPlanWalkRefusal(await refusalOf(() => instance.registerView(viewName, sql())));
      expect(await instance.describe({ tableName: viewName })).toEqual([]);
    },
  );

  it.each(CORPUS.map(([label, sql], i) => [label, sql, `ra_${i}`] as const))(
    'query({ registerAs }) refuses %s and materializes nothing',
    async (_label, sql, tableName) => {
      expectPlanWalkRefusal(
        await refusalOf(() => instance.query(sql(), { registerAs: tableName })),
      );
      expect(await instance.describe({ tableName })).toEqual([]);
    },
  );
});

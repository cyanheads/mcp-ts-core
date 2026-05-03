/**
 * @fileoverview Full round-trip smoke test against a real DuckDB instance.
 * Exercises acquire → registerTable → query → export and the SQL gate's
 * fixture-pinned plan-walk allowlist (refinement #3 in issue #97). This test
 * loads the optional `@duckdb/node-api` peer dependency at runtime; it is
 * skipped automatically if the import fails (e.g. on platforms where DuckDB
 * native bindings are unavailable).
 * @module tests/smoke/canvas-duckdb.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CanvasRegistry } from '@/services/canvas/core/CanvasRegistry.js';
import { DataCanvas } from '@/services/canvas/core/DataCanvas.js';
import {
  ALLOWED_PLAN_OPERATORS,
  collectDisallowedOperators,
} from '@/services/canvas/core/sqlGate.js';
import { DuckdbProvider } from '@/services/canvas/providers/duckdb/DuckdbProvider.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

let duckdbAvailable = false;
try {
  await import('@duckdb/node-api');
  duckdbAvailable = true;
} catch {
  // Skip the suite if DuckDB native bindings can't load.
}

const describeIf = duckdbAvailable ? describe : describe.skip;

const ctx: RequestContext = {
  requestId: 'smoke-canvas',
  timestamp: '2026-01-01T00:00:00.000Z',
  tenantId: 'smoke-tenant',
};

describeIf('canvas · DuckDB round trip', () => {
  let canvas: DataCanvas;
  let provider: DuckdbProvider;
  let exportRoot: string;

  beforeAll(async () => {
    exportRoot = await mkdtemp(join(tmpdir(), 'canvas-smoke-'));
    provider = new DuckdbProvider({
      memoryLimitMb: 256,
      exportRootPath: exportRoot,
      defaultRowLimit: 1000,
      schemaSniffRows: 100,
    });
    const registry = new CanvasRegistry(provider, {
      ttlMs: 60_000,
      absoluteCapMs: 600_000,
      maxCanvasesPerTenant: 100,
      sweeperIntervalMs: 0,
    });
    canvas = new DataCanvas(provider, registry);
  });

  afterAll(async () => {
    if (canvas) await canvas.shutdown(ctx);
    await rm(exportRoot, { recursive: true, force: true });
  });

  it('mints a new canvas, registers a table, and queries it', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    expect(instance.canvasId).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(instance.isNew).toBe(true);

    const rows = [
      { id: 1, name: 'alpha', score: 0.5 },
      { id: 2, name: 'beta', score: 0.7 },
      { id: 3, name: 'gamma', score: 0.9 },
    ];
    const tableInfo = await instance.registerTable('items', rows);
    expect(tableInfo.tableName).toBe('items');
    expect(tableInfo.rowCount).toBe(3);
    expect(tableInfo.columns.sort()).toEqual(['id', 'name', 'score']);

    const result = await instance.query('SELECT name FROM items ORDER BY id');
    expect(result.rows).toEqual([{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }]);
    expect(result.columns).toEqual(['name']);
  });

  it('rejects multi-statement input via the SQL gate', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('t', [{ x: 1 }]);
    await expect(instance.query('SELECT * FROM t; DROP TABLE t;')).rejects.toThrow(
      /exactly one SQL statement|rejected/i,
    );
  });

  it('rejects DDL/DML wrapped in a SELECT envelope', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('t', [{ x: 1 }]);
    // INSERT — non-SELECT statement type; rejected at the type gate.
    await expect(instance.query('INSERT INTO t VALUES (2)')).rejects.toThrow(
      /must be SELECT|rejected/i,
    );
    // PRAGMA — non-SELECT statement type.
    await expect(instance.query('PRAGMA threads = 4')).rejects.toThrow(/must be SELECT|rejected/i);
    // ATTACH — non-SELECT.
    await expect(instance.query("ATTACH ':memory:' AS x")).rejects.toThrow(
      /must be SELECT|rejected/i,
    );
  });

  it('rejects file-reading scans (READ_CSV) via the plan-walk allowlist', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    // Without an existing table, this attempts to plan a READ_CSV which is
    // not in the allowlist. The gate or the planner itself will refuse it.
    await expect(instance.query("SELECT * FROM read_csv('/etc/passwd')")).rejects.toThrow();
  });

  // Issue #100 — read_json/read_parquet bypass. These functions lower into
  // generic scan operators that previously passed the allowlist; the SQL
  // pre-scan and plan-walk rescan should now reject them by name.
  it.each([
    ['read_json', "SELECT * FROM read_json('/etc/passwd')"],
    ['read_json_auto', "SELECT * FROM read_json_auto('/etc/hostname')"],
    ['read_json_objects', "SELECT * FROM read_json_objects('/etc/x.json')"],
    ['read_ndjson', "SELECT * FROM read_ndjson('/etc/x.ndjson')"],
    ['read_parquet', "SELECT * FROM read_parquet('/etc/x.parquet')"],
    ['parquet_scan', "SELECT * FROM parquet_scan('/etc/x.parquet')"],
  ])('issue #100 — rejects %s before reaching DuckDB', async (_label, sql) => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('t', [{ x: 1 }]);
    // The error must come from the canvas gate, not from DuckDB's executor —
    // a "Malformed JSON" or "No such file" message would mean the file was
    // opened, which is the bug.
    await expect(instance.query(sql)).rejects.toThrow(/disallowed table function/i);
  });

  it('issue #100 — comment-injected separator does not bypass the deny-list', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('t', [{ x: 1 }]);
    await expect(instance.query("SELECT * FROM read_json /* x */ ('/etc/passwd')")).rejects.toThrow(
      /disallowed table function/i,
    );
  });

  it('issue #100 — function name as a string literal does not false-positive', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('t', [{ x: 1 }]);
    // The SQL pre-scan strips literals before regex; this query should pass.
    // Note: BIGINT round-trips as a string via getRowObjectsJson().
    const result = await instance.query("SELECT 'read_json' AS s, x FROM t");
    expect(result.rows[0]).toEqual({ s: 'read_json', x: '1' });
  });

  it('honors registerAs for full-result materialization', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    const rows = Array.from({ length: 250 }, (_, i) => ({ x: i }));
    await instance.registerTable('numbers', rows);

    const result = await instance.query('SELECT x * 2 AS doubled FROM numbers ORDER BY x', {
      registerAs: 'doubled_numbers',
      preview: 5,
    });
    expect(result.tableName).toBe('doubled_numbers');
    expect(result.rowCount).toBe(250);
    expect(result.rows.length).toBe(5);
    // BIGINT values are serialized as strings by getRowObjectsJson — lossless
    // for values outside JS Number range, consistent regardless of magnitude.
    expect(result.rows[0]).toEqual({ doubled: '0' });
    expect(result.rows[4]).toEqual({ doubled: '8' });

    const tables = await instance.describe();
    const found = tables.find((t) => t.name === 'doubled_numbers');
    expect(found?.rowCount).toBe(250);
  });

  it('rejects registerAs clashes', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('users', [{ id: 1 }]);
    await expect(instance.query('SELECT 1 AS one', { registerAs: 'users' })).rejects.toThrow(
      /already exists/i,
    );
  });

  it('exports CSV to a sandboxed path', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('export_me', [
      { id: 1, label: 'alpha' },
      { id: 2, label: 'beta' },
    ]);
    const result = await instance.export('export_me', {
      format: 'csv',
      path: 'export.csv',
    });
    expect(result.format).toBe('csv');
    expect(result.path?.startsWith(exportRoot)).toBe(true);
    expect(result.rowCount).toBe(2);
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('rejects export paths that escape the sandbox', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('t', [{ x: 1 }]);
    await expect(instance.export('t', { format: 'csv', path: '../escape.csv' })).rejects.toThrow(
      /escapes/i,
    );
    await expect(instance.export('t', { format: 'csv', path: '/tmp/escape.csv' })).rejects.toThrow(
      /absolute/i,
    );
  });

  it('drop and clear behave correctly', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('one', [{ x: 1 }]);
    await instance.registerTable('two', [{ y: 1 }]);
    expect(await instance.drop('one')).toBe(true);
    expect(await instance.drop('one')).toBe(false);
    const remaining = await instance.describe();
    expect(remaining.map((t) => t.name)).toEqual(['two']);
    expect(remaining.map((t) => t.kind)).toEqual(['table']);
    expect(await instance.clear()).toBe(1);
    expect((await instance.describe()).length).toBe(0);
  });

  it('registerView gates the SELECT and exposes the view via describe/query', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable(
      'sales',
      [
        { region: 'a', amount: 100 },
        { region: 'a', amount: 50 },
        { region: 'b', amount: 25 },
      ],
      {
        schema: [
          { name: 'region', type: 'VARCHAR' },
          { name: 'amount', type: 'INTEGER' },
        ],
      },
    );

    const view = await instance.registerView(
      'sales_by_region',
      'SELECT region, SUM(amount) AS total FROM sales GROUP BY region',
    );
    expect(view.viewName).toBe('sales_by_region');
    expect(view.columns).toEqual(['region', 'total']);

    // Querying the view goes through the normal gate at execution time.
    const result = await instance.query("SELECT total FROM sales_by_region WHERE region = 'a'");
    expect(result.rows).toEqual([{ total: '150' }]);

    const all = await instance.describe();
    const viewInfo = all.find((t) => t.name === 'sales_by_region');
    expect(viewInfo?.kind).toBe('view');

    const onlyViews = await instance.describe({ kind: 'view' });
    expect(onlyViews.map((t) => t.name)).toEqual(['sales_by_region']);

    // CREATE OR REPLACE semantics: re-registering the same name succeeds.
    await expect(
      instance.registerView('sales_by_region', 'SELECT region FROM sales'),
    ).resolves.toBeDefined();

    // drop() detects the kind and emits DROP VIEW.
    expect(await instance.drop('sales_by_region')).toBe(true);
    expect((await instance.describe({ kind: 'view' })).length).toBe(0);
  });

  it('registerView rejects non-SELECT and disallowed-function definitions', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('t', [{ x: 1 }]);

    await expect(instance.registerView('bad', 'INSERT INTO t VALUES (2)')).rejects.toThrow(
      /must be SELECT|rejected/i,
    );
    await expect(
      instance.registerView('bad', "SELECT * FROM read_json('/etc/passwd')"),
    ).rejects.toThrow(/disallowed table function/i);
  });

  it('registerView refuses to overwrite a base table of the same name', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('items', [{ id: 1 }]);
    await expect(instance.registerView('items', 'SELECT 1 AS id')).rejects.toThrow(
      /base table named/i,
    );
  });

  it('importFrom copies a table across canvases through a parquet round-trip', async () => {
    const source = await canvas.acquire(undefined, ctx);
    const target = await canvas.acquire(undefined, ctx);
    expect(source.canvasId).not.toBe(target.canvasId);

    const ts = new Date('2026-04-01T00:00:00.000Z');
    const blob = new Uint8Array([0xfe, 0xed, 0xfa, 0xce]);
    await source.registerTable(
      'orders',
      [
        { id: 1, name: 'a', placed_at: ts, payload: blob },
        { id: 2, name: 'b', placed_at: ts, payload: blob },
      ],
      {
        schema: [
          { name: 'id', type: 'INTEGER' },
          { name: 'name', type: 'VARCHAR' },
          { name: 'placed_at', type: 'TIMESTAMP' },
          { name: 'payload', type: 'BLOB' },
        ],
      },
    );

    const imported = await target.importFrom(source.canvasId, 'orders', { asName: 'orders_copy' });
    expect(imported.tableName).toBe('orders_copy');
    expect(imported.rowCount).toBe(2);
    expect(imported.columns.sort()).toEqual(['id', 'name', 'payload', 'placed_at']);

    // Source remains untouched.
    const sourceTables = await source.describe();
    expect(sourceTables.map((t) => t.name)).toEqual(['orders']);

    // TIMESTAMP/BLOB round-trip losslessly through the parquet temp file.
    const verify = await target.query(
      'SELECT id, name, CAST(placed_at AS VARCHAR) AS ts_s, hex(payload) AS p_hex FROM orders_copy ORDER BY id',
    );
    expect(verify.rows[0]).toMatchObject({
      id: 1,
      name: 'a',
      p_hex: 'FEEDFACE',
    });
    expect((verify.rows[0] as { ts_s: string }).ts_s).toMatch(/^2026-04-01 00:00:00/);

    // Re-importing the same name overwrites idempotently.
    await target.importFrom(source.canvasId, 'orders', { asName: 'orders_copy' });
    expect((await target.describe()).find((t) => t.name === 'orders_copy')?.rowCount).toBe(2);
  });

  it('importFrom defaults asName to the source table name', async () => {
    const source = await canvas.acquire(undefined, ctx);
    const target = await canvas.acquire(undefined, ctx);
    await source.registerTable('catalog', [{ id: 1 }]);
    await target.importFrom(source.canvasId, 'catalog');
    const tables = await target.describe();
    expect(tables.map((t) => t.name)).toContain('catalog');
  });

  it('importFrom rejects a missing source table with NotFound', async () => {
    const source = await canvas.acquire(undefined, ctx);
    const target = await canvas.acquire(undefined, ctx);
    await expect(target.importFrom(source.canvasId, 'no_such_table')).rejects.toThrow(
      /does not contain a table or view/i,
    );
  });

  it('importFrom rejects when source and target are the same canvas', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('x', [{ a: 1 }]);
    await expect(instance.importFrom(instance.canvasId, 'x', { asName: 'y' })).rejects.toThrow(
      /must differ/i,
    );
  });

  it('clear drops views before tables', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('base', [{ id: 1 }]);
    await instance.registerView('derived', 'SELECT id FROM base');
    expect(await instance.clear()).toBe(2);
    expect((await instance.describe()).length).toBe(0);
  });

  // Issue #102 — TIMESTAMP/DATE/BLOB columns previously routed through
  // `appendVarchar(String(value))` which silently corrupted Date objects
  // (locale-string format) and binary BLOBs (`String(uint8Array)` →
  // `"1,2,3"`). The typed-appender path should round-trip values cleanly.
  it('issue #102 — TIMESTAMP/DATE/BLOB round-trip via typed appenders', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    const ts = new Date('2026-01-01T12:34:56.000Z');
    const isoDate = '2026-01-01';
    const blob = new Uint8Array([0x00, 0x01, 0xfe, 0xff]);

    await instance.registerTable('typed', [{ ts, d: isoDate, b: blob, s: 'sentinel' }], {
      schema: [
        { name: 'ts', type: 'TIMESTAMP' },
        { name: 'd', type: 'DATE' },
        { name: 'b', type: 'BLOB' },
        { name: 's', type: 'VARCHAR' },
      ],
    });

    // Cast via SQL so we can assert against scalar values rather than the
    // engine's structured representation. CAST(ts AS VARCHAR) emits the
    // canonical ISO-8601-ish DuckDB timestamp form; hex(b) hexes the bytes.
    const result = await instance.query(
      'SELECT CAST(ts AS VARCHAR) AS ts_s, CAST(d AS VARCHAR) AS d_s, hex(b) AS b_hex, s FROM typed',
    );
    expect(result.rowCount).toBe(1);
    const row = result.rows[0] as Record<string, string>;
    // DuckDB renders TIMESTAMP as "YYYY-MM-DD HH:MM:SS[.fff]" — date+time
    // components must survive the round-trip. The previous corruption path
    // would land "Wed Mar 13 2026 ..." or similar, failing this match.
    expect(row.ts_s).toMatch(/^2026-01-01 12:34:56/);
    expect(row.d_s).toBe('2026-01-01');
    // hex() returns the bytes as uppercase hex; values round-trip exactly.
    expect(row.b_hex).toBe('0001FEFF');
    expect(row.s).toBe('sentinel');
  });

  it('issue #102 — incompatible BLOB value fails fast with structured error', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await expect(
      instance.registerTable('bad', [{ b: 'not-bytes' }], {
        schema: [{ name: 'b', type: 'BLOB' }],
      }),
    ).rejects.toThrow(/BLOB column/);
  });

  // Refinement #3 — pin allowlist against live DuckDB EXPLAIN output. If
  // DuckDB starts emitting an operator name that's not in our allowlist for
  // a basic SELECT, this test fails and the maintainer must decide: widen
  // the allowlist or treat the change as a bug.
  it('SQL gate fixtures: basic SELECT plans are fully covered by the allowlist', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('fx', [
      { id: 1, grp: 'a', value: 0.5 },
      { id: 2, grp: 'a', value: 0.7 },
      { id: 3, grp: 'b', value: 0.3 },
    ]);

    const fixtures = [
      'SELECT id, value FROM fx ORDER BY id',
      'SELECT grp, AVG(value) AS avg_v FROM fx GROUP BY grp',
      'SELECT a.id, b.id FROM fx a JOIN fx b ON a.grp = b.grp',
      'SELECT id, value, ROW_NUMBER() OVER (ORDER BY value) AS rn FROM fx',
      'SELECT * FROM fx WHERE id IN (SELECT id FROM fx WHERE value > 0.4)',
      'WITH t AS (SELECT id FROM fx) SELECT * FROM t',
      'SELECT id, value FROM fx LIMIT 2',
    ];

    for (const sql of fixtures) {
      // biome-ignore lint/complexity/useLiteralKeys: deliberate access to private members for fixture-driven gate verification.
      const explainResult = await provider['runExplain'].call(
        provider,
        // biome-ignore lint/complexity/useLiteralKeys: deliberate access to private members for fixture-driven gate verification.
        provider['canvases'].get(instance.canvasId)!.controlConnection,
        `EXPLAIN (FORMAT JSON) ${sql}`,
      );
      const offending = collectDisallowedOperators(explainResult);
      if (offending.size > 0) {
        const all = [...ALLOWED_PLAN_OPERATORS].sort();
        throw new Error(
          `SQL gate allowlist drift detected for "${sql}". Offending operators: ${[...offending].join(', ')}.\nAllowlist: ${all.join(', ')}`,
        );
      }
    }
  });
});

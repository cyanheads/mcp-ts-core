/**
 * @fileoverview Full round-trip smoke test against a real DuckDB instance.
 * Exercises acquire → registerTable → query → export and the SQL gate's
 * fixture-pinned plan-walk allowlist (refinement #3 in issue #97). This test
 * requires the repo's `@duckdb/node-api` dev dependency and native bindings;
 * a failed load is a failed smoke test.
 * @module tests/smoke/canvas-duckdb.test
 */

import { existsSync, rmSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  DuckDBAppender,
  DuckDBConnection,
  DuckDBInstance,
  version as duckdbVersion,
} from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CanvasInstance } from '@/services/canvas/core/CanvasInstance.js';
import { CanvasRegistry } from '@/services/canvas/core/CanvasRegistry.js';
import { DataCanvas } from '@/services/canvas/core/DataCanvas.js';
import {
  ALLOWED_PLAN_OPERATORS,
  collectDisallowedOperators,
} from '@/services/canvas/core/sqlGate.js';
import { DuckdbProvider } from '@/services/canvas/providers/duckdb/DuckdbProvider.js';
import * as exportWriter from '@/services/canvas/providers/duckdb/exportWriter.js';
import type { ExportFormat } from '@/services/canvas/types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

const ctx: RequestContext = {
  requestId: 'smoke-canvas',
  timestamp: '2026-01-01T00:00:00.000Z',
  tenantId: 'smoke-tenant',
};

/** Rows a statement over Parquet files answers, on an engine of its own: the canvas gate refuses `read_parquet`. */
async function readParquet(sql: string): Promise<Record<string, unknown>[]> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    return (await connection.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/** The `i` of each row of an export, in file order; a CSV's `i` header dropped. */
async function exportedIds(path: string, format: ExportFormat): Promise<number[]> {
  if (format === 'parquet') {
    const rows = await readParquet(
      `SELECT i FROM read_parquet('${path}', file_row_number = true) ORDER BY file_row_number`,
    );
    return rows.map((row) => Number(row.i));
  }
  const lines = (await readFile(path, 'utf8')).split('\n');
  expect(lines.pop()).toBe('');
  if (format === 'json') return lines.map((line) => (JSON.parse(line) as { i: number }).i);
  expect(lines.shift()).toMatch(/^i(,|$)/);
  return lines.map((line) => Number.parseInt(line, 10));
}

/** The `McpError` a canvas call rejects with; fails the test when it resolves. */
async function rejectionOf(call: Promise<unknown>): Promise<McpError> {
  const error = await call.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(McpError);
  return error as McpError;
}

/** The path exports' staging files left anywhere under `root`. */
async function stagingFiles(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true })).filter((name) =>
    basename(name).endsWith('.partial'),
  );
}

describe('canvas · DuckDB round trip', () => {
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
      // Most tests in this group acquire a canvas of their own and none releases it.
      maxCanvasesPerTenant: 200,
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

  // Issue #235 — describe({ tableName }) pushed an unqualified `table_name`
  // filter into a query joining information_schema.tables with duckdb_tables();
  // both expose `table_name`, so DuckDB raised a Binder Error (ambiguous column).
  // The fix qualifies the pushed filters with the `t` alias. Assert the filtered
  // path returns the single table's correct metadata, not merely "doesn't throw".
  it('issue #235 — describe({ tableName }) returns one table with correct metadata', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('df_target', [
      { id: 1, label: 'a' },
      { id: 2, label: 'b' },
    ]);
    // A second table on the same canvas — the filter must exclude it.
    await instance.registerTable('df_other', [{ id: 9 }]);

    const filtered = await instance.describe({ tableName: 'df_target' });

    expect(filtered).toHaveLength(1);
    const info = filtered[0]!;
    expect(info.name).toBe('df_target');
    expect(info.kind).toBe('table');
    expect(info.rowCount).toBe(2);
    expect(info.columns.map((col) => col.name).sort()).toEqual(['id', 'label']);
  });

  // Issue #235, latent arm — `kind` filters also pushed unqualified `table_type`.
  // duckdb_tables() exposes no `table_type` so it wasn't yet ambiguous, but the
  // fix qualifies it too. Combining tableName + kind exercises both qualified
  // predicates together.
  it('issue #235 — describe({ tableName, kind: "table" }) keeps both filters qualified', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('df_combo', [{ id: 1 }, { id: 2 }, { id: 3 }]);

    const filtered = await instance.describe({ tableName: 'df_combo', kind: 'table' });
    expect(filtered.map((t) => t.name)).toEqual(['df_combo']);
    expect(filtered[0]!.rowCount).toBe(3);

    // The same table excluded when the kind filter doesn't match it.
    const asView = await instance.describe({ tableName: 'df_combo', kind: 'view' });
    expect(asView).toHaveLength(0);
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

  // Issue #100 — read_json/read_parquet bypass. These functions lower into
  // generic scan operators that previously passed the allowlist; the SQL
  // pre-scan and plan-walk rescan should now reject them by name.
  it.each([
    ['read_csv', "SELECT * FROM read_csv('/etc/passwd')"],
    ['read_csv_auto', "SELECT * FROM read_csv_auto('/etc/passwd')"],
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

  // Issue #254 — ensureTableMissing's structured validationError crosses
  // query()'s classifyDuckdbError catch. The message alone survived the old
  // reclassification, so this test asserts code + data too: it must stay
  // ValidationError with reason/tableName intact, not become DatabaseError.
  it('rejects registerAs clashes', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('users', [{ id: 1 }]);
    let caught: unknown;
    try {
      await instance.query('SELECT 1 AS one', { registerAs: 'users' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    const mcpErr = caught as McpError;
    expect(mcpErr.message).toMatch(/already exists/i);
    // Must be ValidationError (-32007), not DatabaseError (-32010).
    expect(mcpErr.code).toBe(-32007);
    const data = mcpErr.data as { reason?: string; tableName?: string };
    expect(data.reason).toBe('register_as_clash');
    expect(data.tableName).toBe('users');
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
    expect(result.path).toBe(join(exportRoot, 'export.csv'));
    const bytes = await readFile(join(exportRoot, 'export.csv'));
    expect(bytes.toString()).toBe('id,label\n1,alpha\n2,beta\n');
    expect(result.sizeBytes).toBe(bytes.byteLength);
    expect(result.rowCount).toBe(2);
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  // Issue #254, export() manifestation — resolveExportPath's structured
  // validationErrors cross the same classifyDuckdbError catch as
  // register_as_clash; code and data.reason must survive intact.
  it('rejects export paths that escape the sandbox', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('t', [{ x: 1 }]);

    let escapeErr: unknown;
    try {
      await instance.export('t', { format: 'csv', path: '../escape.csv' });
    } catch (err) {
      escapeErr = err;
    }
    expect(escapeErr).toBeInstanceOf(McpError);
    expect((escapeErr as McpError).message).toMatch(/escapes/i);
    expect((escapeErr as McpError).code).toBe(-32007);
    expect(((escapeErr as McpError).data as { reason?: string }).reason).toBe(
      'export_path_escapes',
    );

    let absoluteErr: unknown;
    try {
      await instance.export('t', { format: 'csv', path: '/tmp/escape.csv' });
    } catch (err) {
      absoluteErr = err;
    }
    expect(absoluteErr).toBeInstanceOf(McpError);
    expect((absoluteErr as McpError).message).toMatch(/absolute/i);
    expect((absoluteErr as McpError).code).toBe(-32007);
    expect(((absoluteErr as McpError).data as { reason?: string }).reason).toBe(
      'export_path_absolute',
    );
  });

  // The export path is caller input spliced into a `COPY … TO '<path>'`
  // literal. Lexical confinement passes a relative path whatever it contains,
  // so quote-escaping is what keeps it one literal rather than the end of one
  // statement and the start of another.
  describe('export path quoting', () => {
    it('writes a path containing a quote to that exact file inside the sandbox', async () => {
      const instance = await canvas.acquire(undefined, ctx);
      await instance.registerTable('quoted_export', [{ id: 1 }]);

      const result = await instance.export('quoted_export', { format: 'csv', path: "it's.csv" });

      expect(result.path).toBe(join(exportRoot, "it's.csv"));
      expect((await readFile(join(exportRoot, "it's.csv"))).toString()).toBe('id\n1\n');
    });

    it('cannot smuggle a second COPY that writes outside the sandbox', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'canvas-smoke-outside-'));
      try {
        const instance = await canvas.acquire(undefined, ctx);
        await instance.registerTable('smuggle_src', [{ id: 1 }]);
        const target = join(outside, 'pwned.csv');

        const failure = await instance
          .export('smuggle_src', {
            format: 'csv',
            path: `a.csv' (FORMAT 'csv'); COPY "smuggle_src" TO '${target}`,
          })
          .then(
            () => undefined,
            (err: unknown) => err,
          );

        // Escaped, the whole string is one file name under directories that
        // do not exist, so the engine's open fails as an I/O fault.
        expect(failure).toBeInstanceOf(McpError);
        expect((failure as McpError).code).toBe(JsonRpcErrorCode.DatabaseError);
        expect(existsSync(target)).toBe(false);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  // A CSV or JSON export writes the bytes a plain COPY of the object writes, and
  // a Parquet export the schema and rows (its row groups are capped, so its
  // bytes differ), in the table's insertion order or a view's ORDER BY, past one
  // row group. At one engine thread DuckDB writes in order either way, so the
  // order cases catch a reordering export only on a host with two or more cores.
  describe('export bytes and row order', () => {
    const ORDERED_ROWS = 400_000;
    let exporting: CanvasInstance;

    beforeAll(async () => {
      exporting = await canvas.acquire(undefined, ctx);
      await exporting.query(
        `SELECT * FROM (VALUES
          (1, 1.5::DOUBLE, 12.345::DECIMAL(18, 3), 'plain', DATE '2024-01-02', TIMESTAMP '2024-01-02 03:04:05.678', true, [1, 2, NULL], {'k': 'v', 'n': 1}, MAP {'a': 1}, 'z'),
          (2, -0.25, -1.5, 'has "quotes", a comma', NULL, NULL, false, [], {'k': NULL, 'n': NULL}, MAP {}, NULL),
          (3, NULL, NULL, 'line one' || chr(10) || 'line two', DATE '1970-01-01', TIMESTAMP '1970-01-01 00:00:00', NULL, NULL, NULL, NULL, NULL)
        ) AS v(i, d, n, s, dt, ts, b, l, st, m, z)`,
        { registerAs: 'mixed' },
      );
      // Four row groups of 122,880 rows.
      await exporting.query(`SELECT i FROM range(${ORDERED_ROWS}) r(i)`, {
        registerAs: 'ordered',
      });
      await exporting.registerView('ordered_desc', 'SELECT i FROM ordered ORDER BY i DESC');
    });

    it.each(['csv', 'json'] as const)(
      'writes the %s bytes a plain COPY of a mixed-type table writes',
      async (format) => {
        const result = await exporting.export('mixed', { format, path: `mixed.${format}` });
        expect(result.rowCount).toBe(3);

        // biome-ignore lint/complexity/useLiteralKeys: deliberate access to the private record to run a plain COPY past the provider's export.
        const record = provider['canvases'].get(exporting.canvasId)!;
        const plainPath = join(exportRoot, `mixed-plain.${format}`);
        await record.controlConnection.run(
          `COPY "mixed" TO '${plainPath}' ${exportWriter.copyFormatClause(format, duckdbVersion())}`,
        );
        const written = await readFile(join(exportRoot, `mixed.${format}`), 'utf8');
        expect(written).toBe(await readFile(plainPath, 'utf8'));
        expect(written).toContain(
          format === 'csv' ? '"has ""quotes"", a comma"' : '"has \\"quotes\\", a comma"',
        );
      },
    );

    it('writes a mixed-type table as Parquet that reads back the schema and rows a plain COPY of it does', async () => {
      const result = await exporting.export('mixed', { format: 'parquet', path: 'mixed.parquet' });
      expect(result.rowCount).toBe(3);

      // biome-ignore lint/complexity/useLiteralKeys: deliberate access to the private record to run a plain COPY past the provider's export.
      const record = provider['canvases'].get(exporting.canvasId)!;
      const plainPath = join(exportRoot, 'mixed-plain.parquet');
      await record.controlConnection.run(`COPY "mixed" TO '${plainPath}' (FORMAT 'parquet')`);
      const schemaOf = (path: string) =>
        readParquet(`SELECT column_name, column_type FROM (DESCRIBE FROM read_parquet('${path}'))`);
      const rowsOf = (path: string) =>
        readParquet(
          `SELECT * EXCLUDE (file_row_number) FROM read_parquet('${path}', file_row_number = true) ORDER BY file_row_number`,
        );
      const writtenPath = join(exportRoot, 'mixed.parquet');
      const schema = await schemaOf(writtenPath);
      expect(schema).toHaveLength(11);
      expect(schema).toEqual(await schemaOf(plainPath));
      const rows = await rowsOf(writtenPath);
      expect(rows.map((row) => row.s)).toEqual([
        'plain',
        'has "quotes", a comma',
        'line one\nline two',
      ]);
      expect(rows).toEqual(await rowsOf(plainPath));
    });

    it.each(['csv', 'json', 'parquet'] as const)(
      'writes every row of a table spanning several row groups as %s in insertion order',
      async (format) => {
        const result = await exporting.export('ordered', { format, path: `ordered.${format}` });
        expect(result.rowCount).toBe(ORDERED_ROWS);
        const ids = await exportedIds(join(exportRoot, `ordered.${format}`), format);
        expect(ids).toHaveLength(ORDERED_ROWS);
        expect(ids.findIndex((id, line) => id !== line)).toBe(-1);
      },
    );

    it.each(['csv', 'json', 'parquet'] as const)(
      'writes a view as %s in the order its ORDER BY sets',
      async (format) => {
        const result = await exporting.export('ordered_desc', {
          format,
          path: `ordered_desc.${format}`,
        });
        expect(result.rowCount).toBe(ORDERED_ROWS);
        const ids = await exportedIds(join(exportRoot, `ordered_desc.${format}`), format);
        expect(ids).toHaveLength(ORDERED_ROWS);
        expect(ids.findIndex((id, line) => id !== ORDERED_ROWS - 1 - line)).toBe(-1);
      },
    );

    // An export reads one version of the object: its row count, its column
    // list, and its COPY all see the table as it stood when the export began.
    it.each(['csv', 'json', 'parquet'] as const)(
      'writes the %s rows a table held when the export began, though another call stages it again before the COPY',
      async (format) => {
        const table = `restaged_${format}`;
        await exporting.registerTable(table, [{ i: 0 }, { i: 1 }]);
        const internals = provider as unknown as {
          countRows(connection: unknown, name: string): Promise<number>;
        };
        const countRows = internals.countRows.bind(provider);
        const spy = vi.spyOn(internals, 'countRows').mockImplementationOnce(async (...args) => {
          const counted = await countRows(...args);
          await exporting.registerTable(table, [{ i: 7, extra: 'x' }]);
          return counted;
        });
        try {
          const result = await exporting.export(table, { format, path: `${table}.${format}` });
          expect(spy).toHaveBeenCalledOnce();
          expect(result.rowCount).toBe(2);
          expect(await exportedIds(join(exportRoot, `${table}.${format}`), format)).toEqual([0, 1]);
        } finally {
          spy.mockRestore();
        }
        // The call that staged it again committed: later reads see its table.
        expect((await exporting.query(`SELECT i, extra FROM ${table}`)).rows).toEqual([
          { i: '7', extra: 'x' },
        ]);
      },
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
    let caught: unknown;
    try {
      await target.importFrom(source.canvasId, 'no_such_table');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    const mcpErr = caught as McpError;
    // NotFound (-32001) with a structured reason + recovery (issue #264) — not a bare message.
    expect(mcpErr.code).toBe(-32001);
    expect(mcpErr.message).toMatch(/does not contain a table or view/i);
    const data = mcpErr.data as { reason?: string; recovery?: { hint?: string } };
    expect(data.reason).toBe('missing_table');
    // Issue #299 — the hint names a capability the caller can reach through the
    // consuming server's tools, never a framework method.
    expect(data.recovery?.hint).toBe(
      "Re-check the source table name, or list the tables staged on the source canvas with this server's dataframe-describe tool.",
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
      const all = [...ALLOWED_PLAN_OPERATORS].sort();
      expect(
        [...offending],
        `SQL gate allowlist drift detected for "${sql}". Allowlist: ${all.join(', ')}`,
      ).toEqual([]);
    }
  });

  // Issue #210 — fail-closed gate: bare PRAGMA returns ValidationError, not -32603.
  it('issue #210 — bare PRAGMA yields non_select_statement ValidationError, not InternalError', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('t', [{ x: 1 }]);
    let caught: unknown;
    try {
      await instance.query('PRAGMA show_tables');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    const mcpErr = caught as McpError;
    // Must be ValidationError (-32007), not InternalError (-32603).
    expect(mcpErr.code).toBe(-32007);
    expect((mcpErr.data as { reason?: string } | undefined)?.reason).toBe('non_select_statement');
  });

  // The parse-tree layer fails closed: a SELECT the serializer reports it
  // cannot represent is refused, never run unchecked. No statement that
  // prepares as one SELECT does this on DuckDB v1.5.6, so the serializer's
  // error shape is substituted for its answer on the canvas's own connection.
  it('refuses a SELECT whose parse tree the engine cannot serialize', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('t', [{ x: 1 }]);
    // biome-ignore lint/complexity/useLiteralKeys: deliberate access to the private record to substitute one engine answer.
    const connection = provider['canvases'].get(instance.canvasId)!.controlConnection;
    const runAndReadAll = connection.runAndReadAll.bind(connection);
    const serialize = vi
      .spyOn(connection, 'runAndReadAll')
      .mockImplementation((sql, ...rest) =>
        sql.startsWith('SELECT json_serialize_sql(')
          ? runAndReadAll(
              `SELECT '{"error":true,"error_type":"not implemented","error_message":"x"}' AS tree`,
            )
          : runAndReadAll(sql, ...rest),
      );
    try {
      await expect(instance.query('SELECT x FROM t')).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'non_select_statement' },
      });
      expect(serialize).toHaveBeenCalledWith(
        expect.stringMatching(/^SELECT json_serialize_sql\(/),
        ['SELECT x FROM t'],
      );
    } finally {
      serialize.mockRestore();
    }
    expect((await instance.query('SELECT x FROM t')).rows).toEqual([{ x: '1' }]);
  });

  // Issue #210 — pragma_* TVF bypass: SELECT * FROM pragma_table_info('t')
  // must be rejected before executing.
  it('issue #210 — pragma_* table function is denied by the gate', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('t', [{ x: 1 }]);
    await expect(instance.query("SELECT * FROM pragma_table_info('t')")).rejects.toThrow(
      /disallowed table function/i,
    );
  });

  it('issue #210 — pragma_database_list() is denied by the gate', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await expect(instance.query('SELECT * FROM pragma_database_list()')).rejects.toThrow(
      /disallowed table function/i,
    );
  });

  // Issue #221 — inferred schema always nullable: register table with no explicit
  // schema where a column is null-free in the sniff window but has nulls after.
  it('issue #221 — null past the sniff window does not fail registration', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    // Build rows where the first 100 (the sniff window) have ticker populated,
    // but row 101 is null for ticker.
    const rows = Array.from({ length: 110 }, (_, i) =>
      i < 100 ? { id: i, ticker: `TICK_${i}` } : { id: i, ticker: null },
    );
    // Pre-fix: this would throw because inferred schema had NOT NULL on ticker.
    await expect(instance.registerTable('stocks', rows)).resolves.toMatchObject({
      tableName: 'stocks',
      rowCount: 110,
    });
    // The null row survives the round-trip.
    const result = await instance.query('SELECT COUNT(*) AS n FROM stocks WHERE ticker IS NULL');
    expect(Number(result.rows[0]?.n)).toBe(10);
  });

  // Issue #222 — streamAndReadUntil: truncated flag set when result exceeds rowLimit.
  it('issue #222 — query sets truncated: true when result exceeds rowLimit', async () => {
    const bigProvider = new DuckdbProvider({
      memoryLimitMb: 256,
      exportRootPath: exportRoot,
      defaultRowLimit: 10,
      schemaSniffRows: 100,
    });
    const bigRegistry = new CanvasRegistry(bigProvider, {
      ttlMs: 60_000,
      absoluteCapMs: 600_000,
      maxCanvasesPerTenant: 100,
      sweeperIntervalMs: 0,
    });
    const bigCanvas = new DataCanvas(bigProvider, bigRegistry);
    try {
      const instance = await bigCanvas.acquire(undefined, ctx);
      const rows = Array.from({ length: 50 }, (_, i) => ({ x: i }));
      await instance.registerTable('big', rows);

      const result = await instance.query('SELECT x FROM big ORDER BY x');
      expect(result.truncated).toBe(true);
      expect(result.rows.length).toBe(10);
      expect(result.rowCount).toBe(10);

      // Below the limit: no truncation.
      const small = await instance.query('SELECT x FROM big WHERE x < 5 ORDER BY x');
      expect(small.truncated).toBeUndefined();
      expect(small.rows.length).toBe(5);
    } finally {
      await bigCanvas.shutdown(ctx);
    }
  });

  // Issue #261 — the provider's own lookup throw is defensive (CanvasInstance
  // touches the registry first, which rejects before the provider is reached),
  // but it carries the same structured canvas_not_found reason/recovery shape.
  it('issue #261 — provider-level unknown canvas id throws canvas_not_found with recovery', async () => {
    let caught: unknown;
    try {
      await provider.query('ZZZZZZZZZZ', 'SELECT 1', ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    const mcpErr = caught as McpError;
    // Must be NotFound (-32001).
    expect(mcpErr.code).toBe(-32001);
    const data = mcpErr.data as { reason?: string; recovery?: { hint?: string } };
    expect(data.reason).toBe('canvas_not_found');
    expect(typeof data.recovery?.hint).toBe('string');
  });

  // Issue #223 — missing-table query yields NotFound, not ValidationError.
  it('issue #223 — querying a non-existent table throws NotFound with reason missing_table', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    let caught: unknown;
    try {
      await instance.query('SELECT * FROM does_not_exist');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    const mcpErr = caught as McpError;
    // Must be NotFound (-32001), not ValidationError (-32007).
    expect(mcpErr.code).toBe(-32001);
    const data = mcpErr.data as { reason?: string; recovery?: { hint?: string } };
    expect(data.reason).toBe('missing_table');
    // Issue #299 — the prepare-time site is the second missing_table throw; its
    // hint and message stay inside what the caller can act on.
    expect(data.recovery?.hint).toBe(
      "Re-run the tool that produced this table to stage it again, or list the currently staged tables with this server's dataframe-describe tool.",
    );
    expect(mcpErr.message).not.toMatch(/registerTable|describe\(\)/);
  });

  // Issue #236 — a SELECT-shaped statement that fails to prepare for a reason
  // other than a missing table (here a mistyped column) is classified as
  // invalid_sql, and the DuckDB binder detail is preserved in data.binderMessage
  // so callers see which column was wrong — not mislabeled non_select_statement.
  it('issue #236 — mistyped column in a SELECT yields invalid_sql with binder detail', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('items236', [{ id: 1, name: 'alpha' }]);
    let caught: unknown;
    try {
      await instance.query('SELECT nonexistent_col FROM items236');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    const mcpErr = caught as McpError;
    // ValidationError (-32007), reason invalid_sql — NOT non_select_statement.
    expect(mcpErr.code).toBe(-32007);
    const data = mcpErr.data as { reason?: string; binderMessage?: string };
    expect(data.reason).toBe('invalid_sql');
    expect(typeof data.binderMessage).toBe('string');
    expect(data.binderMessage).toContain('nonexistent_col');
  });

  // Issue #236 — a genuine non-SELECT statement (prepares, but types as INSERT)
  // still classifies as non_select_statement; the invalid_sql path must not
  // leak onto statements that are simply the wrong shape.
  it('issue #236 — a genuine non-SELECT still yields non_select_statement', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('items236b', [{ x: 1 }]);
    let caught: unknown;
    try {
      await instance.query('INSERT INTO items236b VALUES (2)');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).data?.reason).toBe('non_select_statement');
  });

  // Issue #484 — only a missing table is missing_table. Every other catalog
  // miss on a SELECT-shaped statement is invalid_sql with the binder detail;
  // the old match named the missing function/type/schema as a table.
  describe('issue #484 — catalog misses other than a table', () => {
    async function rejection(run: () => Promise<unknown>): Promise<McpError> {
      try {
        await run();
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        return err as McpError;
      }
      throw new Error('expected the canvas call to reject');
    }

    it.each([
      ['scalar function', 'SELECT nosuchfn(1) FROM items484', 'nosuchfn'],
      ['table function', 'SELECT * FROM nosuchtablefn(3)', 'nosuchtablefn'],
      ['type', 'SELECT 1::nosuchtype', 'nosuchtype'],
      ['collation', "SELECT 'a' COLLATE nosuchcoll", 'nosuchcoll'],
      ['schema', 'SELECT * FROM nosuchschema.items484', 'nosuchschema'],
    ])('a missing %s is invalid_sql naming it in binderMessage', async (_label, sql, name) => {
      const instance = await canvas.acquire(undefined, ctx);
      await instance.registerTable('items484', [{ id: 1 }]);

      const error = await rejection(() => instance.query(sql));

      expect(error.code).toBe(-32007);
      const data = error.data as { reason?: string; binderMessage?: string; tableName?: string };
      expect(data.reason).toBe('invalid_sql');
      expect(data.binderMessage).toContain(name);
      expect(data).not.toHaveProperty('tableName');
    });

    it('registerView classifies a missing function the same way', async () => {
      const instance = await canvas.acquire(undefined, ctx);
      await instance.registerTable('items484v', [{ id: 1 }]);

      const error = await rejection(() =>
        instance.registerView('v484', 'SELECT nosuchfn(id) FROM items484v'),
      );

      expect(error.code).toBe(-32007);
      expect(error.data?.reason).toBe('invalid_sql');
    });

    it('a quoted table name with a space is missing_table with the full name', async () => {
      const instance = await canvas.acquire(undefined, ctx);

      const error = await rejection(() => instance.query('SELECT * FROM "my table"'));

      expect(error.code).toBe(-32001);
      expect(error.data).toMatchObject({ reason: 'missing_table', tableName: 'my table' });
      expect(error.message).toContain('"my table"');
    });

    it.each([
      ['SELECT * FROM', 'SELECT * FROM gone484'],
      ['a bare FROM', 'FROM gone484'],
      ['a WITH query', 'WITH x AS (SELECT * FROM gone484) SELECT * FROM x'],
      ['a main-qualified name', 'SELECT * FROM main.gone484'],
    ])('a missing table under %s stays missing_table (#223)', async (_label, sql) => {
      const instance = await canvas.acquire(undefined, ctx);

      const error = await rejection(() => instance.query(sql));

      expect(error.code).toBe(-32001);
      expect(error.data).toMatchObject({
        reason: 'missing_table',
        tableName: 'gone484',
        recovery: {
          hint: "Re-run the tool that produced this table to stage it again, or list the currently staged tables with this server's dataframe-describe tool.",
        },
      });
    });

    it('registerView over a missing table is missing_table', async () => {
      const instance = await canvas.acquire(undefined, ctx);

      const error = await rejection(() => instance.registerView('v484m', 'SELECT * FROM gone484'));

      expect(error.code).toBe(-32001);
      expect(error.data).toMatchObject({ reason: 'missing_table', tableName: 'gone484' });
    });

    // A write or DDL statement naming a table that does not exist fails DuckDB's
    // prepare with the same catalog text a missing SELECT source does. The
    // statement is rejected for its shape, so re-staging the table would not help.
    it.each([
      ['DROP TABLE', 'DROP TABLE gone484w'],
      ['DELETE', 'DELETE FROM gone484w'],
      ['INSERT', 'INSERT INTO gone484w VALUES (1)'],
      ['UPDATE', 'UPDATE gone484w SET a = 1'],
      ['ALTER TABLE', 'ALTER TABLE gone484w ADD COLUMN b INTEGER'],
    ])(
      '%s against a missing table is non_select_statement, not missing_table',
      async (_label, sql) => {
        const instance = await canvas.acquire(undefined, ctx);

        const error = await rejection(() => instance.query(sql));

        expect(error.code).toBe(-32007);
        expect(error.data).toMatchObject({ reason: 'non_select_statement' });
        expect(error.data).not.toHaveProperty('tableName');
      },
    );

    it('registerView over a DROP of a missing table is non_select_statement', async () => {
      const instance = await canvas.acquire(undefined, ctx);

      const error = await rejection(() => instance.registerView('v484d', 'DROP TABLE gone484w'));

      expect(error.code).toBe(-32007);
      expect(error.data).toMatchObject({ reason: 'non_select_statement' });
    });
  });

  // Issue #597 — a statement DuckDB parses as a SELECT is a read whatever it
  // opens with, so one that fails to prepare keeps its missing table and its
  // binder detail. A statement DuckDB cannot parse is read by its opening, past
  // comments and parentheses. A PIVOT without an IN list creates a type before
  // its SELECT runs, and is refused before it is prepared, naming the list.
  describe('issue #597 — reads that open with something other than SELECT, WITH, or FROM', () => {
    const MISSING_TABLE_HINT =
      "Re-run the tool that produced this table to stage it again, or list the currently staged tables with this server's dataframe-describe tool.";
    const PARSE_HINT =
      'Fix the SQL syntax the message names and send a single read-only SELECT. Put AS before an alias that is a SQL keyword, or double-quote it.';
    const NON_SELECT_HINT =
      'Rewrite as a single SELECT — this surface is read-only and cannot create, alter, or drop tables.';
    const PIVOT_HINT =
      'A PIVOT runs as one SELECT only when it lists its values, as ON column IN (value, ...): list them, or rewrite as a single SELECT — this surface is read-only and cannot create, alter, or drop tables.';
    let reads: CanvasInstance;

    beforeAll(async () => {
      reads = await canvas.acquire(undefined, ctx);
      await reads.registerTable('t597', [
        { category: 'a', v: 1 },
        { category: 'b', v: 2 },
      ]);
    });

    /** The types created on the canvas's own engine, read past the gate. */
    async function userTypes(): Promise<unknown[]> {
      // biome-ignore lint/complexity/useLiteralKeys: deliberate access to the private record to read the engine's catalog past the gate.
      const connection = provider['canvases'].get(reads.canvasId)!.controlConnection;
      const reader = await connection.runAndReadAll(
        'SELECT type_name FROM duckdb_types() WHERE NOT internal',
      );
      return reader.getRowObjectsJson();
    }

    /** Each read DuckDB parses as a SELECT, over `table`, and the rows it answers when `table` is t597. */
    const READS: [label: string, sql: (table: string) => string, rows: unknown][] = [
      ['SUMMARIZE', (t) => `SUMMARIZE ${t}`, { column_name: ['category', 'v'], count: ['2', '2'] }],
      [
        'SUMMARIZE over a SELECT',
        (t) => `SUMMARIZE SELECT * FROM ${t}`,
        { column_name: ['category', 'v'], count: ['2', '2'] },
      ],
      [
        'DESCRIBE',
        (t) => `DESCRIBE ${t}`,
        { column_name: ['category', 'v'], column_type: ['VARCHAR', 'BIGINT'] },
      ],
      [
        'SHOW',
        (t) => `SHOW ${t}`,
        { column_name: ['category', 'v'], column_type: ['VARCHAR', 'BIGINT'] },
      ],
      [
        'TABLE',
        (t) => `TABLE ${t}`,
        [
          { category: 'a', v: '1' },
          { category: 'b', v: '2' },
        ],
      ],
      [
        'PIVOT … IN',
        (t) => `PIVOT ${t} ON category IN ('a', 'b') USING sum(v)`,
        [{ a: '1', b: '2' }],
      ],
      [
        'UNPIVOT',
        (t) => `UNPIVOT ${t} ON v INTO NAME k VALUE val`,
        [
          { category: 'a', k: 'v', val: '1' },
          { category: 'b', k: 'v', val: '2' },
        ],
      ],
      ['VALUES over a subquery', (t) => `VALUES ((SELECT max(v) FROM ${t}))`, [{ col0: '2' }]],
      [
        'a parenthesised SELECT',
        (t) => `(SELECT * FROM ${t} ORDER BY category)`,
        [
          { category: 'a', v: '1' },
          { category: 'b', v: '2' },
        ],
      ],
      [
        'a doubly parenthesised SELECT',
        (t) => `((SELECT v FROM ${t} ORDER BY v))`,
        [{ v: '1' }, { v: '2' }],
      ],
      [
        'a SELECT behind a block comment',
        (t) => `/* c */ SELECT v FROM ${t} ORDER BY v`,
        [{ v: '1' }, { v: '2' }],
      ],
      [
        'a SELECT behind a line comment',
        (t) => `-- c\nSELECT v FROM ${t} ORDER BY v`,
        [{ v: '1' }, { v: '2' }],
      ],
      [
        'a SELECT behind a nested comment',
        (t) => `/* a /* b */ c */ SELECT v FROM ${t} ORDER BY v`,
        [{ v: '1' }, { v: '2' }],
      ],
    ];
    const readCases = READS.map(([label, sql, rows], i) => [label, sql, rows, i] as const);

    /** `rows` as `expected` names it: the listed columns of each row, or the rows whole. */
    function shapeOf(rows: Record<string, unknown>[], expected: unknown): unknown {
      if (Array.isArray(expected)) return rows;
      return Object.fromEntries(
        Object.keys(expected as object).map((column) => [column, rows.map((row) => row[column])]),
      );
    }

    it.each(readCases)('%s with its table staged answers as before', async (_label, sql, rows) => {
      const result = await reads.query(sql('t597'));
      expect(shapeOf(result.rows, rows)).toEqual(rows);
    });

    it.each(readCases)(
      '%s over a missing table is missing_table through query() and registerView()',
      async (_label, sql, _rows, i) => {
        for (const run of [
          () => reads.query(sql('gone597')),
          () => reads.registerView(`v597_${i}`, sql('gone597')),
        ]) {
          const error = await rejectionOf(run());
          expect(error.code).toBe(JsonRpcErrorCode.NotFound);
          expect(error.data).toEqual({
            reason: 'missing_table',
            tableName: 'gone597',
            recovery: { hint: MISSING_TABLE_HINT },
          });
        }
      },
    );

    it.each([
      ['VALUES over an unknown function', 'VALUES (no_such_fn597(1))', 'no_such_fn597'],
      ['a parenthesised SELECT of an unknown column', '(SELECT nope597 FROM t597)', 'nope597'],
      ['UNPIVOT on an unknown column', 'UNPIVOT t597 ON nope597 INTO NAME k VALUE val', 'nope597'],
      [
        'DESCRIBE over a SELECT of an unknown column',
        'DESCRIBE SELECT nope597 FROM t597',
        'nope597',
      ],
      [
        'a SELECT behind a comment of an unknown column',
        '/* c */ SELECT nope597 FROM t597',
        'nope597',
      ],
    ])(
      '%s is invalid_sql with the binder detail through query() and registerView()',
      async (_label, sql, name) => {
        for (const run of [() => reads.query(sql), () => reads.registerView('v597_bad', sql)]) {
          const error = await rejectionOf(run());
          expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
          expect(error.data?.reason).toBe('invalid_sql');
          expect(error.data?.binderMessage).toContain(name);
          expect(error.data).not.toHaveProperty('tableName');
        }
      },
    );

    it.each([
      ['a block comment', '/* c */ SELECT * FRM t597'],
      ['a line comment', '-- c\nSELECT * FRM t597'],
      ['a parenthesis', '(SELECT * FRM t597)'],
      ['a comment and a parenthesis', '/* c */ (VALUES (1) x y z)'],
    ])(
      'a read behind %s that fails to parse is invalid_sql with the parser message',
      async (_label, sql) => {
        const error = await rejectionOf(reads.query(sql));
        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.message).toMatch(/^Canvas query failed to prepare: .*Parser Error: /);
        expect(error.data).toMatchObject({
          reason: 'invalid_sql',
          binderMessage: expect.stringMatching(/Parser Error: /),
          recovery: { hint: PARSE_HINT },
        });
      },
    );

    it.each([
      ['a block comment', '/* SELECT */ DELET FROM t597'],
      ['a parenthesis', '(DELET FROM t597)'],
    ])(
      'a statement behind %s that fails to parse and opens with no read stays non_select_statement',
      async (_label, sql) => {
        const error = await rejectionOf(reads.query(sql));
        expect(error.message).toBe(
          'Canvas query must be SELECT; the statement could not be parsed or prepared.',
        );
        expect(error.data).toEqual({
          reason: 'non_select_statement',
          statementType: 'UNKNOWN',
          recovery: { hint: NON_SELECT_HINT },
        });
      },
    );

    it.each([
      ['PIVOT', 'PIVOT t597 ON category USING sum(v)'],
      ['PIVOT_WIDER', 'PIVOT_WIDER t597 ON category USING sum(v)'],
      ['a PIVOT inside a SELECT', 'SELECT * FROM (PIVOT t597 ON category USING sum(v))'],
      ['a PIVOT over a missing table', 'PIVOT gone597 ON category USING sum(v)'],
    ])(
      '%s without an IN list is non_select_statement naming the list, and creates no type',
      async (_label, sql) => {
        for (const run of [
          () => reads.query(sql),
          () => reads.registerView('v597_pivot', sql),
          () => reads.query(sql, { registerAs: 'ra597_pivot' }),
        ]) {
          const error = await rejectionOf(run());
          expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
          expect(error.message).toBe('Canvas query must be SELECT.');
          expect(error.data).toEqual({
            reason: 'non_select_statement',
            statementType: 'UNKNOWN',
            recovery: { hint: PIVOT_HINT },
          });
        }
        expect(await userTypes()).toEqual([]);
      },
    );

    // The control for the check above: run past the gate, the same PIVOT
    // creates a type on the engine.
    it('a PIVOT without an IN list creates a type when an engine runs it', async () => {
      const plain = await DuckDBInstance.create(':memory:');
      const connection = await plain.connect();
      try {
        await connection.run(
          "CREATE TABLE t597 AS SELECT * FROM (VALUES ('a', 1), ('b', 2)) v(category, v)",
        );
        await connection.run('PIVOT t597 ON category USING sum(v)');
        const reader = await connection.runAndReadAll(
          'SELECT type_name FROM duckdb_types() WHERE NOT internal',
        );
        expect(reader.getRowObjectsJson()).toHaveLength(1);
      } finally {
        connection.closeSync();
        plain.closeSync();
      }
    });

    it.each([
      'WITH x AS (SELECT 1) DELETE FROM gone597',
      '/* c */ DELETE FROM gone597',
      "COPY t597 TO 'x597.csv'",
      'EXPLAIN SELECT * FROM t597',
      'PRAGMA version',
      'DELETE FROM "pivot"',
      'EXPLAIN SELECT 1 AS pivot',
    ])('%s stays non_select_statement, refused before it is prepared', async (sql) => {
      const error = await rejectionOf(reads.query(sql));
      expect(error.message).toBe('Canvas query must be SELECT.');
      expect(error.data).toEqual({
        reason: 'non_select_statement',
        statementType: 'UNKNOWN',
        recovery: { hint: NON_SELECT_HINT },
      });
    });

    it.each([
      'SELECT 1; SELECT 2 AS pivot',
      'PIVOT t597 ON category USING sum(v); SELECT 1',
      "SELECT 1; PIVOT t597 ON category IN ('a') USING sum(v)",
    ])('%s, several statements holding the word PIVOT, stays multi_statement', async (sql) => {
      const error = await rejectionOf(reads.query(sql));
      expect(error.data?.reason).toBe('multi_statement');
      expect(await userTypes()).toEqual([]);
    });

    it.each(['SHOW TABLES', 'DESCRIBE'])('%s stays plan_operator_not_allowed', async (sql) => {
      const error = await rejectionOf(reads.query(sql));
      expect(error.data?.reason).toBe('plan_operator_not_allowed');
    });
  });

  // DuckDB's FROM-first syntax is a read-only SELECT: it prepares as SELECT and
  // passes the gate. When one fails to prepare, it is classified like any
  // other SELECT — the binder detail, not the non-SELECT rejection.
  describe('FROM-first queries', () => {
    it.each([
      ['a bare FROM', 'FROM fromfirst', [{ name: 'alpha' }, { name: 'beta' }]],
      [
        'FROM … SELECT',
        'FROM fromfirst SELECT upper(name) AS up ORDER BY up',
        [{ up: 'ALPHA' }, { up: 'BETA' }],
      ],
    ])('%s passes the gate and returns rows', async (_label, sql, expected) => {
      const instance = await canvas.acquire(undefined, ctx);
      await instance.registerTable('fromfirst', [{ name: 'alpha' }, { name: 'beta' }]);

      const result = await instance.query(sql);

      expect(result.rows).toEqual(expected);
    });

    it('a mistyped column in FROM … SELECT is invalid_sql with the binder detail', async () => {
      const instance = await canvas.acquire(undefined, ctx);
      await instance.registerTable('fromfirst_bad', [{ a: 1 }]);

      let caught: unknown;
      try {
        await instance.query('FROM fromfirst_bad SELECT nosuch_col');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(McpError);
      const error = caught as McpError;
      expect(error.code).toBe(-32007);
      expect(error.data?.reason).toBe('invalid_sql');
      expect(error.data?.binderMessage).toContain('nosuch_col');
    });

    it('a FROM-first write is still rejected', async () => {
      const instance = await canvas.acquire(undefined, ctx);
      await instance.registerTable('fromfirst_w', [{ a: 1 }]);

      let caught: unknown;
      try {
        await instance.query('FROM fromfirst_w SELECT a; DROP TABLE fromfirst_w');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(McpError);
      expect((caught as McpError).data?.reason).toBe('multi_statement');
    });
  });

  // range() and generate_series() called with constant arguments plan under
  // their own names and pass the gate, for calendar spines and gap-filling. A
  // staged table named `range` is on the canvas throughout: a bare `FROM range`
  // reads it, and every call below still binds the function.
  describe('range() and generate_series() series', () => {
    const BINDER_EXECUTION_HINT =
      'Correct the argument the message names, such as a zero step or an infinite bound in range or generate_series. When it names a column, define the view that reads it again over the tables as now staged.';
    let series: CanvasInstance;

    beforeAll(async () => {
      series = await canvas.acquire(undefined, ctx);
      await series.registerTable('series_src', [{ x: 1 }, { x: 2 }, { x: 3 }]);
      await series.registerTable('range', [{ x: 7 }]);
    });

    const ADMITTED = [
      ['range(n)', 'SELECT * FROM range(3)', 3],
      ['range(a, b, step)', 'SELECT * FROM range(1, 10, 2)', 5],
      [
        'range over TIMESTAMP with an INTERVAL step',
        "SELECT * FROM range(TIMESTAMP '2024-01-01', TIMESTAMP '2024-01-04', INTERVAL 1 DAY)",
        3,
      ],
      [
        'range over TIMESTAMPTZ with an INTERVAL step',
        "SELECT * FROM range(TIMESTAMPTZ '2024-01-01 00:00:00+00', TIMESTAMPTZ '2024-01-03 00:00:00+00', INTERVAL 1 DAY)",
        2,
      ],
      ['generate_series(a, b)', 'SELECT * FROM generate_series(1, 3)', 3],
      [
        'generate_series over TIMESTAMP with an INTERVAL step',
        "SELECT * FROM generate_series(TIMESTAMP '2024-01-01', TIMESTAMP '2024-01-03', INTERVAL 1 DAY)",
        3,
      ],
      [
        'generate_series over TIMESTAMPTZ with an INTERVAL step',
        "SELECT * FROM generate_series(TIMESTAMPTZ '2024-01-01 00:00:00+00', TIMESTAMPTZ '2024-01-03 00:00:00+00', INTERVAL 1 DAY)",
        3,
      ],
      ['a quoted, schema-qualified "range"', 'SELECT * FROM system.main."range"(3)', 3],
      [
        'a spine left-joined to a staged table',
        'SELECT r.i, count(s.x) AS n FROM range(5) r(i) LEFT JOIN series_src s ON s.x = r.i GROUP BY r.i',
        5,
      ],
    ] as const;
    const admitted = ADMITTED.map(([label, sql, rows], i) => [label, sql, rows, i] as const);

    it.each(admitted)('query() admits %s', async (_label, sql, rows) => {
      const result = await series.query(sql);
      expect(result.rowCount).toBe(rows);
      expect(result.rows).toHaveLength(rows);
    });

    it.each(admitted)('query({ registerAs }) admits %s', async (_label, sql, rows, i) => {
      const result = await series.query(sql, { registerAs: `series_t_${i}` });
      expect(result).toMatchObject({ tableName: `series_t_${i}`, rowCount: rows });
    });

    it.each(admitted)('registerView() admits %s', async (_label, sql, rows, i) => {
      await series.registerView(`series_v_${i}`, sql);
      const result = await series.query(`SELECT count(*)::INTEGER AS n FROM series_v_${i}`);
      expect(result.rows).toEqual([{ n: rows }]);
    });

    it('fills the gaps of a spine with zero counts, in spine order', async () => {
      const result = await series.query(
        'SELECT r.i, count(s.x)::INTEGER AS n FROM range(5) r(i) LEFT JOIN series_src s ON s.x = r.i GROUP BY r.i ORDER BY r.i',
      );
      expect(result.rows).toEqual([
        { i: '0', n: 0 },
        { i: '1', n: 1 },
        { i: '2', n: 1 },
        { i: '3', n: 1 },
        { i: '4', n: 0 },
      ]);
    });

    it('reads the staged table named range bare, and binds the function when called', async () => {
      expect((await series.query('SELECT * FROM range')).rows).toEqual([{ x: '7' }]);
      expect((await series.query('SELECT * FROM range(3)')).rows).toEqual([
        { range: '0' },
        { range: '1' },
        { range: '2' },
      ]);
    });

    it('returns rowLimit rows of a trillion-row series, marked truncated', async () => {
      const result = await series.query('SELECT * FROM range(1000000000000)', { rowLimit: 100 });
      expect(result).toMatchObject({ rowCount: 100, truncated: true });
      expect(result.rows).toHaveLength(100);
      expect(result.rows[0]).toEqual({ range: '0' });
      expect(result.rows[99]).toEqual({ range: '99' });
    });

    const BAD_ARGUMENTS = [
      ['a zero range step', 'SELECT * FROM range(0, 10, 0)'],
      ['a zero generate_series step', 'SELECT * FROM generate_series(0, 10, 0)'],
      [
        'a zero INTERVAL step',
        "SELECT * FROM generate_series(TIMESTAMP '2024-01-01', TIMESTAMP '2024-01-02', INTERVAL 0 DAY)",
      ],
      [
        'infinite TIMESTAMP bounds',
        "SELECT * FROM range(TIMESTAMP '-infinity', TIMESTAMP 'infinity', INTERVAL 1 DAY)",
      ],
    ] as const;

    /** The rejection of an argument the series rejects as it runs, after the gate prepared it. */
    function expectArgumentRejection(error: unknown): void {
      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'sql_execution_error', recovery: { hint: BINDER_EXECUTION_HINT } },
      });
      expect((error as McpError).message).toMatch(/^Canvas query failed: Binder Error: \S/);
    }

    it.each(BAD_ARGUMENTS)('query() refuses %s as sql_execution_error', async (_label, sql) => {
      expectArgumentRejection(
        await series.query(sql).then(
          () => undefined,
          (err: unknown) => err,
        ),
      );
    });

    it.each(BAD_ARGUMENTS.map(([label, sql], i) => [label, sql, i] as const))(
      'query({ registerAs }) refuses %s as sql_execution_error and leaves no table',
      async (_label, sql, i) => {
        const tableName = `series_bad_${i}`;
        expectArgumentRejection(
          await series.query(sql, { registerAs: tableName }).then(
            () => undefined,
            (err: unknown) => err,
          ),
        );
        expect(await series.describe({ tableName })).toEqual([]);
      },
    );

    it('registers a view over a zero step and refuses the query that reads it', async () => {
      await series.registerView('series_zero_step', 'SELECT * FROM range(0, 10, 0)');
      expectArgumentRejection(
        await series.query('SELECT * FROM series_zero_step').then(
          () => undefined,
          (err: unknown) => err,
        ),
      );
    });

    // The same class covers a view an export binds after its table was staged
    // again without the column the view reads.
    it.each(['csv', 'json', 'parquet'] as const)(
      'refuses a %s export of a view whose table lost the column it reads as sql_execution_error',
      async (format) => {
        const table = `series_stale_${format}`;
        await series.registerTable(table, [{ a: 1, b: 2 }]);
        await series.registerView(`${table}_v`, `SELECT a FROM ${table}`);
        await series.registerTable(table, [{ b: 3 }]);
        const error = await series
          .export(`${table}_v`, { format, path: `${table}.${format}` })
          .then(
            () => undefined,
            (err: unknown) => err,
          );
        expect(error).toBeInstanceOf(McpError);
        expect(error).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'sql_execution_error', recovery: { hint: BINDER_EXECUTION_HINT } },
        });
        expect((error as McpError).message).toMatch(/^Canvas query failed: Binder Error: \S/);
      },
    );
  });

  // A server learns the column types of a caller's (already-gated) SQL by
  // describing it through query() over a string literal. The literal is gated
  // as its own statement, so the metadata query runs where a computed string
  // would not.
  describe('column types of a caller query through query() over a literal', () => {
    /** The metadata query a dataframe-query tool runs after the caller's SQL. */
    const columnTypesSql = (callerSql: string) =>
      `SELECT list(column_type) AS column_types FROM (DESCRIBE SELECT * FROM query('${callerSql.replaceAll("'", "''")}'))`;

    // One canvas for the block: the suite shares a 100-canvas tenant cap.
    let staged: Promise<CanvasInstance> | undefined;
    function stagedInstance() {
      staged ??= canvas.acquire(undefined, ctx).then(async (instance) => {
        await instance.registerTable('scores', [
          { id: 1, name: "o'brien", score: 0.5 },
          { id: 2, name: 'beta', score: 0.75 },
        ]);
        return instance;
      });
      return staged;
    }

    /** The same metadata query run on the control connection, past the gate. */
    async function ungatedColumnTypes(canvasId: string, callerSql: string) {
      // biome-ignore lint/complexity/useLiteralKeys: deliberate access to the private record to run the oracle query outside the gate.
      const record = provider['canvases'].get(canvasId)!;
      const reader = await record.controlConnection.runAndReadAll(columnTypesSql(callerSql));
      return reader.getRowObjectsJson();
    }

    it.each([
      [
        'a CTE with a window function, a trailing semicolon, and a line comment',
        'WITH ranked AS (SELECT id, name, score FROM scores) SELECT name, score, row_number() OVER (ORDER BY score DESC) AS rn FROM ranked; -- top scores',
        ['VARCHAR', 'DOUBLE', 'BIGINT'],
      ],
      [
        'a quote doubled into the literal',
        `SELECT name, 'it''s' AS note FROM scores WHERE name <> 'o''brien'`,
        ['VARCHAR', 'VARCHAR'],
      ],
      [
        'duplicate column names',
        'SELECT id, id, score AS id FROM scores',
        ['BIGINT', 'BIGINT', 'DOUBLE'],
      ],
      ['an empty result', 'SELECT id, name FROM scores WHERE false', ['BIGINT', 'VARCHAR']],
    ])('returns the column types of %s', async (_label, callerSql, types) => {
      const instance = await stagedInstance();
      await instance.query(callerSql);

      const result = await instance.query(columnTypesSql(callerSql));

      expect(result.rows).toEqual([{ column_types: types }]);
      expect(result.rows).toEqual(await ungatedColumnTypes(instance.canvasId, callerSql));
    });

    it('admits the metadata query as a view and through registerAs', async () => {
      const instance = await stagedInstance();
      const sql = columnTypesSql('SELECT id, name FROM scores');

      await instance.registerView('scores_types_v', sql);
      expect((await instance.query('SELECT column_types FROM scores_types_v')).rows).toEqual([
        { column_types: ['BIGINT', 'VARCHAR'] },
      ]);

      await instance.query(sql, { registerAs: 'scores_types_t' });
      expect((await instance.query('SELECT column_types FROM scores_types_t')).rows).toEqual([
        { column_types: ['BIGINT', 'VARCHAR'] },
      ]);
    });

    it('surfaces a caller mistake inside the literal as invalid_sql', async () => {
      const instance = await stagedInstance();
      await expect(
        instance.query(columnTypesSql('SELECT nosuch_col FROM scores')),
      ).rejects.toMatchObject({ data: { reason: 'invalid_sql' } });
    });

    it('surfaces a missing table inside the literal as missing_table', async () => {
      const instance = await stagedInstance();
      await expect(
        instance.query(columnTypesSql('SELECT * FROM no_such_table')),
      ).rejects.toMatchObject({ data: { reason: 'missing_table' } });
    });
  });

  // Issue #224 — denySystemCatalogs: when set, the gate rejects catalog
  // references at the text-scan layer (system_catalog_access). Without the
  // flag, catalog queries still fail at the plan walk, but with a different
  // reason — the text-scan layer is the early-exit for this guard.
  it('issue #224 — denySystemCatalogs emits system_catalog_access when set', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('t', [{ x: 1 }]);

    // With denySystemCatalogs: true — the text-scan layer fires early with the
    // structured reason before any later layer runs.
    let caught: unknown;
    try {
      await instance.query('SELECT * FROM information_schema.tables', {
        denySystemCatalogs: true,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).data?.reason).toBe('system_catalog_access');

    // Without the flag the text-scan layer stays quiet and the plan walk
    // rejects the catalog operators instead.
    await expect(instance.query('SELECT * FROM information_schema.tables')).rejects.toMatchObject({
      data: { reason: 'plan_operator_not_allowed' },
    });
  });

  it('issue #224 — denySystemCatalogs also applies to registerView', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('t', [{ x: 1 }]);
    await expect(
      instance.registerView('bad_view', 'SELECT * FROM information_schema.tables', {
        denySystemCatalogs: true,
      }),
    ).rejects.toMatchObject({ data: { reason: 'system_catalog_access' } });
  });

  // Issue #324 — `duckdb_tables().estimated_size` is a row estimate, not a byte
  // footprint, so describe() no longer reports it. Row width is the pin: two
  // tables with identical row counts and wildly different payload sizes would
  // both have reported the same "bytes".
  it('issue #324 — describe() reports no approxSizeBytes for tables or views', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, payload: 'x'.repeat(4_096) }));
    await instance.registerTable('sized_table', rows);
    await instance.registerView('sized_view', 'SELECT id FROM sized_table');

    const tables = await instance.describe();
    const tableInfo = tables.find((t) => t.name === 'sized_table');
    const viewInfo = tables.find((t) => t.name === 'sized_view');

    expect(tableInfo?.rowCount).toBe(100);
    expect(tableInfo?.approxSizeBytes).toBeUndefined();
    expect(viewInfo?.approxSizeBytes).toBeUndefined();
    expect(Object.hasOwn(tableInfo as object, 'approxSizeBytes')).toBe(false);
  });

  // Issue #140 — per-table TTL: register table with ttlMs, advance clock, verify
  // the table is dropped but the canvas survives with its other tables intact.
  it('issue #140 — per-table TTL: describe surfaces expiresAt; sweep drops expired table; canvas survives', async () => {
    // Use a short-lived registry for this test so we can control the clock.
    const TABLE_TTL = 10 * 60 * 1000; // 10 min
    const CANVAS_TTL = 24 * 60 * 60 * 1000; // 24h

    let now = 1_000_000;
    const testClock = () => now;

    const testRegistry = new CanvasRegistry(
      provider,
      {
        ttlMs: CANVAS_TTL,
        absoluteCapMs: 7 * 24 * 60 * 60 * 1000,
        maxCanvasesPerTenant: 100,
        sweeperIntervalMs: 0,
      },
      testClock,
    );
    const testCanvas = new DataCanvas(provider, testRegistry);

    try {
      const instance = await testCanvas.acquire(undefined, ctx);

      // Register two tables: one with a short per-table TTL, one without.
      await instance.registerTable('expiring', [{ id: 1 }, { id: 2 }], { ttlMs: TABLE_TTL });
      await instance.registerTable('permanent', [{ id: 3 }]);

      // Before sweep: describe surfaces expiresAt for expiring, not for permanent.
      const beforeSweep = await instance.describe();
      const expiringInfo = beforeSweep.find((t) => t.name === 'expiring');
      const permanentInfo = beforeSweep.find((t) => t.name === 'permanent');
      expect(expiringInfo?.expiresAt).toBeDefined();
      expect(permanentInfo?.expiresAt).toBeUndefined();

      // Advance clock past the per-table TTL but well within the canvas TTL.
      now = 1_000_000 + TABLE_TTL + 1;
      await testRegistry.sweep();

      // The canvas is still alive.
      const afterSweep = await instance.describe();
      expect(afterSweep.map((t) => t.name)).not.toContain('expiring');
      expect(afterSweep.map((t) => t.name)).toContain('permanent');
    } finally {
      await testRegistry.shutdown(ctx);
    }
  });

  it('healthCheck() confirms live DuckDB connectivity', async () => {
    await expect(provider.healthCheck()).resolves.toBe(true);
  });

  // A canvas never fetches or loads an extension on its own: each one adds
  // table functions and plan operators the gate was not written against.
  it('creates every canvas with extension autoinstall and autoload switched off', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    // biome-ignore lint/complexity/useLiteralKeys: deliberate access to the private record to read engine settings outside the gate.
    const record = provider['canvases'].get(instance.canvasId)!;
    const reader = await record.controlConnection.runAndReadAll(
      `SELECT name, value FROM duckdb_settings()
       WHERE name IN ('autoinstall_known_extensions', 'autoload_known_extensions')
       ORDER BY name`,
    );
    expect(reader.getRowObjectsJson()).toEqual([
      { name: 'autoinstall_known_extensions', value: 'false' },
      { name: 'autoload_known_extensions', value: 'false' },
    ]);
  });

  // #659 — a failed registration leaves the canvas as it was: the previous
  // table whole on a replacement, no table on a first registration.
  describe('a registration that fails part way (#659)', () => {
    const idSchema = [{ name: 'id', type: 'INTEGER' as const }];
    const tsSchema = [{ name: 'd', type: 'TIMESTAMP' as const }];
    // One canvas for the group: the file runs near the per-tenant canvas cap.
    let instance: CanvasInstance;

    beforeAll(async () => {
      instance = await canvas.acquire(undefined, ctx);
    });

    async function rowsOf(on: CanvasInstance, table: string) {
      return (await on.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
    }

    // Integers registered without a schema are sniffed as BIGINT, which reads back as strings.
    it('keeps the previous table and its row count when the source throws', async () => {
      await instance.registerTable('rows', [{ id: 1 }, { id: 2 }, { id: 3 }]);
      function* failing() {
        yield { id: 10 };
        yield { id: 11 };
        throw new Error('upstream');
      }

      await expect(instance.registerTable('rows', failing(), { schema: idSchema })).rejects.toThrow(
        'upstream',
      );

      expect(await rowsOf(instance, 'rows')).toEqual([{ id: '1' }, { id: '2' }, { id: '3' }]);
      expect((await instance.describe({ tableName: 'rows' }))[0]?.rowCount).toBe(3);
    });

    it('keeps the previous table when a value fails conversion', async () => {
      await instance.registerTable('ts', [{ d: '2024-01-01T00:00:00Z' }], { schema: tsSchema });

      await expect(
        instance.registerTable(
          'ts',
          [{ d: '2024-01-02T00:00:00Z' }, { d: '2024-01-03T00:00:00Z' }, { d: 'garbage' }],
          { schema: tsSchema },
        ),
      ).rejects.toThrow(/TIMESTAMP/);

      expect(await rowsOf(instance, 'ts')).toEqual([{ d: '2024-01-01 00:00:00' }]);
    });

    it('keeps the previous table when the call is cancelled mid-stream', async () => {
      await instance.registerTable('cancelled', [{ id: 1 }]);
      const ctrl = new AbortController();
      async function* source() {
        yield { id: 10 };
        ctrl.abort();
        yield { id: 11 };
      }

      await expect(
        instance.registerTable('cancelled', source(), { schema: idSchema, signal: ctrl.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });

      expect(await rowsOf(instance, 'cancelled')).toEqual([{ id: '1' }]);
    });

    // The appender writes its rows to the table as a chunk fills and as it
    // closes; the engine's message, from a row it could not allocate.
    it.each(['endRow', 'closeSync'] as const)(
      'keeps the previous table when the appender runs out of memory in %s, a DatabaseError cut before the SET advice',
      async (method) => {
        await instance.registerTable('appended', [{ id: 1 }], { schema: idSchema });
        const first =
          'Failed to append: could not allocate block of size 256.0 KiB (60.8 MiB/61.0 MiB used)';
        const engineError = new Error(
          `${first}\n\nPossible solutions:\n* Reducing the number of threads (SET threads=X)\n* Disabling insertion-order preservation (SET preserve_insertion_order=false)\n* Increasing the memory limit (SET memory_limit='...GB')`,
        );
        const original = DuckDBAppender.prototype[method];
        const spy = vi.spyOn(DuckDBAppender.prototype, method).mockImplementationOnce(function (
          this: DuckDBAppender,
        ) {
          original.call(this);
          throw engineError;
        });
        try {
          const error = await rejectionOf(
            instance.registerTable('appended', [{ id: 2 }], { schema: idSchema }),
          );
          expect(error.code).toBe(JsonRpcErrorCode.DatabaseError);
          expect(error.data).toBeUndefined();
          expect(error.message).toBe(first);
          expect(error.cause).toBe(engineError);
        } finally {
          spy.mockRestore();
        }
        expect(await rowsOf(instance, 'appended')).toEqual([{ id: 1 }]);
      },
    );

    it('leaves no table when a first registration fails', async () => {
      function* failing() {
        yield { id: 10 };
        throw new Error('upstream');
      }

      await expect(
        instance.registerTable('never_staged', failing(), { schema: idSchema }),
      ).rejects.toThrow('upstream');

      expect(await instance.describe({ tableName: 'never_staged' })).toEqual([]);
    });

    it('serves the previous table to readers until a replacement commits, then the new one', async () => {
      await instance.registerTable('swapped', [{ id: 1 }, { id: 2 }]);
      const { promise: released, resolve: release } = Promise.withResolvers<void>();
      const { promise: halfway, resolve: reachHalfway } = Promise.withResolvers<void>();
      async function* slow() {
        yield { id: 10 };
        reachHalfway();
        await released;
        yield { id: 11 };
      }

      const replacing = instance.registerTable('swapped', slow(), { schema: idSchema });
      await halfway;
      expect(await rowsOf(instance, 'swapped')).toEqual([{ id: '1' }, { id: '2' }]);
      release();

      await expect(replacing).resolves.toMatchObject({ rowCount: 2 });
      expect(await rowsOf(instance, 'swapped')).toEqual([{ id: 10 }, { id: 11 }]);
    });

    it('closes a sync source it stops reading on a conversion failure (#661)', async () => {
      let closed = 0;
      // The sniffer types `n` BIGINT from its first rows; the bad value sits past
      // its window, so the failure lands in the sniffer's continuation.
      function* source() {
        try {
          for (let i = 0; i < 200; i++) yield { n: i === 150 ? 'garbage' : i };
        } finally {
          closed++;
        }
      }

      await expect(instance.registerTable('sync_n', source())).rejects.toThrow();
      expect(closed).toBe(1);
      expect(await instance.describe({ tableName: 'sync_n' })).toEqual([]);
    });

    it('keeps the destination table when an import fails part way', async () => {
      await instance.registerTable('raw', [{ v: '1' }, { v: 'x' }]);
      // The cast fails while the copy runs, not when the view is defined.
      await instance.registerView('bad', 'SELECT v::INTEGER AS v FROM raw');
      const target = await canvas.acquire(undefined, ctx);
      await target.registerTable('dest', [{ v: 7 }]);

      await expect(
        target.importFrom(instance.canvasId, 'bad', { asName: 'dest' }),
      ).rejects.toThrow();

      expect(await rowsOf(target, 'dest')).toEqual([{ v: '7' }]);
    });
  });

  // A query or registerAs runs on every engine thread, and each thread holds
  // working memory of its own inside memory_limit (an export runs on one); a
  // 256 MB canvas runs at most 4.
  it('caps engine threads at one per 64 MB of memory_limit, below the count DuckDB detects', async () => {
    const plain = await DuckDBInstance.create(':memory:');
    const connection = await plain.connect();
    const detected = (
      await connection.runAndReadAll("SELECT current_setting('threads')::INTEGER AS n")
    ).getRowObjectsJson()[0]!.n as number;
    connection.closeSync();
    plain.closeSync();

    const instance = await canvas.acquire(undefined, ctx);
    // biome-ignore lint/complexity/useLiteralKeys: deliberate access to the private record to read engine settings outside the gate.
    const record = provider['canvases'].get(instance.canvasId)!;
    const reader = await record.controlConnection.runAndReadAll(
      "SELECT current_setting('threads')::INTEGER AS n",
    );
    expect(reader.getRowObjectsJson()).toEqual([{ n: Math.min(detected, 4) }]);
  });

  // The engine reads and writes only under the export root and the canvas's
  // scratch directory, and nothing reachable from SQL can widen that.
  describe('engine file access', () => {
    /** Ungated engine settings of a fresh canvas, read on its control connection. */
    async function settingsOf(canvasId: string) {
      // biome-ignore lint/complexity/useLiteralKeys: deliberate access to the private record to read engine settings outside the gate.
      const record = provider['canvases'].get(canvasId)!;
      const reader = await record.controlConnection.runAndReadAll(
        `SELECT current_setting('enable_external_access') AS external_access,
                current_setting('lock_configuration') AS locked,
                current_setting('allowed_directories') AS allowed`,
      );
      return { record, settings: reader.getRowObjectsJson()[0]! };
    }

    it('creates every canvas with external access off, its directories allow-listed, and configuration locked', async () => {
      const instance = await canvas.acquire(undefined, ctx);
      const { record, settings } = await settingsOf(instance.canvasId);

      expect(settings.external_access).toBe(false);
      expect(settings.locked).toBe(true);
      // DuckDB stores each entry canonicalized: symlinks resolved, trailing separator added.
      const exportDir = `${await realpath(exportRoot)}${sep}`;
      const scratchDir = `${await realpath(record.scratchDir)}${sep}`;
      const allowed = settings.allowed as string[];
      expect(allowed).toContain(exportDir);
      expect(allowed).toContain(scratchDir);
      // The only other entry is DuckDB's own: the canvas's spill directory, inside the scratch directory.
      expect(allowed.filter((dir) => dir !== exportDir && dir !== scratchDir)).toEqual([
        `${scratchDir}${basename(record.spillDir)}${sep}`,
      ]);
    });

    it.each([
      ['re-enabling external access', 'SET enable_external_access = true'],
      ['widening the allow-list', `SET allowed_directories = ['/']`],
      ['raising the memory limit', `SET memory_limit = '4GB'`],
      ['moving the spill directory', `SET temp_directory = '/'`],
      ['resetting the lock', 'RESET lock_configuration'],
    ])('refuses %s, even on a connection the gate never sees', async (_label, statement) => {
      const instance = await canvas.acquire(undefined, ctx);
      // biome-ignore lint/complexity/useLiteralKeys: deliberate access to the private record to run a statement outside the gate.
      const record = provider['canvases'].get(instance.canvasId)!;
      const connection = await record.instance.connect();
      try {
        // DuckDB v2.0 doubles the quotes around the option name.
        await expect(connection.run(statement)).rejects.toThrow(
          /^Invalid Input Error: Cannot change configuration option "{1,2}\w+"{1,2} - the configuration has been locked/,
        );
      } finally {
        connection.closeSync();
      }
      const { settings } = await settingsOf(instance.canvasId);
      expect(settings).toMatchObject({ external_access: false, locked: true });
    });
  });

  // dataTypeToColumnType round-trip — every ColumnType tag maps to and from
  // its DuckDB information_schema.columns.data_type string correctly. This is
  // the describe()/describeOne() column-typing path, otherwise untested.
  it('describe() round-trips every ColumnType through DuckDB information_schema types', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable(
      'typed_columns',
      [
        {
          a: 'x',
          b: 1,
          c: 2n,
          d: 1.5,
          e: true,
          f: new Date('2026-01-01T00:00:00.000Z'),
          g: '2026-01-01',
          h: { k: 'v' },
          i: new Uint8Array([1, 2]),
        },
      ],
      {
        schema: [
          { name: 'a', type: 'VARCHAR' },
          { name: 'b', type: 'INTEGER' },
          { name: 'c', type: 'BIGINT' },
          { name: 'd', type: 'DOUBLE' },
          { name: 'e', type: 'BOOLEAN' },
          { name: 'f', type: 'TIMESTAMP' },
          { name: 'g', type: 'DATE' },
          { name: 'h', type: 'JSON' },
          { name: 'i', type: 'BLOB' },
        ],
      },
    );

    const [info] = await instance.describe({ tableName: 'typed_columns' });
    const byName = new Map(info!.columns.map((c) => [c.name, c.type]));
    expect(byName.get('a')).toBe('VARCHAR');
    expect(byName.get('b')).toBe('INTEGER');
    expect(byName.get('c')).toBe('BIGINT');
    expect(byName.get('d')).toBe('DOUBLE');
    expect(byName.get('e')).toBe('BOOLEAN');
    expect(byName.get('f')).toBe('TIMESTAMP');
    expect(byName.get('g')).toBe('DATE');
    expect(byName.get('h')).toBe('JSON');
    expect(byName.get('i')).toBe('BLOB');
  });

  it('describe() reports nullable:false for a NOT NULL column, true otherwise', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('nn_table', [{ id: 1, label: 'a' }], {
      schema: [
        { name: 'id', type: 'INTEGER', nullable: false },
        { name: 'label', type: 'VARCHAR' },
      ],
    });
    const [info] = await instance.describe({ tableName: 'nn_table' });
    const idCol = info!.columns.find((c) => c.name === 'id');
    const labelCol = info!.columns.find((c) => c.name === 'label');
    expect(idCol?.nullable).toBe(false);
    expect(labelCol?.nullable).toBe(true);
  });

  // #500 — describe() reports each column's type exactly as the engine spells
  // it, as engineType. The coarse tag gives a numeric type the tag that holds
  // every one of its values; one no tag holds stays VARCHAR.
  describe('describe() column types (#500)', () => {
    /** Column name, the SQL producing it, coarse tag, engine type, and the JSON value query() returns. */
    const COLUMNS: readonly (readonly [string, string, string, string, unknown])[] = [
      ['ti', '1::TINYINT', 'INTEGER', 'TINYINT', 1],
      ['si', '2::SMALLINT', 'INTEGER', 'SMALLINT', 2],
      ['uti', '3::UTINYINT', 'INTEGER', 'UTINYINT', 3],
      ['usi', '4::USMALLINT', 'INTEGER', 'USMALLINT', 4],
      ['ui', '5::UINTEGER', 'BIGINT', 'UINTEGER', 5],
      ['ub', '6::UBIGINT', 'VARCHAR', 'UBIGINT', '6'],
      ['hi', '7::HUGEINT', 'VARCHAR', 'HUGEINT', '7'],
      ['uhi', '8::UHUGEINT', 'VARCHAR', 'UHUGEINT', '8'],
      ['dec', '12.345::DECIMAL(18,3)', 'VARCHAR', 'DECIMAL(18,3)', '12.345'],
      ['lit', '1.5', 'VARCHAR', 'DECIMAL(2,1)', '1.5'],
      ['bn', '123::VARINT', 'VARCHAR', 'BIGNUM', '123'],
      ['tm', "TIME '03:04:05'", 'VARCHAR', 'TIME', '03:04:05'],
      ['ttz', "TIMETZ '03:04:05+00'", 'VARCHAR', 'TIME WITH TIME ZONE', '03:04:05+00'],
      ['tns', "TIME_NS '03:04:05.123456789'", 'VARCHAR', 'TIME_NS', '03:04:05.123456789'],
      [
        'tstz',
        "TIMESTAMPTZ '2024-01-02 03:04:05+00'",
        'TIMESTAMP',
        'TIMESTAMP WITH TIME ZONE',
        // Rendered in the process's own time zone.
        expect.stringMatching(/^2024-01-0[12] \d\d:\d\d:05[+-]\d\d/),
      ],
      ['iv', 'INTERVAL 1 DAY', 'VARCHAR', 'INTERVAL', { months: 0, days: 1, micros: '0' }],
      [
        'u',
        "'00000000-0000-0000-0000-000000000001'::UUID",
        'VARCHAR',
        'UUID',
        '00000000-0000-0000-0000-000000000001',
      ],
      ['bt', "'101'::BIT", 'VARCHAR', 'BIT', '101'],
      ['en', "'a'::ENUM('a', 'b')", 'VARCHAR', "ENUM('a', 'b')", 'a'],
      [
        'g',
        "'POINT(1 2)'::GEOMETRY",
        'VARCHAR',
        'GEOMETRY',
        '\\x01\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\xF0?\\x00\\x00\\x00\\x00\\x00\\x00\\x00@',
      ],
      ['li', '[1, 2]::INTEGER[]', 'VARCHAR', 'INTEGER[]', [1, 2]],
      ['ar', '[1, 2, 3]::INTEGER[3]', 'VARCHAR', 'INTEGER[3]', [1, 2, 3]],
      // A list or array of timestamps is a list: it takes the tag every other list does.
      [
        'tsl',
        "[TIMESTAMP '2024-01-02 03:04:05']",
        'VARCHAR',
        'TIMESTAMP[]',
        ['2024-01-02 03:04:05'],
      ],
      [
        'tsa',
        "[TIMESTAMP '2024-01-02 03:04:05']::TIMESTAMP[1]",
        'VARCHAR',
        'TIMESTAMP[1]',
        ['2024-01-02 03:04:05'],
      ],
      [
        'tsn',
        "TIMESTAMP_NS '2024-01-02 03:04:05.123456789'",
        'TIMESTAMP',
        'TIMESTAMP_NS',
        '2024-01-02 03:04:05.123456789',
      ],
      [
        'st',
        "{'a': 1, 'b': 'x'}::STRUCT(a INTEGER, b VARCHAR)",
        'VARCHAR',
        'STRUCT(a INTEGER, b VARCHAR)',
        { a: 1, b: 'x' },
      ],
      ['mp', "MAP {'k': 1}", 'VARCHAR', 'MAP(VARCHAR, INTEGER)', [{ key: 'k', value: 1 }]],
      [
        'un',
        'union_value(i := 1)::UNION(i INTEGER, s VARCHAR)',
        'VARCHAR',
        'UNION(i INTEGER, s VARCHAR)',
        { tag: 'i', value: 1 },
      ],
    ];
    let typed: CanvasInstance;

    beforeAll(async () => {
      typed = await canvas.acquire(undefined, ctx);
      await typed.query(`SELECT ${COLUMNS.map(([name, sql]) => `${sql} AS ${name}`).join(', ')}`, {
        registerAs: 'all_types',
      });
    });

    it('returns the same query() row value for every column type', async () => {
      const { rows } = await typed.query('SELECT * FROM all_types');
      expect(rows).toEqual([
        Object.fromEntries(COLUMNS.map(([name, , , , value]) => [name, value])),
      ]);
    });

    it('reports each column with its engine type verbatim and the tag that holds its values', async () => {
      const [info] = await typed.describe({ tableName: 'all_types' });
      expect(info?.columns).toEqual(
        COLUMNS.map(([name, , type, engineType]) => ({ name, type, engineType, nullable: true })),
      );

      // biome-ignore lint/complexity/useLiteralKeys: deliberate access to the private record to read the engine's catalog past the gate.
      const record = provider['canvases'].get(typed.canvasId)!;
      const catalog = await record.controlConnection.runAndReadAll(
        "SELECT data_type FROM information_schema.columns WHERE table_name = 'all_types' ORDER BY ordinal_position",
      );
      expect(info?.columns.map((c) => c.engineType)).toEqual(
        catalog.getRowObjectsJson().map((row) => row.data_type),
      );
    });

    it('describes the columns ordinary SQL produces with their engine types', async () => {
      await typed.registerTable('t500', [
        { year: 2024, v: 1 },
        { year: 2025, v: 2 },
      ]);
      await typed.query(
        `SELECT SUM(CAST(year AS INTEGER)) AS s, CAST(v AS DECIMAL(10,2)) AS d,
                CAST(1 AS SMALLINT) AS sm, 1.5 AS lit, LIST(v) AS l FROM t500 GROUP BY v`,
        { registerAs: 'r500' },
      );
      const [info] = await typed.describe({ tableName: 'r500' });
      expect(info?.columns.map((c) => [c.name, c.type, c.engineType])).toEqual([
        ['s', 'VARCHAR', 'HUGEINT'],
        ['d', 'VARCHAR', 'DECIMAL(10,2)'],
        ['sm', 'INTEGER', 'SMALLINT'],
        ['lit', 'VARCHAR', 'DECIMAL(2,1)'],
        ['l', 'VARCHAR', 'BIGINT[]'],
      ]);
    });

    it('describes a column registered with each tag as that tag, spelled the same by the engine', async () => {
      const tags = [
        'VARCHAR',
        'INTEGER',
        'BIGINT',
        'DOUBLE',
        'BOOLEAN',
        'TIMESTAMP',
        'DATE',
        'JSON',
        'BLOB',
      ] as const;
      await typed.registerTable('tagged', [], {
        schema: tags.map((type, i) => ({ name: `c${i}`, type })),
      });
      const [info] = await typed.describe({ tableName: 'tagged' });
      expect(info?.columns.map((c) => [c.type, c.engineType])).toEqual(
        tags.map((type) => [type, type]),
      );
    });
  });

  // importFrom's sourceKind resolution — COPY works directly against a VIEW
  // name, not just a base table. Every existing importFrom test copies a
  // table; this exercises the view branch of lookupKind().
  it('importFrom copies from a registered VIEW, not just a base table', async () => {
    const source = await canvas.acquire(undefined, ctx);
    const target = await canvas.acquire(undefined, ctx);
    await source.registerTable('view_source_base', [{ id: 1 }, { id: 2 }, { id: 3 }]);
    await source.registerView('view_source', 'SELECT id FROM view_source_base WHERE id > 1');

    const imported = await target.importFrom(source.canvasId, 'view_source', {
      asName: 'view_copy',
    });
    expect(imported.tableName).toBe('view_copy');
    expect(imported.rowCount).toBe(2);

    const result = await target.query('SELECT id FROM view_copy ORDER BY id');
    expect(result.rows).toEqual([{ id: '2' }, { id: '3' }]);
  });

  // targetExisting === 'view' clash — distinct from the table-vs-table
  // idempotent-overwrite path already covered above.
  it('importFrom rejects when the destination name collides with an existing view', async () => {
    const source = await canvas.acquire(undefined, ctx);
    const target = await canvas.acquire(undefined, ctx);
    await source.registerTable('import_src', [{ id: 1 }]);
    await target.registerTable('base_for_view', [{ id: 1 }]);
    await target.registerView('taken_name', 'SELECT id FROM base_for_view');

    let caught: unknown;
    try {
      await target.importFrom(source.canvasId, 'import_src', { asName: 'taken_name' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    const mcpErr = caught as McpError;
    expect(mcpErr.message).toMatch(/already contains a view/i);
    expect((mcpErr.data as { reason?: string })?.reason).toBe('import_view_clash');
  });

  // A CTE-prefixed query with a bad column must classify as invalid_sql (not
  // non_select_statement), same as the plain-`select` case already covered by
  // issue #236 above.
  it('issue #236 — a malformed column inside a WITH/CTE query also yields invalid_sql', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('cte_source', [{ id: 1 }]);
    let caught: unknown;
    try {
      await instance.query(
        'WITH cte AS (SELECT id FROM cte_source) SELECT nonexistent_col FROM cte',
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    const mcpErr = caught as McpError;
    expect(mcpErr.code).toBe(-32007);
    const data = mcpErr.data as { reason?: string; binderMessage?: string };
    expect(data.reason).toBe('invalid_sql');
    expect(data.binderMessage).toContain('nonexistent_col');
  });

  // preview narrows the returned rows independently of rowLimit-driven
  // truncation — `truncated` is reserved for hitting the rowLimit cap, not
  // for a caller-requested smaller preview slice.
  it('preview narrows returned rows without setting truncated (distinct from rowLimit truncation)', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    const rows = Array.from({ length: 10 }, (_, i) => ({ x: i }));
    await instance.registerTable('preview_table', rows);

    const result = await instance.query('SELECT x FROM preview_table ORDER BY x', { preview: 3 });
    expect(result.rows.length).toBe(3);
    expect(result.rowCount).toBe(10);
    expect(result.truncated).toBeUndefined();
  });

  it.each([
    ['zero rowLimit', { rowLimit: 0 }],
    ['negative rowLimit', { rowLimit: -1 }],
    ['fractional rowLimit', { rowLimit: 1.5 }],
    ['non-finite rowLimit', { rowLimit: Number.POSITIVE_INFINITY }],
    ['rowLimit above provider cap', { rowLimit: 1_001 }],
    ['negative preview', { preview: -1 }],
    ['fractional preview', { preview: 1.5 }],
    ['preview above rowLimit', { preview: 3, rowLimit: 2 }],
  ])('rejects invalid query bounds: %s', async (_label, options) => {
    const instance = await canvas.acquire(undefined, ctx);
    await expect(instance.query('SELECT 1 AS x', options)).rejects.toMatchObject({
      data: { reason: 'invalid_query_bounds' },
    });
  });

  // Issue #451 — a SELECT that passes the gate and then fails on the staged
  // data is the caller's SQL to fix, not a server fault. The engine message is
  // preserved so the agent can see which value and column broke.
  it('issue #451 — an execution-time conversion failure is a caller-side ValidationError', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('df_convert', [{ amount: '12' }, { amount: 'n/a' }]);

    let caught: unknown;
    try {
      await instance.query('SELECT CAST(amount AS INTEGER) AS n FROM df_convert');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    const mcpErr = caught as McpError;
    // ValidationError (-32007), not DatabaseError (-32010).
    expect(mcpErr.code).toBe(-32007);
    const data = mcpErr.data as { reason?: string; recovery?: { hint?: string } };
    expect(data.reason).toBe('sql_execution_error');
    expect(data.recovery?.hint).toMatch(/TRY_CAST/);
    expect(mcpErr.message).toMatch(/Conversion Error/);
  });

  // Issue #451, negative arm — classifyDuckdbError is also reached from
  // export/registerView/importFrom. An I/O fault on the export path must stay a
  // DatabaseError rather than being reported to the caller as bad SQL.
  it('issue #451 — an export-path I/O failure stays a DatabaseError', async () => {
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable('df_export_io', [{ x: 1 }]);

    let caught: unknown;
    try {
      // Inside the sandbox, but the intermediate directory does not exist —
      // DuckDB's COPY raises an IO Error the provider must not reclassify.
      await instance.export('df_export_io', { format: 'csv', path: 'no_such_dir/out.csv' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    const mcpErr = caught as McpError;
    expect(mcpErr.code).toBe(-32010);
    expect((mcpErr.data as { reason?: string } | undefined)?.reason).toBeUndefined();
  });
});

/**
 * With insertion order preserved, DuckDB plans a CSV or JSON `COPY` of a table
 * as a batch copy whose writer holds each batch's whole text in one buffer per
 * thread; v2.0 allocates those inside `memory_limit` and fails with Out of
 * Memory once rows are wide. The export's single-writer statement flushes as it
 * writes. A 128 MB canvas runs two engine threads; at one thread DuckDB plans
 * the single-writer copy on its own, so on a single-core host these cases pass
 * with either statement. A Parquet `COPY` buffers a whole row group, 122,880
 * rows by default, and asks for one 128 MiB block for a column of 1 KB strings:
 * Parquet exports and `importFrom` write from the same single-writer statement
 * with each row group capped, whatever the engine thread count.
 */
describe('canvas · export of wide rows', () => {
  /**
   * About 82 MB of text for each format, past the 64 MiB a batch buffer can
   * hold before it asks for 128 MiB. A JSON copy also holds a working set that
   * grows with row width, not row count, so JSON carries the same text in rows
   * half as wide, which keeps the case within the 128 MB canvas.
   */
  const FIXTURES = {
    csv: { table: 'wide_csv', rows: 20_000, width: 4096 },
    json: { table: 'wide_json', rows: 40_000, width: 2048 },
  } as const;
  /** About 150 MB of 1 KB rows, staged on a canvas of their own. */
  const PARQUET_ROWS = 150_000;
  let wideProvider: DuckdbProvider;
  let wideExportRoot: string;
  let wideCanvas: DataCanvas;
  let wide: CanvasInstance;
  let wideParquet: CanvasInstance;

  /** `rows` rows of `i` and a 1 KB string, staged as `table` on `instance`. */
  async function stageKbRows(instance: CanvasInstance, table: string, rows: number): Promise<void> {
    await instance.query(
      `SELECT i, rpad('AAA-' || i || '-', 1024, 'x') AS pad FROM range(${rows}) r(i)`,
      { registerAs: table, preview: 0 },
    );
  }

  beforeAll(async () => {
    wideExportRoot = await mkdtemp(join(tmpdir(), 'canvas-smoke-wide-'));
    wideProvider = new DuckdbProvider({
      memoryLimitMb: 128,
      exportRootPath: wideExportRoot,
      defaultRowLimit: 100,
      schemaSniffRows: 10,
    });
    wideCanvas = new DataCanvas(
      wideProvider,
      new CanvasRegistry(wideProvider, {
        ttlMs: 60_000,
        absoluteCapMs: 600_000,
        maxCanvasesPerTenant: 10,
        sweeperIntervalMs: 0,
      }),
    );
    wide = await wideCanvas.acquire(undefined, ctx);
    for (const { table, rows, width } of Object.values(FIXTURES)) {
      await wide.query(
        `SELECT i, rpad('AAA-' || i || '-', ${width}, 'x') AS pad FROM range(${rows}) r(i)`,
        { registerAs: table },
      );
    }
    wideParquet = await wideCanvas.acquire(undefined, ctx);
    await stageKbRows(wideParquet, 'kb_rows', PARQUET_ROWS);
  }, 120_000);

  afterAll(async () => {
    await wideProvider?.shutdown();
    await rm(wideExportRoot, { recursive: true, force: true });
  });

  it.each(['csv', 'json'] as const)(
    'exports 82 MB of wide rows as %s to a path, in order',
    async (format) => {
      const { table, rows } = FIXTURES[format];
      const result = await wide.export(table, { format, path: `${table}.${format}` });
      expect(result.rowCount).toBe(rows);
      const ids = await exportedIds(join(wideExportRoot, `${table}.${format}`), format);
      expect(ids).toHaveLength(rows);
      expect(ids.findIndex((id, line) => id !== line)).toBe(-1);
    },
  );

  it.each(['csv', 'json'] as const)(
    'exports 82 MB of wide rows as %s to a stream',
    async (format) => {
      const { table, rows, width } = FIXTURES[format];
      let bytes = 0;
      let lines = 0;
      const stream = new WritableStream<Uint8Array>({
        write(chunk) {
          bytes += chunk.byteLength;
          for (const byte of chunk) if (byte === 0x0a) lines += 1;
        },
      });
      const result = await wide.export(table, { format, stream });
      expect(result).toMatchObject({ rowCount: rows, sizeBytes: bytes });
      expect(bytes).toBeGreaterThan(rows * width);
      expect(lines).toBe(format === 'csv' ? rows + 1 : rows);
    },
  );

  it('exports 150 MB of 1 KB rows as Parquet to a path, in order', async () => {
    const result = await wideParquet.export('kb_rows', { format: 'parquet', path: 'kb.parquet' });
    expect(result.rowCount).toBe(PARQUET_ROWS);
    const ids = await exportedIds(join(wideExportRoot, 'kb.parquet'), 'parquet');
    expect(ids).toHaveLength(PARQUET_ROWS);
    expect(ids.findIndex((id, line) => id !== line)).toBe(-1);
  }, 120_000);

  it('exports 150 MB of 1 KB rows as Parquet to a stream', async () => {
    let bytes = 0;
    const head: number[] = [];
    const stream = new WritableStream<Uint8Array>({
      write(chunk) {
        bytes += chunk.byteLength;
        if (head.length < 4) head.push(...chunk.subarray(0, 4 - head.length));
      },
    });
    const result = await wideParquet.export('kb_rows', { format: 'parquet', stream });
    expect(result).toMatchObject({ rowCount: PARQUET_ROWS, sizeBytes: bytes });
    expect(Buffer.from(head).toString('latin1')).toBe('PAR1');
  }, 120_000);

  it('copies 150 MB of 1 KB rows to a second 128 MB canvas with importFrom', async () => {
    const target = await wideCanvas.acquire(undefined, ctx);
    const imported = await target.importFrom(wideParquet.canvasId, 'kb_rows');
    expect(imported).toMatchObject({ tableName: 'kb_rows', rowCount: PARQUET_ROWS });
    const summary = await target.query(
      'SELECT count(*) AS n, min(i) AS lo, max(i) AS hi, max(length(pad)) AS width FROM kb_rows',
    );
    expect(summary.rows).toEqual([
      { n: String(PARQUET_ROWS), lo: '0', hi: String(PARQUET_ROWS - 1), width: '1024' },
    ]);
    await wideCanvas.drop(target.canvasId, ctx);
  }, 120_000);

  // A row-group cap on a plain COPY is not enough: at two threads the batch copy
  // holds encoded row groups until earlier ones flush, so this table fails.
  it('exports 1,000,000 rows of 1 KB as Parquet, in order', async () => {
    const million = await wideCanvas.acquire(undefined, ctx);
    try {
      await stageKbRows(million, 'kb_million', 1_000_000);
      const result = await million.export('kb_million', {
        format: 'parquet',
        path: 'kb_million.parquet',
      });
      expect(result.rowCount).toBe(1_000_000);
      const ids = await exportedIds(join(wideExportRoot, 'kb_million.parquet'), 'parquet');
      expect(ids).toHaveLength(1_000_000);
      expect(ids.findIndex((id, line) => id !== line)).toBe(-1);
    } finally {
      await wideCanvas.drop(million.canvasId, ctx);
    }
  }, 300_000);
});

/**
 * An export that runs out of memory fails with a typed reason and a hint for its
 * format. A JSON export holds about 13 copies of a 2,048-row slice as JSON text
 * (about 10 on DuckDB 1.5) and a CSV export about 3, so at the 64 MB minimum 4 KB
 * rows fail as JSON while they export as CSV, and 16 KB rows fail as CSV.
 */
describe('canvas · export out of memory (#826)', () => {
  const JSON_HINT =
    'A JSON export needs roughly 26 MB of canvas memory per KB of row width, since it holds about 13 copies of 2,048 rows as JSON text at once. Export as CSV or Parquet, which need far less, or export a selection that leaves out the widest columns.';
  const ROWS_HINT =
    'The export holds 2,048 rows in memory at a time, and rows this wide do not fit in the canvas memory limit. Export a selection that leaves out the widest columns, or ask the operator to raise CANVAS_DEFAULT_MEMORY_LIMIT_MB.';
  let oomProvider: DuckdbProvider;
  let oomExportRoot: string;
  let oomCanvas: DataCanvas;
  /** 2,000 rows of 4 KB. */
  let narrow: CanvasInstance;
  /** 6,144 rows of 16 KB. */
  let wide: CanvasInstance;

  beforeAll(async () => {
    oomExportRoot = await mkdtemp(join(tmpdir(), 'canvas-smoke-oom-'));
    oomProvider = new DuckdbProvider({
      memoryLimitMb: 64,
      exportRootPath: oomExportRoot,
      defaultRowLimit: 100,
      schemaSniffRows: 10,
    });
    oomCanvas = new DataCanvas(
      oomProvider,
      new CanvasRegistry(oomProvider, {
        ttlMs: 60_000,
        absoluteCapMs: 600_000,
        maxCanvasesPerTenant: 10,
        sweeperIntervalMs: 0,
      }),
    );
    narrow = await oomCanvas.acquire(undefined, ctx);
    await narrow.registerTable(
      't',
      Array.from({ length: 2000 }, (_, i) => ({ i, pad: 'x'.repeat(4096) })),
    );
    wide = await oomCanvas.acquire(undefined, ctx);
    await wide.query(`SELECT i, repeat('x', 16384) AS pad FROM range(6144) r(i)`, {
      registerAs: 't',
      preview: 0,
    });
  }, 120_000);

  afterAll(async () => {
    await oomProvider?.shutdown();
    await rm(oomExportRoot, { recursive: true, force: true });
  });

  /** An export's out-of-memory rejection, its message one line with none of DuckDB's SET advice. */
  function expectOutOfMemory(error: McpError, format: ExportFormat, hint: string): void {
    expect(error.code).toBe(JsonRpcErrorCode.DatabaseError);
    expect(error.data).toEqual({ reason: 'export_out_of_memory', format, recovery: { hint } });
    expect(error.message).toMatch(/^Out of Memory Error: [^\n]+$/);
    expect(error.message).not.toMatch(/Possible solutions|SET /);
  }

  it('exports 2,000 rows of 4 KB as CSV and refuses them as JSON, naming CSV and Parquet', async () => {
    const csv = await narrow.export('t', { format: 'csv', path: 'narrow.csv' });
    expect(csv.rowCount).toBe(2000);
    const error = await rejectionOf(narrow.export('t', { format: 'json', path: 'narrow.json' }));
    expectOutOfMemory(error, 'json', JSON_HINT);
  }, 60_000);

  it('refuses 6,144 rows of 16 KB as CSV with the row-width hint', async () => {
    const error = await rejectionOf(wide.export('t', { format: 'csv', path: 'wide.csv' }));
    expectOutOfMemory(error, 'csv', ROWS_HINT);
  }, 60_000);

  it('refuses the same rows as JSON to a stream', async () => {
    const error = await rejectionOf(
      narrow.export('t', { format: 'json', stream: new WritableStream<Uint8Array>() }),
    );
    expectOutOfMemory(error, 'json', JSON_HINT);
  }, 60_000);

  // query() and registerAs are not exports: no reason, only DuckDB's SET advice cut.
  it.each([
    ['query()', {}],
    ['registerAs', { registerAs: 'listed', preview: 0 }],
  ])(
    'keeps %s out of memory a DatabaseError with no reason',
    async (_label, options) => {
      const error = await rejectionOf(wide.query('SELECT list(pad) AS l FROM t', options));
      expect(error.code).toBe(JsonRpcErrorCode.DatabaseError);
      expect(error.data?.reason).toBeUndefined();
      expect(error.message).toMatch(/^Out of Memory Error: [^\n]+$/);
    },
    60_000,
  );

  it('gives a registration that runs out of memory no reason', async () => {
    const error = await narrow.registerTable('huge', [{ s: 'x'.repeat(72_000_000) }]).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/could not allocate/);
    expect((error as { data?: { reason?: string } }).data?.reason).toBeUndefined();
  }, 60_000);
});

/**
 * A path export writes `.<name>.<UUID>.partial` beside its target and renames it
 * over the target once its transaction commits: a call that rejects leaves the
 * target as it found it, and one that resolves publishes the whole file. The
 * cancelled cases sit in `canvas · cancellation before execution`, which can
 * abort between the engine's statements.
 */
describe('canvas · path export publication (#740)', () => {
  const ROWS = 5000;
  let publishProvider: DuckdbProvider;
  let publishRoot: string;
  let publishing: CanvasInstance;

  beforeAll(async () => {
    publishRoot = await mkdtemp(join(tmpdir(), 'canvas-smoke-publish-'));
    publishProvider = new DuckdbProvider({
      memoryLimitMb: 256,
      exportRootPath: publishRoot,
      defaultRowLimit: 100,
      schemaSniffRows: 10,
    });
    const publishCanvas = new DataCanvas(
      publishProvider,
      new CanvasRegistry(publishProvider, {
        ttlMs: 60_000,
        absoluteCapMs: 600_000,
        maxCanvasesPerTenant: 10,
        sweeperIntervalMs: 0,
      }),
    );
    publishing = await publishCanvas.acquire(undefined, ctx);
    await publishing.query(`SELECT i FROM range(${ROWS}) r(i)`, { registerAs: 'rows', preview: 0 });
    await publishing.registerTable('raw', [{ v: '1' }, { v: 'x' }]);
    await publishing.registerView('fails_when_run', 'SELECT v::INTEGER AS v FROM raw');
  });

  afterAll(async () => {
    await publishProvider?.shutdown();
    await rm(publishRoot, { recursive: true, force: true });
  });

  it.each(['csv', 'json', 'parquet'] as const)(
    'replaces a file at the target with a resolved %s export and returns what it wrote',
    async (format) => {
      const path = `rows.${format}`;
      const absolute = join(publishRoot, path);
      await writeFile(absolute, 'prior');
      const result = await publishing.export('rows', { format, path });
      const { size } = await stat(absolute);
      expect(result).toEqual({ format, path: absolute, sizeBytes: size, rowCount: ROWS });
      const ids = await exportedIds(absolute, format);
      expect(ids).toHaveLength(ROWS);
      expect(ids.findIndex((id, line) => id !== line)).toBe(-1);
      expect(await stagingFiles(publishRoot)).toEqual([]);
    },
  );

  it.each(['csv', 'json', 'parquet'] as const)(
    'leaves no target and no staging file when the %s COPY fails in the engine',
    async (format) => {
      // The count reads no column, so the cast fails in the COPY.
      expect((await publishing.query('SELECT count(*) AS n FROM fails_when_run')).rows).toEqual([
        { n: '2' },
      ]);
      const error = await rejectionOf(
        publishing.export('fails_when_run', { format, path: `fails.${format}` }),
      );
      expect(error.data?.reason).toBe('sql_execution_error');
      expect(existsSync(join(publishRoot, `fails.${format}`))).toBe(false);
      expect(await stagingFiles(publishRoot)).toEqual([]);
    },
  );

  it('leaves a directory at the target and no staging file when the rename fails, naming the requested path', async () => {
    await mkdir(join(publishRoot, 'taken'));
    await writeFile(join(publishRoot, 'taken', 'inner.txt'), 'kept');
    const error = await rejectionOf(publishing.export('rows', { format: 'csv', path: 'taken' }));
    expect(error.code).toBe(JsonRpcErrorCode.DatabaseError);
    expect(error.data?.reason).toBeUndefined();
    expect(error.message).toContain(`"${join('[path]', 'taken')}"`);
    expect(error.message).not.toContain('.partial');
    expect(await readFile(join(publishRoot, 'taken', 'inner.txt'), 'utf8')).toBe('kept');
    expect(await stagingFiles(publishRoot)).toEqual([]);
  });

  it('names the requested path, not the staging file, when its directory is missing', async () => {
    const error = await rejectionOf(
      publishing.export('rows', { format: 'csv', path: join('missing', 'out.csv') }),
    );
    expect(error.code).toBe(JsonRpcErrorCode.DatabaseError);
    expect(error.message).toContain(`"${join('[path]', 'missing', 'out.csv')}"`);
    expect(error.message).not.toContain('.partial');
    expect(await stagingFiles(publishRoot)).toEqual([]);
  });
});

/**
 * An export or import that reads a view whose table is gone fails the way a
 * query of the view does: the missing table, which the caller stages again, not
 * an engine fault.
 */
describe('canvas · export and import of a view whose table is gone', () => {
  let orphanProvider: DuckdbProvider;
  let orphanRoot: string;
  let source: CanvasInstance;
  let target: CanvasInstance;

  beforeAll(async () => {
    orphanRoot = await mkdtemp(join(tmpdir(), 'canvas-smoke-orphan-'));
    orphanProvider = new DuckdbProvider({
      memoryLimitMb: 256,
      exportRootPath: orphanRoot,
      defaultRowLimit: 100,
      schemaSniffRows: 10,
    });
    const orphanCanvas = new DataCanvas(
      orphanProvider,
      new CanvasRegistry(orphanProvider, {
        ttlMs: 60_000,
        absoluteCapMs: 600_000,
        maxCanvasesPerTenant: 10,
        sweeperIntervalMs: 0,
      }),
    );
    source = await orphanCanvas.acquire(undefined, ctx);
    target = await orphanCanvas.acquire(undefined, ctx);
    await source.registerTable('gone', [{ x: 1 }]);
    await source.registerView('orphan', 'SELECT x FROM gone');
    expect(await source.drop('gone')).toBe(true);
  });

  afterAll(async () => {
    await orphanProvider?.shutdown();
    await rm(orphanRoot, { recursive: true, force: true });
  });

  /** What query() of the view raises, the shape the other calls must match. */
  async function queryRejection(): Promise<{ code: number; data: unknown; message: string }> {
    const { code, data, message } = await rejectionOf(source.query('SELECT * FROM orphan'));
    expect({ code, reason: data?.reason, tableName: data?.tableName }).toEqual({
      code: JsonRpcErrorCode.NotFound,
      reason: 'missing_table',
      tableName: 'gone',
    });
    return { code, data, message };
  }

  it.each(['csv', 'json', 'parquet'] as const)(
    'refuses a %s export with the missing table query() reports',
    async (format) => {
      const { code, data, message } = await rejectionOf(
        source.export('orphan', { format, path: `orphan.${format}` }),
      );
      expect({ code, data, message }).toEqual(await queryRejection());
      expect(existsSync(join(orphanRoot, `orphan.${format}`))).toBe(false);
    },
  );

  it('refuses an import with the missing table query() reports, and imports nothing', async () => {
    const { code, data, message } = await rejectionOf(target.importFrom(source.canvasId, 'orphan'));
    expect({ code, data, message }).toEqual(await queryRejection());
    expect(await target.describe()).toEqual([]);
  });

  // The source is looked up before the copy begins, so another call can drop it in between.
  it('refuses an import whose source table is dropped once looked up, naming the source table', async () => {
    await source.registerTable('dropped', [{ x: 1 }]);
    const internals = orphanProvider as unknown as {
      lookupKind(connection: unknown, name: string): Promise<string | undefined>;
    };
    const lookupKind = internals.lookupKind.bind(orphanProvider);
    const spy = vi.spyOn(internals, 'lookupKind').mockImplementationOnce(async (...args) => {
      const kind = await lookupKind(...args);
      await source.drop('dropped');
      return kind;
    });
    try {
      const error = await rejectionOf(target.importFrom(source.canvasId, 'dropped'));
      expect(spy).toHaveBeenCalled();
      expect({ code: error.code, data: error.data }).toEqual({
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'missing_table',
          sourceCanvasId: source.canvasId,
          sourceTableName: 'dropped',
          recovery: {
            hint: "Re-check the source table name, or list the tables staged on the source canvas with this server's dataframe-describe tool.",
          },
        },
      });
    } finally {
      spy.mockRestore();
    }
    expect(await target.describe()).toEqual([]);
  });
});

/**
 * DESCRIBE, SUMMARIZE, and SHOW pass the gate as SELECTs. Kept as a table or a
 * view, each runs inside `CREATE TABLE … AS` / `CREATE VIEW … AS`, which DuckDB
 * v2.0 accepts and v1.5 cannot parse; on v1.5 the call is the caller's SQL to
 * change, so it is refused as `sql_parse_error` and leaves nothing behind.
 */
describe('canvas · DESCRIBE, SUMMARIZE, and SHOW kept as a table or a view (#752)', () => {
  /** DuckDB v1.5's CREATE … AS grammar takes a SELECT only. */
  const ENGINE_KEEPS_METADATA = !duckdbVersion().startsWith('v1.');
  const PARSE_HINT =
    'Fix the SQL syntax the message names and send a single read-only SELECT. Put AS before an alias that is a SQL keyword, or double-quote it.';

  let keptProvider: DuckdbProvider;
  let keptExportRoot: string;
  let kept: CanvasInstance;

  beforeAll(async () => {
    keptExportRoot = await mkdtemp(join(tmpdir(), 'canvas-smoke-kept-'));
    keptProvider = new DuckdbProvider({
      memoryLimitMb: 256,
      exportRootPath: keptExportRoot,
      defaultRowLimit: 1000,
      schemaSniffRows: 100,
    });
    const keptCanvas = new DataCanvas(
      keptProvider,
      new CanvasRegistry(keptProvider, {
        ttlMs: 60_000,
        absoluteCapMs: 600_000,
        maxCanvasesPerTenant: 10,
        sweeperIntervalMs: 0,
      }),
    );
    kept = await keptCanvas.acquire(undefined, ctx);
    await kept.registerTable('kept_src', [
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ]);
  });

  afterAll(async () => {
    await keptProvider?.shutdown();
    await rm(keptExportRoot, { recursive: true, force: true });
  });

  /** Each statement and the rows it answers with: one per column described or summarized. */
  const STATEMENTS = [
    ['DESCRIBE SELECT 1', 1],
    ['DESCRIBE kept_src', 2],
    ['SUMMARIZE SELECT 1 AS v', 1],
    ['SUMMARIZE kept_src', 2],
    ['SHOW SELECT a FROM kept_src', 1],
    ['SHOW kept_src', 2],
  ] as const;
  const cases = STATEMENTS.map(([sql, rows], i) => [sql, rows, i] as const);

  it.each(cases)('answers %s on its own', async (sql, rows) => {
    expect((await kept.query(sql)).rowCount).toBe(rows);
  });

  it.runIf(ENGINE_KEEPS_METADATA).each(cases)(
    'registerAs keeps %s as a table with its exact row count',
    async (sql, rows, i) => {
      const result = await kept.query(sql, { registerAs: `kept_t_${i}` });
      expect(result).toMatchObject({ tableName: `kept_t_${i}`, rowCount: rows });
      expect((await kept.describe({ tableName: `kept_t_${i}` }))[0]?.rowCount).toBe(rows);
    },
  );

  it.runIf(ENGINE_KEEPS_METADATA).each(cases)(
    'registerView keeps %s as a view',
    async (sql, rows, i) => {
      await kept.registerView(`kept_v_${i}`, sql);
      expect((await kept.query(`SELECT * FROM kept_v_${i}`)).rowCount).toBe(rows);
    },
  );

  it.runIf(!ENGINE_KEEPS_METADATA).each(cases)(
    'registerAs refuses %s as sql_parse_error and leaves no table',
    async (sql, _rows, i) => {
      const error = await kept.query(sql, { registerAs: `kept_t_${i}` }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'sql_parse_error', recovery: { hint: PARSE_HINT } },
      });
      expect((error as McpError).message).toMatch(/^Canvas SQL rejected: .*Parser Error: /);
      expect(await kept.describe({ tableName: `kept_t_${i}` })).toEqual([]);
    },
  );

  it.runIf(!ENGINE_KEEPS_METADATA).each(cases)(
    'registerView refuses %s as sql_parse_error and creates no view',
    async (sql, _rows, i) => {
      await expect(kept.registerView(`kept_v_${i}`, sql)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'sql_parse_error', recovery: { hint: PARSE_HINT } },
      });
      expect(await kept.describe({ tableName: `kept_v_${i}` })).toEqual([]);
    },
  );
});

/**
 * describe() reads every object in scope before it answers. A registered view
 * stops being readable in five ways, each driven here through the lifecycle
 * wrapper a server calls; a view describe() cannot read rejects the call once,
 * naming every such view and the engine's reason, and never answers with a
 * count it did not take (#838).
 */
describe('canvas · describe() over a view that cannot be read (#838)', () => {
  const VIEW_UNREADABLE_HINT =
    'Drop each view the message names, or define it again over the tables as now staged.';
  const DAY_MS = 24 * 60 * 60 * 1000;
  let now = 1_000_000;
  let viewExportRoot: string;
  let viewRegistry: CanvasRegistry;
  let viewCanvas: DataCanvas;

  beforeAll(async () => {
    viewExportRoot = await mkdtemp(join(tmpdir(), 'canvas-smoke-unreadable-'));
    const viewProvider = new DuckdbProvider({
      memoryLimitMb: 256,
      exportRootPath: viewExportRoot,
      defaultRowLimit: 1000,
      schemaSniffRows: 100,
    });
    viewRegistry = new CanvasRegistry(
      viewProvider,
      {
        ttlMs: DAY_MS,
        absoluteCapMs: 7 * DAY_MS,
        maxCanvasesPerTenant: 100,
        sweeperIntervalMs: 0,
      },
      () => now,
    );
    viewCanvas = new DataCanvas(viewProvider, viewRegistry);
  });

  afterAll(async () => {
    if (viewCanvas) await viewCanvas.shutdown(ctx);
    await rm(viewExportRoot, { recursive: true, force: true });
  });

  /** A canvas holding a readable table `healthy` and a readable view `healthy_v` over it. */
  async function stagedCanvas(): Promise<CanvasInstance> {
    const instance = await viewCanvas.acquire(undefined, ctx);
    await instance.registerTable(
      'healthy',
      [
        { id: 1, label: 'a' },
        { id: 2, label: 'b' },
      ],
      {
        schema: [
          { name: 'id', type: 'INTEGER' },
          { name: 'label', type: 'VARCHAR' },
        ],
      },
    );
    await instance.registerView('healthy_v', 'SELECT id FROM healthy WHERE id > 1');
    return instance;
  }

  type Entry = [name: string, kind: string, rowCount: number, columns: string[]];

  /** Each entry's name, kind, row count, and column names, in the order describe() returns them. */
  function entries(tables: Awaited<ReturnType<CanvasInstance['describe']>>): Entry[] {
    return tables.map((t) => [t.name, t.kind, t.rowCount, t.columns.map((c) => c.name)]);
  }

  const HEALTHY: Entry = ['healthy', 'table', 2, ['id', 'label']];
  const HEALTHY_V: Entry = ['healthy_v', 'view', 1, ['id']];

  /** One view_unreadable rejection naming each `[view, engine error class]`, in order. */
  function expectUnreadable(error: unknown, views: readonly (readonly [string, string])[]): void {
    expect(error).toBeInstanceOf(McpError);
    const mcp = error as McpError;
    expect(mcp.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(mcp.data).toEqual({
      reason: 'view_unreadable',
      views: views.map(([name, engineClass]) => ({
        name,
        engineMessage: expect.stringMatching(new RegExp(`^${engineClass} Error: \\S`)),
      })),
      recovery: { hint: VIEW_UNREADABLE_HINT },
    });
    const named = mcp.data?.views as { engineMessage: string; name: string }[];
    expect(named).toHaveLength(views.length);
    for (const view of named) {
      expect(mcp.message).toContain(`"${view.name}"`);
      expect(mcp.message).toContain(view.engineMessage);
    }
  }

  /** Each way a registered view `rv` stops being readable, and the engine class its read then fails with. */
  const ROUTES: readonly (readonly [string, string, (c: CanvasInstance) => Promise<void>])[] = [
    [
      'a series argument the engine rejects as it runs',
      'Binder',
      async (c) => {
        await c.registerView('rv', 'SELECT * FROM range(0, 10, 0)');
      },
    ],
    [
      'its table dropped',
      'Catalog',
      async (c) => {
        await c.registerTable('base', [{ c: 1 }]);
        await c.registerView('rv', 'SELECT c FROM base');
        expect(await c.drop('base')).toBe(true);
      },
    ],
    [
      'a definition that reads itself',
      'Binder',
      async (c) => {
        await c.registerView('rv', 'SELECT 1 AS c');
        await c.registerView('rv', 'SELECT * FROM rv');
      },
    ],
    [
      'its table expired and swept',
      'Catalog',
      async (c) => {
        await c.registerTable('base', [{ c: 1 }], { ttlMs: 60_000 });
        await c.registerView('rv', 'SELECT c FROM base');
        now += 60_001;
        await viewRegistry.sweep();
      },
    ],
    [
      'its table staged again without the column it reads',
      'Binder',
      async (c) => {
        await c.registerTable('base', [{ c: 1, d: 2 }]);
        await c.registerView('rv', 'SELECT c FROM base');
        await c.registerTable('base', [{ d: 3 }]);
      },
    ],
    [
      'a filter that cannot convert a value of its table as staged again',
      'Conversion',
      async (c) => {
        await c.registerTable('base', [{ v: '1' }]);
        await c.registerView('rv', 'SELECT v FROM base WHERE v::INTEGER > 0');
        await c.registerTable('base', [{ v: '1' }, { v: 'x' }]);
      },
    ],
    [
      'a filter whose function rejects a value of its table as staged again',
      'Invalid Input',
      async (c) => {
        await c.registerTable('base', [{ d: '2024-01-01' }]);
        await c.registerView('rv', "SELECT d FROM base WHERE strptime(d, '%Y-%m-%d') IS NOT NULL");
        await c.registerTable('base', [{ d: 'none' }]);
      },
    ],
    [
      'a filter whose arithmetic leaves its type on a value of its table as staged again',
      'Out of Range',
      async (c) => {
        const schema = [{ name: 'n', type: 'INTEGER' as const }];
        await c.registerTable('base', [{ n: 1 }], { schema });
        await c.registerView('rv', 'SELECT n FROM base WHERE abs(n + 1) > 0');
        await c.registerTable('base', [{ n: 2_147_483_647 }], { schema });
      },
    ],
  ];

  it('answers every entry and count on a canvas whose views all read', async () => {
    const instance = await stagedCanvas();
    await instance.registerView('series_v', 'SELECT * FROM range(3)');
    const SERIES_V: Entry = ['series_v', 'view', 3, ['range']];
    expect(entries(await instance.describe())).toEqual([HEALTHY, HEALTHY_V, SERIES_V]);
    expect(entries(await instance.describe({ kind: 'view' }))).toEqual([HEALTHY_V, SERIES_V]);
    expect(entries(await instance.describe({ kind: 'table' }))).toEqual([HEALTHY]);
    expect(entries(await instance.describe({ tableName: 'healthy_v' }))).toEqual([HEALTHY_V]);
  });

  it.each(ROUTES)(
    'rejects describe() as view_unreadable when a view has %s',
    async (_label, engineClass, breakView) => {
      const instance = await stagedCanvas();
      await breakView(instance);

      for (const options of [undefined, { kind: 'view' as const }, { tableName: 'rv' }]) {
        expectUnreadable(await rejectionOf(instance.describe(options)), [['rv', engineClass]]);
      }

      // Calls whose scope leaves the view out answer as they did.
      const tables = entries(await instance.describe({ kind: 'table' }));
      expect(tables.filter(([name]) => name !== 'base')).toEqual([HEALTHY]);
      expect(entries(await instance.describe({ tableName: 'healthy' }))).toEqual([HEALTHY]);
      expect(entries(await instance.describe({ tableName: 'healthy_v' }))).toEqual([HEALTHY_V]);

      expect(await instance.drop('rv')).toBe(true);
      const after = entries(await instance.describe());
      expect(after.filter(([name]) => name !== 'base')).toEqual([HEALTHY, HEALTHY_V]);
    },
  );

  it('names every view it cannot read in one rejection', async () => {
    const instance = await stagedCanvas();
    await instance.registerView('rv_a', 'SELECT * FROM range(0, 10, 0)');
    await instance.registerTable('base', [{ c: 1 }]);
    await instance.registerView('rv_b', 'SELECT c FROM base');
    expect(await instance.drop('base')).toBe(true);

    const both = [
      ['rv_a', 'Binder'],
      ['rv_b', 'Catalog'],
    ] as const;
    expectUnreadable(await rejectionOf(instance.describe()), both);
    expectUnreadable(await rejectionOf(instance.describe({ kind: 'view' })), both);
  });

  it('passes the caller signal through the canvas handle', async () => {
    const instance = await stagedCanvas();
    const controller = new AbortController();
    controller.abort();
    const error = await rejectionOf(instance.describe({ signal: controller.signal }));
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: 'Canvas describe was cancelled.',
      data: { reason: 'cancelled' },
    });
  });

  it('reports a drop that conflicts with a registration in flight as a DatabaseError', async () => {
    const instance = await viewCanvas.acquire(undefined, ctx);
    await instance.registerTable('busy', [{ x: 1 }]);
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const { promise: staging, resolve: staged } = Promise.withResolvers<void>();
    async function* rows(): AsyncGenerator<Record<string, unknown>> {
      yield { x: 2 };
      staged();
      await held;
      yield { x: 3 };
    }
    const registration = instance.registerTable('busy', rows(), {
      schema: [{ name: 'x', type: 'INTEGER' }],
    });

    await staging;
    const failure = await rejectionOf(instance.drop('busy'));
    release();
    await registration;

    expect(failure).toBeInstanceOf(McpError);
    expect(failure.code).toBe(JsonRpcErrorCode.DatabaseError);
    const { cause } = failure;
    expect(cause).toBeInstanceOf(Error);
    expect(failure.message).toBe((cause as Error).message);
    // The registration it conflicted with committed.
    expect((await instance.query('SELECT x FROM busy ORDER BY x')).rows).toEqual([
      { x: 2 },
      { x: 3 },
    ]);
  });
});

/**
 * describe() runs on a connection of its own and honors its caller's signal
 * the way query() does: an abort rejects it as cancelled, and a describe in
 * progress leaves the canvas's other calls free to run.
 */
describe('canvas · describe cancellation', () => {
  let describeExportRoot: string;
  let describeProvider: DuckdbProvider;
  /** Called with each statement a connection begins, once the engine has it. */
  let onStatement: ((sql: string) => void) | undefined;
  const spies: { mockRestore(): void }[] = [];

  beforeAll(async () => {
    describeExportRoot = await mkdtemp(join(tmpdir(), 'canvas-smoke-describe-abort-'));
    describeProvider = new DuckdbProvider({
      memoryLimitMb: 256,
      exportRootPath: describeExportRoot,
      defaultRowLimit: 100,
      schemaSniffRows: 10,
    });
    await describeProvider.initCanvas('descab0001', ctx);
    await describeProvider.registerTable(
      'descab0001',
      't',
      Array.from({ length: 1_500 }, (_, x) => ({ x })),
      ctx,
    );
    await describeProvider.registerView(
      'descab0001',
      'v_small',
      'SELECT x FROM t WHERE x < 3',
      ctx,
    );
    await describeProvider.registerView(
      'descab0001',
      'v_wide',
      'SELECT a.x FROM t a, t b, t c, t d',
      ctx,
    );

    // A per-call statement reaches the engine through extractStatements; one
    // on the canvas's own connection through runAndReadAll.
    const originalExtract = DuckDBConnection.prototype.extractStatements;
    spies.push(
      vi.spyOn(DuckDBConnection.prototype, 'extractStatements').mockImplementation(async function (
        this: DuckDBConnection,
        sql: string,
      ) {
        const extracted = await originalExtract.call(this, sql);
        onStatement?.(sql);
        return extracted;
      }),
    );
    const originalRead = DuckDBConnection.prototype.runAndReadAll;
    spies.push(
      vi.spyOn(DuckDBConnection.prototype, 'runAndReadAll').mockImplementation(function (
        this: DuckDBConnection,
        ...args
      ) {
        const read = originalRead.apply(this, args);
        onStatement?.(args[0]);
        return read;
      }),
    );
  });

  afterAll(async () => {
    for (const spy of spies) spy.mockRestore();
    await describeProvider?.shutdown();
    await rm(describeExportRoot, { recursive: true, force: true });
  });

  function expectCancelled(error: unknown): void {
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.Timeout);
    expect((error as McpError).data?.reason).toBe('cancelled');
    expect((error as McpError).message).toBe('Canvas describe was cancelled.');
  }

  it('rejects an already-aborted describe as cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await describeProvider
      .describe('descab0001', ctx, { tableName: 'v_small', signal: controller.signal })
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expectCancelled(error);
  });

  it('rejects a describe aborted once it begins reading a view as cancelled', async () => {
    const controller = new AbortController();
    onStatement = (sql) => {
      if (sql === 'SELECT COUNT(*) AS n FROM "v_small"') controller.abort();
    };
    try {
      const error = await describeProvider
        .describe('descab0001', ctx, { tableName: 'v_small', signal: controller.signal })
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      expect(controller.signal.aborted).toBe(true);
      expectCancelled(error);
    } finally {
      onStatement = undefined;
    }
    // The canvas still answers.
    expect(
      (await describeProvider.describe('descab0001', ctx, { tableName: 'v_small' }))[0]?.rowCount,
    ).toBe(3);
  });

  it('leaves a query on the same canvas free to run while a describe is in progress', async () => {
    const controller = new AbortController();
    const { promise: reading, resolve: readingStarted } = Promise.withResolvers<void>();
    onStatement = (sql) => {
      if (sql === 'SELECT COUNT(*) AS n FROM "v_wide"') readingStarted();
    };
    let settled = false;
    const outcome = describeProvider
      .describe('descab0001', ctx, { tableName: 'v_wide', signal: controller.signal })
      .then(
        () => undefined,
        (err: unknown) => err,
      )
      .finally(() => {
        settled = true;
      });
    try {
      await reading;
      const result = await describeProvider.query(
        'descab0001',
        'SELECT count(*)::INTEGER AS n FROM t',
        ctx,
      );
      expect(result.rows).toEqual([{ n: 1_500 }]);
      expect(settled).toBe(false);
    } finally {
      onStatement = undefined;
      controller.abort();
    }
    expectCancelled(await outcome);
  }, 60_000);
});

// An abort reaches a running query as an engine interrupt and surfaces as a
// cancelled Timeout. DuckDB acts on an interrupt only while a query executes,
// so the abort waits until this one observably is: a sort over a three-way
// cross join (8 billion rows) past a 24 MB memory limit writes its first spill
// file within moments of starting and could not finish for hours. No timing is
// asserted — the only clock is the poll for that file.
describe('canvas · query cancellation', () => {
  let scratchParent: string;
  let cancelExportRoot: string;
  let cancelProvider: DuckdbProvider;

  beforeAll(async () => {
    scratchParent = await mkdtemp(join(tmpdir(), 'canvas-smoke-cancel-'));
    cancelExportRoot = await mkdtemp(join(tmpdir(), 'canvas-smoke-cancel-export-'));
    cancelProvider = new DuckdbProvider({
      memoryLimitMb: 24,
      exportRootPath: cancelExportRoot,
      tempRootPath: scratchParent,
      defaultRowLimit: 100,
      schemaSniffRows: 10,
    });
    await cancelProvider.initCanvas('cancelq001', ctx);
    await cancelProvider.registerTable(
      'cancelq001',
      'big',
      Array.from({ length: 2_000 }, (_, x) => ({ x })),
      ctx,
    );
  });

  afterAll(async () => {
    await cancelProvider?.shutdown();
    await rm(scratchParent, { recursive: true, force: true });
    await rm(cancelExportRoot, { recursive: true, force: true });
  });

  /** Files the engine has spilled anywhere under this provider's scratch parent. */
  async function spilledFiles(): Promise<number> {
    const entries = await readdir(scratchParent, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).length;
  }

  it('interrupts a running query and rejects with a cancelled Timeout', async () => {
    expect(await spilledFiles()).toBe(0);
    const controller = new AbortController();
    const outcome = cancelProvider
      .query(
        'cancelq001',
        'SELECT a.x AS a, b.x AS b, c.x AS c FROM big a, big b, big c ORDER BY a DESC, b DESC, c DESC',
        ctx,
        { signal: controller.signal },
      )
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    while ((await spilledFiles()) === 0) await delay(20);
    controller.abort();

    const failure = await outcome;
    expect(failure).toBeInstanceOf(McpError);
    expect((failure as McpError).code).toBe(JsonRpcErrorCode.Timeout);
    expect((failure as McpError).data?.reason).toBe('cancelled');
  }, 120_000);

  it('interrupts a running registerAs, leaves no table, and keeps the canvas answering', async () => {
    const before = await spilledFiles();
    const controller = new AbortController();
    const outcome = cancelProvider
      .query(
        'cancelq001',
        'SELECT a.x AS a, b.x AS b, c.x AS c FROM big a, big b, big c ORDER BY a DESC, b DESC, c DESC',
        ctx,
        { signal: controller.signal, registerAs: 'kept' },
      )
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    while ((await spilledFiles()) <= before) await delay(20);
    controller.abort();

    const failure = await outcome;
    expect(failure).toBeInstanceOf(McpError);
    expect((failure as McpError).code).toBe(JsonRpcErrorCode.Timeout);
    expect((failure as McpError).data?.reason).toBe('cancelled');
    expect((failure as McpError).message).toBe('Canvas query was cancelled.');
    expect(await cancelProvider.describe('cancelq001', ctx, { tableName: 'kept' })).toEqual([]);
    const followUp = await cancelProvider.query(
      'cancelq001',
      'SELECT count(*) AS n FROM big',
      ctx,
      {
        signal: new AbortController().signal,
      },
    );
    expect(followUp.rows).toEqual([{ n: '2000' }]);
  }, 120_000);
});

// An abort that lands before the engine starts executing — before the call,
// while the read-only gate runs, or between preparing the statement and
// running it — rejects the same way an abort mid-execution does, instead of
// being dropped while the query runs to completion (#662). The three-way cross
// join takes seconds; every aborted call must reject well inside that, and the
// baseline is measured on the same machine and load rather than hardcoded.
describe('canvas · cancellation before execution', () => {
  const CROSS_JOIN = 'SELECT sum(a.x * b.x * c.x) AS s FROM t a, t b, t c';
  let exportRoot: string;
  let provider: DuckdbProvider;
  let baselineMs: number;
  /** Per-call connections the provider opened after setup, and those it closed. */
  const opened = new Set<DuckDBConnection>();
  const closed = new Set<DuckDBConnection>();
  /** When set, called with each statement a per-call connection has prepared, before it runs. */
  let onPrepared: ((sql: string) => void) | undefined;
  /** When set, called as a per-call connection closes, once its call's statements are done. */
  let onClosed: (() => void) | undefined;

  beforeAll(async () => {
    exportRoot = await mkdtemp(join(tmpdir(), 'canvas-smoke-early-abort-'));
    provider = new DuckdbProvider({
      memoryLimitMb: 256,
      exportRootPath: exportRoot,
      defaultRowLimit: 100,
      schemaSniffRows: 10,
    });
    await provider.initCanvas('earlyab001', ctx);
    await provider.initCanvas('earlyab002', ctx);
    await provider.registerTable(
      'earlyab001',
      't',
      Array.from({ length: 1_500 }, (_, x) => ({ x })),
      ctx,
    );
    await provider.registerTable('earlyab001', 'small', [{ x: 1 }, { x: 2 }, { x: 3 }], ctx);
    // Path-export publication runs on a canvas of its own, keeping the table
    // lists the cases above assert unchanged.
    await provider.initCanvas('earlyab003', ctx);
    await provider.query(
      'earlyab003',
      'SELECT i, md5(i::VARCHAR) AS s FROM range(200000) r(i)',
      ctx,
      { registerAs: 'publish', preview: 0 },
    );

    const started = performance.now();
    const unaborted = await provider.query('earlyab001', CROSS_JOIN, ctx, {
      signal: new AbortController().signal,
    });
    baselineMs = performance.now() - started;
    expect(unaborted.rowCount).toBe(1);

    // Installed after setup, so the canvases' control connections stay out.
    const originalConnect = DuckDBInstance.prototype.connect;
    vi.spyOn(DuckDBInstance.prototype, 'connect').mockImplementation(async function (
      this: DuckDBInstance,
    ) {
      const connection = await originalConnect.call(this);
      opened.add(connection);
      return connection;
    });
    const originalClose = DuckDBConnection.prototype.closeSync;
    vi.spyOn(DuckDBConnection.prototype, 'closeSync').mockImplementation(function (
      this: DuckDBConnection,
    ) {
      closed.add(this);
      originalClose.call(this);
      if (opened.has(this)) onClosed?.();
    });
    const originalExtract = DuckDBConnection.prototype.extractStatements;
    vi.spyOn(DuckDBConnection.prototype, 'extractStatements').mockImplementation(async function (
      this: DuckDBConnection,
      sql: string,
    ) {
      const extracted = await originalExtract.call(this, sql);
      const hook = onPrepared;
      if (hook && opened.has(this)) {
        const prepare = extracted.prepare.bind(extracted);
        extracted.prepare = async (index: number) => {
          const prepared = await prepare(index);
          hook(sql);
          return prepared;
        };
      }
      return extracted;
    });
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await provider?.shutdown();
    await rm(exportRoot, { recursive: true, force: true });
  });

  /** How `run` settled, and how long it took. */
  async function settle(run: () => Promise<unknown>): Promise<{ error: unknown; ms: number }> {
    const started = performance.now();
    try {
      await run();
      return { error: undefined, ms: performance.now() - started };
    } catch (error) {
      return { error, ms: performance.now() - started };
    }
  }

  function expectCancelled(error: unknown, message: string): void {
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.Timeout);
    expect((error as McpError).data?.reason).toBe('cancelled');
    expect((error as McpError).message).toBe(message);
  }

  async function tableNames(canvasId: string): Promise<string[]> {
    return (await provider.describe(canvasId, ctx)).map((table) => table.name).sort();
  }

  it('measures a cross join that runs for seconds unaborted', () => {
    expect(baselineMs).toBeGreaterThan(1_000);
  });

  it('rejects an already-aborted query as cancelled without running it', async () => {
    const controller = new AbortController();
    controller.abort();
    const { error, ms } = await settle(() =>
      provider.query('earlyab001', CROSS_JOIN, ctx, { signal: controller.signal }),
    );
    expectCancelled(error, 'Canvas query was cancelled.');
    expect(ms).toBeLessThan(baselineMs / 4);
  });

  it('rejects a query aborted in a microtask after the call', async () => {
    const controller = new AbortController();
    const outcome = settle(() =>
      provider.query('earlyab001', CROSS_JOIN, ctx, { signal: controller.signal }),
    );
    queueMicrotask(() => controller.abort());
    const { error, ms } = await outcome;
    expectCancelled(error, 'Canvas query was cancelled.');
    expect(ms).toBeLessThan(baselineMs / 4);
  }, 60_000);

  it('rejects a query aborted while the read-only gate runs', async () => {
    const controller = new AbortController();
    const originalRead = DuckDBConnection.prototype.runAndReadAll;
    const gateSpy = vi
      .spyOn(DuckDBConnection.prototype, 'runAndReadAll')
      .mockImplementation(async function (this: DuckDBConnection, ...args) {
        const reader = await originalRead.apply(this, args);
        if (args[0].includes('json_serialize_sql')) controller.abort();
        return reader;
      });
    try {
      const { error, ms } = await settle(() =>
        provider.query('earlyab001', CROSS_JOIN, ctx, { signal: controller.signal }),
      );
      expect(controller.signal.aborted).toBe(true);
      expectCancelled(error, 'Canvas query was cancelled.');
      expect(ms).toBeLessThan(baselineMs / 4);
    } finally {
      gateSpy.mockRestore();
    }
  }, 60_000);

  it('rejects a query aborted after its statement is prepared but before the engine runs it', async () => {
    const controller = new AbortController();
    onPrepared = (sql) => {
      if (sql === CROSS_JOIN) controller.abort();
    };
    try {
      const { error, ms } = await settle(() =>
        provider.query('earlyab001', CROSS_JOIN, ctx, { signal: controller.signal }),
      );
      expect(controller.signal.aborted).toBe(true);
      expectCancelled(error, 'Canvas query was cancelled.');
      expect(ms).toBeLessThan(baselineMs / 4);
    } finally {
      onPrepared = undefined;
    }
  }, 60_000);

  it('rejects a registerAs aborted after its CTAS is prepared but before it runs, leaving no table', async () => {
    const controller = new AbortController();
    onPrepared = (sql) => {
      if (sql.startsWith('CREATE TABLE')) controller.abort();
    };
    try {
      const { error, ms } = await settle(() =>
        provider.query('earlyab001', CROSS_JOIN, ctx, {
          signal: controller.signal,
          registerAs: 'early_ctas',
        }),
      );
      expect(controller.signal.aborted).toBe(true);
      expectCancelled(error, 'Canvas query was cancelled.');
      expect(ms).toBeLessThan(baselineMs / 4);
    } finally {
      onPrepared = undefined;
    }
    expect(await tableNames('earlyab001')).toEqual(['small', 't']);
  }, 60_000);

  it('drops the registerAs table when the abort lands after the CTAS has created it', async () => {
    const controller = new AbortController();
    onPrepared = (sql) => {
      if (sql.startsWith('SELECT COUNT(*)')) controller.abort();
    };
    try {
      const { error } = await settle(() =>
        provider.query('earlyab001', 'SELECT x FROM small', ctx, {
          signal: controller.signal,
          registerAs: 'late_ctas',
        }),
      );
      expect(controller.signal.aborted).toBe(true);
      expectCancelled(error, 'Canvas query was cancelled.');
    } finally {
      onPrepared = undefined;
    }
    expect(await tableNames('earlyab001')).toEqual(['small', 't']);
  });

  it('rejects a registerAs aborted in a microtask after the call and leaves no table', async () => {
    const controller = new AbortController();
    const outcome = settle(() =>
      provider.query('earlyab001', CROSS_JOIN, ctx, {
        signal: controller.signal,
        registerAs: 'early_ctas',
      }),
    );
    queueMicrotask(() => controller.abort());
    const { error, ms } = await outcome;
    expectCancelled(error, 'Canvas query was cancelled.');
    expect(ms).toBeLessThan(baselineMs / 4);
    expect(await tableNames('earlyab001')).toEqual(['small', 't']);
  }, 60_000);

  it('rejects registerView aborted before the call or during the gate, and registers nothing', async () => {
    const already = new AbortController();
    already.abort();
    const before = await settle(() =>
      provider.registerView('earlyab001', 'early_view', 'SELECT x FROM small', ctx, {
        signal: already.signal,
      }),
    );
    expectCancelled(before.error, 'Canvas view registration was cancelled.');

    const controller = new AbortController();
    const originalRead = DuckDBConnection.prototype.runAndReadAll;
    const gateSpy = vi
      .spyOn(DuckDBConnection.prototype, 'runAndReadAll')
      .mockImplementation(async function (this: DuckDBConnection, ...args) {
        const reader = await originalRead.apply(this, args);
        if (args[0].includes('json_serialize_sql')) controller.abort();
        return reader;
      });
    try {
      const during = await settle(() =>
        provider.registerView('earlyab001', 'early_view', 'SELECT x FROM small', ctx, {
          signal: controller.signal,
        }),
      );
      expect(controller.signal.aborted).toBe(true);
      expectCancelled(during.error, 'Canvas view registration was cancelled.');
    } finally {
      gateSpy.mockRestore();
    }
    expect(await tableNames('earlyab001')).toEqual(['small', 't']);
  });

  it('rejects an export aborted before the call or in a microtask after it, writing nothing', async () => {
    const already = new AbortController();
    already.abort();
    const before = await settle(() =>
      provider.export('earlyab001', 'small', { format: 'csv', path: 'early-before.csv' }, ctx, {
        signal: already.signal,
      }),
    );
    expectCancelled(before.error, 'Canvas export was cancelled.');

    const controller = new AbortController();
    const outcome = settle(() =>
      provider.export('earlyab001', 'small', { format: 'csv', path: 'early-micro.csv' }, ctx, {
        signal: controller.signal,
      }),
    );
    queueMicrotask(() => controller.abort());
    expectCancelled((await outcome).error, 'Canvas export was cancelled.');
    expect(existsSync(join(exportRoot, 'early-before.csv'))).toBe(false);
    expect(existsSync(join(exportRoot, 'early-micro.csv'))).toBe(false);
  });

  it('rejects importFrom aborted before the call or in a microtask after it, importing nothing', async () => {
    const already = new AbortController();
    already.abort();
    const before = await settle(() =>
      provider.importFrom('earlyab002', 'earlyab001', 'small', 'imported', ctx, {
        signal: already.signal,
      }),
    );
    expectCancelled(before.error, 'Canvas import was cancelled.');

    const controller = new AbortController();
    const outcome = settle(() =>
      provider.importFrom('earlyab002', 'earlyab001', 'small', 'imported', ctx, {
        signal: controller.signal,
      }),
    );
    queueMicrotask(() => controller.abort());
    expectCancelled((await outcome).error, 'Canvas import was cancelled.');
    expect(await tableNames('earlyab002')).toEqual([]);
  });

  /** How a path export of `publish`, on its own canvas, settles; `prepared` sees each statement it prepares. */
  async function publish(
    format: ExportFormat,
    path: string,
    prepared: (sql: string, controller: AbortController) => void,
  ): Promise<{ error: unknown; signal: AbortSignal }> {
    const controller = new AbortController();
    onPrepared = (sql) => prepared(sql, controller);
    try {
      const { error } = await settle(() =>
        provider.export('earlyab003', 'publish', { format, path }, ctx, {
          signal: controller.signal,
        }),
      );
      return { error, signal: controller.signal };
    } finally {
      onPrepared = undefined;
    }
  }

  /** Aborts as the export's COMMIT is prepared: its COPY has written the whole file by then. */
  const abortAtCommit = (sql: string, controller: AbortController) => {
    if (sql === 'COMMIT') controller.abort();
  };

  it.each(['csv', 'json', 'parquet'] as const)(
    'rejects a %s export aborted as its COMMIT is prepared, publishing nothing and leaving a prior file as it was',
    async (format) => {
      const fresh = `commit-fresh.${format}`;
      const first = await publish(format, fresh, abortAtCommit);
      expect(first.signal.aborted).toBe(true);
      expectCancelled(first.error, 'Canvas export was cancelled.');
      expect(existsSync(join(exportRoot, fresh))).toBe(false);

      const prior = `commit-prior.${format}`;
      await writeFile(join(exportRoot, prior), 'prior');
      const second = await publish(format, prior, abortAtCommit);
      expectCancelled(second.error, 'Canvas export was cancelled.');
      expect(await readFile(join(exportRoot, prior), 'utf8')).toBe('prior');
      expect(await stagingFiles(exportRoot)).toEqual([]);

      // Resolved, the export replaces the prior file whole.
      const resolved = await publish(format, prior, () => {});
      expect(resolved.error).toBeUndefined();
      expect((await stat(join(exportRoot, prior))).size).toBeGreaterThan(200_000);
      const ids = await exportedIds(join(exportRoot, prior), format);
      expect(ids).toHaveLength(200_000);
      expect(ids.findIndex((id, line) => id !== line)).toBe(-1);
      expect(await stagingFiles(exportRoot)).toEqual([]);
    },
    60_000,
  );

  // A regression guard, not a reproduction: an interrupt as the COPY starts was
  // already honored before any file was written. The COMMIT cases above are the
  // reproduction, since by then the COPY has written the whole file.
  it('rejects a Parquet export aborted as its COPY starts and leaves no target file', async () => {
    const { error, signal } = await publish('parquet', 'copy-start.parquet', (sql, controller) => {
      if (sql.startsWith('COPY')) controller.abort();
    });
    expect(signal.aborted).toBe(true);
    expectCancelled(error, 'Canvas export was cancelled.');
    expect(existsSync(join(exportRoot, 'copy-start.parquet'))).toBe(false);
    expect(await stagingFiles(exportRoot)).toEqual([]);
  });

  // The target's path checks run again once the export commits, before the rename.
  it('refuses to publish over a target that became a symbolic link as the export committed', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'canvas-smoke-publish-outside-'));
    try {
      const destination = join(outside, 'kept.csv');
      await writeFile(destination, 'outside');
      const linked = join(exportRoot, 'linked.csv');
      const { error } = await publish('csv', 'linked.csv', (sql) => {
        if (sql !== 'COMMIT') return;
        rmSync(linked, { force: true });
        symlinkSync(destination, linked);
      });
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).data?.reason).toBe('export_path_symlink');
      expect(await readFile(destination, 'utf8')).toBe('outside');
      expect(await readFile(linked, 'utf8')).toBe('outside');
      expect(await stagingFiles(exportRoot)).toEqual([]);
    } finally {
      await rm(join(exportRoot, 'linked.csv'), { force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  // The last cancellation check comes after the export's connection is done, just before the rename.
  it('rejects a path export aborted as its connection closes after COMMIT, leaving a prior file as it was', async () => {
    const prior = 'close-prior.parquet';
    await writeFile(join(exportRoot, prior), 'prior');
    const controller = new AbortController();
    onClosed = () => controller.abort();
    let outcome: { error: unknown };
    try {
      outcome = await settle(() =>
        provider.export('earlyab003', 'publish', { format: 'parquet', path: prior }, ctx, {
          signal: controller.signal,
        }),
      );
    } finally {
      onClosed = undefined;
    }
    expect(controller.signal.aborted).toBe(true);
    expectCancelled(outcome.error, 'Canvas export was cancelled.');
    expect(await readFile(join(exportRoot, prior), 'utf8')).toBe('prior');
    expect(await stagingFiles(exportRoot)).toEqual([]);
  });

  // It also comes after the target's path is checked again: nothing runs between it and the rename.
  it('rejects a path export aborted while its target path is checked again, leaving a prior file as it was', async () => {
    const prior = 'recheck-prior.csv';
    await writeFile(join(exportRoot, prior), 'prior');
    const controller = new AbortController();
    const resolveExportPath = exportWriter.resolveExportPath;
    let targetChecks = 0;
    const recheck = vi
      .spyOn(exportWriter, 'resolveExportPath')
      .mockImplementation(async (root, requested) => {
        const resolved = await resolveExportPath(root, requested);
        // The target is checked before its COPY, then again once the export commits.
        if (requested === prior && ++targetChecks === 2) controller.abort();
        return resolved;
      });
    let outcome: { error: unknown };
    try {
      outcome = await settle(() =>
        provider.export('earlyab003', 'publish', { format: 'csv', path: prior }, ctx, {
          signal: controller.signal,
        }),
      );
    } finally {
      recheck.mockRestore();
    }
    expect(targetChecks).toBe(2);
    expectCancelled(outcome.error, 'Canvas export was cancelled.');
    expect(await readFile(join(exportRoot, prior), 'utf8')).toBe('prior');
    expect(await stagingFiles(exportRoot)).toEqual([]);
  });

  it('closes every per-call connection and still answers each entry point un-aborted', async () => {
    const signal = new AbortController().signal;
    const result = await provider.query('earlyab001', 'SELECT x FROM small ORDER BY x', ctx, {
      signal,
    });
    // Sniffed as BIGINT, which DuckDB returns as a string.
    expect(result.rows).toEqual([{ x: '1' }, { x: '2' }, { x: '3' }]);
    const registered = await provider.query('earlyab001', 'SELECT x * 10 AS y FROM small', ctx, {
      signal,
      registerAs: 'scaled',
    });
    expect(registered).toMatchObject({ tableName: 'scaled', rowCount: 3, columns: ['y'] });
    const view = await provider.registerView(
      'earlyab001',
      'small_view',
      'SELECT x FROM small',
      ctx,
      {
        signal,
      },
    );
    expect(view.viewName).toBe('small_view');
    const exported = await provider.export(
      'earlyab001',
      'scaled',
      { format: 'csv', path: 'scaled.csv' },
      ctx,
      { signal },
    );
    expect(exported.rowCount).toBe(3);
    const imported = await provider.importFrom(
      'earlyab002',
      'earlyab001',
      'scaled',
      'scaled',
      ctx,
      {
        signal,
      },
    );
    expect(imported).toMatchObject({ tableName: 'scaled', rowCount: 3 });

    expect(opened.size).toBeGreaterThan(0);
    expect([...opened].filter((connection) => !closed.has(connection))).toEqual([]);
  });
});

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
      maxCanvasesPerTenant: 10,
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
    expect(await instance.clear()).toBe(1);
    expect((await instance.describe()).length).toBe(0);
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

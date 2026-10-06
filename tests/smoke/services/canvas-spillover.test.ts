/**
 * @fileoverview `spillover()` against a real DuckDB canvas. The helper always
 * hands the provider an async row stream with an explicit schema, so this is
 * the provider's async-iterable registration path end to end: every source
 * row reaches the table in order, `caps.maxRows` bounds the table exactly, and
 * an async source registered without a schema is refused up front.
 * @module tests/smoke/services/canvas-spillover.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CanvasInstance } from '@/services/canvas/core/CanvasInstance.js';
import { CanvasRegistry } from '@/services/canvas/core/CanvasRegistry.js';
import { DataCanvas } from '@/services/canvas/core/DataCanvas.js';
import { DuckdbProvider } from '@/services/canvas/providers/duckdb/DuckdbProvider.js';
import { spillover } from '@/services/canvas/spillover.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

const ctx: RequestContext = {
  requestId: 'smoke-canvas-spillover',
  timestamp: '2026-01-01T00:00:00.000Z',
  tenantId: 'smoke-tenant',
};

interface Item extends Record<string, unknown> {
  id: number;
  label: string;
}

/** A paginated upstream: `total` rows in pages of 25, each page behind an await. */
async function* pagedSource(total: number): AsyncGenerator<Item> {
  for (let start = 0; start < total; start += 25) {
    await Promise.resolve();
    for (let id = start; id < Math.min(start + 25, total); id += 1) {
      yield { id, label: `item-${id}` };
    }
  }
}

let canvas: DataCanvas;
let instance: CanvasInstance;
let exportRoot: string;

beforeAll(async () => {
  exportRoot = await mkdtemp(join(tmpdir(), 'canvas-spillover-'));
  const provider = new DuckdbProvider({
    memoryLimitMb: 128,
    exportRootPath: exportRoot,
    defaultRowLimit: 1_000,
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
});

afterAll(async () => {
  if (canvas) await canvas.shutdown(ctx);
  await rm(exportRoot, { recursive: true, force: true });
});

/** Every staged id, in id order, as plain numbers. */
async function stagedIds(tableName: string): Promise<number[]> {
  const result = await instance.query(`SELECT id FROM ${tableName} ORDER BY id`);
  return result.rows.map((row) => Number(row.id));
}

describe('canvas · spillover into DuckDB', () => {
  it('stages every row of an async source, the preview included, in source order', async () => {
    const result = await spillover({
      canvas: instance,
      source: pagedSource(240),
      previewChars: 200,
      tableName: 'spill_all',
    });

    expect(result.spilled).toBe(true);
    if (!result.spilled) return;
    expect(result.truncated).toBe(false);
    expect(result.handle).toEqual({
      tableName: 'spill_all',
      rowCount: 240,
      columns: ['id', 'label'],
    });
    expect(result.previewRows.length).toBeGreaterThan(0);
    expect(result.previewRows).toEqual(
      Array.from({ length: result.previewRows.length }, (_, id) => ({ id, label: `item-${id}` })),
    );
    expect(await stagedIds('spill_all')).toEqual(Array.from({ length: 240 }, (_, id) => id));
    const labels = await instance.query(
      "SELECT count(*) AS n FROM spill_all WHERE label = 'item-' || CAST(id AS VARCHAR)",
    );
    expect(labels.rows).toEqual([{ n: '240' }]);
  });

  it('stops the staged table at exactly caps.maxRows and reports the truncation', async () => {
    const result = await spillover({
      canvas: instance,
      source: pagedSource(240),
      previewChars: 200,
      caps: { maxRows: 60 },
      tableName: 'spill_capped',
    });

    expect(result.spilled).toBe(true);
    if (!result.spilled) return;
    expect(result.truncated).toBe(true);
    expect(result.handle.rowCount).toBe(60);
    expect(await stagedIds('spill_capped')).toEqual(Array.from({ length: 60 }, (_, id) => id));
  });

  it('refuses an async source registered without a schema before creating a table', async () => {
    const failure = await instance.registerTable('no_schema', pagedSource(5)).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(McpError);
    expect((failure as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
    expect((failure as McpError).data).toMatchObject({
      reason: 'async_iterable_requires_schema',
      tableName: 'no_schema',
    });
    expect(await instance.describe({ tableName: 'no_schema' })).toEqual([]);
  });
});

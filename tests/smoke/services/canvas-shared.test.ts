/**
 * @fileoverview `DataCanvas.acquireShared` against a real DuckDB instance, with
 * every call's `ctx.state` over one store as concurrent requests to one server
 * have: five concurrent first stagings converge on one canvas whose every
 * table is queryable through the stored id, and with the stored canvas gone, a
 * purge in `onReplace` leaves exactly the records the new stagings wrote.
 * @module tests/smoke/services/canvas-shared.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type Context, createContextState } from '@/core/context.js';
import { CanvasRegistry } from '@/services/canvas/core/CanvasRegistry.js';
import { DataCanvas } from '@/services/canvas/core/DataCanvas.js';
import { DuckdbProvider } from '@/services/canvas/providers/duckdb/DuckdbProvider.js';
import type { StorageService } from '@/storage/core/StorageService.js';
import { createInMemoryStorage, createMockContext } from '@/testing/index.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

const TENANT = 'smoke-tenant';
const tenantCtx: RequestContext = {
  requestId: 'smoke-canvas-shared',
  timestamp: '2026-01-01T00:00:00.000Z',
  tenantId: TENANT,
};

describe('canvas · acquireShared on DuckDB (#598)', () => {
  let exportRoot: string;
  let provider: DuckdbProvider;
  let canvas: DataCanvas;
  let storage: StorageService;

  /**
   * A request context whose `ctx.state` runs over the shared store.
   * `createMockContext` alone gives every context its own.
   */
  function sharedCtx(requestId: string): Context {
    const base = createMockContext({ requestId, tenantId: TENANT });
    return {
      ...base,
      state: createContextState(
        storage,
        { requestId, timestamp: base.timestamp, tenantId: TENANT },
        base.signal,
      ),
    };
  }

  beforeAll(async () => {
    exportRoot = await mkdtemp(join(tmpdir(), 'canvas-shared-smoke-'));
  });

  beforeEach(() => {
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
    storage = createInMemoryStorage();
  });

  afterEach(async () => {
    await canvas.shutdown(tenantCtx);
  });

  afterAll(async () => {
    await rm(exportRoot, { recursive: true, force: true });
  });

  it('five concurrent first stagings converge on one canvas, every table reachable', async () => {
    const registerTable = vi.spyOn(provider, 'registerTable');
    const ctxs = Array.from({ length: 5 }, (_, i) => sharedCtx(`stage-${i}`));

    const staged = await Promise.all(
      ctxs.map(async (ctx, i) => {
        const instance = await canvas.acquireShared(ctx);
        await instance.registerTable(`df_${i}`, [
          { id: 1, v: 0.5 },
          { id: 2, v: 0.7 },
        ]);
        return instance;
      }),
    );

    const canvasId = staged[0]!.canvasId;
    expect(staged.every((instance) => instance.canvasId === canvasId)).toBe(true);
    expect(staged.filter((instance) => instance.isNew)).toHaveLength(1);
    expect(canvas.countForTenant(tenantCtx)).toBe(1);
    for (const [i, ctx] of ctxs.entries()) {
      expect(registerTable).toHaveBeenCalledWith(
        canvasId,
        `df_${i}`,
        expect.anything(),
        ctx,
        undefined,
      );
    }

    const reader = sharedCtx('query');
    const stored = await reader.state.get<string>('canvas-id');
    expect(stored).toBe(canvasId);
    const instance = await canvas.acquire(stored!, reader);
    for (let i = 0; i < 5; i += 1) {
      const result = await instance.query(`SELECT count(*) AS n FROM df_${i}`);
      expect(result.rows).toEqual([{ n: '2' }]);
    }
  });

  it('a purge in onReplace leaves exactly the records the new stagings wrote', async () => {
    const seedCtx = sharedCtx('seed');
    const seed = await canvas.acquireShared(seedCtx);
    await seed.registerTable('df_old', [{ id: 1 }]);
    await seedCtx.state.set('df-meta/df_old', { canvasId: seed.canvasId });
    await canvas.drop(seed.canvasId, tenantCtx);

    /** Deletes every `df-meta/` record the store lists. */
    async function purge(ctx: Context): Promise<void> {
      const page = await ctx.state.list('df-meta/');
      await ctx.state.deleteMany(page.items.map((item) => item.key));
    }

    const names = ['df_c0', 'df_c1', 'df_c2', 'df_c3', 'df_c4'];
    const staged = await Promise.all(
      names.map(async (name) => {
        const ctx = sharedCtx(name);
        const instance = await canvas.acquireShared(ctx, { onReplace: () => purge(ctx) });
        await instance.registerTable(name, [{ id: 1 }]);
        await ctx.state.set(`df-meta/${name}`, { canvasId: instance.canvasId });
        return instance;
      }),
    );

    expect(new Set(staged.map((instance) => instance.canvasId)).size).toBe(1);
    expect(staged[0]!.canvasId).not.toBe(seed.canvasId);
    const page = await sharedCtx('list').state.list('df-meta/');
    expect(page.items.map((item) => item.key).sort()).toEqual(
      names.map((name) => `df-meta/${name}`),
    );

    // The stale table went with its canvas; the new one holds only the new tables.
    const tables = await staged[0]!.describe();
    expect(tables.map((table) => table.name).sort()).toEqual(names);
    await expect(staged[0]!.query('SELECT * FROM df_old')).rejects.toMatchObject({
      data: { reason: 'missing_table' },
    });
  });
});

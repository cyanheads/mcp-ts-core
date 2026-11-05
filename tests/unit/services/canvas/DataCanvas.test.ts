/**
 * @fileoverview Tests for the DataCanvas service wrapper and CanvasInstance
 * handle. These exercise the public API consumers actually use, with a stub
 * provider so the suite runs without `@duckdb/node-api`. Verifies tenant-id
 * enforcement, registry delegation, the touch-or-throw gate before every
 * operation, the expiresAt mutation that slides the TTL window, and the
 * serialized shared-canvas acquire.
 * @module tests/unit/canvas/DataCanvas.test
 */

import { describe, expect, it, vi } from 'vitest';

import { type Context, type ContextState, createContextState } from '@/core/context.js';
import { CanvasInstance } from '@/services/canvas/core/CanvasInstance.js';
import {
  CanvasRegistry,
  type CanvasRegistryOptions,
} from '@/services/canvas/core/CanvasRegistry.js';
import { DataCanvas } from '@/services/canvas/core/DataCanvas.js';
import type { IDataCanvasProvider } from '@/services/canvas/core/IDataCanvasProvider.js';
import type { StorageService } from '@/storage/core/StorageService.js';
import { createInMemoryStorage, createMockContext } from '@/testing/index.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

function makeStubProvider() {
  return {
    name: 'stub',
    initCanvas: vi.fn(async () => undefined),
    destroyCanvas: vi.fn(async () => undefined),
    registerTable: vi.fn(async () => ({ tableName: 't', rowCount: 0, columns: [] })),
    registerView: vi.fn(async () => ({ viewName: 'v', columns: [] })),
    importFrom: vi.fn(async () => ({ tableName: 'imported', rowCount: 0, columns: [] })),
    query: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0 })),
    export: vi.fn(async () => ({ format: 'csv' as const, rowCount: 0, sizeBytes: 0 })),
    describe: vi.fn(async () => []),
    drop: vi.fn(async () => true),
    clear: vi.fn(async () => 0),
    healthCheck: vi.fn(async () => true),
    shutdown: vi.fn(async () => undefined),
  } as unknown as IDataCanvasProvider & {
    initCanvas: ReturnType<typeof vi.fn>;
    destroyCanvas: ReturnType<typeof vi.fn>;
    registerTable: ReturnType<typeof vi.fn>;
    registerView: ReturnType<typeof vi.fn>;
    importFrom: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    export: ReturnType<typeof vi.fn>;
    describe: ReturnType<typeof vi.fn>;
    drop: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    healthCheck: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
  };
}

const TTL = 24 * 60 * 60 * 1000;

function makeOptions(overrides: Partial<CanvasRegistryOptions> = {}): CanvasRegistryOptions {
  return {
    ttlMs: TTL,
    absoluteCapMs: 7 * 24 * 60 * 60 * 1000,
    maxCanvasesPerTenant: 100,
    sweeperIntervalMs: 0,
    ...overrides,
  };
}

const ctxWithTenant: RequestContext = {
  requestId: 'test-req',
  timestamp: '2026-01-01T00:00:00.000Z',
  tenantId: 'tenant-a',
};

const ctxNoTenant: RequestContext = {
  requestId: 'test-req',
  timestamp: '2026-01-01T00:00:00.000Z',
};

describe('DataCanvas · acquire', () => {
  it('throws when context has no tenantId', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    const canvas = new DataCanvas(provider, registry);
    let caught: unknown;
    try {
      await canvas.acquire(undefined, ctxNoTenant);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).code).toBe(JsonRpcErrorCode.InternalError);
    expect((caught as McpError).message).toMatch(/Tenant ID is required/);
    // #548 — request metadata stays out of the client-visible data.
    expect((caught as McpError).data).toBeUndefined();
    await registry.shutdown(ctxWithTenant);
  });

  it('throws when tenantId is an empty string (distinct branch from undefined/null)', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    const canvas = new DataCanvas(provider, registry);
    const ctxEmptyTenant: RequestContext = {
      requestId: 'test-req',
      timestamp: '2026-01-01T00:00:00.000Z',
      tenantId: '',
    };
    let caught: unknown;
    try {
      await canvas.acquire(undefined, ctxEmptyTenant);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).message).toMatch(/Tenant ID is required/);
    await registry.shutdown(ctxWithTenant);
  });

  it('returns a CanvasInstance with canvasId, tenantId, isNew=true, and expiresAt', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), () => 1_000_000);
    const canvas = new DataCanvas(provider, registry);
    const instance = await canvas.acquire(undefined, ctxWithTenant);
    expect(instance).toBeInstanceOf(CanvasInstance);
    expect(instance.canvasId).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(instance.tenantId).toBe('tenant-a');
    expect(instance.isNew).toBe(true);
    expect(new Date(instance.expiresAt).getTime()).toBe(1_000_000 + TTL);
    expect(provider.initCanvas).toHaveBeenCalledWith(instance.canvasId, expect.any(Object));
    await registry.shutdown(ctxWithTenant);
  });

  it('returns isNew=false when re-acquiring an existing canvas', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    const canvas = new DataCanvas(provider, registry);
    const first = await canvas.acquire(undefined, ctxWithTenant);
    const second = await canvas.acquire(first.canvasId, ctxWithTenant);
    expect(second.canvasId).toBe(first.canvasId);
    expect(second.isNew).toBe(false);
    await registry.shutdown(ctxWithTenant);
  });

  it('rejects a pre-aborted acquire without allocating provider or registry state', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    const canvas = new DataCanvas(provider, registry);
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(
      canvas.acquire(undefined, ctxWithTenant, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider.initCanvas).not.toHaveBeenCalled();
    expect(canvas.countForTenant(ctxWithTenant)).toBe(0);
    await registry.shutdown(ctxWithTenant);
  });
});

describe('DataCanvas · drop / countForTenant / healthCheck / shutdown', () => {
  it('drop throws when tenantId is missing and forwards otherwise', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    const canvas = new DataCanvas(provider, registry);
    const instance = await canvas.acquire(undefined, ctxWithTenant);

    await expect(canvas.drop(instance.canvasId, ctxNoTenant)).rejects.toThrow(/Tenant ID/);
    await expect(canvas.drop(instance.canvasId, ctxWithTenant)).resolves.toBe(true);
    expect(provider.destroyCanvas).toHaveBeenCalledWith(instance.canvasId, expect.any(Object));
    await registry.shutdown(ctxWithTenant);
  });

  it('countForTenant throws when tenantId missing and reports active count otherwise', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    const canvas = new DataCanvas(provider, registry);
    expect(() => canvas.countForTenant(ctxNoTenant)).toThrow(/Tenant ID/);
    await canvas.acquire(undefined, ctxWithTenant);
    await canvas.acquire(undefined, ctxWithTenant);
    expect(canvas.countForTenant(ctxWithTenant)).toBe(2);
    await registry.shutdown(ctxWithTenant);
  });

  // Issue #748 — the capacity hint names no drop tool because most consumer drop
  // tools drop one table, and only destroying the canvas releases its slot.
  it('frees a tenant cap slot only through DataCanvas.drop, never a table drop or clear', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions({ maxCanvasesPerTenant: 1 }));
    const canvas = new DataCanvas(provider, registry);
    const instance = await canvas.acquire(undefined, ctxWithTenant);
    await instance.registerTable('df_x', [{ v: 1 }]);

    await expect(instance.drop('df_x')).resolves.toBe(true);
    await expect(canvas.acquire(undefined, ctxWithTenant)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'canvas_capacity_exhausted' },
    });
    await instance.clear();
    expect(canvas.countForTenant(ctxWithTenant)).toBe(1);
    await expect(canvas.acquire(undefined, ctxWithTenant)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
    });

    await expect(canvas.drop(instance.canvasId, ctxWithTenant)).resolves.toBe(true);
    expect(canvas.countForTenant(ctxWithTenant)).toBe(0);
    await expect(canvas.acquire(undefined, ctxWithTenant)).resolves.toMatchObject({ isNew: true });
    await registry.shutdown(ctxWithTenant);
  });

  it("healthCheck reports the provider's verdict, an unhealthy one included", async () => {
    const provider = makeStubProvider();
    provider.healthCheck.mockResolvedValueOnce(false);
    const registry = new CanvasRegistry(provider, makeOptions());
    const canvas = new DataCanvas(provider, registry);
    await expect(canvas.healthCheck()).resolves.toBe(false);
    expect(provider.healthCheck).toHaveBeenCalledTimes(1);
    await registry.shutdown(ctxWithTenant);
  });

  it('shutdown tears down the registry and provider', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    const canvas = new DataCanvas(provider, registry);
    await canvas.acquire(undefined, ctxWithTenant);
    await canvas.shutdown(ctxWithTenant);
    expect(provider.destroyCanvas).toHaveBeenCalled();
    expect(provider.shutdown).toHaveBeenCalled();
  });

  it('getProvider returns the underlying provider', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    const canvas = new DataCanvas(provider, registry);
    expect(canvas.getProvider()).toBe(provider);
    await registry.shutdown(ctxWithTenant);
  });
});

// Issue #327 — the three entry points that take a caller-supplied id. Each one
// read as "not found or expired" before, which is advice no caller can act on
// for a value no tool ever minted.
describe('caller-supplied ids · malformed vs missing (#327)', () => {
  /**
   * Pins the ValidationError contract a malformed id produces, taking the call
   * rather than a caught value: a handler attached with `.catch` never runs when
   * the call resolves, and resolving is exactly what `drop` did for a malformed
   * id before this — so the assertion has to see the settled outcome either way.
   */
  async function expectMalformed(call: Promise<unknown>): Promise<void> {
    const caught = await call.catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(McpError);
    const err = caught as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect((err.data as { reason?: string }).reason).toBe('canvas_id_malformed');
  }

  it('acquire rejects a malformed id and keeps NotFound for a missing one', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    const canvas = new DataCanvas(provider, registry);

    await expectMalformed(canvas.acquire('x', ctxWithTenant));
    await expect(canvas.acquire('AAAAAAAAAA', ctxWithTenant)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
    await registry.shutdown(ctxWithTenant);
  });

  it('drop rejects a malformed id instead of reporting a silent miss', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    const canvas = new DataCanvas(provider, registry);

    await expectMalformed(canvas.drop('x', ctxWithTenant));
    // A well-formed id that simply is not there stays a `false`, not a throw.
    await expect(canvas.drop('AAAAAAAAAA', ctxWithTenant)).resolves.toBe(false);
    await registry.shutdown(ctxWithTenant);
  });

  it('importFrom rejects a malformed source id before the provider is reached', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    const canvas = new DataCanvas(provider, registry);
    const dest = await canvas.acquire(undefined, ctxWithTenant);

    await expectMalformed(dest.importFrom('x', 'rows'));
    expect(provider.importFrom).not.toHaveBeenCalled();
    await registry.shutdown(ctxWithTenant);
  });

  /** Asserts `importFrom` reports a lookup miss on a live destination canvas. */
  async function expectSourceNotFound(dest: CanvasInstance, sourceId: string): Promise<void> {
    let caught: unknown;
    try {
      await dest.importFrom(sourceId, 'rows');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect(((caught as McpError).data as { reason?: string }).reason).toBe('canvas_not_found');
  }

  it('importFrom keeps NotFound for a well-formed source id that was never minted', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    const canvas = new DataCanvas(provider, registry);
    const dest = await canvas.acquire(undefined, ctxWithTenant);

    await expectSourceNotFound(dest, 'AAAAAAAAAA');
    await registry.shutdown(ctxWithTenant);
  });

  it('importFrom keeps NotFound for an expired source id', async () => {
    const provider = makeStubProvider();
    const clock = vi.fn(() => 1_000_000);
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const canvas = new DataCanvas(provider, registry);

    // The source is minted half a TTL ahead of the destination, so the clock
    // can pass the source's window while the destination is still live.
    const source = await canvas.acquire(undefined, ctxWithTenant);
    clock.mockReturnValue(1_000_000 + TTL / 2);
    const dest = await canvas.acquire(undefined, ctxWithTenant);
    clock.mockReturnValue(1_000_000 + TTL + 1);

    await expectSourceNotFound(dest, source.canvasId);
    await registry.shutdown(ctxWithTenant);
  });

  it('importFrom keeps NotFound for a source id owned by another tenant', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    const canvas = new DataCanvas(provider, registry);
    const foreign = await canvas.acquire(undefined, { ...ctxWithTenant, tenantId: 'tenant-b' });
    const dest = await canvas.acquire(undefined, ctxWithTenant);

    await expectSourceNotFound(dest, foreign.canvasId);
    expect(provider.importFrom).not.toHaveBeenCalled();
    await registry.shutdown(ctxWithTenant);
  });
});

describe('CanvasInstance · per-table TTL', () => {
  it('registerTable with ttlMs: describe returns expiresAt for that table', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const canvas = new DataCanvas(provider, registry);
    const instance = await canvas.acquire(undefined, ctxWithTenant);

    const TABLE_TTL = 5 * 60 * 1000;
    await instance.registerTable('my_table', [], { ttlMs: TABLE_TTL });

    // Stub describe to return a table entry
    provider.describe.mockResolvedValueOnce([
      { name: 'my_table', kind: 'table', rowCount: 0, columns: [] },
    ]);

    const result = await instance.describe();
    expect(result[0]?.expiresAt).toBe(new Date(1_000_000 + TABLE_TTL).toISOString());
    await registry.shutdown(ctxWithTenant);
  });

  it('registerTable without ttlMs: describe returns no expiresAt', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const canvas = new DataCanvas(provider, registry);
    const instance = await canvas.acquire(undefined, ctxWithTenant);

    await instance.registerTable('plain_table', []);

    provider.describe.mockResolvedValueOnce([
      { name: 'plain_table', kind: 'table', rowCount: 0, columns: [] },
    ]);

    const result = await instance.describe();
    expect(result[0]?.expiresAt).toBeUndefined();
    await registry.shutdown(ctxWithTenant);
  });

  it('query({ registerAs, ttlMs }) registers TTL for the materialized table', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const canvas = new DataCanvas(provider, registry);
    const instance = await canvas.acquire(undefined, ctxWithTenant);

    const TABLE_TTL = 3 * 60 * 1000;
    await instance.query('SELECT 1', { registerAs: 'result_table', ttlMs: TABLE_TTL });

    provider.describe.mockResolvedValueOnce([
      { name: 'result_table', kind: 'table', rowCount: 0, columns: [] },
    ]);

    const described = await instance.describe();
    expect(described[0]?.expiresAt).toBe(new Date(1_000_000 + TABLE_TTL).toISOString());
    await registry.shutdown(ctxWithTenant);
  });

  it('query({ registerAs }) without ttlMs: no expiresAt on the materialized table', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const canvas = new DataCanvas(provider, registry);
    const instance = await canvas.acquire(undefined, ctxWithTenant);

    await instance.query('SELECT 1', { registerAs: 'result_table' });

    provider.describe.mockResolvedValueOnce([
      { name: 'result_table', kind: 'table', rowCount: 0, columns: [] },
    ]);

    const described = await instance.describe();
    expect(described[0]?.expiresAt).toBeUndefined();
    await registry.shutdown(ctxWithTenant);
  });

  it('drop clears per-table TTL bookkeeping', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const canvas = new DataCanvas(provider, registry);
    const instance = await canvas.acquire(undefined, ctxWithTenant);

    await instance.registerTable('temp_table', [], { ttlMs: 60_000 });
    await instance.drop('temp_table');

    provider.describe.mockResolvedValueOnce([
      { name: 'temp_table', kind: 'table', rowCount: 0, columns: [] },
    ]);

    const described = await instance.describe();
    expect(described[0]?.expiresAt).toBeUndefined();
    await registry.shutdown(ctxWithTenant);
  });

  it('re-registering without ttlMs clears the prior per-table TTL (replace semantics)', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const canvas = new DataCanvas(provider, registry);
    const instance = await canvas.acquire(undefined, ctxWithTenant);

    await instance.registerTable('my_table', [], { ttlMs: 60_000 });
    await instance.registerTable('my_table', []); // replace — no ttlMs

    provider.describe.mockResolvedValueOnce([
      { name: 'my_table', kind: 'table', rowCount: 0, columns: [] },
    ]);

    const described = await instance.describe();
    expect(described[0]?.expiresAt).toBeUndefined();
    await registry.shutdown(ctxWithTenant);
  });

  it('export slides the per-table TTL of the exported table', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const canvas = new DataCanvas(provider, registry);
    const instance = await canvas.acquire(undefined, ctxWithTenant);

    const TABLE_TTL = 5 * 60 * 1000;
    await instance.registerTable('my_table', [], { ttlMs: TABLE_TTL });

    clock.mockReturnValue(2_000_000);
    await instance.export('my_table', { kind: 'path', path: '/tmp/out.csv' } as never);

    provider.describe.mockResolvedValueOnce([
      { name: 'my_table', kind: 'table', rowCount: 0, columns: [] },
    ]);
    const described = await instance.describe();
    expect(described[0]?.expiresAt).toBe(new Date(2_000_000 + TABLE_TTL).toISOString());
    await registry.shutdown(ctxWithTenant);
  });

  it('importFrom clears stale per-table TTL on the replaced destination table', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const canvas = new DataCanvas(provider, registry);
    const source = await canvas.acquire(undefined, ctxWithTenant);
    const dest = await canvas.acquire(undefined, ctxWithTenant);

    await source.registerTable('shared_name', []);
    await dest.registerTable('shared_name', [], { ttlMs: 60_000 });
    await dest.importFrom(source.canvasId, 'shared_name');

    provider.describe.mockResolvedValueOnce([
      { name: 'shared_name', kind: 'table', rowCount: 0, columns: [] },
    ]);
    const described = await dest.describe();
    expect(described[0]?.expiresAt).toBeUndefined();
    await registry.shutdown(ctxWithTenant);
  });
});

describe('CanvasInstance · touch-or-throw + delegation', () => {
  it('every op slides expiresAt and forwards to the provider', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const canvas = new DataCanvas(provider, registry);
    const instance = await canvas.acquire(undefined, ctxWithTenant);
    const initialExpiry = new Date(instance.expiresAt).getTime();

    clock.mockReturnValue(1_000_000 + 60_000);
    await instance.registerTable('t', [{ x: 1 }]);
    expect(provider.registerTable).toHaveBeenCalled();
    expect(new Date(instance.expiresAt).getTime()).toBe(1_000_000 + 60_000 + TTL);
    expect(new Date(instance.expiresAt).getTime()).toBeGreaterThan(initialExpiry);

    clock.mockReturnValue(1_000_000 + 120_000);
    await instance.query('SELECT 1');
    expect(provider.query).toHaveBeenCalled();
    expect(new Date(instance.expiresAt).getTime()).toBe(1_000_000 + 120_000 + TTL);

    clock.mockReturnValue(1_000_000 + 180_000);
    await instance.export('t', { format: 'csv', path: 'x.csv' });
    expect(provider.export).toHaveBeenCalled();

    clock.mockReturnValue(1_000_000 + 240_000);
    await instance.describe();
    expect(provider.describe).toHaveBeenCalled();

    clock.mockReturnValue(1_000_000 + 300_000);
    await instance.drop('t');
    expect(provider.drop).toHaveBeenCalled();

    clock.mockReturnValue(1_000_000 + 360_000);
    await instance.clear();
    expect(provider.clear).toHaveBeenCalled();

    await registry.shutdown(ctxWithTenant);
  });

  it('registerView slides expiresAt and forwards to the provider', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const canvas = new DataCanvas(provider, registry);
    const instance = await canvas.acquire(undefined, ctxWithTenant);

    clock.mockReturnValue(1_000_000 + 30_000);
    await instance.registerView('v', 'SELECT 1');
    expect(provider.registerView).toHaveBeenCalledWith(
      instance.canvasId,
      'v',
      'SELECT 1',
      expect.any(Object),
      undefined,
    );
    expect(new Date(instance.expiresAt).getTime()).toBe(1_000_000 + 30_000 + TTL);

    await registry.shutdown(ctxWithTenant);
  });

  it('importFrom touches both canvases and forwards to the provider', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const canvas = new DataCanvas(provider, registry);
    const target = await canvas.acquire(undefined, ctxWithTenant);
    const source = await canvas.acquire(undefined, ctxWithTenant);

    clock.mockReturnValue(1_000_000 + 60_000);
    await target.importFrom(source.canvasId, 'src');
    expect(provider.importFrom).toHaveBeenCalledWith(
      target.canvasId,
      source.canvasId,
      'src',
      'src',
      expect.any(Object),
      undefined,
    );
    expect(new Date(target.expiresAt).getTime()).toBe(1_000_000 + 60_000 + TTL);

    // Repeat with explicit asName.
    await target.importFrom(source.canvasId, 'src', { asName: 'renamed' });
    expect(provider.importFrom).toHaveBeenLastCalledWith(
      target.canvasId,
      source.canvasId,
      'src',
      'renamed',
      expect.any(Object),
      { asName: 'renamed' },
    );

    await registry.shutdown(ctxWithTenant);
  });

  it('throws NotFound from any op when the canvas has expired', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const canvas = new DataCanvas(provider, registry);
    const instance = await canvas.acquire(undefined, ctxWithTenant);

    // Walk past the sliding TTL with no touches.
    clock.mockReturnValue(1_000_000 + TTL + 1);

    await expect(instance.registerTable('t', [{ x: 1 }])).rejects.toThrow(/not found or expired/i);
    await expect(instance.registerView('v', 'SELECT 1')).rejects.toThrow(/not found or expired/i);
    await expect(instance.query('SELECT 1')).rejects.toThrow(/not found or expired/i);
    await expect(instance.export('t', { format: 'csv', path: 'x.csv' })).rejects.toThrow(
      /not found or expired/i,
    );
    await expect(instance.describe()).rejects.toThrow(/not found or expired/i);
    await expect(instance.drop('t')).rejects.toThrow(/not found or expired/i);
    await expect(instance.clear()).rejects.toThrow(/not found or expired/i);

    // Provider methods must not have been invoked once touch-or-throw rejected.
    expect(provider.registerTable).not.toHaveBeenCalled();
    expect(provider.registerView).not.toHaveBeenCalled();
    expect(provider.query).not.toHaveBeenCalled();
    expect(provider.export).not.toHaveBeenCalled();

    await registry.shutdown(ctxWithTenant);
  });
});

// Issue #598 — servers that keep one canvas per tenant in `ctx.state` minted one
// canvas per concurrent first call, stranding the tables the others staged.
describe('DataCanvas · acquireShared (#598)', () => {
  function setup(overrides: Partial<CanvasRegistryOptions> = {}, clock?: () => number) {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(overrides), clock);
    return {
      provider,
      registry,
      canvas: new DataCanvas(provider, registry),
      storage: createInMemoryStorage(),
    };
  }

  /**
   * A request context on tenant-a whose `ctx.state` runs over `storage`.
   * `createMockContext` gives every context its own store; concurrent requests
   * to one server share one, which is the case under test.
   */
  function sharedCtx(storage: StorageService, signal = new AbortController().signal): Context {
    const base = createMockContext({ signal, tenantId: 'tenant-a' });
    const state = createContextState(
      storage,
      { requestId: base.requestId, timestamp: base.timestamp, tenantId: 'tenant-a' },
      signal,
    );
    return { ...base, state };
  }

  /** `ctx` with some `ctx.state` methods replaced. */
  function withState(ctx: Context, patch: Partial<ContextState>): Context {
    return { ...ctx, state: { ...ctx.state, ...patch } };
  }

  /** Lets every pending microtask, and the work it queues, run. */
  const loopTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

  /** Reports whether `promise` has settled, without leaving a rejection unhandled. */
  function track(promise: Promise<unknown>): () => boolean {
    let settled = false;
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    return () => settled;
  }

  /**
   * Keys with a shared-canvas resolution queued or running. The lock map must
   * empty once every call settles; no public surface reports its size, so the
   * test reads the private field.
   */
  function lockEntries(canvas: DataCanvas): number {
    return (Reflect.get(canvas, 'sharedQueues') as Map<string, unknown>).size;
  }

  const storedId = (storage: StorageService, key = 'canvas-id') =>
    sharedCtx(storage).state.get(key);

  it("converges concurrent first calls on one canvas, each bound to its caller's ctx", async () => {
    const { provider, registry, canvas, storage } = setup();
    const ctxs = Array.from({ length: 5 }, () => sharedCtx(storage));
    const onReplace = vi.fn();

    const instances = await Promise.all(
      ctxs.map((ctx) => canvas.acquireShared(ctx, { onReplace })),
    );

    const canvasId = instances[0]!.canvasId;
    expect(instances.every((instance) => instance.canvasId === canvasId)).toBe(true);
    expect(instances.filter((instance) => instance.isNew)).toHaveLength(1);
    expect(canvas.countForTenant(ctxWithTenant)).toBe(1);
    expect(onReplace).toHaveBeenCalledTimes(1);
    expect(onReplace).toHaveBeenCalledWith(undefined);
    expect(await storedId(storage)).toBe(canvasId);

    await Promise.all(
      instances.map((instance, i) => instance.registerTable(`df_${i}`, [{ v: i }])),
    );
    for (const [i, ctx] of ctxs.entries()) {
      expect(provider.registerTable).toHaveBeenCalledWith(
        canvasId,
        `df_${i}`,
        [{ v: i }],
        ctx,
        undefined,
      );
    }
    expect(lockEntries(canvas)).toBe(0);
    await registry.shutdown(ctxWithTenant);
  });

  it('resolves a live stored id while a resolution for the same key holds the lock', async () => {
    const { registry, canvas, storage } = setup();
    const gate = Promise.withResolvers<void>();
    const holder = canvas.acquireShared(sharedCtx(storage), { onReplace: () => gate.promise });
    await loopTurn();
    const live = await canvas.acquire(undefined, ctxWithTenant);
    await sharedCtx(storage).state.set('canvas-id', live.canvasId);

    const fast = canvas.acquireShared(sharedCtx(storage));
    const fastSettled = track(fast);
    await loopTurn();

    expect(fastSettled()).toBe(true);
    await expect(fast).resolves.toMatchObject({ canvasId: live.canvasId, isNew: false });
    gate.resolve();
    await holder;
    await registry.shutdown(ctxWithTenant);
  });

  it('replaces an empty slot, a canvas_not_found id, and a value that is not a canvas id', async () => {
    const { registry, canvas, storage } = setup();
    const onReplace = vi.fn();

    const first = await canvas.acquireShared(sharedCtx(storage), { onReplace });
    expect(onReplace).toHaveBeenLastCalledWith(undefined);
    expect(first.isNew).toBe(true);

    await canvas.drop(first.canvasId, ctxWithTenant);
    const second = await canvas.acquireShared(sharedCtx(storage), { onReplace });
    expect(onReplace).toHaveBeenLastCalledWith(first.canvasId);
    expect(second.canvasId).not.toBe(first.canvasId);
    expect(await storedId(storage)).toBe(second.canvasId);

    for (const value of ['not-an-id', { canvasId: second.canvasId }]) {
      await sharedCtx(storage).state.set('canvas-id', value);
      const replaced = await canvas.acquireShared(sharedCtx(storage), { onReplace });
      expect(onReplace).toHaveBeenLastCalledWith(undefined);
      expect(replaced.isNew).toBe(true);
      expect(await storedId(storage)).toBe(replaced.canvasId);
    }
    expect(onReplace).toHaveBeenCalledTimes(4);
    await registry.shutdown(ctxWithTenant);
  });

  it('propagates a cancellation or a registry shutdown with the stored id unchanged', async () => {
    const { canvas, storage } = setup();
    const live = await canvas.acquireShared(sharedCtx(storage));
    const onReplace = vi.fn();

    // The abort lands after the stored id is read, so it reaches the registry
    // lookup rather than `ctx.state`.
    const controller = new AbortController();
    const ctx = sharedCtx(storage, controller.signal);
    const readThenAbort = withState(ctx, {
      get: (async (key: string) => {
        const value = await ctx.state.get(key);
        controller.abort();
        return value;
      }) as ContextState['get'],
    });
    await expect(canvas.acquireShared(readThenAbort, { onReplace })).rejects.toMatchObject({
      name: 'AbortError',
    });

    await canvas.shutdown(ctxWithTenant);
    await expect(canvas.acquireShared(sharedCtx(storage), { onReplace })).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringMatching(/shutting down/),
    });

    expect(onReplace).not.toHaveBeenCalled();
    expect(await storedId(storage)).toBe(live.canvasId);
    expect(lockEntries(canvas)).toBe(0);
  });

  it('lets no caller obtain the new canvas before onReplace settles', async () => {
    const { registry, canvas, storage } = setup();
    const gate = Promise.withResolvers<void>();
    const onReplace = vi.fn(() => gate.promise);

    const calls = Array.from({ length: 4 }, () =>
      canvas.acquireShared(sharedCtx(storage), { onReplace }),
    );
    const settled = calls.map(track);
    await loopTurn();

    expect(onReplace).toHaveBeenCalledTimes(1);
    expect(settled.some((isSettled) => isSettled())).toBe(false);
    expect(canvas.countForTenant(ctxWithTenant)).toBe(0);

    gate.resolve();
    const instances = await Promise.all(calls);
    expect(new Set(instances.map((instance) => instance.canvasId)).size).toBe(1);
    expect(onReplace).toHaveBeenCalledTimes(1);
    await registry.shutdown(ctxWithTenant);
  });

  it('purges stale records in onReplace without touching records written for the new canvas', async () => {
    const { registry, canvas, storage } = setup();
    const seed = await canvas.acquireShared(sharedCtx(storage));
    await sharedCtx(storage).state.set('df-meta/df_old', { canvasId: seed.canvasId });
    await canvas.drop(seed.canvasId, ctxWithTenant);

    /** Deletes every `df-meta/` record; listing yields first, as a remote store's round trip does. */
    async function purge(ctx: Context): Promise<void> {
      await loopTurn();
      const page = await ctx.state.list('df-meta/');
      await ctx.state.deleteMany(page.items.map((item) => item.key));
    }

    const names = ['df_c0', 'df_c1', 'df_c2', 'df_c3', 'df_c4'];
    await Promise.all(
      names.map(async (name) => {
        const ctx = sharedCtx(storage);
        const instance = await canvas.acquireShared(ctx, { onReplace: () => purge(ctx) });
        await instance.registerTable(name, [{ v: 1 }]);
        await ctx.state.set(`df-meta/${name}`, { canvasId: instance.canvasId });
      }),
    );

    const page = await sharedCtx(storage).state.list('df-meta/');
    expect(page.items.map((item) => item.key).sort()).toEqual(
      names.map((name) => `df-meta/${name}`),
    );
    await registry.shutdown(ctxWithTenant);
  });

  it('keeps the stored id when onReplace throws, and the next waiter runs its own resolution', async () => {
    const { registry, canvas, storage } = setup();
    const seed = await canvas.acquireShared(sharedCtx(storage));
    await canvas.drop(seed.canvasId, ctxWithTenant);

    const gate = Promise.withResolvers<void>();
    const failure = new Error('purge failed');
    const seen: Array<string | undefined> = [];
    const storedWhenRerun: unknown[] = [];
    const onReplace = vi.fn(async (previousId: string | undefined) => {
      seen.push(previousId);
      if (seen.length === 1) {
        await gate.promise;
        throw failure;
      }
      storedWhenRerun.push(await storedId(storage));
    });

    const calls = [
      canvas.acquireShared(sharedCtx(storage), { onReplace }),
      canvas.acquireShared(sharedCtx(storage), { onReplace }),
    ];
    await loopTurn();
    gate.resolve();
    const [a, b] = await Promise.allSettled(calls);

    const outcomes = [a, b].map((result) => result?.status).sort();
    expect(outcomes).toEqual(['fulfilled', 'rejected']);
    const rejected = [a, b].find(
      (result) => result?.status === 'rejected',
    ) as PromiseRejectedResult;
    const fulfilled = [a, b].find(
      (result) => result?.status === 'fulfilled',
    ) as PromiseFulfilledResult<CanvasInstance>;
    expect(rejected.reason).toBe(failure);
    expect(seen).toEqual([seed.canvasId, seed.canvasId]);
    expect(storedWhenRerun).toEqual([seed.canvasId]);
    expect(canvas.countForTenant(ctxWithTenant)).toBe(1);
    expect(await storedId(storage)).toBe(fulfilled.value.canvasId);
    expect(lockEntries(canvas)).toBe(0);
    await registry.shutdown(ctxWithTenant);
  });

  it('with create: false, returns the live canvas or undefined and never mints', async () => {
    const { registry, canvas, storage } = setup();
    const onReplace = vi.fn();

    await expect(
      canvas.acquireShared(sharedCtx(storage), { create: false, onReplace }),
    ).resolves.toBeUndefined();
    expect(onReplace).toHaveBeenLastCalledWith(undefined);
    expect(canvas.countForTenant(ctxWithTenant)).toBe(0);

    const live = await canvas.acquireShared(sharedCtx(storage));
    onReplace.mockClear();
    const peek = await canvas.acquireShared(sharedCtx(storage), { create: false, onReplace });
    expect(peek).toMatchObject({ canvasId: live.canvasId, isNew: false });
    expect(onReplace).not.toHaveBeenCalled();

    await canvas.drop(live.canvasId, ctxWithTenant);
    await expect(
      canvas.acquireShared(sharedCtx(storage), { create: false, onReplace }),
    ).resolves.toBeUndefined();
    expect(onReplace).toHaveBeenCalledWith(live.canvasId);
    expect(await storedId(storage)).toBeNull();
    expect(canvas.countForTenant(ctxWithTenant)).toBe(0);
    await registry.shutdown(ctxWithTenant);
  });

  it('stores the bare id with a TTL of the absolute cap in whole seconds, rounded up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(10_000_000);
      // A fixed registry clock keeps the canvas live while the store's clock moves.
      const { registry, canvas, storage } = setup({ absoluteCapMs: 1_500 }, () => 0);
      const instance = await canvas.acquireShared(sharedCtx(storage));

      expect(await storedId(storage)).toBe(instance.canvasId);
      vi.setSystemTime(10_000_000 + 2_000);
      expect(await storedId(storage)).toBe(instance.canvasId);
      vi.setSystemTime(10_000_000 + 2_001);
      expect(await storedId(storage)).toBeNull();
      await registry.shutdown(ctxWithTenant);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses an id an earlier bridge stored as a bare string under the same key', async () => {
    const { registry, canvas, storage } = setup();
    const earlier = await canvas.acquire(undefined, ctxWithTenant);
    await sharedCtx(storage).state.set('canvas-id', earlier.canvasId);
    const onReplace = vi.fn();

    const instance = await canvas.acquireShared(sharedCtx(storage), { onReplace });

    expect(instance).toMatchObject({ canvasId: earlier.canvasId, isNew: false });
    expect(onReplace).not.toHaveBeenCalled();
    expect(canvas.countForTenant(ctxWithTenant)).toBe(1);
    await registry.shutdown(ctxWithTenant);
  });

  it('drops the new canvas and rethrows when the id write fails', async () => {
    const { registry, canvas, storage } = setup();
    const failure = new Error('write refused');
    const refusing = withState(sharedCtx(storage), {
      set: async () => {
        throw failure;
      },
    });
    await expect(canvas.acquireShared(refusing)).rejects.toBe(failure);
    expect(canvas.countForTenant(ctxWithTenant)).toBe(0);

    // The call's own cancellation landing at the write takes the same path.
    const controller = new AbortController();
    const ctx = sharedCtx(storage, controller.signal);
    const cancelling = withState(ctx, {
      set: async (key, value, opts) => {
        controller.abort();
        await ctx.state.set(key, value, opts);
      },
    });
    await expect(canvas.acquireShared(cancelling)).rejects.toMatchObject({ name: 'AbortError' });

    expect(canvas.countForTenant(ctxWithTenant)).toBe(0);
    expect(await storedId(storage)).toBeNull();
    expect(lockEntries(canvas)).toBe(0);
    await registry.shutdown(ctxWithTenant);
  });

  it('rejects a queued waiter whose signal aborts before the lock releases, without running its resolution', async () => {
    const { registry, canvas, storage } = setup();
    const gate = Promise.withResolvers<void>();
    const leader = canvas.acquireShared(sharedCtx(storage), { onReplace: () => gate.promise });
    const leaderSettled = track(leader);
    await loopTurn();

    const controller = new AbortController();
    const waiterHook = vi.fn();
    const waiter = canvas.acquireShared(sharedCtx(storage, controller.signal), {
      onReplace: waiterHook,
    });
    const waiterSettled = track(waiter);
    const others = [
      canvas.acquireShared(sharedCtx(storage)),
      canvas.acquireShared(sharedCtx(storage)),
    ];
    await loopTurn();
    const reason = new Error('caller went away');
    controller.abort(reason);
    await loopTurn();

    expect(waiterSettled()).toBe(true);
    expect(leaderSettled()).toBe(false);
    await expect(waiter).rejects.toBe(reason);
    expect(waiterHook).not.toHaveBeenCalled();

    gate.resolve();
    const instances = await Promise.all([leader, ...others]);
    expect(new Set(instances.map((instance) => instance.canvasId)).size).toBe(1);
    expect(canvas.countForTenant(ctxWithTenant)).toBe(1);
    expect(lockEntries(canvas)).toBe(0);
    await registry.shutdown(ctxWithTenant);
  });

  it('resolves distinct state keys independently', async () => {
    const { registry, canvas, storage } = setup();
    const gate = Promise.withResolvers<void>();
    const tenantWide = canvas.acquireShared(sharedCtx(storage), { onReplace: () => gate.promise });
    await loopTurn();

    const perSession = canvas.acquireShared(sharedCtx(storage), {
      stateKey: 'session/s1/canvas-id',
    });
    const perSessionSettled = track(perSession);
    await loopTurn();
    expect(perSessionSettled()).toBe(true);

    gate.resolve();
    const [a, b] = await Promise.all([tenantWide, perSession]);
    expect(a.canvasId).not.toBe(b.canvasId);
    expect(await storedId(storage)).toBe(a.canvasId);
    expect(await storedId(storage, 'session/s1/canvas-id')).toBe(b.canvasId);
    expect(canvas.countForTenant(ctxWithTenant)).toBe(2);
    await registry.shutdown(ctxWithTenant);
  });

  it('resolves one state key for distinct tenants independently', async () => {
    const { registry, canvas, storage } = setup();
    const gate = Promise.withResolvers<void>();
    const tenantA = canvas.acquireShared(sharedCtx(storage), { onReplace: () => gate.promise });
    await loopTurn();

    const base = createMockContext({ tenantId: 'tenant-b' });
    const ctxB: Context = {
      ...base,
      state: createContextState(
        storage,
        { requestId: base.requestId, timestamp: base.timestamp, tenantId: 'tenant-b' },
        base.signal,
      ),
    };
    const tenantB = canvas.acquireShared(ctxB);
    const tenantBSettled = track(tenantB);
    await loopTurn();
    expect(tenantBSettled()).toBe(true);

    gate.resolve();
    const [a, b] = await Promise.all([tenantA, tenantB]);
    expect(b.tenantId).toBe('tenant-b');
    expect(a.canvasId).not.toBe(b.canvasId);
    expect(await ctxB.state.get('canvas-id')).toBe(b.canvasId);
    expect(await storedId(storage)).toBe(a.canvasId);
    expect(lockEntries(canvas)).toBe(0);
    await registry.shutdown(ctxWithTenant);
  });

  it("rejects an invalid stateKey with ctx.state's ValidationError before minting", async () => {
    const { registry, canvas, storage } = setup();
    const onReplace = vi.fn();

    const caught = await canvas
      .acquireShared(sharedCtx(storage), { stateKey: 'canvas:id', onReplace })
      .catch((err: unknown) => err);

    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
    expect(onReplace).not.toHaveBeenCalled();
    expect(canvas.countForTenant(ctxWithTenant)).toBe(0);
    expect(lockEntries(canvas)).toBe(0);
    await registry.shutdown(ctxWithTenant);
  });
});

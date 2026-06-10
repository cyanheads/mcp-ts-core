/**
 * @fileoverview Tests for the DataCanvas service wrapper and CanvasInstance
 * handle. These exercise the public API consumers actually use, with a stub
 * provider so the suite runs without `@duckdb/node-api`. Verifies tenant-id
 * enforcement, registry delegation, the touch-or-throw gate before every
 * operation, and the expiresAt mutation that slides the TTL window.
 * @module tests/unit/canvas/DataCanvas.test
 */

import { describe, expect, it, vi } from 'vitest';

import { CanvasInstance } from '@/services/canvas/core/CanvasInstance.js';
import {
  CanvasRegistry,
  type CanvasRegistryOptions,
} from '@/services/canvas/core/CanvasRegistry.js';
import { DataCanvas } from '@/services/canvas/core/DataCanvas.js';
import type { IDataCanvasProvider } from '@/services/canvas/core/IDataCanvasProvider.js';
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

  it('healthCheck delegates to the provider', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    const canvas = new DataCanvas(provider, registry);
    await expect(canvas.healthCheck()).resolves.toBe(true);
    expect(provider.healthCheck).toHaveBeenCalled();
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

  it('importFrom rejects when the source canvas belongs to another tenant', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    const canvas = new DataCanvas(provider, registry);
    const target = await canvas.acquire(undefined, ctxWithTenant);
    const stranger = await canvas.acquire(undefined, {
      ...ctxWithTenant,
      tenantId: 'tenant-b',
    });

    await expect(target.importFrom(stranger.canvasId, 'src')).rejects.toThrow(
      /not found or expired/i,
    );
    expect(provider.importFrom).not.toHaveBeenCalled();
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

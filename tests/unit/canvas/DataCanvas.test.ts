/**
 * @fileoverview Tests for the DataCanvas service wrapper and CanvasInstance
 * handle. These exercise the public API consumers actually use, with a stub
 * provider so the suite runs without `@duckdb/node-api`. Verifies tenant-id
 * enforcement, registry delegation, the touch-or-throw gate before every
 * operation, and the expiresAt mutation that slides the TTL window.
 * @module tests/unit/canvas/DataCanvas.test
 */

import { describe, expect, it, vi } from 'vitest';

import { CanvasInstance } from '@/canvas/core/CanvasInstance.js';
import { CanvasRegistry, type CanvasRegistryOptions } from '@/canvas/core/CanvasRegistry.js';
import { DataCanvas } from '@/canvas/core/DataCanvas.js';
import type { IDataCanvasProvider } from '@/canvas/core/IDataCanvasProvider.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

function makeStubProvider() {
  return {
    name: 'stub',
    initCanvas: vi.fn(async () => undefined),
    destroyCanvas: vi.fn(async () => undefined),
    registerTable: vi.fn(async () => ({ tableName: 't', rowCount: 0, columns: [] })),
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

  it('throws NotFound from any op when the canvas has expired', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const canvas = new DataCanvas(provider, registry);
    const instance = await canvas.acquire(undefined, ctxWithTenant);

    // Walk past the sliding TTL with no touches.
    clock.mockReturnValue(1_000_000 + TTL + 1);

    await expect(instance.registerTable('t', [{ x: 1 }])).rejects.toThrow(/not found or expired/i);
    await expect(instance.query('SELECT 1')).rejects.toThrow(/not found or expired/i);
    await expect(instance.export('t', { format: 'csv', path: 'x.csv' })).rejects.toThrow(
      /not found or expired/i,
    );
    await expect(instance.describe()).rejects.toThrow(/not found or expired/i);
    await expect(instance.drop('t')).rejects.toThrow(/not found or expired/i);
    await expect(instance.clear()).rejects.toThrow(/not found or expired/i);

    // Provider methods must not have been invoked once touch-or-throw rejected.
    expect(provider.registerTable).not.toHaveBeenCalled();
    expect(provider.query).not.toHaveBeenCalled();
    expect(provider.export).not.toHaveBeenCalled();

    await registry.shutdown(ctxWithTenant);
  });
});

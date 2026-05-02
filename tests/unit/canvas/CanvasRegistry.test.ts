/**
 * @fileoverview Tests for the CanvasRegistry — id minting, sliding TTL,
 * 7-day absolute cap, per-tenant cap, and sweeper. The provider is mocked so
 * tests run synchronously without DuckDB.
 * @module tests/unit/canvas/CanvasRegistry.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CanvasRegistry, type CanvasRegistryOptions } from '@/canvas/core/CanvasRegistry.js';
import type { IDataCanvasProvider } from '@/canvas/core/IDataCanvasProvider.js';
import { McpError } from '@/types-global/errors.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

/** Stub provider — only the lifecycle methods that CanvasRegistry calls are real. */
function makeStubProvider(): IDataCanvasProvider & {
  initCalls: string[];
  destroyCalls: string[];
} {
  const initCalls: string[] = [];
  const destroyCalls: string[] = [];
  return {
    name: 'stub',
    initCalls,
    destroyCalls,
    initCanvas: vi.fn(async (id: string) => {
      initCalls.push(id);
    }),
    destroyCanvas: vi.fn(async (id: string) => {
      destroyCalls.push(id);
    }),
    registerTable: vi.fn(),
    query: vi.fn(),
    export: vi.fn(),
    describe: vi.fn(),
    drop: vi.fn(),
    clear: vi.fn(),
    healthCheck: vi.fn(async () => true),
    shutdown: vi.fn(async () => {}),
  } as unknown as IDataCanvasProvider & {
    initCalls: string[];
    destroyCalls: string[];
  };
}

const baseContext: RequestContext = {
  requestId: 'test-req',
  timestamp: '2026-01-01T00:00:00.000Z',
  tenantId: 'tenant-a',
};

const TTL = 24 * 60 * 60 * 1000;
const ABSOLUTE_CAP = 7 * 24 * 60 * 60 * 1000;

function makeOptions(overrides: Partial<CanvasRegistryOptions> = {}): CanvasRegistryOptions {
  return {
    ttlMs: TTL,
    absoluteCapMs: ABSOLUTE_CAP,
    maxCanvasesPerTenant: 100,
    sweeperIntervalMs: 0, // disable interval; tests call sweep() directly
    ...overrides,
  };
}

describe('CanvasRegistry · acquire (new)', () => {
  it('mints a 10-char URL-safe canvas ID and calls initCanvas on the provider', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), () => 1_000_000);
    const result = await registry.acquire(undefined, 'tenant-a', baseContext);
    expect(result.canvasId).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(result.isNew).toBe(true);
    expect(result.tenantId).toBe('tenant-a');
    expect(provider.initCalls).toEqual([result.canvasId]);
    expect(new Date(result.expiresAt).getTime()).toBe(1_000_000 + TTL);
    await registry.shutdown(baseContext);
  });

  it('can mint many distinct IDs', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions({ maxCanvasesPerTenant: 1000 }));
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const r = await registry.acquire(undefined, 'tenant-a', baseContext);
      expect(seen.has(r.canvasId)).toBe(false);
      seen.add(r.canvasId);
    }
    await registry.shutdown(baseContext);
  });
});

describe('CanvasRegistry · acquire (existing)', () => {
  it('returns the same canvas with isNew=false and extends TTL', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const first = await registry.acquire(undefined, 'tenant-a', baseContext);

    clock.mockReturnValue(2_000_000);
    const second = await registry.acquire(first.canvasId, 'tenant-a', baseContext);

    expect(second.canvasId).toBe(first.canvasId);
    expect(second.isNew).toBe(false);
    expect(new Date(second.expiresAt).getTime()).toBe(2_000_000 + TTL);
    expect(provider.initCalls).toEqual([first.canvasId]); // initCanvas not re-invoked
    await registry.shutdown(baseContext);
  });

  it('throws NotFound for unknown canvas IDs', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    await expect(registry.acquire('AAAAAAAAAA', 'tenant-a', baseContext)).rejects.toThrow(
      /not found or expired/i,
    );
    await registry.shutdown(baseContext);
  });

  it('hides cross-tenant canvases as NotFound', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    const first = await registry.acquire(undefined, 'tenant-a', baseContext);
    await expect(registry.acquire(first.canvasId, 'tenant-b', baseContext)).rejects.toThrow(
      /not found or expired/i,
    );
    await registry.shutdown(baseContext);
  });

  it('throws NotFound for malformed IDs (does not leak shape vs existence)', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    let caught: unknown;
    try {
      await registry.acquire('not a real id', 'tenant-a', baseContext);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    await registry.shutdown(baseContext);
  });
});

describe('CanvasRegistry · sliding TTL and absolute cap', () => {
  it('expires after TTL of inactivity', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const first = await registry.acquire(undefined, 'tenant-a', baseContext);

    clock.mockReturnValue(1_000_000 + TTL + 1);
    await expect(registry.acquire(first.canvasId, 'tenant-a', baseContext)).rejects.toThrow(
      /not found or expired/i,
    );
    await registry.shutdown(baseContext);
  });

  it('enforces 7-day absolute cap even with continuous touches', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const first = await registry.acquire(undefined, 'tenant-a', baseContext);

    // Walk forward in 1-hour steps for 8 days, touching each step.
    for (let elapsed = 0; elapsed < ABSOLUTE_CAP; elapsed += 60 * 60 * 1000) {
      clock.mockReturnValue(1_000_000 + elapsed);
      const r = await registry.acquire(first.canvasId, 'tenant-a', baseContext);
      expect(r.canvasId).toBe(first.canvasId);
    }

    // One step past the absolute cap — must reject.
    clock.mockReturnValue(1_000_000 + ABSOLUTE_CAP + 1);
    await expect(registry.acquire(first.canvasId, 'tenant-a', baseContext)).rejects.toThrow(
      /not found or expired/i,
    );
    await registry.shutdown(baseContext);
  });

  it('clamps expiresAt to the absolute cap when sliding extension would exceed it', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const first = await registry.acquire(undefined, 'tenant-a', baseContext);

    // Walk forward in 1-hour steps to keep the canvas alive, until we're
    // within the sliding window of the absolute cap.
    const oneHour = 60 * 60 * 1000;
    let elapsed = oneHour;
    while (elapsed < ABSOLUTE_CAP - oneHour) {
      clock.mockReturnValue(1_000_000 + elapsed);
      const r = await registry.acquire(first.canvasId, 'tenant-a', baseContext);
      // Until we're inside the last 24h before the cap, sliding wins.
      if (1_000_000 + elapsed + TTL <= 1_000_000 + ABSOLUTE_CAP) {
        expect(new Date(r.expiresAt).getTime()).toBe(1_000_000 + elapsed + TTL);
      } else {
        expect(new Date(r.expiresAt).getTime()).toBe(1_000_000 + ABSOLUTE_CAP);
      }
      elapsed += oneHour;
    }
    // Touch in the last 24h before the cap — sliding would exceed the cap,
    // so expiresAt is clamped to absolute.
    clock.mockReturnValue(1_000_000 + ABSOLUTE_CAP - oneHour);
    const last = await registry.acquire(first.canvasId, 'tenant-a', baseContext);
    expect(new Date(last.expiresAt).getTime()).toBe(1_000_000 + ABSOLUTE_CAP);
    await registry.shutdown(baseContext);
  });
});

describe('CanvasRegistry · per-tenant cap', () => {
  it('throws RateLimited when the tenant exceeds the cap', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions({ maxCanvasesPerTenant: 2 }));
    await registry.acquire(undefined, 'tenant-a', baseContext);
    await registry.acquire(undefined, 'tenant-a', baseContext);
    await expect(registry.acquire(undefined, 'tenant-a', baseContext)).rejects.toThrow(
      /active canvas cap/i,
    );
    // Other tenants are unaffected.
    await expect(registry.acquire(undefined, 'tenant-b', baseContext)).resolves.toBeTruthy();
    await registry.shutdown(baseContext);
  });

  it('countForTenant tracks active count', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    expect(registry.countForTenant('tenant-a')).toBe(0);
    await registry.acquire(undefined, 'tenant-a', baseContext);
    await registry.acquire(undefined, 'tenant-a', baseContext);
    expect(registry.countForTenant('tenant-a')).toBe(2);
    expect(registry.totalActive()).toBe(2);
    await registry.shutdown(baseContext);
  });
});

describe('CanvasRegistry · drop and sweep', () => {
  it('drop() destroys the canvas and decrements counts', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    const first = await registry.acquire(undefined, 'tenant-a', baseContext);
    const ok = await registry.drop(first.canvasId, 'tenant-a', baseContext);
    expect(ok).toBe(true);
    expect(provider.destroyCalls).toContain(first.canvasId);
    expect(registry.countForTenant('tenant-a')).toBe(0);
    await registry.shutdown(baseContext);
  });

  it('drop() returns false for cross-tenant canvases (no destruction leak)', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    const first = await registry.acquire(undefined, 'tenant-a', baseContext);
    const ok = await registry.drop(first.canvasId, 'tenant-b', baseContext);
    expect(ok).toBe(false);
    expect(provider.destroyCalls).not.toContain(first.canvasId);
    await registry.shutdown(baseContext);
  });

  it('sweep() destroys all expired canvases', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const a = await registry.acquire(undefined, 'tenant-a', baseContext);
    const b = await registry.acquire(undefined, 'tenant-b', baseContext);

    clock.mockReturnValue(1_000_000 + TTL + 1);
    await registry.sweep();
    expect(provider.destroyCalls.sort()).toEqual([a.canvasId, b.canvasId].sort());
    expect(registry.totalActive()).toBe(0);
    await registry.shutdown(baseContext);
  });
});

describe('CanvasRegistry · shutdown', () => {
  let registry: CanvasRegistry | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  beforeEach(() => {
    timer = undefined;
    registry = undefined;
  });
  afterEach(async () => {
    if (registry) await registry.shutdown(baseContext);
    if (timer) clearInterval(timer);
  });

  it('destroys all canvases and tears down the provider', async () => {
    const provider = makeStubProvider();
    registry = new CanvasRegistry(provider, makeOptions());
    await registry.acquire(undefined, 'tenant-a', baseContext);
    await registry.acquire(undefined, 'tenant-a', baseContext);
    await registry.shutdown(baseContext);
    expect(provider.destroyCalls.length).toBe(2);
    expect(provider.shutdown).toHaveBeenCalled();
    registry = undefined;
  });

  it('further acquire() calls after shutdown throw NotFound', async () => {
    const provider = makeStubProvider();
    registry = new CanvasRegistry(provider, makeOptions());
    await registry.shutdown(baseContext);
    await expect(registry.acquire(undefined, 'tenant-a', baseContext)).rejects.toThrow(
      /shutting down/i,
    );
    registry = undefined;
  });
});

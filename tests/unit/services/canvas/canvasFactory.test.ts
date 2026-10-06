/**
 * @fileoverview Tests for the canvas service factory. Pins the disabled-by-
 * default behavior, the serverless fail-closed for DuckDB (the stated
 * correctness invariant for Cloudflare Workers), the happy-path construction,
 * and — against real DuckDB, loaded on the first acquire() — that each canvas
 * setting reaches the provider and registry the factory builds.
 * @module tests/unit/canvas/canvasFactory.test
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@/config/index.js';
import { createCanvasService } from '@/services/canvas/core/canvasFactory.js';
import { DataCanvas } from '@/services/canvas/core/DataCanvas.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

function makeConfig(overrides: Partial<AppConfig['canvas']> = {}): AppConfig {
  return {
    canvas: {
      providerType: 'none',
      defaultMemoryLimitMb: 256,
      exportRootPath: './.canvas-exports',
      maxCanvasesPerTenant: 100,
      ttlMs: 24 * 60 * 60 * 1000,
      absoluteCapMs: 7 * 24 * 60 * 60 * 1000,
      sweeperIntervalMs: 0,
      defaultRowLimit: 10_000,
      schemaSniffRows: 100,
      ...overrides,
    },
  } as unknown as AppConfig;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createCanvasService', () => {
  it('returns undefined when providerType is "none" (the default)', () => {
    const result = createCanvasService(makeConfig({ providerType: 'none' }));
    expect(result).toBeUndefined();
  });

  it('short-circuits before the serverless check when providerType is "none"', () => {
    // Set IS_SERVERLESS=true to prove the 'none' path doesn't reach isServerless().
    vi.stubEnv('IS_SERVERLESS', 'true');
    expect(() => createCanvasService(makeConfig({ providerType: 'none' }))).not.toThrow();
  });

  it('returns a DataCanvas when providerType is "duckdb" outside serverless', () => {
    vi.stubEnv('IS_SERVERLESS', 'false');
    const result = createCanvasService(makeConfig({ providerType: 'duckdb' }));
    expect(result).toBeInstanceOf(DataCanvas);
  });

  it('throws ConfigurationError when providerType is "duckdb" in a serverless environment', () => {
    vi.stubEnv('IS_SERVERLESS', 'true');
    let caught: unknown;
    try {
      createCanvasService(makeConfig({ providerType: 'duckdb' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect((caught as McpError).message).toMatch(/DuckDB canvas requires Node\.js or Bun/);
    expect((caught as McpError).message).toMatch(/CANVAS_PROVIDER_TYPE=none/);
    // #548 — the startup context is log metadata, not error data.
    expect((caught as McpError).data).toBeUndefined();
  });
});

// The happy path above only proves a DataCanvas comes back. Each config field
// below is set to a value the defaults would never produce, then observed
// through the service's own behaviour.
describe('createCanvasService · config wiring', () => {
  const ctx: RequestContext = {
    requestId: 'canvas-factory-wiring',
    timestamp: '2026-01-01T00:00:00.000Z',
    tenantId: 'tenant-a',
  };
  const T0 = Date.parse('2026-01-01T00:00:00.000Z');
  const HOUR = 60 * 60 * 1000;
  let dir: string;
  let service: DataCanvas | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'canvas-factory-'));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await service?.shutdown(ctx);
    service = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it('passes every canvas setting through to the provider and registry it builds', async () => {
    vi.stubEnv('IS_SERVERLESS', 'false');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const scratchParent = join(dir, 'scratch');
    const exportRoot = join(dir, 'exports');
    service = createCanvasService(
      makeConfig({
        providerType: 'duckdb',
        tempRootPath: scratchParent,
        exportRootPath: exportRoot,
        maxCanvasesPerTenant: 1,
        ttlMs: 2 * HOUR,
        absoluteCapMs: HOUR,
        defaultRowLimit: 5,
      }),
    );
    if (!service) throw new Error('expected a canvas service');

    const instance = await service.acquire(undefined, ctx);
    // Sliding TTL on creation, clamped to the absolute cap on the next touch.
    expect(instance.expiresAt).toBe(new Date(T0 + 2 * HOUR).toISOString());
    await instance.registerTable('t', [{ x: 1 }]);
    expect(instance.expiresAt).toBe(new Date(T0 + HOUR).toISOString());

    await expect(service.acquire(undefined, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'canvas_capacity_exhausted', cap: 1 },
    });
    await expect(instance.query('SELECT x FROM t', { rowLimit: 6 })).rejects.toMatchObject({
      data: { reason: 'invalid_query_bounds', field: 'rowLimit' },
    });
    expect(await readdir(scratchParent)).toEqual([expect.stringMatching(/^mcp-canvas-/)]);
    const exported = await instance.export('t', { format: 'csv', path: 'out.csv' });
    expect(exported.path).toBe(join(exportRoot, 'out.csv'));
  });
});

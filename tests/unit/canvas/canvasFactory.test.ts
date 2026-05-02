/**
 * @fileoverview Tests for the canvas service factory. Pins the disabled-by-
 * default behavior, the serverless fail-closed for DuckDB (the stated
 * correctness invariant for Cloudflare Workers), and the happy-path
 * construction. The DuckDB provider is constructed but not initialized — the
 * `@duckdb/node-api` module is lazy-loaded on first acquire().
 * @module tests/unit/canvas/canvasFactory.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCanvasService } from '@/canvas/core/canvasFactory.js';
import { DataCanvas } from '@/canvas/core/DataCanvas.js';
import type { AppConfig } from '@/config/index.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

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
  });
});

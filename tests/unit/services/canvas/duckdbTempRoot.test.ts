/**
 * @fileoverview Tests for the DuckDB provider's scratch-root resolution. The
 * provider must never let spill/scratch I/O land in the process cwd: DuckDB
 * defaults an in-memory database's `temp_directory` to a cwd-relative `.tmp`,
 * which fails under a non-root or read-only container rootfs. Constructing the
 * provider does not touch `@duckdb/node-api` (the import is lazy), so these
 * run without the optional peer dependency. (#292)
 * @module tests/unit/services/canvas/duckdbTempRoot.test
 */

import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DuckdbProvider,
  type DuckdbProviderOptions,
} from '@/services/canvas/providers/duckdb/DuckdbProvider.js';

const BASE_OPTIONS: DuckdbProviderOptions = {
  defaultRowLimit: 10_000,
  exportRootPath: './.canvas-exports',
  memoryLimitMb: 256,
  schemaSniffRows: 100,
};

/** Reach the private resolver — there is no public surface that avoids DuckDB. */
function tempRootOf(provider: DuckdbProvider): Promise<string> {
  return (provider as unknown as { ensureTempRoot(): Promise<string> }).ensureTempRoot();
}

describe('DuckdbProvider · scratch root', () => {
  const created: string[] = [];

  afterEach(async () => {
    for (const dir of created.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('defaults under the OS temp directory, never the process cwd', async () => {
    const provider = new DuckdbProvider(BASE_OPTIONS);

    const root = await tempRootOf(provider);
    created.push(root);

    expect(root).toBe(join(tmpdir(), 'mcp-canvas'));
    expect(isAbsolute(root)).toBe(true);
    expect(root.startsWith(process.cwd())).toBe(false);
  });

  it('honours an explicit CANVAS_TEMP_PATH and resolves it to an absolute path', async () => {
    const configured = join(tmpdir(), `mcp-canvas-test-${Date.now()}`, 'nested');
    const provider = new DuckdbProvider({ ...BASE_OPTIONS, tempRootPath: configured });

    const root = await tempRootOf(provider);
    created.push(root);

    expect(root).toBe(configured);
    expect(isAbsolute(root)).toBe(true);
  });

  it('creates the scratch root so a spill can write immediately', async () => {
    const configured = join(tmpdir(), `mcp-canvas-test-${Date.now()}-mkdir`);
    const provider = new DuckdbProvider({ ...BASE_OPTIONS, tempRootPath: configured });

    const root = await tempRootOf(provider);
    created.push(root);

    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it('keeps the scratch root independent of the user-facing export sandbox', async () => {
    const provider = new DuckdbProvider({ ...BASE_OPTIONS, exportRootPath: './.canvas-exports' });

    const root = await tempRootOf(provider);
    created.push(root);

    // Export files stay where the caller asked for them; only scratch moves.
    expect(root).not.toContain('.canvas-exports');
  });
});

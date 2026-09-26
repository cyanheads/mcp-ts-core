/**
 * @fileoverview Tests for the DuckDB provider's private scratch directory. The
 * provider must never let spill/scratch I/O land in the process cwd (#292) —
 * DuckDB defaults an in-memory database's `temp_directory` to a cwd-relative
 * `.tmp` — and must never trust a fixed shared path another local user can
 * read or pre-create (#554). Each provider makes one `mkdtemp` directory on
 * first use and removes it on shutdown. Constructing the provider does not
 * touch `@duckdb/node-api` (the import is lazy), so these run without the
 * optional peer dependency; every test points the scratch parent at a
 * throwaway directory, never the shared OS temp root.
 * @module tests/unit/services/canvas/duckdbTempRoot.test
 */

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DuckdbProvider,
  type DuckdbProviderOptions,
} from '@/services/canvas/providers/duckdb/DuckdbProvider.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

const BASE_OPTIONS: DuckdbProviderOptions = {
  defaultRowLimit: 10_000,
  exportRootPath: './.canvas-exports',
  memoryLimitMb: 256,
  schemaSniffRows: 100,
};

const IS_POSIX = process.platform !== 'win32';
const RUNNING_AS_ROOT = process.getuid?.() === 0;
/** What `mkdtemp(join(parent, 'mcp-canvas-'))` names the private directory. */
const PRIVATE_DIR = /^mcp-canvas-[A-Za-z0-9]{6}$/;

/** Reach the private resolver — there is no public surface that avoids DuckDB. */
function scratchDirOf(provider: DuckdbProvider): Promise<string> {
  return (provider as unknown as { ensureTempRoot(): Promise<string> }).ensureTempRoot();
}

/** Permission bits of `path`. */
async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe('DuckdbProvider · private scratch directory', () => {
  const parents: string[] = [];

  /** A fresh throwaway directory standing in for a scratch parent or the OS temp root. */
  async function throwaway(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'canvas-temproot-test-'));
    parents.push(dir);
    return dir;
  }

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const dir of parents.splice(0)) {
      await chmod(dir, 0o700).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('defaults to a fresh mcp-canvas-XXXXXX under the OS temp directory, never the process cwd', async () => {
    const fakeTmp = await throwaway();
    vi.stubEnv('TMPDIR', fakeTmp);
    const provider = new DuckdbProvider(BASE_OPTIONS);

    const dir = await scratchDirOf(provider);

    expect(dirname(dir)).toBe(tmpdir());
    expect(basename(dir)).toMatch(PRIVATE_DIR);
    expect(isAbsolute(dir)).toBe(true);
    expect(dir.startsWith(process.cwd())).toBe(false);
    expect((await stat(dir)).isDirectory()).toBe(true);
    if (IS_POSIX) expect(await modeOf(dir)).toBe(0o700);
    // The old fixed root is never created.
    expect(await readdir(fakeTmp)).toEqual([basename(dir)]);
    await provider.shutdown();
  });

  it.skipIf(!IS_POSIX)(
    'never reads, writes, or removes a pre-existing <tmpdir>/mcp-canvas',
    async () => {
      const fakeTmp = await throwaway();
      vi.stubEnv('TMPDIR', fakeTmp);
      // Pre-created the way another local user could: world-writable, holding a
      // file and a link planted at one of DuckDB's fixed spill-file names.
      const shared = join(fakeTmp, 'mcp-canvas');
      await mkdir(shared);
      await chmod(shared, 0o777);
      await writeFile(join(shared, 'planted.txt'), 'planted');
      await symlink(join(fakeTmp, 'victim'), join(shared, 'duckdb_temp_storage_DEFAULT-0.tmp'));
      const provider = new DuckdbProvider(BASE_OPTIONS);

      const dir = await scratchDirOf(provider);
      await provider.shutdown();

      expect(dir).not.toBe(shared);
      expect(await modeOf(shared)).toBe(0o777);
      expect((await readdir(shared)).sort()).toEqual([
        'duckdb_temp_storage_DEFAULT-0.tmp',
        'planted.txt',
      ]);
      expect(
        (await lstat(join(shared, 'duckdb_temp_storage_DEFAULT-0.tmp'))).isSymbolicLink(),
      ).toBe(true);
      expect(await readdir(fakeTmp)).toEqual(['mcp-canvas']);
    },
  );

  it('creates a missing CANVAS_TEMP_PATH and makes the private directory inside it', async () => {
    const configured = join(await throwaway(), 'nested', 'scratch');
    const provider = new DuckdbProvider({ ...BASE_OPTIONS, tempRootPath: configured });

    const dir = await scratchDirOf(provider);

    expect(dirname(dir)).toBe(configured);
    expect(basename(dir)).toMatch(PRIVATE_DIR);
    if (IS_POSIX) expect(await modeOf(dir)).toBe(0o700);
    expect(await readdir(configured)).toEqual([basename(dir)]);
    await provider.shutdown();
  });

  it('creates the directory once, however many callers race on first use', async () => {
    const parent = await throwaway();
    const provider = new DuckdbProvider({ ...BASE_OPTIONS, tempRootPath: parent });

    const dirs = await Promise.all([
      scratchDirOf(provider),
      scratchDirOf(provider),
      scratchDirOf(provider),
    ]);

    expect(new Set(dirs).size).toBe(1);
    expect(await scratchDirOf(provider)).toBe(dirs[0]);
    expect(await readdir(parent)).toHaveLength(1);
    await provider.shutdown();
  });

  it('removes the directory on shutdown and makes a new one if the provider is used again', async () => {
    const parent = await throwaway();
    const provider = new DuckdbProvider({ ...BASE_OPTIONS, tempRootPath: parent });

    const first = await scratchDirOf(provider);
    await writeFile(join(first, 'leftover.csv'), 'x');
    await provider.shutdown();
    expect(await readdir(parent)).toEqual([]);

    const second = await scratchDirOf(provider);
    expect(second).not.toBe(first);
    expect(basename(second)).toMatch(PRIVATE_DIR);
    await provider.shutdown();
    await provider.shutdown();
    expect(await readdir(parent)).toEqual([]);
  });

  it('gives every provider its own directory, and shutting one down leaves the others', async () => {
    const parent = await throwaway();
    const one = new DuckdbProvider({ ...BASE_OPTIONS, tempRootPath: parent });
    const two = new DuckdbProvider({ ...BASE_OPTIONS, tempRootPath: parent });

    const [dirOne, dirTwo] = await Promise.all([scratchDirOf(one), scratchDirOf(two)]);
    expect(dirOne).not.toBe(dirTwo);

    await one.shutdown();
    expect(await readdir(parent)).toEqual([basename(dirTwo)]);
    await two.shutdown();
    expect(await readdir(parent)).toEqual([]);
  });

  // What an operator finds when cleanup cannot finish: the directory is left
  // in place with its private mode, and shutdown still settles.
  it.skipIf(!IS_POSIX || RUNNING_AS_ROOT)(
    'leaves the directory in place, still 0700, when shutdown cannot remove it',
    async () => {
      const parent = await throwaway();
      const provider = new DuckdbProvider({ ...BASE_OPTIONS, tempRootPath: parent });
      const dir = await scratchDirOf(provider);
      await chmod(parent, 0o500);

      await expect(provider.shutdown()).resolves.toBeUndefined();

      await chmod(parent, 0o700);
      expect(await readdir(parent)).toEqual([basename(dir)]);
      expect(await modeOf(dir)).toBe(0o700);
    },
  );

  it.skipIf(!IS_POSIX || RUNNING_AS_ROOT)(
    'fails as ConfigurationError on an unwritable CANVAS_TEMP_PATH, then recovers once it is writable',
    async () => {
      const parent = await throwaway();
      await chmod(parent, 0o500);
      const provider = new DuckdbProvider({ ...BASE_OPTIONS, tempRootPath: parent });

      const failure = await scratchDirOf(provider).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(McpError);
      expect((failure as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
      expect((failure as McpError).message).toMatch(/CANVAS_TEMP_PATH/);
      // The message reaches the caller; the host path stays in the cause.
      expect((failure as McpError).message).not.toContain(parent);

      await chmod(parent, 0o700);
      const dir = await scratchDirOf(provider);
      expect(dirname(dir)).toBe(parent);
      await provider.shutdown();
      expect(await readdir(parent)).toEqual([]);
    },
  );
});

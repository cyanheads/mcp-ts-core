/**
 * @fileoverview Tests for scripts/prune-musl-packages.ts — the Dockerfiles'
 * `deps`-stage step that deletes the musl-only packages a `--os`/`--cpu`
 * cross-install leaves beside their glibc twins (#608). Fixture `node_modules`
 * trees are written to disk in each layout Bun produces — hoisted, scoped,
 * nested, and the isolated `node_modules/.bun` store with its relative
 * symlinks — and the script runs against them as a function and as the
 * subprocess a Dockerfile `RUN` starts.
 * @module tests/unit/scripts/prune-musl-packages.test
 */

import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneMuslPackages } from '../../../scripts/prune-musl-packages.js';

const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'prune-musl-packages.ts');

let scratch: string | undefined;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** A scratch project root, with an empty `node_modules` unless `withNodeModules` is false. */
function project(withNodeModules = true): string {
  scratch = mkdtempSync(join(tmpdir(), 'prune-musl-'));
  if (withNodeModules) mkdirSync(join(scratch, 'node_modules'));
  return scratch;
}

/** An installed package at `dir` under `root`: its manifest plus a stand-in native payload. */
function pkg(root: string, dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(root, dir, 'binding.node'), 'native');
}

/** A relative symlink at `path` to `target`, both under `root`, as Bun's isolated linker writes them. */
function link(root: string, path: string, target: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  symlinkSync(relative(dirname(join(root, path)), join(root, target)), join(root, path));
}

/** Whether `path` under `root` exists as a file, directory, or symlink, dangling or not. */
function present(root: string, path: string): boolean {
  try {
    lstatSync(join(root, path));
    return true;
  } catch {
    return false;
  }
}

/** The removed packages as `name@version` beside their directory relative to `root`, sorted. */
function removedOf(root: string, result: ReturnType<typeof pruneMuslPackages>): string[][] {
  return result.removed
    .map(({ name, version, dir }) => [`${name}@${version}`, relative(root, dir)])
    .sort(([a = ''], [b = '']) => a.localeCompare(b));
}

const MUSL = { libc: ['musl'] };
const GLIBC = { libc: ['glibc'] };

describe('pruneMuslPackages', () => {
  it('removes musl-only packages from a hoisted tree: top-level, scoped, and nested two levels down', () => {
    const root = project();
    pkg(root, 'node_modules/@duckdb/node-bindings', {
      name: '@duckdb/node-bindings',
      version: '1',
    });
    pkg(root, 'node_modules/@duckdb/node-bindings-linux-x64', {
      name: '@duckdb/node-bindings-linux-x64',
      version: '1',
      ...GLIBC,
    });
    pkg(root, 'node_modules/@duckdb/node-bindings-linux-x64-musl', {
      name: '@duckdb/node-bindings-linux-x64-musl',
      version: '1',
      ...MUSL,
    });
    // `libc` may be a bare string as well as an array.
    pkg(root, 'node_modules/lightningcss-linux-x64-musl', {
      name: 'lightningcss-linux-x64-musl',
      version: '2',
      libc: 'musl',
    });
    pkg(root, 'node_modules/outer', { name: 'outer', version: '3' });
    pkg(root, 'node_modules/outer/node_modules/@img/sharp-linuxmusl-x64', {
      name: '@img/sharp-linuxmusl-x64',
      version: '4',
      ...MUSL,
    });
    pkg(root, 'node_modules/outer/node_modules/inner', { name: 'inner', version: '5' });
    pkg(
      root,
      'node_modules/outer/node_modules/inner/node_modules/@rolldown/binding-linux-x64-musl',
      {
        name: '@rolldown/binding-linux-x64-musl',
        version: '6',
        ...MUSL,
      },
    );

    const result = pruneMuslPackages(join(root, 'node_modules'));

    expect(removedOf(root, result)).toEqual([
      [
        '@duckdb/node-bindings-linux-x64-musl@1',
        'node_modules/@duckdb/node-bindings-linux-x64-musl',
      ],
      ['@img/sharp-linuxmusl-x64@4', 'node_modules/outer/node_modules/@img/sharp-linuxmusl-x64'],
      [
        '@rolldown/binding-linux-x64-musl@6',
        'node_modules/outer/node_modules/inner/node_modules/@rolldown/binding-linux-x64-musl',
      ],
      ['lightningcss-linux-x64-musl@2', 'node_modules/lightningcss-linux-x64-musl'],
    ]);
    for (const [, dir = ''] of removedOf(root, result)) expect(present(root, dir)).toBe(false);
    for (const kept of [
      'node_modules/@duckdb/node-bindings/binding.node',
      'node_modules/@duckdb/node-bindings-linux-x64/binding.node',
      'node_modules/outer/package.json',
      'node_modules/outer/node_modules/inner/package.json',
    ]) {
      expect(present(root, kept), kept).toBe(true);
    }
    expect(result.unlinked).toEqual([]);
  });

  it('keeps every package whose libc admits glibc or never names musl, whatever its name says', () => {
    const root = project();
    const keep: [string, Record<string, unknown>][] = [
      ['node_modules/@biomejs/cli-linux-x64-musl', { libc: ['!musl'] }],
      ['node_modules/dual-libc-musl', { libc: ['musl', 'glibc'] }],
      ['node_modules/no-libc-field-musl', {}],
      ['node_modules/glibc-string', { libc: 'glibc' }],
      ['node_modules/not-glibc', { libc: ['!glibc'] }],
    ];
    for (const [dir, fields] of keep) {
      pkg(root, dir, { name: dir.replace('node_modules/', ''), version: '1', ...fields });
    }
    // A directory with no manifest is not a package and is left alone.
    mkdirSync(join(root, 'node_modules', '.cache', 'musl'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'stray-dir-musl'));

    const result = pruneMuslPackages(join(root, 'node_modules'));

    expect(result).toEqual({ removed: [], unlinked: [] });
    for (const [dir] of keep) expect(present(root, `${dir}/binding.node`), dir).toBe(true);
    expect(present(root, 'node_modules/.cache/musl')).toBe(true);
    expect(present(root, 'node_modules/stray-dir-musl')).toBe(true);
  });

  it("removes a musl-only package from Bun's isolated store and every symlink into it", () => {
    const root = project();
    const store = 'node_modules/.bun';
    const api = `${store}/@duckdb+node-api@1/node_modules/@duckdb/node-api`;
    const bindings = `${store}/@duckdb+node-bindings@1/node_modules/@duckdb/node-bindings`;
    const glibc = `${store}/@duckdb+node-bindings-linux-x64@1/node_modules/@duckdb/node-bindings-linux-x64`;
    const musl = `${store}/@duckdb+node-bindings-linux-x64-musl@1/node_modules/@duckdb/node-bindings-linux-x64-musl`;
    pkg(root, api, { name: '@duckdb/node-api', version: '1' });
    pkg(root, bindings, { name: '@duckdb/node-bindings', version: '1' });
    pkg(root, glibc, { name: '@duckdb/node-bindings-linux-x64', version: '1', ...GLIBC });
    pkg(root, musl, { name: '@duckdb/node-bindings-linux-x64-musl', version: '1', ...MUSL });
    // The project's direct dependency, each store entry's dependencies, and the store's hoisted view.
    link(root, 'node_modules/@duckdb/node-api', api);
    link(root, `${store}/@duckdb+node-api@1/node_modules/@duckdb/node-bindings`, bindings);
    const dependencyLinks = `${store}/@duckdb+node-bindings@1/node_modules/@duckdb`;
    link(root, `${dependencyLinks}/node-bindings-linux-x64`, glibc);
    link(root, `${dependencyLinks}/node-bindings-linux-x64-musl`, musl);
    link(root, `${store}/node_modules/@duckdb/node-bindings-linux-x64`, glibc);
    link(root, `${store}/node_modules/@duckdb/node-bindings-linux-x64-musl`, musl);

    const result = pruneMuslPackages(join(root, 'node_modules'));

    // Reached through two links and its own store entry, it is still one package removed once.
    expect(removedOf(root, result)).toEqual([['@duckdb/node-bindings-linux-x64-musl@1', musl]]);
    expect(result.unlinked.map((path) => relative(root, path)).sort()).toEqual([
      `${dependencyLinks}/node-bindings-linux-x64-musl`,
      `${store}/node_modules/@duckdb/node-bindings-linux-x64-musl`,
    ]);
    expect(present(root, musl)).toBe(false);
    for (const kept of [
      `${glibc}/binding.node`,
      `${dependencyLinks}/node-bindings-linux-x64/binding.node`,
      `${store}/node_modules/@duckdb/node-bindings-linux-x64/binding.node`,
      `${store}/@duckdb+node-api@1/node_modules/@duckdb/node-bindings/binding.node`,
      'node_modules/@duckdb/node-api/binding.node',
    ]) {
      expect(present(root, kept), kept).toBe(true);
    }
  });
});

describe('prune-musl-packages script', () => {
  /** Runs the script from `cwd`, as the Dockerfile's `RUN bun scripts/prune-musl-packages.ts` does. */
  const run = (cwd: string) => spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });

  it('removes each musl-only package, names it, and exits 0', () => {
    const root = project();
    const dir = 'node_modules/@duckdb/node-bindings-linux-x64-musl';
    pkg(root, dir, { name: '@duckdb/node-bindings-linux-x64-musl', version: '1.5.6-r.1', ...MUSL });
    pkg(root, 'node_modules/@duckdb/node-bindings-linux-x64', {
      name: '@duckdb/node-bindings-linux-x64',
      version: '1.5.6-r.1',
      ...GLIBC,
    });

    const result = run(root);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('removed 1 musl-only package');
    expect(result.stdout).toContain(`@duckdb/node-bindings-linux-x64-musl@1.5.6-r.1 (${dir})`);
    expect(present(root, dir)).toBe(false);
    expect(present(root, 'node_modules/@duckdb/node-bindings-linux-x64')).toBe(true);
  });

  it('exits 0 and says so when node_modules holds no musl-only package', () => {
    const root = project();
    pkg(root, 'node_modules/zod', { name: 'zod', version: '4.6.5' });

    const result = run(root);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no musl-only packages');
    expect(present(root, 'node_modules/zod/package.json')).toBe(true);
  });

  it('exits 1 naming the directory when it has no node_modules', () => {
    const root = project(false);

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join(root, 'node_modules'));
  });
});

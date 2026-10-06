/**
 * @fileoverview Tests `scripts/clean.ts`'s default target list (issue #441).
 * The default set is derived, not literal: `dist`, `logs`, and every TypeScript
 * build-info file the project's tsconfigs write. Two shapes were missed — a
 * lane-suffixed `.tsbuildinfo.<lane>` name, and any build-info file written
 * beside a tsconfig in `config/`.
 *
 * Explicit targets pass a path guard first: a target naming the project root, a
 * path outside it, or an absolute path is refused, so a stray argument can never
 * delete what the project does not own.
 *
 * `clean.ts` roots itself at the cwd, so the scaffold is a temp directory the
 * copied script is run inside, exactly as a consumer's would be.
 *
 * @module tests/unit/scripts/clean-buildinfo.test
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts');

/** Every build-info file this repo's own tsconfig set writes, plus pre-#432 leftovers. */
const BUILD_INFO_FILES = [
  '.tsbuildinfo',
  '.tsbuildinfo.scripts',
  '.tsbuildinfo.worker',
  'config/.tsbuildinfo.scripts',
  'config/.tsbuildinfo.worker',
] as const;

/** Files that must survive a clean — a tsconfig sitting beside its build info, and source. */
const KEPT_FILES = ['config/tsconfig.worker.json', 'src/index.ts'] as const;

let dir: string;

function makeScaffold(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'clean-buildinfo-'));
  mkdirSync(resolve(root, 'scripts'));
  mkdirSync(resolve(root, 'config'));
  mkdirSync(resolve(root, 'src'));
  mkdirSync(resolve(root, 'dist'));
  mkdirSync(resolve(root, 'logs'));
  copyFileSync(resolve(SCRIPTS_DIR, 'clean.ts'), resolve(root, 'scripts', 'clean.ts'));
  writeFileSync(resolve(root, 'package.json'), '{"name":"scaffold","version":"0.0.0"}\n');
  writeFileSync(resolve(root, 'dist', 'index.js'), 'export {};\n');
  writeFileSync(resolve(root, 'logs', 'app.log'), 'log\n');
  for (const file of BUILD_INFO_FILES) writeFileSync(resolve(root, file), '{"version":"x"}\n');
  for (const file of KEPT_FILES) writeFileSync(resolve(root, file), '{}\n');
  return root;
}

function runClean(cwd: string, args: string[] = []): { code: number; out: string } {
  const result = spawnSync('bun', ['run', 'scripts/clean.ts', ...args], {
    cwd,
    encoding: 'utf-8',
  });
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

const present = (file: string): boolean => existsSync(resolve(dir, file));

describe('clean.ts build-info removal (#441)', () => {
  beforeEach(() => {
    dir = makeScaffold();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes the plain root .tsbuildinfo, as it always has', () => {
    expect(runClean(dir).code).toBe(0);
    expect(present('.tsbuildinfo')).toBe(false);
  });

  it('removes lane-suffixed build-info files left in the root', () => {
    expect(runClean(dir).code).toBe(0);
    expect(present('.tsbuildinfo.scripts')).toBe(false);
    expect(present('.tsbuildinfo.worker')).toBe(false);
  });

  it('removes build-info files written beside the tsconfigs in config/', () => {
    expect(runClean(dir).code).toBe(0);
    expect(present('config/.tsbuildinfo.scripts')).toBe(false);
    expect(present('config/.tsbuildinfo.worker')).toBe(false);
  });

  it('still removes dist and logs, and keeps config/ and its tsconfigs', () => {
    expect(runClean(dir).code).toBe(0);
    expect(present('dist')).toBe(false);
    expect(present('logs')).toBe(false);
    expect(present('config')).toBe(true);
    for (const file of KEPT_FILES) expect(present(file)).toBe(true);
  });

  it('names every removed build-info file in its announcement', () => {
    const { out } = runClean(dir);
    for (const file of BUILD_INFO_FILES) expect(out).toContain(file);
  });

  it('leaves build-info files alone when explicit positional arguments are given', () => {
    expect(runClean(dir, ['dist']).code).toBe(0);
    expect(present('dist')).toBe(false);
    expect(present('logs')).toBe(true);
    for (const file of BUILD_INFO_FILES) expect(present(file)).toBe(true);
  });

  it('succeeds in a project with no config/ directory', () => {
    rmSync(resolve(dir, 'config'), { recursive: true, force: true });
    expect(runClean(dir).code).toBe(0);
    expect(present('.tsbuildinfo')).toBe(false);
  });
});

describe('clean.ts target path guard', () => {
  /** A directory beside the scaffold, reachable from it only by leaving the project root. */
  let sibling: string;

  beforeEach(() => {
    dir = makeScaffold();
    sibling = mkdtempSync(resolve(tmpdir(), 'clean-sibling-'));
    writeFileSync(resolve(sibling, 'keep.txt'), 'keep\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(sibling, { recursive: true, force: true });
  });

  it.each([
    ['the project root itself', () => '.', 'Path escapes project root'],
    ['a parent-relative path', () => `../${basename(sibling)}`, 'Path traversal not allowed'],
    [
      'a traversal hidden behind a subdirectory',
      () => `dist/../../${basename(sibling)}`,
      'Path traversal not allowed',
    ],
    ['an absolute path', () => sibling, 'Absolute paths not allowed'],
  ])('refuses %s and deletes nothing outside the project', (_label, target, reason) => {
    const { code, out } = runClean(dir, [target()]);

    expect(code).toBe(1);
    expect(out).toContain(reason);
    expect(present('package.json')).toBe(true);
    expect(existsSync(resolve(sibling, 'keep.txt'))).toBe(true);
  });

  it('still cleans the valid targets beside a refused one', () => {
    const { code, out } = runClean(dir, ['dist', `../${basename(sibling)}`]);

    expect(code).toBe(1);
    expect(present('dist')).toBe(false);
    expect(out).toContain('✓ dist');
    expect(existsSync(resolve(sibling, 'keep.txt'))).toBe(true);
  });
});

/**
 * @fileoverview Tests for the `.husky/pre-commit` hook (issue #543). The hook
 * must pass only flags devcheck recognizes and run Biome read-only: an unknown
 * flag is ignored with a warning, leaving devcheck in auto-fix mode, where
 * `biome check --write` rewrites the working tree after the index was staged
 * and the commit records the unfixed content.
 *
 * Faithful reproduction: a throwaway git repository with this repo's hook as
 * its hooks directory, `devcheck.ts` copied under `scripts/` (it resolves its
 * root from the script location), and this repo's `node_modules` linked in for
 * the Biome binary. Assertions target the Biome check and the working tree —
 * the other checks devcheck runs have nothing real to check in the fixture.
 *
 * @module tests/unit/scripts/husky-pre-commit.test
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** A Biome-fixable formatting issue: extra spaces and no spaces around `=`. */
const FIXABLE = 'export const   x=1\n';
const CLEAN = 'export const x = 1;\n';

function git(cwd: string, args: string[]): { code: number; out: string } {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=hook-test', '-c', 'user.email=hook-test@example.com', ...args],
    { cwd, encoding: 'utf-8', env: { ...process.env, HUSKY: undefined, GIT_PARAMS: undefined } },
  );
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

/** A git repository wired to this repo's pre-commit hook, devcheck, and Biome. */
function makeRepo(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'husky-pre-commit-'));
  mkdirSync(resolve(dir, '.husky'));
  mkdirSync(resolve(dir, 'scripts'));
  mkdirSync(resolve(dir, 'src'));
  copyFileSync(resolve(ROOT, '.husky/pre-commit'), resolve(dir, '.husky/pre-commit'));
  copyFileSync(resolve(ROOT, 'scripts/devcheck.ts'), resolve(dir, 'scripts/devcheck.ts'));
  symlinkSync(resolve(ROOT, 'node_modules'), resolve(dir, 'node_modules'), 'dir');
  writeFileSync(resolve(dir, 'package.json'), '{"name":"hook-fixture","version":"0.0.0"}\n');
  // Written in Biome's own format — Biome checks its config file too.
  writeFileSync(
    resolve(dir, 'biome.json'),
    '{\n\t"files": { "includes": ["src/**"] },\n\t"javascript": { "formatter": { "quoteStyle": "single" } }\n}\n',
  );
  writeFileSync(resolve(dir, '.gitignore'), 'node_modules\n');
  expect(git(dir, ['init', '-q']).code).toBe(0);
  expect(git(dir, ['config', 'core.hooksPath', '.husky']).code).toBe(0);
  return dir;
}

/** The hook's devcheck arguments, as written in `.husky/pre-commit`. */
function hookArgs(): string[] {
  const line = readFileSync(resolve(ROOT, '.husky/pre-commit'), 'utf-8')
    .split('\n')
    .find((l) => l.includes('scripts/devcheck.ts'));
  expect(line).toBeDefined();
  return (line ?? '').split('scripts/devcheck.ts')[1]?.trim().split(/\s+/) ?? [];
}

/** The Biome check's status line from devcheck's summary. */
function biomeResult(out: string): string | undefined {
  return out.split('\n').find((l) => /Biome/.test(l) && /(PASSED|FAILED|SKIPPED)/.test(l));
}

describe('.husky/pre-commit (#543)', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeRepo();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes only flags devcheck recognizes, including --no-fix', () => {
    const args = hookArgs();
    expect(args).toContain('--no-fix');

    const help = spawnSync('bun', ['run', 'scripts/devcheck.ts', ...args, '--help'], {
      cwd: dir,
      encoding: 'utf-8',
    });
    expect(`${help.stdout}${help.stderr}`).not.toContain('Unknown flag');
  });

  it('fails a commit that stages a Biome-fixable file and leaves the working tree untouched', () => {
    writeFileSync(resolve(dir, 'src/index.ts'), FIXABLE);
    expect(git(dir, ['add', '--', 'src/index.ts', 'package.json', 'biome.json']).code).toBe(0);

    const commit = git(dir, ['commit', '-m', 'fixable']);

    expect(commit.out).not.toContain('Unknown flag');
    expect(commit.out).not.toContain('biome check --write');
    expect(biomeResult(commit.out)).toContain('FAILED');
    expect(commit.code).not.toBe(0);
    expect(readFileSync(resolve(dir, 'src/index.ts'), 'utf-8')).toBe(FIXABLE);
    expect(git(dir, ['rev-parse', '--verify', '-q', 'HEAD']).code).not.toBe(0);
  });

  it('passes the Biome check on a clean tree without writing', () => {
    writeFileSync(resolve(dir, 'src/index.ts'), CLEAN);
    expect(git(dir, ['add', '--', 'src/index.ts', 'package.json', 'biome.json']).code).toBe(0);

    const commit = git(dir, ['commit', '-m', 'clean']);

    expect(commit.out).not.toContain('Unknown flag');
    expect(biomeResult(commit.out)).toContain('PASSED');
    expect(readFileSync(resolve(dir, 'src/index.ts'), 'utf-8')).toBe(CLEAN);
  });
});

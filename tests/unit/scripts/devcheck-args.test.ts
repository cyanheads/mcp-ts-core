/**
 * @fileoverview Tests devcheck's command line (#691): arguments are validated
 * before any check runs, so a flag devcheck does not know, a positional, or an
 * `--only` value that is missing, empty, ambiguous, or names no check exits 1
 * instead of passing a run that checked less than it was asked to. `--only`
 * selects by case-insensitive substring, and a selected opt-in check runs.
 *
 * `devcheck.ts` resolves its project root from the SCRIPT location, so one temp
 * scaffold carries the copied script and recording stubs for the tools under
 * `node_modules/.bin`: a run that exits early is proven to have started nothing.
 *
 * @module tests/unit/scripts/devcheck-args.test
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts');

/** Every check devcheck defines, in summary order. */
const CHECK_NAMES = [
  'TODOs/FIXMEs',
  'Tracked Secrets',
  'MCP Definitions',
  'Packaging',
  'Framework Antipatterns',
  'Dependency Specifiers',
  'Open-Indexed Interfaces',
  'Docs Sync',
  'Skills Sync',
  'Skill Versions',
  'Changelog Sync',
  'Biome',
  'TypeScript',
  'TypeScript (Worker)',
  'Tests',
  'Unused Dependencies',
  'Security Audit',
  'Dependencies (Outdated)',
];

let dir: string;

const calls = () => resolve(dir, 'calls.log');

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'devcheck-args-'));
  for (const sub of ['scripts', 'node_modules/.bin', 'dist']) {
    mkdirSync(resolve(dir, sub), { recursive: true });
  }
  copyFileSync(resolve(SCRIPTS_DIR, 'devcheck.ts'), resolve(dir, 'scripts', 'devcheck.ts'));
  writeFileSync(resolve(dir, 'package.json'), '{"name":"scaffold","version":"0.0.0"}\n');
  // The Worker typecheck runs only with its tsconfig and a build present.
  writeFileSync(resolve(dir, 'tsconfig.worker.json'), '{}\n');
  for (const tool of ['biome', 'tsc', 'vitest', 'depcheck']) {
    writeFileSync(
      resolve(dir, 'node_modules/.bin', tool),
      `#!/bin/sh\necho "${tool} $*" >> "${calls()}"\nexit 0\n`,
      { mode: 0o755 },
    );
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(calls(), { force: true });
});

interface Run {
  /** The stubbed tools that ran, with their arguments. */
  calls: string[];
  code: number;
  out: string;
}

function devcheck(...args: string[]): Run {
  const result = spawnSync('bun', ['run', 'scripts/devcheck.ts', ...args], {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env, HUSKY: '', GIT_PARAMS: '', NO_COLOR: '1' },
  });
  return {
    calls: existsSync(calls()) ? readFileSync(calls(), 'utf-8').split('\n').filter(Boolean) : [],
    code: result.status ?? -1,
    out: `${result.stdout}${result.stderr}`,
  };
}

/** A step's summary row, which leads with its name padded to the summary column. */
function row(out: string, checkName: string): string {
  return out.split('\n').find((line) => line.startsWith(`${checkName.padEnd(25)} `)) ?? '';
}

describe('devcheck arguments (#691)', { timeout: 20_000 }, () => {
  it.each([
    { args: ['--no-fix', '--only', 'nosuchcheck'], named: 'nosuchcheck' },
    { args: ['--no-fix', '--only', 'lint'], named: 'lint' },
    { args: ['--no-fix', '--only'], named: '--only' },
    { args: ['--only', '--no-fix'], named: '--only' },
    { args: ['--no-fix', '--only='], named: '--only' },
    { args: ['--no-fix', '--tests', '--only', 'Tests'], named: '--tests' },
    { args: ['--no-fix', '--only', 'Biome', 'extra-positional'], named: 'extra-positional' },
  ])('exits 1 on $args before any check runs', ({ args, named }) => {
    const { calls, code, out } = devcheck(...args);
    // The error line itself names the argument; the usage printed after it names every option.
    expect(out.split('\n').find((line) => line.startsWith('Error:'))).toContain(named);
    expect(out).not.toContain('Checkup Summary');
    expect(out).not.toContain('All checks passed');
    expect(calls).toEqual([]);
    expect(code).toBe(1);
  });

  it('lists every check name when --only matches none', () => {
    const { code, out } = devcheck('--no-fix', '--only', 'nosuchcheck');
    for (const name of CHECK_NAMES) expect(out).toContain(name);
    expect(code).toBe(1);
  });

  it('prints usage for --help and exits 0 without running a check', () => {
    const { calls, code, out } = devcheck('--help');
    expect(out).toContain('Usage:');
    expect(out).toContain('--only <name>');
    expect(calls).toEqual([]);
    expect(code).toBe(0);
  });

  it('runs every check --only matches: typescript selects both TypeScript checks', () => {
    const { calls, code, out } = devcheck('--no-fix', '--only', 'typescript');
    expect(row(out, 'TypeScript')).toContain('PASSED');
    expect(row(out, 'TypeScript (Worker)')).toContain('PASSED');
    expect(row(out, 'Biome')).toContain('SKIPPED');
    // The checks run concurrently, so their stubs log in either order.
    expect(calls.toSorted()).toEqual([
      'tsc --noEmit',
      'tsc --project tsconfig.worker.json --noEmit',
    ]);
    expect(code).toBe(0);
  });

  it('runs an opt-in check --only names, without its enabling flag', () => {
    const { calls, code, out } = devcheck('--no-fix', '--only', 'Tests');
    expect(row(out, 'Tests')).toContain('PASSED');
    expect(calls).toEqual(['vitest run']);
    expect(code).toBe(0);
  });

  it('still requires the enabling flag for an opt-in check outside --only', () => {
    const { calls, out } = devcheck('--no-fix', '--fast', '--no-lint', '--no-types');
    expect(row(out, 'Tests')).toContain('SKIPPED');
    expect(calls).not.toContain('vitest run');
  });
});

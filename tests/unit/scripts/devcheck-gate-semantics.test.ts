/**
 * @fileoverview Tests devcheck's gate semantics across a whole run: how each
 * step's verdict folds into the exit code, which outcomes are demoted to a
 * warning, and which steps `--fast` leaves out.
 *
 * - A warning never fails the run; any failed step does.
 * - Security Audit passes low/moderate-only findings, warns when the output is
 *   not an audit report at all (registry unreachable), and fails a high/critical
 *   report it cannot attribute — the conservative fallback.
 * - Dependencies (Outdated) fails hard when `bun outdated` exits non-zero without
 *   printing its table (a lockfile or network error, not a finding).
 * - Skills Sync drift is demoted to a warning.
 * - `--fast` skips the network-bound and slow steps without running them.
 *
 * `devcheck.ts` resolves its project root from the SCRIPT location, so one temp
 * scaffold carries the copied script, stub checkers, stub `node_modules/.bin`
 * tools, and a `bun` PATH shim serving `audit`/`outdated` from fixture files.
 * Every stub records its invocation, so a skipped step is proven not to have run.
 *
 * @module tests/unit/scripts/devcheck-gate-semantics.test
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

/** Absolute path to the real bun, so the outer invocation bypasses the shim. */
const REAL_BUN = (() => {
  const found = spawnSync('which', ['bun'], { encoding: 'utf-8' }).stdout.trim();
  return found || 'bun';
})();

/** Checker scripts devcheck runs in this scaffold; the rest skip on absent inputs. */
const CHECKER_STUBS = [
  'lint-mcp.ts',
  'check-dependency-specifiers.ts',
  'check-docs-sync.ts',
  'check-skills-sync.ts',
  'check-skill-versions.ts',
] as const;

let dir: string;
let shimDir: string;

const fixture = (name: string) => resolve(dir, 'fixtures', name);

/** A checker stub that prints `message` and exits `code`. */
function stubChecker(script: (typeof CHECKER_STUBS)[number], message: string, code = 0): void {
  writeFileSync(
    resolve(dir, 'scripts', script),
    `console.log(${JSON.stringify(message)});\nprocess.exit(${code});\n`,
  );
}

/** What the `bun audit` / `bun outdated` shim prints, and its exit code. */
function servePackageManager(command: 'audit' | 'outdated', output: string, code: number): void {
  writeFileSync(fixture(`${command}.txt`), `${output}\n`);
  writeFileSync(fixture(`${command}.code`), `${code}\n`);
}

/** An executable that records its name and exits 0 — the tools under node_modules/.bin. */
function recordingTool(path: string, name: string): void {
  writeFileSync(path, `#!/bin/sh\necho ${name} >> "${fixture('calls.log')}"\nexit 0\n`, {
    mode: 0o755,
  });
}

function makeScaffold(): void {
  dir = mkdtempSync(resolve(tmpdir(), 'devcheck-gate-semantics-'));
  shimDir = resolve(dir, 'pm-shim');
  for (const sub of [
    'scripts',
    'fixtures',
    'pm-shim',
    'node_modules/.bin',
    'framework-skills/demo',
    '.claude/skills',
  ]) {
    mkdirSync(resolve(dir, sub), { recursive: true });
  }
  copyFileSync(resolve(SCRIPTS_DIR, 'devcheck.ts'), resolve(dir, 'scripts', 'devcheck.ts'));
  writeFileSync(
    resolve(dir, 'package.json'),
    `${JSON.stringify({ name: 'scaffold', version: '0.0.0', dependencies: { lodash: '^4.17.21' } })}\n`,
  );
  writeFileSync(resolve(dir, 'framework-skills/demo/SKILL.md'), '# demo\n');
  for (const tool of ['biome', 'tsc', 'depcheck']) {
    recordingTool(resolve(dir, 'node_modules/.bin', tool), tool);
  }
  writeFileSync(
    resolve(shimDir, 'bun'),
    [
      '#!/bin/sh',
      'case "$1" in',
      '  --version) echo "1.4.0" ;;',
      `  audit|outdated) echo "$1" >> "${fixture('calls.log')}"; cat "${fixture('$1.txt')}"; exit "$(cat "${fixture('$1.code')}")" ;;`,
      `  *) exec "${REAL_BUN}" "$@" ;;`,
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

interface Run {
  /** Tools and package-manager commands that actually ran. */
  calls: string[];
  code: number;
  out: string;
}

function runDevcheck(...flags: string[]): Run {
  rmSync(fixture('calls.log'), { force: true });
  const result = spawnSync(REAL_BUN, ['run', 'scripts/devcheck.ts', '--no-fix', ...flags], {
    cwd: dir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      HUSKY: '',
      GIT_PARAMS: '',
    },
  });
  const log = fixture('calls.log');
  return {
    calls: existsSync(log) ? readFileSync(log, 'utf-8').split('\n').filter(Boolean) : [],
    code: result.status ?? -1,
    out: `${result.stdout}${result.stderr}`.replace(/\u001B\[[0-9;]*m/g, ''),
  };
}

/** A step's summary row, which leads with its name padded to the summary column. */
function row(out: string, checkName: string): string {
  return out.split('\n').find((line) => line.startsWith(`${checkName.padEnd(25)} `)) ?? '';
}

/** A moderate-only report: no severity word that would route it to the classifier. */
const MODERATE_ONLY = [
  'bun audit v1.4.0 (fixture)',
  '',
  'lodash@4.17.20',
  '  (direct dependency)',
  '  moderate: Prototype pollution in lodash (<4.17.21) - https://github.com/advisories/GHSA-p6mc-m468-83gw',
  '',
  '1 vulnerability (1 moderate)',
].join('\n');

describe('devcheck gate semantics', () => {
  beforeAll(() => {
    makeScaffold();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const script of CHECKER_STUBS) stubChecker(script, 'ok');
    servePackageManager('audit', '0 vulnerabilities found', 0);
    servePackageManager('outdated', '', 0);
  });

  it('exits 0 when the only non-passing steps were demoted to warnings', () => {
    servePackageManager('audit', 'error: could not reach https://registry.npmjs.org/', 1);
    stubChecker(
      'check-skills-sync.ts',
      'framework-skills/ has drifted from its mirror (1 missing, 0 changed, 0 stale).',
      1,
    );

    const { code, out } = runDevcheck();

    expect(row(out, 'Security Audit')).toContain('WARNING');
    expect(out).toContain('Audit command failed (exit 1) — could not reach registry.');
    expect(row(out, 'Skills Sync')).toContain('WARNING');
    expect(out).toContain('   | framework-skills/ has drifted from its mirror');
    expect(row(out, 'Docs Sync')).toContain('PASSED');
    expect(code).toBe(0);
    expect(out).toContain('All checks passed!');
  });

  it('passes a moderate-only audit and fails the run on an outdated error without a table', () => {
    servePackageManager('audit', MODERATE_ONLY, 1);
    servePackageManager('outdated', 'error: lockfile had changes, but lockfile is frozen', 1);

    const { code, out } = runDevcheck();

    expect(row(out, 'Security Audit')).toContain('PASSED');
    expect(row(out, 'Dependencies (Outdated)')).toContain('FAILED');
    expect(row(out, 'Docs Sync')).toContain('PASSED');
    expect(code).toBe(1);
    expect(out).toContain('Found issues.');
  });

  it('fails a high/critical audit report it cannot attribute to any package', () => {
    servePackageManager('audit', 'bun audit v1.4.0 (fixture)\n\n1 vulnerability (1 high)', 1);

    const { code, out } = runDevcheck('--only', 'Audit');

    expect(row(out, 'Security Audit')).toContain('FAILED');
    expect(code).toBe(1);
  });

  it('skips the slow steps under --fast without running them, and runs the rest', () => {
    const { calls, code, out } = runDevcheck('--fast');

    for (const step of ['Unused Dependencies', 'Security Audit', 'Dependencies (Outdated)']) {
      expect(out).toContain(`Skipping ${step}... (Skipped in fast mode)`);
      expect(row(out, step)).toContain('SKIPPED');
    }
    expect(calls).not.toContain('audit');
    expect(calls).not.toContain('outdated');
    expect(calls).not.toContain('depcheck');
    expect(calls).toEqual(expect.arrayContaining(['biome', 'tsc']));
    expect(row(out, 'Docs Sync')).toContain('PASSED');
    expect(code).toBe(0);
  });
});

/**
 * @fileoverview Tests for the not-a-git-repository guards on devcheck's three
 * git-dependent checks (issue #243): TODOs/FIXMEs, Tracked Secrets, and Framework
 * Antipatterns. On a fresh `init` scaffold — before `git init` — `git grep` /
 * `git ls-files` exit 128 ("fatal: not a git repository"), which devcheck wrongly
 * reported as a failure rather than skipping.
 *
 * `devcheck.ts` resolves its project root from the SCRIPT location (`scripts/..`),
 * not the cwd, so the faithful reproduction copies the self-contained `devcheck.ts`
 * (it imports only `node:` builtins) into a non-git temp dir under `scripts/` and
 * runs it there — exactly how a scaffolded server ships and runs the gate. The
 * standalone `check-framework-antipatterns.ts` self-guard is tested directly.
 *
 * @module tests/unit/scripts/devcheck-git-guard.test
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts');

/** A non-git scaffold with devcheck.ts copied in, so its script-relative root has no `.git`. */
function makeScaffold(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'devcheck-git-guard-'));
  mkdirSync(resolve(dir, 'scripts'));
  mkdirSync(resolve(dir, 'src'));
  copyFileSync(resolve(SCRIPTS_DIR, 'devcheck.ts'), resolve(dir, 'scripts', 'devcheck.ts'));
  writeFileSync(resolve(dir, 'package.json'), '{"name":"scaffold","version":"0.0.0"}\n');
  writeFileSync(resolve(dir, 'src', 'index.ts'), 'export const x = 1;\n');
  return dir;
}

function runDevcheckOnly(cwd: string, only: string): { code: number; out: string } {
  const result = spawnSync('bun', ['run', 'scripts/devcheck.ts', '--only', only, '--no-fix'], {
    cwd,
    encoding: 'utf-8',
  });
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

describe('devcheck git-repo guard on a fresh scaffold (#243)', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeScaffold();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    'TODOs',
    'Tracked Secrets',
    'Framework Antipatterns',
  ])('skips %s cleanly when not a git repository (no exit-128 failure)', (check) => {
    const { code, out } = runDevcheckOnly(dir, check);
    expect(code).toBe(0);
    // The fix routes the check to the "No relevant files to check" skip path.
    expect(out).toContain('SKIPPED');
    // The pre-fix bug surfaced these — assert neither escapes.
    expect(out).not.toContain('FAILED');
    expect(out).not.toContain('not a git repository');
  });
});

describe('check-framework-antipatterns standalone self-guard (#243)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'fw-antipatterns-guard-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 with a skip notice when run directly outside a git repo', () => {
    // The script scans via `git grep` from cwd, so cwd is the non-git temp dir.
    const result = spawnSync(
      'bun',
      ['run', resolve(SCRIPTS_DIR, 'check-framework-antipatterns.ts')],
      {
        cwd: dir,
        encoding: 'utf-8',
      },
    );
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('Skipped: not a git repository.');
  });
});

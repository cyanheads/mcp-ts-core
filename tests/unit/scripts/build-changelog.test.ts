/**
 * @fileoverview Tests for scripts/build-changelog.ts — the fresh-scaffold guard
 * (issue #242). A scaffold ships `changelog/template.md` (excluded from version
 * collection) and no `<major.minor>.x/` version files, so `changelog/` exists but
 * holds nothing to roll up. Under `--check` that must skip cleanly (exit 0), not
 * throw "No per-version changelog files found". Spawns the real script against a
 * temp dir reproducing that state — the bug is process-level (throw vs. clean exit),
 * so a meaningful test exercises the actual exit path.
 * @module tests/unit/scripts/build-changelog.test
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/build-changelog.ts',
);

/** Run the real build-changelog script with `cwd` as the project root it inspects. */
function runChangelog(cwd: string, args: string[] = []): { code: number; stdout: string } {
  const result = spawnSync('bun', ['run', SCRIPT, ...args], { cwd, encoding: 'utf-8' });
  return { code: result.status ?? -1, stdout: `${result.stdout}${result.stderr}` };
}

describe('build-changelog · fresh-scaffold guard (#242)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'build-changelog-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('--check exits 0 when changelog/ holds only template.md (no version files)', () => {
    mkdirSync(resolve(dir, 'changelog'));
    // template.md is in EXCLUDED_FILES, so it never counts as a version file.
    writeFileSync(resolve(dir, 'changelog', 'template.md'), '# Template\n');

    const { code, stdout } = runChangelog(dir, ['--check']);

    expect(code).toBe(0);
    expect(stdout).toContain('Skipped: no per-version changelog files');
    // The pre-fix failure threw this — assert it does NOT surface.
    expect(stdout).not.toContain('No per-version changelog files found under');
  });

  it('--check exits 0 when changelog/ exists but is empty', () => {
    mkdirSync(resolve(dir, 'changelog'));

    const { code, stdout } = runChangelog(dir, ['--check']);

    expect(code).toBe(0);
    expect(stdout).toContain('Skipped: no per-version changelog files');
  });

  it('--check still validates a populated changelog (drift fails, not skipped)', () => {
    mkdirSync(resolve(dir, 'changelog', '0.1.x'), { recursive: true });
    writeFileSync(
      resolve(dir, 'changelog', '0.1.x', '0.1.0.md'),
      '---\nsummary: "First release"\n---\n\n# 0.1.0 — 2026-01-01\n\n## Added\n\n- Initial release.\n',
    );
    // No CHANGELOG.md present → --check sees drift and fails (proves the skip
    // guard didn't swallow real version files).
    const { code } = runChangelog(dir, ['--check']);
    expect(code).toBe(1);
  });
});

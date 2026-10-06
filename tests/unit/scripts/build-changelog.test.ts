/**
 * @fileoverview Tests for scripts/build-changelog.ts. The first suite is the
 * fresh-scaffold guard (issue #242). A scaffold ships `changelog/template.md` (excluded from version
 * collection) and no `<major.minor>.x/` version files, so `changelog/` exists but
 * holds nothing to roll up. Under `--check` that must skip cleanly (exit 0), not
 * throw "No per-version changelog files found". Spawns the real script against a
 * temp dir reproducing that state — the bug is process-level (throw vs. clean exit),
 * so a meaningful test exercises the actual exit path.
 *
 * The second suite is the rollup contract CLAUDE.md states for `changelog:check`:
 * entry rendering and semver ordering, the Breaking-then-Security badge order, the
 * 350-character summary cap, strict `true`/`false` flags, the H1 date, and a missing
 * `summary` key warning without failing.
 * @module tests/unit/scripts/build-changelog.test
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const HEADER =
  '# Changelog\n\nAll notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).\n';

describe('build-changelog · rollup contract', () => {
  let dir: string;

  /** Writes `changelog/<major.minor>.x/<version>.md` with the given frontmatter lines. */
  function release(version: string, frontmatter: string[], date = '2026-01-01'): void {
    const series = `${version.split('.').slice(0, 2).join('.')}.x`;
    mkdirSync(resolve(dir, 'changelog', series), { recursive: true });
    writeFileSync(
      resolve(dir, 'changelog', series, `${version}.md`),
      `---\n${frontmatter.join('\n')}\n---\n\n# ${version} — ${date}\n\n## Added\n\n- A change.\n`,
    );
  }

  const rollup = () => readFileSync(resolve(dir, 'CHANGELOG.md'), 'utf-8');

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'build-changelog-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders a linked, dated, newest-first index that --check then accepts', () => {
    release('0.1.0', ['summary: "First release"']);
    release('0.2.0', ["summary: 'Second release'"], '2026-02-01');

    expect(runChangelog(dir).code).toBe(0);
    expect(rollup()).toBe(
      `${HEADER}\n## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-02-01\n\nSecond release\n\n` +
        '## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-01-01\n\nFirst release\n',
    );

    const check = runChangelog(dir, ['--check']);
    expect(check.code).toBe(0);
    expect(check.stdout).toContain('CHANGELOG.md is in sync with changelog/ directory.');

    release('0.2.0', ['summary: "Second release, reworded"'], '2026-02-01');
    expect(runChangelog(dir, ['--check']).code).toBe(1);
  });

  it('orders versions numerically, ranking a release above its prerelease', () => {
    for (const version of ['0.5.9', '0.6.0-rc.1', '0.5.10', '0.6.0']) {
      release(version, [`summary: "${version} release"`]);
    }

    expect(runChangelog(dir).code).toBe(0);
    const order = [...rollup().matchAll(/^## \[([^\]]+)\]/gm)].map((match) => match[1]);
    expect(order).toEqual(['0.6.0', '0.6.0-rc.1', '0.5.10', '0.5.9']);
  });

  it('renders the Breaking badge before the Security badge, and only for true', () => {
    release('0.1.0', ['summary: "Both"', 'security: true', 'breaking: true']);
    release('0.1.1', ['summary: "Security only"', 'breaking: false', 'security: true']);
    release('0.1.2', ['summary: "Neither"', 'breaking: false', 'security: false']);

    expect(runChangelog(dir).code).toBe(0);
    const headers = rollup()
      .split('\n')
      .filter((line) => line.startsWith('## '));
    expect(headers).toEqual([
      '## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-01-01',
      '## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-01-01 · 🛡️ Security',
      '## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-01-01 · ⚠️ Breaking · 🛡️ Security',
    ]);
  });

  it('accepts a 350-character summary and fails --check on a 351-character one', () => {
    release('0.1.0', [`summary: "${'a'.repeat(350)}"`]);
    expect(runChangelog(dir).code).toBe(0);
    expect(rollup()).toContain(`\n${'a'.repeat(350)}\n`);

    release('0.1.1', [`summary: "${'b'.repeat(351)}"`]);
    const { code, stdout } = runChangelog(dir, ['--check']);
    expect(code).not.toBe(0);
    expect(stdout).toContain('changelog/0.1.x/0.1.1.md: summary is 351 chars, exceeds cap of 350.');
  });

  it.each([
    ['breaking', 'yes'],
    ['security', 'True'],
  ])('fails --check when %s is %s rather than true or false', (key, value) => {
    release('0.1.0', ['summary: "Flagged"', `${key}: ${value}`]);

    const { code, stdout } = runChangelog(dir, ['--check']);

    expect(code).not.toBe(0);
    expect(stdout).toContain(`${key} must be 'true' or 'false', got '${value}'.`);
  });

  it('fails when the H1 heading carries no release date', () => {
    mkdirSync(resolve(dir, 'changelog', '0.1.x'), { recursive: true });
    writeFileSync(
      resolve(dir, 'changelog', '0.1.x', '0.1.0.md'),
      '---\nsummary: "Undated"\n---\n\n# 0.1.0\n',
    );

    const { code, stdout } = runChangelog(dir, ['--check']);

    expect(code).not.toBe(0);
    expect(stdout).toContain('changelog/0.1.x/0.1.0.md: H1 heading missing or malformed.');
  });

  it('renders an entry with no summary key header-only and warns without failing', () => {
    release('0.1.0', ['breaking: false']);

    const { code, stdout } = runChangelog(dir);

    expect(code).toBe(0);
    expect(rollup()).toBe(`${HEADER}\n## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-01-01\n`);
    expect(stdout).toContain("1 file(s) missing 'summary' frontmatter:");
    expect(stdout).toContain('  - changelog/0.1.x/0.1.0.md');
    expect(runChangelog(dir, ['--check']).code).toBe(0);
  });
});

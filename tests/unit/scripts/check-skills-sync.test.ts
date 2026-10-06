/**
 * @fileoverview Tests for scripts/check-skills-sync.ts. The core check is one-way
 * propagation from `framework-skills/` to the `.agents/skills` and `.claude/skills`
 * mirrors: a file missing from a mirror, a mirror file whose content differs, and a
 * mirror-only framework skill (`audience: external`) left behind after an upstream
 * removal are each drift; a mirror-only skill of the project's own is not, and
 * `devcheck.config.json` `skillsSync.ignore` silences named paths.
 *
 * The second suite is the pre-0.13 `skills/` tree guard. `init` run in place never overwrites an existing file, so upgrading a
 * pre-0.13 scaffold creates `framework-skills/` and leaves the old copies where a
 * plugin host still auto-loads them. The check has to report that leftover tree, not
 * just the not-yet-migrated one. Spawns the real script against a temp project root,
 * since the script reads the filesystem and exits.
 * @module tests/unit/scripts/check-skills-sync.test
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/check-skills-sync.ts',
);

/** Write a `<root>/<tree>/<name>/SKILL.md`; `audience` marks it framework-managed. */
function writeSkill(root: string, tree: string, name: string, audience = 'external'): void {
  mkdirSync(resolve(root, tree, name), { recursive: true });
  writeFileSync(
    resolve(root, tree, name, 'SKILL.md'),
    `---\nname: ${name}\nmetadata:\n  version: "1.0"\n  audience: ${audience}\n---\n\nBody.\n`,
  );
}

function runCheck(cwd: string): { code: number; stdout: string } {
  const result = spawnSync('bun', ['run', SCRIPT], { cwd, encoding: 'utf-8' });
  return { code: result.status ?? -1, stdout: `${result.stdout}${result.stderr}` };
}

/** Writes `<root>/<relPath>`, creating parent directories. */
function writeFileAt(root: string, relPath: string, content: string): void {
  mkdirSync(dirname(resolve(root, relPath)), { recursive: true });
  writeFileSync(resolve(root, relPath), content);
}

describe('check-skills-sync · mirror drift', () => {
  let dir: string;

  /** A canonical skill with a reference file, copied verbatim into both mirrors. */
  function seedInSync(): void {
    for (const tree of ['framework-skills', '.agents/skills', '.claude/skills']) {
      writeSkill(dir, tree, 'add-tool');
      writeFileAt(dir, `${tree}/add-tool/references/patterns.md`, '# Patterns\n');
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'check-skills-sync-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes when both mirrors match framework-skills/ file for file', () => {
    seedInSync();

    const { code, stdout } = runCheck(dir);

    expect(code).toBe(0);
    expect(stdout).toContain(
      'framework-skills/ is in sync with .agents/skills and .claude/skills.',
    );
  });

  it('skips when no mirror directory exists', () => {
    writeSkill(dir, 'framework-skills', 'add-tool');

    const { code, stdout } = runCheck(dir);

    expect(code).toBe(0);
    expect(stdout).toContain('Skipped: no skill mirrors');
  });

  it('reports a canonical file missing from one mirror', () => {
    seedInSync();
    rmSync(resolve(dir, '.claude/skills/add-tool/references'), { recursive: true });

    const { code, stdout } = runCheck(dir);

    expect(code).toBe(1);
    expect(stdout).toContain('(1 missing, 0 changed, 0 stale)');
    expect(stdout).toContain('Missing in .claude/skills/:\n  - add-tool/references/patterns.md');
    expect(stdout).not.toContain('Missing in .agents/skills/');
  });

  it('reports a mirror file whose content differs from the canonical copy', () => {
    seedInSync();
    writeFileAt(dir, '.agents/skills/add-tool/references/patterns.md', '# Stale patterns\n');

    const { code, stdout } = runCheck(dir);

    expect(code).toBe(1);
    expect(stdout).toContain('(0 missing, 1 changed, 0 stale)');
    expect(stdout).toContain(
      'Content differs in .agents/skills/:\n  - add-tool/references/patterns.md',
    );
  });

  it('reports a mirror-only framework skill as stale, but leaves the project’s own alone', () => {
    seedInSync();
    writeSkill(dir, '.claude/skills', 'removed-upstream');
    writeSkill(dir, '.claude/skills', 'team-runbook', 'internal');

    const { code, stdout } = runCheck(dir);

    expect(code).toBe(1);
    expect(stdout).toContain('(0 missing, 0 changed, 1 stale)');
    expect(stdout).toContain(
      'Stale framework skill (deleted upstream) in .claude/skills/:\n  - removed-upstream',
    );
    expect(stdout).not.toContain('team-runbook');
  });

  it.each([
    ['a bare skill name', 'add-tool'],
    ['a single file path', 'add-tool/references/patterns.md'],
  ])('silences drift named by %s in skillsSync.ignore', (_label, pattern) => {
    seedInSync();
    writeFileAt(dir, '.agents/skills/add-tool/references/patterns.md', '# Local edit\n');
    writeFileAt(dir, 'devcheck.config.json', JSON.stringify({ skillsSync: { ignore: [pattern] } }));

    const { code, stdout } = runCheck(dir);

    expect(code).toBe(0);
    expect(stdout).toContain('is in sync');
  });

  it('ignores OS cruft such as .DS_Store by default', () => {
    seedInSync();
    writeFileAt(dir, 'framework-skills/add-tool/.DS_Store', 'cruft');

    const { code, stdout } = runCheck(dir);

    expect(code).toBe(0);
    expect(stdout).toContain('is in sync');
  });
});

describe('check-skills-sync · pre-0.13 skills/ tree', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'check-skills-sync-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports an unmigrated tree when framework-skills/ is absent', () => {
    writeSkill(dir, 'skills', 'add-tool');

    const { code, stdout } = runCheck(dir);

    expect(code).toBe(1);
    expect(stdout).toContain('git mv skills framework-skills');
  });

  it('reports a leftover tree when both trees carry the same framework skill', () => {
    writeSkill(dir, 'framework-skills', 'add-tool');
    writeSkill(dir, '.claude/skills', 'add-tool');
    writeSkill(dir, 'skills', 'add-tool');

    const { code, stdout } = runCheck(dir);

    expect(code).toBe(1);
    expect(stdout).toContain('rm -rf skills/add-tool');
  });

  it('leaves a skills/ tree of the server’s own published skills alone', () => {
    writeSkill(dir, 'framework-skills', 'add-tool');
    writeSkill(dir, '.claude/skills', 'add-tool');
    writeSkill(dir, 'skills', 'domain-lookup');

    const { code, stdout } = runCheck(dir);

    expect(code).toBe(0);
    expect(stdout).toContain('in sync');
  });
});

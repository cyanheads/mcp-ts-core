/**
 * @fileoverview Tests for scripts/check-skills-sync.ts — the pre-0.13 `skills/` tree
 * guard. `init` run in place never overwrites an existing file, so upgrading a
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

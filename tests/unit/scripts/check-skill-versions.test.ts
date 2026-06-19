/**
 * @fileoverview Tests for scripts/check-skill-versions.ts — the worktree-deleted
 * SKILL.md guard (issue #237). `git diff --name-only HEAD` lists deleted files and
 * `git show HEAD:<path>` still returns the blob, so the loop reached
 * `readFileSync` on a path no longer on disk and crashed with ENOENT. The
 * framework's own `maintenance` skill deletes upstream-pruned skills, so this is
 * hit on every such pass until committed. Spawns the real script against a temp git
 * repo reproducing the deletion — the bug is a process-level crash, so the test
 * asserts a clean exit, not a thrown stack trace.
 * @module tests/unit/scripts/check-skill-versions.test
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/check-skill-versions.ts',
);

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function writeSkill(dir: string, name: string, version: string, body: string): void {
  mkdirSync(resolve(dir, 'skills', name), { recursive: true });
  writeFileSync(
    resolve(dir, 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\nmetadata:\n  version: "${version}"\n---\n\n${body}\n`,
  );
}

/** Run the real check against `cwd` as the project root it inspects. */
function runCheck(cwd: string): { code: number; stdout: string } {
  const result = spawnSync('bun', ['run', SCRIPT], { cwd, encoding: 'utf-8' });
  return { code: result.status ?? -1, stdout: `${result.stdout}${result.stderr}` };
}

describe('check-skill-versions · worktree-deleted skill (#237)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'check-skill-versions-'));
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips a SKILL.md deleted from the worktree instead of crashing on ENOENT', () => {
    writeSkill(dir, 'doomed', '1.0', 'Body to be pruned.');
    writeSkill(dir, 'kept', '1.0', 'Surviving body.');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'seed skills']);

    // Mirror the maintenance-skill prune: remove a tracked skill from the worktree.
    git(dir, ['rm', 'skills/doomed/SKILL.md']);

    const { code, stdout } = runCheck(dir);

    expect(code).toBe(0);
    expect(stdout).toContain('Skill versions are in step with body changes.');
    // The pre-fix failure crashed reading the deleted file — assert no ENOENT escapes.
    expect(stdout).not.toContain('ENOENT');
  });

  it('still flags a real version-bump violation on a surviving skill', () => {
    writeSkill(dir, 'doomed', '1.0', 'Body to be pruned.');
    writeSkill(dir, 'kept', '1.0', 'Original body.');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'seed skills']);

    // Delete one (the guarded path) and change another's body without bumping.
    git(dir, ['rm', 'skills/doomed/SKILL.md']);
    writeSkill(dir, 'kept', '1.0', 'Changed body, version not bumped.');

    const { code, stdout } = runCheck(dir);

    expect(code).toBe(1);
    expect(stdout).toContain('skills/kept/SKILL.md');
    expect(stdout).not.toContain('skills/doomed/SKILL.md');
    expect(stdout).not.toContain('ENOENT');
  });
});

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
  mkdirSync(resolve(dir, 'framework-skills', name), { recursive: true });
  writeFileSync(
    resolve(dir, 'framework-skills', name, 'SKILL.md'),
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
    git(dir, ['rm', 'framework-skills/doomed/SKILL.md']);

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
    git(dir, ['rm', 'framework-skills/doomed/SKILL.md']);
    writeSkill(dir, 'kept', '1.0', 'Changed body, version not bumped.');

    const { code, stdout } = runCheck(dir);

    expect(code).toBe(1);
    expect(stdout).toContain('framework-skills/kept/SKILL.md');
    expect(stdout).not.toContain('framework-skills/doomed/SKILL.md');
    expect(stdout).not.toContain('ENOENT');
  });
});

describe('check-skill-versions · one step per release', () => {
  let dir: string;

  /** Seed a repo whose last release tag holds `framework-skills/kept` at 1.0. */
  function seedRelease(packageName: string): void {
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: packageName }));
    writeSkill(dir, 'kept', '1.0', 'Released body.');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'release']);
    git(dir, ['tag', '--no-sign', '-a', 'v0.1.0', '-m', 'release']);
  }

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'check-skill-versions-'));
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a single minor step past the last release tag', () => {
    seedRelease('@cyanheads/mcp-ts-core');
    writeSkill(dir, 'kept', '1.1', 'Edited body.');

    const { code, stdout } = runCheck(dir);

    expect(code).toBe(0);
    expect(stdout).toContain('Skill versions are in step with body changes.');
  });

  it('accepts a single major step to X.0', () => {
    seedRelease('@cyanheads/mcp-ts-core');
    writeSkill(dir, 'kept', '2.0', 'Restructured body.');

    expect(runCheck(dir).code).toBe(0);
  });

  it('flags a skill bumped more than one step since the last release tag', () => {
    seedRelease('@cyanheads/mcp-ts-core');
    writeSkill(dir, 'kept', '1.3', 'Edited three times, bumped three times.');

    const { code, stdout } = runCheck(dir);

    expect(code).toBe(1);
    expect(stdout).toContain('framework-skills/kept/SKILL.md');
    expect(stdout).toContain('"1.0" at v0.1.0');
    expect(stdout).toContain('"1.3"');
  });

  it('flags an overshoot already committed after the tag', () => {
    seedRelease('@cyanheads/mcp-ts-core');
    writeSkill(dir, 'kept', '1.1', 'First edit.');
    git(dir, ['commit', '-am', 'docs: first edit']);
    writeSkill(dir, 'kept', '1.2', 'Second edit.');
    git(dir, ['commit', '-am', 'docs: second edit']);

    const { code, stdout } = runCheck(dir);

    expect(code).toBe(1);
    expect(stdout).toContain('"1.2"');
  });

  it('lets a later edit share the bump an earlier commit in the cycle made', () => {
    seedRelease('@cyanheads/mcp-ts-core');
    writeSkill(dir, 'kept', '1.1', 'First edit.');
    git(dir, ['commit', '-am', 'docs: first edit']);
    writeSkill(dir, 'kept', '1.1', 'Second edit, same release.');

    const { code, stdout } = runCheck(dir);

    expect(code).toBe(0);
    expect(stdout).toContain('Skill versions are in step with body changes.');
  });

  it('still flags an unbumped edit when the skill has not moved since the tag', () => {
    seedRelease('@cyanheads/mcp-ts-core');
    writeSkill(dir, 'kept', '1.0', 'Edited body, no bump.');

    const { code, stdout } = runCheck(dir);

    expect(code).toBe(1);
    expect(stdout).toContain('metadata.version is still "1.0"');
  });

  it('lets a consumer repo take a multi-step jump from a skill sync', () => {
    seedRelease('some-mcp-server');
    writeSkill(dir, 'kept', '1.5', 'Synced from a newer framework release.');

    expect(runCheck(dir).code).toBe(0);
  });

  it('skips the step check when no release tag exists', () => {
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: '@cyanheads/mcp-ts-core' }));
    writeSkill(dir, 'kept', '1.0', 'Body.');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'seed']);
    writeSkill(dir, 'kept', '1.4', 'Edited body.');

    expect(runCheck(dir).code).toBe(0);
  });
});

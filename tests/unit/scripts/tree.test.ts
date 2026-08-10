/**
 * @fileoverview Tests for scripts/tree.ts gitignore matching — specifically that
 * directory-only patterns (written with a trailing slash, e.g. `/data/` or
 * `.claude/`) exclude the directory they name. The `ignore` package decides a
 * path is a directory from a trailing slash on the path it is given, so the
 * matcher has to be told; without it, every directory-only pattern silently
 * matched nothing and the directory landed in the generated `docs/tree.md`.
 * Spawns the real script with `--dry-run` against a temp project so the assertion
 * is on the tree the script actually prints.
 * @module tests/unit/scripts/tree.test
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/tree.ts');

function writeFileAt(root: string, relPath: string, content = 'x\n'): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Run the real script in dry-run mode against `cwd` and return the printed tree. */
function runTree(cwd: string): string {
  const result = spawnSync('bun', ['run', SCRIPT, '--dry-run'], { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`tree.ts failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout;
}

describe('tree.ts · gitignore directory patterns', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'tree-script-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('excludes directories matched by trailing-slash patterns', () => {
    writeFileSync(
      join(dir, '.gitignore'),
      ['/data/', '.claude/', 'src/generated/', 'stray', ''].join('\n'),
    );
    writeFileAt(dir, 'data/cache.sqlite');
    writeFileAt(dir, '.claude/skills/setup/SKILL.md');
    writeFileAt(dir, 'src/generated/schema.ts');
    writeFileAt(dir, 'src/index.ts');
    writeFileAt(dir, 'README.md');

    const tree = runTree(dir);

    expect(tree).not.toContain('data/');
    expect(tree).not.toContain('.claude/');
    expect(tree).not.toContain('generated/');
    expect(tree).toContain('src/');
    expect(tree).toContain('index.ts');
    expect(tree).toContain('README.md');
  });

  it('keeps a file whose name matches a directory-only pattern', () => {
    writeFileSync(join(dir, '.gitignore'), ['/artifacts/', ''].join('\n'));
    writeFileAt(dir, 'artifacts');

    const tree = runTree(dir);

    expect(tree).toContain('artifacts');
  });

  it('still excludes both a file and a directory for a slashless pattern', () => {
    writeFileSync(join(dir, '.gitignore'), ['stray', ''].join('\n'));
    writeFileAt(dir, 'stray/inner.txt');
    writeFileAt(dir, 'nested/stray');
    writeFileAt(dir, 'nested/kept.txt');

    const tree = runTree(dir);

    expect(tree).not.toContain('stray');
    expect(tree).toContain('kept.txt');
  });

  it('excludes a nested directory named by an unanchored trailing-slash pattern', () => {
    writeFileSync(join(dir, '.gitignore'), ['tmpdata/', ''].join('\n'));
    writeFileAt(dir, 'src/deep/tmpdata/blob.bin');
    writeFileAt(dir, 'src/deep/keep.ts');

    const tree = runTree(dir);

    expect(tree).not.toContain('tmpdata/');
    expect(tree).toContain('keep.ts');
  });
});

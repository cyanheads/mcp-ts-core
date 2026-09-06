/**
 * @fileoverview Tests devcheck's gate predicate for the Packaging step (issue
 * #343). The step used to run only when `manifest.json` or a plugin manifest
 * existed, so a project carrying just an `.mcpbignore` — the framework itself —
 * never had its bundle-content guards checked, and three unanchored dev-dir
 * patterns sat undetected behind a green `devcheck`.
 *
 * `devcheck.ts` resolves its project root from the SCRIPT location
 * (`scripts/..`), not the cwd, so the faithful reproduction copies both
 * self-contained scripts (they import only `node:` builtins) into a temp dir and
 * runs the gate there, exactly as a scaffolded server would.
 *
 * @module tests/unit/scripts/devcheck-packaging-gate.test
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts');

/** A scaffold carrying devcheck plus the packaging linter it shells out to. */
function makeScaffold(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'devcheck-packaging-gate-'));
  mkdirSync(resolve(dir, 'scripts'));
  mkdirSync(resolve(dir, 'src'));
  for (const script of ['devcheck.ts', 'lint-packaging.ts']) {
    copyFileSync(resolve(SCRIPTS_DIR, script), resolve(dir, 'scripts', script));
  }
  writeFileSync(resolve(dir, 'package.json'), '{"name":"scaffold","version":"0.0.0"}\n');
  writeFileSync(resolve(dir, 'src', 'index.ts'), 'export const x = 1;\n');
  return dir;
}

function runPackagingCheck(cwd: string): { code: number; out: string } {
  const result = spawnSync(
    'bun',
    ['run', 'scripts/devcheck.ts', '--only', 'Packaging', '--no-fix'],
    { cwd, encoding: 'utf-8' },
  );
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

/**
 * The step's own summary row, isolated from the `--only` skip notices that also
 * name it. Colour codes are stripped so the row matches on its leading label.
 */
function packagingLine(out: string): string {
  const plain = out.replace(/\u001B\[[0-9;]*m/g, '');
  return plain.split('\n').find((line) => line.startsWith('Packaging')) ?? '';
}

describe('devcheck Packaging gate (#343)', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeScaffold();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips cleanly with no manifest, plugin manifest, or .mcpbignore', () => {
    const { code, out } = runPackagingCheck(dir);
    expect(code).toBe(0);
    expect(packagingLine(out)).toContain('SKIPPED');
  });

  it('runs on an .mcpbignore alone and fails an unanchored dev-dir pattern', () => {
    writeFileSync(resolve(dir, '.mcpbignore'), 'skills/\n');
    const { code, out } = runPackagingCheck(dir);
    expect(code).not.toBe(0);
    expect(packagingLine(out)).not.toContain('SKIPPED');
    expect(out).toContain('unanchored pattern');
  });

  it('passes on an .mcpbignore whose dev-dir patterns are root-anchored', () => {
    writeFileSync(resolve(dir, '.mcpbignore'), '/skills/\n/.claude/\n/.agents/\n');
    const { code, out } = runPackagingCheck(dir);
    expect(code).toBe(0);
    expect(packagingLine(out)).not.toContain('SKIPPED');
    expect(out).toContain('Packaging alignment OK.');
  });
});

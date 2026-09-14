/**
 * @fileoverview Tests how `scripts/build.ts` resolves the tsconfig it compiles
 * (issue #440). The script ships to consumers verbatim, and the two layouts it
 * has to serve disagree: this repo keeps its project tsconfigs in `config/`
 * (#432) while the `init` scaffold writes `tsconfig.build.json` at the root, so
 * a hardcoded default fails one of them on the first `bun run build`.
 *
 * `build.ts` roots itself at the SCRIPT location and invokes
 * `node_modules/.bin/tsc` / `tsc-alias` from there, so the scaffold is a temp
 * project carrying the copied script and two recording shims — the argv they
 * capture is what the script actually asked the compiler to build.
 *
 * @module tests/unit/scripts/build-project-resolution.test
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts');

const TSCONFIG_BODY = `${JSON.stringify({ compilerOptions: { outDir: 'dist' } })}\n`;

let dir: string;

/**
 * A project carrying `build.ts` and shims for the two binaries it drives. Each
 * shim appends `<tool> <argv>` to a log and fails the way `tsc` does when the
 * `-p` path does not exist, so a wrong default is a loud failure, not a silent
 * fallback.
 */
function makeScaffold(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'build-project-resolution-'));
  mkdirSync(resolve(root, 'scripts'));
  mkdirSync(resolve(root, 'node_modules', '.bin'), { recursive: true });
  copyFileSync(resolve(SCRIPTS_DIR, 'build.ts'), resolve(root, 'scripts', 'build.ts'));
  writeFileSync(resolve(root, 'package.json'), '{"name":"scaffold","version":"0.0.0"}\n');

  const log = resolve(root, 'invocations.log');
  for (const tool of ['tsc', 'tsc-alias']) {
    writeFileSync(
      resolve(root, 'node_modules', '.bin', tool),
      [
        '#!/bin/sh',
        `echo "${tool} $*" >> "${log}"`,
        'if [ ! -f "$2" ]; then',
        `  echo "error TS5058: The specified path does not exist: '$2'." >&2`,
        '  exit 2',
        'fi',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
  }
  return root;
}

function writeTsconfig(relativePath: string): void {
  const target = resolve(dir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, TSCONFIG_BODY);
}

function runBuild(args: string[] = []): { code: number; invocations: string[]; out: string } {
  const result = spawnSync('bun', ['run', 'scripts/build.ts', ...args], {
    cwd: dir,
    encoding: 'utf-8',
  });
  const logPath = resolve(dir, 'invocations.log');
  return {
    code: result.status ?? -1,
    invocations: existsSync(logPath)
      ? readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)
      : [],
    out: `${result.stdout}${result.stderr}`,
  };
}

describe('build.ts tsconfig resolution (#440)', () => {
  beforeEach(() => {
    dir = makeScaffold();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds a scaffold that keeps tsconfig.build.json at the root', () => {
    writeTsconfig('tsconfig.build.json');
    const { code, invocations, out } = runBuild();
    expect(out).toContain('tsconfig: tsconfig.build.json');
    expect(invocations).toEqual(['tsc -p tsconfig.build.json', 'tsc-alias -p tsconfig.build.json']);
    expect(code).toBe(0);
  });

  it('builds a project that keeps its tsconfigs in config/', () => {
    writeTsconfig('config/tsconfig.build.json');
    const { code, invocations } = runBuild();
    expect(invocations).toEqual([
      'tsc -p config/tsconfig.build.json',
      'tsc-alias -p config/tsconfig.build.json',
    ]);
    expect(code).toBe(0);
  });

  it('prefers config/ when a project carries both', () => {
    writeTsconfig('config/tsconfig.build.json');
    writeTsconfig('tsconfig.build.json');
    const { code, invocations } = runBuild();
    expect(invocations[0]).toBe('tsc -p config/tsconfig.build.json');
    expect(code).toBe(0);
  });

  it('fails loudly when neither location has a build tsconfig', () => {
    const { code, out } = runBuild();
    expect(code).not.toBe(0);
    expect(out).toContain('tsconfig.build.json');
  });

  it('passes an explicit --project through verbatim, over either default', () => {
    writeTsconfig('config/tsconfig.build.json');
    writeTsconfig('custom/tsconfig.release.json');
    const { code, invocations, out } = runBuild(['--project', 'custom/tsconfig.release.json']);
    expect(out).toContain('tsconfig: custom/tsconfig.release.json');
    expect(invocations).toEqual([
      'tsc -p custom/tsconfig.release.json',
      'tsc-alias -p custom/tsconfig.release.json',
    ]);
    expect(code).toBe(0);
  });

  it('still fails on an explicit --project naming a file that does not exist', () => {
    writeTsconfig('config/tsconfig.build.json');
    const { code, invocations, out } = runBuild(['--project', 'nope.json']);
    expect(invocations).toEqual(['tsc -p nope.json']);
    expect(out).toContain('nope.json');
    expect(code).not.toBe(0);
  });

  it('does not run tsc-alias when tsc fails', () => {
    const { invocations } = runBuild(['--project', 'nope.json']);
    expect(invocations.some((line) => line.startsWith('tsc-alias'))).toBe(false);
  });
});

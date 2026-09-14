/**
 * @fileoverview Tests devcheck's TypeScript (Worker) step gate (issue #440).
 * The step guarded on `config/tsconfig.worker.json` alone, so a project keeping
 * its worker tsconfig at the root rendered `⚪ SKIPPED` with the generic
 * "No relevant files to check" reason — indistinguishable from a project with
 * no Workers lane, and never a failure.
 *
 * `devcheck.ts` resolves its project root from the SCRIPT location, so the
 * scaffold is a temp project carrying the copied script and a `tsc` shim whose
 * recorded argv is what the step actually asked the compiler to check.
 *
 * @module tests/unit/scripts/devcheck-worker-tsconfig.test
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

let dir: string;

/** A scaffold carrying devcheck, a built `dist/`, and a recording `tsc` shim. */
function makeScaffold(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'devcheck-worker-tsconfig-'));
  mkdirSync(resolve(root, 'scripts'));
  mkdirSync(resolve(root, 'dist'));
  mkdirSync(resolve(root, 'node_modules', '.bin'), { recursive: true });
  copyFileSync(resolve(SCRIPTS_DIR, 'devcheck.ts'), resolve(root, 'scripts', 'devcheck.ts'));
  writeFileSync(resolve(root, 'package.json'), '{"name":"scaffold","version":"0.0.0"}\n');
  writeFileSync(resolve(root, 'dist', 'index.js'), 'export {};\n');
  writeFileSync(
    resolve(root, 'node_modules', '.bin', 'tsc'),
    ['#!/bin/sh', `echo "tsc $*" >> "${resolve(root, 'invocations.log')}"`, 'exit 0', ''].join(
      '\n',
    ),
    { mode: 0o755 },
  );
  return root;
}

function writeWorkerTsconfig(relativePath: string): void {
  const target = resolve(dir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify({ compilerOptions: { noEmit: true } })}\n`);
}

function runWorkerCheck(): { code: number; invocations: string[]; row: string } {
  const result = spawnSync('bun', ['run', 'scripts/devcheck.ts', '--only', 'Worker', '--no-fix'], {
    cwd: dir,
    encoding: 'utf-8',
  });
  const plain = `${result.stdout}${result.stderr}`.replace(/\[[0-9;]*m/g, '');
  const logPath = resolve(dir, 'invocations.log');
  return {
    code: result.status ?? -1,
    invocations: existsSync(logPath)
      ? readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)
      : [],
    row: plain.split('\n').find((line) => line.startsWith('TypeScript (Worker)')) ?? '',
  };
}

describe('devcheck TypeScript (Worker) tsconfig gate (#440)', () => {
  beforeEach(() => {
    dir = makeScaffold();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('checks a worker tsconfig kept in config/', () => {
    writeWorkerTsconfig('config/tsconfig.worker.json');
    const { code, invocations, row } = runWorkerCheck();
    expect(invocations).toEqual(['tsc --project config/tsconfig.worker.json --noEmit']);
    expect(row).not.toContain('SKIPPED');
    expect(code).toBe(0);
  });

  it('checks a worker tsconfig kept at the project root', () => {
    writeWorkerTsconfig('tsconfig.worker.json');
    const { code, invocations, row } = runWorkerCheck();
    expect(invocations).toEqual(['tsc --project tsconfig.worker.json --noEmit']);
    expect(row).not.toContain('SKIPPED');
    expect(code).toBe(0);
  });

  it('prefers config/ when a project carries both', () => {
    writeWorkerTsconfig('config/tsconfig.worker.json');
    writeWorkerTsconfig('tsconfig.worker.json');
    expect(runWorkerCheck().invocations).toEqual([
      'tsc --project config/tsconfig.worker.json --noEmit',
    ]);
  });

  it('skips cleanly when neither location has a worker tsconfig', () => {
    const { code, invocations, row } = runWorkerCheck();
    expect(row).toContain('SKIPPED');
    expect(invocations).toEqual([]);
    expect(code).toBe(0);
  });

  it('skips until there is a build to check against', () => {
    writeWorkerTsconfig('config/tsconfig.worker.json');
    rmSync(resolve(dir, 'dist'), { recursive: true, force: true });
    const { code, invocations, row } = runWorkerCheck();
    expect(row).toContain('SKIPPED');
    expect(invocations).toEqual([]);
    expect(code).toBe(0);
  });
});

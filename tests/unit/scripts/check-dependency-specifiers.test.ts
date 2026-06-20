/**
 * @fileoverview Tests for scripts/check-dependency-specifiers.ts (#246) — the
 * floating-specifier guard. Spawns the real script against temp fixtures: a
 * clean manifest/lock passes; a `latest` in package.json or in the bun.lock
 * `workspaces` map fails; a `latest`/`*` buried in the lock `packages` section
 * (third-party nested declarations) is ignored; `*` and pre-release dist-tags
 * are rejected in dependencies but allowed in peerDependencies.
 * @module tests/unit/scripts/check-dependency-specifiers.test
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/check-dependency-specifiers.ts',
);

/** Run the real check against `cwd` as the project root it inspects. */
function runCheck(cwd: string): { code: number; output: string } {
  const result = spawnSync('bun', ['run', SCRIPT], { cwd, encoding: 'utf-8' });
  return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

function write(dir: string, file: string, value: unknown): void {
  writeFileSync(
    resolve(dir, file),
    typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  );
}

describe('check-dependency-specifiers (#246)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'check-dep-specifiers-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes a manifest and JSONC lock with only concrete ranges and pins', () => {
    write(dir, 'package.json', {
      name: 'x',
      dependencies: { a: '^1.0.0' },
      devDependencies: { b: '2.3.4' },
      peerDependencies: { c: '>=4.0.0' },
    });
    // Trailing commas exercise the JSONC tolerance.
    write(
      dir,
      'bun.lock',
      '{\n  "workspaces": {\n    "": {\n      "name": "x",\n      "dependencies": { "a": "^1.0.0" },\n    },\n  },\n}\n',
    );

    const { code, output } = runCheck(dir);

    expect(code).toBe(0);
    expect(output).toContain('No floating dependency specifiers found.');
  });

  it('fails a `latest` specifier in package.json dependencies', () => {
    write(dir, 'package.json', { name: 'x', dependencies: { a: 'latest', b: '^1.0.0' } });

    const { code, output } = runCheck(dir);

    expect(code).toBe(1);
    expect(output).toContain('a → latest');
    expect(output).toContain('package.json dependencies');
    expect(output).not.toContain('b →');
  });

  it('fails a `latest` specifier in the bun.lock workspaces map', () => {
    write(dir, 'package.json', { name: 'x', dependencies: { a: '^1.0.0' } });
    write(
      dir,
      'bun.lock',
      '{\n  "workspaces": {\n    "": {\n      "dependencies": { "a": "latest" },\n    },\n  },\n}\n',
    );

    const { code, output } = runCheck(dir);

    expect(code).toBe(1);
    expect(output).toContain('a → latest');
    expect(output).toContain('bun.lock');
  });

  it('ignores `latest`/`*` in the bun.lock packages section (third-party nested deps)', () => {
    write(dir, 'package.json', { name: 'x', dependencies: { a: '^1.0.0' } });
    write(
      dir,
      'bun.lock',
      '{\n  "workspaces": {\n    "": {\n      "dependencies": { "a": "^1.0.0" },\n    },\n  },\n' +
        '  "packages": {\n    "vend": ["vend@1.0.0", { "dependencies": { "e": "latest" }, "peerDependencies": { "@edge-runtime/vm": "*" } }],\n  },\n}\n',
    );

    const { code, output } = runCheck(dir);

    expect(code).toBe(0);
    expect(output).toContain('No floating dependency specifiers found.');
  });

  it('rejects `*` in dependencies but allows it in peerDependencies', () => {
    write(dir, 'package.json', {
      name: 'x',
      dependencies: { bad: '*' },
      peerDependencies: { ok: '*' },
    });

    const { code, output } = runCheck(dir);

    expect(code).toBe(1);
    expect(output).toContain('bad → *');
    expect(output).not.toContain('ok → *');
  });

  it('rejects a pre-release dist-tag in devDependencies', () => {
    write(dir, 'package.json', { name: 'x', devDependencies: { a: 'next' } });

    const { code, output } = runCheck(dir);

    expect(code).toBe(1);
    expect(output).toContain('a → next');
  });
});

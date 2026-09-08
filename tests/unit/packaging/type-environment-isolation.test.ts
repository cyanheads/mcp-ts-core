/**
 * @fileoverview Guards the Node/workerd type-environment split (issue #397).
 *
 * `@cloudflare/workers-types` declares `Buffer` as an ambient `const … : any`.
 * Loaded into the same TypeScript program as `@types/node`, that collision
 * strips the encoding-aware `toString()` overloads off every Node Buffer —
 * `randomBytes(32).toString('hex')` stops compiling — and `skipLibCheck: true`
 * hides the underlying redeclaration error, so nothing announces it.
 *
 * Ambient globals are per-program, so the framework keeps two: the root and
 * build programs load Node globals; `tsconfig.worker.json` loads the workerd
 * ones for the worker lane. Both halves are asserted here — the Node
 * environment must compile the framework's real Buffer expressions, and the
 * mixed environment must still fail, so a future "simplification" that merges
 * the two is caught rather than silently degrading Buffer everywhere.
 *
 * @module tests/unit/packaging/type-environment-isolation.test
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc');

/** The framework's own Buffer call sites, verbatim — the acceptance proof. */
const PROBE = `
import { createHmac, randomBytes } from 'node:crypto';

export const sessionId = randomBytes(32).toString('hex');
export const signature = createHmac('sha256', 'k').update('payload').digest().toString('binary');
`;

const scratch: string[] = [];

/** Compiles the probe under one ambient `types` set and returns tsc's output. */
function compileWith(types: string[]): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'type-env-isolation-'));
  scratch.push(dir);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'probe.ts'), PROBE);
  // Borrow the repo's install so both type packages resolve the ordinary way.
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2025',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          types,
        },
        include: ['src/**/*'],
      },
      null,
      2,
    ),
  );

  const result = spawnSync(TSC, ['--noEmit'], { cwd: dir, encoding: 'utf-8' });
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Node/workerd type-environment isolation (#397)', () => {
  it('compiles the framework Buffer expressions under Node globals alone', () => {
    const { code, out } = compileWith(['node']);
    expect(out).toBe('');
    expect(code).toBe(0);
  });

  it('still breaks Node Buffer when the workerd globals are loaded alongside', () => {
    const { code, out } = compileWith(['node', '@cloudflare/workers-types']);
    expect(code).not.toBe(0);
    // TS2554 "Expected 0 arguments, but got 1" — the encoding overload is gone.
    expect(out).toContain('TS2554');
  });

  it('keeps the ambient Cloudflare globals out of every Node-side program', () => {
    for (const config of ['tsconfig.json', 'tsconfig.build.json']) {
      const types = JSON.parse(
        readFileSync(join(ROOT, config), 'utf-8').replace(/^\s*\/\/.*$/gm, ''),
      ).compilerOptions.types as string[];
      expect(types).not.toContain('@cloudflare/workers-types');
      expect(types).toContain('node');
    }
  });

  it('keeps a program that does load them, so Worker coverage is not dropped', () => {
    const worker = JSON.parse(
      readFileSync(join(ROOT, 'tsconfig.worker.json'), 'utf-8').replace(/^\s*\/\/.*$/gm, ''),
    );
    expect(worker.compilerOptions.types).toContain('@cloudflare/workers-types');
    // It reads built declarations, so no Node-typed source is recompiled there.
    expect(worker.compilerOptions.paths['@/*']).toEqual(['./dist/*']);
  });
});

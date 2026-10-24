/**
 * @fileoverview Guards the Node/workerd type-environment split (issue #397).
 *
 * `@cloudflare/workers-types` declares `Buffer` as an ambient `var … : any`.
 * Loaded into the same TypeScript program as `@types/node`, that declaration
 * wins and the global `Buffer` becomes `any`, so every `Buffer.from(…)` call
 * goes unchecked — and `skipLibCheck: true` hides the underlying redeclaration
 * error (TS2403), so nothing announces it. (Releases before 5.20261021.1
 * declared it `const`, which instead stripped the encoding-aware `toString()`
 * overloads and broke compilation outright.)
 *
 * Ambient globals are per-program, so the framework keeps two: the root and
 * build programs load Node globals; `tsconfig.worker.json` loads the workerd
 * ones for the worker lane. Both halves are asserted here — the Node
 * environment must compile the framework's real Buffer expressions, and the
 * mixed environment must still degrade `Buffer`, so a future "simplification" that merges
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

/** A type error under Node's `Buffer`; it compiles only once the global has degraded to `any`. */
const ANY_PROBE = `export const length: number = Buffer.from('payload').toString('hex');\n`;

const scratch: string[] = [];

/** Compiles a probe under one ambient `types` set and returns tsc's output. */
function compileWith(types: string[], probe = PROBE): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'type-env-isolation-'));
  scratch.push(dir);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'probe.ts'), probe);
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

  it('still degrades Node Buffer to any when the workerd globals are loaded alongside', () => {
    // Under Node globals alone the probe is the type error it should be…
    const nodeOnly = compileWith(['node'], ANY_PROBE);
    expect(nodeOnly.code).not.toBe(0);
    expect(nodeOnly.out).toContain('TS2322');

    // …and with the workerd globals, in either order, it compiles unchecked.
    for (const types of [
      ['node', '@cloudflare/workers-types'],
      ['@cloudflare/workers-types', 'node'],
    ]) {
      const mixed = compileWith(types, ANY_PROBE);
      expect(mixed.out).toBe('');
      expect(mixed.code).toBe(0);
    }
  });

  it('keeps the ambient Cloudflare globals out of every Node-side program', () => {
    for (const config of ['tsconfig.json', 'config/tsconfig.build.json']) {
      const types = JSON.parse(
        readFileSync(join(ROOT, config), 'utf-8').replace(/^\s*\/\/.*$/gm, ''),
      ).compilerOptions.types as string[];
      expect(types).not.toContain('@cloudflare/workers-types');
      expect(types).toContain('node');
    }
  });

  it('keeps a program that does load them, so Worker coverage is not dropped', () => {
    const worker = JSON.parse(
      readFileSync(join(ROOT, 'config', 'tsconfig.worker.json'), 'utf-8').replace(
        /^\s*\/\/.*$/gm,
        '',
      ),
    );
    expect(worker.compilerOptions.types).toContain('@cloudflare/workers-types');
    // It reads built declarations, so no Node-typed source is recompiled there.
    // The path is relative to config/, where the file now lives.
    expect(worker.compilerOptions.paths['@/*']).toEqual(['../dist/*']);
  });
});

/**
 * @fileoverview Structural test for the shipped `config/tsconfig.base.json`.
 * tsc resolves a relative path against the file that declares it, so a
 * relative `outDir` or `paths` entry in the base points a consumer that
 * extends it at the installed package's own directory (#521). Paths must be
 * anchored to `${configDir}`, which tsc resolves against the config being
 * compiled.
 * @module tests/unit/packaging/tsconfig-base.test
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const base = JSON.parse(readFileSync(join(ROOT, 'config', 'tsconfig.base.json'), 'utf8')) as {
  compilerOptions: Record<string, unknown> & { paths?: Record<string, string[]> };
};

const PATH_OPTIONS = ['outDir', 'rootDir', 'declarationDir', 'tsBuildInfoFile', 'baseUrl'];

describe('config/tsconfig.base.json', () => {
  it('anchors every path option to the configDir template variable', () => {
    const { compilerOptions } = base;
    const pathValues = [
      ...PATH_OPTIONS.map((option) => compilerOptions[option]).filter(
        (value): value is string => typeof value === 'string',
      ),
      ...Object.values(compilerOptions.paths ?? {}).flat(),
    ];

    expect(pathValues.length).toBeGreaterThan(0);
    for (const value of pathValues) {
      expect(value).toMatch(/^\$\{configDir\}\//);
    }
  });

  it('keeps incremental, which the scaffold relies on for its tsBuildInfoFile', () => {
    expect(base.compilerOptions.incremental).toBe(true);
  });
});

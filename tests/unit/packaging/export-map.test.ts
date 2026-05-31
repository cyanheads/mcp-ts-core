/**
 * @fileoverview Structural tests for package.json exports.
 * Catches malformed public subpaths before the built-package consumer test
 * runs against `dist/`.
 * @module tests/unit/packaging/export-map.test
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  exports: Record<string, ExportEntry>;
  files: string[];
};

type ConditionalExport = {
  import?: string;
  types?: string;
};
type ExportEntry = ConditionalExport | string;

const EXPECTED_PUBLIC_SUBPATHS = [
  '.',
  './auth',
  './biome',
  './canvas',
  './config',
  './errors',
  './linter',
  './mirror',
  './package.json',
  './prompts',
  './resources',
  './services',
  './storage',
  './storage/types',
  './tasks',
  './testing',
  './testing/fuzz',
  './tools',
  './tsconfig.base.json',
  './utils',
  './vitest.config',
  './worker',
].sort();

function isConditionalExport(entry: ExportEntry): entry is ConditionalExport {
  return typeof entry === 'object' && entry !== null;
}

function pathExists(packagePath: string): boolean {
  return existsSync(join(ROOT, packagePath.replace(/^\.\//, '')));
}

function sourcePathForDistImport(distImport: string): string {
  return distImport
    .replace(/^\.\//, '')
    .replace(/^dist\//, 'src/')
    .replace(/\.js$/, '.ts');
}

describe('package export map', () => {
  it('keeps the expected public subpath set explicit', () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(EXPECTED_PUBLIC_SUBPATHS);
  });

  it('pairs every runtime export with declaration output under dist', () => {
    for (const [subpath, entry] of Object.entries(pkg.exports)) {
      if (!isConditionalExport(entry)) continue;

      expect(entry.import, `${subpath} import`).toMatch(/^\.\/dist\/.+\.js$/);
      expect(entry.types, `${subpath} types`).toMatch(/^\.\/dist\/.+\.d\.ts$/);
      expect(entry.import?.includes('/src/'), `${subpath} import must not point to src`).toBe(
        false,
      );
      expect(entry.types?.includes('/src/'), `${subpath} types must not point to src`).toBe(false);
      expect(entry.types, `${subpath} types must mirror import path`).toBe(
        entry.import?.replace(/\.js$/, '.d.ts'),
      );

      const sourcePath = sourcePathForDistImport(entry.import!);
      expect(existsSync(join(ROOT, sourcePath)), `${subpath} source ${sourcePath}`).toBe(true);
    }
  });

  it('keeps direct file exports resolvable from the package root', () => {
    for (const [subpath, entry] of Object.entries(pkg.exports)) {
      if (isConditionalExport(entry)) continue;
      expect(pathExists(entry), `${subpath} -> ${entry}`).toBe(true);
    }
  });

  it('includes files required by direct exports and generated artifacts', () => {
    expect(pkg.files).toEqual(
      expect.arrayContaining([
        'dist/',
        'skills/',
        'templates/',
        'tsconfig.base.json',
        'vitest.config.base.mjs',
        'biome.json',
      ]),
    );
  });
});

/**
 * @fileoverview Re-derives the public API manifest in
 * `scripts/public-api-contract.ts` from the live source barrels. Kept out of
 * that module so the manifest the contract tests import stays free of Bun's
 * global type augmentations, which conflict with the Workers typings the
 * worker test suite relies on.
 * @module scripts/public-api-contract-update
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const MANIFEST_OPEN = 'export const PUBLIC_RUNTIME_EXPORTS = {';
const MANIFEST_CLOSE = '} as const satisfies Record<string, readonly string[]>;';

type ConditionalExport = { default?: string; import?: string };

/**
 * Rewrites the manifest in place, leaving the header and the type export
 * untouched. Each public subpath's build target is mapped back to its `src/`
 * entry point, imported, and reduced to its sorted runtime named exports.
 */
async function updateManifest(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const manifestPath = join(root, 'scripts', 'public-api-contract.ts');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    exports: Record<string, ConditionalExport | string>;
  };

  /**
   * `src/testing/vitest.ts` calls `test.extend` at module scope, which throws
   * outside a Vitest runner. A virtual `vitest` module lets the barrel evaluate
   * far enough to expose its export names.
   */
  const { plugin } = await import('bun');
  plugin({
    name: 'vitest-host-stub',
    setup(build) {
      build.module('vitest', () => ({
        loader: 'object',
        exports: {
          describe: () => undefined,
          expect: () => undefined,
          test: Object.assign(() => undefined, { extend: () => () => undefined }),
        },
      }));
    },
  });

  const rows: string[] = [];
  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    if (typeof entry === 'string') continue;
    const target = entry.import ?? entry.default;
    if (!target) continue;
    const source = join(root, target.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts'));
    const barrel = (await import(pathToFileURL(source).href)) as Record<string, unknown>;
    const names = Object.keys(barrel).sort();
    rows.push(`  '${subpath}': [${names.map((name) => `'${name}'`).join(', ')}],`);
  }

  const current = await readFile(manifestPath, 'utf8');
  const open = current.indexOf(MANIFEST_OPEN);
  const close = current.indexOf(MANIFEST_CLOSE);
  if (open === -1 || close === -1) {
    throw new Error(`Manifest markers are missing from ${manifestPath}; its structure changed.`);
  }
  await writeFile(
    manifestPath,
    `${current.slice(0, open)}${MANIFEST_OPEN}\n${rows.join('\n')}\n${current.slice(close)}`,
  );
  await promisify(execFile)('bunx', ['biome', 'format', '--write', manifestPath], { cwd: root });
  console.log(`Regenerated ${rows.length} public subpath contracts in ${manifestPath}.`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  updateManifest().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

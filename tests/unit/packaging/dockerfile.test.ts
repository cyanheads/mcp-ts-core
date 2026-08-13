/**
 * @fileoverview Production Docker install invariants for the framework and
 * scaffold template. Optional peers must stay omitted after both dependency
 * installation steps; the later OTEL add otherwise re-resolves them.
 * @module tests/unit/packaging/dockerfile.test
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** Joins Dockerfile continuation lines so each RUN instruction is assertable. */
function runInstructions(path: string): string[] {
  return readFileSync(path, 'utf8')
    .replace(/\\\r?\n\s*/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('RUN '));
}

describe.each(['Dockerfile', 'templates/Dockerfile'])('%s production installs', (relativePath) => {
  it('omits optional peers from the production install and the OTEL add', () => {
    const runs = runInstructions(join(ROOT, relativePath));
    const productionInstall = runs.filter((line) => line.includes('bun install --production'));
    const otelAdd = runs.filter((line) => line.includes('bun add --omit=dev'));

    expect(productionInstall).toHaveLength(1);
    expect(productionInstall[0]).toContain('--omit=peer');
    expect(otelAdd).toHaveLength(1);
    expect(otelAdd[0]).toContain('--omit=peer');
  });
});

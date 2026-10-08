/**
 * @fileoverview Unit tests for the integration harness's build-freshness walk:
 * only what the build reads counts toward a build input's newest mtime.
 * @module tests/unit/helpers/server-process.test
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { newestMtimeMs } from '../../helpers/server-process.js';

describe('newestMtimeMs', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A `src/` holding one source file at `sourceTime`, everything else written at `laterTime`. */
  function tree(sourceTime: Date, laterTime: Date): string {
    const root = mkdtempSync(join(tmpdir(), 'build-inputs-'));
    dirs.push(root);
    const src = join(root, 'src');
    mkdirSync(join(src, 'nested'), { recursive: true });
    writeFileSync(join(src, 'nested', 'index.ts'), 'export {};\n');
    utimesSync(join(src, 'nested', 'index.ts'), sourceTime, sourceTime);
    for (const name of ['.DS_Store', 'index.ts~', 'notes.md']) {
      writeFileSync(join(src, 'nested', name), 'x');
      utimesSync(join(src, 'nested', name), laterTime, laterTime);
    }
    mkdirSync(join(src, '.cache'));
    writeFileSync(join(src, '.cache', 'state.ts'), 'x');
    utimesSync(join(src, '.cache', 'state.ts'), laterTime, laterTime);
    utimesSync(join(src, '.cache'), laterTime, laterTime);
    utimesSync(join(src, 'nested'), laterTime, laterTime);
    utimesSync(src, laterTime, laterTime);
    return src;
  }

  it('reads only the sources the build reads, not a dotfile, a backup, or a directory', () => {
    const source = new Date('2026-01-01T00:00:00Z');
    const later = new Date('2026-01-02T00:00:00Z');

    expect(newestMtimeMs(tree(source, later))).toBe(source.getTime());
  });

  it('still sees a newer source file', () => {
    const src = tree(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));
    const newer = new Date('2026-01-03T00:00:00Z');
    writeFileSync(join(src, 'added.ts'), 'export {};\n');
    utimesSync(join(src, 'added.ts'), newer, newer);

    expect(newestMtimeMs(src)).toBe(newer.getTime());
  });
});

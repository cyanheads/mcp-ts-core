/**
 * @fileoverview Unit tests for the logger's startup file-sink probe (#497):
 * which destinations it keeps, which it drops and with what code, and that it
 * leaves no file descriptor open behind it.
 * @module tests/unit/utils/internal/logger.fileSinks.test
 */
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { probeFileSinks } from '@/utils/internal/logger.js';

const RUNNING_AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

/** Open descriptors of this process, where the platform exposes them. */
const openFdCount = (): number => readdirSync('/dev/fd').length;
const HAS_DEV_FD = existsSync('/dev/fd');

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-probe-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('probeFileSinks', () => {
  it('creates a missing directory and keeps all three sinks', async () => {
    const dir = join(makeTempDir(), 'nested', 'logs');

    const probe = await probeFileSinks(dir);

    expect(probe.dropped).toEqual([]);
    expect(probe.writable).toEqual({
      'combined.log': join(dir, 'combined.log'),
      'error.log': join(dir, 'error.log'),
      'interactions.log': join(dir, 'interactions.log'),
    });
    for (const destination of Object.values(probe.writable)) {
      expect(existsSync(destination)).toBe(true);
    }
  });

  it.skipIf(RUNNING_AS_ROOT)('drops every sink in a read-only directory with EACCES', async () => {
    const dir = makeTempDir();
    chmodSync(dir, 0o555);

    const probe = await probeFileSinks(dir);

    expect(probe.writable).toEqual({});
    expect(probe.dropped).toEqual([
      { code: 'EACCES', name: 'combined.log', path: join(dir, 'combined.log') },
      { code: 'EACCES', name: 'error.log', path: join(dir, 'error.log') },
      { code: 'EACCES', name: 'interactions.log', path: join(dir, 'interactions.log') },
    ]);
  });

  it('drops every sink with the mkdir code when the directory sits under a file', async () => {
    const file = join(makeTempDir(), 'not-a-dir');
    writeFileSync(file, '');
    const dir = join(file, 'logs');

    const probe = await probeFileSinks(dir);

    expect(probe.writable).toEqual({});
    expect(probe.dropped.map((sink) => [sink.name, sink.code])).toEqual([
      ['combined.log', 'ENOTDIR'],
      ['error.log', 'ENOTDIR'],
      ['interactions.log', 'ENOTDIR'],
    ]);
  });

  it.skipIf(RUNNING_AS_ROOT)('drops only a read-only file and keeps its siblings', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'error.log'), '');
    chmodSync(join(dir, 'error.log'), 0o444);

    const probe = await probeFileSinks(dir);

    expect(probe.dropped).toEqual([
      { code: 'EACCES', name: 'error.log', path: join(dir, 'error.log') },
    ]);
    expect(Object.keys(probe.writable)).toEqual(['combined.log', 'interactions.log']);
  });

  it.skipIf(!HAS_DEV_FD || RUNNING_AS_ROOT)(
    'leaves no descriptor open after a mix of kept and dropped sinks',
    async () => {
      const dir = makeTempDir();
      writeFileSync(join(dir, 'error.log'), '');
      chmodSync(join(dir, 'error.log'), 0o444);
      // Warm the lazy `node:fs` / `node:path` imports so they cannot skew the count.
      await probeFileSinks(dir);

      const before = openFdCount();
      for (let i = 0; i < 20; i++) await probeFileSinks(dir);

      expect(openFdCount()).toBe(before);
    },
  );
});

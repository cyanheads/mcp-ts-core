/**
 * @fileoverview Tests for the export-path sandbox. Refinement #1 in issue #97
 * — path-based exports must be sandboxed to `CANVAS_EXPORT_PATH`. Verifies
 * absolute-path rejection, traversal rejection, and successful resolution
 * for nested paths inside the sandbox.
 * @module tests/unit/canvas/exportWriter.test
 */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  copyFormatClause,
  isPathTarget,
  pipeFileToStream,
  resolveExportPath,
  tempFilePathFor,
} from '@/canvas/providers/duckdb/exportWriter.js';

describe('resolveExportPath', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'canvas-export-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('resolves a simple relative path inside the sandbox', async () => {
    const resolved = await resolveExportPath(root, 'output.csv');
    expect(resolved).toBe(join(root, 'output.csv'));
  });

  it('resolves nested relative paths', async () => {
    const resolved = await resolveExportPath(root, 'sub/dir/output.csv');
    expect(resolved.startsWith(root + sep)).toBe(true);
  });

  it('rejects absolute paths', async () => {
    await expect(resolveExportPath(root, '/etc/passwd')).rejects.toThrow(/absolute/i);
    await expect(resolveExportPath(root, '/tmp/escape.csv')).rejects.toThrow(/absolute/i);
  });

  it('rejects paths that traverse out of the sandbox', async () => {
    await expect(resolveExportPath(root, '../escape.csv')).rejects.toThrow(/escapes/i);
    await expect(resolveExportPath(root, 'sub/../../escape.csv')).rejects.toThrow(/escapes/i);
    await expect(resolveExportPath(root, '../../etc/passwd')).rejects.toThrow(/escapes/i);
  });

  it('rejects empty paths', async () => {
    await expect(resolveExportPath(root, '')).rejects.toThrow(/non-empty/i);
  });

  it('creates the sandbox root directory if missing', async () => {
    const ephemeralRoot = join(root, 'auto-created');
    const resolved = await resolveExportPath(ephemeralRoot, 'output.csv');
    expect(isAbsolute(resolved)).toBe(true);
  });

  it('canonicalizes valid `./` and same-folder paths', async () => {
    const a = await resolveExportPath(root, './nested/x.csv');
    const b = await resolveExportPath(root, 'nested/x.csv');
    expect(a).toBe(b);
  });
});

describe('copyFormatClause', () => {
  it('emits CSV with HEADER true', () => {
    expect(copyFormatClause('csv')).toMatch(/csv/);
    expect(copyFormatClause('csv')).toMatch(/HEADER true/);
  });
  it('emits parquet', () => {
    expect(copyFormatClause('parquet')).toMatch(/parquet/);
  });
  it('emits json', () => {
    expect(copyFormatClause('json')).toMatch(/json/);
  });
});

describe('tempFilePathFor', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'canvas-temp-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('places temp files inside the sandbox root', async () => {
    const path = await tempFilePathFor(root, 'csv');
    expect(path.startsWith(`${root}${sep}.canvas-export-`)).toBe(true);
    expect(path.endsWith('.csv')).toBe(true);
  });
  it('uses unique names', async () => {
    const a = await tempFilePathFor(root, 'parquet');
    const b = await tempFilePathFor(root, 'parquet');
    expect(a).not.toBe(b);
  });
  it('creates the sandbox root if missing', async () => {
    const ephemeralRoot = join(root, 'auto-created');
    const path = await tempFilePathFor(ephemeralRoot, 'csv');
    expect(path.startsWith(`${ephemeralRoot}${sep}`)).toBe(true);
  });
});

describe('isPathTarget', () => {
  it('discriminates the union correctly', () => {
    expect(isPathTarget({ format: 'csv', path: 'x.csv' })).toBe(true);
    expect(
      isPathTarget({
        format: 'csv',
        stream: new WritableStream<Uint8Array>(),
      } as never),
    ).toBe(false);
  });
});

describe('pipeFileToStream', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'canvas-pipe-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('streams file bytes and unlinks the source file', async () => {
    const filePath = join(root, 'src.csv');
    const payload = 'hello,world\n1,2\n3,4\n';
    await mkdir(root, { recursive: true });
    await (await import('node:fs/promises')).writeFile(filePath, payload, 'utf-8');

    const chunks: Uint8Array[] = [];
    const stream = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      },
    });

    const { sizeBytes } = await pipeFileToStream(filePath, stream);
    const total = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
    expect(total).toBe(payload);
    expect(sizeBytes).toBe(payload.length);
    await expect(readFile(filePath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

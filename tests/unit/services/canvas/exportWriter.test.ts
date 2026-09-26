/**
 * @fileoverview Tests for the export-path sandbox. Refinement #1 in issue #97
 * — path-based exports must be sandboxed to `CANVAS_EXPORT_PATH`. Verifies
 * absolute-path rejection, traversal rejection, and successful resolution
 * for nested paths inside the sandbox.
 * @module tests/unit/canvas/exportWriter.test
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  copyFormatClause,
  isPathTarget,
  pipeFileToStream,
  resolveExportPath,
  tempFilePathFor,
} from '@/services/canvas/providers/duckdb/exportWriter.js';

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
    expect(resolved).toBe(join(ephemeralRoot, 'output.csv'));
    expect((await stat(ephemeralRoot)).isDirectory()).toBe(true);
  });

  it('canonicalizes valid `./` and same-folder paths', async () => {
    const a = await resolveExportPath(root, './nested/x.csv');
    const b = await resolveExportPath(root, 'nested/x.csv');
    expect(a).toBe(b);
  });

  it('rejects a symlinked parent that escapes the sandbox', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'canvas-export-outside-'));
    try {
      await symlink(outside, join(root, 'escape'));
      await expect(resolveExportPath(root, 'escape/output.csv')).rejects.toMatchObject({
        data: { reason: 'export_path_symlink' },
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  // The operator's root may itself be reached through a link (a symlinked
  // CANVAS_EXPORT_PATH, or /tmp and /var on macOS); only links below it are
  // refused, and the resolved path keeps the root as configured.
  it('accepts a root reached through a symlink and still rejects a symlink below it', async () => {
    const real = join(root, 'real');
    const linked = join(root, 'linked');
    await mkdir(real);
    await symlink(real, linked);

    await expect(resolveExportPath(linked, 'sub/output.csv')).resolves.toBe(
      join(linked, 'sub', 'output.csv'),
    );

    await symlink(root, join(real, 'escape'));
    await expect(resolveExportPath(linked, 'escape/output.csv')).rejects.toMatchObject({
      data: { reason: 'export_path_symlink' },
    });
  });

  // #565 — the provider redacts the root as configured, so a filesystem fault
  // in the walk must quote that path, not the root's realpath.
  it.skipIf(process.platform === 'win32')(
    'reports a filesystem fault under a symlinked root against the root as configured',
    async () => {
      const real = join(root, 'real');
      const linked = join(root, 'linked');
      await mkdir(real);
      await symlink(real, linked);
      await writeFile(join(real, 'sub'), 'a file, not a directory');

      const err = await resolveExportPath(linked, 'sub/output.csv').catch((e: unknown) => e);

      expect(err).toMatchObject({ code: 'ENOTDIR', path: join(linked, 'sub', 'output.csv') });
      expect((err as Error).message).not.toContain(real);
    },
  );

  it('rejects an existing destination that is itself a symlink', async () => {
    const outside = join(root, '..', `outside-${crypto.randomUUID()}.csv`);
    try {
      await writeFile(outside, 'do not overwrite');
      await symlink(outside, join(root, 'output.csv'));
      await expect(resolveExportPath(root, 'output.csv')).rejects.toMatchObject({
        data: { reason: 'export_path_symlink' },
      });
      await expect(readFile(outside, 'utf8')).resolves.toBe('do not overwrite');
    } finally {
      await rm(outside, { force: true });
    }
  });
});

describe('copyFormatClause', () => {
  it.each([
    ['csv', "(FORMAT 'csv', HEADER true)"],
    ['parquet', "(FORMAT 'parquet')"],
    ['json', "(FORMAT 'json')"],
  ] as const)('emits the COPY format clause for %s', (format, clause) => {
    expect(copyFormatClause(format)).toBe(clause);
  });
});

// #554 — scratch files sit directly in the provider's private directory under
// crypto.randomUUID() names; the 0700 directory, not the name, is the boundary.
describe('tempFilePathFor', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it.each(['csv', 'parquet', 'json'] as const)(
    'names a %s scratch file <uuid>.<format> directly inside the directory',
    (format) => {
      const root = join(tmpdir(), 'mcp-canvas-AbC123');
      const path = tempFilePathFor(root, format);
      expect(dirname(path)).toBe(root);
      const name = basename(path);
      expect(name.endsWith(`.${format}`)).toBe(true);
      expect(name.slice(0, -`.${format}`.length)).toMatch(UUID);
    },
  );

  it('never repeats a name', () => {
    const root = join(tmpdir(), 'mcp-canvas-AbC123');
    const names = new Set(Array.from({ length: 1000 }, () => tempFilePathFor(root, 'parquet')));
    expect(names.size).toBe(1000);
  });

  it('touches nothing on disk — the directory it names into must already exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvas-temp-'));
    try {
      const missing = join(root, 'not-created');
      tempFilePathFor(missing, 'csv');
      await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it('aborts the writer and propagates the error when the source file does not exist', async () => {
    const missingPath = join(root, 'never-written.csv');
    let abortedWith: unknown;
    const stream = new WritableStream<Uint8Array>({
      abort(reason) {
        abortedWith = reason;
      },
    });

    await expect(pipeFileToStream(missingPath, stream)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(abortedWith).toBeDefined();
    expect((abortedWith as { code?: string }).code).toBe('ENOENT');
  });
});

describe('resolveExportPath · non-string requested (runtime defensive check)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'canvas-export-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('rejects a non-string requested path — a distinct branch from the empty-string check', async () => {
    await expect(resolveExportPath(root, 123 as unknown as string)).rejects.toThrow(
      /non-empty string/i,
    );
    await expect(resolveExportPath(root, null as unknown as string)).rejects.toThrow(
      /non-empty string/i,
    );
  });
});

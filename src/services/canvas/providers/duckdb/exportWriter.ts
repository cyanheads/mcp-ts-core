/**
 * @fileoverview Path resolution and sandboxing for canvas exports. Path
 * targets are resolved against `CANVAS_EXPORT_PATH`; absolute paths and `..`
 * traversal are rejected. Stream targets write a sandboxed temp file, pipe to
 * the caller's `WritableStream`, then unlink.
 * @module src/services/canvas/providers/duckdb/exportWriter
 */

import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { validationError } from '@/types-global/errors.js';
import type { ExportFormat, ExportTarget } from '../../types.js';

/**
 * Resolve a relative path against the sandbox root. Refuses absolute inputs
 * and traversal. Returns an absolute path inside `rootPath` and creates the
 * root directory if missing.
 */
export async function resolveExportPath(rootPath: string, requested: string): Promise<string> {
  if (typeof requested !== 'string' || requested.length === 0) {
    throw validationError('Export path must be a non-empty string.', {
      reason: 'export_path_empty',
    });
  }
  if (isAbsolute(requested)) {
    throw validationError(
      'Export path must be relative — absolute paths are rejected to keep writes inside the canvas sandbox.',
      { reason: 'export_path_absolute', requested },
    );
  }
  const root = resolve(rootPath);
  const candidate = resolve(root, requested);
  const rel = relative(root, candidate);
  if (rel.startsWith(`..${sep}`) || rel === '..') {
    throw validationError(
      'Export path escapes the canvas sandbox. Use a path inside CANVAS_EXPORT_PATH.',
      { reason: 'export_path_escapes', requested },
    );
  }
  await mkdir(root, { recursive: true });
  return candidate;
}

/** Map an export format to a DuckDB `COPY ... TO ... (FORMAT ...)` clause. */
export function copyFormatClause(format: ExportFormat): string {
  switch (format) {
    case 'csv':
      return "(FORMAT 'csv', HEADER true)";
    case 'parquet':
      return "(FORMAT 'parquet')";
    case 'json':
      return "(FORMAT 'json')";
  }
}

/**
 * Pipe a sandbox file into a caller-supplied `WritableStream`, unlinking the
 * file in `finally`. Owns the file's lifecycle from the moment of invocation.
 */
export async function pipeFileToStream(
  filePath: string,
  stream: WritableStream<Uint8Array>,
): Promise<{ sizeBytes: number }> {
  const writer = stream.getWriter();
  let total = 0;
  try {
    const handle = await open(filePath, 'r');
    try {
      const chunkSize = 64 * 1024;
      const buffer = new Uint8Array(chunkSize);
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, chunkSize, null);
        if (bytesRead === 0) break;
        // slice() copies — the writer owns the bytes after this point.
        await writer.write(buffer.slice(0, bytesRead));
        total += bytesRead;
      }
    } finally {
      await handle.close();
    }
    await writer.close();
  } catch (err) {
    await writer.abort(err);
    throw err;
  } finally {
    await unlink(filePath).catch(() => {});
  }
  return { sizeBytes: total };
}

/**
 * Generate a unique temp file path inside the sandbox. Creates the root if
 * missing so the caller can write immediately.
 */
export async function tempFilePathFor(rootPath: string, format: ExportFormat): Promise<string> {
  const root = resolve(rootPath);
  await mkdir(root, { recursive: true });
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return join(root, `.canvas-export-${stamp}-${rand}.${format}`);
}

/** Best-effort file size lookup. Returns 0 on failure. */
export async function safeSizeBytes(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return info.size;
  } catch {
    return 0;
  }
}

/** Discriminator for {@link ExportTarget}. */
export function isPathTarget(
  target: ExportTarget,
): target is { format: ExportFormat; path: string } {
  return 'path' in target;
}

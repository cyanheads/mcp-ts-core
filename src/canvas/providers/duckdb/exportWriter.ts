/**
 * @fileoverview Path resolution and sandboxing for canvas export targets.
 *
 * Refinement #1 in issue #97: path-based exports must be sandboxed to
 * `CANVAS_EXPORT_PATH`. Absolute paths and `..` traversal are rejected;
 * the resolved path is always inside the sandbox root. Stream-based exports
 * write to a temp file inside the sandbox and pipe its bytes to the caller's
 * `WritableStream`, then unlink the temp file.
 *
 * @module src/canvas/providers/duckdb/exportWriter
 */

import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { validationError } from '@/types-global/errors.js';
import type { ExportFormat, ExportTarget } from '../../types.js';

/**
 * Resolve a caller-supplied relative path against the sandbox root, refusing
 * absolute inputs and traversal escapes. Always returns an absolute path
 * that is, by post-condition, a descendant of `rootPath`.
 *
 * The sandbox root itself is created if missing.
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

/**
 * Map an export format to its DuckDB `COPY ... TO` `(FORMAT ...)` clause.
 * JSON uses DuckDB's `JSON` format (line-delimited JSON by default).
 */
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
 * Pipe a written sandbox file into a caller-supplied `WritableStream`,
 * unlinking the temp file when finished. Used for the stream branch of
 * {@link ExportTarget}.
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
        // Slice owns its bytes — safe to pass to the writer.
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
    await unlink(filePath).catch(() => {
      // Best-effort cleanup — file may already be gone if abort raced.
    });
  }
  return { sizeBytes: total };
}

/**
 * Generate a unique temp file path inside the sandbox for stream-based exports.
 * Creates the sandbox root if missing so the caller can write immediately.
 */
export async function tempFilePathFor(rootPath: string, format: ExportFormat): Promise<string> {
  const root = resolve(rootPath);
  await mkdir(root, { recursive: true });
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return join(root, `.canvas-export-${stamp}-${rand}.${format}`);
}

/**
 * Best-effort size lookup for a written file. Returns 0 if `stat` fails.
 */
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

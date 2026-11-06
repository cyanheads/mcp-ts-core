/**
 * @fileoverview Path resolution and sandboxing for canvas exports, and the
 * source and format clauses of the `COPY` an export runs. Path targets are
 * resolved against `CANVAS_EXPORT_PATH`; absolute paths and `..` traversal are
 * rejected. A path export writes a staging file beside its target and renames
 * it over the target once written. Stream targets write a scratch file in the
 * provider's private scratch directory, pipe it to the caller's
 * `WritableStream`, then unlink.
 * @module src/services/canvas/providers/duckdb/exportWriter
 */

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import { validationError } from '@/types-global/errors.js';
import { quoteIdentifier } from '../../core/sqlGate.js';
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
  await mkdir(root, { recursive: true });
  const candidate = resolve(root, requested);
  const rel = relative(root, candidate);
  if (rel.startsWith(`..${sep}`) || rel === '..') {
    throw validationError(
      'Export path escapes the canvas sandbox. Use a path inside CANVAS_EXPORT_PATH.',
      { reason: 'export_path_escapes', requested },
    );
  }

  // Lexical confinement does not stop an in-sandbox symlink from pointing
  // outside. Reject every existing symlink in the destination chain (including
  // an existing destination file) before handing the path to DuckDB. The walk
  // starts at the root as configured, not its realpath: `lstat` resolves the
  // root's own links either way, and a filesystem fault then quotes the path
  // the provider redacts (#565).
  let cursor = root;
  for (const segment of rel.split(sep)) {
    cursor = join(cursor, segment);
    const info = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return;
      throw error;
    });
    if (!info) break;
    if (info.isSymbolicLink()) {
      throw validationError('Export path contains a symbolic link.', {
        reason: 'export_path_symlink',
        requested,
      });
    }
  }
  return candidate;
}

/**
 * Map an export format to a DuckDB `COPY ... TO ... (FORMAT ...)` clause for
 * the engine `engineVersion` names (`duckdb.version()`, such as `v2.0.0`).
 *
 * A Parquet row group stays in memory until it is flushed, and the engine's
 * default row group holds too many wide rows to fit in a canvas's memory
 * limit. The cap keeps a row group to about one 2,048-row slice of a wide
 * table: by bytes on v2.0, so a narrow table keeps full-size row groups, and by
 * rows on v1.5, which refuses `ROW_GROUP_SIZE_BYTES` while insertion order is
 * preserved. The writer cuts a group only between slices, so a group never
 * holds less than one slice.
 */
export function copyFormatClause(format: ExportFormat, engineVersion: string): string {
  switch (format) {
    case 'csv':
      return "(FORMAT 'csv', HEADER true)";
    case 'parquet':
      return engineVersion.startsWith('v1.')
        ? "(FORMAT 'parquet', ROW_GROUP_SIZE 2048)"
        : "(FORMAT 'parquet', ROW_GROUP_SIZE_BYTES '8MB')";
    case 'json':
      return "(FORMAT 'json')";
  }
}

/**
 * The `COPY` source every export of `tableName` runs, and the staging copy of
 * an `importFrom()`: the table or view followed by an empty `range(0)` branch
 * of `columnCount` NULLs, one per column.
 *
 * With insertion order preserved, DuckDB plans `COPY "t"` as a batch copy that
 * holds several batches per engine thread at once: to CSV or JSON, each
 * batch's whole text in one buffer, which v2.0 allocates inside
 * `memory_limit`; to Parquet, a row group per thread. Wide rows run out of
 * memory either way. A `range()` source has no batch index, so this union
 * plans DuckDB's single-writer `COPY_TO_FILE`, which flushes to the file as it
 * writes, on one engine thread. `UNION ALL` keeps the table's insertion order
 * and a view's `ORDER BY`. The memory bound rests on the planner keeping the
 * empty branch: an engine that prunes it, as DuckDB already prunes
 * `WHERE false`, plans the batch copy again, so row order still holds, the
 * bound does not, and the wide-row export smoke test fails.
 */
export function singleWriterCopySource(tableName: string, columnCount: number): string {
  const nulls = Array.from({ length: columnCount }, () => 'NULL').join(', ');
  return `(SELECT * FROM ${quoteIdentifier(tableName)} UNION ALL SELECT ${nulls} FROM range(0))`;
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
 * A fresh scratch file path directly inside `dir`, the provider's private
 * scratch directory, which must already exist — nothing touches the disk
 * here. The name is a `crypto.randomUUID()`, but the directory's `0700` mode
 * is what keeps other local users out: there is no exclusive-create step,
 * since DuckDB's `COPY … TO` opens the path itself and replaces an existing
 * target through a `tmp_<name>` sidecar. Callers unlink the file once it is
 * consumed.
 */
export function tempFilePathFor(dir: string, format: ExportFormat): string {
  return join(dir, `${randomUUID()}.${format}`);
}

/** The longest file name ext4, APFS, and most other filesystems accept, in UTF-8 bytes. */
const FILE_NAME_MAX_BYTES = 255;

/**
 * The path, relative like `requested`, a path export writes before renaming
 * it over `requested`: `.<name>.<UUID>.partial` in the directory of the file
 * `requested` resolves to, its `.` and `..` segments applied first, so the
 * rename stays on one filesystem and the staging path passes the same
 * {@link resolveExportPath} checks the target does. `<name>` is cut at a code
 * point boundary when the staging name would pass {@link FILE_NAME_MAX_BYTES},
 * so a target name the filesystem accepts never fails on the suffix.
 */
export function exportStagingPath(requested: string): string {
  const suffix = `.${randomUUID()}.partial`;
  const target = normalize(requested);
  const name = basename(target);
  // encodeInto writes whole code points only, so `read` never splits one.
  const { read } = new TextEncoder().encodeInto(
    name,
    new Uint8Array(FILE_NAME_MAX_BYTES - 1 - suffix.length),
  );
  return join(dirname(target), `.${name.slice(0, read)}${suffix}`);
}

/** Discriminator for {@link ExportTarget}. */
export function isPathTarget(
  target: ExportTarget,
): target is { format: ExportFormat; path: string } {
  return 'path' in target;
}

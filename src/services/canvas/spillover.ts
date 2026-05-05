/**
 * @fileoverview Source-agnostic spillover helper. Drains rows from any
 * tabular source up to a character budget for the inline preview, then — if
 * the source exceeds the budget — registers the full source (preview rows +
 * sentinel + remaining tail) to a canvas table and returns a handle. Same
 * input domain as {@link CanvasInstance.registerTable}: arrays, sync
 * generators, paginated APIs wrapped as async generators, etc. The seam is
 * the row iterable itself; everything BrAPI- or pagination-specific stays
 * out of this layer.
 * @module src/services/canvas/spillover
 */

import { validationError } from '@/types-global/errors.js';
import { idGenerator } from '@/utils/security/idGenerator.js';
import type { CanvasInstance } from './core/CanvasInstance.js';
import { inferSchemaFromRows } from './core/schemaSniffer.js';
import { assertValidIdentifier } from './core/sqlGate.js';
import type { ColumnSchema, RegisterTableResult } from './types.js';

/** Row shape — mirrors what registerTable accepts. */
type Row = Record<string, unknown>;

/** Options for {@link spillover}. */
export interface SpilloverOptions<T extends Row> {
  /** Pre-acquired canvas the caller already controls. */
  canvas: CanvasInstance;
  /** Drain caps applied to the spill phase. */
  caps?: {
    /**
     * Hard upper bound on rows registered to the canvas table. When the cap
     * is hit while the source still has more rows, the table holds exactly
     * `maxRows` rows and the result reports `truncated: true`.
     */
    maxRows?: number;
  };
  /**
   * Character budget for the inline preview. The helper drains rows,
   * accumulating `JSON.stringify(row).length` per row. The first row whose
   * serialization pushes the running total past `previewChars` is the
   * overflow sentinel — its existence proves the source has more rows than
   * fit, and it is itself spilled (not previewed). Heuristic: ~4× the
   * desired token budget (e.g. 100_000 chars ≈ 25k tokens). Must be ≥ 1.
   */
  previewChars: number;
  /**
   * Explicit table schema. Forwarded to canvas. Auto-derived from the
   * preview buffer when omitted.
   */
  schema?: ColumnSchema[];
  /**
   * Cancellation. Throws on abort during drain or registration; partial
   * canvas tables are best-effort dropped before the throw propagates.
   */
  signal?: AbortSignal;
  /** Row source. Anything DataCanvas.registerTable accepts. */
  source: AsyncIterable<T> | Iterable<T>;
  /**
   * Auto-generated (e.g. `spilled_<8-hex>`) when omitted. Caller-supplied
   * names are validated against the canvas identifier rules up-front,
   * before any draining begins.
   */
  tableName?: string;
}

/** Return value when the source fit inside the preview budget. No canvas call was made. */
export interface SpilloverFitResult<T> {
  previewRows: T[];
  spilled: false;
}

/** Return value when the source exceeded the preview budget and was spilled to a canvas table. */
export interface SpilloverSpillResult<T> {
  /** Result from `canvas.registerTable` — `tableName`, `rowCount`, `columns`. */
  handle: RegisterTableResult;
  previewRows: T[];
  spilled: true;
  /**
   * `true` when `caps.maxRows` was hit during the spill drain — the
   * registered table holds exactly `caps.maxRows` rows but the upstream
   * source had more. `false` when the full source was registered.
   */
  truncated: boolean;
}

/** Discriminated union return for {@link spillover}. */
export type SpilloverResult<T> = SpilloverFitResult<T> | SpilloverSpillResult<T>;

const GENERATED_NAME_PREFIX = 'spilled_';
const GENERATED_NAME_HEX_LENGTH = 8;
const HEX_CHARSET = '0123456789abcdef';

/**
 * Drain a tabular source into an inline preview slice and (if the source
 * exceeds the budget) register the full source to a canvas table. The
 * registered table holds every row — the preview slice plus the rows beyond
 * it — so callers SQL the canvas table for the complete result rather than
 * mentally unioning the preview and the table.
 *
 * The character budget is enforced by serializing each drained row with
 * `JSON.stringify`. The first row that pushes the running total past
 * `previewChars` is the overflow sentinel: its existence proves the source
 * has more rows than fit, and it is registered on the canvas (not echoed in
 * the preview). When the source exhausts under budget no canvas call is
 * made.
 *
 * Schema is inferred from the preview buffer (plus the overflow sentinel)
 * when no explicit schema is supplied. Pass `schema` directly when type
 * fidelity matters more than the buffer-sized sniff window.
 *
 * @example
 * ```ts
 * async function* fetchAll(): AsyncIterable<Row> {
 *   for (let p = 0; ; p++) {
 *     const page = await fetchPage(p);
 *     yield* page.rows;
 *     if (page.last) return;
 *   }
 * }
 *
 * const result = await spillover({
 *   canvas,
 *   source: fetchAll(),
 *   previewChars: 100_000,         // ≈ 25k tokens
 *   caps: { maxRows: 50_000 },
 *   signal: ctx.signal,
 * });
 * if (result.spilled) {
 *   // result.handle.tableName, result.truncated, result.previewRows
 * } else {
 *   // result.previewRows
 * }
 * ```
 */
export async function spillover<T extends Row>(
  opts: SpilloverOptions<T>,
): Promise<SpilloverResult<T>> {
  validatePreviewChars(opts.previewChars);
  validateMaxRows(opts.caps?.maxRows);

  // Validate (or generate) the table name before draining a single row —
  // catches bad caller-supplied names without wasting a 50k-row pull.
  const tableName = opts.tableName ?? generateTableName();
  assertValidIdentifier(tableName, 'table');

  opts.signal?.throwIfAborted();

  const iter = openIterator(opts.source);

  // ---------------- Phase 1: drain into the preview buffer ---------------
  const previewBuffer: T[] = [];
  let bytes = 0;
  let overflowSentinel: T | undefined;

  while (true) {
    opts.signal?.throwIfAborted();
    const next = await iter.next();
    if (next.done) break;
    const row = next.value;
    const rowChars = safeJsonLength(row);
    if (bytes + rowChars > opts.previewChars) {
      // This row crosses the budget — it's the overflow sentinel.
      overflowSentinel = row;
      break;
    }
    previewBuffer.push(row);
    bytes += rowChars;
  }

  if (overflowSentinel === undefined) {
    return { spilled: false, previewRows: previewBuffer };
  }

  // ---------------- Phase 2: spill the remainder to canvas ---------------
  const schema = opts.schema ?? inferSchemaFromRows([...previewBuffer, overflowSentinel]);

  const truncationFlag = { hit: false };
  const merged = mergedRows({
    bufferedRows: previewBuffer,
    overflowSentinel,
    remaining: iter,
    maxRows: opts.caps?.maxRows,
    signal: opts.signal,
    truncationFlag,
  });

  let handle: RegisterTableResult;
  try {
    handle = await opts.canvas.registerTable(tableName, merged, {
      schema,
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
  } catch (err) {
    // Best-effort cleanup so an aborted or failed registration doesn't leave
    // a partially-appended table on the canvas. Drop is idempotent.
    try {
      await opts.canvas.drop(tableName);
    } catch {
      /* swallow — original error wins */
    }
    throw err;
  }

  return {
    spilled: true,
    previewRows: previewBuffer,
    handle,
    truncated: truncationFlag.hit,
  };
}

function validatePreviewChars(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      'previewChars must be an integer ≥ 1. Use canvas.registerTable directly for headless spills.',
      { reason: 'invalid_preview_chars', previewChars: value },
    );
  }
}

function validateMaxRows(value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1) {
    throw validationError('caps.maxRows must be an integer ≥ 1 when supplied.', {
      reason: 'invalid_max_rows',
      maxRows: value,
    });
  }
}

function openIterator<T>(source: AsyncIterable<T> | Iterable<T>): Iterator<T> | AsyncIterator<T> {
  if (typeof (source as AsyncIterable<T>)[Symbol.asyncIterator] === 'function') {
    return (source as AsyncIterable<T>)[Symbol.asyncIterator]();
  }
  return (source as Iterable<T>)[Symbol.iterator]();
}

function safeJsonLength(row: unknown): number {
  try {
    return JSON.stringify(row).length;
  } catch {
    /**
     * Cyclic structures or stringify-unfriendly values would crash a
     * downstream serializer anyway. Treat as an oversized row so it pushes
     * past the budget and the caller sees the failure during register
     * rather than silently in the preview.
     */
    return Number.MAX_SAFE_INTEGER;
  }
}

interface MergedRowsArgs<T> {
  bufferedRows: readonly T[];
  maxRows: number | undefined;
  overflowSentinel: T;
  remaining: Iterator<T> | AsyncIterator<T>;
  signal: AbortSignal | undefined;
  truncationFlag: { hit: boolean };
}

async function* mergedRows<T>(args: MergedRowsArgs<T>): AsyncIterable<T> {
  const cap = args.maxRows;
  let yielded = 0;

  const capHit = (): boolean => cap !== undefined && yielded >= cap;

  for (const row of args.bufferedRows) {
    args.signal?.throwIfAborted();
    if (capHit()) {
      args.truncationFlag.hit = true;
      return;
    }
    yield row;
    yielded += 1;
  }

  args.signal?.throwIfAborted();
  if (capHit()) {
    args.truncationFlag.hit = true;
    return;
  }
  yield args.overflowSentinel;
  yielded += 1;

  while (true) {
    args.signal?.throwIfAborted();
    const next = await args.remaining.next();
    if (next.done) return;
    if (capHit()) {
      // Cap hit AND the source still had more — honest truncation.
      args.truncationFlag.hit = true;
      return;
    }
    yield next.value;
    yielded += 1;
  }
}

function generateTableName(): string {
  const suffix = idGenerator.generateRandomString(GENERATED_NAME_HEX_LENGTH, HEX_CHARSET);
  return `${GENERATED_NAME_PREFIX}${suffix}`;
}

/**
 * @fileoverview Schema inference for canvas table registration. Engine-agnostic
 * — produces `ColumnSchema[]` from observed JS values; providers map those
 * tags to native types when needed. `VARCHAR` is the safe fallback for
 * ambiguous unions. Used by the DuckDB provider for the no-explicit-schema
 * sync path and by the spillover helper to infer a schema from its preview
 * buffer when the source is async.
 * @module src/services/canvas/core/schemaSniffer
 */

import { validationError } from '@/types-global/errors.js';
import type { ColumnSchema, ColumnType } from '../types.js';

/** Row shape — mirrors what registerTable accepts. */
type Row = Record<string, unknown>;

/**
 * Sniff outcome. Callers must drain via `remaining`; re-iterating the original
 * input would lose data on generators or duplicate rows on fresh-iterator
 * iterables.
 */
export interface SniffedSchema {
  /**
   * Iterator positioned just past `sniffedRows`. May yield zero items when the
   * input fit entirely inside the sniff window.
   */
  remaining: Iterator<Row>;
  schema: ColumnSchema[];
  /** Rows already consumed; append these first. */
  sniffedRows: Row[];
}

/** JS-side type tag observed in a single value. */
type JsType = 'null' | 'string' | 'integer' | 'double' | 'bigint' | 'boolean' | 'object';

function classify(value: unknown): JsType {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'bigint') return 'bigint';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'double';
  }
  // Arrays, plain objects, dates → stored as JSON.
  return 'object';
}

/**
 * Pick a column type tag from the union of observed JS types. Conservative:
 * mixed string+numeric falls back to `VARCHAR` rather than guessing.
 */
function unionToColumnType(observed: Set<JsType>): ColumnType {
  const nonNull = new Set(observed);
  nonNull.delete('null');
  if (nonNull.size === 0) return 'VARCHAR';
  if (nonNull.size === 1) {
    const [only] = nonNull;
    switch (only) {
      case 'string':
        return 'VARCHAR';
      case 'integer':
      case 'bigint':
        return 'BIGINT';
      case 'double':
        return 'DOUBLE';
      case 'boolean':
        return 'BOOLEAN';
      case 'object':
        return 'JSON';
      default:
        return 'VARCHAR';
    }
  }
  // Pure-numeric union widens to DOUBLE if any double, otherwise BIGINT.
  const allNumeric = [...nonNull].every((t) => t === 'integer' || t === 'double' || t === 'bigint');
  if (allNumeric) return nonNull.has('double') ? 'DOUBLE' : 'BIGINT';
  if (!nonNull.has('string') && nonNull.has('object')) return 'JSON';
  return 'VARCHAR';
}

/**
 * Infer a `ColumnSchema[]` from a set of fully-buffered rows. Column ordering
 * follows first appearance. A column is `nullable` if any sampled row had
 * `null`/`undefined` for it or was missing the key. Throws if `rows` is empty.
 */
export function inferSchemaFromRows(rows: readonly Row[]): ColumnSchema[] {
  if (rows.length === 0) {
    throw validationError(
      'Cannot infer schema from an empty input. Provide either rows or an explicit `schema`.',
      { reason: 'empty_input' },
    );
  }

  const observedByCol = new Map<string, Set<JsType>>();
  const columnOrder: string[] = [];
  const presenceCount = new Map<string, number>();

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      let bag = observedByCol.get(key);
      if (!bag) {
        bag = new Set();
        observedByCol.set(key, bag);
        columnOrder.push(key);
      }
      bag.add(classify(row[key]));
      presenceCount.set(key, (presenceCount.get(key) ?? 0) + 1);
    }
  }

  const total = rows.length;
  return columnOrder.map((name) => {
    const observed = observedByCol.get(name) ?? new Set<JsType>(['null']);
    const present = presenceCount.get(name) ?? 0;
    const nullable = observed.has('null') || present < total;
    return { name, type: unionToColumnType(observed), nullable };
  });
}

/**
 * Buffer up to `sniffRowCount` rows and return the inferred schema, the
 * buffered rows, and a continuation iterator. Throws if the input is empty.
 *
 * Column ordering follows first appearance. A column is `nullable` if any
 * sampled row had `null`/`undefined` for it or was missing the key.
 */
export function sniffSchema(iterable: Iterable<Row>, sniffRowCount: number): SniffedSchema {
  if (sniffRowCount < 1) {
    throw validationError('sniffRowCount must be at least 1.', { sniffRowCount });
  }
  // Consume the same iterator we hand back so generators aren't re-iterated.
  const iter = iterable[Symbol.iterator]();
  const sniffedRows: Row[] = [];
  while (sniffedRows.length < sniffRowCount) {
    const next = iter.next();
    if (next.done) break;
    sniffedRows.push(next.value);
  }
  const schema = inferSchemaFromRows(sniffedRows);
  return { schema, sniffedRows, remaining: iter };
}

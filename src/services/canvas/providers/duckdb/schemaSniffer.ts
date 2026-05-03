/**
 * @fileoverview Schema inference for {@link DuckdbProvider.registerTable}.
 * Buffers the first N rows of an iterable, unions JS-side types per column,
 * and maps to DuckDB types. `VARCHAR` is the safe fallback for ambiguous
 * unions. Only used when the caller does not pass an explicit `schema`;
 * `AsyncIterable` inputs must always supply one because we cannot peek
 * without consuming.
 * @module src/services/canvas/providers/duckdb/schemaSniffer
 */

import { validationError } from '@/types-global/errors.js';
import type { ColumnSchema, ColumnType } from '../../types.js';

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
 * Pick a DuckDB column type from the union of observed JS types. Conservative:
 * mixed string+numeric falls back to `VARCHAR` rather than guessing.
 */
function unionToDuckdbType(observed: Set<JsType>): ColumnType {
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
  if (sniffedRows.length === 0) {
    throw validationError(
      'Cannot infer schema from an empty input. Provide either rows or an explicit `schema`.',
      { reason: 'empty_input' },
    );
  }

  const observedByCol = new Map<string, Set<JsType>>();
  const columnOrder: string[] = [];
  const presenceCount = new Map<string, number>();

  for (const row of sniffedRows) {
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

  const total = sniffedRows.length;
  const schema: ColumnSchema[] = columnOrder.map((name) => {
    const observed = observedByCol.get(name) ?? new Set<JsType>(['null']);
    const present = presenceCount.get(name) ?? 0;
    const nullable = observed.has('null') || present < total;
    return { name, type: unionToDuckdbType(observed), nullable };
  });

  return { schema, sniffedRows, remaining: iter };
}

/**
 * @fileoverview Schema inference for {@link DuckdbProvider.registerTable}.
 * Materializes the first N rows of an iterable, unions JS-side types per
 * column, and maps to DuckDB column types. Used only when the caller does
 * not pass an explicit `schema` to `registerTable`. For `AsyncIterable`
 * inputs the caller must supply a schema — we cannot peek without consuming.
 *
 * Algorithm (refinement 4 in issue #97):
 *   1. Buffer up to `sniffRowCount` rows (default 100).
 *   2. For each column, take the union of observed JS-side types
 *      (`string`, `number-int`, `number-float`, `bigint`, `boolean`, `null`,
 *      `object`).
 *   3. Map the union to a DuckDB type via {@link unionToDuckdbType}, with
 *      `VARCHAR` as the safe fallback when the union has no clean answer.
 *   4. Return `(schema, sniffedRows)` so the caller can append the buffered
 *      rows without re-iterating.
 *
 * @module src/canvas/providers/duckdb/schemaSniffer
 */

import { validationError } from '@/types-global/errors.js';
import type { ColumnSchema, ColumnType } from '../../types.js';

/** Row-shape used internally — mirrors what registerTable accepts. */
type Row = Record<string, unknown>;

/**
 * Outcome of a sniff: the inferred schema plus the buffered rows we consumed
 * from the iterable. Callers append `sniffedRows` first, then continue
 * draining whatever's left of the iterator.
 */
export interface SniffedSchema {
  schema: ColumnSchema[];
  /** Rows already consumed from the iterable. Append these first. */
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
  // Arrays, plain objects, dates, etc. all fall through here. Stored as JSON.
  return 'object';
}

/**
 * Choose a DuckDB column type for a column based on the union of JS types
 * observed in the first N rows. Conservative: when the union mixes strings
 * with numerics, falls back to `VARCHAR` rather than guessing.
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
        return 'BIGINT';
      case 'double':
        return 'DOUBLE';
      case 'bigint':
        return 'BIGINT';
      case 'boolean':
        return 'BOOLEAN';
      case 'object':
        return 'JSON';
      default:
        return 'VARCHAR';
    }
  }
  // Numeric widening — INTEGER + DOUBLE → DOUBLE; INTEGER + BIGINT → BIGINT.
  if (nonNull.has('double') && nonNull.has('integer') && nonNull.size === 2) return 'DOUBLE';
  if (nonNull.has('bigint') && nonNull.has('integer') && nonNull.size === 2) return 'BIGINT';
  if (
    nonNull.has('double') &&
    nonNull.has('integer') &&
    nonNull.has('bigint') &&
    nonNull.size === 3
  ) {
    return 'DOUBLE';
  }
  // Mixed string+structured → JSON when string is absent; otherwise VARCHAR.
  if (!nonNull.has('string') && nonNull.has('object')) return 'JSON';
  return 'VARCHAR';
}

/**
 * Materialize up to `sniffRowCount` rows from the iterable and return the
 * inferred schema plus the buffered rows. Throws if the input is empty.
 *
 * Column ordering is determined by first-appearance across the buffered rows
 * — column names from the first row come first, then any new keys added by
 * later rows (each appended in observation order). Missing keys in any row
 * count as `null` for type inference purposes.
 */
export function sniffSchema(iterable: Iterable<Row>, sniffRowCount: number): SniffedSchema {
  if (sniffRowCount < 1) {
    throw validationError('sniffRowCount must be at least 1.', { sniffRowCount });
  }
  const sniffedRows: Row[] = [];
  let count = 0;
  for (const row of iterable) {
    sniffedRows.push(row);
    count += 1;
    if (count >= sniffRowCount) break;
  }
  if (sniffedRows.length === 0) {
    throw validationError(
      'Cannot infer schema from an empty input. Provide either rows or an explicit `schema`.',
      { reason: 'empty_input' },
    );
  }

  const observedByCol = new Map<string, Set<JsType>>();
  const columnOrder: string[] = [];

  for (const row of sniffedRows) {
    for (const key of Object.keys(row)) {
      let bag = observedByCol.get(key);
      if (!bag) {
        bag = new Set();
        observedByCol.set(key, bag);
        columnOrder.push(key);
      }
      bag.add(classify(row[key]));
    }
    // Account for missing keys as `null` against existing columns.
    for (const key of columnOrder) {
      if (!(key in row)) {
        observedByCol.get(key)?.add('null');
      }
    }
  }

  const schema: ColumnSchema[] = columnOrder.map((name) => {
    const observed = observedByCol.get(name) ?? new Set<JsType>(['null']);
    return {
      name,
      type: unionToDuckdbType(observed),
      nullable: observed.has('null') || observed.size === 0,
    };
  });

  return { schema, sniffedRows };
}

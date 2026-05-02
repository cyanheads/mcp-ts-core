/**
 * @fileoverview Tests for schema sniffing — the multi-row type-union inference
 * that drives `registerTable` when no explicit schema is provided. Refinement
 * #4 in issue #97.
 * @module tests/unit/canvas/schemaSniffer.test
 */

import { describe, expect, it } from 'vitest';

import { sniffSchema } from '@/canvas/providers/duckdb/schemaSniffer.js';

describe('sniffSchema · single-type columns', () => {
  it('infers VARCHAR for string columns', () => {
    const { schema } = sniffSchema([{ name: 'a' }, { name: 'b' }], 100);
    expect(schema).toEqual([{ name: 'name', type: 'VARCHAR', nullable: false }]);
  });

  it('infers BIGINT for integer columns', () => {
    const { schema } = sniffSchema([{ count: 1 }, { count: 2 }], 100);
    expect(schema[0]).toMatchObject({ name: 'count', type: 'BIGINT' });
  });

  it('infers DOUBLE for float columns', () => {
    const { schema } = sniffSchema([{ ratio: 1.5 }, { ratio: 2.7 }], 100);
    expect(schema[0]).toMatchObject({ name: 'ratio', type: 'DOUBLE' });
  });

  it('infers BOOLEAN for boolean columns', () => {
    const { schema } = sniffSchema([{ active: true }, { active: false }], 100);
    expect(schema[0]).toMatchObject({ name: 'active', type: 'BOOLEAN' });
  });

  it('infers JSON for plain-object columns', () => {
    const { schema } = sniffSchema([{ payload: { a: 1 } }, { payload: { b: 2 } }], 100);
    expect(schema[0]).toMatchObject({ name: 'payload', type: 'JSON' });
  });
});

describe('sniffSchema · numeric widening', () => {
  it('widens INTEGER + DOUBLE → DOUBLE', () => {
    const { schema } = sniffSchema([{ x: 1 }, { x: 1.5 }], 100);
    expect(schema[0]?.type).toBe('DOUBLE');
  });

  it('widens INTEGER + BIGINT → BIGINT', () => {
    const { schema } = sniffSchema([{ x: 1 }, { x: 9_007_199_254_740_993n }], 100);
    expect(schema[0]?.type).toBe('BIGINT');
  });
});

describe('sniffSchema · ambiguous columns', () => {
  it('falls back to VARCHAR when string mixes with numerics', () => {
    const { schema } = sniffSchema([{ x: 'a' }, { x: 1 }], 100);
    expect(schema[0]?.type).toBe('VARCHAR');
  });

  it('marks columns nullable when null is observed', () => {
    const { schema } = sniffSchema([{ x: 'a' }, { x: null }], 100);
    expect(schema[0]).toMatchObject({ type: 'VARCHAR', nullable: true });
  });

  it('falls back to VARCHAR when only nulls are observed', () => {
    const { schema } = sniffSchema([{ x: null }, { x: null }], 100);
    expect(schema[0]).toMatchObject({ type: 'VARCHAR', nullable: true });
  });
});

describe('sniffSchema · column ordering and missing keys', () => {
  it('preserves first-appearance column order', () => {
    const { schema } = sniffSchema(
      [
        { a: 1, b: 'x' },
        { c: true, b: 'y', a: 2 },
      ],
      100,
    );
    expect(schema.map((c) => c.name)).toEqual(['a', 'b', 'c']);
  });

  it('treats missing keys as nullable across rows', () => {
    const { schema } = sniffSchema([{ a: 1, b: 'x' }, { a: 2 }], 100);
    expect(schema.find((c) => c.name === 'b')?.nullable).toBe(true);
  });
});

describe('sniffSchema · sniff window', () => {
  it('honors sniffRowCount — only buffers up to N rows', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ x: i }));
    const result = sniffSchema(rows, 50);
    expect(result.sniffedRows.length).toBe(50);
  });

  it('returns the buffered prefix so callers can append without re-iterating', () => {
    const rows = [{ a: 1 }, { a: 2 }, { a: 3 }];
    const result = sniffSchema(rows, 100);
    expect(result.sniffedRows).toEqual(rows);
  });
});

describe('sniffSchema · errors', () => {
  it('throws on empty input', () => {
    expect(() => sniffSchema([], 100)).toThrow(/empty input/i);
  });

  it('throws when sniffRowCount is below 1', () => {
    expect(() => sniffSchema([{ a: 1 }], 0)).toThrow(/sniffRowCount must be at least 1/i);
  });
});

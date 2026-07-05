/**
 * @fileoverview Tests for schema sniffing — the multi-row type-union inference
 * that drives `registerTable` when no explicit schema is provided. Refinement
 * #4 in issue #97.
 * @module tests/unit/canvas/schemaSniffer.test
 */

import { describe, expect, it } from 'vitest';

import { inferSchemaFromRows, sniffSchema } from '@/services/canvas/core/schemaSniffer.js';

describe('sniffSchema · single-type columns', () => {
  it('infers VARCHAR for string columns', () => {
    const { schema } = sniffSchema([{ name: 'a' }, { name: 'b' }], 100);
    // Inferred schemas always emit nullable: true (issue #221)
    expect(schema).toEqual([{ name: 'name', type: 'VARCHAR', nullable: true }]);
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

  it('widens DOUBLE + BIGINT → DOUBLE (no integer in the union)', () => {
    // Pre-fix gap: only INTEGER+DOUBLE, INTEGER+BIGINT, and the triple were
    // enumerated explicitly, so a column mixing only float and bigint values
    // fell through to VARCHAR. Now any pure-numeric union widens.
    const { schema } = sniffSchema([{ x: 1.5 }, { x: 9_007_199_254_740_993n }], 100);
    expect(schema[0]?.type).toBe('DOUBLE');
  });

  it('widens INTEGER + DOUBLE + BIGINT → DOUBLE', () => {
    const { schema } = sniffSchema([{ x: 1 }, { x: 1.5 }, { x: 9_007_199_254_740_993n }], 100);
    expect(schema[0]?.type).toBe('DOUBLE');
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

  it('marks late-introduced columns nullable', () => {
    // Column `b` appears for the first time at row 2; row 1 didn't have it.
    // The pre-fix sniffer marked `b` as nullable=false because the missing-
    // key loop only ran for columns already in columnOrder at each row.
    const { schema } = sniffSchema([{ a: 1 }, { a: 2, b: 'x' }], 100);
    const b = schema.find((c) => c.name === 'b');
    expect(b?.nullable).toBe(true);
  });

  it('marks columns nullable when missing in the middle of the stream', () => {
    const { schema } = sniffSchema([{ a: 1, b: 'x' }, { a: 2 }, { a: 3, b: 'y' }], 100);
    expect(schema.find((c) => c.name === 'b')?.nullable).toBe(true);
  });
});

describe('sniffSchema · continuation iterator', () => {
  it('returns a remaining iterator positioned past the buffered prefix', () => {
    const rows = [{ x: 1 }, { x: 2 }, { x: 3 }, { x: 4 }, { x: 5 }];
    const { sniffedRows, remaining } = sniffSchema(rows, 2);
    expect(sniffedRows.length).toBe(2);
    const drained: Array<Record<string, unknown>> = [];
    let next = remaining.next();
    while (!next.done) {
      drained.push(next.value);
      next = remaining.next();
    }
    expect(drained).toEqual([{ x: 3 }, { x: 4 }, { x: 5 }]);
  });

  it('handles generators (one-shot iterables) without dropping data', () => {
    function* gen() {
      for (let i = 1; i <= 250; i += 1) yield { x: i };
    }
    const iterable = gen();
    const { sniffedRows, remaining } = sniffSchema(iterable, 100);
    expect(sniffedRows.length).toBe(100);
    const drained: Array<Record<string, unknown>> = [];
    let next = remaining.next();
    while (!next.done) {
      drained.push(next.value);
      next = remaining.next();
    }
    // sniffedRows + drained must equal the original 250 rows exactly.
    expect(drained.length).toBe(150);
    const all = [...sniffedRows, ...drained];
    expect(all.length).toBe(250);
    expect(all[0]).toEqual({ x: 1 });
    expect(all[100]).toEqual({ x: 101 });
    expect(all[249]).toEqual({ x: 250 });
  });

  it('returns an immediately-done iterator when the input fits inside the sniff window', () => {
    const { remaining } = sniffSchema([{ a: 1 }, { a: 2 }], 100);
    expect(remaining.next().done).toBe(true);
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

// Issue #221 — inferred schemas always emit nullable: true
describe('sniffSchema · always-nullable inference (issue #221)', () => {
  it('emits nullable: true for a fully non-null column', () => {
    const { schema } = sniffSchema([{ x: 1 }, { x: 2 }, { x: 3 }], 100);
    expect(schema[0]?.nullable).toBe(true);
  });

  it('emits nullable: true even when every sampled row has a value', () => {
    const { schema } = sniffSchema(
      [{ ticker: 'AAPL' }, { ticker: 'MSFT' }, { ticker: 'GOOG' }],
      100,
    );
    expect(schema[0]?.nullable).toBe(true);
  });

  it('inferSchemaFromRows never emits nullable: false', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      label: `row_${i}`,
      score: i / 10,
    }));
    const schema = inferSchemaFromRows(rows);
    for (const col of schema) {
      expect(col.nullable).toBe(true);
    }
  });
});

describe('classify() · undefined is equivalent to null', () => {
  it('treats undefined the same as null when mixed with a populated column', () => {
    const { schema } = sniffSchema([{ x: 'a' }, { x: undefined }], 100);
    expect(schema[0]).toMatchObject({ type: 'VARCHAR', nullable: true });
  });

  it('falls back to VARCHAR when only undefined values are observed', () => {
    const { schema } = sniffSchema([{ x: undefined }, { x: undefined }], 100);
    expect(schema[0]).toMatchObject({ type: 'VARCHAR', nullable: true });
  });
});

describe('sniffSchema · pure-bigint column', () => {
  it('infers BIGINT for a column observed only as bigint values', () => {
    const { schema } = sniffSchema([{ id: 1n }, { id: 2n }], 100);
    expect(schema[0]).toMatchObject({ name: 'id', type: 'BIGINT' });
  });
});

describe('classify() · object-tagged values beyond plain objects', () => {
  it('classifies arrays as object → JSON column type', () => {
    const { schema } = sniffSchema([{ tags: [1, 2] }, { tags: [3] }], 100);
    expect(schema[0]).toMatchObject({ name: 'tags', type: 'JSON' });
  });

  it('classifies Date instances as object → JSON column type', () => {
    const { schema } = sniffSchema([{ when: new Date() }, { when: new Date() }], 100);
    expect(schema[0]).toMatchObject({ name: 'when', type: 'JSON' });
  });
});

describe('unionToColumnType · non-numeric mixed unions', () => {
  it('falls back to VARCHAR when boolean mixes with string', () => {
    const { schema } = sniffSchema([{ x: true }, { x: 'yes' }], 100);
    expect(schema[0]?.type).toBe('VARCHAR');
  });

  it('falls back to VARCHAR when object mixes with string (string beats object → JSON)', () => {
    const { schema } = sniffSchema([{ x: { a: 1 } }, { x: 'plain' }], 100);
    expect(schema[0]?.type).toBe('VARCHAR');
  });

  it('widens to JSON when object mixes with boolean (non-numeric, no string present)', () => {
    const { schema } = sniffSchema([{ x: { a: 1 } }, { x: true }], 100);
    expect(schema[0]?.type).toBe('JSON');
  });
});

describe('inferSchemaFromRows · rows with no observed keys', () => {
  it('returns an empty schema for a single empty-object row (rows.length !== 0, but no columns)', () => {
    expect(inferSchemaFromRows([{}])).toEqual([]);
  });
});

describe('sniffSchema · exact sniff-window boundary', () => {
  it('drains the whole input and reports remaining as done when rows === sniffRowCount exactly', () => {
    const rows = [{ x: 1 }, { x: 2 }, { x: 3 }];
    const { sniffedRows, remaining } = sniffSchema(rows, 3);
    expect(sniffedRows.length).toBe(3);
    expect(remaining.next().done).toBe(true);
  });
});

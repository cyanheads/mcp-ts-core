/**
 * @fileoverview Tests for the TIMESTAMP/DATE/BLOB coercion helpers used by the
 * DuckDB provider's appender. Pins the fail-fast behavior that replaced the
 * silent `String(value)` fallback (issue #102) — Date objects now route to
 * proper micros/days, binary types route to Uint8Array, anything else throws.
 * @module tests/unit/services/canvas/appendValueCoerce.test
 */

import { describe, expect, it } from 'vitest';

import {
  toDateDays,
  toTimestampMicros,
  toUint8Array,
} from '@/services/canvas/providers/duckdb/DuckdbProvider.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

const COL = 'col';

describe('toTimestampMicros', () => {
  it('converts Date to micros since epoch', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    expect(toTimestampMicros(date, COL)).toBe(1_767_225_600_000_000n);
  });

  it('treats numbers as ms since epoch', () => {
    expect(toTimestampMicros(1_767_225_600_000, COL)).toBe(1_767_225_600_000_000n);
    expect(toTimestampMicros(0, COL)).toBe(0n);
  });

  it('passes bigint through as already-micros', () => {
    expect(toTimestampMicros(1_767_225_600_000_000n, COL)).toBe(1_767_225_600_000_000n);
  });

  it('parses ISO 8601 strings', () => {
    expect(toTimestampMicros('2026-01-01T00:00:00.000Z', COL)).toBe(1_767_225_600_000_000n);
  });

  it('rejects invalid Date instances', () => {
    let caught: unknown;
    try {
      toTimestampMicros(new Date('not a date'), COL);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    const err = caught as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect((err.data as { reason: string }).reason).toBe('invalid_value_for_type');
  });

  it('rejects unparseable strings', () => {
    expect(() => toTimestampMicros('not a date', COL)).toThrow(McpError);
  });

  it.each([true, [], {}, Symbol('x')])('rejects type %p', (value) => {
    let caught: unknown;
    try {
      toTimestampMicros(value, COL);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).message).toContain('TIMESTAMP');
  });
});

describe('toDateDays', () => {
  it('converts Date to days since epoch (UTC)', () => {
    expect(toDateDays(new Date('1970-01-01T00:00:00.000Z'), COL)).toBe(0);
    expect(toDateDays(new Date('2026-01-01T00:00:00.000Z'), COL)).toBe(20_454);
  });

  it('parses ISO 8601 date strings', () => {
    expect(toDateDays('2026-01-01', COL)).toBe(20_454);
  });

  it('treats numbers as ms since epoch', () => {
    expect(toDateDays(0, COL)).toBe(0);
    expect(toDateDays(86_400_000, COL)).toBe(1);
  });

  it('floors fractional days (mid-day Date stays on its calendar day)', () => {
    expect(toDateDays(new Date('2026-01-01T12:00:00.000Z'), COL)).toBe(20_454);
    expect(toDateDays(new Date('2026-01-01T23:59:59.999Z'), COL)).toBe(20_454);
  });

  it('rejects invalid Date instances', () => {
    expect(() => toDateDays(new Date('not a date'), COL)).toThrow(McpError);
  });

  it('rejects unparseable strings', () => {
    expect(() => toDateDays('not a date', COL)).toThrow(McpError);
  });

  it.each([true, [], {}, 0n])('rejects type %p', (value) => {
    expect(() => toDateDays(value, COL)).toThrow(McpError);
  });
});

describe('toUint8Array', () => {
  it('passes Uint8Array through unchanged', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(toUint8Array(bytes, COL)).toBe(bytes);
  });

  it('wraps ArrayBuffer', () => {
    const buf = new ArrayBuffer(4);
    new Uint8Array(buf).set([1, 2, 3, 4]);
    const result = toUint8Array(buf, COL);
    expect(result).toBeInstanceOf(Uint8Array);
    expect([...result]).toEqual([1, 2, 3, 4]);
  });

  it('wraps Node Buffer (Uint8Array subclass)', () => {
    const buf = Buffer.from([1, 2, 3]);
    const result = toUint8Array(buf, COL);
    expect([...result]).toEqual([1, 2, 3]);
  });

  it('wraps other ArrayBufferView subclasses', () => {
    const i16 = new Int16Array([0x0201, 0x0403]);
    const result = toUint8Array(i16, COL);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.byteLength).toBe(4);
  });

  it.each([
    'string-not-bytes',
    42,
    true,
    null,
    undefined,
    [1, 2, 3], // arrays are not bytes — must be Uint8Array
    { length: 3, 0: 1, 1: 2, 2: 3 },
  ])('rejects non-binary value %p', (value) => {
    let caught: unknown;
    try {
      toUint8Array(value, COL);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).message).toContain('BLOB');
    expect(((caught as McpError).data as { reason: string }).reason).toBe('invalid_value_for_type');
  });
});

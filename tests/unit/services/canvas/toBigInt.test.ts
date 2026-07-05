/**
 * @fileoverview Tests for the BIGINT coercion helper used by the DuckDB
 * provider's appender. Pins the lossless-string path that fixes precision
 * truncation when upstream APIs return BIGINT IDs as numeric strings.
 * @module tests/unit/services/canvas/toBigInt.test
 */

import { describe, expect, it } from 'vitest';

import { toBigInt } from '@/services/canvas/providers/duckdb/DuckdbProvider.js';
import { McpError } from '@/types-global/errors.js';

describe('toBigInt', () => {
  it('returns bigint inputs unchanged', () => {
    expect(toBigInt(42n)).toBe(42n);
    expect(toBigInt(9_007_199_254_740_993n)).toBe(9_007_199_254_740_993n);
  });

  it('preserves precision for numeric strings outside JS Number safe range', () => {
    // 2^53 + 1 — not representable as a JS Number without precision loss.
    expect(toBigInt('9007199254740993')).toBe(9_007_199_254_740_993n);
    expect(toBigInt('-9007199254740993')).toBe(-9_007_199_254_740_993n);
  });

  it('handles regular numeric strings inside the safe range', () => {
    expect(toBigInt('42')).toBe(42n);
    expect(toBigInt('-42')).toBe(-42n);
    expect(toBigInt('0')).toBe(0n);
  });

  it('falls back to Number-based coercion for plain numbers', () => {
    expect(toBigInt(42)).toBe(42n);
    expect(toBigInt(3.7)).toBe(3n); // Math.trunc
  });

  it('falls back to Number-based coercion for non-numeric strings', () => {
    // Decimals and scientific notation aren't matched by the strict integer
    // regex; they fall through to Number-based coercion (lossy by design —
    // BigInt() throws on these inputs).
    expect(toBigInt('3.7')).toBe(3n);
  });
});

describe('toBigInt · null and undefined (documented current behavior)', () => {
  it('coerces null to 0n via Number(null) === 0 — no explicit null guard', () => {
    // Number(null) is 0, so toBigInt(null) silently succeeds as 0n rather
    // than throwing — unlike its sibling coercers (toTimestampMicros /
    // toDateDays / toUint8Array), which all reject invalid types with a
    // structured validationError. In production this path is unreachable
    // (appendValue intercepts null/undefined before dispatching to
    // toBigInt), but the exported function itself does not guard against it.
    expect(toBigInt(null)).toBe(0n);
  });

  it('throws a raw (non-McpError) error for undefined — inconsistent with sibling coercers', () => {
    // Number(undefined) is NaN, and BigInt(NaN) throws a native RangeError —
    // uncaught by toBigInt, so callers see an unstructured error instead of
    // the validationError() its appendValue-coercion siblings produce for
    // every other invalid input.
    let caught: unknown;
    try {
      toBigInt(undefined);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(McpError);
  });
});

/**
 * @fileoverview Tests for the BIGINT coercion helper used by the DuckDB
 * provider's appender. Pins the lossless-string path that fixes precision
 * truncation when upstream APIs return BIGINT IDs as numeric strings.
 * @module tests/unit/services/canvas/toBigInt.test
 */

import { describe, expect, it } from 'vitest';

import { toBigInt } from '@/services/canvas/providers/duckdb/DuckdbProvider.js';

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

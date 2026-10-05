/**
 * @fileoverview Tests for the length cap on caller-supplied strings that log
 * records and span attributes carry — a resource read's URI and a request's
 * JSON-RPC id.
 * @module tests/unit/utils/internal/observabilityCap.test
 */
import { describe, expect, it } from 'vitest';

import {
  capForObservability,
  jsonRpcIdLogFields,
  OBSERVABILITY_MAX_STRING_LENGTH,
} from '@/utils/internal/observabilityCap.js';

describe('capForObservability', () => {
  it('shares one 1,024-character limit', () => {
    expect(OBSERVABILITY_MAX_STRING_LENGTH).toBe(1_024);
  });

  it.each([
    ['an empty string', ''],
    ['a string under the limit', 'abc'],
    ['a string exactly at the limit', 'abcd'],
  ])('returns %s unchanged, with no length', (_label, value) => {
    expect(capForObservability(value, 4)).toEqual({ value });
  });

  it('cuts a string one past the limit to its first characters and records the uncut length', () => {
    expect(capForObservability('abcde', 4)).toEqual({ value: 'abcd', length: 5 });
  });

  it('never splits a surrogate pair, ending one unit early and recording the uncut length', () => {
    // 'ab🙂c': the emoji is the pair at units 2–3, so a 3-unit cut would end on its high half.
    const value = 'ab\u{1F642}c';

    const { value: kept, length } = capForObservability(value, 3);

    expect(kept).toBe('ab');
    expect(kept.isWellFormed()).toBe(true);
    expect(length).toBe(5);
  });

  it('keeps a whole surrogate pair that ends exactly at the limit', () => {
    expect(capForObservability('ab\u{1F642}c', 4)).toEqual({ value: 'ab\u{1F642}', length: 5 });
  });

  it('keeps a cut of a long astral string well formed at the shared limit', () => {
    const value = `${'q'.repeat(1_023)}${'\u{1F642}'.repeat(10)}`;

    const { value: kept, length } = capForObservability(value, OBSERVABILITY_MAX_STRING_LENGTH);

    expect(kept).toBe('q'.repeat(1_023));
    expect(kept.isWellFormed()).toBe(true);
    expect(length).toBe(1_043);
  });

  it('cuts a 999,000-character string at the shared limit', () => {
    const value = 'q'.repeat(999_000);

    expect(capForObservability(value, OBSERVABILITY_MAX_STRING_LENGTH)).toEqual({
      value: value.slice(0, 1_024),
      length: 999_000,
    });
  });
});

describe('jsonRpcIdLogFields', () => {
  it.each([
    ['a number', 10],
    ['null', null],
    ['a short string', 'client-string-id-19'],
    ['a 1,024-character string', 'q'.repeat(1_024)],
  ])('carries %s as sent, with no length', (_label, id) => {
    expect(jsonRpcIdLogFields(id)).toEqual({ jsonRpcId: id });
  });

  it.each([1_025, 999_000])(
    'cuts a %i-character string to 1,024 and records its length',
    (length) => {
      const id = 'q'.repeat(length);

      expect(jsonRpcIdLogFields(id)).toEqual({
        jsonRpcId: id.slice(0, 1_024),
        jsonRpcIdLength: length,
      });
    },
  );
});

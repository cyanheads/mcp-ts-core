/**
 * @fileoverview Tests for the `tool-input-partial` generator: every partial is a plain
 * object, partials grow toward the complete arguments without ever equalling them, and
 * escapes and nested containers close correctly.
 * @module tests/unit/testing/apps/partial-json.test
 */

import { describe, expect, it } from 'vitest';

import { partialArguments } from '@/testing/apps/partial-json.js';

function expectPlainObjects(partials: unknown[]): void {
  for (const partial of partials) {
    expect(partial).toBeTypeOf('object');
    expect(partial).not.toBeNull();
    expect(Array.isArray(partial)).toBe(false);
  }
}

describe('partialArguments', () => {
  it('returns no partials for empty arguments', () => {
    expect(partialArguments({})).toEqual([]);
  });

  it('returns plain objects that never equal the complete arguments', () => {
    const args = { query: 'a fairly long probe query', limit: 25, exact: true };
    const partials = partialArguments(args);
    expect(partials.length).toBeGreaterThan(0);
    expectPlainObjects(partials);
    for (const partial of partials) expect(partial).not.toEqual(args);
  });

  it('grows toward the complete arguments and drops consecutive duplicates', () => {
    const args = { query: 'probe-query-with-length', page: 3 };
    const partials = partialArguments(args);
    const serialized = partials.map((partial) => JSON.stringify(partial));
    for (let i = 1; i < serialized.length; i++) {
      expect(serialized[i]).not.toBe(serialized[i - 1]);
      expect(serialized[i]?.length).toBeGreaterThanOrEqual(serialized[i - 1]?.length ?? 0);
    }
    const last = partials.at(-1) as { query?: string };
    expect(args.query.startsWith(last.query ?? '')).toBe(true);
  });

  it('produces at most eight partials however long the arguments are', () => {
    const partials = partialArguments({ text: 'x'.repeat(5_000) });
    expect(partials.length).toBeLessThanOrEqual(8);
    expect(partials.length).toBeGreaterThan(1);
  });

  it('closes strings that hold escapes, quotes, and unicode', () => {
    const args = { text: 'line one\nline "two" \\ back\tslash — ünïcødé ✓ end' };
    const partials = partialArguments(args);
    expect(partials.length).toBeGreaterThan(0);
    expectPlainObjects(partials);
    for (const partial of partials) {
      const text = (partial as { text?: string }).text;
      if (text !== undefined) expect(args.text.startsWith(text)).toBe(true);
    }
  });

  it('closes nested objects and arrays', () => {
    const args = {
      filters: { tags: ['alpha', 'beta', 'gamma'], range: { min: 1, max: 99 } },
      rows: [
        [1, 2],
        [3, 4],
      ],
      label: 'nested',
    };
    const partials = partialArguments(args);
    expect(partials.length).toBeGreaterThan(1);
    expectPlainObjects(partials);
    for (const partial of partials) expect(partial).not.toEqual(args);
    expect(partials.some((partial) => 'filters' in partial)).toBe(true);
  });

  it('backs off a dangling key or a partial literal instead of inventing a value', () => {
    const partials = partialArguments({ flag: true, other: null, count: 12345 });
    expectPlainObjects(partials);
    for (const partial of partials) {
      for (const [key, value] of Object.entries(partial)) {
        expect(['flag', 'other', 'count']).toContain(key);
        if (key === 'flag') expect(value).toBe(true);
        if (key === 'other') expect(value).toBeNull();
      }
    }
  });
});

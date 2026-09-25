/**
 * @fileoverview Tests for the partial-result schema and runtime helpers.
 * @module tests/utils/formatting/partialResult.test
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  failureEntrySchema,
  partialResult,
  partialResultSchema,
  resolvePartialResultKeys,
} from '@/utils/formatting/partialResult.js';

describe('failureEntrySchema', () => {
  it('builds an entry with the requested id key, reason, and optional detail', () => {
    const reason = z.enum(['no_oa', 'fetch_failed']);
    const schema = failureEntrySchema({
      idKey: 'pmid',
      idDescription: 'PMID',
      reason,
    });

    const valid = schema.parse({ pmid: '12345', reason: 'no_oa' });
    expect(valid).toEqual({ pmid: '12345', reason: 'no_oa' });

    const withDetail = schema.parse({ pmid: '12345', reason: 'fetch_failed', detail: '404' });
    expect(withDetail.detail).toBe('404');

    expect(() => schema.parse({ pmid: '12345', reason: 'wrong' })).toThrow();
  });

  it('respects the dynamic idKey in the schema shape', () => {
    const schema = failureEntrySchema({
      idKey: 'doi',
      reason: z.enum(['x', 'y']),
    });

    const result = schema.parse({ doi: '10.1/abc', reason: 'x' });
    expect(result.doi).toBe('10.1/abc');

    expect(() => schema.parse({ pmid: '1', reason: 'x' })).toThrow();
  });
});

describe('partialResultSchema', () => {
  const itemSchema = z.object({ id: z.string().describe('Item ID') });
  const reason = z.enum(['not_found', 'withdrawn']);

  it('produces a schema with succeeded array, total, and optional failed', () => {
    const schema = partialResultSchema({
      succeededKey: 'articles',
      succeededSchema: itemSchema,
      failedKey: 'unavailable',
      idKey: 'pmid',
      reason,
    });

    const result = schema.parse({
      articles: [{ id: 'a' }, { id: 'b' }],
      totalSucceeded: 2,
    });
    expect(result).toMatchObject({
      articles: [{ id: 'a' }, { id: 'b' }],
      totalSucceeded: 2,
    });
    expect((result as Record<string, unknown>).unavailable).toBeUndefined();

    const withFailures = schema.parse({
      articles: [{ id: 'a' }],
      totalSucceeded: 1,
      unavailable: [{ pmid: '999', reason: 'not_found' }],
    });
    expect((withFailures as { unavailable: unknown[] }).unavailable).toHaveLength(1);
  });
});

// Issue #524 — partial-success telemetry reads the author's keys, resolved from
// the output shape.
describe('resolvePartialResultKeys', () => {
  const itemSchema = z.object({ id: z.string().describe('Item ID') });
  const reason = z.enum(['not_found', 'withdrawn']).describe('Why it failed');
  const Out = partialResultSchema({
    succeededKey: 'articles',
    succeededSchema: itemSchema,
    failedKey: 'unavailable',
    idKey: 'pmid',
    reason,
  });

  it('names the arrays partialResultSchema built', () => {
    expect(resolvePartialResultKeys(Out.shape)).toEqual({
      failed: 'unavailable',
      succeeded: 'articles',
    });
  });

  it.each([
    ['.extend()', () => Out.extend({ note: z.string().describe('Note') }).shape],
    ['.pick()', () => Out.pick({ articles: true, unavailable: true }).shape],
    ['.omit()', () => Out.omit({ totalSucceeded: true }).shape],
    ['a .shape spread', () => z.object({ ...Out.shape }).shape],
  ])('follows the fields through %s', (_label, shape) => {
    expect(resolvePartialResultKeys(shape())).toEqual({
      failed: 'unavailable',
      succeeded: 'articles',
    });
  });

  it('reads the key a field sits under, not the key it was built with', () => {
    const renamed = { items: Out.shape.articles, misses: Out.shape.unavailable };
    expect(resolvePartialResultKeys(renamed)).toEqual({ failed: 'misses', succeeded: 'items' });
  });

  it('falls back to the literal key for a role no helper field claims', () => {
    const literalFailed = partialResultSchema({
      succeededKey: 'articles',
      succeededSchema: itemSchema,
      failedKey: 'failed',
      idKey: 'pmid',
      reason,
    });
    expect(resolvePartialResultKeys(literalFailed.shape)).toEqual({
      failed: 'failed',
      succeeded: 'articles',
    });
    expect(resolvePartialResultKeys(Out.pick({ unavailable: true }).shape)).toEqual({
      failed: 'unavailable',
      succeeded: 'succeeded',
    });
  });

  it.each([
    [
      'hand-written arrays',
      {
        articles: z.array(itemSchema).describe('Found'),
        unavailable: z.array(itemSchema).describe('Missing'),
      },
    ],
    ['a .partial() derivation, which rebuilds the fields', Out.partial().shape],
  ])('resolves the literal keys for %s', (_label, shape) => {
    expect(resolvePartialResultKeys(shape)).toEqual({ failed: 'failed', succeeded: 'succeeded' });
  });

  it('leaves the JSON Schema identical to the same shape built by hand', () => {
    const failure = z.object({
      pmid: z.string().describe('Identifier (pmid)'),
      reason,
      detail: z.string().optional().describe('Additional human-readable context, when available'),
    });
    const byHand = z.object({
      articles: z.array(itemSchema).describe('Successful items (articles)'),
      totalSucceeded: z
        .number()
        .int()
        .nonnegative()
        .describe("Number of successful items in 'articles'"),
      unavailable: z
        .array(failure)
        .optional()
        .describe(
          'Per-input explanations for inputs that could not be returned. Absent when nothing failed.',
        ),
    });

    expect(JSON.stringify(z.toJSONSchema(Out, { io: 'output' }))).toBe(
      JSON.stringify(z.toJSONSchema(byHand, { io: 'output' })),
    );
  });
});

describe('partialResult', () => {
  it('omits the failed key when no failures occurred', () => {
    const result = partialResult({
      succeededKey: 'items',
      succeeded: [{ id: 1 }, { id: 2 }],
      failedKey: 'failed',
      failed: [],
    });
    expect(result).toEqual({
      items: [{ id: 1 }, { id: 2 }],
      totalSucceeded: 2,
    });
    expect(result).not.toHaveProperty('failed');
  });

  it('includes the failed key when failures exist', () => {
    const result = partialResult({
      succeededKey: 'items',
      succeeded: [{ id: 1 }],
      failedKey: 'failed',
      failed: [{ id: 'x', reason: 'bad' }],
    });
    expect(result).toEqual({
      items: [{ id: 1 }],
      totalSucceeded: 1,
      failed: [{ id: 'x', reason: 'bad' }],
    });
  });

  it('always includes totalFailed when includeTotalFailed is true', () => {
    const empty = partialResult({
      succeededKey: 'items',
      succeeded: [],
      failedKey: 'failed',
      failed: [],
      includeTotalFailed: true,
    });
    expect(empty).toMatchObject({ totalSucceeded: 0, totalFailed: 0 });

    const some = partialResult({
      succeededKey: 'items',
      succeeded: [{ id: 1 }],
      failedKey: 'failed',
      failed: [{ id: 'x', reason: 'r' }],
      includeTotalFailed: true,
    });
    expect(some).toMatchObject({ totalSucceeded: 1, totalFailed: 1 });
  });
});

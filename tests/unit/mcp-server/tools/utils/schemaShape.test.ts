/**
 * @fileoverview Unit tests for the shared Zod root-shape checks (#142). The
 * definition builder, the server manifest, and the linter all classify a tool's
 * `input` through these, so the discriminated-vs-plain union distinction is
 * what keeps the three agreeing.
 * @module tests/unit/mcp-server/tools/utils/schemaShape.test
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  inputVariants,
  isDiscriminatedUnionSchema,
  isZodObjectSchema,
} from '@/mcp-server/tools/utils/schemaShape.js';

const byId = z.object({ mode: z.literal('byId'), id: z.string() });
const byName = z.object({ mode: z.literal('byName'), name: z.string() });
const union = z.discriminatedUnion('mode', [byId, byName]);

describe('isZodObjectSchema', () => {
  it('true for a z.object()', () => {
    expect(isZodObjectSchema(z.object({}))).toBe(true);
  });

  it.each([
    ['a discriminated union', union],
    ['a non-object Zod schema', z.string()],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a plain object with no _zod', {}],
    ['a string', 'not a schema'],
  ])('false for %s', (_label, value) => {
    expect(isZodObjectSchema(value)).toBe(false);
  });
});

describe('isDiscriminatedUnionSchema', () => {
  it('true for a z.discriminatedUnion()', () => {
    expect(isDiscriminatedUnionSchema(union)).toBe(true);
  });

  it('false for a plain z.union() — Zod tags both as `union`', () => {
    // The discriminator string is the only thing separating them, and a bare
    // union gives the model no key to choose a branch by.
    expect(isDiscriminatedUnionSchema(z.union([byId, byName]))).toBe(false);
  });

  it.each([
    ['a z.object()', z.object({})],
    ['null', null],
    ['undefined', undefined],
    ['a plain object with no _zod', {}],
  ])('false for %s', (_label, value) => {
    expect(isDiscriminatedUnionSchema(value)).toBe(false);
  });
});

describe('inputVariants', () => {
  it('returns a union’s options in declaration order', () => {
    expect(inputVariants(union)).toEqual([byId, byName]);
  });

  it('returns a single object root as its own only variant', () => {
    const single = z.object({ a: z.string() });
    expect(inputVariants(single)).toEqual([single]);
  });

  it.each([
    ['a plain z.union()', z.union([byId, byName])],
    ['a non-object Zod schema', z.string()],
    ['undefined', undefined],
  ])('returns nothing to walk for %s', (_label, value) => {
    expect(inputVariants(value)).toEqual([]);
  });
});

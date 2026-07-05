/**
 * @fileoverview Tests for Zod schema lint rules: object-shape checks,
 * `.describe()` presence/recursion, JSON Schema serializability, and the
 * shared schema-introspection helpers (`isZodObject`, `objectShape`,
 * `objectShapeKeys`, `unwrapWrappers`, `getCoreDefType`).
 * @module tests/unit/linter/schema-rules.test
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  checkFieldDescriptions,
  checkIsZodObject,
  checkSchemaSerializable,
  getCoreDefType,
  isZodObject,
  objectShape,
  objectShapeKeys,
  unwrapWrappers,
} from '@/linter/rules/schema-rules.js';

// ---------------------------------------------------------------------------
// checkIsZodObject
// ---------------------------------------------------------------------------

describe('checkIsZodObject', () => {
  it('returns null for a real ZodObject', () => {
    expect(checkIsZodObject(z.object({ a: z.string() }), 'input', 'tool', 'x')).toBeNull();
  });

  it('errors when schema is a non-object Zod type', () => {
    const diagnostic = checkIsZodObject(z.string(), 'input', 'tool', 'x');
    expect(diagnostic).toMatchObject({ rule: 'schema-is-object', severity: 'error' });
    expect(diagnostic?.message).toContain('input');
  });

  it('errors when schema is undefined', () => {
    expect(checkIsZodObject(undefined, 'output', 'tool', 'x')).toMatchObject({
      rule: 'schema-is-object',
    });
  });

  it('errors when schema is a plain object that is not a Zod schema at all', () => {
    expect(checkIsZodObject({}, 'params', 'resource', 'x')).toMatchObject({
      rule: 'schema-is-object',
    });
  });
});

// ---------------------------------------------------------------------------
// checkFieldDescriptions
// ---------------------------------------------------------------------------

describe('checkFieldDescriptions', () => {
  it('returns [] when schema is not a ZodObject', () => {
    expect(checkFieldDescriptions(z.string(), 'input', 'tool', 'x')).toEqual([]);
    expect(checkFieldDescriptions(undefined, 'input', 'tool', 'x')).toEqual([]);
  });

  it('returns [] for an object with no fields', () => {
    expect(checkFieldDescriptions(z.object({}), 'input', 'tool', 'x')).toEqual([]);
  });

  it('flags a top-level field with an empty-string describe (not just a missing one)', () => {
    const diagnostics = checkFieldDescriptions(
      z.object({ q: z.string().describe('') }),
      'input',
      'tool',
      'x',
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        rule: 'describe-on-fields',
        message: expect.stringContaining('input.q'),
      }),
    );
  });

  it('flags an optional field with no describe anywhere in the wrapper chain', () => {
    const diagnostics = checkFieldDescriptions(
      z.object({ q: z.string().optional() }),
      'input',
      'tool',
      'x',
    );
    expect(diagnostics).toContainEqual(expect.objectContaining({ rule: 'describe-on-fields' }));
  });

  it('does not flag a nullable field with describe on the inner type', () => {
    const diagnostics = checkFieldDescriptions(
      z.object({ q: z.string().describe('q').nullable() }),
      'input',
      'tool',
      'x',
    );
    expect(diagnostics).toEqual([]);
  });

  it('does not flag a readonly field with describe on the inner type', () => {
    const diagnostics = checkFieldDescriptions(
      z.object({ q: z.string().describe('q').readonly() }),
      'input',
      'tool',
      'x',
    );
    expect(diagnostics).toEqual([]);
  });

  it('does not flag a defaulted field with describe on the inner type', () => {
    const diagnostics = checkFieldDescriptions(
      z.object({ q: z.string().describe('q').default('x') }),
      'input',
      'tool',
      'x',
    );
    expect(diagnostics).toEqual([]);
  });

  it('flags a defaulted field with no describe anywhere', () => {
    const diagnostics = checkFieldDescriptions(
      z.object({ q: z.string().default('x') }),
      'input',
      'tool',
      'x',
    );
    expect(diagnostics).toContainEqual(expect.objectContaining({ rule: 'describe-on-fields' }));
  });

  it('handles a field whose unwrapped core has no _zod.def without throwing (defensive fallback)', () => {
    // A schema-shaped field whose declared type is 'object' but whose shape
    // holds a plain, non-Zod value — exercises the `if (!def) return;` guard
    // in recurseIntoCompound and the equivalent branch in hasDescription.
    const fakeShape = { weird: {} };
    const fakeObject = {
      _zod: { def: { type: 'object', shape: fakeShape } },
      shape: fakeShape,
    };
    expect(() => checkFieldDescriptions(fakeObject, 'input', 'tool', 'x')).not.toThrow();
    const diagnostics = checkFieldDescriptions(fakeObject, 'input', 'tool', 'x');
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('input.weird') }),
    );
  });

  it('does not crash and still flags a non-Zod primitive masquerading as a field', () => {
    const fakeShape = { broken: 'not-a-zod-schema' };
    const fakeObject = {
      _zod: { def: { type: 'object', shape: fakeShape } },
      shape: fakeShape,
    };
    const diagnostics = checkFieldDescriptions(fakeObject, 'input', 'tool', 'x');
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('input.broken') }),
    );
  });

  describe('nested objects', () => {
    it('recurses into nested object fields independently of the parent describe', () => {
      const diagnostics = checkFieldDescriptions(
        z.object({
          filter: z
            .object({ status: z.string().describe('status'), extra: z.string() })
            .describe('filter'),
        }),
        'input',
        'tool',
        'x',
      );
      expect(diagnostics).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('input.filter.extra') }),
      );
      expect(diagnostics.find((d) => d.message.includes('input.filter.status'))).toBeUndefined();
    });
  });

  describe('arrays', () => {
    it('recurses into array-of-object elements', () => {
      const diagnostics = checkFieldDescriptions(
        z.object({ items: z.array(z.object({ id: z.string() })).describe('items') }),
        'output',
        'tool',
        'x',
      );
      expect(diagnostics).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('output.items[].id') }),
      );
    });

    it('does not recurse into array-of-primitive elements', () => {
      const diagnostics = checkFieldDescriptions(
        z.object({ tags: z.array(z.string()).describe('tags') }),
        'output',
        'tool',
        'x',
      );
      expect(diagnostics).toEqual([]);
    });

    it('recurses into array-of-array (nested compound) elements', () => {
      const diagnostics = checkFieldDescriptions(
        z.object({ grid: z.array(z.array(z.object({ v: z.string() }))).describe('grid') }),
        'output',
        'tool',
        'x',
      );
      expect(diagnostics).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('output.grid[][].v') }),
      );
    });
  });

  describe('unions', () => {
    it('skips literal variants but recurses into non-literal variants', () => {
      const diagnostics = checkFieldDescriptions(
        z.object({
          value: z.union([z.literal('none'), z.object({ v: z.string() })]).describe('value'),
        }),
        'input',
        'tool',
        'x',
      );
      expect(diagnostics).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('input.value|1.v') }),
      );
      expect(diagnostics.find((d) => d.message.includes('input.value|0'))).toBeUndefined();
    });

    it('skips a literal variant even when wrapped in optional', () => {
      const diagnostics = checkFieldDescriptions(
        z.object({
          value: z
            .union([z.literal('none').optional(), z.string().describe('v')])
            .describe('value'),
        }),
        'input',
        'tool',
        'x',
      );
      expect(diagnostics.find((d) => d.message.includes('input.value|0'))).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// checkSchemaSerializable
// ---------------------------------------------------------------------------

describe('checkSchemaSerializable', () => {
  it('returns null for a non-ZodObject (nothing to check at this call site)', () => {
    expect(checkSchemaSerializable(z.string(), 'input', 'tool', 'x')).toBeNull();
  });

  it('returns null for a fully serializable object schema', () => {
    expect(
      checkSchemaSerializable(
        z.object({ a: z.string().describe('a'), b: z.number().optional().describe('b') }),
        'input',
        'tool',
        'x',
      ),
    ).toBeNull();
  });

  it('errors on z.custom()', () => {
    const diagnostic = checkSchemaSerializable(
      z.object({ x: z.custom<unknown>().describe('x') }),
      'input',
      'tool',
      'x',
    );
    expect(diagnostic).toMatchObject({ rule: 'schema-serializable', severity: 'error' });
  });

  it('errors on z.date()', () => {
    expect(
      checkSchemaSerializable(z.object({ when: z.date().describe('when') }), 'input', 'tool', 'x'),
    ).toMatchObject({ rule: 'schema-serializable' });
  });

  it('errors on z.bigint()', () => {
    expect(
      checkSchemaSerializable(z.object({ n: z.bigint().describe('n') }), 'output', 'tool', 'x'),
    ).toMatchObject({ rule: 'schema-serializable', message: expect.stringContaining('output') });
  });
});

// ---------------------------------------------------------------------------
// isZodObject
// ---------------------------------------------------------------------------

describe('isZodObject', () => {
  it('true for a real ZodObject', () => {
    expect(isZodObject(z.object({}))).toBe(true);
  });

  it.each([
    ['a non-object Zod schema', z.string()],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a plain object with no _zod', {}],
    ['a string', 'not a schema'],
  ])('false for %s', (_label, value) => {
    expect(isZodObject(value)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// objectShape / objectShapeKeys
// ---------------------------------------------------------------------------

describe('objectShape', () => {
  it('reads the shape of a real ZodObject via its direct .shape property', () => {
    const schema = z.object({ a: z.string(), b: z.number() });
    expect(Object.keys(objectShape(schema) ?? {})).toEqual(['a', 'b']);
  });

  it('returns undefined for a non-object input', () => {
    expect(objectShape(null)).toBeUndefined();
    expect(objectShape('nope')).toBeUndefined();
    expect(objectShape(42)).toBeUndefined();
  });

  it('falls back to _zod.def.shape when no direct .shape property is present', () => {
    const fake = { _zod: { def: { shape: { x: z.string() } } } };
    expect(Object.keys(objectShape(fake) ?? {})).toEqual(['x']);
  });

  it('falls back to legacy _def.shape when neither .shape nor _zod.def.shape is present', () => {
    const fake = { _def: { shape: { y: z.string() } } };
    expect(Object.keys(objectShape(fake) ?? {})).toEqual(['y']);
  });

  it('returns undefined when none of the three shape locations are present', () => {
    expect(objectShape({})).toBeUndefined();
  });

  it('returns undefined when a resolved "shape" is not itself an object', () => {
    const fake = { shape: 'not-an-object' };
    expect(objectShape(fake)).toBeUndefined();
  });
});

describe('objectShapeKeys', () => {
  it('returns field names for a real ZodObject', () => {
    expect(objectShapeKeys(z.object({ canvas_id: z.string(), rows: z.array(z.string()) }))).toEqual(
      ['canvas_id', 'rows'],
    );
  });

  it('returns [] when there is no shape to read', () => {
    expect(objectShapeKeys(undefined)).toEqual([]);
    expect(objectShapeKeys(z.string())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// unwrapWrappers / getCoreDefType
// ---------------------------------------------------------------------------

describe('unwrapWrappers', () => {
  it('returns the field unchanged for non-object input', () => {
    expect(unwrapWrappers('x')).toBe('x');
    expect(unwrapWrappers(null)).toBeNull();
    expect(unwrapWrappers(undefined)).toBeUndefined();
  });

  it('returns the field unchanged when it has no _zod.def', () => {
    const fake = {};
    expect(unwrapWrappers(fake)).toBe(fake);
  });

  it('unwraps a single optional wrapper', () => {
    const inner = z.string().describe('inner');
    expect(unwrapWrappers(inner.optional())).toBe(inner);
  });

  it('unwraps a single nullable wrapper', () => {
    const inner = z.string().describe('a');
    expect(unwrapWrappers(inner.nullable())).toBe(inner);
  });

  it('unwraps a single default wrapper', () => {
    const inner = z.string().describe('b');
    expect(unwrapWrappers(inner.default('x'))).toBe(inner);
  });

  it('unwraps a single readonly wrapper', () => {
    const inner = z.string().describe('c');
    expect(unwrapWrappers(inner.readonly())).toBe(inner);
  });

  it('unwraps a nonoptional wrapper down to its base type', () => {
    const wrapped = z.string().describe('d').optional().nonoptional();
    expect(getCoreDefType(wrapped)).toBe('string');
  });

  it('recurses through multiple stacked wrappers', () => {
    const inner = z.string().describe('deep');
    expect(unwrapWrappers(inner.nullable().optional())).toBe(inner);
  });
});

describe('getCoreDefType', () => {
  it('returns the unwrapped core type for a wrapped schema', () => {
    expect(getCoreDefType(z.string().optional())).toBe('string');
    expect(getCoreDefType(z.object({}).nullable())).toBe('object');
  });

  it('returns undefined for a non-object value', () => {
    expect(getCoreDefType('x')).toBeUndefined();
    expect(getCoreDefType(null)).toBeUndefined();
  });

  it('returns undefined for a plain object with no _zod.def', () => {
    expect(getCoreDefType({})).toBeUndefined();
  });
});

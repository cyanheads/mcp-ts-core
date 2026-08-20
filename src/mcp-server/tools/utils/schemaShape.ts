/**
 * @fileoverview Runtime shape checks for the Zod roots a tool definition may
 * declare. Zod 4 tags every schema with `_zod.def.type`, and a discriminated
 * union tags as `'union'` like any other — the discriminator on its `def` is
 * what separates the two. Kept in one place so the definition builder, the
 * server manifest, and the linter agree on what a union root is.
 * @module src/mcp-server/tools/utils/schemaShape
 */

import type { ZodDiscriminatedUnion, ZodObject, ZodRawShape } from 'zod';

/** The Zod 4 internals both checks read. */
interface ZodInternals {
  _zod?: { def?: { discriminator?: unknown; type?: string } };
}

/** True when `value` is a `z.object()`. */
export function isZodObjectSchema(value: unknown): value is ZodObject<ZodRawShape> {
  if (!value || typeof value !== 'object') return false;
  return (value as ZodInternals)._zod?.def?.type === 'object';
}

/**
 * True when `value` is a `z.discriminatedUnion()`.
 *
 * A plain `z.union()` also tags as `'union'` but carries no `discriminator`, so
 * the discriminator string is the distinguishing field. Only the discriminated
 * form is accepted as a tool input root: a bare union gives the model no key to
 * choose a branch by, and every variant's `required` list would apply at once.
 */
export function isDiscriminatedUnionSchema(
  value: unknown,
): value is ZodDiscriminatedUnion<readonly ZodObject<ZodRawShape>[]> {
  if (!value || typeof value !== 'object') return false;
  const def = (value as ZodInternals)._zod?.def;
  return def?.type === 'union' && typeof def.discriminator === 'string';
}

/**
 * The object variants of a tool input root: the union's options, or the single
 * object itself. Empty when the schema is neither — callers that lint or read
 * shapes then have nothing to walk rather than a partial view.
 */
export function inputVariants(schema: unknown): readonly ZodObject<ZodRawShape>[] {
  if (isDiscriminatedUnionSchema(schema)) {
    const options = (schema as { options?: unknown }).options;
    return Array.isArray(options)
      ? (options.filter(isZodObjectSchema) as ZodObject<ZodRawShape>[])
      : [];
  }
  return isZodObjectSchema(schema) ? [schema] : [];
}

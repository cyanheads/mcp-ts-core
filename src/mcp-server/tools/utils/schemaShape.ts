/**
 * @fileoverview Runtime shape checks for the Zod roots a tool definition may
 * declare. Zod 4 tags every schema with `_zod.def.type`, and a discriminated
 * union tags as `'union'` like any other — the discriminator on its `def` is
 * what separates the two. Kept in one place so the definition builder, the
 * server manifest, and the linter agree on what a union root is.
 * @module src/mcp-server/tools/utils/schemaShape
 */

import type { ZodDiscriminatedUnion, ZodObject, ZodRawShape } from 'zod';

/**
 * The Zod 4 definition fields the framework reads off a schema without going
 * through the class API: the `type` tag every schema carries, plus the
 * per-type payload (`shape`, `options`, `element`, …). Everything is optional
 * because the linter also sees partial and hostile objects.
 */
export interface ZodDef {
  checks?: unknown[];
  discriminator?: unknown;
  element?: unknown;
  entries?: Record<string, unknown>;
  innerType?: unknown;
  items?: unknown[];
  options?: unknown[];
  shape?: Record<string, unknown>;
  type?: string;
  values?: unknown[];
  valueType?: unknown;
}

/** Reads `_zod.def` from any value; `undefined` when it is not a Zod 4 schema. */
export function zodDef(value: unknown): ZodDef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return (value as { _zod?: { def?: ZodDef } })._zod?.def;
}

/** True when `value` is a `z.object()`. */
export function isZodObjectSchema(value: unknown): value is ZodObject<ZodRawShape> {
  return zodDef(value)?.type === 'object';
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
  const def = zodDef(value);
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

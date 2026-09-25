/**
 * @fileoverview Helpers for the "partial success" tool-output pattern: a tool
 * that processes N items and returns the ones that succeeded plus a structured
 * list of the ones that failed (each with a stable `reason` enum). Generalizes
 * the pattern exemplified by pubmed-mcp-server's `unavailable[]` array.
 * @module src/utils/formatting/partialResult
 */

import { z } from 'zod';

/**
 * The two output keys batch partial-success telemetry reads: the array of
 * failed entries and the array of succeeded items.
 */
export interface PartialResultKeys {
  failed: string;
  succeeded: string;
}

/** The keys read when the output schema names no others: a `{ succeeded, failed }` envelope. */
export const DEFAULT_PARTIAL_RESULT_KEYS: Readonly<PartialResultKeys> = Object.freeze({
  failed: 'failed',
  succeeded: 'succeeded',
});

/**
 * The role of each array field {@link partialResultSchema} builds, keyed on the
 * field instance. `.extend()`, `.pick()`, `.omit()`, and a `.shape` spread all
 * reuse field instances, so the role survives them; a side table rather than
 * `.meta()` keeps the advertised JSON Schema unchanged.
 */
const partialResultFieldRoles = new WeakMap<object, keyof PartialResultKeys>();

/**
 * Resolves the keys partial-success telemetry reads from a tool's output shape:
 * the key of each array field {@link partialResultSchema} built, by role, with
 * {@link DEFAULT_PARTIAL_RESULT_KEYS} filling any role no such field claims.
 *
 * Keyed on field instances, so a derivation that rebuilds a field — `.partial()`,
 * `.required()`, re-describing the field itself — falls back to the default key
 * for that role.
 */
export function resolvePartialResultKeys(shape: z.ZodRawShape): PartialResultKeys {
  let failed: string | undefined;
  let succeeded: string | undefined;
  for (const [key, field] of Object.entries(shape)) {
    const role = partialResultFieldRoles.get(field);
    if (role === 'failed') failed ??= key;
    else if (role === 'succeeded') succeeded ??= key;
  }
  return {
    failed: failed ?? DEFAULT_PARTIAL_RESULT_KEYS.failed,
    succeeded: succeeded ?? DEFAULT_PARTIAL_RESULT_KEYS.succeeded,
  };
}

/**
 * Builds a Zod schema for one entry in a partial-failure list.
 *
 * The shape is `{ [idKey]: string; reason: TReason; detail?: string }` —
 * the `idKey` field identifies the input the failure pertains to, `reason`
 * is a stable enum the caller can switch on, and `detail` is an optional
 * human-readable supplement.
 *
 * @example
 * ```ts
 * const UnavailableReason = z.enum([
 *   'no_pmc_fallback_disabled',
 *   'no_doi',
 *   'no_oa',
 *   'fetch_failed',
 *   'parse_failed',
 *   'service_error',
 * ]).describe('Why the PMID could not be returned');
 *
 * const Unavailable = failureEntrySchema({
 *   idKey: 'pmid',
 *   idDescription: 'PMID full text could not be returned for',
 *   reason: UnavailableReason,
 *   description: 'A PMID that could not be returned, with an explanation',
 * });
 * // → ZodObject<{ pmid: ZodString; reason: typeof UnavailableReason; detail: ZodOptional<ZodString> }>
 * ```
 */
export function failureEntrySchema<TIdKey extends string, TReason extends z.ZodTypeAny>(opts: {
  /** Field name that identifies the failed input (e.g. `'pmid'`, `'id'`). */
  idKey: TIdKey;
  /** Description for the id field. Surfaced in the JSON Schema. */
  idDescription?: string;
  /** Zod enum describing the stable `reason` values. */
  reason: TReason;
  /** Description for the entry as a whole. */
  description?: string;
  /** Description for the optional `detail` field. Defaults to a generic value. */
  detailDescription?: string;
}) {
  const idField = z.string().describe(opts.idDescription ?? `Identifier (${opts.idKey})`);
  const detailField = z
    .string()
    .optional()
    .describe(opts.detailDescription ?? 'Additional human-readable context, when available');

  // Build the shape with the dynamic id key. Cast through `unknown` because TS
  // can't narrow the index signature to the literal `TIdKey` without help.
  const shape = {
    [opts.idKey]: idField,
    reason: opts.reason,
    detail: detailField,
  } as { [K in TIdKey]: z.ZodString } & {
    reason: TReason;
    detail: z.ZodOptional<z.ZodString>;
  };

  const schema = z.object(shape);
  return opts.description ? schema.describe(opts.description) : schema;
}

/**
 * Standard tool-output shape for batch operations that may partially fail.
 *
 * Composes a typed succeeded list, totals, and an optional failures list with
 * stable reason codes. Wraps `failureEntrySchema` so callers don't have to
 * compose three things.
 *
 * Partial-success telemetry (`mcp.tool.partial_success`, `mcp.tool.batch.*`)
 * reads the two arrays under `succeededKey` and `failedKey`, including after
 * `.extend()`, `.pick()`, `.omit()`, or a `.shape` spread. See
 * {@link resolvePartialResultKeys} for the derivations it does not follow.
 *
 * @example
 * ```ts
 * const ArticleSchema = z.object({ pmid: z.string(), title: z.string() });
 *
 * export const fetchTool = tool('fetch_articles', {
 *   // ...
 *   output: partialResultSchema({
 *     succeededKey: 'articles',
 *     succeededSchema: ArticleSchema,
 *     failedKey: 'unavailable',
 *     idKey: 'pmid',
 *     reason: z.enum(['not_found', 'withdrawn']),
 *   }),
 *   // → { articles: ArticleSchema[], totalSucceeded: number,
 *   //     unavailable?: [{pmid, reason, detail?}] }
 *   //   plus totalFailed?: number with includeTotalFailed: true
 * });
 * ```
 */
export function partialResultSchema<
  TSuccKey extends string,
  TFailKey extends string,
  TIdKey extends string,
  TItem extends z.ZodTypeAny,
  TReason extends z.ZodTypeAny,
>(opts: {
  /** Key for the array of successful items (e.g. `'articles'`, `'records'`). */
  succeededKey: TSuccKey;
  /** Schema for one successful item. */
  succeededSchema: TItem;
  /** Description for the succeeded array. Optional. */
  succeededDescription?: string;
  /** Key for the array of failed entries (e.g. `'unavailable'`, `'failed'`). */
  failedKey: TFailKey;
  /** Field name that identifies a failed input on each failure entry. */
  idKey: TIdKey;
  /** Description for the failure entry's id field. */
  idDescription?: string;
  /** Reason enum (typically `z.enum([...])`). */
  reason: TReason;
  /** Description for one failure entry. */
  failureDescription?: string;
  /** When `true`, includes a `totalFailed` count alongside `totalSucceeded`. */
  includeTotalFailed?: boolean;
}) {
  const failureSchema = failureEntrySchema({
    idKey: opts.idKey,
    ...(opts.idDescription !== undefined && { idDescription: opts.idDescription }),
    reason: opts.reason,
    ...(opts.failureDescription !== undefined && { description: opts.failureDescription }),
  });

  const succeededField = z
    .array(opts.succeededSchema)
    .describe(opts.succeededDescription ?? `Successful items (${opts.succeededKey})`);

  const totalSucceededField = z
    .number()
    .int()
    .nonnegative()
    .describe(`Number of successful items in '${opts.succeededKey}'`);

  const failedField = z
    .array(failureSchema)
    .optional()
    .describe(
      `Per-input explanations for inputs that could not be returned. Absent when nothing failed.`,
    );

  partialResultFieldRoles.set(succeededField, 'succeeded');
  partialResultFieldRoles.set(failedField, 'failed');

  const baseShape = {
    [opts.succeededKey]: succeededField,
    totalSucceeded: totalSucceededField,
    [opts.failedKey]: failedField,
  } as Record<string, z.ZodTypeAny>;

  if (opts.includeTotalFailed) {
    baseShape.totalFailed = z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(`Number of failed inputs in '${opts.failedKey}'`);
  }

  return z.object(baseShape) as z.ZodObject<
    {
      [K in TSuccKey]: z.ZodArray<TItem>;
    } & {
      totalSucceeded: z.ZodNumber;
    } & {
      [K in TFailKey]: z.ZodOptional<z.ZodArray<typeof failureSchema>>;
    }
  >;
}

/**
 * Shape of the object returned by {@link partialResult}. Keys are derived from
 * the type parameters so the return type aligns with what `partialResultSchema`
 * produces — handlers can `return partialResult({...})` directly without
 * casting against `z.infer<typeof Output>`.
 *
 * `failedKey` and `totalFailed` are optional because the runtime helper omits
 * them when no failures occurred.
 */
export type PartialResultObject<
  TSuccKey extends string,
  TFailKey extends string,
  TItem,
  TFailEntry,
> = { [K in TSuccKey]: TItem[] } & {
  totalSucceeded: number;
} & { [K in TFailKey]?: TFailEntry[] } & { totalFailed?: number };

/**
 * Constructs a partial-result object at runtime, conditionally including the
 * failed array (omits it when empty so the structuredContent stays clean).
 *
 * @example
 * ```ts
 * return partialResult({
 *   succeededKey: 'articles',
 *   succeeded: articles,
 *   failedKey: 'unavailable',
 *   failed: unavailable,
 * });
 * // → { articles: [...], totalSucceeded: 3, unavailable: [...] }
 * // or, when unavailable is empty:
 * // → { articles: [...], totalSucceeded: 3 }
 * ```
 */
export function partialResult<
  TSuccKey extends string,
  TFailKey extends string,
  TItem,
  TFailEntry,
>(opts: {
  succeededKey: TSuccKey;
  succeeded: readonly TItem[];
  failedKey: TFailKey;
  failed: readonly TFailEntry[];
  /** When `true`, also includes `totalFailed`. */
  includeTotalFailed?: boolean;
}): PartialResultObject<TSuccKey, TFailKey, TItem, TFailEntry> {
  const out: Record<string, unknown> = {
    [opts.succeededKey]: opts.succeeded,
    totalSucceeded: opts.succeeded.length,
  };
  if (opts.failed.length > 0) {
    out[opts.failedKey] = opts.failed;
    if (opts.includeTotalFailed) {
      out.totalFailed = opts.failed.length;
    }
  } else if (opts.includeTotalFailed) {
    out.totalFailed = 0;
  }
  return out as PartialResultObject<TSuccKey, TFailKey, TItem, TFailEntry>;
}

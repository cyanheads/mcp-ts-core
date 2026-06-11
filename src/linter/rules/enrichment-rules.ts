/**
 * @fileoverview Lint rules for the `enrichment` block on tool definitions.
 * Validates the block's shape, guards against `output`-key collisions (which
 * `output.extend(enrichment)` would silently override), requires a markdown
 * renderer for non-scalar fields that would otherwise JSON-blob in the content[]
 * trailer, validates the `enrichmentTrailer` config, and — when no block is
 * declared — nudges meta-looking `output` fields toward enrichment.
 *
 * Every check here is a static shape check on the declaration, not a
 * handler-source scan: enrichment is populated via `ctx.enrich(...)`, which is
 * callable from the service layer and therefore invisible to a handler-body
 * scan. "Declared but never populated" is caught at runtime instead — a required
 * enrichment field that goes unpopulated fails the effective-output parse.
 * @module src/linter/rules/enrichment-rules
 */

import type { LintDefinitionType, LintDiagnostic } from '../types.js';
import { getCoreDefType, objectShape, objectShapeKeys, unwrapWrappers } from './schema-rules.js';

/** Pattern matching depth-0 cap-like input fields (case-insensitive, snake or camel). */
const CAP_FIELD_RE =
  /^(limit|per_page|perPage|page_size|pageSize|max_results|maxResults|max_items|maxItems)$/i;

/**
 * Output field names that almost always indicate agent-facing context rather
 * than domain payload. Kept deliberately tiny to avoid false positives —
 * `totalCount`, for instance, is legitimate domain data in many tools and is NOT
 * listed. Compared case-insensitively.
 */
const META_FIELD_HINTS: ReadonlySet<string> = new Set(['notice', 'effectivequery', 'queryecho']);

/** Heuristic: a value is a Zod schema if it carries the Zod 4 (`_zod`) or legacy (`_def`) marker. */
function isZodSchema(value: unknown): boolean {
  return !!value && typeof value === 'object' && ('_zod' in value || '_def' in value);
}

/**
 * Core Zod types whose runtime value is a JS object/array (`typeof === 'object'`),
 * which `JSON.stringify` into a one-line blob in the content[] enrichment trailer
 * unless the author supplies an `enrichmentTrailer.render`.
 */
const NON_SCALAR_CORE_TYPES: ReadonlySet<string> = new Set([
  'object',
  'array',
  'tuple',
  'record',
  'map',
  'set',
]);

/** True when the field's core (unwrapped) Zod type renders as a JSON blob in the trailer. */
function isNonScalarSchema(schema: unknown): boolean {
  const type = getCoreDefType(schema);
  return type !== undefined && NON_SCALAR_CORE_TYPES.has(type);
}

/**
 * True when the field is the recognized `delta` shape — a `z.object({ before, after })`
 * populated via `ctx.enrich.delta()`, which renders natively as "key: before → after".
 * Exempt from the non-scalar renderer requirement.
 */
function isDeltaShape(schema: unknown): boolean {
  const core = unwrapWrappers(schema);
  if (getCoreDefType(core) !== 'object') return false;
  const keys = objectShapeKeys(core);
  return keys.length === 2 && keys.includes('before') && keys.includes('after');
}

/**
 * Validates the `enrichment` block and its `enrichmentTrailer` config on a tool
 * definition.
 *
 * When `enrichment` is declared:
 *   - it must be an object mapping field names to Zod schemas (a `ZodRawShape`)
 *   - each field value must be a Zod schema
 *   - keys must be disjoint from `output` keys (`.extend` silently overrides
 *     collisions — this one is an error)
 *   - a non-scalar (object/array) field must declare an `enrichmentTrailer.render`
 *     (or be the `delta` shape) so it renders as markdown, not a JSON blob, in
 *     `content[]`
 *   - `enrichmentTrailer` keys must reference declared enrichment fields
 *
 * When `enrichment` is absent: emits an advisory nudge for any `output` field
 * whose name strongly signals agent-facing context (e.g. `notice`,
 * `effectiveQuery`) that would be better expressed as enrichment — and errors if
 * an `enrichmentTrailer` is declared with no block to attach to.
 */
export function lintEnrichmentContract(
  def: { enrichment?: unknown; output?: unknown; enrichmentTrailer?: unknown },
  definitionType: LintDefinitionType,
  definitionName: string,
): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  const outputKeys = objectShapeKeys(def.output);

  if (def.enrichment === undefined) {
    if (def.enrichmentTrailer !== undefined) {
      diagnostics.push({
        rule: 'enrichment-trailer-orphan',
        severity: 'error',
        message:
          `${definitionType} '${definitionName}' declares 'enrichmentTrailer' without an 'enrichment' ` +
          'block. Trailer config only renders enrichment fields — add the block or drop the config.',
        definitionType,
        definitionName,
      });
    }
    for (const key of outputKeys) {
      if (META_FIELD_HINTS.has(key.toLowerCase())) {
        diagnostics.push({
          rule: 'enrichment-prefer-block',
          severity: 'warning',
          message:
            `${definitionType} '${definitionName}' output field '${key}' looks like agent-facing ` +
            'context (empty-result notice, query echo) rather than domain payload. Consider an ' +
            '`enrichment` block populated via `ctx.enrich()` — enrichment fields are advertised in ' +
            "`tools/list` and mirrored into content[] without a format() entry. (Advisory; ignore if '" +
            `${key}' is genuinely domain data.)`,
          definitionType,
          definitionName,
        });
      }
    }
    return diagnostics;
  }

  if (
    typeof def.enrichment !== 'object' ||
    def.enrichment === null ||
    Array.isArray(def.enrichment)
  ) {
    diagnostics.push({
      rule: 'enrichment-type',
      severity: 'error',
      message: `${definitionType} '${definitionName}' 'enrichment' must be an object mapping field names to Zod schemas (a ZodRawShape).`,
      definitionType,
      definitionName,
    });
    return diagnostics;
  }

  const entries = Object.entries(def.enrichment as Record<string, unknown>);

  if (entries.length === 0) {
    diagnostics.push({
      rule: 'enrichment-empty',
      severity: 'warning',
      message:
        `${definitionType} '${definitionName}' declares an empty 'enrichment: {}' block — a no-op. ` +
        'Drop the field, or declare the agent-facing fields ctx.enrich() will populate.',
      definitionType,
      definitionName,
    });
    return diagnostics;
  }

  const outputKeySet = new Set(outputKeys);
  const enrichmentKeys = new Set(entries.map(([key]) => key));
  const trailerByKey =
    def.enrichmentTrailer && typeof def.enrichmentTrailer === 'object'
      ? (def.enrichmentTrailer as Record<string, { label?: unknown; render?: unknown } | undefined>)
      : undefined;

  for (const [key, schema] of entries) {
    if (!isZodSchema(schema)) {
      diagnostics.push({
        rule: 'enrichment-field-type',
        severity: 'error',
        message: `${definitionType} '${definitionName}' enrichment field '${key}' must be a Zod schema.`,
        definitionType,
        definitionName,
      });
    }
    if (outputKeySet.has(key)) {
      diagnostics.push({
        rule: 'enrichment-output-collision',
        severity: 'error',
        message:
          `${definitionType} '${definitionName}' enrichment field '${key}' collides with an 'output' field ` +
          'of the same name. The effective output schema is output.extend(enrichment); a collision silently ' +
          'overrides the output field. Rename one so enrichment keys are disjoint from output keys.',
        definitionType,
        definitionName,
      });
    }
    // Non-scalar fields render as a one-line JSON blob in the content[] trailer
    // unless the author supplies a renderer. The `delta` shape is exempt —
    // ctx.enrich.delta() renders it natively as "key: before → after".
    if (
      isZodSchema(schema) &&
      isNonScalarSchema(schema) &&
      !isDeltaShape(schema) &&
      typeof trailerByKey?.[key]?.render !== 'function'
    ) {
      diagnostics.push({
        rule: 'enrichment-trailer-render',
        severity: 'error',
        message:
          `${definitionType} '${definitionName}' enrichment field '${key}' holds a non-scalar ` +
          '(object/array) value, which renders as a one-line JSON blob in the content[] trailer ' +
          '(structuredContent keeps the full value). Supply a markdown renderer — ' +
          `enrichmentTrailer: { ${key}: { render: (v) => ... } } — use ctx.enrich.delta() for ` +
          'before/after state, or opt into JSON explicitly with render: (v) => JSON.stringify(v).',
        definitionType,
        definitionName,
      });
    }
  }

  // Trailer config must reference declared enrichment fields (catches drift /
  // typos that the keyof-typed config rejects at compile time for TS authors).
  if (trailerByKey) {
    for (const key of Object.keys(trailerByKey)) {
      if (!enrichmentKeys.has(key)) {
        diagnostics.push({
          rule: 'enrichment-trailer-unknown-field',
          severity: 'error',
          message:
            `${definitionType} '${definitionName}' enrichmentTrailer references '${key}', which is not a ` +
            'declared enrichment field. Trailer keys must match enrichment field names.',
          definitionType,
          definitionName,
        });
      }
    }
  }

  return diagnostics;
}

/** Options for the capped-list-no-truncation rule. */
export interface TruncationOptions {
  /** Tool names exempt from the rule. `false` disables the rule entirely. */
  truncationAllowlist?: ReadonlyArray<string> | false;
}

/**
 * Warns when a tool takes a cap-like input field (e.g. `limit`, `per_page`) and
 * returns an array output, but declares no truncation disclosure — neither a
 * `truncated` key in its declared `enrichment` shape, nor `totalCount` in enrichment,
 * nor `truncated` or `totalCount` as top-level `output` keys.
 *
 * The established `enrich.total()` convention (`totalCount`) and bespoke output fields
 * count as honest disclosure — the rule fires only on a genuinely silent cap.
 */
export function lintCappedListTruncation(
  def: { name?: unknown; input?: unknown; output?: unknown; enrichment?: unknown },
  truncationOptions?: TruncationOptions,
): LintDiagnostic[] {
  // Rule disabled via knob
  if (truncationOptions?.truncationAllowlist === false) return [];

  const name = typeof def.name === 'string' ? def.name : '<unnamed>';

  // Check allowlist
  const allowlist = truncationOptions?.truncationAllowlist;
  if (Array.isArray(allowlist) && allowlist.includes(name)) return [];

  // Check input for a cap-like field
  const inputKeys = objectShapeKeys(def.input);
  const hasCap = inputKeys.some((k) => CAP_FIELD_RE.test(k));
  if (!hasCap) return [];

  // Check output for at least one array-typed field
  const hasArrayOutput = hasTopLevelArray(def.output);
  if (!hasArrayOutput) return [];

  // Check for truncation disclosure:
  // 1. Declared enrichment has `truncated` or `totalCount`
  // 2. Output schema has a top-level `truncated` or `totalCount` key
  if (hasTruncationDisclosure(def.enrichment, def.output)) return [];

  return [
    {
      rule: 'capped-list-no-truncation',
      severity: 'warning',
      message:
        `Tool '${name}' accepts a cap-like input (${inputKeys.filter((k) => CAP_FIELD_RE.test(k)).join(', ')}) ` +
        `and returns an array, but discloses no truncation. A silently capped list leaves the agent ` +
        `unaware that results were cut off. Disclose via \`ctx.enrich.truncated({ shown, cap })\` and ` +
        `declare \`truncated\`, \`shown\`, \`cap\` in the \`enrichment\` block; or call \`ctx.enrich.total(n)\` ` +
        `when the upstream total is known; or add \`truncated\` / \`totalCount\` to the \`output\` schema. ` +
        `To suppress for this tool, add its name to \`truncationAllowlist\` in \`LintInput\` or ` +
        `\`MCP_LINT_TRUNCATION_ALLOWLIST\` in the environment.`,
      definitionType: 'tool',
      definitionName: name,
    },
  ];
}

/** True when the schema has at least one depth-0 field whose core Zod type is `array`. */
function hasTopLevelArray(schema: unknown): boolean {
  const shape = objectShape(schema);
  if (!shape) return false;
  return Object.values(shape).some((field) => getCoreDefType(unwrapWrappers(field)) === 'array');
}

/**
 * True when truncation is already disclosed — enrichment block has `truncated` or
 * `totalCount`, or output schema has a depth-0 `truncated` or `totalCount` key.
 */
function hasTruncationDisclosure(enrichment: unknown, output: unknown): boolean {
  const DISCLOSURE_KEYS = ['truncated', 'totalCount'];
  // Check enrichment shape
  if (enrichment && typeof enrichment === 'object' && !Array.isArray(enrichment)) {
    const enrichKeys = Object.keys(enrichment as Record<string, unknown>);
    if (DISCLOSURE_KEYS.some((k) => enrichKeys.includes(k))) return true;
  }
  // Check output shape
  const outputKeys = objectShapeKeys(output);
  return DISCLOSURE_KEYS.some((k) => outputKeys.includes(k));
}

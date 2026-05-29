/**
 * @fileoverview Lint rules for the `enrichment` block on tool definitions.
 * Validates the block's shape, guards against `output`-key collisions (which
 * `output.extend(enrichment)` would silently override), and — when no block is
 * declared — nudges meta-looking `output` fields toward enrichment.
 *
 * The conformance check is deliberately an advisory shape check, not a
 * handler-source scan: enrichment is populated via `ctx.enrich(...)`, which is
 * callable from the service layer and therefore invisible to a handler-body
 * scan. "Declared but never populated" is caught at runtime instead — a required
 * enrichment field that goes unpopulated fails the effective-output parse.
 * @module src/linter/rules/enrichment-rules
 */

import type { LintDefinitionType, LintDiagnostic } from '../types.js';

/**
 * Output field names that almost always indicate agent-facing context rather
 * than domain payload. Kept deliberately tiny to avoid false positives —
 * `totalCount`, for instance, is legitimate domain data in many tools and is NOT
 * listed. Compared case-insensitively.
 */
const META_FIELD_HINTS: ReadonlySet<string> = new Set(['notice', 'effectivequery', 'queryecho']);

/** Reads the top-level field names of a ZodObject, defensively across Zod 4 / legacy shapes. */
function objectShapeKeys(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const s = schema as {
    shape?: Record<string, unknown>;
    _zod?: { def?: { shape?: Record<string, unknown> } };
    _def?: { shape?: Record<string, unknown> };
  };
  const shape = s.shape ?? s._zod?.def?.shape ?? s._def?.shape;
  return shape && typeof shape === 'object' ? Object.keys(shape) : [];
}

/** Heuristic: a value is a Zod schema if it carries the Zod 4 (`_zod`) or legacy (`_def`) marker. */
function isZodSchema(value: unknown): boolean {
  return !!value && typeof value === 'object' && ('_zod' in value || '_def' in value);
}

/**
 * Validates the `enrichment` block on a tool definition.
 *
 * When `enrichment` is declared:
 *   - it must be an object mapping field names to Zod schemas (a `ZodRawShape`)
 *   - each field value must be a Zod schema
 *   - keys must be disjoint from `output` keys (`.extend` silently overrides
 *     collisions — this one is an error)
 *
 * When `enrichment` is absent: emits an advisory nudge for any `output` field
 * whose name strongly signals agent-facing context (e.g. `notice`,
 * `effectiveQuery`) that would be better expressed as enrichment.
 */
export function lintEnrichmentContract(
  def: { enrichment?: unknown; output?: unknown },
  definitionType: LintDefinitionType,
  definitionName: string,
): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  const outputKeys = objectShapeKeys(def.output);

  if (def.enrichment === undefined) {
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
  }

  return diagnostics;
}

/**
 * @fileoverview Cross-vendor JSON Schema portability lint rules.
 *
 * MCP pins JSON Schema 2020-12 as the default dialect (SEP-1613), but the LLM
 * vendors that ultimately consume tool/resource schemas each accept a different
 * subset of 2020-12. Schemas that pass `schema-serializable` and the rest of
 * the linter can still hard-fail at registration or silently lose fields when
 * the same server is consumed by a non-Anthropic client.
 *
 * These rules walk the emitted JSON Schema (not the Zod tree) and flag the
 * patterns most likely to break cross-vendor — see issue #132 for the spec
 * matrix and field-report evidence (gpt-5-codex hard-rejecting `format: "uri"`
 * via `cyanheads/git-mcp-server#47`, Gemini's `$defs` and `anyOf`-type-required
 * rules, Mastra's silent-drop matrix).
 *
 * @module src/linter/rules/portability-rules
 */

import type { ZodObject, ZodRawShape } from 'zod';
import { toJSONSchema } from 'zod/v4/core';
import {
  isDiscriminatedUnionSchema,
  isZodObjectSchema,
} from '@/mcp-server/tools/utils/schemaShape.js';
import type { LintDefinitionType, LintDiagnostic } from '../types.js';

/**
 * Default allowlist of JSON Schema `format` values, taken from OpenAI's
 * structured-outputs documentation — the strictest commonly-used target.
 * Override via `validateDefinitions({ formatAllowlist })` when targeting
 * a different vendor matrix.
 */
export const DEFAULT_FORMAT_ALLOWLIST: ReadonlySet<string> = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'uuid',
]);

/** Canonical JSON Schema 2020-12 dialect URI (SEP-1613). */
const JSON_SCHEMA_2020_12_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Options threaded from `validateDefinitions` into the portability rule
 * runner. `formatAllowlist` is always resolved (default applied) before
 * being passed; rules treat absent allowlist as a programmer error.
 */
export interface PortabilityOptions {
  /** Resolved `format` allowlist. */
  formatAllowlist: ReadonlySet<string>;
  /**
   * Promotes opt-in rules (`schema-no-defs`, `schema-dialect-tag`) to
   * warnings when set to `'strict'`. Otherwise those rules don't fire.
   */
  portability?: 'strict';
}

/** A subschema location during the walk. Pointer is a JSON Pointer (RFC 6901). */
interface Visited {
  node: Record<string, unknown>;
  pointer: string;
}

/**
 * Yields every subschema in a JSON Schema 2020-12 tree, paired with a
 * JSON Pointer to its location. Follows structural keywords: `properties`,
 * `items`, `prefixItems`, `additionalProperties` (schema form),
 * `anyOf`/`oneOf`/`allOf`, `$defs`. `$ref` is treated as opaque — referenced
 * subschemas are reachable via `$defs` so we don't risk cycles.
 */
function* walkJsonSchema(
  node: unknown,
  pointer: string,
  visited: WeakSet<object> = new WeakSet(),
): Generator<Visited> {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  if (visited.has(node)) return;
  visited.add(node);

  yield { pointer, node: node as Record<string, unknown> };

  const n = node as Record<string, unknown>;

  if (n.properties && typeof n.properties === 'object' && !Array.isArray(n.properties)) {
    for (const [k, v] of Object.entries(n.properties)) {
      yield* walkJsonSchema(v, `${pointer}/properties/${encodePointer(k)}`, visited);
    }
  }
  if (n.items && typeof n.items === 'object') {
    yield* walkJsonSchema(n.items, `${pointer}/items`, visited);
  }
  if (n.additionalProperties && typeof n.additionalProperties === 'object') {
    yield* walkJsonSchema(n.additionalProperties, `${pointer}/additionalProperties`, visited);
  }
  for (const combinator of ['anyOf', 'oneOf', 'allOf'] as const) {
    const arr = n[combinator];
    if (Array.isArray(arr)) {
      for (let i = 0; i < arr.length; i++) {
        yield* walkJsonSchema(arr[i], `${pointer}/${combinator}/${i}`, visited);
      }
    }
  }
  if (Array.isArray(n.prefixItems)) {
    for (let i = 0; i < n.prefixItems.length; i++) {
      yield* walkJsonSchema(n.prefixItems[i], `${pointer}/prefixItems/${i}`, visited);
    }
  }
  if (n.$defs && typeof n.$defs === 'object' && !Array.isArray(n.$defs)) {
    for (const [k, v] of Object.entries(n.$defs)) {
      yield* walkJsonSchema(v, `${pointer}/$defs/${encodePointer(k)}`, visited);
    }
  }
}

/** Encodes `/` and `~` per RFC 6901. */
function encodePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Runs every cross-vendor portability rule against one Zod schema.
 *
 * Caller contract: pass a root schema (validated by `checkIsZodObject`) that has
 * already passed `checkSchemaSerializable` — a ZodObject, or a discriminated
 * union of them on a tool input. `walkJsonSchema` descends `oneOf`, so union
 * variants are covered by the same pass. Other shapes are silently skipped;
 * serialization failures return no diagnostics so the existing
 * `schema-serializable` error stays the single source of truth for that class.
 */
export function lintSchemaPortability(
  schema: unknown,
  fieldName: string,
  definitionType: LintDefinitionType,
  definitionName: string,
  opts: PortabilityOptions,
): LintDiagnostic[] {
  if (!isZodObjectSchema(schema) && !isDiscriminatedUnionSchema(schema)) return [];

  let json: unknown;
  try {
    json = toJSONSchema(schema as ZodObject<ZodRawShape>);
  } catch {
    return [];
  }

  const strict = opts.portability === 'strict';
  const diagnostics: LintDiagnostic[] = [];

  // schema-root-oneof-portability (info / opt-in) — top-level check only.
  //
  // A multi-mode tool advertises `{"type":"object","oneOf":[…]}`. Every branch
  // is a typed object, so `schema-anyof-needs-type` is satisfied and the shape
  // is the one this file already recommends over the OpenAPI `discriminator`
  // keyword — in a *nested* position. At the parameter root it is unmeasured:
  // a vendor that reads `type` and `properties` and ignores `oneOf` sees a
  // parameterless tool and drops the constraint silently rather than erroring.
  // Flagged under the strict knob so an author targeting a broad vendor matrix
  // makes that call deliberately; not an error, since the emitted shape is
  // valid 2020-12 and correct on both MCP eras.
  if (strict && Array.isArray((json as Record<string, unknown>).oneOf)) {
    diagnostics.push({
      rule: 'schema-root-oneof-portability',
      severity: 'warning',
      message:
        `${definitionType} '${definitionName}' ${fieldName} has a root-level oneOf (a ` +
        `z.discriminatedUnion input). Branches are typed objects, so the shape is valid ` +
        `2020-12 and identical on both MCP protocol revisions — but vendor handling of a ` +
        `oneOf at the parameter root is unmeasured, and a client that reads only 'type' and ` +
        `'properties' would see a parameterless tool. ` +
        `Fix, if you need the widest vendor reach: flatten to a single z.object() with a ` +
        `discriminator field and optional per-mode fields, and validate the combination in ` +
        `the handler.`,
      definitionType,
      definitionName,
    });
  }

  // schema-dialect-tag (info / opt-in) — top-level check only.
  if (strict) {
    const top = json as Record<string, unknown>;
    if (typeof top.$schema !== 'string' || top.$schema.length === 0) {
      diagnostics.push({
        rule: 'schema-dialect-tag',
        severity: 'warning',
        message:
          `${definitionType} '${definitionName}' ${fieldName} top-level schema is missing $schema. ` +
          `SEP-1613 makes JSON Schema 2020-12 the default dialect, but explicit tagging ` +
          `("${JSON_SCHEMA_2020_12_DIALECT}") is forward-compatible — older SDK clients default to draft-07.`,
        definitionType,
        definitionName,
      });
    }
  }

  // Single pass through the schema for the per-node rules. Track $defs/$ref
  // sightings to emit `schema-no-defs` once per schema field instead of once
  // per reference site (recursive schemas would otherwise be very noisy).
  let usesDefsOrRef = false;

  for (const { pointer, node } of walkJsonSchema(json, '')) {
    // schema-format-portability (error, always on)
    if (typeof node.format === 'string') {
      const fmt = node.format;
      if (!opts.formatAllowlist.has(fmt)) {
        const allowed = [...opts.formatAllowlist].sort().join(', ');
        diagnostics.push({
          rule: 'schema-format-portability',
          severity: 'error',
          message:
            `${definitionType} '${definitionName}' ${fieldName}${pointer} emits format: "${fmt}", ` +
            `outside the portable allowlist (${allowed}). ` +
            `OpenAI's tool validator hard-rejects unknown format values — the tool refuses to register and the model never sees it ` +
            `(see cyanheads/git-mcp-server#47 for the gpt-5-codex field report). ` +
            `Fix: drop the format method (use a plain z.string()) and move the constraint into .describe() text where the model can read it. ` +
            `Override via validateDefinitions({ formatAllowlist }) if you're targeting only vendors that accept "${fmt}".`,
          definitionType,
          definitionName,
        });
      }
    }

    // schema-no-discriminator-keyword (warning, always on)
    if ('discriminator' in node) {
      diagnostics.push({
        rule: 'schema-no-discriminator-keyword',
        severity: 'warning',
        message:
          `${definitionType} '${definitionName}' ${fieldName}${pointer} uses the OpenAPI 'discriminator' keyword. ` +
          `OpenAI silently ignores it; Gemini doesn't recognize it. ` +
          `Use z.discriminatedUnion(...) — it emits the portable shape (oneOf of typed object branches with const-tagged literals).`,
        definitionType,
        definitionName,
      });
    }

    // schema-anyof-needs-type (warning, always on)
    for (const combinator of ['anyOf', 'oneOf'] as const) {
      const arr = node[combinator];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const branch = arr[i];
        if (!branch || typeof branch !== 'object') continue;
        const b = branch as Record<string, unknown>;
        // $ref-only branches are surfaced separately by schema-no-defs.
        if (typeof b.$ref === 'string') continue;
        if (b.type === undefined) {
          diagnostics.push({
            rule: 'schema-anyof-needs-type',
            severity: 'warning',
            message:
              `${definitionType} '${definitionName}' ${fieldName}${pointer}/${combinator}/${i} ` +
              `lacks a top-level 'type'. ` +
              `Gemini requires every branch of anyOf/oneOf to declare its type, or the request fails ` +
              `with "reference to undefined schema". ` +
              `Triggered by patterns like z.union([z.object(...).nullable(), z.object(...)]). ` +
              `Fix: prefer optionality via required-omission, or use z.discriminatedUnion for tagged unions.`,
            definitionType,
            definitionName,
          });
        }
      }
    }

    // schema-no-defs (info / opt-in) — accumulate, emit once.
    if (strict && ('$defs' in node || '$ref' in node)) {
      usesDefsOrRef = true;
    }
  }

  if (strict && usesDefsOrRef) {
    diagnostics.push({
      rule: 'schema-no-defs',
      severity: 'warning',
      message:
        `${definitionType} '${definitionName}' ${fieldName} emits $defs/$ref. ` +
        `Gemini's API rejects schemas with $defs/$ref ("400: reference to undefined schema"). ` +
        `Typically caused by reused or recursive z.lazy(...) types — inline the type when possible, ` +
        `or accept the limitation if targeting only Anthropic clients. ` +
        `SEP-1576 (token-bloat mitigation) is moving the spec community toward more $defs, so this rule ` +
        `is opt-in via MCP_LINT_PORTABILITY=strict or validateDefinitions({ portability: 'strict' }).`,
      definitionType,
      definitionName,
    });
  }

  return diagnostics;
}

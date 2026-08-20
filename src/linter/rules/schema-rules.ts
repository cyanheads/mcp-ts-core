/**
 * @fileoverview Lint rules for Zod schema validation: type checking, `.describe()`
 * presence, JSON Schema serializability, and satisfiability of the emitted schema.
 * Covers MCP spec rules T3-T5 and framework convention for field descriptions.
 * @module src/linter/rules/schema-rules
 */

import type { ZodObject, ZodRawShape } from 'zod';
import { toJSONSchema } from 'zod/v4/core';

import {
  inputVariants,
  isDiscriminatedUnionSchema,
  isZodObjectSchema,
} from '@/mcp-server/tools/utils/schemaShape.js';
import type { LintDiagnostic } from '../types.js';

/**
 * Checks that a schema is a ZodObject (required for tool inputSchema).
 * Spec: T3-T4 — inputSchema MUST be a JSON Schema object with type: "object".
 *
 * Pass `allowDiscriminatedUnion` on a tool's `input` root, where a
 * `z.discriminatedUnion()` of object variants is also valid: it advertises as
 * `{"type":"object","oneOf":[…]}`, satisfying the spec's object requirement
 * while keeping per-variant required fields. Output roots must stay objects —
 * the 2025-era projection rewrites a non-object output root and wraps
 * `structuredContent` to match.
 */
export function checkIsZodObject(
  schema: unknown,
  fieldName: string,
  definitionType: LintDiagnostic['definitionType'],
  definitionName: string,
  options: { allowDiscriminatedUnion?: boolean } = {},
): LintDiagnostic | null {
  if (isZodObjectSchema(schema)) return null;
  if (options.allowDiscriminatedUnion && isDiscriminatedUnionSchema(schema)) return null;

  const accepted = options.allowDiscriminatedUnion
    ? 'must be a z.object() or a z.discriminatedUnion() of z.object() variants'
    : 'must be a z.object()';
  return {
    rule: 'schema-is-object',
    severity: 'error',
    message:
      `${definitionType} '${definitionName}' ${fieldName} ${accepted}. ` +
      'MCP spec requires inputSchema to have type: "object".',
    definitionType,
    definitionName,
  };
}

/**
 * Checks that all fields in a ZodObject have `.describe()` set, recursing into
 * nested objects, array element types, and union/discriminatedUnion variants.
 * Framework convention: every field the LLM reads should carry a description.
 *
 * Path syntax in diagnostic messages:
 *   - `.key` for object properties
 *   - `[]` for array element types
 *   - `|<i>` for union / discriminatedUnion variant at index i
 */
export function checkFieldDescriptions(
  schema: unknown,
  fieldName: string,
  definitionType: LintDiagnostic['definitionType'],
  definitionName: string,
): LintDiagnostic[] {
  const roots = inputVariants(schema);
  if (roots.length === 0) return [];

  const diagnostics: LintDiagnostic[] = [];
  // A root carries no `.describe()` of its own — neither an object root nor a
  // union's variant objects, which are structural branches rather than fields
  // the model reads. So walk each root's *shape*, not the root. (A union in a
  // nested position is different: there the branch is a value a field can hold,
  // and `recurseIntoCompound` does ask it to describe itself.)
  const single = roots.length === 1;
  roots.forEach((root, i) => {
    const prefix = single ? fieldName : `${fieldName}|${i}`;
    for (const [key, field] of Object.entries(root.shape)) {
      walkField(field, `${prefix}.${key}`, diagnostics, definitionType, definitionName);
    }
  });

  return diagnostics;
}

/**
 * Emits a diagnostic when the field lacks a description, then recurses into
 * compound types (object, array, union) so inner fields get the same check.
 * A described container does NOT suppress checks on its children — each level
 * is evaluated independently because LLMs read the flattened JSON Schema.
 */
function walkField(
  field: unknown,
  path: string,
  diagnostics: LintDiagnostic[],
  definitionType: LintDiagnostic['definitionType'],
  definitionName: string,
): void {
  if (!hasDescription(field)) {
    diagnostics.push({
      rule: 'describe-on-fields',
      severity: 'warning',
      message:
        `${definitionType} '${definitionName}' ${path} is missing .describe(). ` +
        'Add .describe() to improve LLM tool-use quality.',
      definitionType,
      definitionName,
    });
  }

  recurseIntoCompound(field, path, diagnostics, definitionType, definitionName);
}

/**
 * Strips optional/nullable/default/readonly/nonoptional wrappers to find the
 * core type, then recurses into object shapes, array elements, and union
 * options. Non-compound cores (primitives, literals) terminate recursion.
 * Primitive array elements are skipped — array-level describe is sufficient.
 */
function recurseIntoCompound(
  field: unknown,
  path: string,
  diagnostics: LintDiagnostic[],
  definitionType: LintDiagnostic['definitionType'],
  definitionName: string,
): void {
  const core = unwrapWrappers(field);
  if (!core || typeof core !== 'object') return;

  const def = (core as { _zod?: { def?: { type?: string } } })._zod?.def;
  if (!def) return;

  if (def.type === 'object') {
    const shape = (core as ZodObject<ZodRawShape>).shape;
    for (const [key, inner] of Object.entries(shape)) {
      walkField(inner, `${path}.${key}`, diagnostics, definitionType, definitionName);
    }
    return;
  }

  if (def.type === 'array') {
    const element = (def as { element?: unknown }).element;
    if (element && isCompound(element)) {
      walkField(element, `${path}[]`, diagnostics, definitionType, definitionName);
    }
    return;
  }

  if (def.type === 'union') {
    const options = (def as { options?: unknown[] }).options;
    if (Array.isArray(options)) {
      options.forEach((option, i) => {
        // Skip z.literal(...) variants — structural markers (e.g. form-client
        // blank-tolerance sentinels like z.literal('')) carry no independent
        // semantic content. The outer union describe is sufficient; a describe
        // on the literal variant would ship to JSON Schema as clutter.
        if (isLiteralVariant(option)) return;
        walkField(option, `${path}|${i}`, diagnostics, definitionType, definitionName);
      });
    }
  }
}

/** True when the (unwrapped) field is a `z.literal(...)` — not a compound variant. */
function isLiteralVariant(field: unknown): boolean {
  return getCoreDefType(field) === 'literal';
}

/** Recursively strips optional/nullable/default/readonly/nonoptional wrappers. */
export function unwrapWrappers(field: unknown): unknown {
  if (!field || typeof field !== 'object') return field;
  const def = (field as { _zod?: { def?: { type?: string; innerType?: unknown } } })._zod?.def;
  if (!def) return field;
  const wrapperTypes = new Set(['optional', 'nullable', 'default', 'readonly', 'nonoptional']);
  if (def.type && wrapperTypes.has(def.type) && def.innerType) {
    return unwrapWrappers(def.innerType);
  }
  return field;
}

/** True if the (unwrapped) field is an object, array, or union — a compound type worth recursing into. */
function isCompound(field: unknown): boolean {
  const type = getCoreDefType(field);
  return type === 'object' || type === 'array' || type === 'union';
}

/** Unwrap optional/nullable/default and return the Zod 4 `_zod.def.type` discriminator. */
export function getCoreDefType(field: unknown): string | undefined {
  const core = unwrapWrappers(field);
  if (!core || typeof core !== 'object') return;
  return (core as { _zod?: { def?: { type?: string } } })._zod?.def?.type;
}

/**
 * Checks that a Zod schema can be converted to JSON Schema.
 * The MCP SDK serializes schemas via `toJSONSchema()` when handling `tools/list`.
 * Types like `z.custom()`, `z.date()`, `z.transform()`, etc. throw at serialization
 * time, causing a hard runtime failure for any client that enumerates tools.
 */
export function checkSchemaSerializable(
  schema: unknown,
  fieldName: string,
  definitionType: LintDiagnostic['definitionType'],
  definitionName: string,
): LintDiagnostic | null {
  if (!isSchemaRoot(schema)) return null;

  try {
    toJSONSchema(schema as ZodObject<ZodRawShape>);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Schema contains non-serializable types';
    return {
      rule: 'schema-serializable',
      severity: 'error',
      message:
        `${definitionType} '${definitionName}' ${fieldName} cannot be converted to JSON Schema: ${message}. ` +
        'Replace non-serializable types (z.custom(), z.date(), z.transform(), z.bigint(), etc.) with structural Zod types.',
      definitionType,
      definitionName,
    };
  }
}

/**
 * Checks that no node in the schema the SDK advertises describes an empty value
 * set — a field no input can ever satisfy.
 *
 * Evaluated on the emitted JSON Schema rather than on Zod internals, because the
 * two disagree in exactly the case that matters: `z.enum([1, 2, 3])` (a numeric
 * array handed to a string-only constructor) keeps its five options on the Zod
 * side but serializes to `{"type":"string","enum":[]}`. The emitted form is what
 * reaches the model, so it is the decisive one.
 *
 * Unsatisfiable: `enum: []`, `anyOf: []`, `oneOf: []`, `type: []`, and `not: {}`
 * / `not: true`. Explicitly NOT unsatisfiable: `allOf: []` (vacuously true —
 * matches everything), and empty `required` / `properties` / `prefixItems`,
 * which are absent constraints rather than impossible ones.
 *
 * Serializability failures are `checkSchemaSerializable`'s diagnostic, so this
 * check stays silent when conversion throws.
 */
export function checkSchemaSatisfiable(
  schema: unknown,
  fieldName: string,
  definitionType: LintDiagnostic['definitionType'],
  definitionName: string,
): LintDiagnostic[] {
  if (!isSchemaRoot(schema)) return [];

  let json: unknown;
  try {
    json = toJSONSchema(schema as ZodObject<ZodRawShape>);
  } catch {
    return [];
  }

  const paths: string[] = [];
  collectUnsatisfiablePaths(json, fieldName, paths, new Set());

  return paths.map((path) => ({
    rule: 'schema-unsatisfiable',
    severity: 'error' as const,
    message:
      `${definitionType} '${definitionName}' ${path} describes an empty value set — no value can ` +
      'satisfy it, so the field can never be populated and nothing downstream reports the gap. ' +
      'Common cause: a non-string array passed to z.enum(), which serializes to ' +
      '{"type":"string","enum":[]}; use z.literal([1, 2, 3]) for a closed set of non-string ' +
      'values. Also produced by z.enum([]), z.union([]), and z.never().',
    definitionType,
    definitionName,
  }));
}

/** True when a JSON Schema node's own keywords admit no value at all. */
function isUnsatisfiableNode(node: Record<string, unknown>): boolean {
  if (Array.isArray(node.enum) && node.enum.length === 0) return true;
  if (Array.isArray(node.anyOf) && node.anyOf.length === 0) return true;
  if (Array.isArray(node.oneOf) && node.oneOf.length === 0) return true;
  if (Array.isArray(node.type) && node.type.length === 0) return true;
  // `not: {}` / `not: true` negates the always-true schema.
  if (node.not === true) return true;
  if (
    typeof node.not === 'object' &&
    node.not !== null &&
    !Array.isArray(node.not) &&
    Object.keys(node.not).length === 0
  ) {
    return true;
  }
  return false;
}

/**
 * Walks the emitted JSON Schema collecting the path of every unsatisfiable node.
 * Never descends into `not` — an unsatisfiable subschema *there* makes the parent
 * match everything, the opposite finding. `seen` breaks `$ref` cycles from
 * recursive schemas.
 */
function collectUnsatisfiablePaths(
  node: unknown,
  path: string,
  out: string[],
  seen: Set<object>,
): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  if (seen.has(node)) return;
  seen.add(node);

  const n = node as Record<string, unknown>;
  if (isUnsatisfiableNode(n)) {
    out.push(path);
    return;
  }

  const properties = n.properties;
  if (properties && typeof properties === 'object') {
    for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
      collectUnsatisfiablePaths(child, `${path}.${key}`, out, seen);
    }
  }

  collectUnsatisfiablePaths(n.items, `${path}[]`, out, seen);
  collectUnsatisfiablePaths(n.additionalProperties, `${path}.<key>`, out, seen);

  for (const [i, item] of (Array.isArray(n.prefixItems) ? n.prefixItems : []).entries()) {
    collectUnsatisfiablePaths(item, `${path}[${i}]`, out, seen);
  }

  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = n[keyword];
    if (!Array.isArray(branches)) continue;
    for (const [i, branch] of branches.entries()) {
      collectUnsatisfiablePaths(branch, `${path}|${i}`, out, seen);
    }
  }

  for (const keyword of ['$defs', 'definitions'] as const) {
    const defs = n[keyword];
    if (!defs || typeof defs !== 'object') continue;
    for (const [key, def] of Object.entries(defs as Record<string, unknown>)) {
      collectUnsatisfiablePaths(def, `${path}.$defs.${key}`, out, seen);
    }
  }
}

/**
 * True for either root a definition may declare: a `z.object()` or a
 * `z.discriminatedUnion()` of object variants.
 *
 * The per-node rules below evaluate the emitted JSON Schema, and both walkers
 * already descend `oneOf`, so a union root needs no traversal of its own — only
 * for the root gate to let it through. Whether a union root is *allowed* on a
 * given field is `checkIsZodObject`'s call, made once per field; a rule that
 * runs after it should not re-litigate the decision by skipping the schema.
 */
function isSchemaRoot(value: unknown): boolean {
  return isZodObjectSchema(value) || isDiscriminatedUnionSchema(value);
}

/** Reads a ZodObject's raw shape, defensively across Zod 4 / legacy internals. */
export function objectShape(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return;
  const s = schema as {
    shape?: Record<string, unknown>;
    _zod?: { def?: { shape?: Record<string, unknown> } };
    _def?: { shape?: Record<string, unknown> };
  };
  const shape = s.shape ?? s._zod?.def?.shape ?? s._def?.shape;
  return shape && typeof shape === 'object' ? shape : undefined;
}

/** Reads the top-level field names of a ZodObject, defensively across Zod 4 / legacy shapes. */
export function objectShapeKeys(schema: unknown): string[] {
  const shape = objectShape(schema);
  return shape ? Object.keys(shape) : [];
}

/**
 * Checks whether a Zod schema (possibly wrapped in optional/nullable/default)
 * has a `.describe()` set at any level.
 */
function hasDescription(field: unknown): boolean {
  if (!field || typeof field !== 'object') return false;
  const f = field as { description?: string; _zod?: { def?: { innerType?: unknown } } };

  // Direct description on this schema
  if (typeof f.description === 'string' && f.description.length > 0) return true;

  // Walk through wrappers (optional, nullable, default, etc.)
  const inner = f._zod?.def?.innerType;
  if (inner) return hasDescription(inner);

  return false;
}

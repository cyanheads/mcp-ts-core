/**
 * @fileoverview Lint rules for Zod schema validation: type checking, `.describe()` presence,
 * and JSON Schema serializability.
 * Covers MCP spec rules T3-T5 and framework convention for field descriptions.
 * @module src/linter/rules/schema-rules
 */

import type { ZodObject, ZodRawShape } from 'zod';
import { toJSONSchema } from 'zod/v4/core';

import type { LintDiagnostic } from '../types.js';

/**
 * Checks that a schema is a ZodObject (required for tool inputSchema).
 * Spec: T3-T4 — inputSchema MUST be a JSON Schema object with type: "object".
 */
export function checkIsZodObject(
  schema: unknown,
  fieldName: string,
  definitionType: LintDiagnostic['definitionType'],
  definitionName: string,
): LintDiagnostic | null {
  if (!isZodObject(schema)) {
    return {
      rule: 'schema-is-object',
      severity: 'error',
      message:
        `${definitionType} '${definitionName}' ${fieldName} must be a z.object(). ` +
        'MCP spec requires inputSchema to have type: "object".',
      definitionType,
      definitionName,
    };
  }
  return null;
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
  if (!isZodObject(schema)) return [];

  const diagnostics: LintDiagnostic[] = [];
  const shape = (schema as ZodObject<ZodRawShape>).shape;

  for (const [key, field] of Object.entries(shape)) {
    walkField(field, `${fieldName}.${key}`, diagnostics, definitionType, definitionName);
  }

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
  if (!isZodObject(schema)) return null;

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

/** Runtime check for ZodObject via Zod 4's `_zod.def.type`. */
export function isZodObject(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const zod = (value as Record<string, unknown>)._zod as { def?: { type?: string } } | undefined;
  return zod?.def?.type === 'object';
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

/**
 * @fileoverview `x-mcp-header` input designation (protocol revision 2026-07-28).
 *
 * A tool may designate an input property with `x-mcp-header: "<Name>"`, which
 * makes the value ride an `Mcp-Param-<Name>` request header alongside the
 * JSON-RPC body so an intermediary can read it without parsing the body. It is
 * a mirroring/attestation mechanism, not a relocation: when the body carries a
 * value for a designated property the matching header MUST be present and
 * decode equal, and the handler still reads its argument from the body.
 *
 * `headerParam()` attaches the annotation via Zod `.meta()`, which passes
 * through to the emitted JSON Schema verbatim — the emission seam needs no
 * interception.
 *
 * The spec places five constraints on a declaration, and the SDK enforces them
 * with a `console.warn` rather than a rejection: an invalid declaration still
 * registers and the tool is then silently dropped by conforming Streamable HTTP
 * clients. {@link assertHeaderDesignations} runs the same scan at definition
 * time so the failure is a loud startup error instead. To stay in lockstep with
 * the runtime it targets, the scan here evaluates the *emitted JSON Schema*
 * — the same bytes the SDK scans — rather than Zod internals, and mirrors the
 * SDK's checks, their order, and its first-fault-wins short-circuit.
 *
 * @module src/mcp-server/tools/utils/headerParam
 */

import type { ZodType } from 'zod';
import { toJSONSchema } from 'zod/v4/core';

import { isDiscriminatedUnionSchema } from './schemaShape.js';

/** The JSON Schema extension key a designated input property carries. */
export const X_MCP_HEADER_KEY = 'x-mcp-header';

/**
 * RFC 9110 §5.1 `token` syntax (`1*tchar`). Rejects empty, space, control
 * characters (including CR/LF), and the HTTP delimiters.
 */
const RFC9110_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Emitted `type` values a designation may sit on.
 *
 * The spec names `string`, `integer`, and `boolean`; the SDK release this
 * framework targets also accepts `number` (its own source comment tracks the
 * discrepancy against the conformance referee). Matching the runtime is the
 * point of this scan — a rule that hard-rejected `number` would fail a
 * declaration the SDK accepts.
 */
const PERMITTED_TYPES = new Set(['boolean', 'integer', 'number', 'string']);

/**
 * JSON Schema keywords the static-reachability constraint excludes from the
 * `properties`-only chain. A designation found under any of them invalidates
 * the whole tool definition, so the walk visits them specifically to fail them.
 */
const NON_REACHABLE_SUBSCHEMA_KEYWORDS = [
  'items',
  'prefixItems',
  'contains',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'propertyNames',
  'patternProperties',
  'dependentSchemas',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  '$defs',
  'definitions',
] as const;

/**
 * Subschema-carrying keywords whose value is a `name → subschema` map rather
 * than a single subschema or an array of them.
 */
const OBJECT_VALUED_SUBSCHEMA_KEYWORDS = new Set([
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
]);

/**
 * One step of the walk from the schema root to a designation: a `properties`
 * key, or a descent through a subschema keyword (`label` names the branch when
 * the keyword carries several).
 */
export type DesignationStep =
  | { readonly key: string; readonly kind: 'property' }
  | { readonly keyword: string; readonly kind: 'branch'; readonly label?: number | string };

/** A validated `x-mcp-header` designation found on an emitted input schema. */
export interface HeaderDesignation {
  /** The declared header name — the wire header is `Mcp-Param-<headerName>`. */
  readonly headerName: string;
  /** Path from the schema root to the designated property. */
  readonly path: readonly DesignationStep[];
  /** The property's emitted JSON Schema `type`. */
  readonly type: string;
}

/**
 * Outcome of scanning an emitted input schema. Invalid carries the first
 * violated constraint and where it was found — the SDK stops at the first
 * fault too, so reporting more would be a divergence, not a courtesy.
 */
export type HeaderDesignationScan =
  | { readonly designations: readonly HeaderDesignation[]; readonly valid: true }
  | { readonly path: readonly DesignationStep[]; readonly reason: string; readonly valid: false };

/**
 * Designates a tool input property as an `x-mcp-header` parameter.
 *
 * The emitted property carries `"x-mcp-header": "<headerName>"` and nothing
 * else about the field changes — description, type, validation, and
 * requiredness are untouched. The wire header is `Mcp-Param-<headerName>`.
 *
 * Returns the same schema type, so it composes in either direction:
 * `headerParam(z.string(), 'Region').describe('…')` and
 * `headerParam(z.string().describe('…'), 'Region')` are equivalent.
 *
 * Only a primitive-typed property statically reachable through a chain of
 * `properties` keys may be designated; {@link assertHeaderDesignations} — run
 * by `tool()` — rejects anything else at definition time.
 *
 * @example
 * ```ts
 * input: z.object({
 *   region: headerParam(z.string(), 'Region').describe('Deployment region.'),
 * })
 * ```
 */
export function headerParam<TSchema extends ZodType>(schema: TSchema, headerName: string): TSchema {
  return schema.meta({ [X_MCP_HEADER_KEY]: headerName });
}

/**
 * Scans a tool's input root for `x-mcp-header` declarations and validates every
 * constraint the spec places on them.
 *
 * Evaluates the *emitted JSON Schema* — the same bytes the SDK scans — so a
 * verdict here is the SDK's verdict. Returns `undefined` when the schema cannot
 * be converted to JSON Schema at all: that is `schema-serializable`'s finding
 * and a hard SDK failure at registration, and the SDK swallows the same
 * conversion error around its own scan rather than reporting it twice.
 *
 * The walk descends `properties` at any depth (the spec's "any nesting depth"
 * clause) and visits every excluded position too, with reachability cleared, so
 * a designation found there fails rather than being missed.
 */
export function scanHeaderDesignations(input: unknown): HeaderDesignationScan | undefined {
  const inputSchema = emitInputJsonSchema(input);
  if (inputSchema === undefined) return undefined;
  return scanEmitted(inputSchema);
}

/** The constraint walk itself, over an already-emitted JSON Schema. */
function scanEmitted(inputSchema: Record<string, unknown>): HeaderDesignationScan {
  const designations: HeaderDesignation[] = [];
  const seenLower = new Map<string, string>();

  const validateDeclaration = (
    schema: Record<string, unknown>,
    path: readonly DesignationStep[],
    reachable: boolean,
  ): Fault | undefined => {
    if (!reachable || path.length === 0) {
      return {
        path,
        reason:
          'x-mcp-header is only permitted on a property statically reachable through a chain of ' +
          "'properties' keys — never on the schema root, and never under items, " +
          'additionalProperties, oneOf/anyOf/allOf/not, if/then/else, patternProperties, ' +
          'dependentSchemas, propertyNames, or a $defs target.',
      };
    }

    const raw = schema[X_MCP_HEADER_KEY];
    if (typeof raw !== 'string' || raw.length === 0) {
      return { path, reason: 'x-mcp-header must be a non-empty string.' };
    }
    if (!RFC9110_TOKEN.test(raw)) {
      return {
        path,
        reason:
          `x-mcp-header '${raw}' is not a valid RFC 9110 token — no spaces, control ` +
          'characters, or HTTP delimiters.',
      };
    }

    const type = typeof schema.type === 'string' ? schema.type : undefined;
    if (type === undefined || !PERMITTED_TYPES.has(type)) {
      return {
        path,
        reason:
          'x-mcp-header is only permitted on a primitive-typed property (string, integer, ' +
          `number, boolean); this property emits type ${type ?? '<none>'}.`,
      };
    }

    const lower = raw.toLowerCase();
    const prior = seenLower.get(lower);
    if (prior !== undefined) {
      return {
        path,
        reason:
          `x-mcp-header '${raw}' is not case-insensitively unique — '${prior}' is already ` +
          'declared elsewhere in this schema.',
      };
    }

    seenLower.set(lower, raw);
    designations.push({ headerName: raw, path, type });
    return undefined;
  };

  const visit = (
    node: unknown,
    path: readonly DesignationStep[],
    reachable: boolean,
  ): Fault | undefined => {
    if (node === null || typeof node !== 'object') return undefined;
    const schema = node as Record<string, unknown>;

    if (X_MCP_HEADER_KEY in schema) {
      const fault = validateDeclaration(schema, path, reachable);
      if (fault) return fault;
    }

    const properties = schema.properties;
    if (properties !== null && typeof properties === 'object') {
      for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
        const fault = visit(child, [...path, { key, kind: 'property' }], reachable);
        if (fault) return fault;
      }
    }

    for (const keyword of NON_REACHABLE_SUBSCHEMA_KEYWORDS) {
      const sub = schema[keyword];
      if (sub === undefined) continue;
      for (const [label, branch] of branchesOf(keyword, sub)) {
        const step: DesignationStep =
          label === undefined ? { keyword, kind: 'branch' } : { keyword, kind: 'branch', label };
        const fault = visit(branch, [...path, step], false);
        if (fault) return fault;
      }
    }

    return undefined;
  };

  const fault = visit(inputSchema, [], true);
  return fault ? { ...fault, valid: false } : { designations, valid: true };
}

/**
 * Renders a designation path in the linter's path vocabulary — `.key` for a
 * property, `[]`/`[i]` for array positions, `|i` for a composition branch,
 * `.<key>` for an `additionalProperties` value, `.<keyword>` for anything else.
 */
export function formatDesignationPath(path: readonly DesignationStep[], root: string): string {
  return path.reduce((rendered, step) => rendered + formatStep(step), root);
}

/**
 * Throws when a tool's input schema carries an invalid `x-mcp-header`
 * designation, naming the field path and the violated constraint.
 */
export function assertHeaderDesignations(toolName: string, input: unknown): void {
  const scan = scanHeaderDesignations(input);
  if (scan === undefined || scan.valid) return;

  const unionNote = isDiscriminatedUnionSchema(input)
    ? " A discriminated-union input root advertises 'oneOf' at the schema root, so every field " +
      'lives inside a branch — no field of a union-input tool can be designated.'
    : '';

  throw new Error(
    `Tool '${toolName}' declares an invalid x-mcp-header designation at ` +
      `${formatDesignationPath(scan.path, 'input')}: ${scan.reason}${unionNote} ` +
      'The MCP SDK only warns about this and registers the tool anyway, leaving conforming ' +
      'Streamable HTTP clients to drop it from tools/list — so it is rejected here instead.',
  );
}

/** The first violated constraint and the path it was found at. */
interface Fault {
  readonly path: readonly DesignationStep[];
  readonly reason: string;
}

/**
 * The JSON Schema the SDK scans for a tool's input: the `io: 'input'`
 * draft-2020-12 conversion with `type: 'object'` stamped on the root (a
 * discriminated union emits `oneOf` with no root `type`). Reproduced verbatim
 * so the scanned bytes are the SDK's rather than a near-copy.
 */
function emitInputJsonSchema(input: unknown): Record<string, unknown> | undefined {
  try {
    const emitted = toJSONSchema(input as Parameters<typeof toJSONSchema>[0], {
      io: 'input',
      target: 'draft-2020-12',
    });
    return { type: 'object', ...emitted };
  } catch {
    return undefined;
  }
}

/**
 * The subschemas a non-reachable keyword carries, each paired with the label
 * that names it: an index for an array-valued keyword, a key for a map-valued
 * one, `undefined` for a single subschema.
 */
function branchesOf(keyword: string, sub: unknown): Array<[number | string | undefined, unknown]> {
  if (Array.isArray(sub)) return sub.map((branch, index) => [index, branch]);
  if (sub !== null && typeof sub === 'object' && OBJECT_VALUED_SUBSCHEMA_KEYWORDS.has(keyword)) {
    return Object.entries(sub as Record<string, unknown>);
  }
  return [[undefined, sub]];
}

/** Renders one path step. See {@link formatDesignationPath}. */
function formatStep(step: DesignationStep): string {
  if (step.kind === 'property') return `.${step.key}`;
  switch (step.keyword) {
    case 'allOf':
    case 'anyOf':
    case 'oneOf':
      return `|${step.label}`;
    case 'items':
      return step.label === undefined ? '[]' : `[${step.label}]`;
    case 'prefixItems':
      return `[${step.label}]`;
    case 'additionalProperties':
    case 'unevaluatedProperties':
      return '.<key>';
    default:
      return step.label === undefined ? `.<${step.keyword}>` : `.<${step.keyword}:${step.label}>`;
  }
}

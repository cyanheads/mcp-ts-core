/**
 * @fileoverview Handler factory for tool definitions.
 * Constructs Context, checks inline auth, measures execution, formats response.
 * @module src/mcp-server/tools/utils/toolHandlerFactory
 */

import type {
  CallToolResult,
  ContentBlock,
  InputRequiredResult,
  ServerContext,
} from '@modelcontextprotocol/server';

import { ZodError, type ZodObject, type ZodRawShape, type ZodType, z } from 'zod';

import type { Context, EnrichmentStore } from '@/core/context.js';
import { readContentStore, readEnrichmentStore } from '@/core/context.js';
import {
  buildHandlerContext,
  type HandlerServices,
  handlerParentContext,
  resolveHandlerRequest,
} from '@/mcp-server/handlerContext.js';
import { type InputRequiredGate, isInputRequiredSignal } from '@/mcp-server/inputRequired.js';
import type { NotifierSources } from '@/mcp-server/notifications.js';
import { withRequiredScopes } from '@/mcp-server/transports/auth/lib/authUtils.js';
import {
  type ErrorContractSeverity,
  internalError,
  JsonRpcErrorCode,
  McpError,
} from '@/types-global/errors.js';
import { resolvePartialResultKeys } from '@/utils/formatting/partialResult.js';
import { asRequestCancelled, ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { measureToolExecution } from '@/utils/internal/performance.js';
import { type RequestContext, requestContextService } from '@/utils/internal/requestContext.js';
import { ATTR_MCP_TOOL_ENRICHED } from '@/utils/telemetry/attributes.js';
import {
  countCoerced,
  type InputHandlingOptions,
  prevalidateToolArguments,
  repairRepresentations,
} from './inputPrevalidation.js';
import { isZodObjectSchema } from './schemaShape.js';
import type { AnyToolDefinition } from './toolDefinition.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The factory's own contract, shared with the resource factory. */
export type { HandlerServices } from '@/mcp-server/handlerContext.js';
export type { NotifierSources } from '@/mcp-server/notifications.js';
export type { InputHandlingOptions } from './inputPrevalidation.js';

// ---------------------------------------------------------------------------
// Default formatter
// ---------------------------------------------------------------------------

const defaultResponseFormatter = (result: unknown): ContentBlock[] => [
  { type: 'text', text: JSON.stringify(result, null, 2) },
];

/**
 * Renders `content[]` for a validated tool result: `format()` (or the JSON
 * default) over the domain payload, with any blocks collected via
 * `ctx.content` (image/audio bytes) prepended. Collected blocks ride
 * `content[]` only — never `structuredContent` — so a handler can surface
 * media for the model without the base64 duplicating into the typed output.
 *
 * A formatter failure is isolated from handler failures so it classifies as
 * an internal error, carrying the formatter's own error as `cause`.
 */
export function renderToolContent(
  def: AnyToolDefinition,
  validatedOutput: Record<string, unknown>,
  ctx: Context,
): ContentBlock[] {
  let content: ContentBlock[];
  try {
    content = (def.format ?? defaultResponseFormatter)(validatedOutput);
  } catch (formatError) {
    throw internalError(
      `Output formatting failed: ${formatError instanceof Error ? formatError.message : String(formatError)}`,
      undefined,
      { cause: formatError },
    );
  }
  const collected = readContentStore(ctx)?.blocks;
  return collected && collected.length > 0 ? [...collected, ...content] : content;
}

// ---------------------------------------------------------------------------
// Error response shaping
// ---------------------------------------------------------------------------

/**
 * Pulls `data.recovery.hint` from an error data payload when present and
 * non-empty. Returns `undefined` otherwise. Used to mirror the hint into
 * `content[]` text so format()-only clients see the same recovery guidance
 * structuredContent-only clients receive via `error.data.recovery.hint`.
 */
function extractRecoveryHint(data: Record<string, unknown> | undefined): string | undefined {
  const hint = (data?.recovery as { hint?: unknown } | undefined)?.hint;
  return typeof hint === 'string' && hint.length > 0 ? hint : undefined;
}

/**
 * The compact trailing line carrying the two `data` fields a caller branches
 * on — `reason`, the stable identifier, and `retryable`, whether a retry can
 * succeed (#458). Both reach `structuredContent.error.data`; without this line
 * neither reaches the text surface, so a model that just failed cannot tell a
 * deterministic rejection from a transient one.
 *
 * Returns `undefined` when `data` carries neither — a classified plain
 * `Error`, an `McpError` with no `data` — leaving the text as it was. The
 * numeric `code` and `data.issues` stay JSON-only on purpose: the code is the
 * one envelope field a model cannot act on, and the message already renders
 * each issue as a sentence.
 */
function renderBranchableTerms(data: Record<string, unknown> | undefined): string | undefined {
  const terms: string[] = [];
  if (typeof data?.reason === 'string' && data.reason.length > 0) {
    terms.push(`reason ${data.reason}`);
  }
  if (typeof data?.retryable === 'boolean') {
    terms.push(data.retryable ? 'retryable' : 'not retryable');
  }
  return terms.length > 0 ? `(${terms.join(' · ')})` : undefined;
}

/**
 * Shapes a `CallToolResult` for a tool error response with parity across both
 * surfaces clients forward to the agent:
 * - `content[]` — read by clients like Claude Desktop (markdown)
 * - `structuredContent.error` — read by clients like Claude Code (JSON)
 *
 * The text carries the message, the `data.recovery.hint` when it adds
 * something, and the branchable `reason` / `retryable` terms
 * {@link renderBranchableTerms} renders; the numeric `code` and `data.issues`
 * stay JSON-only.
 *
 * The `Recovery:` line is dropped when the message already contains the hint
 * verbatim (#459) — `buildArgumentRecoveryHint` falls back to an issue's own
 * message for a constraint or refinement, and repeating that sentence costs
 * the reader without adding a next step. Containment, not equality: the
 * argument-rejection preamble and a field-path prefix both leave the hint's
 * whole text on screen. `structuredContent.error.data.recovery.hint` stays
 * populated either way, so #445's guarantee holds on the JSON surface.
 *
 * Note: `_meta.error` is intentionally NOT emitted — the error code, message,
 * and data live on `structuredContent.error` instead, mirroring the success
 * path's `structuredContent` surface.
 */
export function buildToolErrorResult(
  code: JsonRpcErrorCode,
  message: string,
  data: Record<string, unknown> | undefined,
): CallToolResult {
  const hint = extractRecoveryHint(data);
  const blocks = [`Error: ${message}`];
  if (hint !== undefined && !message.trim().includes(hint.trim())) blocks.push(`Recovery: ${hint}`);
  const terms = renderBranchableTerms(data);
  if (terms !== undefined) blocks.push(terms);
  const text = blocks.join('\n\n');
  return {
    isError: true,
    content: [{ type: 'text', text }],
    structuredContent: {
      error: {
        code,
        message,
        ...(data !== undefined && { data }),
      },
    },
  };
}

/** One entry of a `ZodError`'s issue list. */
type ArgumentIssue = ZodError['issues'][number];

/** The framework-owned `data.reason` on every argument rejection (#445). */
const INVALID_ARGUMENTS_REASON = 'invalid_arguments';

/** What {@link readArgumentAt} returns when the raw arguments carry no value there. */
const ABSENT = Symbol('absent');

/**
 * The value the raw arguments carry at `path`, or {@link ABSENT}.
 *
 * The one resolver behind #378's missing-vs-wrong rendering and #445's
 * missing-required hint, which ask the same question of the same arguments.
 * Zod's `invalid_value` issue names an expected set and nothing else, so an
 * omitted field and a wrong choice are otherwise indistinguishable. Resolving
 * it here keeps the caller's value in-process: only the absent/present bit and
 * the arriving *type* reach a rendered sentence, unlike Zod's `reportInput`
 * option, which would copy every rejected value onto `data.issues`.
 *
 * A key present with an explicit `null` is present — the caller supplied a
 * value, it was the wrong one. A key present with `undefined` is absent, which
 * is how Zod itself reads it.
 */
function readArgumentAt(args: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let cursor = args;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return ABSENT;
    if (!Object.hasOwn(cursor, segment)) return ABSENT;
    cursor = (cursor as Record<PropertyKey, unknown>)[segment];
  }
  return cursor === undefined ? ABSENT : cursor;
}

/** The accepted-value half of an `invalid_value` sentence, from the issue's own values. */
function expectedValuesText(values: readonly unknown[]): string {
  const rendered = values.map((value) => JSON.stringify(value)).join('|');
  return values.length === 1 ? `Expected ${rendered}` : `Expected one of ${rendered}`;
}

/**
 * The union branches worth rendering: every branch except one whose only issue
 * is a single-valued `invalid_value`.
 *
 * That shape is the `z.literal('')` blank-field sentinel of the form-client
 * convention — never the branch that says what would have been accepted. The
 * filter reads issue shape only, never message text, so a one-entry
 * `z.enum([...])` (which Zod reports identically) is filtered too and the
 * caller falls back to the union's own message.
 */
function selectUnionBranches(
  branches: ReadonlyArray<readonly ArgumentIssue[]>,
): ReadonlyArray<readonly ArgumentIssue[]> {
  return branches.filter((branch) => {
    const only = branch.length === 1 ? branch[0] : undefined;
    return !(only?.code === 'invalid_value' && only.values.length === 1);
  });
}

/**
 * The readable half of one issue's rendered line.
 *
 * Two rewrites, both keeping `data.issues` and the envelope shape untouched:
 *
 * - **#417** — Zod reports a union whose every branch aborted as one
 *   `invalid_union` issue whose own message is the placeholder `Invalid input`;
 *   what would have been accepted lives on the nested branch issues. Render the
 *   selected branches instead, joined by ` or `. (When exactly one branch
 *   matched the base type and failed only a check, Zod returns that branch's
 *   issues directly and this never fires.)
 * - **#447** — an object branch's issues carry their own branch-relative path,
 *   so {@link renderBranchIssue} prefixes each one with it and no alternative
 *   goes unnamed. Issues *within* a branch join on `; ` rather than the `, `
 *   that {@link formatInputValidationMessage} joins top-level issues with, so a
 *   reader can tell the two nestings apart.
 * - **#378** — an `invalid_value` issue (`z.enum`, `z.literal`) names an
 *   expected set without naming what arrived, so an omitted field and a wrong
 *   choice render identically. When the key is `absent`, say so and keep the
 *   expected set, which is the guidance a caller needs to fill the field in on
 *   one retry.
 *
 * On a required union field both compose: the branch is selected first, then
 * the absence check decides how that branch's message renders.
 */
function renderIssueMessage(issue: ArgumentIssue, absent: boolean): string {
  if (issue.code === 'invalid_union') {
    const branches = selectUnionBranches(issue.errors);
    if (branches.length === 0) return issue.message;
    const rendered = branches.map((branch) =>
      branch.map((branchIssue) => renderBranchIssue(branchIssue, absent)).join('; '),
    );
    return [...new Set(rendered)].join(' or ');
  }
  if (absent && issue.code === 'invalid_value') {
    return `Missing required field. ${expectedValuesText(issue.values)}`;
  }
  return issue.message;
}

/**
 * One issue of a union branch, prefixed with the branch-relative path it names.
 *
 * A scalar branch carries `path: []` and renders exactly as before; an object
 * branch's issues each name a field of that branch, and without the prefix two
 * alternatives that differ only in which field they require read as one
 * unattributed sentence — or collapse outright, since the caller dedupes
 * rendered branches. The outer path stays where
 * {@link formatInputValidationMessage} puts it; only the branch-relative
 * segments are added here.
 */
function renderBranchIssue(issue: ArgumentIssue, absent: boolean): string {
  const message = renderIssueMessage(issue, absent);
  return issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ${message}` : message;
}

/**
 * Renders an argument-validation failure the way the MCP SDK renders its own,
 * so the readable diagnostic — the offending key or field, and why it failed —
 * is unchanged for clients that read `content[]` text. The framework owns this
 * rejection (see `deferInputValidation`) purely so it can also carry
 * `structuredContent.error`.
 *
 * `args` are the caller's raw arguments, read only through
 * {@link readArgumentAt}; see {@link renderIssueMessage} for what that decides.
 */
export function formatInputValidationMessage(
  toolName: string,
  error: ZodError,
  args: unknown,
): string {
  const detail = error.issues
    .map((issue) => {
      const message = renderIssueMessage(issue, readArgumentAt(args, issue.path) === ABSENT);
      return issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ${message}` : message;
    })
    .join(', ');
  return `Input validation error: Invalid arguments for tool ${toolName}: ${detail}`;
}

/** `a number`, `an array` — the indefinite article a type name reads with. */
function withArticle(typeName: string): string {
  return `${/^[aeiou]/.test(typeName) ? 'an' : 'a'} ${typeName}`;
}

/** How a raw argument's JS type reads in the wrong-type sentence. */
function arrivedTypeText(value: unknown): string {
  if (value === null) return 'null';
  return withArticle(Array.isArray(value) ? 'array' : typeof value);
}

/** `lat`, `lat and lon`, `lat, lon and alt`. */
function joinNames(names: readonly string[]): string {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * The root property names a tool advertises, in schema order — the accepted-key
 * list of an unknown-key hint.
 *
 * Empty for a `z.discriminatedUnion()` root: `strictenInput` strictens each
 * variant, so `unrecognized_keys` does fire there, but the issue carries no way
 * to know which variant matched, and the union of every variant's keys would
 * claim the tool accepts a set no single call does.
 */
function rootPropertyNames(input: AnyToolDefinition['input']): readonly string[] {
  return isZodObjectSchema(input) ? Object.keys(input.shape) : [];
}

/**
 * Synthesizes `data.recovery.hint` from the Zod issues, the raw arguments, and
 * the root schema (#445) — so the one failure a weaker model hits most often
 * carries the same next step every handler-thrown error does, instead of
 * costing a round trip for the schema.
 *
 * One sentence per issue, joined into a single hint, except that every missing
 * required field collapses into one `Provide …` sentence at the first of their
 * positions. An issue no bucket claims contributes its rendered message
 * unchanged, which keeps the hint nonempty for any rejection Zod can produce.
 */
function buildArgumentRecoveryHint(def: AnyToolDefinition, error: ZodError, args: unknown): string {
  const sentences: string[] = [];
  const missing: string[] = [];
  let missingSlot = -1;

  for (const issue of error.issues) {
    const path = issue.path.map(String).join('.');
    const arrived = readArgumentAt(args, issue.path);

    if (issue.code === 'unrecognized_keys') {
      const label = issue.keys.length === 1 ? 'Unknown key' : 'Unknown keys';
      const accepted = rootPropertyNames(def.input);
      sentences.push(
        accepted.length > 0
          ? `${label} ${issue.keys.join(', ')}. This tool accepts: ${accepted.join(', ')}.`
          : `${label} ${issue.keys.join(', ')}.`,
      );
      continue;
    }

    if (path.length > 0 && arrived === ABSENT) {
      if (missingSlot < 0) {
        missingSlot = sentences.length;
        sentences.push('');
      }
      missing.push(path);
      continue;
    }

    if (issue.code === 'invalid_type') {
      const subject = path.length > 0 ? path : 'the arguments';
      const expected = withArticle(issue.expected);
      sentences.push(
        arrived === ABSENT
          ? `Send ${subject} as ${expected}.`
          : `Send ${subject} as ${expected}, not ${arrivedTypeText(arrived)}.`,
      );
      continue;
    }

    sentences.push(renderIssueMessage(issue, false));
  }

  if (missingSlot >= 0) sentences[missingSlot] = `Provide ${joinNames(missing)}.`;
  return sentences.join(' ');
}

/** What {@link parseToolArguments} needs beyond the definition and the arguments. */
export interface ParseToolArgumentsOptions {
  /** Request context the pre-validation step's debug logs correlate to. */
  context?: RequestContext;
  /** Server-level pre-validation switches, from `createApp({ input })`. */
  input?: InputHandlingOptions;
}

/**
 * Validates raw tool arguments against the definition's `input` schema, or
 * throws the rejection a client receives on the wire: `InvalidParams`
 * (`-32602`), the message {@link formatInputValidationMessage} renders, the Zod
 * issues as `data.issues`, and — as with any other declared failure —
 * `data.reason` plus a `data.recovery.hint` {@link buildArgumentRecoveryHint}
 * synthesizes (#445). {@link buildToolErrorResult} mirrors that hint into
 * `content[]`, so it reaches format()-only clients with no extra work.
 *
 * An ordered pre-validation step wraps the parse. Before it,
 * {@link prevalidateToolArguments} drops client-added keys (#453) and rewrites
 * key aliases (#452); after a failure — and only then —
 * {@link repairRepresentations} undoes a stringified array and the arguments
 * are parsed once more (#234), the repair kept only if the author's own schema
 * now accepts it. When nothing validates, the *original* rejection is thrown
 * verbatim, built from the arguments that produced it.
 *
 * The single argument-rejection path. {@link createToolHandler} and the
 * `runToolContract` test helper both route through it, so a test written to
 * the helper pins the code, message, and `content[]` text a deployment
 * actually produces (#416). Anything that classifies a `ZodError` as
 * `ValidationError` — a handler's own validation, the output-schema parse —
 * is a different failure and does not come through here.
 */
export function parseToolArguments<TDefinition extends AnyToolDefinition>(
  def: TDefinition,
  input: unknown,
  options: ParseToolArgumentsOptions = {},
): z.infer<TDefinition['input']> {
  const prepared = prevalidateToolArguments(def, input, options.input, options.context);
  const parsed = def.input.safeParse(prepared);
  if (parsed.success) return parsed.data as z.infer<TDefinition['input']>;

  if (options.input?.coerce !== false) {
    const repaired = repairRepresentations(prepared, parsed.error.issues);
    if (repaired !== prepared) {
      const retried = def.input.safeParse(repaired);
      if (retried.success) {
        countCoerced(def.name, options.context);
        return retried.data as z.infer<TDefinition['input']>;
      }
    }
  }

  throw new McpError(
    JsonRpcErrorCode.InvalidParams,
    formatInputValidationMessage(def.name, parsed.error, prepared),
    {
      issues: parsed.error.issues,
      reason: INVALID_ARGUMENTS_REASON,
      recovery: { hint: buildArgumentRecoveryHint(def, parsed.error, prepared) },
    },
  );
}

/**
 * Builds an error `CallToolResult` from a raw thrown value. Classifies via
 * {@link ErrorHandler.classifyOnly} when the value isn't already an
 * `McpError`. Only propagates data from `McpError` (its declared `data`) or
 * `ZodError` (its `issues`) — other thrown values get a `structuredContent.error`
 * with `code` and `message` only, so internal classification context never
 * leaks to clients.
 *
 * Use after invoking {@link ErrorHandler.handleError} for OTel/logging side
 * effects — this helper does not log.
 */
export function classifyAndBuildToolErrorResult(error: unknown): CallToolResult {
  if (error instanceof McpError) {
    return buildToolErrorResult(error.code, error.message, error.data);
  }
  const { code, message } = ErrorHandler.classifyOnly(error);
  const data = error instanceof ZodError ? { issues: error.issues } : undefined;
  return buildToolErrorResult(code, message, data);
}

// ---------------------------------------------------------------------------
// Success response shaping — enrichment merge + trailer
// ---------------------------------------------------------------------------

/**
 * The schema the framework **parses** a successful result against: the declared
 * `output`, extended with the `enrichment` block when one is declared. Strict by
 * construction — a required enrichment field the handler never populated fails
 * here, surfacing the authoring bug loudly.
 *
 * This is deliberately *not* what is advertised — see
 * {@link advertisedOutputSchema}.
 */
export function effectiveOutputSchema(def: AnyToolDefinition): ZodObject<ZodRawShape> {
  if (!def.enrichment) return def.output;
  return def.output.extend(def.enrichment) as ZodObject<ZodRawShape>;
}

/**
 * A contract entry's `when` text, terminated so the entry that follows it —
 * and the description's own trailing sentence — starts a new one (#389).
 * Nothing validates a punctuation convention on `when`, and an entry authored
 * as a fragment otherwise runs into whatever comes next. Punctuating at the
 * join leaves the authored text alone, terminator or not.
 */
function terminateWhen(when: string): string {
  const text = when.trim();
  return /[.?!]$/.test(text) ? text : `${text}.`;
}

/**
 * The error envelope a tool can put on `structuredContent` when it fails,
 * mirroring {@link buildToolErrorResult}'s runtime shape.
 *
 * Loose at every level on purpose: `data` carries the throw site's arbitrary
 * keys alongside `reason` / `recovery` / `retryable`, and generic classified
 * errors carry no `data` at all. A strict declaration would recreate on the
 * error path the very `-32602` this envelope exists to prevent (#241).
 *
 * `data.reason` stays `type: 'string'` even when the definition declares an
 * `errors[]` contract. The contract covers what the *handler* throws; a service
 * it calls can throw its own `data.reason` (the SQL gate's `denied_function`,
 * the parser's `yaml_parse_failed`), which reaches the wire verbatim. Narrowing
 * to an enum would make a strict client reject exactly those envelopes with
 * `-32602` — the failure #241 exists to prevent. The declared reasons are
 * carried as `examples` plus their `when` text in the description instead:
 * documented, not enforced.
 */
function toolErrorEnvelopeSchema(def: AnyToolDefinition): ZodType {
  const contract = def.errors ?? [];
  const reasons = contract.map((entry) => entry.reason);
  const reasonSchema =
    reasons.length > 0
      ? z
          .string()
          .describe(
            `Machine-readable failure mode. Declared by this tool: ${contract
              .map((entry) => `\`${entry.reason}\`: ${terminateWhen(entry.when)}`)
              .join(' ')} Other values are possible when a failure originates below the handler.`,
          )
          .meta({ examples: reasons })
      : z.string().describe('Machine-readable failure mode.');

  return z.looseObject({
    code: z.number().int().describe('JSON-RPC error code for this failure.'),
    message: z.string().describe('Human-readable description of what went wrong.'),
    data: z
      .looseObject({
        reason: reasonSchema.optional(),
        recovery: z
          .looseObject({ hint: z.string() })
          .optional()
          .describe('Actionable next step for the caller.'),
        retryable: z.boolean().optional().describe('Whether retrying may succeed.'),
      })
      .optional(),
  });
}

/**
 * The `outputSchema` advertised to clients in `tools/list` — every success field
 * made optional, plus a declared `error` property (#241).
 *
 * A tool that fails returns `structuredContent: { error: … }`, which can never
 * satisfy a success-only schema. Clients shipping an SDK whose `callTool()`
 * validates `structuredContent` without first checking `isError` (every v1
 * client, and every caller pinned to one) reject that envelope with `-32602`
 * before the `isError` result reaches the agent. Widening the advertised schema
 * is the only fix a server can ship, because the validator runs in the caller.
 *
 * **The root stays `type: 'object'`.** A discriminated union is the natural
 * expression of success-or-error and is a trap: it emits `anyOf` with no `type`,
 * which SEP-2106's legacy projection classifies as a non-object root and
 * rewrites to `{ result: <natural> }` for every 2025-era client — silently
 * breaking the *success* path for existing consumers to fix the error path.
 *
 * The cost of the object form is that `required` drops. An `anyOf` refinement
 * carried in schema metadata recovers it: a result must satisfy either the
 * success branch (success fields present, no `error`) or the failure branch
 * (`error` present). `type: 'object'` is still there, so the projection does not
 * trip, and `{}` — a handler that returned nothing — is rejected, which the
 * success-only schema never caught either.
 *
 * Emission only. {@link buildToolSuccessResult} keeps parsing against
 * {@link effectiveOutputSchema}, so the required-enrichment authoring check is
 * unaffected.
 */
export function advertisedOutputSchema(def: AnyToolDefinition): ZodObject<ZodRawShape> {
  const success = effectiveOutputSchema(def);
  const requiredSuccessKeys = Object.entries(success.shape)
    .filter(([, field]) => !(field as ZodType).safeParse(undefined).success)
    .map(([key]) => key);

  // Rebuilt field by field rather than via `success.partial()`: Zod rejects
  // `.partial()` outright on an object carrying `.refine()` / `.superRefine()`
  // checks, and `tool()` accepts those (both return a `ZodObject`), so calling
  // it would throw at registration and take the whole server down at startup.
  // Object-level refinements are dropped here on purpose — this schema is
  // advertised, never parsed against, and JSON Schema cannot express them.
  const optionalShape = Object.fromEntries(
    Object.entries(success.shape).map(([key, field]) => [key, (field as ZodType).optional()]),
  ) as ZodRawShape;
  const catchall = success.def.catchall;
  const base =
    catchall === undefined ? z.object(optionalShape) : z.object(optionalShape).catchall(catchall);
  const widened = base.extend({
    error: toolErrorEnvelopeSchema(def)
      .optional()
      .describe('Present when the call failed. Absent on success.'),
  }) as ZodObject<ZodRawShape>;

  const successBranch = {
    not: { required: ['error'] },
    ...(requiredSuccessKeys.length > 0 && { required: requiredSuccessKeys }),
  };

  // `.meta()` last: `.extend()` discards metadata, so the refinement has to be
  // attached to the final widened object or it is lost before emission.
  return widened.meta({
    anyOf: [successBranch, { required: ['error'] }],
  }) as ZodObject<ZodRawShape>;
}

/** Renders a non-kind-tagged enrichment value as compact trailer text. */
function formatEnrichmentScalar(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * True when a rendered field's last line leaves open a CommonMark container that
 * lazy continuation would pull the next field into — a block quote (`>`) or a
 * list item (`-`, `+`, `*`, `1.`, `1)`), each indented up to three spaces.
 *
 * Keyed on the line, not the field kind: a custom `enrichmentTrailer.render` can
 * emit multi-line markdown whose final line is a quote or a bullet, and either
 * one swallows what follows exactly as a `notice` does.
 *
 * A list marker must be followed by a space or end the line, so `**0 total**`
 * and a `***` rule are not mistaken for bullets.
 */
function opensLazyContainer(text: string): boolean {
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  return /^ {0,3}(?:>|(?:[-+*]|\d{1,9}[.)])(?: |$))/.test(lastLine);
}

/**
 * Joins rendered fields into the trailer body, closing any open container before
 * the next field. CommonMark lazy continuation folds an unprefixed paragraph line
 * that follows a block quote or list item *into* it, so a bare `\n` would render
 * server-authored facts (totals, query echoes) as quoted text attributed to the
 * notice, or as the tail of somebody's last bullet. Emitting the blank line only
 * after those lines keeps the compact single-`\n` layout everywhere else.
 */
function joinTrailerFields(fields: string[]): string {
  let text = '';
  for (const field of fields) {
    if (text.length > 0) text += opensLazyContainer(text) ? '\n\n' : '\n';
    text += field;
  }
  return text;
}

/**
 * Renders accumulated enrichment as a single `content[]` trailer block, so
 * `content[]`-only clients see the same context `structuredContent` clients get
 * from the merged output. Per field, rendering resolves in order:
 *   1. a per-field `enrichmentTrailer.render` (the author's full control; wins
 *      over everything — the escape hatch for structured fields that would
 *      otherwise JSON-blob),
 *   2. the kind-tag set by a field-helper (notice → blockquote, total →
 *      "N total", echo → "Query: …", delta → "field: before → after"),
 *   3. the generic `**key:** value` fallback (key overridable via `label`),
 *      `JSON.stringify`-ing non-scalars.
 *
 * `parsed` is the validated effective output, so renderers receive the typed,
 * post-parse value rather than the raw accumulator entry. The rendered markdown
 * is appended to `content[]` only — `structuredContent` is built separately from
 * the raw merged values and never carries this trailer text. The trailer text
 * leads with a blank-line separator so it stands off the preceding block on
 * clients that concatenate adjacent text blocks with no join (#257); markdown
 * collapses consecutive blank lines, so clients that do insert their own
 * separator render at most one blank line either way. Fields are joined by
 * {@link joinTrailerFields}, which terminates block quotes so a following field
 * renders as its own block (#308). Returns `[]` when nothing was enriched.
 */
function renderEnrichmentTrailer(
  store: EnrichmentStore,
  trailer: AnyToolDefinition['enrichmentTrailer'],
  parsed: Record<string, unknown>,
): ContentBlock[] {
  const fields: string[] = [];
  for (const key of Object.keys(store.values)) {
    // Skip keys the effective-output parse stripped (enriched but not declared in
    // the block) — the trailer mirrors what reached structuredContent.
    if (!(key in parsed)) continue;
    const value = parsed[key];
    const cfg = trailer?.[key];
    if (cfg?.render) {
      fields.push(cfg.render(value));
      continue;
    }
    switch (store.kinds.get(key)) {
      case 'notice':
        fields.push(`> ${String(value)}`);
        break;
      case 'total':
        fields.push(`**${String(value)} total**`);
        break;
      case 'echo':
        fields.push(`Query: ${String(value)}`);
        break;
      case 'delta': {
        const d = (value ?? {}) as { after?: unknown; before?: unknown };
        fields.push(
          `**${cfg?.label ?? key}:** ${formatEnrichmentScalar(d.before)} → ${formatEnrichmentScalar(d.after)}`,
        );
        break;
      }
      default:
        fields.push(`**${cfg?.label ?? key}:** ${formatEnrichmentScalar(value)}`);
    }
  }
  return fields.length > 0 ? [{ type: 'text', text: `\n\n${joinTrailerFields(fields)}` }] : [];
}

/**
 * Shapes the success `CallToolResult` surfaces from the validated domain payload
 * plus any accumulated enrichment:
 * - `structuredContent` — domain output merged with enrichment (validated against
 *   `output.extend(enrichment)`); the bare domain output when no enrichment block.
 * - `content[]` — the caller-rendered domain content (from `format()` or the
 *   JSON-stringify default, applied to the **domain payload only**) with the
 *   enrichment trailer always appended. Rendering the domain payload — never the
 *   merged object — keeps enrichment out of the JSON blob and avoids double-render.
 *
 * A required enrichment field the handler never populated fails the parse here,
 * surfacing the authoring bug as a loud error rather than dropping it silently.
 */
export function buildToolSuccessResult(
  def: AnyToolDefinition,
  ctx: Context,
  domainValidated: Record<string, unknown>,
  domainContent: ContentBlock[],
): Pick<CallToolResult, 'content' | 'structuredContent'> {
  if (!def.enrichment) {
    return { structuredContent: domainValidated, content: domainContent };
  }
  const store = readEnrichmentStore(ctx);
  const values = store?.values ?? {};
  const structuredContent = effectiveOutputSchema(def).parse({
    ...domainValidated,
    ...values,
  }) as Record<string, unknown>;
  const trailer =
    store && Object.keys(values).length > 0
      ? renderEnrichmentTrailer(store, def.enrichmentTrailer, structuredContent)
      : [];
  return {
    structuredContent,
    content: trailer.length > 0 ? [...domainContent, ...trailer] : domainContent,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * The log level the definition declared for the failure that just unwound, or
 * `undefined` to keep `error` (#380).
 *
 * The outer catch is the one place holding both the definition and the thrown
 * error, so the reason-to-entry lookup happens here rather than inside
 * `ErrorHandler`, which sees neither. Resolution is deliberately narrow: an
 * `McpError` whose `data.reason` names a contract entry that declared a
 * severity. A plain `Error`, a reason thrown below the handler that the
 * contract never declared, and an entry with no severity all fall through to
 * today's behavior. A cancellation is settled earlier — `asRequestCancelled`
 * replaces the thrown value, so no declared reason reaches this point.
 */
function declaredSeverity(
  def: AnyToolDefinition,
  error: unknown,
): ErrorContractSeverity | undefined {
  if (!(error instanceof McpError)) return undefined;
  const reason = error.data?.reason;
  if (typeof reason !== 'string') return undefined;
  return def.errors?.find((entry) => entry.reason === reason)?.severity;
}

/**
 * Creates an MCP tool handler from a tool definition.
 * The returned function is compatible with the MCP SDK's ToolCallback type.
 *
 * Responsibilities:
 * - Creates RequestContext from SDK context (for tracing)
 * - Creates unified Context (for the handler)
 * - Checks inline `auth` scopes if defined
 * - Validates input via Zod schema
 * - Measures execution time
 * - Formats response via `format` or JSON default
 * - Catches errors and returns `isError: true`
 */
export function createToolHandler(
  def: AnyToolDefinition,
  services: HandlerServices,
  notifiers: NotifierSources,
  inputGate?: InputRequiredGate,
): (
  input: Record<string, unknown>,
  ctx: ServerContext,
) => Promise<CallToolResult | InputRequiredResult> {
  // The handler's return value carries no marker, so the arrays partial-success
  // telemetry reads are named by the output schema — resolved once here (#524).
  const partialResultKeys = resolvePartialResultKeys(def.output.shape);

  return async (input, serverContext): Promise<CallToolResult | InputRequiredResult> => {
    const request = resolveHandlerRequest(serverContext, services, notifiers);
    const appContext = requestContextService.createRequestContext({
      parentContext: handlerParentContext(request),
      operation: 'HandleToolRequest',
      additionalContext: { toolName: def.name },
    });

    try {
      // Check inline auth scopes
      if (def.auth && def.auth.length > 0) {
        withRequiredScopes(def.auth, appContext);
      }

      // Validate input. The SDK's own argument check is deliberately deferred
      // to here (see `deferInputValidation`) so a rejection carries the
      // structured error envelope; the message and `InvalidParams`
      // classification match what the SDK produced before (#377).
      const validatedInput = parseToolArguments(def, input, {
        context: appContext,
        ...(services.input && { input: services.input }),
      });

      // Read by the success-attributes thunk below, which the measurement
      // evaluates after the callback settles.
      let ctx: Context | undefined;

      // Execute the handler AND the success-response pipeline under one
      // measurement. Output-schema validation, `format()`, the enrichment
      // merge, and the trailer render all decide the client-visible outcome,
      // so a failure in any of them is a failed call — closing the span when
      // the handler returned recorded those as successes (#346).
      return await measureToolExecution(
        async (spanContext, recordOutput) => {
          const handlerCtx = buildHandlerContext(
            request,
            services,
            spanContext,
            def.errors,
            inputGate,
          );
          ctx = handlerCtx;

          try {
            // Handler may return sync or async.
            const handlerResult = await def.handler(validatedInput, handlerCtx);

            // The domain value is what `mcp.tool.output_bytes` and
            // partial-success detection measure — not the assembled result this
            // callback returns, which re-renders it into content[].
            recordOutput(handlerResult);

            // Render content[] from the domain payload only (Resolution B), then
            // merge enrichment into structuredContent and append the content[] trailer.
            const validatedResult = def.output.parse(handlerResult) as Record<string, unknown>;
            return buildToolSuccessResult(
              def,
              handlerCtx,
              validatedResult,
              renderToolContent(def, validatedResult, handlerCtx),
            );
          } catch (error) {
            // Inside the measurement on purpose: the completion log's
            // `metrics.errorCode` and the span's error-code attribute are
            // derived from what leaves this callback (#421).
            throw asRequestCancelled(error, request.signal);
          }
        },
        { ...appContext, toolName: def.name },
        validatedInput,
        () => {
          const store = ctx ? readEnrichmentStore(ctx) : undefined;
          return store && Object.keys(store.values).length > 0
            ? { [ATTR_MCP_TOOL_ENRICHED]: true }
            : {};
        },
        partialResultKeys,
      );
    } catch (error: unknown) {
      // `ctx.requestInput(...)` is protocol control flow, not a failure: return
      // the `input_required` result untouched, with no span, log, or
      // classification. The client (2026 era) or the SDK's legacy shim (2025
      // era) fulfils it and re-invokes this handler. A request this connection
      // cannot serve never reaches here as a signal — `ctx.requestInput`
      // throws the refusal instead, and it arrives below as an `McpError`.
      if (isInputRequiredSignal(error)) return error.result;

      const severity = declaredSeverity(def, error);
      ErrorHandler.handleError(error, {
        operation: `tool:${def.name}`,
        context: appContext,
        ...(severity !== undefined && { severity }),
      });
      return classifyAndBuildToolErrorResult(error);
    }
  };
}

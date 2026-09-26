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

import { config } from '@/config/index.js';
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
import { parseOutputContract } from '@/mcp-server/outputContract.js';
import { withRequiredScopes } from '@/mcp-server/transports/auth/lib/authUtils.js';
import {
  type ErrorContractSeverity,
  internalError,
  JsonRpcErrorCode,
  McpError,
} from '@/types-global/errors.js';
import { resolvePartialResultKeys } from '@/utils/formatting/partialResult.js';
import { asRequestCancelled, ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { measureToolExecution, recordToolRejection } from '@/utils/internal/performance.js';
import {
  type RequestContext,
  requestContextService,
  withExtra,
} from '@/utils/internal/requestContext.js';
import { sanitization } from '@/utils/security/sanitization.js';
import { ATTR_MCP_TOOL_ENRICHED } from '@/utils/telemetry/attributes.js';
import {
  type CoercionKind,
  countCoerced,
  type InputHandlingOptions,
  type PrevalidatedArguments,
  type PrevalidationReport,
  prevalidateAliasFirst,
  prevalidateToolArguments,
  recordPrevalidation,
  repairRepresentations,
} from './inputPrevalidation.js';
import { isZodObjectSchema, type ZodDef, zodDef } from './schemaShape.js';
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
 * verbatim (#459) — `buildArgumentRecoveryHint` restates a constraint or
 * refinement issue as its own message line, and a hint made only of those is
 * the message's issue text, so repeating it costs the reader without adding a
 * next step. Containment, not equality: the argument-rejection preamble leaves
 * that text whole on screen, and so does a handler hint the message embeds.
 * `structuredContent.error.data.recovery.hint` stays populated either way, so
 * #445's guarantee holds on the JSON surface.
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
  const value = path.reduce<unknown>(stepInto, args);
  return value === undefined ? ABSENT : value;
}

/** The caller's value one step down, or `undefined` when nothing owns one there. */
function stepInto(value: unknown, step: PropertyKey): unknown {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, step)
    ? (value as Record<PropertyKey, unknown>)[step]
    : undefined;
}

/** The accepted-value half of an `invalid_value` sentence, from the issue's own values. */
function expectedValuesText(values: readonly unknown[]): string {
  const rendered = values.map((value) => JSON.stringify(value)).join('|');
  return values.length === 1 ? `Expected ${rendered}` : `Expected one of ${rendered}`;
}

/** The branch's only issue, when it has exactly one. */
function onlyIssue(branch: readonly ArgumentIssue[]): ArgumentIssue | undefined {
  return branch.length === 1 ? branch[0] : undefined;
}

/** Whether any of a branch's issues names a path below the branch's root. */
function failsBelowRoot(branch: readonly ArgumentIssue[]): boolean {
  return branch.some((issue) => issue.path.length > 0);
}

/**
 * The union branches worth rendering. Two filters, both reading issue shape
 * only, never message text:
 *
 * - **#417** — drop a branch whose only issue is a single-valued
 *   `invalid_value`. That shape is the `z.literal('')` blank-field sentinel of
 *   the form-client convention — never the branch that says what would have
 *   been accepted. A one-entry `z.enum([...])`, which Zod reports identically,
 *   is filtered too, and the caller falls back to the union's own message.
 * - **#492** — once some branch fails below its root, drop every branch whose
 *   only issue is a root `invalid_type`. In a one-or-many field
 *   (`z.union([z.array(Item), Item])`) that branch merely says the value is
 *   the other shape; the branch that failed inside the value is the one that
 *   says what to change. When every branch fails at its root, none is dropped.
 */
function selectUnionBranches(
  branches: ReadonlyArray<readonly ArgumentIssue[]>,
): ReadonlyArray<readonly ArgumentIssue[]> {
  const selected = branches.filter((branch) => {
    const only = onlyIssue(branch);
    return !(only?.code === 'invalid_value' && only.values.length === 1);
  });
  if (!selected.some(failsBelowRoot)) return selected;
  return selected.filter((branch) => {
    const only = onlyIssue(branch);
    return !(only?.code === 'invalid_type' && only.path.length === 0);
  });
}

/**
 * One line of a rendered argument rejection: a Zod issue and the full path it
 * renders under. The path equals `issue.path` except for an issue lifted out of
 * a union branch, whose branch-relative path follows the union's own.
 */
interface RenderedIssue {
  readonly issue: ArgumentIssue;
  readonly path: readonly PropertyKey[];
}

/**
 * The issues a rejection renders, in order: Zod's list, except that a union
 * left with one selected branch that fails below its root is replaced by that
 * branch's issues under the union's path (#492) — so a one-or-many field
 * reports a list element's field error exactly as a list-only field does
 * (`items.1.name: …`). Recursive, so a one-or-many union nested in another, or
 * inside a list element, resolves the same way at every level.
 *
 * The message ({@link formatInputValidationMessage}) and the hint
 * ({@link buildArgumentRecoveryHint}) both render from this list, which keeps
 * the hint's restatements identical to the message's lines. `data.issues` is
 * never rebuilt from it: it ships Zod's own list.
 */
function renderedIssues(
  issues: readonly ArgumentIssue[],
  prefix: readonly PropertyKey[] = [],
): RenderedIssue[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'invalid_union') {
      const [branch, ...others] = selectUnionBranches(issue.errors);
      if (branch && others.length === 0 && failsBelowRoot(branch)) {
        return renderedIssues(branch, path);
      }
    }
    return [{ issue, path }];
  });
}

/** `items.1.name` — the dotted form a path takes in the message and the hint. */
function dottedPath(path: readonly PropertyKey[]): string {
  return path.map(String).join('.');
}

/**
 * One line of the rendered detail: `path: message`, or the bare message at the
 * root. `args` decides the absent/present bit {@link renderIssueMessage} reads.
 */
function renderIssueLine({ issue, path }: RenderedIssue, args: unknown): string {
  const message = renderIssueMessage(issue, readArgumentAt(args, path) === ABSENT);
  return path.length > 0 ? `${dottedPath(path)}: ${message}` : message;
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
  return issue.path.length > 0 ? `${dottedPath(issue.path)}: ${message}` : message;
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
  const detail = renderedIssues(error.issues)
    .map((entry) => renderIssueLine(entry, args))
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

/** The Zod 4 definition fields {@link objectSchemaAt} reads beyond `ZodDef`'s. */
type WalkedDef = ZodDef & {
  getter?: () => unknown;
  in?: unknown;
  rest?: unknown;
};

/**
 * The `z.object()` a nested unknown-key issue sits in, found by walking its
 * rendered path down from `schema` beside the caller's own `value` — or
 * `undefined` when the path does not land on exactly one object (#566).
 *
 * Wrappers (`optional`, `nullable`, `default`, …), `pipe`, and `z.lazy()` are
 * looked through. A numeric step enters an array element or tuple item; a
 * string step, a property or a record value. A discriminated union follows the
 * variant the argument's own discriminator selects, as Zod did. A plain union
 * follows the one option under which the rest of the path still lands on an
 * object — the branch {@link renderedIssues} lifted under #492. Anything else,
 * an intersection or a union two options satisfy, resolves to nothing.
 */
function objectSchemaAt(
  schema: unknown,
  path: readonly PropertyKey[],
  value: unknown,
): ZodObject<ZodRawShape> | undefined {
  const def = zodDef(schema) as WalkedDef | undefined;
  if (!def) return undefined;
  if (def.type === 'lazy' && def.getter) return objectSchemaAt(def.getter(), path, value);
  if (def.type === 'pipe') return objectSchemaAt(def.in, path, value);
  if (def.innerType !== undefined) return objectSchemaAt(def.innerType, path, value);
  if (def.type === 'union') return unionOptionAt(def, path, value);

  const [step, ...rest] = path;
  if (step === undefined) return isZodObjectSchema(schema) ? schema : undefined;
  const next = stepInto(value, step);

  switch (def.type) {
    case 'object':
      return typeof step === 'string' && def.shape && Object.hasOwn(def.shape, step)
        ? objectSchemaAt(def.shape[step], rest, next)
        : undefined;
    case 'record':
      return objectSchemaAt(def.valueType, rest, next);
    case 'array':
      return typeof step === 'number' ? objectSchemaAt(def.element, rest, next) : undefined;
    case 'tuple':
      return typeof step === 'number'
        ? objectSchemaAt(def.items?.[step] ?? def.rest, rest, next)
        : undefined;
    default:
      return undefined;
  }
}

/** {@link objectSchemaAt} at a union: the one option the path resolves through. */
function unionOptionAt(
  def: WalkedDef,
  path: readonly PropertyKey[],
  value: unknown,
): ZodObject<ZodRawShape> | undefined {
  const options = def.options ?? [];
  const { discriminator } = def;
  if (typeof discriminator === 'string') {
    const tag = stepInto(value, discriminator);
    const selected = options.find((option) => {
      const field = isZodObjectSchema(option) ? option.shape[discriminator] : undefined;
      return (field as ZodType | undefined)?.safeParse(tag).success === true;
    });
    return selected === undefined ? undefined : objectSchemaAt(selected, path, value);
  }
  const resolved = options.flatMap((option) => objectSchemaAt(option, path, value) ?? []);
  return resolved.length === 1 ? resolved[0] : undefined;
}

/**
 * The unknown-key sentence for one `unrecognized_keys` issue.
 *
 * A root key names the root properties the tool advertises (#445). A key inside
 * a nested strict object is named by its full path, beside the keys that object
 * accepts (#566) — the root list there would send the caller to move the key to
 * the root or rename it after a root field. Neither list is given when there is
 * none to give: a discriminated-union root, a nested object declaring no keys,
 * or a path {@link objectSchemaAt} cannot resolve.
 */
function unknownKeySentence(
  input: AnyToolDefinition['input'],
  keys: readonly string[],
  path: readonly PropertyKey[],
  args: unknown,
): string {
  const label = keys.length === 1 ? 'Unknown key' : 'Unknown keys';
  if (path.length === 0) {
    const accepted = rootPropertyNames(input);
    return accepted.length > 0
      ? `${label} ${keys.join(', ')}. This tool accepts: ${accepted.join(', ')}.`
      : `${label} ${keys.join(', ')}.`;
  }
  const where = dottedPath(path);
  const named = keys.map((key) => `${where}.${key}`).join(', ');
  const accepted = Object.keys(objectSchemaAt(input, path, args)?.shape ?? {});
  return accepted.length > 0
    ? `${label} ${named}. ${where} accepts: ${accepted.join(', ')}.`
    : `${label} ${named}.`;
}

/**
 * The wrong-type sentence for one `invalid_type` issue.
 *
 * `int` is the one expectation a JSON number fails by type — `.int()`,
 * `z.int()`, `z.int32()`, and `z.uint32()` all report it, while range and
 * safe-integer violations arrive as `too_big` / `too_small` — so a number
 * arriving there has a fractional part, and the sentence names that fix
 * rather than the type names `int` and `number`, which the value already
 * satisfies (#499).
 */
function wrongTypeSentence(subject: string, expected: string, arrived: unknown): string {
  if (arrived === ABSENT) return `Send ${subject} as ${withArticle(expected)}.`;
  if (expected === 'int' && typeof arrived === 'number') {
    return `Send ${subject} as an integer, not a fractional number.`;
  }
  return `Send ${subject} as ${withArticle(expected)}, not ${arrivedTypeText(arrived)}.`;
}

/**
 * Synthesizes `data.recovery.hint` from the Zod issues, the raw arguments, and
 * the root schema (#445) — so the one failure a weaker model hits most often
 * carries the same next step every handler-thrown error does, instead of
 * costing a round trip for the schema.
 *
 * One sentence per {@link renderedIssues} entry, joined into a single hint,
 * except that every missing required field collapses into one `Provide …`
 * sentence at the first of their positions. An issue no bucket claims is
 * restated as its message line — `start: Must be …`, path included, so
 * identical constraints on different fields stay distinguishable (#493).
 *
 * When every sentence is a restatement, the hint is the message's issue text
 * verbatim, which is what lets {@link buildToolErrorResult} drop the
 * `Recovery:` line (#459). When restatements share the hint with the
 * framework's own sentences, each is terminated so it cannot run into the next
 * one, and a sentence already stated is not repeated.
 *
 * `report` closes the hint with what the pre-validation step changed before
 * the parse (#468) — `Validated query as targetQuery.` for a rewritten key,
 * `Dropped undeclared key _max.` for an underscore-rule drop — since the issues
 * name only the keys that were validated. Both are framework sentences, never
 * restatements, so a hint carrying one keeps its `Recovery:` line.
 */
function buildArgumentRecoveryHint(
  def: AnyToolDefinition,
  error: ZodError,
  args: unknown,
  report: PrevalidationReport | undefined,
): string {
  const sentences: string[] = [];
  const restatements: string[] = [];
  const missing: string[] = [];
  let missingSlot = -1;

  for (const entry of renderedIssues(error.issues)) {
    const { issue } = entry;
    const path = dottedPath(entry.path);
    const arrived = readArgumentAt(args, entry.path);

    if (issue.code === 'unrecognized_keys') {
      sentences.push(unknownKeySentence(def.input, issue.keys, entry.path, args));
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
      sentences.push(
        wrongTypeSentence(path.length > 0 ? path : 'the arguments', issue.expected, arrived),
      );
      continue;
    }

    const line = renderIssueLine(entry, args);
    restatements.push(line);
    sentences.push(terminateSentence(line));
  }

  if (report && report.aliased.length > 0) {
    const rewrites = report.aliased.map(({ alias, target }) => `${alias} as ${target}`);
    sentences.push(`Validated ${joinNames(rewrites)}.`);
  }
  if (report && report.ignored.length > 0) {
    const label = report.ignored.length === 1 ? 'key' : 'keys';
    sentences.push(`Dropped undeclared ${label} ${joinNames(report.ignored)}.`);
  }

  if (restatements.length === sentences.length) return restatements.join(', ');
  if (missingSlot >= 0) sentences[missingSlot] = `Provide ${joinNames(missing)}.`;
  return [...new Set(sentences)].join(' ');
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
 * {@link repairRepresentations} undoes a stringified array or object or an
 * integer sent for a string, and the arguments are parsed once more (#234,
 * #479, #487), the repair kept only if the author's own schema now accepts it.
 * When that attempt still fails and its drop discarded a key,
 * {@link prevalidateAliasFirst} reruns the stages alias-first and the same
 * parse-then-repair runs on the result, kept only if it validates (#563).
 * {@link recordPrevalidation} then counts and logs the attempt the handler
 * receives, so a call the first attempt validates is untouched by the retry.
 * When nothing validates, the first attempt's *original* rejection is thrown,
 * built from the arguments that produced it — identical to the one the same
 * call gets under `input: { coerce: false }`. It carries the rewrites and
 * underscore-rule drops that attempt made as `data.input`, and as sentences
 * closing the hint (#468); a call with neither gains no `data.input`.
 *
 * The single argument-rejection path. {@link createToolHandler} and the
 * `runToolContract` test helper both route through it, so a test written to
 * the helper pins the code, message, and `content[]` text a deployment
 * actually produces (#416). A `ZodError` a handler throws from its own
 * validation classifies as `ValidationError` and does not come through here;
 * nor does the output-schema parse, which fails as `InternalError`
 * ({@link parseToolOutput}).
 */
export function parseToolArguments<TDefinition extends AnyToolDefinition>(
  def: TDefinition,
  input: unknown,
  options: ParseToolArgumentsOptions = {},
): z.infer<TDefinition['input']> {
  const first = prevalidateToolArguments(def, input, options.input);
  const parsed = parseAttempt(def, first.args, options.input);
  if (parsed.success) return accept(def, first, parsed, options.context);

  const retry = prevalidateAliasFirst(def, input, first, options.input);
  if (retry) {
    const retried = parseAttempt(def, retry.args, options.input);
    if (retried.success) return accept(def, retry, retried, options.context);
  }

  recordPrevalidation(def, first, options.context);
  const { report } = first;
  throw new McpError(
    JsonRpcErrorCode.InvalidParams,
    formatInputValidationMessage(def.name, parsed.error, first.args),
    {
      issues: parsed.error.issues,
      reason: INVALID_ARGUMENTS_REASON,
      ...(report && { input: report }),
      recovery: { hint: buildArgumentRecoveryHint(def, parsed.error, first.args, report) },
    },
  );
}

/** What {@link parseAttempt} decided for one ordering of the pre-parse stages. */
type ParsedAttempt =
  | { readonly coerced: readonly CoercionKind[]; readonly data: unknown; readonly success: true }
  | { readonly error: ZodError; readonly success: false };

/**
 * Parses one attempt's arguments, and on failure repairs them once and
 * re-parses, keeping the repair only if the schema then accepts it. A failure
 * carries the first parse's error: a discarded repair leaves no trace.
 */
function parseAttempt(
  def: AnyToolDefinition,
  args: unknown,
  options: InputHandlingOptions | undefined,
): ParsedAttempt {
  const parsed = def.input.safeParse(args);
  if (parsed.success) return { success: true, data: parsed.data, coerced: [] };

  if (options?.coerce !== false) {
    const repair = repairRepresentations(args, parsed.error.issues);
    if (repair.args !== args) {
      const retried = def.input.safeParse(repair.args);
      if (retried.success) return { success: true, data: retried.data, coerced: repair.kinds };
    }
  }
  return { success: false, error: parsed.error };
}

/** Emits the winning attempt's telemetry and hands its arguments to the handler. */
function accept<TDefinition extends AnyToolDefinition>(
  def: TDefinition,
  attempt: PrevalidatedArguments,
  parsed: Extract<ParsedAttempt, { success: true }>,
  context: RequestContext | undefined,
): z.infer<TDefinition['input']> {
  recordPrevalidation(def, attempt, context);
  if (parsed.coerced.length > 0) countCoerced(def.name, parsed.coerced, context);
  return parsed.data as z.infer<TDefinition['input']>;
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
 * Parses a handler's returned value against the tool's `output` schema. A value
 * that breaks it fails as `InternalError` naming the tool and the output
 * contract — a server fault, never the caller's `ValidationError` (#480).
 * {@link createToolHandler} and the `runToolContract` test helper both route
 * through it.
 */
export function parseToolOutput(def: AnyToolDefinition, value: unknown): Record<string, unknown> {
  return parseOutputContract(def.output, value, {
    kind: 'Tool',
    name: def.name,
    contract: 'output',
  }) as Record<string, unknown>;
}

/**
 * `text`, trimmed and ending in terminal punctuation, so whatever is joined
 * after it starts a new sentence. Punctuating at the join leaves authored text
 * alone, terminator or not: a contract entry's `when` (#389), which nothing
 * validates a punctuation convention on, and an issue message restated in an
 * argument hint beside the framework's own sentences (#493).
 */
function terminateSentence(text: string): string {
  const trimmed = text.trim();
  return /[.?!]$/.test(trimmed) ? trimmed : `${trimmed}.`;
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
              .map((entry) => `\`${entry.reason}\`: ${terminateSentence(entry.when)}`)
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
 * surfacing the authoring bug as a loud `InternalError` naming the enrichment
 * contract rather than dropping it silently (#480).
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
  const structuredContent = parseOutputContract(
    effectiveOutputSchema(def),
    { ...domainValidated, ...values },
    { kind: 'Tool', name: def.name, contract: 'enrichment' },
  ) as Record<string, unknown>;
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
 * - Catches errors and returns `isError: true`, counting one raised before the
 *   measured region (the scope check, argument validation) on `mcp.tool.rejections`
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
    // Set once the call reaches the measured region; a failure before it is a
    // rejection the call and error counters never see (#546).
    let measured = false;

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
      measured = true;
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
            const validatedResult = parseToolOutput(def, handlerResult);
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
      if (!measured) recordToolRejection(def.name, error);
      const result = classifyAndBuildToolErrorResult(error);
      if (config.logToolFailurePayloads) {
        logFailurePayload(services.logger, def.name, appContext, input, result, severity);
      }
      return result;
    }
  };
}

/**
 * Writes the opt-in failed-call payload record (#291): the arguments as the
 * caller sent them — before pre-validation drops or renames a key — and the
 * `CallToolResult` the client receives, each redacted, serialized, and capped
 * on its own by `sanitization.serializeForLogging`.
 *
 * Logged at the level of the call's own error record and with the same request
 * context, so the two filter and correlate together. A cancellation writes
 * nothing: its error record is a routine `info` line, and the caller that would
 * have read the result is gone.
 */
function logFailurePayload(
  log: HandlerServices['logger'],
  toolName: string,
  context: RequestContext,
  input: unknown,
  result: CallToolResult,
  severity: ErrorContractSeverity | undefined,
): void {
  const { code } = (result.structuredContent as { error: { code: JsonRpcErrorCode } }).error;
  if (code === JsonRpcErrorCode.RequestCancelled) return;

  const maxBytes = config.logToolFailurePayloadMaxBytes;
  const toolInput = sanitization.serializeForLogging(input, maxBytes);
  const toolResult = sanitization.serializeForLogging(result, maxBytes);
  log[severity ?? 'error'](
    `Tool failure payload: ${toolName}`,
    withExtra(context, {
      toolInput: toolInput.text,
      toolInputTruncated: toolInput.truncated,
      toolResult: toolResult.text,
      toolResultTruncated: toolResult.truncated,
    }),
  );
}

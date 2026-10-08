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

import { type ZodError, type ZodObject, type ZodRawShape, type ZodType, z } from 'zod';

import { config } from '@/config/index.js';
import type { Context, EnrichmentStore } from '@/core/context.js';
import { readContentStore, readEnrichmentStore, resolveDeclaredFailure } from '@/core/context.js';
import {
  buildHandlerContext,
  type HandlerServices,
  handlerParentContext,
  resolveHandlerRequest,
} from '@/mcp-server/handlerContext.js';
import {
  CLIENT_CAPABILITY_MISSING_REASON,
  type ClientCapabilityView,
  isInputRequiredSignal,
  sealSignal,
} from '@/mcp-server/inputRequired.js';
import type { NotifierSources } from '@/mcp-server/notifications.js';
import { parseOutputContract } from '@/mcp-server/outputContract.js';
import { isScopeRefusal, withRequiredScopes } from '@/mcp-server/transports/auth/lib/authUtils.js';
import {
  type ErrorContract,
  type ErrorContractSeverity,
  internalError,
  JsonRpcErrorCode,
  McpError,
} from '@/types-global/errors.js';
import { resolvePartialResultKeys } from '@/utils/formatting/partialResult.js';
import { asRequestCancelled, ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import {
  isInstance,
  readErrorData,
  readWireErrorData,
} from '@/utils/internal/error-handler/helpers.js';
import {
  capForObservability,
  OBSERVABILITY_MAX_STRING_LENGTH,
} from '@/utils/internal/observabilityCap.js';
import { measureToolExecution, recordToolRejection } from '@/utils/internal/performance.js';
import {
  type RequestContext,
  requestContextService,
  withExtra,
} from '@/utils/internal/requestContext.js';
import { sanitization } from '@/utils/security/sanitization.js';
import { ATTR_MCP_TOOL_ENRICHED } from '@/utils/telemetry/attributes.js';
import {
  type AliasCollision,
  applyRepairs,
  type CoercionKind,
  countCoerced,
  heldRepairs,
  type InputHandlingOptions,
  type LocatedIssue,
  type PrevalidatedArguments,
  prevalidateAliasFirst,
  prevalidateToolArguments,
  recordPrevalidation,
  repairAsSent,
  repairRepresentations,
  sameValue,
} from './inputPrevalidation.js';
import {
  type ArgumentAt,
  argumentAt,
  isZodObjectSchema,
  objectSchemaAt,
  type TransformCache,
} from './schemaShape.js';
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
 * succeed (#458) — then `request <id>`, the `data.requestId` the server's log
 * records carry (#576). All three reach `structuredContent.error.data`;
 * without this line none reaches the text surface, so a model that just failed
 * cannot tell a deterministic rejection from a transient one, and a failure
 * reported from a `content[]`-only client cannot be matched to its log record.
 *
 * Returns `undefined` when `data` carries none of them — an `McpError` with no
 * `data` outside a request, as `runToolContract` builds it — leaving the text
 * as it was. The numeric `code` and `data.issues` stay JSON-only on purpose:
 * the code is the one envelope field a model cannot act on, and the message
 * already renders the issues as sentences.
 */
function renderBranchableTerms(data: Record<string, unknown> | undefined): string | undefined {
  const terms: string[] = [];
  if (typeof data?.reason === 'string' && data.reason.length > 0) {
    terms.push(`reason ${data.reason}`);
  }
  if (typeof data?.retryable === 'boolean') {
    terms.push(data.retryable ? 'retryable' : 'not retryable');
  }
  if (typeof data?.requestId === 'string' && data.requestId.length > 0) {
    terms.push(`request ${data.requestId}`);
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
 * something, and the `reason` / `retryable` / `request` terms
 * {@link renderBranchableTerms} renders, in that order; the numeric `code` and
 * `data.issues` stay JSON-only.
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

/**
 * The arguments a rejection describes, with the input schema and the transform
 * cache its issue paths are read through (#599).
 */
interface RejectedArguments {
  readonly args: unknown;
  readonly input: AnyToolDefinition['input'];
  readonly transforms: TransformCache;
}

/**
 * What a rejected call's arguments hold at `path`, as the schema there
 * received them.
 *
 * The one resolver behind #378's missing-vs-wrong rendering, #445's
 * missing-required hint, and the wrong-type sentence, which ask the same
 * question of the same arguments. Zod's `invalid_value` issue names an expected
 * set and nothing else, so an omitted field and a wrong choice are otherwise
 * indistinguishable. Resolving it here keeps the caller's value in-process:
 * only the absent/present bit and the arriving *type* reach a rendered
 * sentence, unlike Zod's `reportInput` option, which would copy every rejected
 * value onto `data.issues`.
 *
 * Below a `z.preprocess()` or a `.transform().pipe()`, an issue path names the
 * transform's output — `items.0` for a lone object the transform wrapped — so
 * the path is walked through the schema, with the transform re-applied
 * in-process ({@link argumentAt}), rather than read off the arguments as sent.
 */
function argumentOf(rejected: RejectedArguments, path: readonly PropertyKey[]): ArgumentAt {
  return argumentAt(rejected.input, path, rejected.args, rejected.transforms);
}

/**
 * Whether the schema at a path received no value because the caller sent
 * none: it left the value out, or sent `null` or a blank string that a
 * transform there made `undefined` of (a blank a preprocess maps to unset). A
 * transform that makes `undefined` of anything else — a name its lookup does
 * not know — rejected a value the caller did send, so it is not absent. A key
 * present with an explicit `null` and no transform is present — the caller
 * supplied a value, it was the wrong one. A key present with `undefined` is
 * absent, which is how Zod itself reads it. A path a re-applied transform threw
 * on is never absent: what it holds is unknown.
 */
function isAbsent(at: ArgumentAt): boolean {
  if (!at.known || at.received !== undefined) return false;
  const { sent } = at;
  return sent === undefined || sent === null || (typeof sent === 'string' && sent.trim() === '');
}

/** `"a"`, or `one of "a"|"b"` — the values an `invalid_value` sentence names. */
function acceptedValuesText(values: readonly unknown[]): string {
  const rendered = values.map((value) => JSON.stringify(value)).join('|');
  return values.length === 1 ? rendered : `one of ${rendered}`;
}

/** The branch's only issue, when it has exactly one. */
function onlyIssue(branch: readonly ArgumentIssue[]): ArgumentIssue | undefined {
  return branch.length === 1 ? branch[0] : undefined;
}

/**
 * The branch's only issue when it is a single-valued `invalid_value`: the
 * branch failed on one literal (#417).
 */
function oneLiteral(
  branch: readonly ArgumentIssue[],
): Extract<ArgumentIssue, { code: 'invalid_value' }> | undefined {
  const only = onlyIssue(branch);
  return only?.code === 'invalid_value' && only.values.length === 1 ? only : undefined;
}

/**
 * The one issue a union renders as when every branch failed on a single
 * literal at the same path — the tag of literal-tagged object branches, or a
 * union of bare literals: that literal's `invalid_value` at that path, naming
 * every branch's value as Zod names an enum's (`Invalid option: expected one
 * of "a"|"b"`), the way a `z.discriminatedUnion()` names every discriminator.
 * Its `path` is the shared branch-relative one. `undefined` for any other
 * union, one whose literals sit at different paths included.
 */
function literalTagIssue(issue: ArgumentIssue): ArgumentIssue | undefined {
  // A discriminated union's unmatched tag carries no branches; its own message names the values.
  if (issue.code !== 'invalid_union' || issue.errors.length === 0) return;
  const literals = issue.errors.map(oneLiteral);
  const path = literals[0]?.path ?? [];
  const at = JSON.stringify(path);
  const values: Extract<ArgumentIssue, { code: 'invalid_value' }>['values'] = [];
  for (const literal of literals) {
    if (!literal || JSON.stringify(literal.path) !== at) return;
    if (!values.includes(literal.values[0])) values.push(literal.values[0]);
  }
  const kind = values.length === 1 ? 'Invalid input' : 'Invalid option';
  return {
    code: 'invalid_value',
    message: `${kind}: expected ${acceptedValuesText(values)}`,
    path,
    values,
  };
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
 *   is filtered too. When that leaves nothing — every branch failed on one
 *   literal, as literal-tagged branches all do on an unknown tag — the union
 *   renders every value instead ({@link literalTagIssue}). The filter's
 *   premise is a value the caller sent, the other branch's tag: so when it
 *   leaves no branch failing below its root, a branch whose one literal sits
 *   below its root at a path `leftOut` says the caller sent nothing at is kept
 *   — `{ q: 5 }` with `format` omitted, beside a list branch that only says
 *   the value is not a list.
 * - **#492** — once some branch fails below its root, drop every branch whose
 *   only issue is a root `invalid_type`. In a one-or-many field
 *   (`z.union([z.array(Item), Item])`) that branch merely says the value is
 *   the other shape; the branch that failed inside the value is the one that
 *   says what to change. When every branch fails at its root, none is dropped.
 */
function selectUnionBranches(
  branches: ReadonlyArray<readonly ArgumentIssue[]>,
  leftOut?: (path: readonly PropertyKey[]) => boolean,
): ReadonlyArray<readonly ArgumentIssue[]> {
  let selected = branches.filter((branch) => !oneLiteral(branch));
  if (leftOut && !selected.some(failsBelowRoot)) {
    selected = branches.filter((branch) => {
      const literal = oneLiteral(branch);
      return !literal || (literal.path.length > 0 && leftOut(literal.path));
    });
  }
  if (!selected.some(failsBelowRoot)) return selected;
  return selected.filter((branch) => {
    const only = onlyIssue(branch);
    return !(only?.code === 'invalid_type' && only.path.length === 0);
  });
}

/**
 * The issues a rejection renders, in order, each at the full path it renders
 * under: Zod's list, except that a union left with one selected branch that
 * fails below its root is replaced by that branch's issues under the union's
 * path (#492) — so a one-or-many field reports a list element's field error
 * exactly as a list-only field does (`items.1.name: …`). Recursive, so a
 * one-or-many union nested in another, or inside a list element, resolves the
 * same way at every level.
 *
 * The message ({@link formatInputValidationMessage}) and the hint
 * ({@link buildArgumentRecoveryHint}) both render from this list, through
 * {@link issueLines}, which keeps the hint's restatements identical to the
 * message's lines, and the repair reads it too (#570), so a value is repaired
 * exactly where the hint would name it — the tag {@link issueLines} names for a
 * union every branch of which failed on it included, which the repair reads
 * below that union's entry (#714). A lifted entry
 * carries the one-literal issues dropped branches raised at its own path as
 * `rivals`, which only the repair reads. `data.issues` is never rebuilt from
 * it: it carries Zod's own list, bounded (#648).
 *
 * `leftOut`, given only by {@link issueLines}, reads the caller's arguments
 * at a full path, for the branch {@link selectUnionBranches} keeps on a
 * literal left out. The repair goes without it, so which branch it lifts —
 * and so which calls validate — never rests on it; such a branch holds
 * nothing to repair.
 */
function renderedIssues(
  issues: readonly ArgumentIssue[],
  prefix: readonly PropertyKey[] = [],
  leftOut?: (path: readonly PropertyKey[]) => boolean,
): LocatedIssue[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'invalid_union') {
      const [branch, ...others] = selectUnionBranches(
        issue.errors,
        leftOut && ((at) => leftOut([...path, ...at])),
      );
      if (branch && others.length === 0 && failsBelowRoot(branch)) {
        return withRivals(renderedIssues(branch, path, leftOut), issue.errors, path);
      }
    }
    return [{ issue, path }];
  });
}

/**
 * `entries`, each given the one-literal issue any other branch of the union at
 * `path` raised at the entry's own path — a branch {@link selectUnionBranches}
 * dropped under #417 (`v: 5` beside the lifted branch's `v: string`). That
 * branch still takes the literal's type there, so the repair reads the value
 * as the plain union field `z.union([z.literal(5), z.string()])` would.
 *
 * Every entry sits below `path`, so each is matched on its path below it, and
 * only when that is as long as some literal's: a union lifted at every level
 * of a recursive schema then reads each entry's path once in all rather than
 * once per level (#648).
 */
function withRivals(
  entries: LocatedIssue[],
  branches: ReadonlyArray<readonly ArgumentIssue[]>,
  path: readonly PropertyKey[],
): LocatedIssue[] {
  const rivals = new Map<string, ArgumentIssue[]>();
  const depths = new Set<number>();
  for (const branch of branches) {
    const literal = oneLiteral(branch);
    if (!literal || literal.path.length === 0) continue;
    const at = JSON.stringify(literal.path);
    rivals.set(at, [...(rivals.get(at) ?? []), literal]);
    depths.add(literal.path.length);
  }
  if (rivals.size === 0) return entries;
  return entries.map((entry) => {
    if (!depths.has(entry.path.length - path.length)) return entry;
    const found = rivals.get(JSON.stringify(entry.path.slice(path.length)));
    return found ? { ...entry, rivals: [...(entry.rivals ?? []), ...found] } : entry;
  });
}

/**
 * The lines the message and the hint render: {@link renderedIssues}, except
 * that a union every branch of which failed on one literal at one path renders
 * as that literal's issue at its full path, naming every branch's value
 * ({@link literalTagIssue}) — `target.kind: Invalid option: expected one of
 * "a"|"b"`, or `Provide target.kind.` when the tag was left out. The repair
 * reads {@link renderedIssues} itself, where such a union stays one value, and
 * reads its tag there as a field holding every branch's literal (#714), as it
 * reads an unknown discriminator: `1` sent for tags `"1"` and `"2"` becomes
 * `"1"`. `rejected` tells a literal the caller left out from one it sent wrong.
 */
function issueLines(issues: readonly ArgumentIssue[], rejected: RejectedArguments): LocatedIssue[] {
  const leftOut = (path: readonly PropertyKey[]) => isAbsent(argumentOf(rejected, path));
  return renderedIssues(issues, [], leftOut).map((entry) => {
    const tag = literalTagIssue(entry.issue);
    return tag ? { issue: tag, path: [...entry.path, ...tag.path] } : entry;
  });
}

/** `items.1.name` — the dotted form a path takes in the message and the hint. */
function dottedPath(path: readonly PropertyKey[]): string {
  return path.map(String).join('.');
}

/**
 * The most entries an argument rejection keeps, in its result (#648) and its
 * log record (#631) alike: issue lines of the message and the hint, entries of
 * every array its `data` carries, and own keys of every object. The caller
 * sets every count and length a rejection reports — how many issues, how many
 * keys, how long a key — and an author's refinement can copy the caller's
 * value into a custom issue, so neither surface grows with them.
 */
const REJECTION_ENTRIES = 10;

/**
 * A message line or hint sentence as a rejection carries it (#648): its first
 * {@link OBSERVABILITY_MAX_STRING_LENGTH} characters, ending `…` when that cut
 * removed something. One line grows with the caller's keys and paths, a
 * union's branches, and an author's enum list, so a line count alone does not
 * bound the text.
 */
function cutLine(text: string): string {
  if (text.length <= OBSERVABILITY_MAX_STRING_LENGTH) return text;
  return `${capForObservability(text).value}…`;
}

/**
 * How much of an issue's rendering a rejection reads (#648): one character
 * past the longest line {@link cutLine} returns, so a line it cuts reads the
 * same as the whole rendering, and a line short enough to keep is whole.
 */
const RENDERED_LENGTH = OBSERVABILITY_MAX_STRING_LENGTH + 2;

/** `text` as far as a rejection reads it: its first {@link RENDERED_LENGTH} characters. */
function readable(text: string): string {
  return text.length > RENDERED_LENGTH ? text.slice(0, RENDERED_LENGTH) : text;
}

/** `(+N more)` for the issue lines past the first {@link REJECTION_ENTRIES}, or `undefined`. */
function moreLines(lines: readonly LocatedIssue[]): string | undefined {
  const left = lines.length - REJECTION_ENTRIES;
  return left > 0 ? `(+${left} more)` : undefined;
}

/**
 * The most issues `data.issues` keeps in all (#648), counted in document order
 * through every union's branches. A union's issue lists each branch's issues,
 * and Zod hands every branch that parsed the same value the same issues — a
 * recursive union's `and` and `or` branches both list the clause they share —
 * so the tree a caller's nesting raises doubles per level while its distinct
 * issues grow only with the nesting. A per-array cap alone leaves that tree
 * whole: no array in it is long.
 */
const REJECTION_ISSUES = 30;

/**
 * The most levels of arrays and objects a projection keeps below an object an
 * array holds — an issue, in `data.issues` — or below its root. An issue's own
 * structure reaches two: a union's `errors` and the branch lists in it. Caller
 * data an author's refinement copies into a custom issue keeps the same two,
 * so its nesting no more grows a rejection than its width does; a list or an
 * object one level deeper keeps none of its entries.
 */
const REJECTION_LEVELS = 2;

/** How many entries a list or an object `level` levels below an issue keeps: none past {@link REJECTION_LEVELS}. */
function entriesAt(level: number): number {
  return level > REJECTION_LEVELS ? 0 : REJECTION_ENTRIES;
}

/** What is left of the objects a projection may still keep ({@link boundedProjection}). */
interface Budget {
  left: number;
}

/**
 * Whether `budget` lets an array keep `entry`, which then takes its share: an
 * object takes one, an array takes none but is kept only while one is left,
 * and any other value is always kept.
 */
function admits(budget: Budget, entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return true;
  if (budget.left === 0) return false;
  if (!Array.isArray(entry)) budget.left--;
  return true;
}

/**
 * How many levels below an issue an array's entry sits, `level` being the
 * array's: an object it holds is counted like an issue, from zero again, and
 * takes its share of the budget for it ({@link admits}).
 */
function entryLevel(entry: unknown, level: number): number {
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? 0 : level + 1;
}

/**
 * The containers {@link cutToCaps} built. A projection writes each cut's
 * record beside the field it cut, and a second projection would read those
 * records as fields of the caller's and cut them again — past 10 keys, or a
 * `<key>KeyLength` past 1,024 characters — so a container the projection built
 * passes through a later one unchanged: the argument rejection's log record
 * projects a `data` whose `data.issues` and `data.input` it already built
 * (#631).
 */
const projections = new WeakSet<object>();

/**
 * Whether {@link cutToCaps} leaves `value` as it is: nothing in it past the
 * caps — no string or key past 1,024 characters, no array past 10 entries, no
 * object past 10 own keys, no list or object holding anything past
 * {@link REJECTION_LEVELS} levels below an issue — and its arrays holding no
 * more objects in all than `budget` admits. Walked without copying, since
 * nearly every rejection is within them, and stopped at the first value past
 * them, so a finite budget bounds the walk however many times Zod lists one
 * issue. `level` is `value`'s, below the nearest object an array holds.
 */
function withinCaps(value: unknown, budget: Budget, level = 0): boolean {
  if (typeof value === 'string') return value.length <= OBSERVABILITY_MAX_STRING_LENGTH;
  if (value === null || typeof value !== 'object' || projections.has(value)) return true;
  if (Array.isArray(value)) {
    if (value.length > entriesAt(level)) return false;
    for (const entry of value) {
      if (!admits(budget, entry) || !withinCaps(entry, budget, entryLevel(entry, level))) {
        return false;
      }
    }
    return true;
  }
  const keys = Object.keys(value);
  if (keys.length > entriesAt(level)) return false;
  for (const key of keys) {
    if (key.length > OBSERVABILITY_MAX_STRING_LENGTH) return false;
    if (!withinCaps((value as Record<string, unknown>)[key], budget, level + 1)) return false;
  }
  return true;
}

/**
 * `value` bounded as an argument rejection carries it, on the wire (#648) and
 * in its log record (#631): `value` itself when nothing in it is past the
 * caps, so a rejection within them is carried uncut, and otherwise its
 * {@link cutToCaps} projection. `objects` is the most objects its arrays keep
 * in all — {@link REJECTION_ISSUES} for `data.issues`, where every such object
 * is an issue. `value` is an object the framework builds, whose own few keys
 * are never cut, so the records of its own cut have no field to sit beside.
 */
function boundedProjection(value: unknown, objects = Number.POSITIVE_INFINITY): unknown {
  return withinCaps(value, { left: objects })
    ? value
    : cutToCaps(value, { left: objects }, 0).value;
}

/**
 * What a cut removed from a value itself, as the suffix and the value of the
 * record its field takes beside it: `Length`, a string's uncut length;
 * `Count`, an array's uncut entry count or an object's uncut key count; and
 * `Lengths`, the uncut {@link sizeOf size} of every entry an array kept, when
 * it cut one of them.
 */
type CutRecord = readonly [suffix: 'Count' | 'Length' | 'Lengths', value: unknown];

/** A value as {@link cutToCaps} keeps it, and the records its field takes. */
interface Cut {
  readonly records: readonly CutRecord[];
  readonly value: unknown;
}

/** The records of a value nothing was cut from. */
const UNCUT: readonly CutRecord[] = [];

/**
 * `value` with a string cut to its first {@link OBSERVABILITY_MAX_STRING_LENGTH}
 * characters, an array to its first {@link REJECTION_ENTRIES} entries and
 * before the first entry `budget` no longer {@link admits}, an object to its
 * first 10 own keys ({@link cutObject}), and a list or an object
 * {@link REJECTION_LEVELS} levels below an issue to none of its entries, read
 * in document order, and every nested value the same. A value the projection
 * built passes through unchanged ({@link projections}).
 */
function cutToCaps(value: unknown, budget: Budget, level: number): Cut {
  if (typeof value === 'string') {
    const { value: kept, length } = capForObservability(value);
    return { value: kept, records: length === undefined ? UNCUT : [['Length', length]] };
  }
  if (value === null || typeof value !== 'object' || projections.has(value)) {
    return { value, records: UNCUT };
  }
  const cut = Array.isArray(value)
    ? cutArray(value, budget, level)
    : cutObject(value as Record<string, unknown>, budget, level);
  projections.add(cut.value as object);
  return cut;
}

/**
 * An array's first {@link entriesAt} entries, ending before the first one
 * `budget` no longer {@link admits}, each cut in turn: `Count` when entries
 * were left out, and `Lengths` when a kept entry's own string, entries, or
 * keys were cut.
 */
function cutArray(value: readonly unknown[], budget: Budget, level: number): Cut {
  const kept: unknown[] = [];
  let entryCut = false;
  for (const entry of value.slice(0, entriesAt(level))) {
    if (!admits(budget, entry)) break;
    const cut = cutToCaps(entry, budget, entryLevel(entry, level));
    kept.push(cut.value);
    entryCut ||= cut.records.some(([suffix]) => suffix !== 'Lengths');
  }
  const records: CutRecord[] = [];
  if (kept.length < value.length) records.push(['Count', value.length]);
  if (entryCut) records.push(['Lengths', kept.map((_, i) => sizeOf(value[i]) ?? null)]);
  return { value: kept, records };
}

/**
 * An object's first {@link entriesAt} own keys, each key cut to its first
 * 1,024 characters with `<key>KeyLength`, the uncut length, beside a cut one,
 * and each value cut in turn with its records beside it, in the object's own
 * order. A record never shares a name with a kept key: a key a record's name
 * takes, or one that cutting makes equal to an earlier key, is left out with
 * the keys past the first 10, and `Count` records them all. A `<key>KeyLength`
 * is longer than any kept key, so no kept key can take its name. Nor can two
 * records share one: the only suffix that ends another, `KeyLength` ending
 * `Length`, follows a cut key, and the field that would share it, `<key>Key`,
 * is longer than any key kept.
 */
function cutObject(value: Record<string, unknown>, budget: Budget, level: number): Cut {
  const keys = Object.keys(value);
  const fields: Array<{ name: string; records: Array<[string, unknown]>; value: unknown }> = [];
  const names = new Set<string>();
  for (const key of keys.slice(0, entriesAt(level))) {
    const { value: name, length } = capForObservability(key);
    if (names.has(name)) continue;
    names.add(name);
    const cut = cutToCaps(value[key], budget, level + 1);
    const records = cut.records.map(([suffix, record]): [string, unknown] => [
      `${name}${suffix}`,
      record,
    ]);
    if (length !== undefined) records.unshift([`${name}KeyLength`, length]);
    fields.push({ name, records, value: cut.value });
  }

  const recorded = new Set(fields.flatMap(({ records }) => records.map(([name]) => name)));
  const bounded: Record<string, unknown> = {};
  let kept = 0;
  for (const field of fields) {
    if (recorded.has(field.name)) continue;
    kept++;
    bounded[field.name] = field.value;
    for (const [name, record] of field.records) bounded[name] = record;
  }
  return { value: bounded, records: kept < keys.length ? [['Count', keys.length]] : UNCUT };
}

/**
 * What {@link cutToCaps} can cut of `value` itself: a string's length, an
 * array's entry count, an object's key count, `undefined` for anything else.
 */
function sizeOf(value: unknown): number | undefined {
  if (typeof value === 'string' || Array.isArray(value)) return value.length;
  return value !== null && typeof value === 'object' ? Object.keys(value).length : undefined;
}

/**
 * One line of the rendered detail: `path: message`, or the bare message at the
 * root. `absent` is the bit {@link renderIssueMessage} reads ({@link isAbsent}).
 */
function renderIssueLine({ issue, path }: LocatedIssue, absent: boolean): string {
  const message = renderIssueMessage(issue, absent);
  return path.length > 0 ? `${dottedPath(path)}: ${message}` : message;
}

/**
 * {@link renderIssueMessage}'s renderings, by issue, for each `absent` bit.
 * Zod hands every union branch that parsed the same value the same issue
 * objects, so keying on the issue renders a shared one once.
 */
const renderings = {
  absent: new WeakMap<ArgumentIssue, string>(),
  present: new WeakMap<ArgumentIssue, string>(),
};

/**
 * The readable half of one issue's rendered line.
 *
 * Two rewrites, both keeping `data.issues` and the envelope shape untouched:
 *
 * - **#417** — Zod reports a union whose every branch aborted as one
 *   `invalid_union` issue whose own message is the placeholder `Invalid input`;
 *   what would have been accepted lives on the nested branch issues. Render the
 *   selected branches instead, joined by ` or `. When the selection leaves
 *   none, every branch failed on one literal: render the literal's issue
 *   naming every value where they share a path ({@link literalTagIssue}), and
 *   every branch where they do not. Only a union with no branches, a
 *   discriminated union's unmatched tag, keeps Zod's own message, which names
 *   the accepted values itself. (When exactly one branch matched the base type
 *   and failed only a check, Zod returns that branch's issues directly and
 *   this never fires.)
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
 *
 * Read only as far as a rejection reads it (#648): the first
 * {@link RENDERED_LENGTH} characters, a branch or issue past them never
 * rendered, and each issue rendered once per `absent` bit however many
 * branches list it ({@link renderings}). A union's rendering grows with every
 * branch it names, so one whose branches share a recursive clause doubles per
 * level of the caller's nesting; read this way, its cost grows with the
 * distinct issues alone.
 */
function renderIssueMessage(issue: ArgumentIssue, absent: boolean): string {
  const rendered = renderings[absent ? 'absent' : 'present'];
  let message = rendered.get(issue);
  if (message === undefined) {
    message = readable(composeIssueMessage(issue, absent));
    rendered.set(issue, message);
  }
  return message;
}

/**
 * The rendering {@link renderIssueMessage} reads from, stopped once it is
 * {@link RENDERED_LENGTH} characters long: the selected branches, each
 * rendered once and joined on ` or `, a branch already rendered skipped.
 */
function composeIssueMessage(issue: ArgumentIssue, absent: boolean): string {
  if (issue.code === 'invalid_union') {
    const tag = literalTagIssue(issue);
    if (tag) return renderBranchIssue(tag, absent);
    const selected = selectUnionBranches(issue.errors);
    const branches = selected.length > 0 ? selected : issue.errors;
    if (branches.length === 0) return issue.message;
    const rendered = new Set<string>();
    let length = 0;
    for (const branch of branches) {
      const text = joinReadable(branch, '; ', (branchIssue) =>
        renderBranchIssue(branchIssue, absent),
      );
      if (rendered.has(text)) continue;
      length += (rendered.size > 0 ? ' or '.length : 0) + text.length;
      rendered.add(text);
      if (length >= RENDERED_LENGTH) break;
    }
    return [...rendered].join(' or ');
  }
  if (absent && issue.code === 'invalid_value') {
    return `Missing required field. Expected ${acceptedValuesText(issue.values)}`;
  }
  return issue.message;
}

/**
 * `items` rendered and joined on `separator` as far as a rejection reads them
 * ({@link readable}): an item past that point is never rendered.
 */
function joinReadable<T>(
  items: readonly T[],
  separator: string,
  render: (item: T) => string,
): string {
  let text = '';
  for (const [index, item] of items.entries()) {
    text += `${index > 0 ? separator : ''}${render(item)}`;
    if (text.length >= RENDERED_LENGTH) return readable(text);
  }
  return text;
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
 * `lines` are the rejection's {@link issueLines}, and `rejected.args` the
 * arguments its parse ran on — the caller's, with any repairs that held
 * (#706) — read only through {@link argumentOf}; see
 * {@link renderIssueMessage} for what that decides.
 *
 * Bounded whatever the caller sends (#648): the first 10 issue lines, each
 * {@link cutLine cut} to its first 1,024 characters, then ` (+N more)` for the
 * lines left out — the suffix `formatZodErrorMessage` closes other `ZodError`
 * messages with. A rejection with 10 lines or fewer, none past 1,024
 * characters, is not cut.
 */
function formatInputValidationMessage(
  toolName: string,
  lines: readonly LocatedIssue[],
  rejected: RejectedArguments,
): string {
  const detail = lines
    .slice(0, REJECTION_ENTRIES)
    .map((entry) => cutLine(renderIssueLine(entry, isAbsent(argumentOf(rejected, entry.path)))))
    .join(', ');
  const more = moreLines(lines);
  return `Input validation error: Invalid arguments for tool ${toolName}: ${more === undefined ? detail : `${detail} ${more}`}`;
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
 * The unknown-key sentence for one `unrecognized_keys` issue.
 *
 * A root key names the root properties the tool advertises (#445). A key inside
 * a nested strict object is named by its full path, beside the keys that object
 * accepts (#566) — the root list there would send the caller to move the key to
 * the root or rename it after a root field. Neither list is given when there is
 * none to give: a discriminated-union root, a nested object declaring no keys,
 * or a path {@link objectSchemaAt} cannot resolve. A nested path is resolved
 * through a transforming pipe's output (#599), so an item a `z.preprocess()`
 * wrapped in a list names its own keys.
 */
function unknownKeySentence(
  rejected: RejectedArguments,
  keys: readonly string[],
  path: readonly PropertyKey[],
): string {
  const label = keys.length === 1 ? 'Unknown key' : 'Unknown keys';
  if (path.length === 0) {
    const accepted = rootPropertyNames(rejected.input);
    return accepted.length > 0
      ? `${label} ${keys.join(', ')}. This tool accepts: ${accepted.join(', ')}.`
      : `${label} ${keys.join(', ')}.`;
  }
  const where = dottedPath(path);
  const named = keys.map((key) => `${where}.${key}`).join(', ');
  const { args, input, transforms } = rejected;
  const accepted = Object.keys(objectSchemaAt(input, path, args, transforms)?.shape ?? {});
  return accepted.length > 0
    ? `${label} ${named}. ${where} accepts: ${accepted.join(', ')}.`
    : `${label} ${named}.`;
}

/**
 * The sentence for a declared key the caller sent with an alias of it (#639):
 * the aliases, in argument order, and the choice left to make — between two
 * keys, or among three or more.
 */
function collisionSentence({ keys, target }: AliasCollision): string {
  const aliases = keys.filter((key) => key !== target);
  const subject =
    aliases.length === 1 ? `${aliases[0]} is an alias of` : `${joinNames(aliases)} are aliases of`;
  const choice = keys.length > 2 ? 'send only one of them.' : 'send one of them, not both.';
  return `${subject} ${target}; ${choice}`;
}

/**
 * The wrong-type sentence for one `invalid_type` issue, from the value the
 * schema there received.
 *
 * `int` is the one expectation a JSON number fails by type — `.int()`,
 * `z.int()`, `z.int32()`, and `z.uint32()` all report it, while range and
 * safe-integer violations arrive as `too_big` / `too_small` — so a number
 * arriving there has a fractional part, and the sentence names that fix
 * rather than the type names `int` and `number`, which the value already
 * satisfies (#499).
 */
function wrongTypeSentence(subject: string, expected: string, at: ArgumentAt): string {
  if (isAbsent(at)) return `Send ${subject} as ${withArticle(expected)}.`;
  const arrived = at.received;
  if (expected === 'int' && typeof arrived === 'number') {
    return `Send ${subject} as an integer, not a fractional number.`;
  }
  return `Send ${subject} as ${withArticle(expected)}, not ${arrivedTypeText(arrived)}.`;
}

/**
 * Synthesizes `data.recovery.hint` from the Zod issues, the arguments their
 * parse ran on, and the root schema (#445) — so the one failure a weaker
 * model hits most often carries the same next step every handler-thrown error
 * does, instead of costing a round trip for the schema.
 *
 * One sentence per {@link issueLines} entry, joined into a single hint,
 * except that every missing required field collapses into one `Provide …`
 * sentence at the first of their positions. An issue no bucket claims is
 * restated as its message line — `start: Must be …`, path included, so
 * identical constraints on different fields stay distinguishable (#493).
 *
 * The wrong-type sentence names the type the schema received, which says
 * what to send only where that is the caller's own value. A path that ends on
 * a transform (#599) — a `z.preprocess()` that falls through on a string it
 * cannot parse, in front of `z.number()` — is restated instead: the raw type
 * says nothing about which forms the transform accepts. So is a path whose
 * transform threw when re-applied, since what it received is unknown, and one
 * a transform made `undefined` of a value the caller sent: a lookup that does
 * not know the name is asked for nothing it can `Provide` ({@link isAbsent}).
 *
 * When every sentence is a restatement, the hint is the message's issue text
 * verbatim, which is what lets {@link buildToolErrorResult} drop the
 * `Recovery:` line (#459). When restatements share the hint with the
 * framework's own sentences, each is terminated so it cannot run into the next
 * one, and a sentence already stated is not repeated.
 *
 * The attempt's `report` closes the hint with what the pre-validation step
 * changed before the parse (#468) — `Validated query as targetQuery.` for a
 * rewritten key, `Dropped undeclared key _max.` for an underscore-rule drop —
 * since the issues name only the keys that were validated. Both are framework
 * sentences, never restatements, so a hint carrying one keeps its `Recovery:`
 * line.
 *
 * Its `collisions` name an alias the caller sent beside its target as one
 * (#639) — `maxResults is an alias of pageSize; send one of them, not both.` —
 * in place of the sentence that would otherwise call it an unknown root key
 * or a dropped key, once per target, at the first place either would have
 * named it. The keys around it keep their own sentences.
 *
 * Bounded like the message (#648): sentences for the first 10 entries only,
 * each {@link cutLine cut} to its first 1,024 characters, the issue sentences
 * closed with the message's ` (+N more)` before what the pre-validation step
 * changed. An `unrecognized_keys` entry is one of the 10 however many keys and
 * alias collisions it names, and a missing field past them is counted there,
 * not named. A cut restatement is the message's cut line itself, so a hint
 * made only of restatements is still the message's issue text, suffix
 * included.
 */
function buildArgumentRecoveryHint(
  lines: readonly LocatedIssue[],
  rejected: RejectedArguments,
  { collisions, report }: Pick<PrevalidatedArguments, 'collisions' | 'report'>,
): string {
  const sentences: string[] = [];
  const restatements: string[] = [];
  const missing: string[] = [];
  let missingSlot = -1;

  const collidedBy = new Map<string, AliasCollision>();
  for (const collision of collisions?.() ?? []) {
    for (const key of collision.declined) collidedBy.set(key, collision);
  }
  const named = new Set<AliasCollision>();
  const nameCollisions = (keys: readonly string[], into: string[]): void => {
    for (const key of keys) {
      const collision = collidedBy.get(key);
      if (!collision || named.has(collision)) continue;
      named.add(collision);
      into.push(cutLine(collisionSentence(collision)));
    }
  };
  const uncollided = (keys: readonly string[]): readonly string[] =>
    collidedBy.size === 0 ? keys : keys.filter((key) => !collidedBy.has(key));

  for (const entry of lines.slice(0, REJECTION_ENTRIES)) {
    const { issue } = entry;
    const path = dottedPath(entry.path);

    if (issue.code === 'unrecognized_keys') {
      // Aliases are root keys, so only the root's unknown keys can be one.
      const root = entry.path.length === 0;
      if (root) nameCollisions(issue.keys, sentences);
      const unknown = root ? uncollided(issue.keys) : issue.keys;
      if (unknown.length > 0) {
        sentences.push(cutLine(unknownKeySentence(rejected, unknown, entry.path)));
      }
      continue;
    }

    const at = argumentOf(rejected, entry.path);
    const absent = isAbsent(at);
    if (path.length > 0 && absent) {
      if (missingSlot < 0) {
        missingSlot = sentences.length;
        sentences.push('');
      }
      missing.push(path);
      continue;
    }

    // A value a transform made undefined of what the caller sent names no type to send instead.
    const typed = absent || at.received !== undefined;
    if (issue.code === 'invalid_type' && at.known && !at.transformed && typed) {
      sentences.push(
        cutLine(wrongTypeSentence(path.length > 0 ? path : 'the arguments', issue.expected, at)),
      );
      continue;
    }

    const rendered = renderIssueLine(entry, absent);
    const line = cutLine(rendered);
    restatements.push(line);
    sentences.push(line === rendered ? terminateSentence(rendered) : line);
  }

  const changed: string[] = [];
  if (report) nameCollisions(report.ignored, changed);
  if (report && report.aliased.length > 0) {
    const rewrites = report.aliased.map(({ alias, target }) => `${alias} as ${target}`);
    changed.push(cutLine(`Validated ${joinNames(rewrites)}.`));
  }
  const dropped = report ? uncollided(report.ignored) : [];
  if (dropped.length > 0) {
    const label = dropped.length === 1 ? 'key' : 'keys';
    changed.push(cutLine(`Dropped undeclared ${label} ${joinNames(dropped)}.`));
  }

  const more = moreLines(lines);
  if (restatements.length === sentences.length && changed.length === 0) {
    const text = restatements.join(', ');
    return more === undefined ? text : `${text} ${more}`;
  }
  if (missingSlot >= 0) sentences[missingSlot] = cutLine(`Provide ${joinNames(missing)}.`);
  if (more !== undefined) sentences.push(more);
  return [...new Set([...sentences, ...changed])].join(' ');
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
 * The rejection is bounded whatever the caller sends (#648), here at the
 * throw, so every path through this function carries the bound: the message
 * and the hint render the first 10 issue lines, each cut to 1,024 characters,
 * and `data.issues` and `data.input` are {@link boundedProjection}s — the
 * first 10 entries of every array and own keys of every object, the first
 * 1,024 characters of every string and key, and {@link REJECTION_LEVELS} levels
 * of nesting below each issue, the uncut count or length beside each cut — with
 * `data.issues` keeping at most {@link REJECTION_ISSUES} issues in all through
 * every union's branches. `data.issuesCount`, how many issues Zod raised at
 * the top level, sits beside `data.issues` whenever it keeps fewer of them —
 * past the first 10, or sooner when that budget runs out — as `errorsCount`
 * sits beside a cut branch list. A rejection within those caps carries Zod's
 * list and the report exactly. Its cost grows
 * with the distinct issues Zod raised, not with how many branches list one:
 * every reader of the issues walks a shared one once or stops at a bound.
 *
 * An ordered pre-validation step wraps the parse. Before it,
 * {@link prevalidateToolArguments} drops client-added keys (#453) and rewrites
 * key aliases (#452); after a failure — and only then —
 * {@link repairRepresentations} undoes a stringified array or object, an
 * integer sent for a string, a string sent for a number or boolean, or a lone
 * string sent for an array, and deletes `null` sent for an optional field, at
 * the paths {@link renderedIssues} names — inside a union field's one surviving
 * branch (#570), at a discriminator or literal tag no variant accepts (#714),
 * and inside a `z.preprocess()` output (#599) included — and the
 * arguments are parsed once more (#234, #479, #487, #707, #602, #616), the
 * repair kept only if the author's own schema now accepts it. The repair
 * 0.13.13 made, of Zod's own issues in the arguments as sent
 * ({@link repairAsSent}), is parsed before it, so every call that repair
 * validated keeps its value. Every path the
 * repair, the message, and the hint read is walked through the input schema,
 * a transform on the way re-applied once per value for the whole call.
 * When that attempt still fails and its drop discarded a key,
 * {@link prevalidateAliasFirst} reruns the stages alias-first and the same
 * parse-then-repair runs on the result, kept only if it validates (#563).
 * {@link recordPrevalidation} then counts and logs the attempt the handler
 * receives, so a call the first attempt validates is untouched by the retry.
 * When nothing validates, the last attempt's rejection is thrown — the
 * retry's when it ran, since there every key the drop discarded reached its
 * target and the issues name what is wrong with the value it carried. It is a
 * parse of that attempt's arguments with only the repairs that held applied
 * (#706, {@link repairAttempt}), rendered from those same arguments: a value
 * the schema accepted once repaired is not reported — one that held only
 * written in place below a transform that reorders or rewrites it excepted —
 * and one whose repair the schema refused is reported as sent, so a call no
 * repair helped gets exactly
 * the rejection it gets under `input: { coerce: false }` — as does one the
 * held repairs alone would validate (only a union or a cross-field refinement
 * allows that), held values included. It carries the rewrites and
 * underscore-rule drops that attempt made as `data.input`, and as sentences
 * closing the hint (#468); a call with neither gains no `data.input`, and
 * nothing in it says a repair held. An alias that attempt
 * declined because its target was already present is named in the hint as an
 * alias of that target (#639), never as an unknown or a dropped key.
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
  const parsed = def.input.safeParse(first.args);
  if (!parsed.success) return repairOrReject(def, input, first, parsed.error, options);
  return accept(
    def,
    first,
    { success: true, data: parsed.data, coerced: NO_COERCIONS },
    options.context,
  );
}

/** No repair applied. */
const NO_COERCIONS: readonly CoercionKind[] = [];

/**
 * {@link parseToolArguments} once the first parse has failed with
 * `firstError`: the repair, the alias-first retry, and the rejection. Kept out
 * of the function a valid call runs, which then allocates nothing past the
 * parse.
 */
function repairOrReject<TDefinition extends AnyToolDefinition>(
  def: TDefinition,
  input: unknown,
  first: PrevalidatedArguments,
  firstError: ZodError,
  options: ParseToolArgumentsOptions,
): z.infer<TDefinition['input']> {
  // One cache for the whole call: the repair, the message, and the hint each
  // read paths through the same transforms, which then run once per value (#599).
  const transforms: TransformCache = new Map();
  const parsed = repairAttempt(def, first.args, firstError, options.input, transforms);
  if (parsed.success) return accept(def, first, parsed, options.context);

  let failed = { attempt: first, parsed };
  const retry = prevalidateAliasFirst(def, input, first, options.input);
  if (retry) {
    const retryParse = def.input.safeParse(retry.args);
    const retried: ParsedAttempt = retryParse.success
      ? { success: true, data: retryParse.data, coerced: NO_COERCIONS }
      : repairAttempt(def, retry.args, retryParse.error, options.input, transforms);
    if (retried.success) return accept(def, retry, retried, options.context);
    failed = { attempt: retry, parsed: retried };
  }

  const {
    attempt,
    parsed: { args, error },
  } = failed;
  recordPrevalidation(def, attempt, options.context);
  const { report } = attempt;
  const rejected: RejectedArguments = { args, input: def.input, transforms };
  const lines = issueLines(error.issues, rejected);
  throw new McpError(
    JsonRpcErrorCode.InvalidParams,
    formatInputValidationMessage(def.name, lines, rejected),
    {
      ...(boundedProjection({ issues: error.issues }, REJECTION_ISSUES) as Record<string, unknown>),
      reason: INVALID_ARGUMENTS_REASON,
      ...(report && { input: boundedProjection(report) }),
      recovery: { hint: buildArgumentRecoveryHint(lines, rejected, attempt) },
    },
  );
}

/** What {@link repairAttempt} decided for one ordering of the pre-parse stages. */
type ParsedAttempt =
  | { readonly coerced: readonly CoercionKind[]; readonly data: unknown; readonly success: true }
  | {
      /** The arguments `error` came from, which the message and the hint read. */
      readonly args: unknown;
      readonly error: ZodError;
      readonly success: false;
    };

/**
 * Repairs one attempt's arguments, whose parse failed with `error`, once and
 * re-parses, keeping the repair only if the schema then accepts it. The
 * original repair — Zod's own issues read and written at their paths in the
 * arguments as sent ({@link repairAsSent}) — is parsed first, so a call it
 * validated validates with the same value. A repair below a transform is then
 * parsed written in place (#599, {@link repairRepresentations}), and the
 * substitution last — with the original repairs no rendered issue reached,
 * then, when that fails, without them; arguments equal to the original
 * repair's are not parsed again, and a substitution every transform refused,
 * which leaves the arguments as sent, is not parsed at all. Only the first
 * substitution's parse can be the rejection, since only its repairs sit where
 * the issues name values.
 *
 * A call that still fails is rejected from the attempt's arguments with only
 * the repairs that held applied (#706) — those {@link heldRepairs} finds no
 * re-parse issue at or below. Every repair held: the re-parse is the
 * rejection. None did: the first parse is, exactly as under `coerce: false`.
 * Some did: one more parse, of the arguments with those written. It only
 * reports, never admits: when it validates — possible only where the schema
 * judges one value by another, as a union or a cross-field refinement does —
 * the first parse is the rejection, so which calls validate never rests on
 * it. Short of that fallback, no reported issue names a value the caller sent
 * and the schema accepted once repaired, and a value whose repair the schema
 * refused is reported as sent — but a value that held only written in place,
 * below a transform that reorders or rewrites it, is judged here by the
 * substitution, whose issues name positions in the transform's output, and is
 * reported as sent too. A re-parse the author's schema throws on discards the
 * repairs it carried, like a failed one.
 */
function repairAttempt(
  def: AnyToolDefinition,
  args: unknown,
  error: ZodError,
  options: InputHandlingOptions | undefined,
  transforms: TransformCache,
): ParsedAttempt {
  const asSent = { success: false, args, error } as const;
  if (options?.coerce === false) return asSent;

  const original = repairAsSent(args, error.issues);
  const originalParse = original && reparse(def, original.args);
  if (original && originalParse?.success) {
    return { success: true, data: originalParse.data, coerced: original.kinds };
  }
  // A repair that writes the same arguments as the original one fails the same way.
  const parseRepaired = (repaired: unknown) =>
    original && sameValue(repaired, original.args) ? originalParse : reparse(def, repaired);

  const repair = repairRepresentations(
    args,
    renderedIssues(error.issues),
    def.input,
    transforms,
    original?.repairs,
  );
  if (repair.inPlace) {
    const placed = parseRepaired(repair.inPlace.args);
    if (placed?.success) return { success: true, data: placed.data, coerced: repair.inPlace.kinds };
  }
  // No repair, or each one below a transform that refused it: the first parse read these arguments.
  if (repair.repairs.length === 0 || sameValue(repair.args, args)) return asSent;
  const retried = parseRepaired(repair.args);
  if (retried?.success) return { success: true, data: retried.data, coerced: repair.kinds };
  if (repair.unaided) {
    const unaided = parseRepaired(repair.unaided.args);
    if (unaided?.success) {
      return { success: true, data: unaided.data, coerced: repair.unaided.kinds };
    }
  }
  if (!retried) return asSent;

  const held = heldRepairs(repair.repairs, retried.error.issues);
  if (held.length === repair.repairs.length) {
    return { success: false, args: repair.args, error: retried.error };
  }
  if (held.length === 0) return asSent;
  const reported = applyRepairs(args, held);
  const reparsed = reparse(def, reported);
  return !reparsed || reparsed.success
    ? asSent
    : { success: false, args: reported, error: reparsed.error };
}

/**
 * Parses repaired arguments, or `undefined` when the author's schema throws on
 * them: a check written for the values a valid call carries can throw on a
 * repaired one, such as an optional field's `undefined` once its `null` is
 * deleted.
 */
function reparse(
  def: AnyToolDefinition,
  args: unknown,
): ReturnType<AnyToolDefinition['input']['safeParse']> | undefined {
  try {
    return def.input.safeParse(args);
  } catch {
    return;
  }
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
 * `ZodError` (its `issues`), so internal classification context never leaks
 * to clients.
 *
 * `requestId`, when given, is set as `data.requestId` on the envelope — after
 * the thrown data, so the framework's value replaces a thrown one, as
 * canonical fields win in log records (#550) — and closes the `content[]`
 * terms line (#576). It is the one request-context field that reaches `data`,
 * added here rather than to the thrown `McpError.data`, so the error the
 * handler threw and the log record's `errorData` stay context-free (#548).
 * `runToolContract` passes none: it has no real request, so a thrown
 * `data.requestId` is dropped rather than rendered as one.
 *
 * Never throws on the thrown value (#697): its `code`, `message`, and `data`
 * are read as {@link ErrorHandler.classifyOnly} reads them, so one that cannot
 * be read is `InternalError`, `'[Unreadable]'`, or left out, and `data` is a
 * copy of the thrown one in which every field is one the wire carries
 * ({@link readWireErrorData}).
 *
 * Use after invoking {@link ErrorHandler.handleError} for OTel/logging side
 * effects — this helper does not log.
 */
export function classifyAndBuildToolErrorResult(
  error: unknown,
  requestId?: string,
): CallToolResult {
  const withRequestId = (data: Record<string, unknown> | undefined) => {
    if (requestId !== undefined) return { ...data, requestId };
    if (data?.requestId === undefined) return data;
    const { requestId: _thrown, ...rest } = data;
    return Object.keys(rest).length > 0 ? rest : undefined;
  };
  // `classifyOnly` returns only a `ZodError`'s issues as `data`; a thrown `McpError`'s is copied here.
  const { code, message, data } = ErrorHandler.classifyOnly(error);
  return buildToolErrorResult(code, message, withRequestId(readWireErrorData(error) ?? data));
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
 * The two reasons the framework raises itself, both a refusal of the call
 * rather than a fault in this server: `invalid_arguments`, only from the schema
 * gate in {@link parseToolArguments}, and `client_capability_missing`, only
 * from `ctx.requestInput`'s capability gate.
 */
const FRAMEWORK_REFUSAL_REASONS: ReadonlySet<string> = new Set([
  INVALID_ARGUMENTS_REASON,
  CLIENT_CAPABILITY_MISSING_REASON,
]);

/**
 * The level the `Error in tool:<name>` record is emitted at, or `undefined` to
 * keep `error`.
 *
 * A severity the matched `errors[]` entry declares wins (#380). Otherwise one
 * of the framework's own refusals logs at `notice`: a reason in
 * {@link FRAMEWORK_REFUSAL_REASONS} (#567) — a caller's arguments failing the
 * tool's schema, or a client connection that cannot serve an input request —
 * and a scope check's missing-scope refusal (#585), from the inline `auth`
 * check or a handler's `checkScopes`, recognized by the mark those utilities
 * put on it rather than by its `Forbidden` code. Each is routine traffic, and a
 * schema that wrongly rejects valid calls still shows per tool on
 * `mcp.tool.rejections`. Everything else — a plain `Error`, an undeclared
 * reason, an entry with no severity, a missing auth context, a handler's own
 * `forbidden()`, an upstream 403, an output-contract failure — keeps `error`.
 * A cancellation takes `handleError`'s own `info` path whatever this returns.
 * The three framework refusals also log without a stack, whatever level this
 * resolves for them (#651).
 *
 * Resolved here rather than in `ErrorHandler`, which also serves services,
 * prompts, and transports and knows neither the definition nor the schema gate.
 * `reason` is the failure's `data.reason`, as {@link readErrorData} reads it.
 */
function failureSeverity(
  entry: ErrorContract | undefined,
  failure: unknown,
  reason: unknown,
): ErrorContractSeverity | undefined {
  if (entry?.severity !== undefined) return entry.severity;
  if (isScopeRefusal(failure)) return 'notice';
  return typeof reason === 'string' && FRAMEWORK_REFUSAL_REASONS.has(reason) ? 'notice' : undefined;
}

/**
 * The argument rejection its `Error in tool:<name>` record is written from
 * (#631). The caller sets every length in it — a key's name, how many keys,
 * how many issues — and the record is logged at `notice`, which the default
 * level admits, so it is bounded like any other caller-supplied value: the
 * message and every string in `data` keep at most their first 1,024 characters,
 * and `data` is the {@link boundedProjection} the result's is, with
 * `originalMessageLength` beside a cut message. `data.issues` and `data.input`
 * arrive as projections already (#648) and pass through unchanged, the records
 * their cuts wrote included ({@link projections}); what the record cuts further
 * is the message and `recovery.hint`, which the `-32602` result carries as up
 * to 10 lines of up to 1,025 characters each. A rejection within the caps is
 * logged uncut.
 */
function argumentRejectionForLog(rejection: McpError): McpError {
  const { value: message, length } = capForObservability(rejection.message);
  return new McpError(rejection.code, message, {
    ...(boundedProjection(rejection.data) as Record<string, unknown>),
    ...(length !== undefined && { originalMessageLength: length }),
  });
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
  capabilities?: ClientCapabilityView,
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
      parentContext: handlerParentContext(serverContext),
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
            capabilities,
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
            // derived from what leaves this callback (#421). An input-required
            // signal leaves with its `requestState` sealed when a key is
            // configured, so a sealing failure is a failed call like any other;
            // anything else leaves as itself, never awaited (#697).
            throw asRequestCancelled(
              isInputRequiredSignal(error)
                ? await sealSignal(error, services.requestState, serverContext)
                : error,
              request.signal,
            );
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
      // the `input_required` result — its `requestState` already sealed when a
      // key is configured — with no span, log, or classification. The client
      // (2026 era) or the SDK's legacy shim (2025 era) fulfils it and
      // re-invokes this handler. A request this connection cannot serve never
      // reaches here as a signal — `ctx.requestInput` throws the refusal
      // instead, and it arrives below as an `McpError`.
      if (isInputRequiredSignal(error)) return error.result;

      // One reason-to-entry lookup: the declared recovery fills a failure that
      // carries none (#579) and the entry's severity sets the log level (#380,
      // #567). Filled before `handleError`, so the error record, the envelope,
      // and the failure-payload record carry the same hint.
      const { entry, failure } = resolveDeclaredFailure(def.errors, error);
      // Read once, through a copy: the failure may be a thrown value whose
      // `data` cannot be read (#697).
      const reason = readErrorData(failure)?.reason;
      const severity = failureSeverity(entry, failure, reason);
      // The schema gate's rejection, raised before the handler ran (#631).
      const argumentRejection =
        !measured && isInstance(failure, McpError) && reason === INVALID_ARGUMENTS_REASON;
      // The capability gate's refusal, recognized by its reserved reason.
      const capabilityRefusal = reason === CLIENT_CAPABILITY_MISSING_REASON;
      // No framework refusal is a fault in this server, so a stack would name
      // only the gate that refused it and the line that called it — at
      // whatever level an `errors[]` entry declares (#585, #631, #651).
      ErrorHandler.handleError(argumentRejection ? argumentRejectionForLog(failure) : failure, {
        operation: `tool:${def.name}`,
        context: appContext,
        ...(severity !== undefined && { severity }),
        ...((argumentRejection || capabilityRefusal || isScopeRefusal(failure)) && {
          includeStack: false,
        }),
      });
      if (!measured) recordToolRejection(def.name, failure);
      const result = classifyAndBuildToolErrorResult(failure, appContext.requestId);
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

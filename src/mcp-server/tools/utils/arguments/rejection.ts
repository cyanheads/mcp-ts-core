/**
 * @fileoverview The argument rejection a call no pre-validation attempt
 * rescued receives: its message, its synthesized recovery hint, the `-32602`
 * `McpError` that carries them, and the bounded copy its log record is written
 * from.
 * @module src/mcp-server/tools/utils/arguments/rejection
 */

import type { ZodError } from 'zod';

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { joinNames, terminateSentence } from '@/utils/formatting/sentence.js';
import {
  boundedProjection,
  REJECTION_ENTRIES,
  REJECTION_ISSUES,
} from '@/utils/internal/boundedProjection.js';
import { capForObservability, cutLine } from '@/utils/internal/observabilityCap.js';
import {
  type ArgumentAt,
  isZodObjectSchema,
  objectSchemaAt,
  type TransformCache,
} from '../schemaShape.js';
import type { AnyToolDefinition } from '../toolDefinition.js';
import { moreLines, RENDERED_LENGTH, readable } from './bounds.js';
import {
  type ArgumentIssue,
  acceptedValuesText,
  argumentOf,
  dottedPath,
  isAbsent,
  issueLines,
  type LocatedIssue,
  literalTagIssue,
  type RejectedArguments,
  selectUnionBranches,
} from './issues.js';
import type { AliasCollision, PrevalidatedArguments } from './prevalidation.js';

/** The framework-owned `data.reason` on every argument rejection (#445). */
export const INVALID_ARGUMENTS_REASON = 'invalid_arguments';

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

/**
 * The `-32602` rejection {@link parseToolArguments} throws when no attempt
 * validated: built from the failed attempt — its arguments, the parse error
 * they raised, and the call's transform cache — and returned for the caller to
 * throw.
 */
export function argumentRejection(
  def: AnyToolDefinition,
  attempt: PrevalidatedArguments,
  args: unknown,
  error: ZodError,
  transforms: TransformCache,
): McpError {
  const { report } = attempt;
  const rejected: RejectedArguments = { args, input: def.input, transforms };
  const lines = issueLines(error.issues, rejected);
  return new McpError(
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
export function argumentRejectionForLog(rejection: McpError): McpError {
  const { value: message, length } = capForObservability(rejection.message);
  return new McpError(rejection.code, message, {
    ...(boundedProjection(rejection.data) as Record<string, unknown>),
    ...(length !== undefined && { originalMessageLength: length }),
  });
}

/**
 * @fileoverview The Zod issues of a rejected call, located at the full
 * argument paths a rejection renders them under, and the reads of the
 * caller's arguments at those paths that the repair, the message, and the
 * hint share.
 * @module src/mcp-server/tools/utils/arguments/issues
 */

import type { ZodError } from 'zod';

import { type ArgumentAt, argumentAt, type TransformCache } from '../schemaShape.js';
import type { AnyToolDefinition } from '../toolDefinition.js';

/** One entry of a `ZodError`'s issue list. */
export type ArgumentIssue = ZodError['issues'][number];

/**
 * A Zod issue and the full argument path it sits at. The path equals
 * `issue.path` except for an issue lifted out of a union branch, whose
 * branch-relative path follows the union's own (#492).
 */
export interface LocatedIssue {
  readonly issue: ArgumentIssue;
  readonly path: readonly PropertyKey[];
  /**
   * The one-literal issues other branches of an enclosing union raised at
   * this same path — branches the rendering dropped for failing on one
   * literal alone (#417). The repair reads the value as a plain union field
   * holding those branches would, so a dropped `z.literal(5)` branch keeps `6`
   * from becoming `"6"` (#570).
   */
  readonly rivals?: readonly ArgumentIssue[];
}

/**
 * The arguments a rejection describes, with the input schema and the transform
 * cache its issue paths are read through (#599).
 */
export interface RejectedArguments {
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
export function argumentOf(rejected: RejectedArguments, path: readonly PropertyKey[]): ArgumentAt {
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
export function isAbsent(at: ArgumentAt): boolean {
  if (!at.known || at.received !== undefined) return false;
  const { sent } = at;
  return sent === undefined || sent === null || (typeof sent === 'string' && sent.trim() === '');
}

/** `"a"`, or `one of "a"|"b"` — the values an `invalid_value` sentence names. */
export function acceptedValuesText(values: readonly unknown[]): string {
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
export function literalTagIssue(issue: ArgumentIssue): ArgumentIssue | undefined {
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
export function selectUnionBranches(
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
export function renderedIssues(
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
export function issueLines(
  issues: readonly ArgumentIssue[],
  rejected: RejectedArguments,
): LocatedIssue[] {
  const leftOut = (path: readonly PropertyKey[]) => isAbsent(argumentOf(rejected, path));
  return renderedIssues(issues, [], leftOut).map((entry) => {
    const tag = literalTagIssue(entry.issue);
    return tag ? { issue: tag, path: [...entry.path, ...tag.path] } : entry;
  });
}

/** `items.1.name` — the dotted form a path takes in the message and the hint. */
export function dottedPath(path: readonly PropertyKey[]): string {
  return path.map(String).join('.');
}

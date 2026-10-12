/**
 * @fileoverview Representation repair, the one stage of tool argument handling
 * that runs after a failed parse: each value the rejection names is read for a
 * known encoding slip, the repairs are written onto a copy of the arguments,
 * and a failed re-parse is checked for which repairs held.
 * @module src/mcp-server/tools/utils/arguments/repair
 */

import type { ZodType } from 'zod';

import {
  argumentAt,
  objectSchemaAt,
  routesThroughPipeAt,
  stepInto,
  type TransformCache,
  type TransformSite,
} from '../schemaShape.js';
import type { ToolInputSchema } from '../toolDefinition.js';
import type { ArgumentIssue, LocatedIssue } from './issues.js';

/**
 * The repairs {@link repairRepresentations} performs, as `mcp.input.coercion`
 * labels them, in the order a call's debug log names them — paired with how
 * that log reads each one.
 */
export const COERCION_KINDS = {
  stringified_array: 'a stringified array',
  stringified_object: 'a stringified object',
  integer_as_string: 'an integer sent for a string',
  string_as_number: 'a string sent for a number',
  string_as_boolean: 'a string sent for a boolean',
  string_as_array: 'a string sent for an array',
  null_as_absent: 'null sent for an optional field',
} as const;

/** One repair {@link repairRepresentations} can perform. */
export type CoercionKind = keyof typeof COERCION_KINDS;

/**
 * One value {@link repairRepresentations} repaired: where it sits, what the
 * caller sent there, and what replaces it — or, for `null_as_absent`, that the
 * key is deleted. {@link applyRepairs} writes any set of them onto the caller's
 * arguments, so a parse can be retried with only some of a call's repairs
 * applied, and leaving a deletion out of the set keeps the caller's `null`.
 *
 * A value below a `z.preprocess()` or a `.transform().pipe()` sits in what the
 * transform made of the argument, not in the argument itself (#599): `within`
 * names each such transform, outermost first, and the repair is written into
 * its output.
 */
export type Repair = (
  | {
      readonly kind: Exclude<CoercionKind, 'null_as_absent'>;
      /** The full argument path the value sits at. */
      readonly path: readonly PropertyKey[];
      /** The value at `path` — the caller's own, or a transform's output there. */
      readonly sent: unknown;
      /** The value that replaces it. */
      readonly value: unknown;
    }
  | {
      readonly kind: 'null_as_absent';
      /** The full argument path of the key that is deleted. */
      readonly path: readonly PropertyKey[];
      readonly sent: null;
    }
) & {
  /** The transforms above `path`, outermost first; absent when there are none. */
  readonly within?: readonly TransformSite[];
};

/** What {@link repairRepresentations} produced. */
export interface RepairedArguments {
  /** The repaired arguments — the input itself when nothing was repairable. */
  readonly args: unknown;
  /**
   * The arguments with each repair below a transform written in place instead
   * — at its issue path in the arguments as sent, never into the transform's
   * output — and the kinds they carry. Present only when such a repair was
   * found; {@link parseToolArguments} parses it after {@link repairAsSent}'s
   * repair and before `args`.
   */
  readonly inPlace?: { readonly args: unknown; readonly kinds: readonly CoercionKind[] };
  /** Each kind that fired at least once, in {@link COERCION_KINDS} order. */
  readonly kinds: readonly CoercionKind[];
  /** Every repair {@link RepairedArguments.args} carries, one per path, in issue order. */
  readonly repairs: readonly Repair[];
  /**
   * The arguments without the original repairs `args` adds beside the
   * rendered issues' own, and the kinds they carry. Present only when an
   * original repair was added and these still differ from the input;
   * {@link parseToolArguments} parses them when `args` fails.
   */
  readonly unaided?: { readonly args: unknown; readonly kinds: readonly CoercionKind[] };
}

/**
 * Undoes a representation slip at each path the failed parse's issues named:
 * a string whose trimmed form is a JSON array or object is parsed back into
 * what it encodes (#234, #479), a safe integer where a string was expected
 * becomes its decimal string (#487), a string where only numbers or booleans
 * are accepted becomes the one it spells (#707), a lone string where an array
 * was expected becomes its only element (#602), and `null` at a key the
 * enclosing `z.object()` of `input` declares optional is deleted (#616). That
 * deletion is the only key change: no key is added or renamed, none is dropped
 * but a `null`-valued one, and a value no issue points at is returned
 * untouched.
 *
 * **`null` means unset only where the schema says so.** The key must be one
 * the enclosing object declares — resolved by {@link objectSchemaAt}, through
 * wrappers and into the variant a discriminator selects — and its field must
 * refuse `null` and accept `undefined`. A required field's `null` keeps its
 * rejection, a `.nullable()` field never raises the issue, and a `z.record()`
 * entry, a key under an author-opened catchall, and an array element are data
 * whose key set is the meaning, so none is deleted. The value, not the issue
 * code, is the trigger: `null` on an optional enum fails as `invalid_value`,
 * whose message never says `null`.
 *
 * **Targeted, not a full walk.** A rejection names exactly the values the schema
 * could not accept, and repairing anything else loses repairs that should have
 * succeeded: one call carrying a stringified array for an array field *and* a
 * free-text field legitimately holding `"[1,2]"` would have both rewritten, the
 * re-parse would fail on the free-text field, and the whole call would be
 * rejected over a value that was valid all along.
 *
 * **The issues the rejection renders.** {@link parseToolArguments} passes the
 * list the rejection's message renders, each at its full path: a union whose
 * selection leaves one branch failing below its root contributes that branch's
 * issues under the union's path, recursively (#570), and every other union
 * keeps its one issue at its own path — the value the union rejected, read as
 * a whole — and is also read at each path below it where every branch listed
 * the values it takes (#714, {@link everyBranchRefuses}). That is where a
 * literal tag no branch takes sits, read as a plain field holding every
 * branch's literal reads it: `"1"` against tags `1` and `2` reads as it does
 * against `z.union([z.literal(1), z.literal(2)])`. A discriminated union's
 * unmatched discriminator, which Zod reports with no branches, is read from
 * the tags it lists the same way ({@link unmatchedDiscriminator}). Inside the
 * lifted branch each kind repairs exactly as it would in a non-union field,
 * with its own gate. Only one branch looks inside the value there: every other
 * failed at its root or on one literal, and so rejects the value whatever it
 * holds — except where that literal sits at the very path being repaired,
 * which the entry carries as a rival, and the gate then reads the value as a
 * plain union field of those branches (`6` beside a `z.literal(5)` branch
 * stays a number, so it stays rejected). A branch that accepts a number at the
 * path is reported by Zod as its own check (`too_big`), which no gate takes.
 * Two branches failing below their roots are never lifted, so neither is read
 * below its root but where each lists the values it takes.
 *
 * **One pass, no stacking.** Only a value the first parse rejected is repaired,
 * and at most once — the first issue at a path that yields a repair claims it —
 * so a value one repair produced is never repaired again: an integer inside a
 * stringified array, a stringified field inside a stringified object. The
 * caller re-parses once. A repaired discriminator selects a variant Zod never
 * parsed, so a second slip inside that variant is not repaired with it: the
 * rejection reports it, the tag's repair held (#706).
 *
 * `JSON.parse` is the exact inverse of the `JSON.stringify` that produced a
 * string, and `String(n)` of a safe integer is the digits the caller sent, so
 * each repair undoes a known encoding rather than matching a nearest candidate —
 * the distinction that makes it safe where nearest-key matching is not (#232).
 * Safety does not rest on that alone: {@link parseToolArguments} runs this only
 * after validation has already failed and keeps the result only when it then
 * passes.
 *
 * **A string is read as another type only where the field types it itself.**
 * A field routed through a `.transform()`, `.pipe()`, or `z.preprocess()`
 * can reject its transform's output rather than the string sent — `"15"` an
 * ID-or-name lookup does not know — so a string there is never turned into a
 * number, boolean, or one-element list. Nor is one at a path that could land on
 * such a field ({@link routesThroughPipeAt}): one option of a plain union
 * declaring it while another declares or catches the same key, one side of an
 * intersection, or an option whose own tag the caller sent wrong — the tag
 * itself included, so `"1"` stays a string where one branch types its tag
 * through a `z.preprocess()`.
 *
 * **A value inside a transform's output (#599).** Below a `z.preprocess()` or
 * a `.transform().pipe()`, an issue path runs through what the transform made
 * of the argument — `items.0.year` inside the list a preprocess wrapped a lone
 * object in — so each path is read through {@link argumentAt}, which re-applies
 * the transform in-process. The repair is written into that output, and the
 * output is put in the argument's place only when the transform, applied to
 * it, returns it structurally unchanged ({@link applyRepairs}); a transform
 * that would reorder it, rewrite a value in it, or reject it leaves the
 * argument as sent. The field the value sits in still decides the string
 * kinds: a plain `z.string()` inside a wrapped list takes them, a field that
 * is itself a pipe does not.
 *
 * **The same values written in place, tried first.** A repair can also be read
 * and written at its issue path in the arguments as sent, leaving the re-parse
 * to run the transform over it again. That validates calls the substitution
 * refuses — `[1, 2]` under a preprocess that reverses a list reaches the
 * handler as `["2", "1"]` — and gives some a different value: `[5]` under one
 * that doubles numbers reaches it as `["5"]`, where the substitution would
 * hand on `["10"]`. The original repair ({@link repairAsSent}) already places
 * every value Zod's own issues name that way, so each call it validated keeps
 * its value; `inPlace` carries the placement where that repair does not reach
 * — inside a union's one surviving branch, and beside this pass's other
 * repairs — so such a call gets the value the field gets on its own. It is
 * built whenever a value below a transform, or behind one that throws when
 * re-applied, is repairable that way, with the kinds that placement carries: a
 * stringified array or object, and an integer sent for a string.
 * {@link parseToolArguments} parses it after the original repair and before
 * `args`, and keeps it when it validates. Each repair of `original` that no
 * rendered issue reaches and that sits at no transform — a union field's
 * value read whole, a stringified list beside a branch that splits a string —
 * joins `repairs` too ({@link withOriginal}), so a call needing it beside a
 * repair only this pass makes validates, and a rejection reports it as held.
 * The repairs without it come back as `unaided`, parsed when `args` fails:
 * integers inside the list a branch decodes from JSON text need the lifted
 * branch's repairs, and the original reading of the text refuses them.
 *
 * Every value is read beside the caller's arguments, each transform at most
 * once per value through `transforms`, and the repairs found are written in
 * one {@link applyRepairs} pass per placement, so the work is linear in the
 * issues however many values one array holds. They come back as `repairs`,
 * one per path.
 *
 * `args` is the argument itself when nothing was repairable, which is the
 * signal the caller uses to skip the second parse.
 */
export function repairRepresentations(
  args: unknown,
  issues: readonly LocatedIssue[],
  input: ToolInputSchema,
  transforms: TransformCache,
  original: readonly Repair[] = [],
): RepairedArguments {
  let repairs: Repair[] = [];
  let inPlace: Repair[] = [];
  const claimed = new Set<string>();
  const placed = new Set<string>();
  const strayed: Stray[] = [];
  for (const { issue, path, tag } of valueReads(issues)) {
    if (path.length === 0) continue;
    const key = JSON.stringify(path);
    if (claimed.has(key) && placed.has(key)) continue;
    const at = argumentAt(input, path, args, transforms);
    if (at.known && at.sites.length === 0) {
      // The path names the caller's own value, so both placements are one.
      placed.add(key);
    } else if (!placed.has(key)) {
      const repair = inPlaceRepair(args, path, issue);
      if (repair) {
        inPlace.push(repair);
        placed.add(key);
      }
    }
    if (claimed.has(key) || !at.known) continue;
    const within = at.sites.length > 0 ? { within: at.sites } : {};
    const sent = at.value;
    if (sent === null) {
      if (!unsetAt(input, args, path, transforms)) continue;
      repairs.push({ kind: 'null_as_absent', path, sent, ...within });
    } else {
      const repair = repairValue(sent, issue);
      if (!repair) continue;
      if (READS_A_STRING.has(repair.kind) && routesThroughPipeAt(input, path, args, transforms)) {
        continue;
      }
      repairs.push({ kind: repair.kind, path, sent, value: repair.value, ...within });
      if (tag && selectsRival(tag, repair.value)) strayed.push({ at: tag.at, path });
    }
    claimed.add(key);
  }
  if (strayed.length > 0) {
    const leftBehind = belowStrayedBranch(strayed);
    repairs = repairs.filter((repair) => !leftBehind(repair.path));
    inPlace = inPlace.filter((repair) => !leftBehind(repair.path));
  }
  const rendered = repairs;
  repairs = withOriginal(repairs, original, claimed, (path) => {
    const at = argumentAt(input, path, args, transforms);
    return at.known && at.sites.length === 0;
  });
  const repaired = repairs.length === 0 ? args : applyRepairs(args, repairs);
  const result: RepairedArguments = {
    args: repaired,
    kinds: kindsOf(repairs),
    repairs,
    ...unaidedBy(args, rendered, repairs),
  };
  if (inPlace.length === 0) return result;
  const placedRepairs = [...repairs.filter(({ within }) => !within), ...inPlace];
  const writtenInPlace = applyRepairs(args, placedRepairs);
  // Where the transform leaves every value at its own position, both placements are one parse.
  if (sameValue(writtenInPlace, repaired)) return result;
  return { ...result, inPlace: { args: writtenInPlace, kinds: kindsOf(placedRepairs) } };
}

/**
 * `repairs` with each repair of `original` ({@link repairAsSent}) added that
 * no repair here claimed and that names the caller's own value, `own` — no
 * transform above its path — and each repair below an added one dropped. The
 * rendered issues read a union whose selection lifts a branch inside that
 * branch (#570), so the original repair of the union's value read whole — a
 * stringified list beside a branch that splits a string — has no counterpart
 * here, and a call needing it beside a repair only this pass makes would
 * validate under neither. Below a transform the in-place placement already
 * carries the original repair.
 */
function withOriginal(
  repairs: Repair[],
  original: readonly Repair[],
  claimed: ReadonlySet<string>,
  own: (path: readonly PropertyKey[]) => boolean,
): Repair[] {
  const added = original.filter(
    (repair) => !claimed.has(JSON.stringify(repair.path)) && own(repair.path),
  );
  if (added.length === 0) return repairs;
  interface Node {
    added?: true;
    readonly children: Map<string, Node>;
  }
  const root: Node = { children: new Map() };
  for (const { path } of added) {
    let node = root;
    for (const step of path) {
      const key = String(step);
      let child = node.children.get(key);
      if (!child) {
        child = { children: new Map() };
        node.children.set(key, child);
      }
      node = child;
    }
    node.added = true;
  }
  const below = (path: readonly PropertyKey[]): boolean => {
    let node: Node | undefined = root;
    for (let depth = 0; node && depth < path.length - 1; depth++) {
      node = node.children.get(String(path[depth]));
      if (node?.added) return true;
    }
    return false;
  };
  return [...repairs.filter((repair) => !below(repair.path)), ...added];
}

/**
 * The substitution before {@link withOriginal} widened it — the rendered
 * issues' own repairs alone, `rendered` — for when the widened one fails: a
 * lifted branch's repairs can be what a call needs where the original reading
 * of the union's value is refused, as integers inside the list a branch
 * decodes from JSON text are. Empty when nothing was added, or when those
 * repairs leave the arguments as sent.
 */
function unaidedBy(
  args: unknown,
  rendered: readonly Repair[],
  repairs: readonly Repair[],
): Pick<RepairedArguments, 'unaided'> {
  if (repairs === rendered || rendered.length === 0) return {};
  const unaided = applyRepairs(args, rendered);
  return sameValue(unaided, args) ? {} : { unaided: { args: unaided, kinds: kindsOf(rendered) } };
}

/** One value {@link repairRepresentations} reads: the issue its gates ask, at the value's full path. */
interface ValueRead {
  readonly issue: ArgumentIssue;
  readonly path: readonly PropertyKey[];
  /** Present for an entry with {@link LocatedIssue.rivals}: what {@link selectsRival} reads. */
  readonly tag?: RivalTag;
}

/**
 * A lifted branch's value at a path where branches the rendering dropped failed
 * on one literal — a tag, read as the plain union field holding those literals
 * (#570, #714).
 */
interface RivalTag {
  /** The path of the union the branch was lifted from. */
  readonly at: readonly PropertyKey[];
  /** The lifted branch's own issue at the tag. */
  readonly own: ArgumentIssue;
  /** The dropped branches' literals there. */
  readonly rivals: readonly ArgumentIssue[];
}

/** A tag repair that selects a dropped branch: the union at `at`, and the tag's path. */
interface Stray {
  readonly at: readonly PropertyKey[];
  readonly path: readonly PropertyKey[];
}

/**
 * Every value {@link repairRepresentations} reads for `issues`, in order: each
 * entry at its own path — a discriminated union's unmatched discriminator read
 * as the values its variants take ({@link unmatchedDiscriminator}), an entry
 * with {@link LocatedIssue.rivals} as the plain union field holding those
 * branches ({@link asUnionIssue}) — then each path below a union the rendering
 * left whole at which every branch listed the values it takes
 * ({@link everyBranchRefuses}).
 */
function* valueReads(issues: readonly LocatedIssue[]): Generator<ValueRead> {
  for (const entry of issues) {
    const read = unmatchedDiscriminator(entry.issue) ?? entry.issue;
    const { path, rivals } = entry;
    if (rivals) {
      // Each rival's path is branch-relative, so the union sits that many steps up.
      const at = path.slice(0, path.length - (rivals[0]?.path.length ?? 0));
      yield { issue: asUnionIssue(read, rivals), path, tag: { at, own: read, rivals } };
    } else {
      yield { issue: read, path };
    }
    yield* everyBranchRefuses(entry);
  }
}

/**
 * Whether a repaired tag is a value its own branch's literal refuses and a
 * dropped branch's literal takes: `"2"` repaired to `2` where the lifted branch
 * is tagged `1` and a dropped one `2`. The dropped branch failed on that tag
 * alone, so the repaired call selects it, and every other repair the lifted
 * branch's issues asked for belongs to a branch the call no longer selects —
 * one that would turn `id: 7`, valid in the selected branch, into `"7"`.
 */
function selectsRival({ own, rivals }: RivalTag, value: unknown): boolean {
  const takes = (literal: ArgumentIssue) =>
    literal.code === 'invalid_value' && literal.values.includes(value as never);
  return own.code === 'invalid_value' && !takes(own) && rivals.some(takes);
}

/**
 * Whether a repair's path lies below a union in `strayed` other than at that
 * union's tag — a repair {@link selectsRival} says belongs to a branch the call
 * no longer selects. The unions are held as a tree of their paths, so each
 * question costs the depth of the path asked about.
 */
function belowStrayedBranch(strayed: readonly Stray[]): (path: readonly PropertyKey[]) => boolean {
  interface Node {
    readonly children: Map<string, Node>;
    tags?: Set<string>;
  }
  const root: Node = { children: new Map() };
  for (const { at, path } of strayed) {
    let node = root;
    for (const step of at) {
      const key = String(step);
      let child = node.children.get(key);
      if (!child) {
        child = { children: new Map() };
        node.children.set(key, child);
      }
      node = child;
    }
    node.tags ??= new Set();
    node.tags.add(JSON.stringify(path.slice(at.length)));
  }
  return (path) => {
    let node: Node | undefined = root;
    for (let depth = 0; node && depth < path.length; depth++) {
      if (node.tags && !node.tags.has(JSON.stringify(path.slice(depth)))) return true;
      node = node.children.get(String(path[depth]));
    }
    return false;
  };
}

/**
 * A discriminated union's issue for a discriminator no variant takes, which
 * carries no branches, as the `invalid_value` a field holding every variant's
 * tag raises at the discriminator (#714): Zod lists those tags as `options`.
 * A tag a variant leaves optional is listed as `undefined`, which says nothing
 * about a value the caller sent, so it is left out — as a plain union of the
 * same variants leaves it out. `undefined` for any other issue.
 */
function unmatchedDiscriminator(issue: ArgumentIssue): ArgumentIssue | undefined {
  if (issue.code !== 'invalid_union' || issue.errors.length > 0 || !('options' in issue)) return;
  const values = (issue.options ?? []).filter((value) => value !== undefined);
  if (values.length === 0) return;
  return { code: 'invalid_value', message: issue.message, path: issue.path, values };
}

/**
 * The values a union the rendering left whole refused in every branch (#714):
 * each path below the union at which every branch raised an `invalid_value` —
 * a literal tag no branch takes, or any field each branch lists the values
 * of — or an unmatched discriminator ({@link unmatchedDiscriminator}), read as
 * the one issue `z.union()` of those literals raises there
 * ({@link asUnionIssue}). The gates then read `"1"` against tags `1` and `2`
 * exactly as they read it against `z.union([z.literal(1), z.literal(2)])`.
 *
 * Each branch's values are mapped by path once, and a candidate is looked up
 * in the other branches' maps: scanning them for it instead costs the square
 * of the issues on a union whose branches each report many values at paths
 * the others lack.
 */
function* everyBranchRefuses({ issue, path }: LocatedIssue): Generator<ValueRead> {
  if (issue.code !== 'invalid_union') return;
  const [first, ...others] = issue.errors.map((branch) => {
    const byPath = new Map<string, ArgumentIssue>();
    for (const branchIssue of branch) {
      const listed =
        branchIssue.code === 'invalid_value' ? branchIssue : unmatchedDiscriminator(branchIssue);
      if (!listed || listed.path.length === 0) continue;
      const at = JSON.stringify(listed.path);
      if (!byPath.has(at)) byPath.set(at, listed);
    }
    return byPath;
  });
  if (!first) return;
  for (const [at, listed] of first) {
    const rivals = others.map((branch) => branch.get(at));
    if (rivals.every((rival): rival is ArgumentIssue => rival !== undefined)) {
      yield { issue: asUnionIssue(listed, rivals), path: [...path, ...listed.path] };
    }
  }
}

/** Each kind `repairs` holds, in {@link COERCION_KINDS} order. */
function kindsOf(repairs: readonly Repair[]): readonly CoercionKind[] {
  const fired = new Set(repairs.map((repair) => repair.kind));
  return (Object.keys(COERCION_KINDS) as CoercionKind[]).filter((kind) => fired.has(kind));
}

/** The kinds a repair written in place carries ({@link inPlaceRepair}). */
const IN_PLACE_KINDS: ReadonlySet<CoercionKind> = new Set([
  'stringified_array',
  'stringified_object',
  'integer_as_string',
]);

/**
 * The repair the value at `path` in the arguments as sent takes, written back
 * at that same path — for a path below a transform, whose issue names a value
 * in the transform's output, the value read can be another one or none at
 * all. Only {@link IN_PLACE_KINDS}: each reads nothing but the value and the
 * issue, so it needs no schema at a path the arguments as sent do not follow.
 */
function inPlaceRepair(
  args: unknown,
  path: readonly PropertyKey[],
  issue: ArgumentIssue,
): Repair | undefined {
  const sent = path.reduce<unknown>((value, step) => stepInto(value, step), args);
  const repair = repairValue(sent, issue);
  if (!repair || !IN_PLACE_KINDS.has(repair.kind)) return;
  return { kind: repair.kind, path, sent, value: repair.value };
}

/**
 * The repair 0.13.13 and earlier made, which every call it validated must
 * still get first: each of the failed parse's own issues at a non-root path,
 * read and written at that path in the arguments as sent
 * ({@link inPlaceRepair}). A value takes one kind of those repairs whichever
 * issue names it, and {@link applyRepairs} writes a path two repairs share
 * once. Zod's own list, not the one the rejection renders: a union whose
 * selection lifts a branch (#570) is read here as the one value it rejected,
 * so a stringified list for a field whose other branch splits or wraps a
 * string parses back into the list, as that reading gave it. `undefined` when
 * nothing repairs.
 */
export function repairAsSent(
  args: unknown,
  issues: readonly ArgumentIssue[],
):
  | {
      readonly args: unknown;
      readonly kinds: readonly CoercionKind[];
      readonly repairs: readonly Repair[];
    }
  | undefined {
  const repairs: Repair[] = [];
  for (const issue of issues) {
    if (issue.path.length === 0) continue;
    const repair = inPlaceRepair(args, issue.path, issue);
    if (repair) repairs.push(repair);
  }
  if (repairs.length === 0) return;
  return { args: applyRepairs(args, repairs), kinds: kindsOf(repairs), repairs };
}

/**
 * `issue` and its {@link LocatedIssue.rivals}, as the one `invalid_union` a
 * plain union field holding those branches raises at that path — each
 * branch's issue at its root — so every gate reads the value exactly as it
 * reads that field.
 */
function asUnionIssue(issue: ArgumentIssue, rivals: readonly ArgumentIssue[]): ArgumentIssue {
  return {
    code: 'invalid_union',
    errors: [issue, ...rivals].map((branch) => [{ ...branch, path: [] }]),
    message: issue.message,
    path: issue.path,
  };
}

/**
 * Whether `null` at `path` means the key is unset: the enclosing `z.object()`
 * declares the key, and its field refuses `null` but accepts `undefined`
 * (`.optional()`, `.default()`). `.exactOptional()` fails the second test even
 * though its object accepts the key absent, so its `null` keeps the rejection.
 */
function unsetAt(
  input: ToolInputSchema,
  args: unknown,
  path: readonly PropertyKey[],
  transforms: TransformCache,
): boolean {
  const key = path.at(-1);
  if (typeof key !== 'string') return false;
  const shape = objectSchemaAt(input, path.slice(0, -1), args, transforms)?.shape;
  if (!shape || !Object.hasOwn(shape, key)) return false;
  const field = shape[key] as ZodType;
  // An author check or transform that throws on `undefined` throws for the
  // omitted key too; here it only means the `null` keeps its rejection.
  try {
    return !field.safeParse(null).success && field.safeParse(undefined).success;
  } catch {
    return false;
  }
}

/**
 * The kinds that read a string as another type. Each is refused at a field
 * that routes its value through a transform ({@link routesThroughPipeAt}): there
 * the rejection can describe the transform's output, so the string the caller
 * sent may be one the field takes — a name its lookup lacks, not a number.
 */
const READS_A_STRING: ReadonlySet<CoercionKind> = new Set([
  'string_as_number',
  'string_as_boolean',
  'string_as_array',
]);

/**
 * The repair for one value the parse rejected, or `undefined` when none applies.
 *
 * A string is decoded only when its trimmed form opens a JSON array or object —
 * the grammar then guarantees the decoded kind — and such a string is never
 * read any other way, even when it does not parse. A number becomes a string
 * only when it is a safe integer other than `-0` (`String(-0)` is `"0"`, and an
 * unsafe integer already lost digits in `JSON.parse`), and only when the issue
 * says it failed for being a number ({@link failedAsNumber}). Any other string
 * is wrapped as a one-element array where the issue is `invalid_type`
 * expecting an array ({@link wrapsAsArray}) — never a tuple
 * (`expected: "tuple"`) or a union field (`invalid_union`) — and otherwise
 * becomes the number or boolean it spells, only where the issue accepts
 * nothing but those ({@link scalarTypesAt}). Each string matches one rule at
 * most, so the kinds never compete.
 */
function repairValue(value: unknown, issue: ArgumentIssue): ValueRepair | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && !Object.is(value, -0) && failedAsNumber(issue)
      ? { kind: 'integer_as_string', value: String(value) }
      : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const kind = trimmed.startsWith('[')
    ? 'stringified_array'
    : trimmed.startsWith('{')
      ? 'stringified_object'
      : undefined;
  if (kind) {
    try {
      return { kind, value: JSON.parse(trimmed) };
    } catch {
      return undefined;
    }
  }
  if (issue.code === 'invalid_type' && issue.expected === 'array') {
    return wrapsAsArray(value, trimmed) ? { kind: 'string_as_array', value: [value] } : undefined;
  }
  return scalarFromString(trimmed, scalarTypesAt(issue));
}

/** A repair that replaces a value — every kind but `null_as_absent`'s deletion. */
type ValueRepair = Pick<Extract<Repair, { value: unknown }>, 'kind' | 'value'>;

/**
 * Whether a string sent where an array was expected is its one element, as
 * sent (#602). Never a blank string — a form client's unset field — and never
 * one holding a comma or a line break, which may be a joined list: splitting it
 * is the server's call, and the rejection already says to send an array. A line
 * break is any Unicode mandatory break: `\n`, `\v`, `\f`, `\r`, next line
 * (U+0085), and the line and paragraph separators (U+2028, U+2029).
 */
function wrapsAsArray(value: string, trimmed: string): boolean {
  return trimmed.length > 0 && !/[,\n\v\f\r\x85\p{Zl}\p{Zp}]/u.test(value);
}

/** A JSON scalar other than a string, as {@link scalarTypesAt} names it. */
type NonStringScalar = 'boolean' | 'number';

/**
 * The number or boolean a trimmed string spells, when `accepted` takes it.
 *
 * A number only when `String(n)` gives the string back — the decimal form
 * `JSON.stringify` writes — so the repair is an exact inverse: `"15"`, `"2.5"`,
 * `"-3"` convert, while `"01"`, `"1e3"`, `"-0"`, `"1.50"`, `"0x10"`, a blank,
 * and an integer past 2^53 (it would lose digits) never do. A boolean only from
 * `"true"` or `"false"` exactly.
 */
function scalarFromString(
  trimmed: string,
  accepted: ReadonlySet<NonStringScalar>,
): ValueRepair | undefined {
  if (accepted.has('number')) {
    const number = Number(trimmed);
    if (Number.isFinite(number) && String(number) === trimmed) {
      return { kind: 'string_as_number', value: number };
    }
  }
  if (accepted.has('boolean') && (trimmed === 'true' || trimmed === 'false')) {
    return { kind: 'string_as_boolean', value: trimmed === 'true' };
  }
  return undefined;
}

/** What {@link scalarTypesAt} returns for an issue that takes a string some way. */
const NO_SCALARS: ReadonlySet<NonStringScalar> = new Set();

/**
 * The scalar types a string could be converted into at an issue — empty unless
 * the issue says the string failed for its type where only numbers and booleans
 * are accepted, the mirror of {@link failedAsNumber}'s gate (#707):
 *
 * - `invalid_type` expecting `number` or `boolean`.
 * - `invalid_value` listing only numbers, booleans, and `null` — a numeric
 *   literal set or enum, `z.literal(true)`.
 * - `invalid_union` whose every branch failed one of those ways, or as
 *   `invalid_type` expecting `null`, at its own root.
 *
 * Anything else takes a string some way and keeps its rejection: `"15"` against
 * `z.union([z.number(), z.literal('auto')])` fails a branch that lists a
 * string, so the field takes strings and `"15"` is a wrong one, and a branch
 * expecting an array gives the string a second reading. A discriminated
 * union's unmatched discriminator reports no branches and never passes:
 * {@link repairRepresentations} asks with the tags it lists instead
 * ({@link unmatchedDiscriminator}).
 */
function scalarTypesAt(issue: ArgumentIssue): ReadonlySet<NonStringScalar> {
  const types = new Set<NonStringScalar>();
  const admits = (candidate: ArgumentIssue): boolean => {
    switch (candidate.code) {
      case 'invalid_type':
        if (candidate.expected === 'number') types.add('number');
        else if (candidate.expected === 'boolean') types.add('boolean');
        else return candidate.expected === 'null';
        return true;
      case 'invalid_value':
        return (
          candidate.values.length > 0 &&
          candidate.values.every((value) => {
            if (typeof value === 'number') types.add('number');
            else if (typeof value === 'boolean') types.add('boolean');
            else return value === null;
            return true;
          })
        );
      default:
        return false;
    }
  };
  const gated =
    issue.code === 'invalid_union'
      ? issue.errors.length > 0 &&
        issue.errors.every(
          (branch) =>
            branch.length > 0 &&
            branch.every((branchIssue) => branchIssue.path.length === 0 && admits(branchIssue)),
        )
      : admits(issue);
  return gated ? types : NO_SCALARS;
}

/**
 * Whether an issue says its value failed for being a number, rather than for
 * failing a number's own check — the gate that keeps the integer repair from
 * laundering a number into a string branch (#487).
 *
 * - `invalid_type` — the value's type is what the schema there refused.
 * - `invalid_value` listing only strings — a `z.enum` or string literal.
 * - `invalid_union` whose every branch failed one of those two ways at its own
 *   root.
 *
 * Anything else keeps its rejection. `-1` against
 * `z.union([z.number().int().positive(), z.string()])` arrives as the number
 * branch's own `too_small` — that union takes numbers, and `"-1"` would slip
 * past the author's constraint through the string branch — and `6` against
 * `z.union([z.literal(5), z.string()])` fails a branch that lists a number. A
 * discriminated union's unmatched discriminator reports no branches and never
 * passes: {@link repairRepresentations} asks with the tags it lists instead
 * ({@link unmatchedDiscriminator}).
 */
function failedAsNumber(issue: ArgumentIssue): boolean {
  switch (issue.code) {
    case 'invalid_type':
      return true;
    case 'invalid_value':
      return issue.values.length > 0 && issue.values.every((value) => typeof value === 'string');
    case 'invalid_union':
      return (
        issue.errors.length > 0 &&
        issue.errors.every(
          (branch) =>
            branch.length > 0 &&
            branch.every(
              (branchIssue) => branchIssue.path.length === 0 && failedAsNumber(branchIssue),
            ),
        )
      );
    default:
      return false;
  }
}

/** The repairs below one container, keyed by the path step that reaches each. */
interface RepairNode {
  children?: Map<string, RepairNode>;
  repair?: Repair;
  /** The transforms at this position, outermost first, whose output the repairs below sit in. */
  sites?: readonly TransformSite[];
}

/**
 * `repairs` as a tree of their paths, each transform a repair sits inside
 * attached to the node at its position. A path two repairs share keeps the
 * first, and so does a position two repairs' transforms share.
 */
function repairTree(repairs: readonly Repair[]): RepairNode {
  const root: RepairNode = {};
  for (const repair of repairs) {
    const { path, within = [] } = repair;
    let node = root;
    let next = 0;
    for (let depth = 0; ; depth++) {
      const first = next;
      while (within[next]?.depth === depth) next++;
      if (next > first && !node.sites) node.sites = within.slice(first, next);
      if (depth === path.length) break;
      node.children ??= new Map();
      const step = String(path[depth]);
      let child = node.children.get(step);
      if (!child) {
        child = {};
        node.children.set(step, child);
      }
      node = child;
    }
    node.repair ??= repair;
  }
  return root;
}

/**
 * Writes `repairs` onto `args`, copying each container on their paths once and
 * leaving the caller's own objects untouched — so a thousand repaired elements
 * of one array cost one copy of it, not a thousand. A `null_as_absent` repair
 * leaves its key out of the copy of the object that holds it. A path two
 * repairs share takes the first. Any subset of one call's
 * {@link RepairedArguments.repairs} can be written, which is how
 * {@link parseToolArguments} builds a rejection from the repairs that held.
 *
 * A repair inside a transform's output (#599) is written into that output, and
 * the output takes the argument's place only when the transform, applied to
 * it, returns it unchanged — compared structurally, since a transform may
 * rebuild the list it was handed. That is the one check the validity re-parse
 * cannot make: a transform that reorders or rewrites its input could validate
 * with values the repair never wrote. Otherwise every repair inside that
 * output is dropped and the argument is left as sent, so the call keeps its
 * rejection. A transform that throws on the output counts as one that changed
 * it. Nested transforms are checked at each position, innermost first.
 *
 * Object copies go through `Object.fromEntries`, which *defines* each property
 * rather than assigning it. `copy[key] = value` would route a caller's own
 * `__proto__` key — which `JSON.parse` creates as an ordinary own data property
 * — through `Object.prototype`'s setter: the key would vanish and the copy's
 * prototype would become whatever the caller sent, which Zod then reads
 * inherited values from. Defining keeps the key and the prototype, so no key is
 * added or renamed, and none is dropped but a deleted one.
 */
export function applyRepairs(args: unknown, repairs: readonly Repair[]): unknown {
  return applyNode(args, repairTree(repairs));
}

/**
 * The repairs a failed re-parse kept (#706): each one no issue of `issues` lies
 * at or below — the re-parse accepted the value it wrote, and whatever still
 * fails is somewhere else. A union's issue counts at its own path and every
 * branch's issues at theirs, whichever branch the rendering would select: a
 * repair one branch accepts and another refuses at the same path did not hold,
 * because the repaired value is what the refusing branch would then report.
 *
 * Each issue walks the tree of repair paths along its own path, so the check
 * is linear in the issues and the repairs together, however many of each one
 * array carries. An issue is walked from a node once (#648): Zod hands every
 * branch that parsed the same value the same issue objects, so a recursive
 * union whose `and` and `or` branches share a clause lists it under both, and
 * walking each listing would double the walk per level of the caller's
 * nesting.
 */
export function heldRepairs(
  repairs: readonly Repair[],
  issues: readonly ArgumentIssue[],
): readonly Repair[] {
  const broken = new Set<Repair>();
  const walked = new Map<RepairNode, Set<ArgumentIssue>>();
  const strike = (from: RepairNode, issue: ArgumentIssue): void => {
    const seen = walked.get(from) ?? new Set<ArgumentIssue>();
    if (seen.has(issue)) return;
    walked.set(from, seen.add(issue));
    let node = from;
    for (const step of issue.path) {
      const child = node.children?.get(String(step));
      if (!child) return;
      node = child;
      if (node.repair) broken.add(node.repair);
    }
    if (issue.code !== 'invalid_union') return;
    for (const branch of issue.errors) {
      for (const branchIssue of branch) strike(node, branchIssue);
    }
  };
  const tree = repairTree(repairs);
  for (const issue of issues) strike(tree, issue);
  return repairs.filter((repair) => !broken.has(repair));
}

/**
 * {@link applyRepairs} for one value and the repairs at and below it. At a
 * transform's position the repairs below are written into its output instead,
 * kept only when every transform there returns the result unchanged.
 */
function applyNode(value: unknown, node: RepairNode): unknown {
  const { repair, sites } = node;
  if (!sites || repair) return writeNode(value, node);
  const written = writeNode(sites[sites.length - 1]?.output, node);
  return sites.every((site) => returnsUnchanged(site.transform, written)) ? written : value;
}

/** Whether `transform` applied to `value` gives back a value structurally equal to it. */
function returnsUnchanged(transform: ZodType, value: unknown): boolean {
  try {
    const again = transform.safeParse(value);
    return again.success && sameValue(again.data, value);
  } catch {
    return false;
  }
}

/**
 * Structural equality over what arguments are made of: the same value, or
 * arrays and plain objects holding equal entries under the same keys. Any
 * other object equals only itself.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a)) {
    return (
      Array.isArray(b) && a.length === b.length && a.every((entry, i) => sameValue(entry, b[i]))
    );
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
  );
}

/** A `{}` or `Object.create(null)` object — what `JSON.parse` and a spread produce. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Writes the repairs at and below `node` onto `value` itself. A deletion is
 * applied by the object holding the key, so a value reached through one comes
 * back as sent.
 */
function writeNode(value: unknown, node: RepairNode): unknown {
  const { children, repair } = node;
  if (repair) return repair.kind === 'null_as_absent' ? value : repair.value;
  if (!children || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    const copy = [...value];
    for (const [step, child] of children) {
      const index = Number(step);
      if (Number.isInteger(index) && index >= 0 && index < copy.length) {
        copy[index] = applyNode(value[index], child);
      }
    }
    return copy;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
      const child = children.get(key);
      if (!child) return [[key, entry]];
      return child.repair?.kind === 'null_as_absent' ? [] : [[key, applyNode(entry, child)]];
    }),
  );
}

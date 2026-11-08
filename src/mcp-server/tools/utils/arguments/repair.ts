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
  stepAlong,
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

/** The repair {@link repairAsSent} made: the arguments it wrote, and its repairs and their kinds. */
export interface OriginalRepair {
  readonly args: unknown;
  /**
   * Whether {@link repairRepresentations}, given the same issues as the
   * rejection renders them, makes exactly these repairs wherever the schema
   * reads every value as sent ({@link readsAsSent}): no issue is a union's,
   * which the rendering reads below its own path; no value an issue names is
   * `null` or a string that is no JSON text, the values only the substitution
   * repairs; and no two repairs share a path. The substitution is then this
   * repair itself.
   */
  readonly exhaustive: boolean;
  readonly kinds: readonly CoercionKind[];
  readonly repairs: readonly Repair[];
}

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
  /**
   * Every repair {@link RepairedArguments.args} was written from, one per path,
   * in issue order — one below another included, which the write leaves to the
   * one above it ({@link applyRepairs}).
   */
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
 * issues however many values one array holds, a small multiple of the parse of
 * the same arguments. They come back as `repairs`, one per path. When they are
 * the original repairs one for one — every value the rendered issues name is
 * one Zod's own issues name, and takes the same repair there — the
 * substitution is `original` itself, written once.
 *
 * `args` is the argument itself when nothing was repairable, which is the
 * signal the caller uses to skip the second parse.
 */
export function repairRepresentations(
  args: unknown,
  issues: readonly LocatedIssue[],
  input: ToolInputSchema,
  transforms: TransformCache,
  original?: OriginalRepair,
): RepairedArguments {
  let repairs: Repair[] = [];
  let inPlace: Repair[] = [];
  const marks: PathMark = {};
  const strayed: Stray[] = [];
  const originals = original?.repairs ?? [];
  /** How many of `originals`, in order, a read here took up as its own repair. */
  let matched = 0;
  for (const { issue, path, tag } of valueReads(issues)) {
    if (path.length === 0) continue;
    const mark = markAt(marks, path);
    if (mark.claimed && mark.placed) continue;
    const at = argumentAt(input, path, args, transforms);
    if (at.known && at.sites.length === 0) {
      // The path names the caller's own value, so both placements are one.
      mark.placed = true;
    } else if (!mark.placed) {
      const repair = inPlaceRepair(stepAlong(args, path), path, issue);
      if (repair) {
        inPlace.push(repair);
        mark.placed = true;
      }
    }
    if (mark.claimed || !at.known) continue;
    const within = at.sites.length > 0 ? { within: at.sites } : undefined;
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
      // The next original repair, where this one is it: the same kind and value at Zod's own issue path.
      const next = originals[matched];
      if (!within && next && sameWrite(next, path, repair)) {
        repairs.push(next);
        matched++;
      } else {
        repairs.push({ kind: repair.kind, path, sent, value: repair.value, ...within });
      }
      if (tag && selectsRival(tag, repair.value)) strayed.push({ at: tag.at, path });
    }
    mark.claimed = true;
  }
  if (strayed.length > 0) {
    const leftBehind = belowStrayedBranch(strayed);
    repairs = repairs.filter((repair) => !leftBehind(repair.path));
    inPlace = inPlace.filter((repair) => !leftBehind(repair.path));
  }
  const rendered = repairs;
  // A read here took up every original repair, so none is left for the rendered issues to lack.
  if (matched < originals.length) {
    repairs = withOriginal(repairs, originals, marks, (path) => {
      const at = argumentAt(input, path, args, transforms);
      return at.known && at.sites.length === 0;
    });
  }
  const result: RepairedArguments = {
    ...(original && sameRepairs(repairs, original.repairs)
      ? original
      : {
          args: repairs.length === 0 ? args : applyRepairs(args, repairs),
          kinds: kindsOf(repairs),
          repairs,
        }),
    ...unaidedBy(args, rendered, repairs),
  };
  if (inPlace.length === 0) return result;
  const placedRepairs = [...result.repairs.filter(({ within }) => !within), ...inPlace];
  const writtenInPlace = applyRepairs(args, placedRepairs);
  // Where the transform leaves every value at its own position, both placements are one parse.
  if (sameValue(writtenInPlace, result.args)) return result;
  return { ...result, inPlace: { args: writtenInPlace, kinds: kindsOf(placedRepairs) } };
}

/** Whether `repairs` are `original`'s, repair for repair. */
function sameRepairs(repairs: readonly Repair[], original: readonly Repair[]): boolean {
  return (
    repairs.length === original.length &&
    repairs.every((repair, index) => repair === original[index])
  );
}

/**
 * Whether an original repair ({@link repairAsSent}) writes what `repair` would
 * at `path`: the same kind and value at the same issue path. Such a read takes
 * the original repair up as its own.
 */
function sameWrite(original: Repair, path: readonly PropertyKey[], repair: ValueRepair): boolean {
  return (
    original.path === path &&
    original.kind === repair.kind &&
    'value' in original &&
    Object.is(original.value, repair.value)
  );
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
  marks: PathMark,
  own: (path: readonly PropertyKey[]) => boolean,
): Repair[] {
  const added = original.filter(
    (repair) => !markedAt(marks, repair.path)?.claimed && own(repair.path),
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
function valueReads(issues: readonly LocatedIssue[]): ValueRead[] {
  const reads: ValueRead[] = [];
  for (const entry of issues) {
    const discriminator = unmatchedDiscriminator(entry.issue);
    const read = discriminator ?? entry.issue;
    const { path, rivals } = entry;
    if (rivals) {
      // Each rival's path is branch-relative, so the union sits that many steps up.
      const at = path.slice(0, path.length - (rivals[0]?.path.length ?? 0));
      reads.push({ issue: asUnionIssue(read, rivals), path, tag: { at, own: read, rivals } });
    } else {
      reads.push(discriminator ? { issue: read, path } : entry);
    }
    if (entry.issue.code === 'invalid_union') everyBranchRefuses(entry, reads);
  }
  return reads;
}

/**
 * A trie node's children, by path step: a step that is an array index in a
 * plain array, the index a repair inside a list most often takes, and any
 * other step in a `Map`, each compared as itself.
 */
interface StepChildren<T> {
  elements?: T[];
  named?: Map<PropertyKey, T>;
}

/** The highest array index: `2 ** 32 - 2`. */
const MAX_ARRAY_INDEX = 4_294_967_294;

/** Whether a step is an array index, which {@link StepChildren} keeps in `elements`. */
function isArrayIndex(step: PropertyKey): step is number {
  return typeof step === 'number' && Number.isInteger(step) && step >= 0 && step <= MAX_ARRAY_INDEX;
}

/** The child at `step`, or `undefined` when none was made. */
function childAt<T>(node: StepChildren<T>, step: PropertyKey): T | undefined {
  return isArrayIndex(step) ? node.elements?.[step] : node.named?.get(step);
}

/** Sets the child at `step`. */
function setChildAt<T>(node: StepChildren<T>, step: PropertyKey, child: T): void {
  if (isArrayIndex(step)) {
    node.elements ??= [];
    node.elements[step] = child;
  } else {
    node.named ??= new Map();
    node.named.set(step, child);
  }
}

/**
 * The marks {@link repairRepresentations} sets on the paths it reads, one node
 * per path step. A step is compared as itself, so two paths share a node
 * exactly when `JSON.stringify` writes them alike: `0` and `"0"` stay apart.
 */
interface PathMark extends StepChildren<PathMark> {
  /** A repair was found at this path. */
  claimed?: true;
  /** This path's in-place placement is settled. */
  placed?: true;
}

/** The mark at `path` below `root`, made on first use. */
function markAt(root: PathMark, path: readonly PropertyKey[]): PathMark {
  let node = root;
  for (const step of path) {
    let next = childAt(node, step);
    if (!next) {
      next = {};
      setChildAt(node, step, next);
    }
    node = next;
  }
  return node;
}

/** The mark at `path` below `root`, or `undefined` when none was made. */
function markedAt(root: PathMark, path: readonly PropertyKey[]): PathMark | undefined {
  let node: PathMark | undefined = root;
  for (const step of path) {
    node = childAt(node, step);
    if (!node) return;
  }
  return node;
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
 * the others lack. The reads are added to `reads`.
 */
function everyBranchRefuses({ issue, path }: LocatedIssue, reads: ValueRead[]): void {
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
      reads.push({ issue: asUnionIssue(listed, rivals), path: [...path, ...listed.path] });
    }
  }
}

/** Each kind `repairs` holds, in {@link COERCION_KINDS} order. */
function kindsOf(repairs: readonly Repair[]): readonly CoercionKind[] {
  const fired = new Set<CoercionKind>();
  for (const { kind } of repairs) fired.add(kind);
  return (Object.keys(COERCION_KINDS) as CoercionKind[]).filter((kind) => fired.has(kind));
}

/** The kinds a repair written in place carries ({@link inPlaceRepair}). */
const IN_PLACE_KINDS: ReadonlySet<CoercionKind> = new Set([
  'stringified_array',
  'stringified_object',
  'integer_as_string',
]);

/**
 * The repair of `sent`, the value the arguments as sent hold at `path`,
 * written back at that same path. Below a transform, whose issue names a value
 * in the transform's output, `sent` can be another value or none at all. Only
 * {@link IN_PLACE_KINDS}: each reads nothing but the value and the issue, so
 * it needs no schema at a path the arguments as sent do not follow.
 */
function inPlaceRepair(
  sent: unknown,
  path: readonly PropertyKey[],
  issue: ArgumentIssue,
): Repair | undefined {
  // Only a number or JSON text takes one of those kinds; any other value's repair is never kept.
  if (typeof sent !== 'number' && !(typeof sent === 'string' && opensJson(sent.trim()))) return;
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
 *
 * It also says whether these are the repairs {@link repairRepresentations}
 * would make of the same issues over a schema that reads them as sent
 * ({@link readsAsSent}), as {@link OriginalRepair.exhaustive}.
 */
export function repairAsSent(
  args: unknown,
  issues: readonly ArgumentIssue[],
): OriginalRepair | undefined {
  const repairs: Repair[] = [];
  let exhaustive = true;
  for (const issue of issues) {
    // A union is read below its own path, beside the value it rejected.
    if (issue.code === 'invalid_union') exhaustive = false;
    if (issue.path.length === 0) continue;
    const sent = stepAlong(args, issue.path);
    // `null`, and a string that is no JSON text, take a kind only the substitution makes.
    if (sent === null || (typeof sent === 'string' && !opensJson(sent.trim()))) exhaustive = false;
    const repair = inPlaceRepair(sent, issue.path, issue);
    if (repair) repairs.push(repair);
  }
  if (repairs.length === 0) return;
  const written = applyRepairs(args, repairs);
  // The substitution makes one repair per path, so two at one path are not its repairs.
  if (repairTree(repairs).sharedPath) exhaustive = false;
  return { args: written, exhaustive, kinds: kindsOf(repairs), repairs };
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
  /**
   * An author check or transform that throws on `undefined` throws for the
   * omitted key too; here it only means the `null` keeps its rejection.
   */
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
  if (opensJson(trimmed)) {
    try {
      return {
        kind: trimmed.startsWith('[') ? 'stringified_array' : 'stringified_object',
        value: JSON.parse(trimmed),
      };
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

/** Whether a trimmed string opens a JSON array or object, the only way {@link repairValue} reads one that does. */
function opensJson(trimmed: string): boolean {
  return trimmed.startsWith('[') || trimmed.startsWith('{');
}

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

/**
 * Each set {@link scalarTypesAt} returns, by the flags it is built from — 1
 * for `number`, 2 for `boolean` — shared, since a repair asks once per value.
 * `0` is what an issue that takes a string some way gets.
 */
const SCALAR_SETS: readonly ReadonlySet<NonStringScalar>[] = [
  new Set(),
  new Set(['number']),
  new Set(['boolean']),
  new Set(['number', 'boolean']),
];

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
  if (issue.code !== 'invalid_union')
    return SCALAR_SETS[scalarFlags(issue)] as ReadonlySet<NonStringScalar>;
  let flags = 0;
  const gated =
    issue.errors.length > 0 &&
    issue.errors.every(
      (branch) =>
        branch.length > 0 &&
        branch.every((branchIssue) => {
          if (branchIssue.path.length > 0) return false;
          const admitted = scalarFlags(branchIssue);
          flags |= admitted;
          return admitted !== 0 || admitsNull(branchIssue);
        }),
    );
  return SCALAR_SETS[gated ? flags : 0] as ReadonlySet<NonStringScalar>;
}

/**
 * The {@link SCALAR_SETS} flags of the scalar types one issue says the
 * value failed for, where it accepts nothing but numbers, booleans, and
 * `null` — `0` when it takes anything else, or only `null` ({@link admitsNull}).
 */
function scalarFlags(issue: ArgumentIssue): number {
  switch (issue.code) {
    case 'invalid_type':
      return issue.expected === 'number' ? 1 : issue.expected === 'boolean' ? 2 : 0;
    case 'invalid_value': {
      if (issue.values.length === 0) return 0;
      let flags = 0;
      for (const value of issue.values) {
        if (typeof value === 'number') flags |= 1;
        else if (typeof value === 'boolean') flags |= 2;
        else if (value !== null) return 0;
      }
      return flags;
    }
    default:
      return 0;
  }
}

/** Whether an issue accepts only `null` — a union branch that leaves the scalar gate open. */
function admitsNull(issue: ArgumentIssue): boolean {
  if (issue.code === 'invalid_type') return issue.expected === 'null';
  return (
    issue.code === 'invalid_value' &&
    issue.values.length > 0 &&
    issue.values.every((value) => value === null)
  );
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

/** The repairs below one container, keyed by the {@link stepKey} of the path step that reaches each. */
interface RepairNode extends StepChildren<RepairNode> {
  /** Where {@link RepairNode.repair} sits in the repairs the tree was built from. */
  index?: number;
  /**
   * Set on the root when one of the repairs the tree was built from lies below
   * another, whose value {@link applyRepairs} writes in its place.
   */
  nested?: true;
  repair?: Repair;
  /** Set on the root when two of the repairs the tree was built from share a path. */
  sharedPath?: true;
  /** The transforms at this position, outermost first, whose output the repairs below sit in. */
  sites?: readonly TransformSite[];
  /** Each child's {@link stepKey}, in the order the children were made. */
  steps?: PropertyKey[];
}

/**
 * The key a path step takes in a {@link RepairNode}'s children. Two steps name
 * one position when `String()` writes them alike — `0` and `"0"` one element,
 * `"01"` another — so a string `String()` writes for a number is keyed as that
 * number, and an array index, the step most repairs take, stays one.
 */
function stepKey(step: PropertyKey): PropertyKey {
  if (typeof step === 'number') return step;
  if (typeof step === 'symbol') return String(step);
  // What `String()` writes for a number opens with a digit, `-`, `I`nfinity, or `N`aN.
  const first = step.charCodeAt(0);
  if ((first < 48 || first > 57) && first !== 45 && first !== 73 && first !== 78) return step;
  const number = Number(step);
  return String(number) === step ? number : step;
}

/**
 * The tree {@link repairTree} built for each set of repairs, so one set
 * written by {@link applyRepairs} and checked by {@link heldRepairs} is walked
 * into a tree once. A set is never changed once built.
 */
const repairTrees = new WeakMap<readonly Repair[], RepairNode>();

/** A repair's `within` when it sits below no transform. */
const NO_TRANSFORMS: readonly TransformSite[] = [];

/**
 * `repairs` as a tree of their paths, each transform a repair sits inside
 * attached to the node at its position. A path two repairs share keeps the
 * first, and so does a position two repairs' transforms share.
 */
function repairTree(repairs: readonly Repair[]): RepairNode {
  const built = repairTrees.get(repairs);
  if (built) return built;
  const root: RepairNode = {};
  for (let index = 0; index < repairs.length; index++) {
    const repair = repairs[index] as Repair;
    const { path, within = NO_TRANSFORMS } = repair;
    let node = root;
    let next = 0;
    for (let depth = 0; ; depth++) {
      const first = next;
      while (within[next]?.depth === depth) next++;
      if (next > first && !node.sites) node.sites = within.slice(first, next);
      if (depth === path.length) break;
      if (node.repair) root.nested = true;
      const step = stepKey(path[depth] as PropertyKey);
      let child = childAt(node, step);
      if (!child) {
        child = {};
        setChildAt(node, step, child);
        node.steps ??= [];
        node.steps.push(step);
      }
      node = child;
    }
    if (node.repair) {
      root.sharedPath = true;
    } else {
      // A child is on the path of a repair made earlier, which now lies below this one.
      if (node.steps) root.nested = true;
      node.repair = repair;
      node.index = index;
    }
  }
  repairTrees.set(repairs, root);
  return root;
}

/**
 * Writes `repairs` onto `args`, copying each container on their paths once and
 * leaving the caller's own objects untouched — so a thousand repaired elements
 * of one array cost one copy of it, not a thousand. A `null_as_absent` repair
 * leaves its key out of the copy of the object that holds it. A path two
 * repairs share takes the first, and a repair below another is never written:
 * the value of the one above it is. Any subset of one call's
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
 * it, and so does an output holding an array the write would copy that owns a
 * key besides its elements ({@link ownsNonIndexKey}): the copy would drop the
 * key, and the re-parse would judge a value the transform never made. Nested
 * transforms are checked at each position, innermost first.
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
  return applyNode(args, repairTree(repairs), false);
}

/**
 * The checks a value of the type its field takes fails for its magnitude — a
 * length, a range, a step. Each repair keeps the magnitude the caller sent (the
 * number `"600"` spells, the digits `String(n)` writes, the decoded list's
 * length), so such a check at the repaired value is the caller's own failure.
 */
const MAGNITUDE_CHECKS: ReadonlySet<ArgumentIssue['code']> = new Set([
  'too_big',
  'too_small',
  'not_multiple_of',
]);

/**
 * The repairs a failed re-parse kept (#706): each one no issue of `issues` lies
 * at or below — the re-parse accepted the value it wrote, and whatever still
 * fails is somewhere else — except a {@link MAGNITUDE_CHECKS} issue at the
 * repair's own path, which leaves it held (#745): the re-parse took the
 * repaired type and refused only its size, so the rejection reports that
 * check, exactly as a call sending the type gets it (`"600"` against `.max(500)`
 * reads as `600` does). Any other issue there, and any issue below it, inside
 * the repaired value, breaks it. A union's issue counts at its own path and
 * every branch's issues at theirs, whichever branch the rendering would select:
 * a repair one branch accepts and another refuses at the same path did not
 * hold, because the repaired value is what the refusing branch would then
 * report.
 *
 * A repair below another in `repairs` held exactly when the outermost one above
 * it did ({@link followOutermost}). Such a pair reads one value the caller sent
 * twice — a stringified list a `z.preprocess()` wraps, decoded where it was
 * sent and again as the one element the wrap made of it — and
 * {@link applyRepairs} writes only the outer reading, so the re-parse never
 * judged the inner one: its issues at `tags.0` measured the first element of
 * the decoded list.
 *
 * Each issue walks the tree of repair paths along its own path — the tree
 * {@link applyRepairs} wrote the same repairs from — so the check is linear in
 * the issues and the repairs together, however many of each one array
 * carries. An issue inside a union is walked from a node once (#648): Zod
 * hands every branch that parsed the same value the same issue objects, so a
 * recursive union whose `and` and `or` branches share a clause lists it under
 * both, and walking each listing would double the walk per level of the
 * caller's nesting.
 */
export function heldRepairs(
  repairs: readonly Repair[],
  issues: readonly ArgumentIssue[],
): readonly Repair[] {
  /** A flag per repair, by its place in `repairs`, set once an issue breaks it. */
  const broken = new Uint8Array(repairs.length);
  const walked = new Map<RepairNode, Set<ArgumentIssue>>();
  const strike = (from: RepairNode, issue: ArgumentIssue): void => {
    const { path } = issue;
    // The depth a magnitude check leaves its repair held at: its own path's last step.
    const holdsAt = MAGNITUDE_CHECKS.has(issue.code) ? path.length - 1 : -1;
    let node = from;
    for (let depth = 0; depth < path.length; depth++) {
      const child = childAt(node, stepKey(path[depth] as PropertyKey));
      if (!child) return;
      node = child;
      if (node.index !== undefined && depth !== holdsAt) broken[node.index] = 1;
    }
    if (issue.code !== 'invalid_union') return;
    const seen = walked.get(node) ?? new Set<ArgumentIssue>();
    walked.set(node, seen);
    for (const branch of issue.errors) {
      for (const branchIssue of branch) {
        if (seen.has(branchIssue)) continue;
        seen.add(branchIssue);
        strike(node, branchIssue);
      }
    }
  };
  const tree = repairTree(repairs);
  for (const issue of issues) strike(tree, issue);
  if (tree.nested) followOutermost(tree, broken);
  return repairs.filter((_, index) => broken[index] === 0);
}

/**
 * Gives each repair at or below `node` that lies below another the `broken`
 * flag of the outermost one above it, `outer`: {@link applyRepairs} writes that
 * one's value at its path and never descends past it.
 */
function followOutermost(node: RepairNode, broken: Uint8Array, outer?: number): void {
  const { index } = node;
  if (index !== undefined && outer !== undefined) broken[index] = broken[outer] as number;
  const above = outer ?? index;
  for (const step of node.steps ?? []) {
    followOutermost(childAt(node, step) as RepairNode, broken, above);
  }
}

/**
 * {@link applyRepairs} for one value and the repairs at and below it. At a
 * transform's position the repairs below are written into its output instead,
 * kept only when the output could be copied whole ({@link UNCOPIED}) and every
 * transform there returns the result unchanged. `inOutput` says `value` sits
 * inside a transform's output.
 */
function applyNode(value: unknown, node: RepairNode, inOutput: boolean): unknown {
  const { repair, sites } = node;
  if (!sites || repair) return writeNode(value, node, inOutput);
  const written = writeNode(sites.at(-1)?.output, node, true);
  return written !== UNCOPIED && sites.every((site) => returnsUnchanged(site.transform, written))
    ? written
    : value;
}

/**
 * What {@link writeNode} gives back, inside a transform's output, for an array
 * that owns a key besides its elements ({@link ownsNonIndexKey}): the
 * transform's position then leaves the argument as sent ({@link applyNode}).
 */
const UNCOPIED = Symbol('uncopied');

/**
 * Whether an array owns a key besides its elements and `length` — a string no
 * index spells, or a symbol — which a copy of its elements drops. An ordinary
 * array lists its own keys indices first, then `length`, then the rest in the
 * order they were made, so the last key answers. Only a transform's output can
 * hold such an array, so only an array copied inside one is asked: the question
 * costs a key per element.
 */
function ownsNonIndexKey(array: readonly unknown[]): boolean {
  return Reflect.ownKeys(array).at(-1) !== 'length';
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
 * back as sent. Inside a transform's output (`inOutput`), an array that owns a
 * key besides its elements, at or below `value`, makes it {@link UNCOPIED}.
 */
function writeNode(value: unknown, node: RepairNode, inOutput: boolean): unknown {
  const { repair, steps } = node;
  if (repair) return repair.kind === 'null_as_absent' ? value : repair.value;
  if (!steps || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    if (inOutput && ownsNonIndexKey(value)) return UNCOPIED;
    const copy = [...value];
    for (const step of steps) {
      // An element's step is the number `stepKey` keys it as; `"1.0"` or `"01"` names a property.
      if (typeof step === 'number' && Number.isInteger(step) && step >= 0 && step < copy.length) {
        const written = applyNode(value[step], childAt(node, step) as RepairNode, inOutput);
        if (written === UNCOPIED) return UNCOPIED;
        copy[step] = written;
      }
    }
    return copy;
  }

  let uncopied = false;
  const copy = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
      const child = childAt(node, stepKey(key));
      if (!child) return [[key, entry]];
      if (child.repair?.kind === 'null_as_absent') return [];
      const written = applyNode(entry, child, inOutput);
      if (written === UNCOPIED) uncopied = true;
      return [[key, written]];
    }),
  );
  return uncopied ? UNCOPIED : copy;
}

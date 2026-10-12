/**
 * @fileoverview The bounded projection of a `ZodError`'s issues that every
 * envelope carrying them is held to, whatever the caller sent: the tool
 * argument rejection's `data.issues` and `data.input`, on the wire (#648) and
 * in its log record (#631), and the `data.issues` of every other `ZodError` the
 * framework classifies (#710) — a resource `params` rejection, and one a tool
 * or resource handler throws, `ctx.state.get(key, schema)` included.
 * @module src/utils/internal/boundedProjection
 */

import { readField, UNREADABLE } from '@/utils/internal/error-handler/helpers.js';
import {
  capForObservability,
  OBSERVABILITY_MAX_STRING_LENGTH,
} from '@/utils/internal/observabilityCap.js';

/**
 * The most entries a bounded projection keeps, and the most issue lines an
 * argument rejection renders (#648, #631): entries of every array its `data`
 * carries, and own keys of every object. The caller sets every count and length
 * a rejection reports — how many issues, how many keys, how long a key — and an
 * author's refinement can copy the caller's value into a custom issue, so
 * neither the result nor its log record grows with them.
 */
export const REJECTION_ENTRIES = 10;

/**
 * The most issues `data.issues` keeps in all (#648), counted in document order
 * through every union's branches. A union's issue lists each branch's issues,
 * and Zod hands every branch that parsed the same value the same issues — a
 * recursive union's `and` and `or` branches both list the clause they share —
 * so the tree a caller's nesting raises doubles per level while its distinct
 * issues grow only with the nesting. A per-array cap alone leaves that tree
 * whole: no array in it is long.
 */
export const REJECTION_ISSUES = 30;

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
 * in its log record (#631), and as a classified `ZodError`'s `data` (#710):
 * `value` itself when nothing in it is past the caps, so data within them is
 * carried uncut, and otherwise its {@link cutToCaps} projection. `objects` is
 * the most objects its arrays keep in all — {@link REJECTION_ISSUES} for
 * `data.issues`, where every such object is an issue. `value` is an object the
 * framework builds, whose own few keys are never cut, so the records of its
 * own cut have no field to sit beside.
 *
 * Never throws: a field whose read throws (a getter, a `Proxy` trap) is
 * `'[Unreadable]'` in the projection, and so is an array or object that cannot
 * be inspected (a revoked `Proxy`), since an envelope holding either would fail
 * where it is serialized.
 */
export function boundedProjection(value: unknown, objects = Number.POSITIVE_INFINITY): unknown {
  let within: boolean;
  try {
    within = withinCaps(value, { left: objects });
  } catch {
    within = false;
  }
  return within ? value : cutToCaps(value, { left: objects }, 0).value;
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
  let cut: Cut;
  try {
    cut = Array.isArray(value)
      ? cutArray(value, budget, level)
      : cutObject(value as Record<string, unknown>, budget, level);
  } catch {
    return { value: UNREADABLE, records: UNCUT };
  }
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
    const cut = cutToCaps(readField(value, key), budget, level + 1);
    const records = cut.records.map(([suffix, record]): [string, unknown] => [
      `${name}${suffix}`,
      record,
    ]);
    if (length !== undefined) records.unshift([`${name}KeyLength`, length]);
    fields.push({ name, records, value: cut.value });
  }

  const recorded = new Set(fields.flatMap(({ records }) => records.map(([name]) => name)));
  // Built from entries, never by assignment: a caller's own `__proto__` key
  // — one JSON gives a wire body — is then a key of the copy, not its
  // prototype (#733).
  const entries: Array<[string, unknown]> = [];
  let kept = 0;
  for (const field of fields) {
    if (recorded.has(field.name)) continue;
    kept++;
    entries.push([field.name, field.value], ...field.records);
  }
  const bounded = Object.fromEntries(entries);
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

/**
 * @fileoverview Runtime shape checks for the Zod roots a tool definition may
 * declare, and the walk from a root down an argument path to the object that
 * path sits in, the field it names, or the value that field received. Zod 4
 * tags every schema with `_zod.def.type`, and a discriminated union tags as
 * `'union'` like any other — the discriminator on its `def` is what separates
 * the two. Kept in one place so the definition builder, the server manifest,
 * the linter, the argument-rejection hint, and the argument repair agree on
 * what a union root is and which schema and value a path names.
 *
 * An argument path names the value a schema received, which is not always one
 * the caller sent: below a `z.preprocess()` or a `.transform().pipe()`, Zod's
 * issue paths run through the transform's output (`items.0` for a lone object
 * the transform wrapped in a list). The walk re-applies such a transform
 * in-process and continues in the pipe's output schema, so every reader of a
 * path reads the value Zod reported on (#599).
 * @module src/mcp-server/tools/utils/schemaShape
 */

import type { ZodDiscriminatedUnion, ZodObject, ZodRawShape, ZodType } from 'zod';

/**
 * The Zod 4 definition fields the framework reads off a schema without going
 * through the class API: the `type` tag every schema carries, plus the
 * per-type payload (`shape`, `options`, `element`, …). Everything is optional
 * because the linter also sees partial and hostile objects.
 */
export interface ZodDef {
  checks?: unknown[];
  discriminator?: unknown;
  element?: unknown;
  entries?: Record<string, unknown>;
  innerType?: unknown;
  items?: unknown[];
  options?: unknown[];
  shape?: Record<string, unknown>;
  type?: string;
  values?: unknown[];
  valueType?: unknown;
}

/** Reads `_zod.def` from any value; `undefined` when it is not a Zod 4 schema. */
export function zodDef(value: unknown): ZodDef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return (value as { _zod?: { def?: ZodDef } })._zod?.def;
}

/** True when `value` is a `z.object()`. */
export function isZodObjectSchema(value: unknown): value is ZodObject<ZodRawShape> {
  return zodDef(value)?.type === 'object';
}

/**
 * True when `value` is a `z.discriminatedUnion()`.
 *
 * A plain `z.union()` also tags as `'union'` but carries no `discriminator`, so
 * the discriminator string is the distinguishing field. Only the discriminated
 * form is accepted as a tool input root: a bare union gives the model no key to
 * choose a branch by, and every variant's `required` list would apply at once.
 */
export function isDiscriminatedUnionSchema(
  value: unknown,
): value is ZodDiscriminatedUnion<readonly ZodObject<ZodRawShape>[]> {
  const def = zodDef(value);
  return def?.type === 'union' && typeof def.discriminator === 'string';
}

/**
 * The object variants of a tool input root: the union's options, or the single
 * object itself. Empty when the schema is neither — callers that lint or read
 * shapes then have nothing to walk rather than a partial view.
 */
export function inputVariants(schema: unknown): readonly ZodObject<ZodRawShape>[] {
  if (isDiscriminatedUnionSchema(schema)) {
    const options = (schema as { options?: unknown }).options;
    return Array.isArray(options)
      ? (options.filter(isZodObjectSchema) as ZodObject<ZodRawShape>[])
      : [];
  }
  return isZodObjectSchema(schema) ? [schema] : [];
}

/** The caller's value one step down, or `undefined` when nothing owns one there. */
export function stepInto(value: unknown, step: PropertyKey): unknown {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, step)
    ? (value as Record<PropertyKey, unknown>)[step]
    : undefined;
}

/** The Zod 4 definition fields {@link walkTo} reads beyond `ZodDef`'s. */
type WalkedDef = ZodDef & {
  catchall?: unknown;
  in?: unknown;
  left?: unknown;
  out?: unknown;
  rest?: unknown;
  right?: unknown;
};

/**
 * What re-applying a pipe's input side gave, per input side and then per value
 * it was applied to. One rejected call shares one cache across the repair, the
 * message, and the hint, so a transform runs once per value it is applied to,
 * however many issues sit below it (#599).
 */
export type TransformCache = Map<unknown, Map<unknown, Transformed>>;

/** What re-applying a pipe's input side to one value gave. */
type Transformed =
  | { readonly kind: 'output'; readonly output: unknown }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'threw' };

/** A transform {@link argumentAt} re-applied above the path it walked. */
export interface TransformSite {
  /** How many steps of the path reach the pipe. */
  readonly depth: number;
  /** What the transform made of the value there — the value the pipe's output schema received. */
  readonly output: unknown;
  /** The pipe's input side, which re-applies the transform. */
  readonly transform: ZodType;
}

/** What one argument path leads to, read beside the arguments (#599). */
export interface ArgumentAt {
  /**
   * False when re-applying a transform on the way threw. What the path names
   * is then unknown, and `value` and `received` are `undefined`.
   */
  readonly known: boolean;
  /**
   * The value the schema at the path received: `value`, or what a transform at
   * the path itself made of it. `undefined` when it received none.
   */
  readonly received: unknown;
  /**
   * What the caller sent for the value at the path: `value`, read in front of
   * a transform at the path itself. Below a transform above the path, an
   * `undefined` in its output may be the transform's own, so this is the
   * arguments as sent at the same path instead.
   */
  readonly sent: unknown;
  /** The transforms above the path, outermost first; `value` sits in the last one's output. */
  readonly sites: readonly TransformSite[];
  /** Whether a transform at the path itself made `received` of `value`. */
  readonly transformed: boolean;
  /** The value at the path: the caller's own, or what a transform above the path holds there. */
  readonly value: unknown;
}

/**
 * The `z.object()` an argument path sits in, found by walking the path down
 * from `schema` beside the caller's own `value` — or `undefined` when the path
 * does not land on exactly one object (#566).
 *
 * Wrappers (`optional`, `nullable`, `default`, …), `pipe`, and `z.lazy()` are
 * looked through. A pipe whose input side transforms — `z.preprocess()`, or
 * `.transform()` followed by `.pipe()` — is walked through its output schema,
 * beside what the transform makes of the value (#599). A numeric step enters
 * an array element or tuple item; a string step, a property, a record value,
 * or the value of a key an author's `.catchall()` types.
 * A discriminated union follows the variant the argument's own discriminator
 * selects, as Zod did. A plain union follows the one option under which the
 * rest of the path still lands on an object, an option whose single-valued
 * literal field refuses the argument's value there left out unless every
 * object option does ({@link unionCandidates}). Anything else, an
 * intersection or a union two options satisfy (one declaring the key, another
 * declaring or catching it), resolves to nothing.
 */
export function objectSchemaAt(
  schema: unknown,
  path: readonly PropertyKey[],
  value: unknown,
  transforms: TransformCache = new Map(),
): ZodObject<ZodRawShape> | undefined {
  return walkTo(schema, path, 0, value, transforms, (node) =>
    isZodObjectSchema(node) ? node : undefined,
  );
}

/**
 * Whether any schema an argument path can land on routes its value through a
 * transform ({@link routesThroughPipe}). Descends as {@link objectSchemaAt}
 * does, and a key no `z.object()` declares lands on the author's `.catchall()`
 * schema when one types it, so a pipe there counts as a declared field's
 * would; under `.strict()` or `.passthrough()` it lands on nothing. Where the
 * path resolves under several options of a plain union (one option declaring
 * the key and another declaring or catching it) or under both sides of an
 * intersection, every one is asked — and where a plain union's literal tags
 * refuse every object option, every option ({@link unionCandidates}). The
 * walk cannot tell which of them the parse read the value with, so a second
 * reading of the path never hides a transform.
 */
export function routesThroughPipeAt(
  schema: unknown,
  path: readonly PropertyKey[],
  value: unknown,
  transforms: TransformCache = new Map(),
): boolean {
  const piped = (node: unknown): true | undefined => routesThroughPipe(node) || undefined;
  return walkTo(schema, path, 0, value, transforms, piped, 'any') === true;
}

/**
 * The value an argument path names, walked down from `schema` beside the
 * caller's `value` (#599). Descends as {@link objectSchemaAt} does — through a
 * transforming pipe's output with the transform re-applied, an author catchall's
 * value included — and where the schema no longer says what the path names (a
 * key no object declares or types, an intersection, a union no single option
 * resolves), it reads on in the value alone, as Zod's own issue paths do.
 *
 * A transform whose input side rejects the value is walked through that input
 * side instead: the issue below it is the input side's own, about the value as
 * sent. One that throws when re-applied leaves the path unknown. A pipe the
 * path ends on is not run when the value is absent there — the caller left it
 * out, whatever the transform would have made of that.
 */
export function argumentAt(
  schema: unknown,
  path: readonly PropertyKey[],
  value: unknown,
  transforms: TransformCache = new Map(),
): ArgumentAt {
  // Only a walk trying one union option comes back unresolved; this one reads on in the value.
  const walks: Walks = new Map();
  const at = walkArgument(
    schema,
    path,
    0,
    value,
    undefined,
    false,
    transforms,
    walks,
  ) as WalkedArgument;
  const sent =
    at.transformed || at.sites.length === 0
      ? at.value
      : path.reduce<unknown>((current, step) => stepInto(current, step), value);
  return { ...at, sent };
}

/** What {@link walkArgument} reads: an {@link ArgumentAt} before {@link argumentAt} adds `sent`. */
type WalkedArgument = Omit<ArgumentAt, 'sent'>;

/** The transforms a walk has passed, innermost first — shared by the union options it tries. */
interface SiteList {
  readonly outer: SiteList | undefined;
  readonly site: TransformSite;
}

/** The sites of a {@link SiteList}, outermost first. */
function siteArray(list: SiteList | undefined): TransformSite[] {
  const sites: TransformSite[] = [];
  for (let entry = list; entry; entry = entry.outer) sites.push(entry.site);
  return sites.reverse();
}

/**
 * {@link argumentAt} from step `start` of `path`, below the transforms
 * `sites` names. `strict` is set while trying one option of a union: the walk
 * then comes back `undefined` wherever {@link walkTo} would — a step the
 * schema does not declare, a union no single option resolves, a transform that
 * throws above the path's end — and at a step taken from a value that is no
 * object or array, which that option cannot have parsed below, instead of
 * reading on in the value alone. A string beside a list option and an option
 * that splits it then resolves to the option that split it.
 *
 * At a union, each option is walked to the end of the path once, and the one
 * that resolves is the result. Picking the option with a walk to the end and
 * then walking the rest again would cost the square of the depth on a
 * recursive schema with a union at every level, and `walks` keeps what each
 * union resolved, so options that walk on into the same union below read it
 * once ({@link walkedAt}).
 */
function walkArgument(
  schema: unknown,
  path: readonly PropertyKey[],
  start: number,
  value: unknown,
  sites: SiteList | undefined,
  strict: boolean,
  transforms: TransformCache,
  walks: Walks,
): WalkedArgument | undefined {
  let node = schema;
  let current = value;
  let passed = sites;
  for (let index = start; ; index++) {
    const atPath = current;
    let transformed = false;
    for (let def = zodDef(node) as WalkedDef | undefined; def; def = zodDef(node)) {
      if (def.type === 'lazy') {
        node = lazyInner(node);
      } else if (def.type === 'pipe') {
        if (!transformsIn(def.in) || (index === path.length && current === undefined)) {
          node = def.in;
          continue;
        }
        const applied = transformedBy(def.in, current, transforms);
        if (applied.kind === 'threw') {
          if (strict && index < path.length) return undefined;
          return {
            known: false,
            received: undefined,
            sites: siteArray(passed),
            transformed: false,
            value: undefined,
          };
        }
        if (applied.kind === 'rejected') {
          node = def.in;
          continue;
        }
        if (index < path.length) {
          const site = { depth: index, output: applied.output, transform: def.in as ZodType };
          passed = { outer: passed, site };
        }
        transformed = true;
        current = applied.output;
        node = def.out;
      } else if (def.innerType !== undefined) {
        node = def.innerType;
      } else if (def.type === 'union' && index < path.length) {
        const through = unionThrough(def, path, index, current, passed, transforms, walks);
        if (through !== undefined || strict) return through;
        node = undefined;
      } else {
        break;
      }
    }
    if (index === path.length) {
      return {
        known: true,
        received: current,
        sites: siteArray(passed),
        transformed,
        value: atPath,
      };
    }
    const step = path[index] as PropertyKey;
    node = childAt(zodDef(node) as WalkedDef | undefined, step);
    if (strict && (zodDef(node) === undefined || current === null || typeof current !== 'object')) {
      return undefined;
    }
    current = stepInto(current, step);
  }
}

/**
 * Whether a field routes its value through a transform before the type the
 * field reports — a `.transform()`, `.pipe()`, or `z.preprocess()` on the field
 * itself, behind any wrapper or `z.lazy()`, or on one option of a union. Such a
 * field's rejection can describe the transform's output rather than the value
 * the caller sent. A pipe inside an array element or an object property is the
 * element's or property's own, not the field's.
 */
export function routesThroughPipe(schema: unknown): boolean {
  const seen = new Set<unknown>();
  const piped = (node: unknown): boolean => {
    const def = zodDef(node) as WalkedDef | undefined;
    if (!def || seen.has(node)) return false;
    seen.add(node);
    if (def.type === 'pipe') return true;
    if (def.type === 'lazy') return piped(lazyInner(node));
    if (def.innerType !== undefined) return piped(def.innerType);
    return def.type === 'union' && (def.options ?? []).some(piped);
  };
  return piped(schema);
}

/**
 * A `z.lazy()` schema's inner type. Zod resolves the getter once and caches
 * the result, so a walk reads the same schema the parse validated with instead
 * of building a new one per step, which on a recursive schema would cost a
 * schema per level per path.
 */
function lazyInner(schema: unknown): unknown {
  return (schema as { _zod: { innerType: unknown } })._zod.innerType;
}

/**
 * The walk behind {@link objectSchemaAt} and {@link routesThroughPipeAt}: from
 * `schema`, beside the caller's `value`, down `path` from `index`. `found`
 * decides the node the path ends at — it is offered each node there, outermost
 * first, and the walk looks through a wrapper, a `pipe`, or a `z.lazy()` only
 * while `found` declines. Indexing the path rather than slicing it keeps a walk
 * linear in its depth.
 *
 * `readings` decides a path several schemas resolve. Under `'one'` a plain
 * union resolves only when one of its {@link unionCandidates} does, and an
 * intersection never does. Under `'any'` the first candidate or side `found`
 * accepts is returned. Either way each union and intersection is walked once
 * per step and value, through `walks` ({@link walkedAt}).
 */
function walkTo<T>(
  schema: unknown,
  path: readonly PropertyKey[],
  index: number,
  value: unknown,
  transforms: TransformCache,
  found: (node: unknown) => T | undefined,
  readings: 'any' | 'one' = 'one',
  walks: Walks = new Map(),
): T | undefined {
  const def = zodDef(schema) as WalkedDef | undefined;
  if (!def) return undefined;
  if (index === path.length) {
    const node = found(schema);
    if (node !== undefined) return node;
  }
  const on = (next: unknown, nextIndex: number, nextValue: unknown) =>
    walkTo(next, path, nextIndex, nextValue, transforms, found, readings, walks);
  if (def.type === 'lazy') return on(lazyInner(schema), index, value);
  if (def.type === 'pipe') {
    if (!transformsIn(def.in)) return on(def.in, index, value);
    const applied = transformedBy(def.in, value, transforms);
    if (applied.kind === 'threw') return undefined;
    return applied.kind === 'output'
      ? on(def.out, index, applied.output)
      : on(def.in, index, value);
  }
  if (def.innerType !== undefined) return on(def.innerType, index, value);
  if (def.type === 'union' || (def.type === 'intersection' && readings === 'any')) {
    const walked = walkedAt(walks, [def, index]);
    if (walked.has(value)) return walked.get(value) as T | undefined;
    let result: T | undefined;
    if (def.type === 'union') {
      const resolved: T[] = [];
      for (const option of unionCandidates(def, value)) {
        const node = on(option, index, value);
        if (node !== undefined) resolved.push(node);
      }
      result =
        resolved.length === 1 || (readings === 'any' && resolved.length > 0)
          ? resolved[0]
          : undefined;
    } else {
      result = on(def.left, index, value) ?? on(def.right, index, value);
    }
    walked.set(value, result);
    return result;
  }
  if (index === path.length) return undefined;

  const step = path[index] as PropertyKey;
  return on(childAt(def, step), index + 1, stepInto(value, step));
}

/**
 * The schema one path step enters from a container, or `undefined` when it
 * declares none there. A key an object leaves undeclared enters its author's
 * `.catchall()`, the schema Zod parses that key's value with.
 */
function childAt(def: WalkedDef | undefined, step: PropertyKey): unknown {
  switch (def?.type) {
    case 'object':
      if (typeof step !== 'string') return undefined;
      return def.shape && Object.hasOwn(def.shape, step) ? def.shape[step] : typedCatchall(def);
    case 'record':
      return def.valueType;
    case 'array':
      return typeof step === 'number' ? def.element : undefined;
    case 'tuple':
      return typeof step === 'number' ? (def.items?.[step] ?? def.rest) : undefined;
    default:
      return undefined;
  }
}

/**
 * An object's catchall when it types its undeclared keys' values. `.strict()`
 * records a `never` catchall, whose keys fail as one `unrecognized_keys` issue
 * on the object itself, and `.passthrough()` an `unknown` one, which no value
 * fails — no issue sits below either, so neither is walked, and a plain
 * union's option open in either way never competes with one declaring the
 * key. A typed catchall does compete: a path one option declares and another
 * catches resolves under both.
 */
function typedCatchall(def: WalkedDef): unknown {
  const type = zodDef(def.catchall)?.type;
  return type === undefined || type === 'never' || type === 'unknown' || type === 'any'
    ? undefined
    : def.catchall;
}

/**
 * The options of a union a walk may follow for `value`: the variant a
 * discriminated union's own discriminator selects, as Zod did, or every option
 * of a plain union but one whose single-valued literal field — a tag like
 * `kind: z.literal('a')` — refuses the value there. Zod reports such an option
 * as that literal's failure alone, which the rejection drops (#417), so the
 * walk does not follow it either (#570).
 *
 * When the tags leave no object option, every option is followed. The branch
 * a rejection kept can refuse its own tag too — `"c"` where no branch takes
 * it, `"1"` for `z.literal(1)`, a one-value enum left out — and a walk that
 * found no branch would read its values off the arguments alone: a value a
 * `z.preprocess()` there wrapped in a list would read as absent, a `null`
 * there would never read as an optional key, and the string-repair gate would
 * miss a field that routes through a transform.
 */
function unionCandidates(def: WalkedDef, value: unknown): readonly unknown[] {
  const options = def.options ?? [];
  const { discriminator } = def;
  if (typeof discriminator !== 'string') {
    const tagged = options.filter((option) => !refusesTag(option, value));
    return tagged.some(isZodObjectSchema) ? tagged : options;
  }
  const tag = stepInto(value, discriminator);
  const selected = options.find((option) => {
    const field = isZodObjectSchema(option) ? option.shape[discriminator] : undefined;
    return (field as ZodType | undefined)?.safeParse(tag).success === true;
  });
  return selected === undefined ? [] : [selected];
}

/** Whether an object option has a single-valued literal field that refuses `value`'s own field. */
function refusesTag(option: unknown, value: unknown): boolean {
  const shape = isZodObjectSchema(option) ? zodDef(option)?.shape : undefined;
  if (!shape) return false;
  return Object.entries(shape).some(([key, field]) => {
    const def = zodDef(field);
    const singleValued =
      def?.type === 'literal'
        ? def.values?.length === 1
        : def?.type === 'enum' && Object.keys(def.entries ?? {}).length === 1;
    return singleValued && !(field as ZodType).safeParse(stepInto(value, key)).success;
  });
}

/**
 * What {@link argumentAt} reads at the end of the path through the one union
 * candidate the rest of the path resolves under, or `undefined` when none or
 * several do.
 */
function unionThrough(
  def: WalkedDef,
  path: readonly PropertyKey[],
  index: number,
  value: unknown,
  sites: SiteList | undefined,
  transforms: TransformCache,
  walks: Walks,
): WalkedArgument | undefined {
  const walked = walkedAt(walks, [def, index, sites]);
  if (walked.has(value)) return walked.get(value) as WalkedArgument | undefined;
  let only: WalkedArgument | undefined;
  for (const option of unionCandidates(def, value)) {
    const at = walkArgument(option, path, index, value, sites, true, transforms, walks);
    if (at === undefined) continue;
    if (only !== undefined) {
      only = undefined;
      break;
    }
    only = at;
  }
  walked.set(value, only);
  return only;
}

/**
 * What one walk resolved at each union, or intersection, it reached — keyed by
 * that node and everything the rest of the walk reads: the path step, the
 * value beside it, and, for {@link argumentAt}, the transforms passed. Each
 * option of a plain union can walk on into the same union a level down, at the
 * same step and beside the same value, so a recursive schema whose options
 * share a key would otherwise re-walk the rest of the path once per option per
 * level, a walk that doubles per level. One map per walk, so the path is fixed.
 */
type Walks = Map<unknown, unknown>;

/**
 * The map of `walks` that holds, by value, what the walk resolved at `keys`
 * (#648) — created on first use. Looked up before a node is walked and
 * written after, so a walk keeps the depth of call stack it had without it.
 */
function walkedAt(walks: Walks, keys: readonly unknown[]): Map<unknown, unknown> {
  let level = walks;
  for (const key of keys) {
    let next = level.get(key) as Walks | undefined;
    if (next === undefined) {
      next = new Map();
      level.set(key, next);
    }
    level = next;
  }
  return level;
}

/**
 * Whether a pipe's input side transforms the value its output schema
 * receives: `z.preprocess()`'s input side is the transform itself, and
 * `.transform(f).pipe(B)`'s is a pipe ending in one. Any other pipe — `.pipe()`
 * after a plain schema, or a bare `.transform()`, whose input side is the
 * schema it transforms — is walked through its input side, whose issues name
 * the value as sent.
 */
function transformsIn(schema: unknown): boolean {
  const def = zodDef(schema) as WalkedDef | undefined;
  return def?.type === 'transform' || (def?.type === 'pipe' && transformsIn(def.out));
}

/**
 * A pipe's input side re-applied to `value`, once per value per
 * {@link TransformCache}. The author's transform may throw — on a value only
 * the walk feeds it, or on a second run — and that is recorded rather than
 * thrown, so reading a rejection's paths never turns it into a crash.
 */
function transformedBy(input: unknown, value: unknown, transforms: TransformCache): Transformed {
  let byValue = transforms.get(input);
  if (byValue === undefined) {
    byValue = new Map();
    transforms.set(input, byValue);
  }
  let applied = byValue.get(value);
  if (applied === undefined) {
    try {
      const parsed = (input as ZodType).safeParse(value);
      applied = parsed.success ? { kind: 'output', output: parsed.data } : { kind: 'rejected' };
    } catch {
      applied = { kind: 'threw' };
    }
    byValue.set(value, applied);
  }
  return applied;
}

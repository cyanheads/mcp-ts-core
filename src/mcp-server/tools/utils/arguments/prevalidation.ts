/**
 * @fileoverview The pre-parse stages of tool argument handling — drop
 * client-added root keys (#453) and rewrite key aliases (#452) — run drop-first,
 * or alias-first for the retry (#563), each attempt carrying what it changed
 * for the parse to report or record. Emits nothing itself.
 * @module src/mcp-server/tools/utils/arguments/prevalidation
 */

import type { ZodObject, ZodRawShape, ZodType } from 'zod';

import { scanHeaderDesignations } from '../headerParam.js';
import { inputVariants, isDiscriminatedUnionSchema, zodDef } from '../schemaShape.js';
import type { AnyToolDefinition, ToolInputSchema } from '../toolDefinition.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Server-level switches for the pre-validation step, set once via
 * `createApp({ input })`. Every stage is on with no configuration; an entry
 * here either extends a stage or turns it off for the whole server. There is no
 * per-tool switch — a definition's only say is the `inputAliases` it declares.
 */
export interface InputHandlingOptions {
  /**
   * Rewrite an undeclared root key whose case-folded form (`-`/`_` stripped,
   * lowercased) matches exactly one declared key. `false` leaves declared
   * `inputAliases` working and restores rejection for undeclared variants.
   * Default `true`.
   */
  caseStyleAliases?: boolean;
  /**
   * Retry a failed parse once against repaired argument *values* — a
   * JSON-stringified array or object parsed back into what it encodes, a safe
   * integer sent where a string was expected turned into its decimal string, a
   * string sent where only numbers or booleans are accepted turned into the
   * one it spells (`"15"`, `"true"`), a lone string sent where an array was
   * expected wrapped as its only element, and `null` sent for an optional
   * field deleted so the field reads as unset. `false` turns the repair off,
   * so each order of the key stages is parsed once, with the values as sent.
   * Default `true`.
   */
  coerce?: boolean;
  /**
   * Additional root keys to drop when the tool does not declare them, on top of
   * the built-in client artifacts (`_meta`, `tool_call_description`,
   * `toolCallId`). `false` disables the stage, so every undeclared key is
   * rejected by name as it was before. Default: the built-in list only.
   */
  ignoreKeys?: readonly string[] | false;
}

/**
 * Root keys known to be added by a client rather than written by the model, so
 * rejecting them fails a call whose arguments were all correct. `_meta` belongs
 * on `params`, not inside `arguments`; the other two are call bookkeeping.
 */
const BUILT_IN_IGNORED_KEYS: readonly string[] = ['_meta', 'tool_call_description', 'toolCallId'];

/**
 * What the ignored-key counter reports for a key the underscore heuristic
 * dropped. The key itself is caller-supplied and stays in the debug log.
 */
const UNDERSCORE_RULE = 'underscore_prefix';

/** Which half of the alias stage rewrote a key. */
export type AliasKind = 'case_style' | 'declared';

/**
 * What the pre-parse stages changed that the caller wrote, reported on an
 * argument rejection (#468) so a caller can tell a bad value from a key that
 * was moved or discarded. Keys only, never values.
 */
interface PrevalidationReport {
  /** Root keys rewritten to their canonical spelling, in argument order. */
  readonly aliased: ReadonlyArray<{ readonly alias: string; readonly target: string }>;
  /**
   * Undeclared underscore-prefixed root keys the drop stage discarded, in
   * argument order. An ignore-list drop is never listed: it is a client
   * artifact the model did not write and cannot remove.
   */
  readonly ignored: readonly string[];
}

/**
 * One key a pre-parse stage rewrote or dropped, as {@link recordPrevalidation}
 * counts and logs it. `rule` is the ignore-list entry that matched, or
 * {@link UNDERSCORE_RULE}.
 */
export type PrevalidationChange =
  | {
      readonly alias: string;
      readonly aliasKind: AliasKind;
      readonly kind: 'aliased';
      readonly target: string;
    }
  | { readonly key: string; readonly kind: 'dropped'; readonly rule: string };

/**
 * A declared key the caller sent together with an alias of it (#639). The
 * alias stage leaves an alias in place when its target is already present, so
 * the strict root rejects it as an unknown key, or the drop discards it as an
 * undeclared underscore key — and naming it that way would send the caller
 * looking for a typo when the problem is that two names for one field arrived.
 */
export interface AliasCollision {
  /** The aliases left in place because `target` was already present, in argument order. */
  readonly declined: readonly string[];
  /**
   * Every key the caller sent for `target`, in argument order: the key itself,
   * the aliases rewritten to it, and the declined ones.
   */
  readonly keys: readonly string[];
  /** The declared key. */
  readonly target: string;
}

/** One ordering of the pre-parse stages — what {@link prevalidateToolArguments} hands the parse. */
export interface PrevalidatedArguments {
  /** The arguments to parse — the caller's own object when nothing applied. */
  readonly args: unknown;
  /**
   * Every rewrite and drop, in the order the stages made them. Nothing is
   * emitted while the stages run: the parse decides which attempt the handler
   * receives, and {@link recordPrevalidation} emits that one.
   */
  readonly changes: readonly PrevalidationChange[];
  /**
   * The aliases the alias stage declined because their target was already
   * present, grouped by target, or `undefined` when it declined none. Worked
   * out only when called: a rejection's hint is the one reader, so a call that
   * validates never pays for it. Kept off `report`, which records what the
   * stages changed: a rejection's hint names these keys, and `data.input` never
   * does.
   */
  readonly collisions?: () => readonly AliasCollision[] | undefined;
  /** Present only when a rewrite or an underscore-rule drop happened. */
  readonly report?: PrevalidationReport;
}

// ---------------------------------------------------------------------------
// Per-schema plan
// ---------------------------------------------------------------------------

/** What one object root — or one variant of a union root — accepts. */
interface VariantPlan {
  /** Case-folded key → the single declared key it names, or `null` when two do. */
  readonly folded: ReadonlyMap<string, string | null>;
  readonly keys: ReadonlySet<string>;
  /** The author declared `.passthrough()` / `.catchall(...)`, so extra keys are data. */
  readonly open: boolean;
}

/** Everything the step needs about a definition's `input`, derived once. */
interface InputPlan {
  /** Every variant's root keys. The drop stage's "declared" set — see {@link dropIgnoredKeys}. */
  readonly allKeys: ReadonlySet<string>;
  /** Any variant left open by its author. */
  readonly anyOpen: boolean;
  readonly discriminator: string | undefined;
  /** Root properties designated `x-mcp-header`; never a rewrite target. */
  readonly headerTargets: ReadonlySet<string>;
  /** Some declared key is underscore-prefixed, which switches the underscore rule off. */
  readonly underscoreDeclared: boolean;
  readonly variants: ReadonlyArray<{ plan: VariantPlan; schema: ZodObject<ZodRawShape> }>;
}

const plans = new WeakMap<object, InputPlan>();

/**
 * `Max-Results`, `max_results`, and `maxResults` all fold to `maxresults`.
 *
 * Exported so `lint:mcp` decides alias ambiguity by the same fold the rewrite
 * uses — a rule computing its own would pass a definition the runtime declines
 * to rewrite, or fail one it rewrites happily.
 */
export function foldArgumentKey(key: string): string {
  return key.replaceAll(/[-_]/g, '').toLowerCase();
}

/**
 * True when the author opened the object themselves. `.strict()` also records a
 * catchall — a `ZodNever` one — so the type of the catchall, not its presence,
 * is what separates an open root from a strict one.
 */
function isOpenObject(schema: ZodObject<ZodRawShape>): boolean {
  const catchall = schema.def.catchall;
  return catchall !== undefined && zodDef(catchall)?.type !== 'never';
}

function buildVariantPlan(schema: ZodObject<ZodRawShape>): VariantPlan {
  const keys = new Set(Object.keys(schema.shape));
  const folded = new Map<string, string | null>();
  for (const key of keys) {
    const fold = foldArgumentKey(key);
    folded.set(fold, folded.has(fold) ? null : key);
  }
  return { folded, keys, open: isOpenObject(schema) };
}

/**
 * Derives the plan for a definition's input root, memoized on the root schema —
 * the header scan emits JSON Schema, which is far too much work to repeat per
 * call.
 */
function planFor(input: ToolInputSchema): InputPlan {
  const cached = plans.get(input);
  if (cached) return cached;

  const variants = inputVariants(input).map((schema) => ({
    plan: buildVariantPlan(schema),
    schema,
  }));
  const allKeys = new Set<string>();
  for (const variant of variants) for (const key of variant.plan.keys) allKeys.add(key);

  // A union root can carry no valid designation at all (every field sits under
  // `oneOf`), and an invalid one already failed in `tool()`, so this only ever
  // collects root properties of an object root.
  const scan = scanHeaderDesignations(input);
  const headerTargets = new Set<string>(
    scan?.valid
      ? scan.designations.flatMap(({ path }) => {
          const step = path.length === 1 ? path[0] : undefined;
          return step?.kind === 'property' ? [step.key] : [];
        })
      : [],
  );

  const discriminator = isDiscriminatedUnionSchema(input)
    ? (zodDef(input)?.discriminator as string | undefined)
    : undefined;

  const plan: InputPlan = {
    allKeys,
    anyOpen: variants.some((variant) => variant.plan.open),
    discriminator,
    headerTargets,
    underscoreDeclared: [...allKeys].some((key) => key.startsWith('_')),
    variants,
  };
  plans.set(input, plan);
  return plan;
}

/**
 * The variant the arguments select, or `undefined` when nothing selects one.
 *
 * An object root has exactly one. A union root has no single declared-key set
 * until the discriminator is read, and a call whose discriminator is absent or
 * unrecognized fails on the discriminator either way — so the rewrite stage
 * declines rather than guessing a branch.
 */
function selectVariant(plan: InputPlan, args: Record<string, unknown>): VariantPlan | undefined {
  if (plan.discriminator === undefined) return plan.variants[0]?.plan;
  if (!Object.hasOwn(args, plan.discriminator)) return undefined;
  const value = args[plan.discriminator];
  for (const variant of plan.variants) {
    const field = variant.schema.shape[plan.discriminator] as ZodType | undefined;
    if (field?.safeParse(value).success) return variant.plan;
  }
  return undefined;
}

/**
 * The keys the drop stage discards whenever the tool does not declare them: the
 * built-in client artifacts plus the server's own `input.ignoreKeys`. Empty
 * when the stage is off, since nothing is then treated as a client artifact.
 */
function ignoreListFor(options: InputHandlingOptions | undefined): ReadonlySet<string> {
  if (options?.ignoreKeys === false) return new Set();
  return new Set([...BUILT_IN_IGNORED_KEYS, ...(options?.ignoreKeys ?? [])]);
}

// ---------------------------------------------------------------------------
// Stage — key aliases (#452)
// ---------------------------------------------------------------------------

/**
 * Rewrites root keys to their canonical spelling in two passes: the definition's
 * declared `inputAliases`, then — unless `caseStyleAliases: false` — any
 * undeclared key whose case-folded form names exactly one declared key.
 *
 * A rewrite applies only when the target key is absent. With both present the
 * arguments pass through and the strict rejection fires, and the alias is
 * recorded as declined so the rejection can name it as an alias rather than an
 * unknown key (#639). An author-opened root is never rewritten (an unknown key
 * there is already accepted verbatim), and a `headerParam`-designated target
 * is never rewritten *to*: the SDK cross-checks the `Mcp-Param-<Name>` header
 * against the raw body before dispatch, so a later rewrite would hand the
 * handler a value no intermediary attested.
 *
 * `unfolded` names keys the case-style pass never folds. The alias-first retry
 * passes the ignore list, since there the drop has not yet removed a client
 * artifact: `_meta` stays the client's, whatever a tool declares as `meta`. A
 * declared alias still fires for one — naming it is the author's call, as
 * declaring the key itself is (#563).
 *
 * Returns the rewrites in the order they were made, and again in argument order
 * for the rejection report, with each declined alias mapped to its target.
 * `heldTarget` reads the same rules for a key that never reached this stage —
 * an underscore-rule drop of the drop-first order — and names the target the
 * key stands for when the arguments already hold it: such a key is an alias
 * sent beside its target, which the alias-first order would decline. It runs
 * only when a rejection asks ({@link collisionsIn}), since folding every key a
 * call carries that the drop discarded costs each one's length.
 */
function applyAliases(
  def: AnyToolDefinition,
  args: Record<string, unknown>,
  plan: InputPlan,
  options: InputHandlingOptions | undefined,
  unfolded: ReadonlySet<string>,
): AliasRewrite {
  const changes: PrevalidationChange[] = [];
  const declared = def.inputAliases;
  const caseStyle = options?.caseStyleAliases !== false;
  const variant = plan.anyOpen || (!declared && !caseStyle) ? undefined : selectVariant(plan, args);
  if (!variant) {
    return { args, aliased: [], changes, declined: NO_DECLINES, heldTarget: NO_TARGET };
  }

  let rewritten: Record<string, unknown> | undefined;
  const current = (): Record<string, unknown> => rewritten ?? args;
  const moved = new Map<string, string>();
  let declined: Map<string, string> | undefined;

  const reaches = (alias: string, target: string): boolean =>
    !variant.keys.has(alias) && variant.keys.has(target) && !plan.headerTargets.has(target);

  const decline = (alias: string, target: string): void => {
    declined ??= new Map();
    if (!declined.has(alias)) declined.set(alias, target);
  };

  const move = (alias: string, target: string, kind: AliasKind): void => {
    // `target` is a declared key read off the Zod shape, never caller text — an
    // object literal resolves `__proto__` to the prototype setter rather than a
    // key, so a shape cannot declare one and this assignment cannot reach it.
    // `alias` is caller text, but it is only read and deleted, both own-property
    // operations. The spread defines rather than assigns, so an own `__proto__`
    // elsewhere in the arguments survives the copy.
    rewritten ??= { ...args };
    rewritten[target] = rewritten[alias];
    delete rewritten[alias];
    moved.set(alias, target);
    declined?.delete(alias);
    changes.push({ kind: 'aliased', alias, target, aliasKind: kind });
  };

  const resolve = (alias: string, target: string, kind: AliasKind): void => {
    if (!Object.hasOwn(current(), alias) || !reaches(alias, target)) return;
    if (Object.hasOwn(current(), target)) decline(alias, target);
    else move(alias, target, kind);
  };

  for (const [alias, target] of Object.entries(declared ?? {})) resolve(alias, target, 'declared');

  if (caseStyle) {
    // Snapshot first: `move` only ever removes an undeclared key and adds a
    // declared one, so the remaining candidates are unaffected.
    for (const key of Object.keys(current())) {
      if (variant.keys.has(key) || unfolded.has(key)) continue;
      const target = variant.folded.get(foldArgumentKey(key));
      if (target) resolve(key, target, 'case_style');
    }
  }

  const heldTarget = (key: string): string | undefined => {
    // The alias-first order tries a declared alias first, then the case fold.
    const named = declared && Object.hasOwn(declared, key) ? declared[key] : undefined;
    const target =
      named !== undefined && reaches(key, named)
        ? named
        : (caseStyle && variant.folded.get(foldArgumentKey(key))) || undefined;
    return target !== undefined && reaches(key, target) && Object.hasOwn(current(), target)
      ? target
      : undefined;
  };

  const aliased = Object.keys(args).flatMap((alias) => {
    const target = moved.get(alias);
    return target === undefined ? [] : [{ alias, target }];
  });
  return {
    args: rewritten ?? args,
    aliased,
    changes,
    declined: declined ?? NO_DECLINES,
    heldTarget,
  };
}

/** What {@link applyAliases} did to one attempt's arguments. */
interface AliasRewrite {
  aliased: PrevalidationReport['aliased'];
  args: Record<string, unknown>;
  changes: PrevalidationChange[];
  /** Each alias left in place because its target was present, mapped to that target. */
  declined: ReadonlyMap<string, string>;
  /** The target a key the stage never saw stands for, when the arguments hold it. */
  heldTarget: (key: string) => string | undefined;
}

/** No alias declined. */
const NO_DECLINES: ReadonlyMap<string, string> = new Map();

/** No key stands for a target. */
const NO_TARGET = (): undefined => undefined;

/**
 * Groups an attempt's declined aliases by target, each with every key the
 * caller sent for that target in argument order — `undefined` when none was
 * declined. `args` is the caller's own object, so a key the drop discarded
 * keeps its place. `dropped` are the underscore-rule drops that ran before the
 * alias stage, each declined when it stands for a target the arguments hold.
 */
function collisionsIn(
  args: Record<string, unknown>,
  rewrite: AliasRewrite,
  dropped: readonly string[],
): readonly AliasCollision[] | undefined {
  const { aliased, heldTarget } = rewrite;
  const declined = new Map(rewrite.declined);
  for (const key of dropped) {
    const target = heldTarget(key);
    if (target !== undefined) declined.set(key, target);
  }
  if (declined.size === 0) return;
  const moved = new Map(aliased.map(({ alias, target }) => [alias, target]));
  const byTarget = new Map<string, { declined: string[]; keys: string[] }>();
  for (const target of declined.values()) byTarget.set(target, { declined: [], keys: [] });
  for (const key of Object.keys(args)) {
    const collision = byTarget.get(declined.get(key) ?? moved.get(key) ?? key);
    if (!collision) continue;
    collision.keys.push(key);
    if (declined.has(key)) collision.declined.push(key);
  }
  return [...byTarget].map(([target, collision]) => ({ ...collision, target }));
}

// ---------------------------------------------------------------------------
// Stage — drop client-added keys (#453)
// ---------------------------------------------------------------------------

/**
 * Drops a root key the tool does not declare when it is either underscore-
 * prefixed or on the ignore list. Three boundaries:
 *
 * - **A declared key is never dropped**, including a declared underscore-prefixed
 *   one. On a union root "declared" is every variant's root keys, since the
 *   matching variant is unknown until the discriminator is read.
 * - **An author-opened root is untouched** — its extra keys reach the handler
 *   today, and dropping them would delete data the author accepts on purpose.
 * - **The underscore rule is off for a tool declaring any underscore-prefixed
 *   key.** Otherwise a misspelled `_cursor` would be silently dropped instead of
 *   rejected by name, which is the failure #232 removed. The ignore list still
 *   applies there.
 *
 * A key the alias stage would have rewritten is dropped here like any other on
 * the first attempt; the alias-first retry is what reaches it (#563).
 *
 * Returns every drop in argument order, and the underscore-rule drops again for
 * the rejection report — an ignore-list drop is a client artifact and is never
 * reported.
 */
function dropIgnoredKeys(
  args: Record<string, unknown>,
  plan: InputPlan,
  options: InputHandlingOptions | undefined,
  ignoreList: ReadonlySet<string>,
): { args: Record<string, unknown>; changes: PrevalidationChange[]; ignored: string[] } {
  const changes: PrevalidationChange[] = [];
  const ignored: string[] = [];
  if (options?.ignoreKeys === false || plan.anyOpen) return { args, changes, ignored };

  const underscoreRule = !plan.underscoreDeclared;

  let kept: Record<string, unknown> | undefined;
  for (const key of Object.keys(args)) {
    if (plan.allKeys.has(key)) continue;
    const listed = ignoreList.has(key);
    if (!listed && !(underscoreRule && key.startsWith('_'))) continue;
    // Spread copies own properties by definition, so a caller's own `__proto__`
    // survives as a key instead of re-prototyping the copy; `delete` on that own
    // property is equally safe.
    kept ??= { ...args };
    delete kept[key];
    if (!listed) ignored.push(key);
    changes.push({ kind: 'dropped', key, rule: listed ? key : UNDERSCORE_RULE });
  }
  return { args: kept ?? args, changes, ignored };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** No key the case-style pass declines to fold. */
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Runs both pre-parse stages in one order and collects what they changed.
 * Emits nothing: the parse has not yet decided which attempt the handler
 * receives.
 */
function runStages(
  def: AnyToolDefinition,
  args: unknown,
  options: InputHandlingOptions | undefined,
  order: 'alias-first' | 'drop-first',
): PrevalidatedArguments {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { args, changes: [] };
  }

  const plan = planFor(def.input);
  if (plan.variants.length === 0) return { args, changes: [] };

  const record = args as Record<string, unknown>;
  if (namesOnlyDeclaredKeys(plan, record)) return { args, changes: NO_CHANGES };
  const ignoreList = ignoreListFor(options);

  if (order === 'drop-first') {
    // The drop has already removed every undeclared ignore-listed key, so the
    // case-style pass folds whatever is left, exactly as it always has.
    const drop = dropIgnoredKeys(record, plan, options, ignoreList);
    const rewrite = applyAliases(def, drop.args, plan, options, NO_KEYS);
    const changes = [...drop.changes, ...rewrite.changes];
    return attempt(rewrite.args, changes, rewrite.aliased, drop.ignored, () =>
      collisionsIn(record, rewrite, drop.ignored),
    );
  }
  const rewrite = applyAliases(def, record, plan, options, ignoreList);
  const drop = dropIgnoredKeys(rewrite.args, plan, options, ignoreList);
  const changes = [...rewrite.changes, ...drop.changes];
  return attempt(drop.args, changes, rewrite.aliased, drop.ignored, () =>
    collisionsIn(record, rewrite, []),
  );
}

/** No key rewritten or dropped. */
const NO_CHANGES: readonly PrevalidationChange[] = [];

/**
 * Whether every key of `args` is one the variant they select declares — the
 * shape of nearly every call. Neither stage then has anything to do: the drop
 * skips a declared key, and an alias, declared or case-style, is a key the
 * variant does not declare. Checked first, so such a call allocates nothing
 * here and runs neither stage.
 */
function namesOnlyDeclaredKeys(plan: InputPlan, args: Record<string, unknown>): boolean {
  const variant = plan.variants.length === 1 ? plan.variants[0]?.plan : selectVariant(plan, args);
  if (!variant) return false;
  for (const key in args) {
    if (!variant.keys.has(key)) return false;
  }
  return true;
}

/** One attempt, carrying a report only when a rewrite or an underscore-rule drop happened. */
function attempt(
  args: Record<string, unknown>,
  changes: readonly PrevalidationChange[],
  aliased: PrevalidationReport['aliased'],
  ignored: PrevalidationReport['ignored'],
  collisions: () => readonly AliasCollision[] | undefined,
): PrevalidatedArguments {
  return aliased.length === 0 && ignored.length === 0
    ? { args, changes, collisions }
    : { args, changes, collisions, report: { aliased, ignored } };
}

/**
 * Runs the pre-parse half of the step in its first order — drop client-added
 * keys, then rewrite key aliases — and returns the arguments to parse, with
 * what the two stages changed that the caller wrote.
 *
 * `args` is the caller's own object when nothing applied. Non-object arguments
 * are handed straight back: the schema's own rejection already says what
 * arrived.
 */
export function prevalidateToolArguments(
  def: AnyToolDefinition,
  args: unknown,
  options: InputHandlingOptions | undefined,
): PrevalidatedArguments {
  return runStages(def, args, options, 'drop-first');
}

/**
 * The retry for a call whose first attempt failed (#563): the same stages with
 * the alias stage first, so a key the drop discarded — an underscore spelling
 * of a declared key, a declared `_q` alias, an ignore-listed key a declared
 * alias names — reaches the rewrite. An underscore-prefixed key the alias stage
 * cannot resolve is still dropped after it.
 *
 * `undefined` when there is nothing to retry: the first attempt dropped no key,
 * or this order hands the parse the same arguments, which would only repeat
 * the first attempt's failure.
 */
export function prevalidateAliasFirst(
  def: AnyToolDefinition,
  args: unknown,
  first: PrevalidatedArguments,
  options: InputHandlingOptions | undefined,
): PrevalidatedArguments | undefined {
  if (!first.changes.some((change) => change.kind === 'dropped')) return undefined;
  const retry = runStages(def, args, options, 'alias-first');
  // A drop means the arguments were an object, and both orders hand back one.
  const same = sameArguments(
    retry.args as Record<string, unknown>,
    first.args as Record<string, unknown>,
  );
  return same ? undefined : retry;
}

/**
 * Whether two orderings of the stages produced the same arguments. Both only
 * move and delete keys of one caller object, never touching a value, so the
 * same key set holding the same values is the same parse.
 */
function sameArguments(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && Object.is(a[key], b[key]))
  );
}

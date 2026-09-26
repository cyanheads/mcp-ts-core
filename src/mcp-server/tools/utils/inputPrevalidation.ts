/**
 * @fileoverview The ordered step raw `tools/call` arguments pass through before
 * — and, for one stage, after — the `input` schema parses them.
 *
 * Strict inputs (#232) reject an unrecognized root key by name, which is right
 * for a misspelling the caller can fix and wrong for the three cases collected
 * here, where the arguments the model wrote are correct and something between
 * the model and the schema is not:
 *
 * 1. **Client-added keys (#453)** — a placeholder, a call description, a call
 *    id, or an `arguments`-level `_meta` block the model never wrote and cannot
 *    remove. Dropped before parsing.
 * 2. **Key aliases (#452)** — a declared `inputAliases` entry, or the same name
 *    in another case style (`max_results` for `maxResults`). Rewritten to the
 *    canonical key before parsing. A one-to-one mapping fixed ahead of time, not
 *    the nearest-key guess #232 rejected.
 * 3. **Representation repair (#234, #479, #487)** — a JSON-stringified array or
 *    object where one was declared, or an integer where a string was. Applied
 *    only *after* the parse has already failed, and kept only when it flips the
 *    arguments from invalid to valid: the author's schema is the sole arbiter,
 *    so a repair can never touch input that was already valid.
 *
 * The drop runs first, so it also discards a key the alias stage would have
 * resolved: an underscore spelling of a declared key (`_query`), a declared
 * `_q` alias, an ignore-listed key a declared alias names. When the arguments
 * then fail, repair included, the two stages run once more with the alias
 * stage first, and that retry — with its own repair — is kept only if it
 * validates (#563). A call the first order validates never reaches the retry,
 * so the retry never changes which calls validate. A call neither order
 * validates carries the retry's rejection, where the discarded keys reached
 * their targets: a declared `_q` alias with a bad value is reported as
 * validated under `query`, with the value's own failure, not as a dropped key
 * beside a missing field.
 *
 * All three are on by default and each has a server-level switch on
 * `createApp({ input })` / `createWorkerHandler({ input })`. None of them
 * changes what `tools/list` advertises. A call they rescue carries nothing
 * about them in its response: a drop, a rewrite, and a repair each emit one
 * debug log and one counter increment instead — for the attempt whose
 * arguments the handler receives, never one the parse discarded. A call they
 * cannot rescue is rejected with the rewrites and underscore-rule drops of the
 * attempt whose rejection it carries reported (#468), since without them the caller cannot
 * tell a bad value from a key that was moved or discarded; a repair the
 * re-parse discarded leaves no trace there.
 *
 * The split between log and counter is deliberate. Counter attributes are
 * bounded and author- or framework-defined — the ignore-list entry that
 * matched, the declared key a rewrite resolved to — because a metric label
 * carrying the caller's own key text mints a permanent time series per spelling
 * a client invents (#114). The raw key and alias go to the debug log, which is
 * where an operator looks when a counter shows a new client artifact and where
 * cardinality costs nothing — and, on a rejection, back to the caller who sent
 * them, since an error payload is per call rather than a permanent series.
 *
 * @module src/mcp-server/tools/utils/inputPrevalidation
 */

import type { Counter } from '@opentelemetry/api';
import type { ZodError, ZodObject, ZodRawShape, ZodType } from 'zod';

import { logger } from '@/utils/internal/logger.js';
import {
  type RequestContext,
  requestContextService,
  withExtra,
} from '@/utils/internal/requestContext.js';
import {
  ATTR_MCP_INPUT_ALIAS_KIND,
  ATTR_MCP_INPUT_COERCION,
  ATTR_MCP_INPUT_IGNORE_RULE,
  ATTR_MCP_INPUT_TARGET,
  ATTR_MCP_TOOL_NAME,
} from '@/utils/telemetry/attributes.js';
import { createCounter } from '@/utils/telemetry/metrics.js';
import { scanHeaderDesignations } from './headerParam.js';
import { inputVariants, isDiscriminatedUnionSchema, zodDef } from './schemaShape.js';
import type { AnyToolDefinition, ToolInputSchema } from './toolDefinition.js';

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
   * JSON-stringified array or object parsed back into what it encodes, or a
   * safe integer sent where a string was expected turned into its decimal
   * string. `false` turns the repair off, so each order of the key stages is
   * parsed once, with the values as sent. Default `true`.
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
 * The repairs {@link repairRepresentations} performs, as `mcp.input.coercion`
 * labels them, in the order a call's debug log names them — paired with how
 * that log reads each one.
 */
const COERCION_KINDS = {
  stringified_array: 'a stringified array',
  stringified_object: 'a stringified object',
  integer_as_string: 'an integer sent for a string',
} as const;

/** One repair {@link repairRepresentations} can perform. */
export type CoercionKind = keyof typeof COERCION_KINDS;

/**
 * What the ignored-key counter reports for a key the underscore heuristic
 * dropped. The key itself is caller-supplied and stays in the debug log.
 */
const UNDERSCORE_RULE = 'underscore_prefix';

/** Which half of the alias stage rewrote a key. */
type AliasKind = 'case_style' | 'declared';

/** One Zod issue from a failed parse of the arguments. */
type ArgumentIssue = ZodError['issues'][number];

/**
 * What the pre-parse stages changed that the caller wrote, reported on an
 * argument rejection (#468) so a caller can tell a bad value from a key that
 * was moved or discarded. Keys only, never values.
 */
export interface PrevalidationReport {
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
  /** Present only when a rewrite or an underscore-rule drop happened. */
  readonly report?: PrevalidationReport;
}

/** What {@link repairRepresentations} produced. */
export interface RepairedArguments {
  /** The repaired arguments — the input itself when nothing was repairable. */
  readonly args: unknown;
  /** Each kind that fired at least once, in {@link COERCION_KINDS} order. */
  readonly kinds: readonly CoercionKind[];
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

let ignoredKeyCounter: Counter | undefined;
let aliasedCounter: Counter | undefined;
let coercedCounter: Counter | undefined;

/**
 * Lazily created — a server whose callers never trip a stage emits no series.
 *
 * `rule` is the ignore-list entry that matched or {@link UNDERSCORE_RULE}, never
 * the dropped key itself: the key is the caller's text, and one client inventing
 * `_callId`, `_call_id`, `_callID` would mint three permanent series (#114). The
 * ignore list is author- and framework-defined, so it is safe to name.
 */
function countIgnoredKey(toolName: string, rule: string): void {
  ignoredKeyCounter ??= createCounter(
    'mcp.input.ignored_key',
    'Client-added root argument keys dropped before validation',
    '{keys}',
  );
  ignoredKeyCounter.add(1, {
    [ATTR_MCP_TOOL_NAME]: toolName,
    [ATTR_MCP_INPUT_IGNORE_RULE]: rule,
  });
}

/**
 * Labelled by the canonical *target* and which half of the stage fired — both
 * bounded by the definition. The alias is the caller's text, and the case-style
 * half accepts every `-`/`_`/case permutation of a declared key, so labelling it
 * would put an unbounded set on a permanent series (#114).
 */
function countAliased(toolName: string, target: string, kind: AliasKind): void {
  aliasedCounter ??= createCounter(
    'mcp.input.aliased',
    'Root argument keys rewritten to their canonical spelling',
    '{keys}',
  );
  aliasedCounter.add(1, {
    [ATTR_MCP_TOOL_NAME]: toolName,
    [ATTR_MCP_INPUT_TARGET]: target,
    [ATTR_MCP_INPUT_ALIAS_KIND]: kind,
  });
}

/**
 * Emits one counter increment and one debug log per change an attempt made, in
 * the order its stages made them. {@link parseToolArguments} calls it once per
 * call, for the attempt whose arguments the handler receives — or, on a
 * rejection, the first attempt, the one the rejection reports — so a key the
 * alias-first retry rewrote never also counts as dropped (#563).
 */
export function recordPrevalidation(
  def: AnyToolDefinition,
  attempt: PrevalidatedArguments,
  context: RequestContext | undefined,
): void {
  for (const change of attempt.changes) {
    if (change.kind === 'aliased') {
      const { alias, aliasKind, target } = change;
      countAliased(def.name, target, aliasKind);
      debugLog(`Tool '${def.name}': rewrote argument key '${alias}' to '${target}'.`, context, {
        toolName: def.name,
        alias,
        target,
        aliasKind,
      });
    } else {
      countIgnoredKey(def.name, change.rule);
      debugLog(`Tool '${def.name}': dropped client-added argument key '${change.key}'.`, context, {
        toolName: def.name,
        ignoredKey: change.key,
        ignoreRule: change.rule,
      });
    }
  }
}

/**
 * One increment per repaired call and kind — a call repairing an array and an
 * object adds one to each series, and one repairing three arrays adds one — and
 * one debug log per call naming every kind that fired.
 */
export function countCoerced(
  toolName: string,
  kinds: readonly CoercionKind[],
  context: RequestContext | undefined,
): void {
  coercedCounter ??= createCounter(
    'mcp.input.coerced',
    'Tool calls that validated only after a representation repair',
    '{calls}',
  );
  for (const kind of kinds) {
    coercedCounter.add(1, {
      [ATTR_MCP_TOOL_NAME]: toolName,
      [ATTR_MCP_INPUT_COERCION]: kind,
    });
  }
  const phrases = kinds.map((kind) => COERCION_KINDS[kind]);
  const named =
    phrases.length < 2
      ? phrases.join('')
      : `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}`;
  debugLog(`Tool '${toolName}': arguments validated after repairing ${named}.`, context, {
    toolName,
    coercions: kinds,
  });
}

/**
 * The step's own debug channel. A call the step rescues carries nothing about
 * it in its response, so the log is where a server operator sees which key was
 * dropped or moved; the counters say only that one was. A rejected call also
 * reports its rewrites and underscore-rule drops to the caller (#468); an
 * ignore-list drop never reaches the caller at all.
 */
function debugLog(
  message: string,
  context: RequestContext | undefined,
  extra: Record<string, unknown>,
): void {
  const base =
    context ?? requestContextService.createRequestContext({ operation: 'ToolInputPrevalidation' });
  logger.debug(message, withExtra(base, extra));
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
 * A rewrite applies only when the target key is absent; with both present the
 * arguments pass through and the strict rejection fires as it does today. An
 * author-opened root is never rewritten (an unknown key there is already
 * accepted verbatim), and a `headerParam`-designated target is never rewritten
 * *to*: the SDK cross-checks the `Mcp-Param-<Name>` header against the raw body
 * before dispatch, so a later rewrite would hand the handler a value no
 * intermediary attested.
 *
 * `unfolded` names keys the case-style pass never folds. The alias-first retry
 * passes the ignore list, since there the drop has not yet removed a client
 * artifact: `_meta` stays the client's, whatever a tool declares as `meta`. A
 * declared alias still fires for one — naming it is the author's call, as
 * declaring the key itself is (#563).
 *
 * Returns the rewrites in the order they were made, and again in argument order
 * for the rejection report.
 */
function applyAliases(
  def: AnyToolDefinition,
  args: Record<string, unknown>,
  plan: InputPlan,
  options: InputHandlingOptions | undefined,
  unfolded: ReadonlySet<string>,
): {
  args: Record<string, unknown>;
  aliased: PrevalidationReport['aliased'];
  changes: PrevalidationChange[];
} {
  const changes: PrevalidationChange[] = [];
  const declared = def.inputAliases;
  const caseStyle = options?.caseStyleAliases !== false;
  if (plan.anyOpen || (!declared && !caseStyle)) return { args, aliased: [], changes };

  const variant = selectVariant(plan, args);
  if (!variant) return { args, aliased: [], changes };

  let rewritten: Record<string, unknown> | undefined;
  const current = (): Record<string, unknown> => rewritten ?? args;
  const moved = new Map<string, string>();

  const rewritable = (alias: string, target: string): boolean =>
    Object.hasOwn(current(), alias) &&
    !variant.keys.has(alias) &&
    variant.keys.has(target) &&
    !plan.headerTargets.has(target) &&
    !Object.hasOwn(current(), target);

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
    changes.push({ kind: 'aliased', alias, target, aliasKind: kind });
  };

  for (const [alias, target] of Object.entries(declared ?? {})) {
    if (rewritable(alias, target)) move(alias, target, 'declared');
  }

  if (caseStyle) {
    // Snapshot first: `move` only ever removes an undeclared key and adds a
    // declared one, so the remaining candidates are unaffected.
    for (const key of Object.keys(current())) {
      if (variant.keys.has(key) || unfolded.has(key)) continue;
      const target = variant.folded.get(foldArgumentKey(key));
      if (target && rewritable(key, target)) move(key, target, 'case_style');
    }
  }

  const aliased = Object.keys(args).flatMap((alias) => {
    const target = moved.get(alias);
    return target === undefined ? [] : [{ alias, target }];
  });
  return { args: rewritten ?? args, aliased, changes };
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

  const ignoreList = ignoreListFor(options);
  const record = args as Record<string, unknown>;

  if (order === 'drop-first') {
    // The drop has already removed every undeclared ignore-listed key, so the
    // case-style pass folds whatever is left, exactly as it always has.
    const drop = dropIgnoredKeys(record, plan, options, ignoreList);
    const rewrite = applyAliases(def, drop.args, plan, options, NO_KEYS);
    const changes = [...drop.changes, ...rewrite.changes];
    return attempt(rewrite.args, changes, rewrite.aliased, drop.ignored);
  }
  const rewrite = applyAliases(def, record, plan, options, ignoreList);
  const drop = dropIgnoredKeys(rewrite.args, plan, options, ignoreList);
  return attempt(drop.args, [...rewrite.changes, ...drop.changes], rewrite.aliased, drop.ignored);
}

/** One attempt, carrying a report only when a rewrite or an underscore-rule drop happened. */
function attempt(
  args: Record<string, unknown>,
  changes: readonly PrevalidationChange[],
  aliased: PrevalidationReport['aliased'],
  ignored: PrevalidationReport['ignored'],
): PrevalidatedArguments {
  if (aliased.length === 0 && ignored.length === 0) return { args, changes };
  return { args, changes, report: { aliased, ignored } };
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

/**
 * Undoes a representation slip at each path the failed parse's issues named:
 * a string whose trimmed form is a JSON array or object is parsed back into
 * what it encodes (#234, #479), and a safe integer where a string was expected
 * becomes its decimal string (#487). Keys are never added, dropped, or renamed,
 * and a value no issue points at is returned untouched.
 *
 * **Targeted, not a full walk.** A rejection names exactly the values the schema
 * could not accept, and repairing anything else loses repairs that should have
 * succeeded: one call carrying a stringified array for an array field *and* a
 * free-text field legitimately holding `"[1,2]"` would have both rewritten, the
 * re-parse would fail on the free-text field, and the whole call would be
 * rejected over a value that was valid all along. An `invalid_union` issue's
 * outer path counts like any other — that is the value the union rejected, and
 * the only one read: a number inside one branch of a union field stays as sent.
 *
 * **One pass, no stacking.** Only a value the first parse rejected is repaired,
 * and at most once, so a value one repair produced is never repaired again — an
 * integer inside a stringified array, a stringified field inside a stringified
 * object. The caller re-parses once.
 *
 * `JSON.parse` is the exact inverse of the `JSON.stringify` that produced a
 * string, and `String(n)` of a safe integer is the digits the caller sent, so
 * each repair undoes a known encoding rather than matching a nearest candidate —
 * the distinction that makes it safe where nearest-key matching is not (#232).
 * Safety does not rest on that alone: {@link parseToolArguments} runs this only
 * after validation has already failed and keeps the result only when it then
 * passes.
 *
 * `args` is the argument itself when nothing was repairable, which is the
 * signal the caller uses to skip the second parse.
 */
export function repairRepresentations(
  args: unknown,
  issues: readonly ArgumentIssue[],
): RepairedArguments {
  let repaired = args;
  const fired = new Set<CoercionKind>();
  for (const issue of issues) {
    if (issue.path.length === 0) continue;
    const current = readAt(repaired, issue.path);
    const repair = repairValue(current, issue);
    if (repair) {
      repaired = writeAt(repaired, issue.path, repair.value);
      fired.add(repair.kind);
    }
  }
  return {
    args: repaired,
    kinds: (Object.keys(COERCION_KINDS) as CoercionKind[]).filter((kind) => fired.has(kind)),
  };
}

/**
 * The repair for one value the parse rejected, or `undefined` when none applies.
 *
 * A string is decoded only when its trimmed form opens a JSON array or object —
 * the grammar then guarantees the decoded kind. A number becomes a string only
 * when it is a safe integer other than `-0` (`String(-0)` is `"0"`, and an
 * unsafe integer already lost digits in `JSON.parse`), and only when the issue
 * says it failed for being a number ({@link failedAsNumber}).
 */
function repairValue(
  value: unknown,
  issue: ArgumentIssue,
): { kind: CoercionKind; value: unknown } | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && !Object.is(value, -0) && failedAsNumber(issue)
      ? { kind: 'integer_as_string', value: String(value) }
      : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const kind: CoercionKind | undefined = trimmed.startsWith('[')
    ? 'stringified_array'
    : trimmed.startsWith('{')
      ? 'stringified_object'
      : undefined;
  if (!kind) return undefined;
  try {
    return { kind, value: JSON.parse(trimmed) };
  } catch {
    return undefined;
  }
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
 * discriminator mismatch reports no branches and never passes.
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

/** The value at `path`, or `undefined` when nothing owns one there. */
function readAt(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let cursor = root;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    if (!Object.hasOwn(cursor, segment)) return undefined;
    cursor = (cursor as Record<PropertyKey, unknown>)[segment];
  }
  return cursor;
}

/**
 * Replaces the value at `path`, copying each container along the way and
 * leaving the caller's own objects untouched.
 *
 * Object copies go through `Object.fromEntries`, which *defines* each property
 * rather than assigning it. `copy[key] = value` would route a caller's own
 * `__proto__` key — which `JSON.parse` creates as an ordinary own data property
 * — through `Object.prototype`'s setter: the key would vanish and the copy's
 * prototype would become whatever the caller sent, which Zod then reads
 * inherited values from. Defining keeps the key and the prototype, and keeps
 * this function's promise that no key is added, dropped, or renamed.
 */
function writeAt(root: unknown, path: ReadonlyArray<PropertyKey>, value: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return value;

  if (Array.isArray(root)) {
    const index = Number(head);
    if (!Number.isInteger(index) || index < 0 || index >= root.length) return root;
    const copy = [...root];
    copy[index] = writeAt(root[index], rest, value);
    return copy;
  }

  if (root !== null && typeof root === 'object') {
    const key = String(head);
    if (!Object.hasOwn(root, key)) return root;
    return Object.fromEntries(
      Object.entries(root as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        entryKey === key ? writeAt(entryValue, rest, value) : entryValue,
      ]),
    );
  }

  return root;
}

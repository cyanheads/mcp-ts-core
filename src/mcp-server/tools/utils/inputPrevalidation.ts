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
 * 3. **Representation repair (#234)** — a JSON-stringified array where an array
 *    was declared. Applied only *after* the parse has already failed, and kept
 *    only when it flips the arguments from invalid to valid: the author's schema
 *    is the sole arbiter, so a repair can never touch input that was already
 *    valid.
 *
 * All three are on by default and each has a server-level switch on
 * `createApp({ input })` / `createWorkerHandler({ input })`. None of them
 * changes what `tools/list` advertises, and none appears in a response: a drop,
 * a rewrite, and a repair each emit one debug log and one counter increment
 * instead.
 *
 * The split between the two is deliberate. Counter attributes are bounded and
 * author- or framework-defined — the ignore-list entry that matched, the
 * declared key a rewrite resolved to — because a metric label carrying the
 * caller's own key text mints a permanent time series per spelling a client
 * invents (#114). The raw key and alias go to the debug log, which is where an
 * operator looks when a counter shows a new client artifact and where
 * cardinality costs nothing.
 *
 * @module src/mcp-server/tools/utils/inputPrevalidation
 */

import type { Counter } from '@opentelemetry/api';
import type { ZodObject, ZodRawShape, ZodType } from 'zod';

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
   * JSON-stringified array parsed back into an array. `false` restores the
   * single-parse behavior exactly. Default `true`.
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

/** The one repair {@link repairRepresentations} performs, as the counter labels it. */
const COERCION_KIND_STRINGIFIED_ARRAY = 'stringified_array';

/**
 * What the ignored-key counter reports for a key the underscore heuristic
 * dropped. The key itself is caller-supplied and stays in the debug log.
 */
const UNDERSCORE_RULE = 'underscore_prefix';

/** Which half of the alias stage rewrote a key. */
type AliasKind = 'case_style' | 'declared';

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

/** One increment per repaired call, not per repaired value. */
export function countCoerced(toolName: string, context: RequestContext | undefined): void {
  coercedCounter ??= createCounter(
    'mcp.input.coerced',
    'Tool calls that validated only after a representation repair',
    '{calls}',
  );
  coercedCounter.add(1, {
    [ATTR_MCP_TOOL_NAME]: toolName,
    [ATTR_MCP_INPUT_COERCION]: COERCION_KIND_STRINGIFIED_ARRAY,
  });
  debugLog(
    `Tool '${toolName}': arguments validated after repairing a stringified array.`,
    context,
    { toolName, coercion: COERCION_KIND_STRINGIFIED_ARRAY },
  );
}

/**
 * The step's own debug channel. A pre-validation decision is invisible in the
 * response by design, so the log is the only place a server operator sees that
 * a key was dropped or moved.
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

// ---------------------------------------------------------------------------
// Stage 1 — drop client-added keys (#453)
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
 */
function dropIgnoredKeys(
  def: AnyToolDefinition,
  args: Record<string, unknown>,
  plan: InputPlan,
  options: InputHandlingOptions | undefined,
  context: RequestContext | undefined,
): Record<string, unknown> {
  if (options?.ignoreKeys === false || plan.anyOpen) return args;

  const ignored = new Set<string>([...BUILT_IN_IGNORED_KEYS, ...(options?.ignoreKeys ?? [])]);
  const underscoreRule = !plan.underscoreDeclared;

  let kept: Record<string, unknown> | undefined;
  for (const key of Object.keys(args)) {
    if (plan.allKeys.has(key)) continue;
    const listed = ignored.has(key);
    if (!listed && !(underscoreRule && key.startsWith('_'))) continue;
    // Spread copies own properties by definition, so a caller's own `__proto__`
    // survives as a key instead of re-prototyping the copy; `delete` on that own
    // property is equally safe.
    kept ??= { ...args };
    delete kept[key];
    countIgnoredKey(def.name, listed ? key : UNDERSCORE_RULE);
    debugLog(`Tool '${def.name}': dropped client-added argument key '${key}'.`, context, {
      toolName: def.name,
      ignoredKey: key,
      ignoreRule: listed ? key : UNDERSCORE_RULE,
    });
  }
  return kept ?? args;
}

// ---------------------------------------------------------------------------
// Stage 2 — key aliases (#452)
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
 */
function applyAliases(
  def: AnyToolDefinition,
  args: Record<string, unknown>,
  plan: InputPlan,
  options: InputHandlingOptions | undefined,
  context: RequestContext | undefined,
): Record<string, unknown> {
  const declared = def.inputAliases;
  const caseStyle = options?.caseStyleAliases !== false;
  if (plan.anyOpen || (!declared && !caseStyle)) return args;

  const variant = selectVariant(plan, args);
  if (!variant) return args;

  let rewritten: Record<string, unknown> | undefined;
  const current = (): Record<string, unknown> => rewritten ?? args;

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
    countAliased(def.name, target, kind);
    debugLog(`Tool '${def.name}': rewrote argument key '${alias}' to '${target}'.`, context, {
      toolName: def.name,
      alias,
      target,
      aliasKind: kind,
    });
  };

  for (const [alias, target] of Object.entries(declared ?? {})) {
    if (rewritable(alias, target)) move(alias, target, 'declared');
  }

  if (caseStyle) {
    // Snapshot first: `move` only ever removes an undeclared key and adds a
    // declared one, so the remaining candidates are unaffected.
    for (const key of Object.keys(current())) {
      if (variant.keys.has(key)) continue;
      const target = variant.folded.get(foldArgumentKey(key));
      if (target && rewritable(key, target)) move(key, target, 'case_style');
    }
  }

  return rewritten ?? args;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Runs the pre-parse half of the step — drop client-added keys, then rewrite
 * key aliases — and returns the arguments to parse.
 *
 * Returns the caller's own object unchanged when nothing applied, so the common
 * path allocates nothing. Non-object arguments are handed straight back: the
 * schema's own rejection already says what arrived.
 */
export function prevalidateToolArguments(
  def: AnyToolDefinition,
  args: unknown,
  options: InputHandlingOptions | undefined,
  context: RequestContext | undefined,
): unknown {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args;

  const plan = planFor(def.input);
  if (plan.variants.length === 0) return args;

  const record = args as Record<string, unknown>;
  return applyAliases(
    def,
    dropIgnoredKeys(def, record, plan, options, context),
    plan,
    options,
    context,
  );
}

/**
 * Parses back a string whose trimmed form is a JSON array, at each path the
 * failed parse's issues named. Keys are never added, dropped, or renamed, and
 * a value no issue points at is returned untouched.
 *
 * **Targeted, not a full walk.** A rejection names exactly the values the schema
 * could not accept, and repairing anything else loses repairs that should have
 * succeeded: one call carrying a stringified array for an array field *and* a
 * free-text field legitimately holding `"[1,2]"` would have both rewritten, the
 * re-parse would fail on the free-text field, and the whole call would be
 * rejected over a value that was valid all along. An `invalid_union` issue's
 * outer path counts like any other — that is the value the union rejected.
 *
 * `JSON.parse` is the exact inverse of the `JSON.stringify` that produced the
 * value, so this undoes a known encoding rather than matching a nearest
 * candidate — the distinction that makes it safe where nearest-key matching is
 * not (#232). Safety does not rest on that alone: {@link parseToolArguments}
 * runs this only after validation has already failed and keeps the result only
 * when it then passes.
 *
 * Returns the argument itself when nothing was repairable, which is the signal
 * the caller uses to skip the second parse.
 */
export function repairRepresentations(
  args: unknown,
  issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey> }>,
): unknown {
  let repaired = args;
  for (const issue of issues) {
    if (issue.path.length === 0) continue;
    const current = readAt(repaired, issue.path);
    const next = repairValue(current);
    if (next !== current) repaired = writeAt(repaired, issue.path, next);
  }
  return repaired;
}

/** The one repair: a JSON-array string back into the array it encodes. */
function repairValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return value;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
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

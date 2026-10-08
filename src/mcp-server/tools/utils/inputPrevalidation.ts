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
 * 3. **Representation repair (#234, #479, #487, #707, #602, #616, #570, #599,
 *    #714)** — a JSON-stringified array or object where one was declared, an
 *    integer where a string was, a string spelling a number or boolean where
 *    only those are accepted, a lone string where an array was, or `null` for
 *    an optional field, which is deleted — at any path the rejection renders,
 *    inside the one union branch that survives selection included, at a
 *    discriminator or literal tag no variant accepts, and inside what a
 *    `z.preprocess()` made of the argument — tried first written in place at
 *    the issue path, then written into the output, which takes the argument's
 *    place only if the preprocess returns it unchanged. Applied only
 *    *after* the parse has already failed, and kept only when it flips the
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
 * attempt whose rejection it carries reported (#468), since without them the
 * caller cannot tell a bad value from a key that was moved or discarded, and
 * with each alias sent beside its target named as one in the hint (#639),
 * since an unknown or dropped key would send the caller looking for a typo. Its
 * issues come from a parse with only the repairs that held applied (#706), so
 * a value the schema accepted once repaired is not reported and one it refused
 * is reported as sent — unless that parse validates, which only a union or a
 * cross-field refinement allows, and the first parse is reported instead; the
 * rejection itself never mentions a repair. A value that held only written in
 * place below a transform that reorders or rewrites it is reported as sent
 * too: the issues name positions in the transform's output, where a repair
 * written in place is not.
 *
 * The split between log and counter is deliberate. Counter attributes are
 * bounded and author- or framework-defined — the ignore-list entry that
 * matched, the declared key a rewrite resolved to — because a metric label
 * carrying the caller's own key text mints a permanent time series per spelling
 * a client invents (#114). The raw key and alias go to the debug log, which is
 * where an operator looks when a counter shows a new client artifact and where
 * cardinality costs nothing, at most their first 1,024 characters bounding its size
 * (#631) — and, on a rejection, back to the caller who sent them, cut the same
 * way (#648), since an error payload is per call rather than a permanent series.
 *
 * @module src/mcp-server/tools/utils/inputPrevalidation
 */

import type { Counter } from '@opentelemetry/api';
import type { ZodError, ZodObject, ZodRawShape, ZodType } from 'zod';

import { logger } from '@/utils/internal/logger.js';
import { capForObservability } from '@/utils/internal/observabilityCap.js';
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
import {
  argumentAt,
  inputVariants,
  isDiscriminatedUnionSchema,
  objectSchemaAt,
  routesThroughPipeAt,
  stepInto,
  type TransformCache,
  type TransformSite,
  zodDef,
} from './schemaShape.js';
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
 * The repairs {@link repairRepresentations} performs, as `mcp.input.coercion`
 * labels them, in the order a call's debug log names them — paired with how
 * that log reads each one.
 */
const COERCION_KINDS = {
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
 * What the ignored-key counter reports for a key the underscore heuristic
 * dropped. The key itself is caller-supplied and stays in the debug log.
 */
const UNDERSCORE_RULE = 'underscore_prefix';

/** Which half of the alias stage rewrote a key. */
type AliasKind = 'case_style' | 'declared';

/** One Zod issue from a failed parse of the arguments. */
type ArgumentIssue = ZodError['issues'][number];

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
 * rejection, the attempt the rejection reports, which is the alias-first
 * retry's when it ran — so a key the alias-first retry rewrote never also
 * counts as dropped (#563).
 *
 * The key a record names is the caller's, of whatever length the caller wrote,
 * so the message and the field carry at most its first 1,024 characters, with
 * `aliasLength` / `ignoredKeyLength` holding the uncut length when that cut
 * something (#631).
 */
export function recordPrevalidation(
  def: AnyToolDefinition,
  attempt: PrevalidatedArguments,
  context: RequestContext | undefined,
): void {
  for (const change of attempt.changes) {
    if (change.kind === 'aliased') {
      const { aliasKind, target } = change;
      const alias = capForObservability(change.alias);
      countAliased(def.name, target, aliasKind);
      debugLog(
        `Tool '${def.name}': rewrote argument key '${alias.value}' to '${target}'.`,
        context,
        {
          toolName: def.name,
          alias: alias.value,
          ...(alias.length !== undefined && { aliasLength: alias.length }),
          target,
          aliasKind,
        },
      );
    } else {
      const key = capForObservability(change.key);
      countIgnoredKey(def.name, change.rule);
      debugLog(`Tool '${def.name}': dropped client-added argument key '${key.value}'.`, context, {
        toolName: def.name,
        ignoredKey: key.value,
        ...(key.length !== undefined && { ignoredKeyLength: key.length }),
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

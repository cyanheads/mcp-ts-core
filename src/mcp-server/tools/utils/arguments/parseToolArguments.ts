/**
 * @fileoverview The single argument-validation path for tool calls: runs the
 * pre-parse stages, parses against the definition's `input`, repairs and
 * re-parses a failed call, retries alias-first, and either hands the handler
 * its arguments or throws the argument rejection.
 * @module src/mcp-server/tools/utils/arguments/parseToolArguments
 */

import type { ZodError, z } from 'zod';

import type { RequestContext } from '@/utils/internal/requestContext.js';
import type { TransformCache } from '../schemaShape.js';
import type { AnyToolDefinition } from '../toolDefinition.js';
import { renderedIssues } from './issues.js';
import {
  type InputHandlingOptions,
  type PrevalidatedArguments,
  prevalidateAliasFirst,
  prevalidateToolArguments,
} from './prevalidation.js';
import { argumentRejection } from './rejection.js';
import {
  applyRepairs,
  type CoercionKind,
  heldRepairs,
  repairAsSent,
  repairRepresentations,
  sameValue,
} from './repair.js';
import { countCoerced, recordPrevalidation } from './telemetry.js';

/** What {@link parseToolArguments} needs beyond the definition and the arguments. */
export interface ParseToolArgumentsOptions {
  /** Request context the pre-validation step's debug logs correlate to. */
  context?: RequestContext;
  /** Server-level pre-validation switches, from `createApp({ input })`. */
  input?: InputHandlingOptions;
}

/**
 * Validates raw tool arguments against the definition's `input` schema, or
 * throws the rejection a client receives on the wire: `InvalidParams`
 * (`-32602`), the message {@link formatInputValidationMessage} renders, the Zod
 * issues as `data.issues`, and — as with any other declared failure —
 * `data.reason` plus a `data.recovery.hint` {@link buildArgumentRecoveryHint}
 * synthesizes (#445). {@link buildToolErrorResult} mirrors that hint into
 * `content[]`, so it reaches format()-only clients with no extra work.
 *
 * The rejection is bounded whatever the caller sends (#648) in
 * {@link argumentRejection}, so every path here carries the bound: the message
 * and the hint render the first 10 issue lines, each cut to 1,024 characters,
 * and `data.issues` and `data.input` are `boundedProjection`s — the
 * first 10 entries of every array and own keys of every object, the first
 * 1,024 characters of every string and key, and two levels of lists and objects
 * below each issue, the uncut count or length beside each cut — with
 * `data.issues` keeping at most 30 issues in all through
 * every union's branches. `data.issuesCount`, how many issues Zod raised at
 * the top level, sits beside `data.issues` whenever it keeps fewer of them —
 * past the first 10, or sooner when that budget runs out — as `errorsCount`
 * sits beside a cut branch list. A rejection within those caps carries Zod's
 * list and the report exactly. Its cost grows
 * with the distinct issues Zod raised, not with how many branches list one:
 * every reader of the issues walks a shared one once or stops at a bound.
 *
 * An ordered pre-validation step wraps the parse. Before it,
 * {@link prevalidateToolArguments} drops client-added keys (#453) and rewrites
 * key aliases (#452); after a failure — and only then —
 * {@link repairRepresentations} undoes a stringified array or object, an
 * integer sent for a string, a string sent for a number or boolean, or a lone
 * string sent for an array, and deletes `null` sent for an optional field, at
 * the paths {@link renderedIssues} names — inside a union field's one surviving
 * branch (#570), at a discriminator or literal tag no variant accepts (#714),
 * and inside a `z.preprocess()` output (#599) included — and the
 * arguments are parsed once more (#234, #479, #487, #707, #602, #616), the
 * repair kept only if the author's own schema now accepts it. The repair
 * 0.13.13 made, of Zod's own issues in the arguments as sent
 * ({@link repairAsSent}), is parsed before it, so every call that repair
 * validated keeps its value. Every path the
 * repair, the message, and the hint read is walked through the input schema,
 * a transform on the way re-applied once per value for the whole call.
 * When that attempt still fails and its drop discarded a key,
 * {@link prevalidateAliasFirst} reruns the stages alias-first and the same
 * parse-then-repair runs on the result, kept only if it validates (#563).
 * {@link recordPrevalidation} then counts and logs the attempt the handler
 * receives, so a call the first attempt validates is untouched by the retry.
 * When nothing validates, the last attempt's rejection is thrown — the
 * retry's when it ran, since there every key the drop discarded reached its
 * target and the issues name what is wrong with the value it carried. It is a
 * parse of that attempt's arguments with only the repairs that held applied
 * (#706, {@link repairAttempt}), rendered from those same arguments: a value
 * the schema accepted once repaired is not reported — one that held only
 * written in place below a transform that reorders or rewrites it excepted —
 * and one whose repair the schema refused is reported as sent, so a call no
 * repair helped gets exactly
 * the rejection it gets under `input: { coerce: false }` — as does one the
 * held repairs alone would validate (only a union or a cross-field refinement
 * allows that), held values included. It carries the rewrites and
 * underscore-rule drops that attempt made as `data.input`, and as sentences
 * closing the hint (#468); a call with neither gains no `data.input`, and
 * nothing in it says a repair held. An alias that attempt
 * declined because its target was already present is named in the hint as an
 * alias of that target (#639), never as an unknown or a dropped key.
 *
 * The single argument-rejection path. {@link createToolHandler} and the
 * `runToolContract` test helper both route through it, so a test written to
 * the helper pins the code, message, and `content[]` text a deployment
 * actually produces (#416). A `ZodError` a handler throws from its own
 * validation classifies as `ValidationError` and does not come through here;
 * nor does the output-schema parse, which fails as `InternalError`
 * ({@link parseToolOutput}).
 */
export function parseToolArguments<TDefinition extends AnyToolDefinition>(
  def: TDefinition,
  input: unknown,
  options: ParseToolArgumentsOptions = {},
): z.infer<TDefinition['input']> {
  const first = prevalidateToolArguments(def, input, options.input);
  const parsed = def.input.safeParse(first.args);
  if (!parsed.success) return repairOrReject(def, input, first, parsed.error, options);
  return accept(
    def,
    first,
    { success: true, data: parsed.data, coerced: NO_COERCIONS },
    options.context,
  );
}

/** No repair applied. */
const NO_COERCIONS: readonly CoercionKind[] = [];

/**
 * {@link parseToolArguments} once the first parse has failed with
 * `firstError`: the repair, the alias-first retry, and the rejection. Kept out
 * of the function a valid call runs, which then allocates nothing past the
 * parse.
 */
function repairOrReject<TDefinition extends AnyToolDefinition>(
  def: TDefinition,
  input: unknown,
  first: PrevalidatedArguments,
  firstError: ZodError,
  options: ParseToolArgumentsOptions,
): z.infer<TDefinition['input']> {
  // One cache for the whole call: the repair, the message, and the hint each
  // read paths through the same transforms, which then run once per value (#599).
  const transforms: TransformCache = new Map();
  const parsed = repairAttempt(def, first.args, firstError, options.input, transforms);
  if (parsed.success) return accept(def, first, parsed, options.context);

  let failed = { attempt: first, parsed };
  const retry = prevalidateAliasFirst(def, input, first, options.input);
  if (retry) {
    const retryParse = def.input.safeParse(retry.args);
    const retried: ParsedAttempt = retryParse.success
      ? { success: true, data: retryParse.data, coerced: NO_COERCIONS }
      : repairAttempt(def, retry.args, retryParse.error, options.input, transforms);
    if (retried.success) return accept(def, retry, retried, options.context);
    failed = { attempt: retry, parsed: retried };
  }

  const {
    attempt,
    parsed: { args, error },
  } = failed;
  recordPrevalidation(def, attempt, options.context);
  throw argumentRejection(def, attempt, args, error, transforms);
}

/** What {@link repairAttempt} decided for one ordering of the pre-parse stages. */
type ParsedAttempt =
  | { readonly coerced: readonly CoercionKind[]; readonly data: unknown; readonly success: true }
  | {
      /** The arguments `error` came from, which the message and the hint read. */
      readonly args: unknown;
      readonly error: ZodError;
      readonly success: false;
    };

/**
 * Repairs one attempt's arguments, whose parse failed with `error`, once and
 * re-parses, keeping the repair only if the schema then accepts it. The
 * original repair — Zod's own issues read and written at their paths in the
 * arguments as sent ({@link repairAsSent}) — is parsed first, so a call it
 * validated validates with the same value. A repair below a transform is then
 * parsed written in place (#599, {@link repairRepresentations}), and the
 * substitution last — with the original repairs no rendered issue reached,
 * then, when that fails, without them; arguments equal to the original
 * repair's are not parsed again, and a substitution every transform refused,
 * which leaves the arguments as sent, is not parsed at all. Only the first
 * substitution's parse can be the rejection, since only its repairs sit where
 * the issues name values.
 *
 * A call that still fails is rejected from the attempt's arguments with only
 * the repairs that held applied (#706) — those {@link heldRepairs} finds no
 * re-parse issue at or below. Every repair held: the re-parse is the
 * rejection. None did: the first parse is, exactly as under `coerce: false`.
 * Some did: one more parse, of the arguments with those written. It only
 * reports, never admits: when it validates — possible only where the schema
 * judges one value by another, as a union or a cross-field refinement does —
 * the first parse is the rejection, so which calls validate never rests on
 * it. Short of that fallback, no reported issue names a value the caller sent
 * and the schema accepted once repaired, and a value whose repair the schema
 * refused is reported as sent — but a value that held only written in place,
 * below a transform that reorders or rewrites it, is judged here by the
 * substitution, whose issues name positions in the transform's output, and is
 * reported as sent too. A re-parse the author's schema throws on discards the
 * repairs it carried, like a failed one.
 */
function repairAttempt(
  def: AnyToolDefinition,
  args: unknown,
  error: ZodError,
  options: InputHandlingOptions | undefined,
  transforms: TransformCache,
): ParsedAttempt {
  const asSent = { success: false, args, error } as const;
  if (options?.coerce === false) return asSent;

  const original = repairAsSent(args, error.issues);
  const originalParse = original && reparse(def, original.args);
  if (original && originalParse?.success) {
    return { success: true, data: originalParse.data, coerced: original.kinds };
  }
  // A repair that writes the same arguments as the original one fails the same way.
  const parseRepaired = (repaired: unknown) =>
    original && sameValue(repaired, original.args) ? originalParse : reparse(def, repaired);

  const repair = repairRepresentations(
    args,
    renderedIssues(error.issues),
    def.input,
    transforms,
    original?.repairs,
  );
  if (repair.inPlace) {
    const placed = parseRepaired(repair.inPlace.args);
    if (placed?.success) return { success: true, data: placed.data, coerced: repair.inPlace.kinds };
  }
  // No repair, or each one below a transform that refused it: the first parse read these arguments.
  if (repair.repairs.length === 0 || sameValue(repair.args, args)) return asSent;
  const retried = parseRepaired(repair.args);
  if (retried?.success) return { success: true, data: retried.data, coerced: repair.kinds };
  if (repair.unaided) {
    const unaided = parseRepaired(repair.unaided.args);
    if (unaided?.success) {
      return { success: true, data: unaided.data, coerced: repair.unaided.kinds };
    }
  }
  if (!retried) return asSent;

  const held = heldRepairs(repair.repairs, retried.error.issues);
  if (held.length === repair.repairs.length) {
    return { success: false, args: repair.args, error: retried.error };
  }
  if (held.length === 0) return asSent;
  const reported = applyRepairs(args, held);
  const reparsed = reparse(def, reported);
  return !reparsed || reparsed.success
    ? asSent
    : { success: false, args: reported, error: reparsed.error };
}

/**
 * Parses repaired arguments, or `undefined` when the author's schema throws on
 * them: a check written for the values a valid call carries can throw on a
 * repaired one, such as an optional field's `undefined` once its `null` is
 * deleted.
 */
function reparse(
  def: AnyToolDefinition,
  args: unknown,
): ReturnType<AnyToolDefinition['input']['safeParse']> | undefined {
  try {
    return def.input.safeParse(args);
  } catch {
    return;
  }
}

/** Emits the winning attempt's telemetry and hands its arguments to the handler. */
function accept<TDefinition extends AnyToolDefinition>(
  def: TDefinition,
  attempt: PrevalidatedArguments,
  parsed: Extract<ParsedAttempt, { success: true }>,
  context: RequestContext | undefined,
): z.infer<TDefinition['input']> {
  recordPrevalidation(def, attempt, context);
  if (parsed.coerced.length > 0) countCoerced(def.name, parsed.coerced, context);
  return parsed.data as z.infer<TDefinition['input']>;
}

/**
 * @fileoverview The ordered step raw `tools/call` arguments pass through before
 * — and, for one stage, after — the `input` schema parses them, run by
 * `parseToolArguments.ts`.
 *
 * Strict inputs (#232) reject an unrecognized root key by name, which is right
 * for a misspelling the caller can fix and wrong for the three cases collected
 * here, where the arguments the model wrote are correct and something between
 * the model and the schema is not:
 *
 * 1. **Client-added keys (#453)** — a placeholder, a call description, a call
 *    id, or an `arguments`-level `_meta` block the model never wrote and cannot
 *    remove. Dropped before parsing, in `prevalidation.ts`.
 * 2. **Key aliases (#452)** — a declared `inputAliases` entry, or the same name
 *    in another case style (`max_results` for `maxResults`). Rewritten to the
 *    canonical key before parsing, in `prevalidation.ts`. A one-to-one mapping
 *    fixed ahead of time, not the nearest-key guess #232 rejected.
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
 *    so a repair can never touch input that was already valid. In `repair.ts`.
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
 * cannot rescue is rejected (`rejection.ts`, from the issues `issues.ts`
 * locates, within the caps `bounds.ts` and `utils/internal/boundedProjection.ts`
 * set) with the rewrites and
 * underscore-rule drops of the attempt whose rejection it carries reported
 * (#468), since without them the caller cannot tell a bad value from a key that
 * was moved or discarded, and with each alias sent beside its target named as
 * one in the hint (#639), since an unknown or dropped key would send the caller
 * looking for a typo. Its issues come from a parse with only the repairs that
 * held applied (#706), so a value the schema accepted once repaired is not
 * reported and one it refused is reported as sent — unless that parse
 * validates, which only a union or a cross-field refinement allows, and the
 * first parse is reported instead; the rejection itself never mentions a
 * repair. A value that held only written in place below a transform that
 * reorders or rewrites it is reported as sent too: the issues name positions in
 * the transform's output, where a repair written in place is not.
 *
 * The split between log and counter is deliberate, and lives in `telemetry.ts`.
 * Counter attributes are bounded and author- or framework-defined — the
 * ignore-list entry that matched, the declared key a rewrite resolved to —
 * because a metric label carrying the caller's own key text mints a permanent
 * time series per spelling a client invents (#114). The raw key and alias go to
 * the debug log, which is where an operator looks when a counter shows a new
 * client artifact and where cardinality costs nothing, at most their first
 * 1,024 characters bounding its size (#631) — and, on a rejection, back to the
 * caller who sent them, cut the same way (#648), since an error payload is per
 * call rather than a permanent series.
 *
 * @module src/mcp-server/tools/utils/arguments/index
 */

export { type ParseToolArgumentsOptions, parseToolArguments } from './parseToolArguments.js';
export { foldArgumentKey, type InputHandlingOptions } from './prevalidation.js';
export { argumentRejectionForLog, INVALID_ARGUMENTS_REASON } from './rejection.js';

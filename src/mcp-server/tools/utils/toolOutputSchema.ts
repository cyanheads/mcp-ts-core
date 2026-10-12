/**
 * @fileoverview The output schemas derived from a tool definition: the one a
 * successful result is parsed against, and the widened one `tools/list`
 * advertises so an error envelope validates in strict clients.
 * @module src/mcp-server/tools/utils/toolOutputSchema
 */

import { type ZodObject, type ZodRawShape, type ZodType, z } from 'zod';

import { terminateSentence } from '@/utils/formatting/sentence.js';
import type { AnyToolDefinition } from './toolDefinition.js';

/**
 * The schema the framework **parses** a successful result against: the declared
 * `output`, extended with the `enrichment` block when one is declared. Strict by
 * construction — a required enrichment field the handler never populated fails
 * here, surfacing the authoring bug loudly.
 *
 * This is deliberately *not* what is advertised — see
 * {@link advertisedOutputSchema}.
 */
export function effectiveOutputSchema(def: AnyToolDefinition): ZodObject<ZodRawShape> {
  if (!def.enrichment) return def.output;
  return def.output.extend(def.enrichment) as ZodObject<ZodRawShape>;
}

/**
 * The error envelope a tool can put on `structuredContent` when it fails,
 * mirroring {@link buildToolErrorResult}'s runtime shape.
 *
 * Loose at every level on purpose: `data` carries the throw site's arbitrary
 * keys alongside `reason` / `recovery` / `retryable`, and generic classified
 * errors carry no `data` at all. A strict declaration would recreate on the
 * error path the very `-32602` this envelope exists to prevent (#241).
 *
 * `data.reason` stays `type: 'string'` even when the definition declares an
 * `errors[]` contract. The contract covers what the *handler* throws; a service
 * it calls can throw its own `data.reason` (the SQL gate's `denied_function`,
 * the parser's `yaml_parse_failed`), which reaches the wire verbatim. Narrowing
 * to an enum would make a strict client reject exactly those envelopes with
 * `-32602` — the failure #241 exists to prevent. The declared reasons are
 * carried as `examples` plus their `when` text in the description instead:
 * documented, not enforced.
 */
function toolErrorEnvelopeSchema(def: AnyToolDefinition): ZodType {
  const contract = def.errors ?? [];
  const reasons = contract.map((entry) => entry.reason);
  const reasonSchema =
    reasons.length > 0
      ? z
          .string()
          .describe(
            `Machine-readable failure mode. Declared by this tool: ${contract
              .map((entry) => `\`${entry.reason}\`: ${terminateSentence(entry.when)}`)
              .join(' ')} Other values are possible when a failure originates below the handler.`,
          )
          .meta({ examples: reasons })
      : z.string().describe('Machine-readable failure mode.');

  return z.looseObject({
    code: z.number().int().describe('JSON-RPC error code for this failure.'),
    message: z.string().describe('Human-readable description of what went wrong.'),
    data: z
      .looseObject({
        reason: reasonSchema.optional(),
        recovery: z
          .looseObject({ hint: z.string() })
          .optional()
          .describe('Actionable next step for the caller.'),
        retryable: z.boolean().optional().describe('Whether retrying may succeed.'),
      })
      .optional(),
  });
}

/**
 * The `outputSchema` advertised to clients in `tools/list` — every success field
 * made optional, plus a declared `error` property (#241).
 *
 * A tool that fails returns `structuredContent: { error: … }`, which can never
 * satisfy a success-only schema. Clients shipping an SDK whose `callTool()`
 * validates `structuredContent` without first checking `isError` (every v1
 * client, and every caller pinned to one) reject that envelope with `-32602`
 * before the `isError` result reaches the agent. Widening the advertised schema
 * is the only fix a server can ship, because the validator runs in the caller.
 *
 * **The root stays `type: 'object'`.** A discriminated union is the natural
 * expression of success-or-error and is a trap: it emits `anyOf` with no `type`,
 * which SEP-2106's legacy projection classifies as a non-object root and
 * rewrites to `{ result: <natural> }` for every 2025-era client — silently
 * breaking the *success* path for existing consumers to fix the error path.
 *
 * The cost of the object form is that `required` drops. An `anyOf` refinement
 * carried in schema metadata recovers it: a result must satisfy either the
 * success branch (success fields present, no `error`) or the failure branch
 * (`error` present). `type: 'object'` is still there, so the projection does not
 * trip, and `{}` — a handler that returned nothing — is rejected, which the
 * success-only schema never caught either.
 *
 * Emission only. {@link buildToolSuccessResult} keeps parsing against
 * {@link effectiveOutputSchema}, so the required-enrichment authoring check is
 * unaffected.
 */
export function advertisedOutputSchema(def: AnyToolDefinition): ZodObject<ZodRawShape> {
  const success = effectiveOutputSchema(def);
  const requiredSuccessKeys = Object.entries(success.shape)
    .filter(([, field]) => !(field as ZodType).safeParse(undefined).success)
    .map(([key]) => key);

  // Rebuilt field by field rather than via `success.partial()`: Zod rejects
  // `.partial()` outright on an object carrying `.refine()` / `.superRefine()`
  // checks, and `tool()` accepts those (both return a `ZodObject`), so calling
  // it would throw at registration and take the whole server down at startup.
  // Object-level refinements are dropped here on purpose — this schema is
  // advertised, never parsed against, and JSON Schema cannot express them.
  const optionalShape = Object.fromEntries(
    Object.entries(success.shape).map(([key, field]) => [key, (field as ZodType).optional()]),
  ) as ZodRawShape;
  const catchall = success.def.catchall;
  const base =
    catchall === undefined ? z.object(optionalShape) : z.object(optionalShape).catchall(catchall);
  const widened = base.extend({
    error: toolErrorEnvelopeSchema(def)
      .optional()
      .describe('Present when the call failed. Absent on success.'),
  }) as ZodObject<ZodRawShape>;

  const successBranch = {
    not: { required: ['error'] },
    ...(requiredSuccessKeys.length > 0 && { required: requiredSuccessKeys }),
  };

  // `.meta()` last: `.extend()` discards metadata, so the refinement has to be
  // attached to the final widened object or it is lost before emission.
  return widened.meta({
    anyOf: [successBranch, { required: ['error'] }],
  }) as ZodObject<ZodRawShape>;
}

/**
 * @fileoverview Handler factory for tool definitions.
 * Constructs Context, checks inline auth, measures execution, formats response.
 * @module src/mcp-server/tools/utils/toolHandlerFactory
 */

import type {
  CallToolResult,
  ContentBlock,
  InputRequiredResult,
  ServerContext,
} from '@modelcontextprotocol/server';

import { ZodError, type ZodObject, type ZodRawShape, type ZodType, z } from 'zod';

import type { Context, EnrichmentStore } from '@/core/context.js';
import { readContentStore, readEnrichmentStore } from '@/core/context.js';
import {
  buildHandlerContext,
  type HandlerServices,
  handlerParentContext,
  resolveHandlerRequest,
} from '@/mcp-server/handlerContext.js';
import { isInputRequiredSignal } from '@/mcp-server/inputRequired.js';
import type { NotifierSources } from '@/mcp-server/notifications.js';
import { withRequiredScopes } from '@/mcp-server/transports/auth/lib/authUtils.js';
import { internalError, JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { measureToolExecution } from '@/utils/internal/performance.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { ATTR_MCP_TOOL_ENRICHED } from '@/utils/telemetry/attributes.js';
import type { AnyToolDefinition } from './toolDefinition.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The factory's own contract, shared with the resource factory. */
export type { HandlerServices } from '@/mcp-server/handlerContext.js';
export type { NotifierSources } from '@/mcp-server/notifications.js';

// ---------------------------------------------------------------------------
// Default formatter
// ---------------------------------------------------------------------------

const defaultResponseFormatter = (result: unknown): ContentBlock[] => [
  { type: 'text', text: JSON.stringify(result, null, 2) },
];

/**
 * Renders `content[]` for a validated tool result: `format()` (or the JSON
 * default) over the domain payload, with any blocks collected via
 * `ctx.content` (image/audio bytes) prepended. Collected blocks ride
 * `content[]` only — never `structuredContent` — so a handler can surface
 * media for the model without the base64 duplicating into the typed output.
 *
 * A formatter failure is isolated from handler failures so it classifies as
 * an internal error, carrying the formatter's own error as `cause`.
 */
export function renderToolContent(
  def: AnyToolDefinition,
  validatedOutput: Record<string, unknown>,
  ctx: Context,
): ContentBlock[] {
  let content: ContentBlock[];
  try {
    content = (def.format ?? defaultResponseFormatter)(validatedOutput);
  } catch (formatError) {
    throw internalError(
      `Output formatting failed: ${formatError instanceof Error ? formatError.message : String(formatError)}`,
      undefined,
      { cause: formatError },
    );
  }
  const collected = readContentStore(ctx)?.blocks;
  return collected && collected.length > 0 ? [...collected, ...content] : content;
}

// ---------------------------------------------------------------------------
// Error response shaping
// ---------------------------------------------------------------------------

/**
 * Pulls `data.recovery.hint` from an error data payload when present and
 * non-empty. Returns `undefined` otherwise. Used to mirror the hint into
 * `content[]` text so format()-only clients see the same recovery guidance
 * structuredContent-only clients receive via `error.data.recovery.hint`.
 */
function extractRecoveryHint(data: Record<string, unknown> | undefined): string | undefined {
  const hint = (data?.recovery as { hint?: unknown } | undefined)?.hint;
  return typeof hint === 'string' && hint.length > 0 ? hint : undefined;
}

/**
 * Shapes a `CallToolResult` for a tool error response with parity across both
 * surfaces clients forward to the agent:
 * - `content[]` — read by clients like Claude Desktop (markdown)
 * - `structuredContent.error` — read by clients like Claude Code (JSON)
 *
 * Both surfaces carry the same payload. When `data.recovery.hint` is present,
 * it is also mirrored into the `content[]` text so format()-only clients see
 * the recovery guidance.
 *
 * Note: `_meta.error` is intentionally NOT emitted — the error code, message,
 * and data live on `structuredContent.error` instead, mirroring the success
 * path's `structuredContent` surface.
 */
export function buildToolErrorResult(
  code: JsonRpcErrorCode,
  message: string,
  data: Record<string, unknown> | undefined,
): CallToolResult {
  const hint = extractRecoveryHint(data);
  const text = hint ? `Error: ${message}\n\nRecovery: ${hint}` : `Error: ${message}`;
  return {
    isError: true,
    content: [{ type: 'text', text }],
    structuredContent: {
      error: {
        code,
        message,
        ...(data !== undefined && { data }),
      },
    },
  };
}

/**
 * Renders an argument-validation failure the way the MCP SDK renders its own,
 * so the readable diagnostic — the offending key or field, and why it failed —
 * is unchanged for clients that read `content[]` text. The framework owns this
 * rejection (see `deferInputValidation`) purely so it can also carry
 * `structuredContent.error`.
 */
export function formatInputValidationMessage(toolName: string, error: ZodError): string {
  const detail = error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.map(String).join('.')}: ${issue.message}`
        : issue.message,
    )
    .join(', ');
  return `Input validation error: Invalid arguments for tool ${toolName}: ${detail}`;
}

/**
 * Builds an error `CallToolResult` from a raw thrown value. Classifies via
 * {@link ErrorHandler.classifyOnly} when the value isn't already an
 * `McpError`. Only propagates data from `McpError` (its declared `data`) or
 * `ZodError` (its `issues`) — other thrown values get a `structuredContent.error`
 * with `code` and `message` only, so internal classification context never
 * leaks to clients.
 *
 * Use after invoking {@link ErrorHandler.handleError} for OTel/logging side
 * effects — this helper does not log.
 */
export function classifyAndBuildToolErrorResult(error: unknown): CallToolResult {
  if (error instanceof McpError) {
    return buildToolErrorResult(error.code, error.message, error.data);
  }
  const { code, message } = ErrorHandler.classifyOnly(error);
  const data = error instanceof ZodError ? { issues: error.issues } : undefined;
  return buildToolErrorResult(code, message, data);
}

// ---------------------------------------------------------------------------
// Success response shaping — enrichment merge + trailer
// ---------------------------------------------------------------------------

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
              .map((entry) => `\`${entry.reason}\`: ${entry.when}`)
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

/** Renders a non-kind-tagged enrichment value as compact trailer text. */
function formatEnrichmentScalar(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * True when a rendered field's last line leaves open a CommonMark container that
 * lazy continuation would pull the next field into — a block quote (`>`) or a
 * list item (`-`, `+`, `*`, `1.`, `1)`), each indented up to three spaces.
 *
 * Keyed on the line, not the field kind: a custom `enrichmentTrailer.render` can
 * emit multi-line markdown whose final line is a quote or a bullet, and either
 * one swallows what follows exactly as a `notice` does.
 *
 * A list marker must be followed by a space or end the line, so `**0 total**`
 * and a `***` rule are not mistaken for bullets.
 */
function opensLazyContainer(text: string): boolean {
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  return /^ {0,3}(?:>|(?:[-+*]|\d{1,9}[.)])(?: |$))/.test(lastLine);
}

/**
 * Joins rendered fields into the trailer body, closing any open container before
 * the next field. CommonMark lazy continuation folds an unprefixed paragraph line
 * that follows a block quote or list item *into* it, so a bare `\n` would render
 * server-authored facts (totals, query echoes) as quoted text attributed to the
 * notice, or as the tail of somebody's last bullet. Emitting the blank line only
 * after those lines keeps the compact single-`\n` layout everywhere else.
 */
function joinTrailerFields(fields: string[]): string {
  let text = '';
  for (const field of fields) {
    if (text.length > 0) text += opensLazyContainer(text) ? '\n\n' : '\n';
    text += field;
  }
  return text;
}

/**
 * Renders accumulated enrichment as a single `content[]` trailer block, so
 * `content[]`-only clients see the same context `structuredContent` clients get
 * from the merged output. Per field, rendering resolves in order:
 *   1. a per-field `enrichmentTrailer.render` (the author's full control; wins
 *      over everything — the escape hatch for structured fields that would
 *      otherwise JSON-blob),
 *   2. the kind-tag set by a field-helper (notice → blockquote, total →
 *      "N total", echo → "Query: …", delta → "field: before → after"),
 *   3. the generic `**key:** value` fallback (key overridable via `label`),
 *      `JSON.stringify`-ing non-scalars.
 *
 * `parsed` is the validated effective output, so renderers receive the typed,
 * post-parse value rather than the raw accumulator entry. The rendered markdown
 * is appended to `content[]` only — `structuredContent` is built separately from
 * the raw merged values and never carries this trailer text. The trailer text
 * leads with a blank-line separator so it stands off the preceding block on
 * clients that concatenate adjacent text blocks with no join (#257); markdown
 * collapses consecutive blank lines, so clients that do insert their own
 * separator render at most one blank line either way. Fields are joined by
 * {@link joinTrailerFields}, which terminates block quotes so a following field
 * renders as its own block (#308). Returns `[]` when nothing was enriched.
 */
function renderEnrichmentTrailer(
  store: EnrichmentStore,
  trailer: AnyToolDefinition['enrichmentTrailer'],
  parsed: Record<string, unknown>,
): ContentBlock[] {
  const fields: string[] = [];
  for (const key of Object.keys(store.values)) {
    // Skip keys the effective-output parse stripped (enriched but not declared in
    // the block) — the trailer mirrors what reached structuredContent.
    if (!(key in parsed)) continue;
    const value = parsed[key];
    const cfg = trailer?.[key];
    if (cfg?.render) {
      fields.push(cfg.render(value));
      continue;
    }
    switch (store.kinds.get(key)) {
      case 'notice':
        fields.push(`> ${String(value)}`);
        break;
      case 'total':
        fields.push(`**${String(value)} total**`);
        break;
      case 'echo':
        fields.push(`Query: ${String(value)}`);
        break;
      case 'delta': {
        const d = (value ?? {}) as { after?: unknown; before?: unknown };
        fields.push(
          `**${cfg?.label ?? key}:** ${formatEnrichmentScalar(d.before)} → ${formatEnrichmentScalar(d.after)}`,
        );
        break;
      }
      default:
        fields.push(`**${cfg?.label ?? key}:** ${formatEnrichmentScalar(value)}`);
    }
  }
  return fields.length > 0 ? [{ type: 'text', text: `\n\n${joinTrailerFields(fields)}` }] : [];
}

/**
 * Shapes the success `CallToolResult` surfaces from the validated domain payload
 * plus any accumulated enrichment:
 * - `structuredContent` — domain output merged with enrichment (validated against
 *   `output.extend(enrichment)`); the bare domain output when no enrichment block.
 * - `content[]` — the caller-rendered domain content (from `format()` or the
 *   JSON-stringify default, applied to the **domain payload only**) with the
 *   enrichment trailer always appended. Rendering the domain payload — never the
 *   merged object — keeps enrichment out of the JSON blob and avoids double-render.
 *
 * A required enrichment field the handler never populated fails the parse here,
 * surfacing the authoring bug as a loud error rather than dropping it silently.
 */
export function buildToolSuccessResult(
  def: AnyToolDefinition,
  ctx: Context,
  domainValidated: Record<string, unknown>,
  domainContent: ContentBlock[],
): Pick<CallToolResult, 'content' | 'structuredContent'> {
  if (!def.enrichment) {
    return { structuredContent: domainValidated, content: domainContent };
  }
  const store = readEnrichmentStore(ctx);
  const values = store?.values ?? {};
  const structuredContent = effectiveOutputSchema(def).parse({
    ...domainValidated,
    ...values,
  }) as Record<string, unknown>;
  const trailer =
    store && Object.keys(values).length > 0
      ? renderEnrichmentTrailer(store, def.enrichmentTrailer, structuredContent)
      : [];
  return {
    structuredContent,
    content: trailer.length > 0 ? [...domainContent, ...trailer] : domainContent,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an MCP tool handler from a tool definition.
 * The returned function is compatible with the MCP SDK's ToolCallback type.
 *
 * Responsibilities:
 * - Creates RequestContext from SDK context (for tracing)
 * - Creates unified Context (for the handler)
 * - Checks inline `auth` scopes if defined
 * - Validates input via Zod schema
 * - Measures execution time
 * - Formats response via `format` or JSON default
 * - Catches errors and returns `isError: true`
 */
export function createToolHandler(
  def: AnyToolDefinition,
  services: HandlerServices,
  notifiers: NotifierSources,
): (
  input: Record<string, unknown>,
  ctx: ServerContext,
) => Promise<CallToolResult | InputRequiredResult> {
  return async (input, serverContext): Promise<CallToolResult | InputRequiredResult> => {
    const request = resolveHandlerRequest(serverContext, services, notifiers);
    const appContext = requestContextService.createRequestContext({
      parentContext: handlerParentContext(request),
      operation: 'HandleToolRequest',
      additionalContext: { toolName: def.name },
    });

    try {
      // Check inline auth scopes
      if (def.auth && def.auth.length > 0) {
        withRequiredScopes(def.auth, appContext);
      }

      // Validate input. The SDK's own argument check is deliberately deferred
      // to here (see `deferInputValidation`) so a rejection carries the
      // structured error envelope; the message and `InvalidParams`
      // classification match what the SDK produced before (#377).
      const parsedInput = def.input.safeParse(input);
      if (!parsedInput.success) {
        throw new McpError(
          JsonRpcErrorCode.InvalidParams,
          formatInputValidationMessage(def.name, parsedInput.error),
          { issues: parsedInput.error.issues },
        );
      }
      const validatedInput = parsedInput.data;

      // Read by the success-attributes thunk below, which the measurement
      // evaluates after the callback settles.
      let ctx: Context | undefined;

      // Execute the handler AND the success-response pipeline under one
      // measurement. Output-schema validation, `format()`, the enrichment
      // merge, and the trailer render all decide the client-visible outcome,
      // so a failure in any of them is a failed call — closing the span when
      // the handler returned recorded those as successes (#346).
      return await measureToolExecution(
        async (spanContext, recordOutput) => {
          const handlerCtx = buildHandlerContext(request, services, spanContext, def.errors);
          ctx = handlerCtx;

          // Handler may return sync or async.
          const handlerResult = await def.handler(validatedInput, handlerCtx);

          // The domain value is what `mcp.tool.output_bytes` and
          // partial-success detection measure — not the assembled result this
          // callback returns, which re-renders it into content[].
          recordOutput(handlerResult);

          // Render content[] from the domain payload only (Resolution B), then
          // merge enrichment into structuredContent and append the content[] trailer.
          const validatedResult = def.output.parse(handlerResult) as Record<string, unknown>;
          return buildToolSuccessResult(
            def,
            handlerCtx,
            validatedResult,
            renderToolContent(def, validatedResult, handlerCtx),
          );
        },
        { ...appContext, toolName: def.name },
        validatedInput,
        () => {
          const store = ctx ? readEnrichmentStore(ctx) : undefined;
          return store && Object.keys(store.values).length > 0
            ? { [ATTR_MCP_TOOL_ENRICHED]: true }
            : {};
        },
      );
    } catch (error: unknown) {
      // `ctx.requestInput(...)` is protocol control flow, not a failure: return
      // the `input_required` result untouched, with no span, log, or
      // classification. The client (2026 era) or the SDK's legacy shim (2025
      // era) fulfils it and re-invokes this handler.
      if (isInputRequiredSignal(error)) return error.result;

      ErrorHandler.handleError(error, {
        operation: `tool:${def.name}`,
        context: appContext,
      });
      return classifyAndBuildToolErrorResult(error);
    }
  };
}

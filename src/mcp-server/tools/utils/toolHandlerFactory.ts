/**
 * @fileoverview Handler factory for tool definitions.
 * Constructs Context, checks inline auth, measures execution, formats response.
 * @module src/mcp-server/tools/utils/toolHandlerFactory
 */

import type {
  CallToolResult,
  InputRequiredResult,
  ServerContext,
} from '@modelcontextprotocol/server';

import { config } from '@/config/index.js';
import type { Context } from '@/core/context.js';
import { readEnrichmentStore, resolveDeclaredFailure } from '@/core/context.js';
import {
  buildHandlerContext,
  type HandlerServices,
  handlerParentContext,
  resolveHandlerRequest,
} from '@/mcp-server/handlerContext.js';
import {
  CLIENT_CAPABILITY_MISSING_REASON,
  type ClientCapabilityView,
  isInputRequiredSignal,
  sealSignal,
} from '@/mcp-server/inputRequired.js';
import type { NotifierSources } from '@/mcp-server/notifications.js';
import { isScopeRefusal, withRequiredScopes } from '@/mcp-server/transports/auth/lib/authUtils.js';
import {
  type ErrorContract,
  type ErrorContractSeverity,
  JsonRpcErrorCode,
  McpError,
} from '@/types-global/errors.js';
import { resolvePartialResultKeys } from '@/utils/formatting/partialResult.js';
import { asRequestCancelled, ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { isInstance, readErrorData } from '@/utils/internal/error-handler/helpers.js';
import { measureToolExecution, recordToolRejection } from '@/utils/internal/performance.js';
import {
  type RequestContext,
  requestContextService,
  withExtra,
} from '@/utils/internal/requestContext.js';
import { TOOL_FAILURE_PAYLOAD_MESSAGE_PREFIX } from '@/utils/internal/telemetryMessages.js';
import { sanitization } from '@/utils/security/sanitization.js';
import { ATTR_MCP_TOOL_ENRICHED } from '@/utils/telemetry/attributes.js';
import {
  argumentRejectionForLog,
  INVALID_ARGUMENTS_REASON,
  parseToolArguments,
} from './arguments/index.js';
import type { AnyToolDefinition } from './toolDefinition.js';
import {
  buildToolSuccessResult,
  classifyAndBuildToolErrorResult,
  parseToolOutput,
  renderToolContent,
} from './toolResult.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The factory's own contract, shared with the resource factory. */
export type { HandlerServices } from '@/mcp-server/handlerContext.js';
export type { NotifierSources } from '@/mcp-server/notifications.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * The two reasons the framework raises itself, both a refusal of the call
 * rather than a fault in this server: `invalid_arguments`, only from the schema
 * gate in {@link parseToolArguments}, and `client_capability_missing`, only
 * from `ctx.requestInput`'s capability gate.
 */
const FRAMEWORK_REFUSAL_REASONS: ReadonlySet<string> = new Set([
  INVALID_ARGUMENTS_REASON,
  CLIENT_CAPABILITY_MISSING_REASON,
]);

/**
 * The level the `Error in tool:<name>` record is emitted at, or `undefined` to
 * keep `error`.
 *
 * A severity the matched `errors[]` entry declares wins (#380). Otherwise one
 * of the framework's own refusals logs at `notice`: a reason in
 * {@link FRAMEWORK_REFUSAL_REASONS} (#567) — a caller's arguments failing the
 * tool's schema, or a client connection that cannot serve an input request —
 * and a scope check's missing-scope refusal (#585), from the inline `auth`
 * check or a handler's `checkScopes`, recognized by the mark those utilities
 * put on it rather than by its `Forbidden` code. Each is routine traffic, and a
 * schema that wrongly rejects valid calls still shows per tool on
 * `mcp.tool.rejections`. Everything else — a plain `Error`, an undeclared
 * reason, an entry with no severity, a missing auth context, a handler's own
 * `forbidden()`, an upstream 403, an output-contract failure — keeps `error`.
 * A cancellation takes `handleError`'s own `info` path whatever this returns.
 * The three framework refusals also log without a stack, whatever level this
 * resolves for them (#651).
 *
 * Resolved here rather than in `ErrorHandler`, which also serves services,
 * prompts, and transports and knows neither the definition nor the schema gate.
 * `reason` is the failure's `data.reason`, as {@link readErrorData} reads it.
 */
function failureSeverity(
  entry: ErrorContract | undefined,
  failure: unknown,
  reason: unknown,
): ErrorContractSeverity | undefined {
  if (entry?.severity !== undefined) return entry.severity;
  if (isScopeRefusal(failure)) return 'notice';
  return typeof reason === 'string' && FRAMEWORK_REFUSAL_REASONS.has(reason) ? 'notice' : undefined;
}

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
 * - Catches errors and returns `isError: true`, counting one raised before the
 *   measured region (the scope check, argument validation) on `mcp.tool.rejections`
 */
export function createToolHandler(
  def: AnyToolDefinition,
  services: HandlerServices,
  notifiers: NotifierSources,
  capabilities?: ClientCapabilityView,
): (
  input: Record<string, unknown>,
  ctx: ServerContext,
) => Promise<CallToolResult | InputRequiredResult> {
  // The handler's return value carries no marker, so the arrays partial-success
  // telemetry reads are named by the output schema — resolved once here (#524).
  const partialResultKeys = resolvePartialResultKeys(def.output.shape);

  return async (input, serverContext): Promise<CallToolResult | InputRequiredResult> => {
    const request = resolveHandlerRequest(serverContext, services, notifiers);
    const appContext = requestContextService.createRequestContext({
      parentContext: handlerParentContext(serverContext),
      operation: 'HandleToolRequest',
      additionalContext: { toolName: def.name },
    });
    // Set once the call reaches the measured region; a failure before it is a
    // rejection the call and error counters never see (#546).
    let measured = false;

    try {
      // Check inline auth scopes
      if (def.auth && def.auth.length > 0) {
        withRequiredScopes(def.auth, appContext);
      }

      // Validate input. The SDK's own argument check is deliberately deferred
      // to here (see `deferInputValidation`) so a rejection carries the
      // structured error envelope; the message and `InvalidParams`
      // classification match what the SDK produced before (#377).
      const validatedInput = parseToolArguments(def, input, {
        context: appContext,
        ...(services.input && { input: services.input }),
      });

      // Read by the success-attributes thunk below, which the measurement
      // evaluates after the callback settles.
      let ctx: Context | undefined;

      // Execute the handler AND the success-response pipeline under one
      // measurement. Output-schema validation, `format()`, the enrichment
      // merge, and the trailer render all decide the client-visible outcome,
      // so a failure in any of them is a failed call — closing the span when
      // the handler returned recorded those as successes (#346).
      measured = true;
      return await measureToolExecution(
        async (spanContext, recordOutput) => {
          const handlerCtx = buildHandlerContext(
            request,
            services,
            spanContext,
            def.errors,
            capabilities,
          );
          ctx = handlerCtx;

          try {
            // Handler may return sync or async.
            const handlerResult = await def.handler(validatedInput, handlerCtx);
            // A handler that caught the abort and returned — a fan-out folding
            // the aborted leg into a partial result, an early `return` on
            // `ctx.signal.aborted` — settles as the cancellation it is, through
            // the catch below, before its result is measured (#753).
            request.signal.throwIfAborted();

            // The domain value is what `mcp.tool.output_bytes` and
            // partial-success detection measure — not the assembled result this
            // callback returns, which re-renders it into content[].
            recordOutput(handlerResult);

            // Render content[] from the domain payload only (Resolution B), then
            // merge enrichment into structuredContent and append the content[] trailer.
            const validatedResult = parseToolOutput(def, handlerResult);
            return buildToolSuccessResult(
              def,
              handlerCtx,
              validatedResult,
              renderToolContent(def, validatedResult, handlerCtx),
            );
          } catch (error) {
            // Inside the measurement on purpose: the completion log's
            // `metrics.errorCode` and the span's error-code attribute are
            // derived from what leaves this callback (#421). An input-required
            // signal leaves with its `requestState` sealed when a key is
            // configured, so a sealing failure is a failed call like any other;
            // anything else leaves as itself, never awaited (#697).
            throw asRequestCancelled(
              isInputRequiredSignal(error)
                ? await sealSignal(error, services.requestState, serverContext)
                : error,
              request.signal,
            );
          }
        },
        { ...appContext, toolName: def.name },
        validatedInput,
        () => {
          const store = ctx ? readEnrichmentStore(ctx) : undefined;
          return store && Object.keys(store.values).length > 0
            ? { [ATTR_MCP_TOOL_ENRICHED]: true }
            : {};
        },
        partialResultKeys,
      );
    } catch (error: unknown) {
      // `ctx.requestInput(...)` is protocol control flow, not a failure: return
      // the `input_required` result — its `requestState` already sealed when a
      // key is configured — with no span, log, or classification. The client
      // (2026 era) or the SDK's legacy shim (2025 era) fulfils it and
      // re-invokes this handler. A request this connection cannot serve never
      // reaches here as a signal — `ctx.requestInput` throws the refusal
      // instead, and it arrives below as an `McpError`.
      if (isInputRequiredSignal(error)) return error.result;

      // One reason-to-entry lookup: the declared recovery fills a failure that
      // carries none (#579) and the entry's severity sets the log level (#380,
      // #567). Filled before `handleError`, so the error record, the envelope,
      // and the failure-payload record carry the same hint.
      const { entry, failure } = resolveDeclaredFailure(def.errors, error);
      // Read once, through a copy: the failure may be a thrown value whose
      // `data` cannot be read (#697).
      const reason = readErrorData(failure)?.reason;
      const severity = failureSeverity(entry, failure, reason);
      // The schema gate's rejection, raised before the handler ran (#631).
      const isArgumentRejection =
        !measured && isInstance(failure, McpError) && reason === INVALID_ARGUMENTS_REASON;
      // The capability gate's refusal, recognized by its reserved reason.
      const capabilityRefusal = reason === CLIENT_CAPABILITY_MISSING_REASON;
      // No framework refusal is a fault in this server, so a stack would name
      // only the gate that refused it and the line that called it — at
      // whatever level an `errors[]` entry declares (#585, #631, #651).
      ErrorHandler.handleError(isArgumentRejection ? argumentRejectionForLog(failure) : failure, {
        operation: `tool:${def.name}`,
        context: appContext,
        ...(severity !== undefined && { severity }),
        ...((isArgumentRejection || capabilityRefusal || isScopeRefusal(failure)) && {
          includeStack: false,
        }),
      });
      if (!measured) recordToolRejection(def.name, failure);
      const result = classifyAndBuildToolErrorResult(failure, appContext.requestId);
      if (config.logToolFailurePayloads) {
        logFailurePayload(services.logger, def.name, appContext, input, result, severity);
      }
      return result;
    }
  };
}

/**
 * Writes the opt-in failed-call payload record (#291): the arguments as the
 * caller sent them — before pre-validation drops or renames a key — and the
 * `CallToolResult` the client receives, each redacted, serialized, and capped
 * on its own by `sanitization.serializeForLogging`.
 *
 * Logged at the level of the call's own error record and with the same request
 * context, so the two filter and correlate together. Its message starts with
 * {@link TOOL_FAILURE_PAYLOAD_MESSAGE_PREFIX}, which the logger exempts from
 * rate limiting, so every failed call keeps its record (#735). A cancellation
 * writes nothing: its error record is a routine `info` line, and the caller
 * that would have read the result is gone.
 */
function logFailurePayload(
  log: HandlerServices['logger'],
  toolName: string,
  context: RequestContext,
  input: unknown,
  result: CallToolResult,
  severity: ErrorContractSeverity | undefined,
): void {
  const { code } = (result.structuredContent as { error: { code: JsonRpcErrorCode } }).error;
  if (code === JsonRpcErrorCode.RequestCancelled) return;

  const maxBytes = config.logToolFailurePayloadMaxBytes;
  const toolInput = sanitization.serializeForLogging(input, maxBytes);
  const toolResult = sanitization.serializeForLogging(result, maxBytes);
  log[severity ?? 'error'](
    `${TOOL_FAILURE_PAYLOAD_MESSAGE_PREFIX}${toolName}`,
    withExtra(context, {
      toolInput: toolInput.text,
      toolInputTruncated: toolInput.truncated,
      toolResult: toolResult.text,
      toolResultTruncated: toolResult.truncated,
    }),
  );
}

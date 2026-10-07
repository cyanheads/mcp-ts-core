/**
 * @fileoverview Handler factory for resource definitions.
 * Constructs Context (with `uri`), checks inline auth, validates params, formats response.
 * @module src/mcp-server/resources/utils/resourceHandlerFactory
 */

import type {
  InputRequiredResult,
  ReadResourceResult,
  ServerContext,
  Variables,
} from '@modelcontextprotocol/server';

import { resolveDeclaredFailure } from '@/core/context.js';
import {
  buildHandlerContext,
  type HandlerServices,
  handlerParentContext,
  resolveHandlerRequest,
} from '@/mcp-server/handlerContext.js';
import {
  type ClientCapabilityView,
  isInputRequiredSignal,
  sealSignal,
} from '@/mcp-server/inputRequired.js';
import type { NotifierSources } from '@/mcp-server/notifications.js';
import { parseOutputContract } from '@/mcp-server/outputContract.js';
import type { AnyResourceDefinition } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { withRequiredScopes } from '@/mcp-server/transports/auth/lib/authUtils.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { asRequestCancelled, ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { isInstance, readErrorData, UNREADABLE } from '@/utils/internal/error-handler/helpers.js';
import {
  capForObservability,
  OBSERVABILITY_MAX_STRING_LENGTH,
} from '@/utils/internal/observabilityCap.js';
import { measureResourceExecution } from '@/utils/internal/performance.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The factory's own contract, shared with the tool factory. */
export type { HandlerServices } from '@/mcp-server/handlerContext.js';
export type { NotifierSources } from '@/mcp-server/notifications.js';

// ---------------------------------------------------------------------------
// Default formatter
// ---------------------------------------------------------------------------

function isJsonMimeType(mimeType: string): boolean {
  const normalizedMimeType = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return normalizedMimeType === 'application/json' || normalizedMimeType.endsWith('+json');
}

function formatResourceText(result: unknown, mimeType: string): string {
  return typeof result === 'string' && !isJsonMimeType(mimeType)
    ? result
    : JSON.stringify(result, null, 2);
}

/**
 * Default `resources/read` contents when a definition declares no `format`:
 * a string result is passed through for text MIME types, anything else is
 * pretty-printed JSON. Also the fallback `appResource()` mirrors UI meta into.
 */
export function defaultResponseFormatter(
  result: unknown,
  meta: { uri: URL; mimeType: string },
): ReadResourceResult['contents'] {
  const text = formatResourceText(result, meta.mimeType);
  return [
    {
      uri: meta.uri.href,
      text,
      mimeType: meta.mimeType,
    },
  ];
}

/**
 * The URI a read's log records and span carry: userinfo, query, and fragment
 * stripped — they commonly carry credentials or caller secrets — then cut to
 * its first {@link OBSERVABILITY_MAX_STRING_LENGTH} characters, since a client
 * sets its length. `uriLength` is the uncut projection's length, present only
 * when the cut removed something. The handler's `ctx.uri` and the response
 * keep the original URI; this projection is observability-only.
 */
function observableResourceUri(uri: URL): { uri: string; uriLength?: number } {
  const safe = new URL(uri.href);
  safe.username = '';
  safe.password = '';
  safe.search = '';
  safe.hash = '';
  const { value, length } = capForObservability(safe.href);
  return { uri: value, ...(length !== undefined && { uriLength: length }) };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an MCP resource read handler from a resource definition.
 * The returned function is compatible with the MCP SDK's resource callback type.
 *
 * Responsibilities:
 * - Creates RequestContext from SDK context (for tracing)
 * - Creates unified Context with `ctx.uri` set
 * - Checks inline `auth` scopes if defined
 * - Validates params via Zod schema
 * - Formats response via `format` or JSON default
 * - Catches errors and re-throws for the SDK, with the declared recovery filled
 *   (#579) and the read's request id added (#576)
 */
export function createResourceHandler(
  def: AnyResourceDefinition,
  services: HandlerServices,
  notifiers: NotifierSources,
  capabilities?: ClientCapabilityView,
): (
  uri: URL,
  variables: Variables,
  ctx: ServerContext,
) => Promise<ReadResourceResult | InputRequiredResult> {
  const mimeType = def.mimeType ?? 'application/json';
  const formatter = def.format ?? defaultResponseFormatter;
  const resourceName = def.name ?? def.uriTemplate;

  return async (
    uri,
    variables,
    serverContext,
  ): Promise<ReadResourceResult | InputRequiredResult> => {
    const request = resolveHandlerRequest(serverContext, services, notifiers);
    const observed = observableResourceUri(uri);

    // The URI template already captures the named segments; anything else is
    // query-string / caller-supplied and belongs in metrics, not logs.
    const appContext = requestContextService.createRequestContext({
      parentContext: handlerParentContext(serverContext),
      operation: 'HandleResourceRead',
      additionalContext: {
        resourceName,
        resourceUri: observed.uri,
        ...(observed.uriLength !== undefined && { resourceUriLength: observed.uriLength }),
        resourceHasQuery: uri.search.length > 0,
      },
    });

    try {
      // Check inline auth scopes
      if (def.auth && def.auth.length > 0) {
        withRequiredScopes(def.auth, appContext);
      }

      // Validate params via schema if defined
      const validatedParams = def.params ? def.params.parse(variables) : variables;

      // Execute the handler AND the response pipeline under one measurement:
      // output-schema validation and `format()` decide the client-visible
      // outcome, so a failure in either is a failed read. Closing the span when
      // the handler returned recorded those as successes (#346).
      return await measureResourceExecution(
        async (spanContext, recordOutput) => {
          const ctx = buildHandlerContext(
            request,
            services,
            spanContext,
            def.errors,
            capabilities,
            uri,
          );

          try {
            // Handler may return sync or async.
            const handlerResult = await def.handler(validatedParams, ctx);

            // The domain value is what `mcp.resource.output_bytes` measures — not
            // the assembled `contents` this callback returns.
            recordOutput(handlerResult);

            // Validate output against schema when defined; a violation is a
            // server fault, `InternalError` naming the contract (#480).
            const validatedResult = def.output
              ? parseOutputContract(def.output, handlerResult, {
                  kind: 'Resource',
                  name: resourceName,
                  contract: 'output',
                })
              : handlerResult;

            return { contents: formatter(validatedResult, { uri, mimeType }) };
          } catch (error) {
            // Inside the measurement on purpose: the completion log's
            // `metrics.errorCode` and the span's error-code attribute are
            // derived from what leaves this callback (#421). An input-required
            // signal leaves with its `requestState` sealed when a key is
            // configured, so a sealing failure is a failed read like any other;
            // anything else leaves as itself, never awaited (#697).
            throw asRequestCancelled(
              isInputRequiredSignal(error)
                ? await sealSignal(error, services.requestState, serverContext)
                : error,
              request.signal,
            );
          }
        },
        { ...appContext, resourceName },
        { ...observed, mimeType },
      );
    } catch (error: unknown) {
      // `ctx.requestInput(...)` is protocol control flow, not a failure —
      // `resources/read` honors `input_required` on the 2026-07-28 revision.
      // A request this connection cannot serve never reaches here as a signal:
      // `ctx.requestInput` throws the refusal instead, and it arrives below as
      // an `McpError` carrying the reason and hint (#379).
      if (isInputRequiredSignal(error)) return error.result;

      // Classified without logging: the completion record carries the code.
      const { failure } = resolveDeclaredFailure(def.errors, asMcpError(error));
      throw withRequestId(failure, appContext.requestId);
    }
  };
}

/** The thrown value as an `McpError`, classified by {@link ErrorHandler.classifyOnly} when it is not one. */
function asMcpError(error: unknown): McpError {
  if (isInstance(error, McpError)) return error;
  const { code, message, data } = ErrorHandler.classifyOnly(error);
  return new McpError(code, message, data, { cause: error });
}

/**
 * The error the SDK serializes into the read's JSON-RPC `error`, carrying the
 * read's `requestId` as `data.requestId` (#576) — the id its completion record
 * logs — so a failure reported from the client can be matched to that record.
 * Set after the thrown data, so the framework's value replaces a thrown one.
 *
 * A `-32602` whose `data` is exactly `{ uri }` passes through untouched: it is
 * the spec's resource-not-found shape, which clients recognize by that exact
 * `data`.
 *
 * Never throws on the thrown error (#697): its `code`, `message`, and `data`
 * are read as {@link ErrorHandler.classifyOnly} reads them, so one that cannot
 * be read is `InternalError`, `'[Unreadable]'`, or left out. A not-found error
 * whose message cannot be read is rebuilt with the same `{ uri }`, so the SDK
 * never reads the thrown one.
 */
function withRequestId(error: McpError, requestId: string): McpError {
  const { code, message } = ErrorHandler.classifyOnly(error);
  const data = readErrorData(error);
  const isResourceNotFound =
    code === JsonRpcErrorCode.InvalidParams &&
    data !== undefined &&
    typeof data.uri === 'string' &&
    Object.keys(data).length === 1;
  if (isResourceNotFound) {
    return message === UNREADABLE ? new McpError(code, message, data, { cause: error }) : error;
  }
  return new McpError(code, message, { ...data, requestId }, { cause: error });
}

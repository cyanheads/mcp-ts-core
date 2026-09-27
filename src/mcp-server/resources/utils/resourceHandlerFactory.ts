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
  sealThrown,
} from '@/mcp-server/inputRequired.js';
import type { NotifierSources } from '@/mcp-server/notifications.js';
import { parseOutputContract } from '@/mcp-server/outputContract.js';
import type { AnyResourceDefinition } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { withRequiredScopes } from '@/mcp-server/transports/auth/lib/authUtils.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { asRequestCancelled, ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
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

/** Strip URL components that commonly carry credentials or caller secrets
 * before the URI reaches logs or telemetry. The protocol response still uses
 * the original URI; this projection is observability-only. */
function observableResourceUri(uri: URL): string {
  const safe = new URL(uri.href);
  safe.username = '';
  safe.password = '';
  safe.search = '';
  safe.hash = '';
  return safe.href;
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
    const resourceUri = observableResourceUri(uri);

    // The URI template already captures the named segments; anything else is
    // query-string / caller-supplied and belongs in metrics, not logs.
    const appContext = requestContextService.createRequestContext({
      parentContext: handlerParentContext(serverContext),
      operation: 'HandleResourceRead',
      additionalContext: {
        resourceName,
        resourceUri,
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
            // configured, so a sealing failure is a failed read like any other.
            throw asRequestCancelled(
              await sealThrown(error, services.requestState, serverContext),
              request.signal,
            );
          }
        },
        { ...appContext, resourceName },
        { uri: resourceUri, mimeType },
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
  if (error instanceof McpError) return error;
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
 */
function withRequestId(error: McpError, requestId: string): McpError {
  const { data } = error;
  const isResourceNotFound =
    error.code === JsonRpcErrorCode.InvalidParams &&
    data !== undefined &&
    typeof data.uri === 'string' &&
    Object.keys(data).length === 1;
  if (isResourceNotFound) return error;
  return new McpError(error.code, error.message, { ...data, requestId }, { cause: error });
}

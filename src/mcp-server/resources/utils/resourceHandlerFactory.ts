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

import {
  buildHandlerContext,
  type HandlerServices,
  handlerParentContext,
  resolveHandlerRequest,
} from '@/mcp-server/handlerContext.js';
import { isInputRequiredSignal } from '@/mcp-server/inputRequired.js';
import type { NotifierSources } from '@/mcp-server/notifications.js';
import type { AnyResourceDefinition } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { withRequiredScopes } from '@/mcp-server/transports/auth/lib/authUtils.js';
import { McpError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
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
 * - Catches errors and re-throws for the SDK
 */
export function createResourceHandler(
  def: AnyResourceDefinition,
  services: HandlerServices,
  notifiers: NotifierSources,
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
      parentContext: handlerParentContext(request),
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
          const ctx = buildHandlerContext(request, services, spanContext, def.errors, uri);

          // Handler may return sync or async.
          const handlerResult = await def.handler(validatedParams, ctx);

          // The domain value is what `mcp.resource.output_bytes` measures — not
          // the assembled `contents` this callback returns.
          recordOutput(handlerResult);

          // Validate output against schema when defined
          const validatedResult = def.output ? def.output.parse(handlerResult) : handlerResult;

          return { contents: formatter(validatedResult, { uri, mimeType }) };
        },
        { ...appContext, resourceName },
        { uri: resourceUri, mimeType },
      );
    } catch (error: unknown) {
      // `ctx.requestInput(...)` is protocol control flow, not a failure —
      // `resources/read` honors `input_required` on the 2026-07-28 revision.
      if (isInputRequiredSignal(error)) return error.result;

      // Classify without logging — the SDK logs when it catches the thrown error.
      if (error instanceof McpError) {
        throw error;
      }
      const { code, message, data } = ErrorHandler.classifyOnly(error);
      throw new McpError(code, message, data, { cause: error });
    }
  };
}

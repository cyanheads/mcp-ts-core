/**
 * @fileoverview Handler factory for resource definitions.
 * Constructs Context (with `uri`), checks inline auth, validates params, formats response.
 * @module src/mcp-server/resources/utils/resourceHandlerFactory
 */

import type {
  InputRequiredResult,
  ReadResourceResult,
  ServerContext,
  ServerNotifier,
  Variables,
} from '@modelcontextprotocol/server';

import { config } from '@/config/index.js';
import { attachTypedFail, createContext } from '@/core/context.js';
import {
  createContextInputs,
  createRequestInput,
  isInputRequiredSignal,
} from '@/mcp-server/inputRequired.js';
import { type ResourceSubscriptions, selectNotifiers } from '@/mcp-server/notifications.js';
import type { AnyResourceDefinition } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { withRequiredScopes } from '@/mcp-server/transports/auth/lib/authUtils.js';
import { resolveSessionMode } from '@/mcp-server/types.js';
import type { StorageService } from '@/storage/core/StorageService.js';
import { McpError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import type { Logger } from '@/utils/internal/logger.js';
import { measureResourceExecution } from '@/utils/internal/performance.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Services required by the handler factory to construct Context. */
export interface ResourceHandlerFactoryServices {
  /**
   * When true, surface `ctx.sessionId` even in stateless HTTP mode (per-request
   * generated token). Wired from `createApp({ context: { exposeStatelessSessionId } })`.
   * Default false — `ctx.sessionId` is only set when the session has
   * request-spanning lifetime (HTTP `stateful` / `auto` mode).
   */
  exposeStatelessSessionId?: boolean;
  logger: Logger;
  storage: StorageService;
}

/**
 * Per-server notifier closures bound at registration time, targeting
 * `server.send*ListChanged()`.
 *
 * Split from {@link ResourceHandlerFactoryServices} so each per-request
 * McpServer gets its own notifier closures — preventing a concurrent
 * registerAll() from overwriting an in-flight handler's notifier target.
 *
 * The resource handler factory picks a delivery path per era via
 * {@link selectNotifiers}, and uses these closures only as a fallback for
 * scopes with neither a bus nor a request sender (stdio, test harnesses).
 */
export interface ResourceHandlerNotifiers {
  /**
   * Publish facade for the modern era's `subscriptions/listen` bus, supplied
   * only for `modern` instances. Takes precedence over the request-scoped path:
   * on 2026-07-28 the client opts into notification types through its listen
   * stream, and only what reaches the bus is filtered against that opt-in
   * (#193).
   */
  bus?: ServerNotifier;
  notifyPromptListChanged?: () => void;
  notifyResourceListChanged?: () => void;
  notifyResourceUpdated?: (uri: string) => void;
  notifyToolListChanged?: () => void;
  /** Per-connection `resources/subscribe` registry (#354). Legacy era only. */
  subscriptions?: ResourceSubscriptions;
}

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

function defaultResponseFormatter(
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
  services: ResourceHandlerFactoryServices,
  notifiers: ResourceHandlerNotifiers,
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
    const mcpReq = serverContext?.mcpReq;
    const signal = mcpReq?.signal ?? new AbortController().signal;

    const effectiveNotifiers = selectNotifiers(notifiers, mcpReq);

    const sdkSessionId =
      typeof serverContext?.sessionId === 'string' ? serverContext.sessionId : undefined;

    // Surface sessionId on `Context` only when it has request-spanning
    // lifetime — stateful HTTP (or `auto`, which resolves to stateful for
    // HTTP). In stateless mode the SDK still hands us a per-request token;
    // pass it through only when the consumer opted in via
    // `createApp({ context: { exposeStatelessSessionId: true } })`. Stdio
    // gives no sessionId at the SDK layer, so the gate is moot there.
    const isStatefulMode = resolveSessionMode(config.mcpSessionMode) === 'stateful';
    const handlerSessionId =
      sdkSessionId && (isStatefulMode || services.exposeStatelessSessionId === true)
        ? sdkSessionId
        : undefined;
    const resourceUri = observableResourceUri(uri);

    // Raw `inputParams` is intentionally excluded from the context — it flows
    // into the completion log via context spread and can contain caller data.
    // The URI template already captures the named segments; anything else is
    // query-string / caller-supplied and belongs in metrics, not logs.
    // Log correlation always uses the raw SDK sessionId — useful even in
    // stateless mode for tracing the SDK's per-request token through events.
    const requestId = mcpReq?.id;
    const appContext = requestContextService.createRequestContext({
      parentContext: {
        ...(typeof requestId === 'string' ? { requestId } : {}),
        ...(sdkSessionId ? { sessionId: sdkSessionId } : {}),
      },
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

      // Execute handler with performance measurement. The context is built
      // from inside the execution span so `ctx.traceId` / `ctx.spanId` — and
      // the child logger built from them — name the `resource_read:*` span the
      // handler runs in rather than the enclosing request span (#296).
      // `attachTypedFail` adds `ctx.fail` when the definition declares an error
      // contract; otherwise no-op.
      const handlerResult = await measureResourceExecution(
        (spanContext) => {
          const ctx = attachTypedFail(
            createContext({
              appContext: spanContext,
              logger: services.logger,
              storage: services.storage,
              signal,
              sessionId: handlerSessionId,
              inputs: createContextInputs(mcpReq),
              requestInput: createRequestInput(),
              ...(mcpReq?.log && { wireLog: mcpReq.log }),
              notifyPromptListChanged: effectiveNotifiers.notifyPromptListChanged,
              notifyResourceListChanged: effectiveNotifiers.notifyResourceListChanged,
              notifyResourceUpdated: effectiveNotifiers.notifyResourceUpdated,
              notifyToolListChanged: effectiveNotifiers.notifyToolListChanged,
              uri,
            }),
            def.errors,
          );
          return Promise.resolve(def.handler(validatedParams, ctx));
        },
        { ...appContext, resourceName },
        { uri: resourceUri, mimeType },
      );

      // Validate output against schema when defined
      const validatedResult = def.output ? def.output.parse(handlerResult) : handlerResult;

      const contents = formatter(validatedResult, { uri, mimeType });
      return { contents };
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

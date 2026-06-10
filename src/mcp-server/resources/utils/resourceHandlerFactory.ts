/**
 * @fileoverview Handler factory for resource definitions.
 * Constructs Context (with `uri`), checks inline auth, validates params, formats response.
 * @module src/mcp-server/resources/utils/resourceHandlerFactory
 */

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Variables } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import type {
  ElicitRequestFormParams,
  ElicitRequestURLParams,
  ElicitResult,
  ReadResourceResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { ZodObject, ZodRawShape } from 'zod';
import { toJSONSchema } from 'zod';

import { config } from '@/config/index.js';
import type { ElicitFn } from '@/core/context.js';
import { attachTypedFail, createContext } from '@/core/context.js';
import { buildRequestScopedNotifiers } from '@/mcp-server/notifications.js';
import type { AnyResourceDefinition } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { withRequiredScopes } from '@/mcp-server/transports/auth/lib/authUtils.js';
import type { StorageService } from '@/storage/core/StorageService.js';
import { McpError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import type { Logger } from '@/utils/internal/logger.js';
import { measureResourceExecution } from '@/utils/internal/performance.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SdkExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

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
 * `server.send*ListChanged()` and `server.server.elicitInput(...)`.
 *
 * Split from {@link ResourceHandlerFactoryServices} so each per-request
 * McpServer gets its own notifier closures — preventing a concurrent
 * registerAll() from overwriting an in-flight handler's notifier target.
 *
 * The resource handler factory prefers request-scoped notifiers
 * ({@link buildRequestScopedNotifiers}, #135) and uses these only as a fallback
 * when the SDK extra exposes no sender (e.g. a non-request test scope).
 *
 * `elicitInput` and `getClientCapabilities` are bound at registration time to
 * the per-server `Server` instance so `wrapElicit` can gate `ctx.elicit` on
 * the client's advertised capability and forward elicitation requests on the
 * wire.
 */
export interface ResourceHandlerNotifiers {
  /** Bound to `server.server.elicitInput.bind(server.server)`. */
  elicitInput?: (params: ElicitRequestFormParams | ElicitRequestURLParams) => Promise<ElicitResult>;
  /** Bound to `server.server.getClientCapabilities.bind(server.server)`. */
  getClientCapabilities?: () => { elicitation?: unknown } | undefined;
  notifyPromptListChanged?: () => void;
  notifyResourceListChanged?: () => void;
  notifyResourceUpdated?: (uri: string) => void;
  notifyToolListChanged?: () => void;
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

// ---------------------------------------------------------------------------
// Capability detection helpers
// ---------------------------------------------------------------------------

/**
 * Builds `ctx.elicit` from the notifiers bound at registration time.
 * Returns `undefined` when elicitInput was not bound or the client did not
 * advertise the elicitation capability.
 * See toolHandlerFactory.wrapElicit for the full contract description.
 */
function wrapElicit(notifiers: ResourceHandlerNotifiers): ElicitFn | undefined {
  const { elicitInput, getClientCapabilities } = notifiers;
  if (typeof elicitInput !== 'function') return;
  if (!getClientCapabilities?.()?.elicitation) return;

  const formFn = (msg: string, schema: ZodObject<ZodRawShape>): Promise<ElicitResult> => {
    const requestedSchema = toJSONSchema(schema) as ElicitRequestFormParams['requestedSchema'];
    return elicitInput({ message: msg, requestedSchema });
  };

  const urlFn = (msg: string, url: string): Promise<ElicitResult> => {
    const elicitationId = crypto.randomUUID();
    return elicitInput({ mode: 'url', message: msg, elicitationId, url });
  };

  const elicitFn = formFn as ElicitFn;
  elicitFn.url = urlFn;
  return elicitFn;
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
): (uri: URL, variables: Variables, extra: SdkExtra) => Promise<ReadResourceResult> {
  const mimeType = def.mimeType ?? 'application/json';
  const formatter = def.format ?? defaultResponseFormatter;

  return async (uri, variables, callContext): Promise<ReadResourceResult> => {
    const sdkContext = callContext as unknown as SdkExtra;

    // Route handler-time list-changed / resource-updated notifications through
    // this request's `extra.sendNotification` so they carry `relatedRequestId`
    // and reach the client under the per-request HTTP/Worker McpServer model
    // (#135). Fall back to the server-level notifiers when the extra exposes no
    // sender (non-request scopes) — those deliver on stdio but drop under HTTP.
    const effectiveNotifiers = buildRequestScopedNotifiers(sdkContext) ?? notifiers;

    const sdkSessionId =
      typeof sdkContext?.sessionId === 'string' ? sdkContext.sessionId : undefined;

    // Surface sessionId on `Context` only when it has request-spanning
    // lifetime — stateful HTTP (or `auto`, which resolves to stateful for
    // HTTP). In stateless mode the SDK still hands us a per-request token;
    // pass it through only when the consumer opted in via
    // `createApp({ context: { exposeStatelessSessionId: true } })`. Stdio
    // gives no sessionId at the SDK layer, so the gate is moot there.
    const isStatefulMode = config.mcpSessionMode === 'stateful' || config.mcpSessionMode === 'auto';
    const handlerSessionId =
      sdkSessionId && (isStatefulMode || services.exposeStatelessSessionId === true)
        ? sdkSessionId
        : undefined;

    // Raw `inputParams` is intentionally excluded from the context — it flows
    // into the completion log via context spread and can contain caller data.
    // The URI template already captures the named segments; anything else is
    // query-string / caller-supplied and belongs in metrics, not logs.
    // Log correlation always uses the raw SDK sessionId — useful even in
    // stateless mode for tracing the SDK's per-request token through events.
    const appContext = requestContextService.createRequestContext({
      parentContext: {
        ...(typeof sdkContext?.requestId === 'string' ? { requestId: sdkContext.requestId } : {}),
        ...(sdkSessionId ? { sessionId: sdkSessionId } : {}),
      },
      operation: 'HandleResourceRead',
      additionalContext: {
        resourceName: def.name ?? def.uriTemplate,
        resourceUri: uri.href,
        sessionId: sdkSessionId,
      },
    });

    try {
      // Check inline auth scopes
      if (def.auth && def.auth.length > 0) {
        withRequiredScopes(def.auth, appContext);
      }

      // Validate params via schema if defined
      const validatedParams = def.params ? def.params.parse(variables) : variables;

      // Construct Context with uri set. `attachTypedFail` adds `ctx.fail`
      // when the definition declares an error contract; otherwise no-op.
      const ctx = attachTypedFail(
        createContext({
          appContext,
          logger: services.logger,
          storage: services.storage,
          signal: sdkContext.signal,
          sessionId: handlerSessionId,
          elicit: wrapElicit(notifiers),
          notifyPromptListChanged: effectiveNotifiers.notifyPromptListChanged,
          notifyResourceListChanged: effectiveNotifiers.notifyResourceListChanged,
          notifyResourceUpdated: effectiveNotifiers.notifyResourceUpdated,
          notifyToolListChanged: effectiveNotifiers.notifyToolListChanged,
          uri,
        }),
        def.errors,
      );

      // Execute handler with performance measurement
      const resourceName = def.name ?? def.uriTemplate;
      const handlerResult = await measureResourceExecution(
        () => Promise.resolve(def.handler(validatedParams, ctx)),
        { ...appContext, resourceName },
        { uri: uri.href, mimeType },
      );

      // Validate output against schema when defined
      const validatedResult = def.output ? def.output.parse(handlerResult) : handlerResult;

      const contents = formatter(validatedResult, { uri, mimeType });
      return { contents };
    } catch (error: unknown) {
      // Classify without logging — the SDK logs when it catches the thrown error.
      if (error instanceof McpError) {
        throw error;
      }
      const { code, message, data } = ErrorHandler.classifyOnly(error);
      throw new McpError(code, message, data, { cause: error });
    }
  };
}

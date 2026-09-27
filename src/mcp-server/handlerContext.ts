/**
 * @fileoverview What the tool and resource handler factories share: the
 * services a handler `Context` is built from, the per-request values derived
 * from the SDK's `ServerContext`, and the `Context` assembly itself.
 * @module src/mcp-server/handlerContext
 */

import type { ServerContext } from '@modelcontextprotocol/server';

import { config } from '@/config/index.js';
import { attachTypedFail, type Context, createContext } from '@/core/context.js';
import {
  type ClientCapabilityView,
  createContextInputs,
  createInputRequiredGate,
  createRequestInput,
  type RequestStateSealer,
} from '@/mcp-server/inputRequired.js';
import {
  type NotifierSources,
  type OptionalNotifiers,
  selectNotifiers,
} from '@/mcp-server/notifications.js';
import type { InputHandlingOptions } from '@/mcp-server/tools/utils/inputPrevalidation.js';
import { resolveSessionMode } from '@/mcp-server/types.js';
import type { StorageService } from '@/storage/core/StorageService.js';
import type { ErrorContract } from '@/types-global/errors.js';
import type { Logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

/** Services a handler factory builds `Context` from. */
export interface HandlerServices {
  /**
   * When true, surface `ctx.sessionId` even in stateless HTTP mode (per-request
   * generated token). Wired from `createApp({ context: { exposeStatelessSessionId } })`.
   * Default false — `ctx.sessionId` is only set when the session has
   * request-spanning lifetime (HTTP `stateful` / `auto` mode).
   */
  exposeStatelessSessionId?: boolean;
  /**
   * Server-level switches for the tool-argument pre-validation step. Wired from
   * `createApp({ input })`; every stage is on when this is absent. Tools only.
   */
  input?: InputHandlingOptions;
  logger: Logger;
  /**
   * Seals the `requestState` a handler returns with `ctx.requestInput(...)`,
   * built from `MCP_REQUEST_STATE_KEY`. Absent when no key is configured, and
   * the state then leaves as the handler wrote it.
   */
  requestState?: RequestStateSealer;
  storage: StorageService;
}

/** What a factory derives once per request from the SDK's `ServerContext`. */
export interface HandlerRequest {
  /**
   * Tenant for a request whose auth pipeline supplied none: `'default'` on
   * stdio and on HTTP with `MCP_AUTH_MODE=none`, `undefined` under HTTP
   * `jwt`/`oauth` so a token without a `tid` claim fails closed on `ctx.state`.
   */
  defaultTenantId: string | undefined;
  mcpReq: ServerContext['mcpReq'] | undefined;
  /** The delivery path `ctx.notify*` takes for this request's era. */
  notifiers: OptionalNotifiers;
  /**
   * What `ctx.sessionId` surfaces: a session with request-spanning lifetime
   * (stateful HTTP, or `auto` resolving to it), or the SDK's per-request token
   * when the consumer opted in via `exposeStatelessSessionId`. Stdio gives no
   * session id at the SDK layer, so the gate is moot there.
   */
  sessionId: string | undefined;
  /** Cancellation for the handler; a never-aborting signal when the SDK gives none. */
  signal: AbortSignal;
}

/**
 * Derives the per-request values from the SDK's `ServerContext`, and picks the
 * notifier delivery path for the request's era via {@link selectNotifiers}.
 * The server-level `notifiers` are bound per `registerAll()`, so a concurrent
 * registration never redirects an in-flight handler's notifications.
 */
export function resolveHandlerRequest(
  serverContext: ServerContext | undefined,
  services: HandlerServices,
  notifiers: NotifierSources,
): HandlerRequest {
  const mcpReq = serverContext?.mcpReq;
  const sdkSessionId = sdkSessionIdOf(serverContext);
  const isStatefulMode = resolveSessionMode(config.mcpSessionMode) === 'stateful';
  const hasNoAuthPipeline = config.mcpTransportType === 'stdio' || config.mcpAuthMode === 'none';
  return {
    defaultTenantId: hasNoAuthPipeline ? 'default' : undefined,
    mcpReq,
    notifiers: selectNotifiers(notifiers, mcpReq),
    sessionId:
      sdkSessionId && (isStatefulMode || services.exposeStatelessSessionId === true)
        ? sdkSessionId
        : undefined,
    signal: mcpReq?.signal ?? new AbortController().signal,
  };
}

/** The raw SDK session token of a request, when it carries one. */
function sdkSessionIdOf(serverContext: ServerContext | undefined): string | undefined {
  return typeof serverContext?.sessionId === 'string' ? serverContext.sessionId : undefined;
}

/**
 * The `parentContext` of a request's tracing context — for a tool call, a
 * resource read, and a `prompts/get` alike: the SDK request id when the client
 * sent a string id (otherwise the context generates one) and the raw session
 * id when present. That id is the one the call's log records carry and its
 * error `data.requestId` returns (#576). Raw handler input is deliberately not
 * part of it — the context spreads into the completion log and can carry
 * caller PII or secrets; sizes and parameter names are recorded as metric
 * attributes by the execution measurement instead.
 */
export function handlerParentContext(
  serverContext: ServerContext | undefined,
): Partial<Pick<RequestContext, 'requestId' | 'sessionId'>> {
  const requestId = serverContext?.mcpReq?.id;
  const sessionId = sdkSessionIdOf(serverContext);
  return {
    ...(typeof requestId === 'string' && { requestId }),
    ...(sessionId && { sessionId }),
  };
}

/**
 * Builds the handler `Context`. Called from inside the execution span so
 * `ctx.traceId` / `ctx.spanId` — and the child logger built from them — name
 * the span the handler runs in rather than the enclosing request span (#296).
 * `attachTypedFail` adds `ctx.fail` when the definition declares an error
 * contract; otherwise the context is unchanged.
 *
 * `capabilityView` is the instance's view of its client's declared
 * capabilities (#580), resolved once here into the value
 * `ctx.clientCapabilities` carries, the filter over `ctx.inputs` applies
 * (#496), and — on a 2025-era instance — the gate `ctx.requestInput` runs on
 * the result it builds (#379). Without a view the request has none:
 * `ctx.clientCapabilities` is `undefined`, no response reaches `ctx.inputs`,
 * and nothing gates `ctx.requestInput`.
 */
export function buildHandlerContext(
  request: HandlerRequest,
  services: HandlerServices,
  spanContext: RequestContext,
  errors: readonly ErrorContract[] | undefined,
  capabilityView?: ClientCapabilityView,
  uri?: URL,
): Context {
  const { mcpReq, notifiers } = request;
  const clientCapabilities = capabilityView?.capabilities(mcpReq);
  return attachTypedFail(
    createContext({
      appContext: spanContext,
      clientCapabilities,
      defaultTenantId: request.defaultTenantId,
      logger: services.logger,
      storage: services.storage,
      signal: request.signal,
      sessionId: request.sessionId,
      inputs: createContextInputs(mcpReq, clientCapabilities),
      requestInput: createRequestInput(
        capabilityView?.era === 'legacy' ? createInputRequiredGate(clientCapabilities) : undefined,
      ),
      ...(mcpReq?.log && { wireLog: mcpReq.log }),
      notifyPromptListChanged: notifiers.notifyPromptListChanged,
      notifyResourceListChanged: notifiers.notifyResourceListChanged,
      notifyResourceUpdated: notifiers.notifyResourceUpdated,
      notifyToolListChanged: notifiers.notifyToolListChanged,
      ...(uri && { uri }),
    }),
    errors,
  );
}

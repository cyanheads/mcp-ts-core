/**
 * @fileoverview What the tool and resource handler factories share: the
 * services a handler `Context` is built from, the per-request values derived
 * from the SDK's `ServerContext`, and the `Context` assembly itself.
 * @module src/mcp-server/handlerContext
 */

import type { ServerContext } from '@modelcontextprotocol/server';

import { config } from '@/config/index.js';
import { attachTypedFail, type Context, createContext } from '@/core/context.js';
import { createContextInputs, createRequestInput } from '@/mcp-server/inputRequired.js';
import {
  type NotifierSources,
  type OptionalNotifiers,
  selectNotifiers,
} from '@/mcp-server/notifications.js';
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
  logger: Logger;
  storage: StorageService;
}

/** What a factory derives once per request from the SDK's `ServerContext`. */
export interface HandlerRequest {
  mcpReq: ServerContext['mcpReq'] | undefined;
  /** The delivery path `ctx.notify*` takes for this request's era. */
  notifiers: OptionalNotifiers;
  /** The raw SDK session token — log correlation uses it in every mode. */
  sdkSessionId: string | undefined;
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
  const sdkSessionId =
    typeof serverContext?.sessionId === 'string' ? serverContext.sessionId : undefined;
  const isStatefulMode = resolveSessionMode(config.mcpSessionMode) === 'stateful';
  return {
    mcpReq,
    notifiers: selectNotifiers(notifiers, mcpReq),
    sdkSessionId,
    sessionId:
      sdkSessionId && (isStatefulMode || services.exposeStatelessSessionId === true)
        ? sdkSessionId
        : undefined,
    signal: mcpReq?.signal ?? new AbortController().signal,
  };
}

/**
 * The `parentContext` of a request's tracing context: the SDK request id and
 * the raw session id when present. Raw handler input is deliberately not part
 * of it — the context spreads into the completion log and can carry caller
 * PII or secrets; sizes and parameter names are recorded as metric attributes
 * by the execution measurement instead.
 */
export function handlerParentContext(
  request: HandlerRequest,
): Partial<Pick<RequestContext, 'requestId' | 'sessionId'>> {
  const requestId = request.mcpReq?.id;
  return {
    ...(typeof requestId === 'string' && { requestId }),
    ...(request.sdkSessionId && { sessionId: request.sdkSessionId }),
  };
}

/**
 * Builds the handler `Context`. Called from inside the execution span so
 * `ctx.traceId` / `ctx.spanId` — and the child logger built from them — name
 * the span the handler runs in rather than the enclosing request span (#296).
 * `attachTypedFail` adds `ctx.fail` when the definition declares an error
 * contract; otherwise the context is unchanged.
 */
export function buildHandlerContext(
  request: HandlerRequest,
  services: HandlerServices,
  spanContext: RequestContext,
  errors: readonly ErrorContract[] | undefined,
  uri?: URL,
): Context {
  const { mcpReq, notifiers } = request;
  return attachTypedFail(
    createContext({
      appContext: spanContext,
      logger: services.logger,
      storage: services.storage,
      signal: request.signal,
      sessionId: request.sessionId,
      inputs: createContextInputs(mcpReq),
      requestInput: createRequestInput(),
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

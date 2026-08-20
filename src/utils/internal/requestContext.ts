/**
 * @fileoverview Utilities for creating and managing request contexts.
 *
 * A request context is an immutable-by-convention object that carries a unique
 * request ID, ISO 8601 timestamp, optional tenant ID, and optional auth data.
 * It is the primary carrier for log correlation, distributed tracing, and
 * multi-tenancy isolation throughout the server.
 *
 * Key behaviors:
 * - `requestId` is inherited from a parent context when provided, otherwise a
 *   new unique ID is generated via {@link generateRequestContextId}.
 * - `tenantId` is resolved with the following priority (highest to lowest):
 *   `additionalContext.tenantId` → the `tenantId` param → `parentContext.tenantId`
 *   → AsyncLocalStorage auth store (`authContext`).
 * - OpenTelemetry `traceId` and `spanId` are automatically injected from the
 *   active span when one exists.
 * - Auth data is populated separately via {@link requestContextService.withAuthInfo}
 *   and is NOT stored in AsyncLocalStorage by this module — ALS propagation is
 *   the responsibility of auth middleware.
 *
 * @module src/utils/internal/requestContext
 */
import { isSpanContextValid, trace } from '@opentelemetry/api';

import { authContext as alsAuthContext } from '@/mcp-server/transports/auth/lib/authContext.js';
import type { AuthInfo } from '@/mcp-server/transports/auth/lib/authTypes.js';
import { generateRequestContextId } from '@/utils/security/idGenerator.js';

/** Maps validated token info to the context-facing auth shape. */
function toAuthContext(info: AuthInfo): AuthContext {
  return {
    sub: info.subject ?? info.clientId,
    scopes: info.scopes,
    clientId: info.clientId,
    ...(info.tenantId && { tenantId: info.tenantId }),
    ...(info.token && { token: info.token }),
  };
}

/**
 * Processed authentication data extracted from a validated JWT or OAuth token
 * and attached to a {@link RequestContext} by {@link requestContextService.withAuthInfo}.
 *
 * Fields map directly to standard JWT claims: `clientId` ← `cid`/`client_id`,
 * `scopes` ← `scp`/`scope` (split to array), `sub` ← `sub`, `tenantId` ← `tid`.
 *
 * @example
 * ```typescript
 * const auth: AuthContext = ctx.auth!;
 * if (auth.scopes.includes('tool:my_tool:read')) {
 *   // authorized
 * }
 * ```
 */
export interface AuthContext {
  /** The client application identifier (`cid` or `client_id` JWT claim). */
  clientId: string;
  /** Granted permission scopes derived from the `scp` or `scope` JWT claim. */
  scopes: string[];
  /** Subject identifier — the user or service principal (`sub` JWT claim). Falls back to `clientId` when `sub` is absent. */
  sub: string;
  /** Tenant identifier from the `tid` JWT claim. Present only for multi-tenant tokens. */
  tenantId?: string;
  /**
   * Raw bearer token from the validated request. Forwarded so handlers can
   * relay it to upstream APIs in on-behalf-of / PAT pass-through flows.
   * Redacted by the framework logger's pino-redact paths (`*.token`,
   * `*.*.token`); avoid passing it to telemetry sinks that bypass that layer.
   */
  token?: string;
  /** Additional token payload properties not mapped to named fields. */
  // allow open-indexed-named: forward-extensibility for future JWT claims (post-#121)
  [key: string]: unknown;
}

/**
 * Core context object associated with a single request or operation.
 *
 * The one canonical request-shape type. Handler-facing `Context` extends it, so
 * a handler's `ctx` is accepted anywhere a `RequestContext` is — services,
 * storage, the logger — with no slice helper and no index-signature gymnastics.
 *
 * Closed by design: a misspelled canonical field (`tenatId`) is a type error
 * rather than a silently-ignored key. Operation-specific data goes in
 * {@link RequestContext.extra}, the one place that is explicitly an open bag.
 *
 * Optional fields (`traceId`, `spanId`) are injected automatically when an
 * OpenTelemetry active span exists at context-creation time.
 *
 * @example
 * ```typescript
 * // Read-only access in a handler
 * ctx.log.info('Handling request', { requestId: ctx.requestId, tenantId: ctx.tenantId });
 * ```
 */
export interface RequestContext {
  /**
   * Authentication data populated by {@link requestContextService.withAuthInfo}.
   * `undefined` when the request is unauthenticated or auth mode is `none`.
   */
  auth?: AuthContext | undefined;

  /**
   * Operation-specific correlation data — tool name, resource URI, retry
   * attempt, whatever the call site wants carried alongside the canonical
   * fields. Flattened into every log line written with this context, so the
   * emitted shape is the same as the pre-0.12 open-bag spread.
   *
   * Add to it with {@link withExtra} rather than by hand: that merges into any
   * value a parent context already carried instead of replacing it.
   */
  // allow open-indexed-named: the one deliberate open bag — everything else is closed
  extra?: Readonly<Record<string, unknown>> | undefined;

  /**
   * Human-readable label for the operation this context belongs to. Set from
   * `createRequestContext({ operation })` and read by the storage layer's
   * tenant assertion and the network helpers' error reporting.
   */
  operation?: string | undefined;

  /**
   * Unique identifier for this request, used to correlate log entries across
   * service boundaries. Inherited from a parent context when provided;
   * otherwise generated by {@link generateRequestContextId}.
   */
  requestId: string;

  /**
   * MCP session identifier, when the request carries a durable session.
   * `undefined` for stdio and for stateless HTTP.
   */
  sessionId?: string | undefined;

  /**
   * OpenTelemetry span ID from the active span at context-creation time.
   * `undefined` when no active span exists.
   */
  spanId?: string | undefined;

  /**
   * Tenant identifier used for multi-tenancy data isolation.
   * Resolved in priority order: `additionalContext.tenantId` →
   * `tenantId` param → `parentContext.tenantId` → AsyncLocalStorage auth store.
   */
  tenantId?: string | undefined;

  /**
   * ISO 8601 UTC timestamp recorded at the moment this context was created.
   */
  timestamp: string;

  /**
   * OpenTelemetry trace ID from the active span at context-creation time.
   * `undefined` when no active span exists.
   */
  traceId?: string | undefined;
}

/**
 * @deprecated Use {@link RequestContext}. It was the closed projection that
 * existed only because `RequestContext` carried an index signature; now that
 * the index signature is gone, `RequestContext` *is* the closed projection.
 * Kept as an alias for one minor.
 */
export type RequestContextLike = RequestContext;

/**
 * The complete key set of {@link RequestContext}. The type is closed, so this
 * list is its runtime mirror — used by {@link toCanonicalContext} to project a
 * wider object back down to the contract.
 */
const CANONICAL_CONTEXT_KEYS = [
  'auth',
  'extra',
  'operation',
  'requestId',
  'sessionId',
  'spanId',
  'tenantId',
  'timestamp',
  'traceId',
] as const satisfies readonly (keyof RequestContext)[];

/**
 * Projects any context-shaped object down to the {@link RequestContext}
 * contract, dropping every key the type does not declare.
 *
 * TypeScript cannot enforce this at the call site: excess-property checking
 * applies to object *literals*, not to a variable, so a handler `ctx` — which
 * carries live request machinery (`log`, `signal`, `state`) and, after a
 * multi-round-trip round, the user-entered content in `inputs.responses` —
 * satisfies a `RequestContext` parameter and arrives whole. Anything that
 * serializes a caller-supplied context onto a wire or into a log must project
 * first, or that payload rides along.
 *
 * Allowlist, not denylist: a field added to a handler context later is dropped
 * by default rather than silently published.
 */
export function toCanonicalContext(context: Readonly<Record<string, unknown>>): RequestContext {
  const projected: Record<string, unknown> = {};
  for (const key of CANONICAL_CONTEXT_KEYS) {
    if (context[key] !== undefined) projected[key] = context[key];
  }
  return projected as unknown as RequestContext;
}

/**
 * Returns a copy of `context` with `fields` merged into its {@link
 * RequestContext.extra} bag.
 *
 * Replaces the `{ ...context, someField }` spread the open-bag type used to
 * allow. Merging rather than replacing means a child call site can add its own
 * correlation data without dropping what a parent already attached.
 *
 * @example
 * ```typescript
 * logger.warning('Retrying upstream call', withExtra(ctx, { attempt, url }));
 * ```
 */
export function withExtra(
  context: RequestContext,
  fields: Readonly<Record<string, unknown>>,
): RequestContext {
  return { ...context, extra: { ...context.extra, ...fields } };
}

/**
 * Reads the trace and span IDs of the currently-active OpenTelemetry span, or
 * `undefined` when there is no active span or its span context is invalid.
 *
 * An invalid span context is what a non-recording span carries — the shape
 * `startActiveSpan` produces when telemetry is disabled. Its IDs are all
 * zeroes, which correlate to nothing; treating them as absent keeps a
 * telemetry-off deployment reporting `undefined` rather than a run of zeroes.
 */
function activeSpanIds(): { spanId: string; traceId: string } | undefined {
  const activeSpan = trace.getActiveSpan();
  if (!activeSpan || typeof activeSpan.spanContext !== 'function') return undefined;
  const spanContext = activeSpan.spanContext();
  if (!spanContext || !isSpanContextValid(spanContext)) return undefined;
  return { spanId: spanContext.spanId, traceId: spanContext.traceId };
}

/**
 * Returns a copy of `context` whose `traceId` / `spanId` name the span that is
 * active *now*, rather than the one that was active when the context was built.
 *
 * A context created before a span opens carries the enclosing span's IDs, so a
 * handler running inside a `tool_execution:*` span would advertise the request
 * span instead of its own. Re-binding at the point the span becomes active is
 * what makes `ctx.spanId` name the execution the handler is part of.
 *
 * Returns the input unchanged when no valid span is active, so a
 * telemetry-disabled path is untouched.
 */
export function withActiveSpan<T extends RequestContext>(context: T): T {
  const ids = activeSpanIds();
  if (!ids) return context;
  if (context.traceId === ids.traceId && context.spanId === ids.spanId) return context;
  return { ...context, traceId: ids.traceId, spanId: ids.spanId };
}

/**
 * Parameters accepted by {@link requestContextService.createRequestContext}.
 *
 * Closed, like the context it builds. Operation-specific keys go in
 * `additionalContext`, which lands on {@link RequestContext.extra}.
 *
 * @example
 * ```typescript
 * const ctx = requestContextService.createRequestContext({
 *   operation: 'fetchUser',
 *   parentContext: incomingCtx,
 *   additionalContext: { userId: '123' },
 * });
 * ```
 */
export interface CreateRequestContextParams {
  /**
   * Operation-specific key-value pairs, merged into the new context's
   * {@link RequestContext.extra} on top of whatever the parent carried.
   */
  additionalContext?: Readonly<Record<string, unknown>> | undefined;

  /**
   * Human-readable label for the operation creating this context.
   * Written onto the context as `context.operation` when provided.
   */
  operation?: string | undefined;

  /**
   * Parent context whose properties are inherited as the base. When
   * `parentContext.requestId` is a non-empty string it is reused as-is,
   * preserving the same request ID across a call chain.
   */
  parentContext?: Partial<RequestContext> | undefined;

  /** Explicit tenant, ranked below `additionalContext.tenantId`. */
  tenantId?: string | undefined;
}

/**
 * Singleton-like service object for managing request context operations.
 * @private
 */
const requestContextServiceInstance = {
  /**
   * Creates a new {@link RequestContext} with a guaranteed unique `requestId`
   * and current ISO 8601 `timestamp`.
   *
   * Merge order (later entries win, except `requestId`/`timestamp` which are
   * always generated fresh or inherited):
   * 1. `parentContext` properties (base)
   * 2. Resolved `requestId` and `timestamp` (canonical, never overwritten)
   * 3. `extra` — the parent's bag with `additionalContext` merged over it
   * 4. Resolved `tenantId` (see priority order in {@link RequestContext.tenantId})
   * 5. `operation` (written as `context.operation` when provided)
   * 6. OTel `traceId`/`spanId` from the active span (when present)
   *
   * @param params - Context creation parameters. Defaults to `{}`.
   * @returns A fully constructed `RequestContext`.
   *
   * @example
   * ```typescript
   * // Minimal — generates a fresh requestId and timestamp
   * const ctx = requestContextService.createRequestContext();
   *
   * // Propagate an existing request ID across a call chain
   * const childCtx = requestContextService.createRequestContext({
   *   parentContext: incomingCtx,
   *   operation: 'processItem',
   *   additionalContext: { itemId: item.id },
   * });
   * ```
   */
  createRequestContext(params: CreateRequestContextParams = {}): RequestContext {
    const { parentContext, additionalContext, operation, tenantId } = params;

    const authStore = alsAuthContext.getStore();
    const tenantIdFromAuth = authStore?.authInfo?.tenantId;

    // Bridge auth info from ALS into the context so ctx.auth is populated
    // in tool/resource handlers without requiring a separate withAuthInfo() call.
    const authFromStore: AuthContext | undefined = authStore?.authInfo
      ? toAuthContext(authStore.authInfo)
      : undefined;

    const requestId = parentContext?.requestId
      ? parentContext.requestId
      : generateRequestContextId();
    const timestamp = new Date().toISOString();

    const additionalTenantId =
      typeof additionalContext?.tenantId === 'string' ? additionalContext.tenantId : undefined;
    const resolvedTenantId =
      additionalTenantId ?? tenantId ?? parentContext?.tenantId ?? tenantIdFromAuth;

    const extra =
      parentContext?.extra || additionalContext
        ? { ...parentContext?.extra, ...additionalContext }
        : undefined;

    const context: RequestContext = {
      ...parentContext,
      requestId,
      timestamp,
      ...(extra && { extra }),
      ...(resolvedTenantId ? { tenantId: resolvedTenantId } : {}),
      ...(operation ? { operation } : {}),
      ...(authFromStore && { auth: authFromStore }),
    };

    // --- OpenTelemetry Integration ---
    const ids = activeSpanIds();
    if (ids) {
      context.traceId = ids.traceId;
      context.spanId = ids.spanId;
    }
    // --- End OpenTelemetry Integration ---

    return context;
  },

  /**
   * Creates a new {@link RequestContext} enriched with authentication information.
   * This method populates the context with auth data from a validated token,
   * including tenant ID, client ID, scopes, and subject.
   *
   * **Note:** This method builds and returns a `RequestContext` object only.
   * It does NOT propagate auth into `AsyncLocalStorage`. ALS propagation is
   * handled by the auth middleware via `authContext.run()`. If you need
   * scope enforcement via `withRequiredScopes()`, ensure the call runs
   * inside the middleware's ALS continuation.
   *
   * @param authInfo - The validated authentication information from JWT/OAuth token.
   * @param parentContext - Optional parent context to inherit properties from.
   * @returns A new `RequestContext` object with auth information populated.
   *
   * @example
   * ```typescript
   * const authInfo = await jwtStrategy.verify(token);
   * const context = requestContextService.withAuthInfo(authInfo);
   * // context now includes: { requestId, timestamp, tenantId, auth: {...}, ... }
   * ```
   */
  withAuthInfo(authInfo: AuthInfo, parentContext?: Partial<RequestContext>): RequestContext {
    const baseContext = this.createRequestContext({
      // Inherit the operation from parentContext when provided, so callers that
      // already established an operation name keep it.
      operation: parentContext?.operation ?? 'withAuthInfo',
      ...(parentContext && { parentContext }),
      ...(authInfo.tenantId && { tenantId: authInfo.tenantId }),
    });

    return {
      ...baseContext,
      auth: toAuthContext(authInfo),
    };
  },
};

/**
 * Service for creating and enriching {@link RequestContext} instances.
 *
 * The two primary methods cover the full lifecycle:
 * - {@link requestContextService.createRequestContext} — general-purpose context
 *   creation with parent propagation and OTel integration.
 * - {@link requestContextService.withAuthInfo} — enriches a context with
 *   structured auth data from a validated token.
 *
 * @example
 * ```typescript
 * import { requestContextService } from '@/utils/internal/requestContext.js';
 *
 * // Create a root context for an incoming request
 * const ctx = requestContextService.createRequestContext({ operation: 'handleRequest' });
 *
 * // Enrich with auth after token verification
 * const authCtx = requestContextService.withAuthInfo(verifiedAuthInfo, ctx);
 * ```
 */
export const requestContextService = requestContextServiceInstance;

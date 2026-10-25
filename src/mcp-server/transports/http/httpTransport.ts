/**
 * @fileoverview Worker-safe Hono application factory for the HTTP MCP transport.
 * Builds the routing, auth, session, and serving wiring using only web-standard
 * APIs. The Node-only `serve()` start path lives in `httpServer.ts` so the
 * Worker bundle drops `@hono/node-server` and `node:http` via tree-shaking.
 *
 * Serving is split by session mode:
 *
 * - **stateless** — one `createMcpHandler(factory)` answers both protocol eras
 *   per request (its default `legacy: 'stateless'` posture).
 * - **stateful / auto** — `isLegacyRequest(request)` splits the traffic. 2025-era
 *   requests go to a sessionful `WebStandardStreamableHTTPServerTransport` with
 *   one persistent `McpServer` per `Mcp-Session-Id`; 2026-07-28 requests go to a
 *   strict (`legacy: 'reject'`) modern handler, which is per-request by
 *   construction — that revision has no session.
 *
 * The sessionful arm is load-bearing rather than legacy courtesy: the SDK's
 * multi-round-trip legacy shim needs a live session, so dropping it would break
 * interactive tools for every 2025 client that is not on stdio.
 *
 * @see {@link https://modelcontextprotocol.io/specification/2026-07-28/basic/transports | MCP Transports}
 * @module src/mcp-server/transports/http/httpTransport
 */

import {
  createMcpHandler,
  isJsonContentType,
  isLegacyRequest,
  type McpHttpHandler,
  type RequestId,
  type ServerEventBus,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { config } from '@/config/index.js';
import type { ServerManifest } from '@/core/serverManifest.js';
import { createAuthStrategy } from '@/mcp-server/transports/auth/authFactory.js';
import { createAuthMiddleware } from '@/mcp-server/transports/auth/authMiddleware.js';
import { authContext } from '@/mcp-server/transports/auth/lib/authContext.js';
import type { AuthInfo } from '@/mcp-server/transports/auth/lib/authTypes.js';
import { createBoundedEventStore } from '@/mcp-server/transports/http/eventStore.js';
import { httpErrorHandler } from '@/mcp-server/transports/http/httpErrorHandler.js';
import type { HonoNodeBindings } from '@/mcp-server/transports/http/httpTypes.js';
import { createLandingPageHandler } from '@/mcp-server/transports/http/landing-page/index.js';
import { protectedResourceMetadataHandler } from '@/mcp-server/transports/http/protectedResourceMetadata.js';
import { createRobotsTxtHandler } from '@/mcp-server/transports/http/robotsTxt.js';
import { createServerCardHandler } from '@/mcp-server/transports/http/serverCard.js';
import { generateSecureSessionId } from '@/mcp-server/transports/http/sessionIdUtils.js';
import {
  closeConnection,
  type SessionIdentity,
  SessionStore,
} from '@/mcp-server/transports/http/sessionStore.js';
import { type FrameworkServerFactory, resolveSessionMode } from '@/mcp-server/types.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import {
  type RequestContext,
  requestContextService,
  withExtra,
} from '@/utils/internal/requestContext.js';
import { runtimeCaps } from '@/utils/internal/runtime.js';
import { createObservableGauge } from '@/utils/telemetry/metrics.js';

/** Matches loopback origins (http(s)://localhost|127.0.0.1|[::1] with optional port).
 * Used as the fail-closed default for the Origin guard when no explicit
 * MCP_ALLOWED_ORIGINS is configured — an unauthenticated MCP server must not
 * accept browser Origin headers from arbitrary hosts (DNS rebinding
 * protection). The SDK's `validateOriginHeader` matches bare hostnames from a
 * fixed list and so cannot express "any loopback port", which is exactly the
 * dev-server case this guard exists for. */
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

/** Request headers the 2025-era protocol uses — the preflight answer for every origin. */
const BASE_CORS_ALLOW_HEADERS = [
  'Content-Type',
  'Authorization',
  'Mcp-Session-Id',
  'MCP-Protocol-Version',
];

/**
 * The 2026-07-28 standard request headers, plus `Last-Event-ID`, which an SSE
 * resume on the sessionful arm sends.
 */
const MCP_CORS_ALLOW_HEADERS = ['Mcp-Method', 'Mcp-Name', 'Last-Event-ID'];

/**
 * Response headers a cross-origin browser client may read. `Mcp-Session-Id`
 * carries the 2025-era session; `WWW-Authenticate` carries a 401's RFC 9728
 * `resource_metadata` challenge, the client's only pointer to the
 * authorization server; `Retry-After` says when a retryable `503` (draining,
 * session capacity) may be retried. None is CORS-safelisted, so without listing
 * them a browser hides all three.
 */
const CORS_EXPOSE_HEADERS = ['Mcp-Session-Id', 'WWW-Authenticate', 'Retry-After'];

/**
 * `Mcp-Param-<Name>` for every `headerParam` designation on a registered tool.
 * A disabled tool is never registered, so its designations are left out, and a
 * name two tools share is listed once — header names are case-insensitive.
 */
function mcpParamHeaders(manifest: ServerManifest): string[] {
  const byLowerName = new Map<string, string>();
  for (const tool of manifest.definitions.tools) {
    if (tool.disabled) continue;
    for (const name of tool.headerParams ?? []) {
      const header = `Mcp-Param-${name}`;
      if (!byLowerName.has(header.toLowerCase())) byLowerName.set(header.toLowerCase(), header);
    }
  }
  return [...byLowerName.values()];
}

type BoundedBodyRead =
  | { exceeded: false; body: ArrayBuffer }
  | { exceeded: true; bytesRead: number };

/** Reads at most one stream chunk beyond `maxBytes`, cancelling as soon as the
 * limit is crossed. Fetch body chunks are not size-bounded by the consumer, so
 * the final chunk may itself be larger than the remaining allowance. */
async function readBodyWithinLimit(request: Request, maxBytes: number): Promise<BoundedBodyRead> {
  if (!request.body) return { exceeded: false, body: new ArrayBuffer(0) };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      try {
        await reader.cancel('Request body size limit exceeded');
      } catch {
        // The 413 remains authoritative even when the producer rejects cancel.
      }
      return { exceeded: true, bytesRead };
    }
    chunks.push(value);
  }

  const body = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { exceeded: false, body: body.buffer };
}

const asRequestId = (value: unknown): RequestId | undefined =>
  typeof value === 'string' || typeof value === 'number' ? value : undefined;

/** The id of a POST body that is exactly one JSON-RPC request, else undefined. */
function singleRequestId(body: unknown): RequestId | undefined {
  if (Array.isArray(body) || typeof body !== 'object' || body === null) return undefined;
  const message = body as { id?: unknown; method?: unknown };
  return typeof message.method === 'string' ? asRequestId(message.id) : undefined;
}

/** Request ids named by the `notifications/cancelled` messages in a POST body. */
function cancelledRequestIds(body: unknown): RequestId[] {
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  return messages.flatMap((message) => {
    const { method, params } = (message ?? {}) as {
      method?: unknown;
      params?: { requestId?: unknown };
    };
    const id = method === 'notifications/cancelled' ? asRequestId(params?.requestId) : undefined;
    return id === undefined ? [] : [id];
  });
}

/**
 * Re-streams a response so `onEnd` runs once its body is over — after the
 * transport writes the response and closes it, when the client disconnects, or
 * when the sessionful arm's cancellation shim closes it. A response with no
 * body runs `onEnd` at once.
 */
function onStreamEnd(response: Response, onEnd: () => void): Response {
  const reader = response.body?.getReader();
  if (!reader) {
    onEnd();
    return response;
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read().catch((error: unknown) => {
        onEnd();
        throw error;
      });
      if (next.done) {
        onEnd();
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    cancel(reason) {
      onEnd();
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * `request` with `signal` joined to its own abort signal. Its body is left
 * behind: a POST reaches the SDK already parsed, as `parsedBody`, and the
 * other methods carry none.
 */
function withAddedSignal(request: Request, signal: AbortSignal): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    signal: AbortSignal.any([request.signal, signal]),
  });
}

/**
 * Creates a Hono HTTP application for the MCP server.
 *
 * This function is generic and can create apps with different binding types:
 * - Node.js environments use HonoNodeBindings (default)
 * - Cloudflare Workers use CloudflareBindings
 *
 * The function itself doesn't access bindings; they're only used at runtime
 * when the app processes requests in its specific environment.
 *
 * @template TBindings - The Hono binding type (must extend object, defaults to HonoNodeBindings for Node.js)
 * @param mcpServer - The MCP server instance
 * @param parentContext - Parent request context for logging
 * @param bus - Change-event bus the modern leg's `subscriptions/listen` streams
 *   subscribe to. Pass the one the app publishes on (`ComposedApp.bus`), or a
 *   background emission reaches a different bus than the streams listen to and
 *   is silently dropped (#193). Omitted, the handler creates its own — fine for
 *   a test harness that never emits out of request.
 * @returns Configured Hono application with the specified binding type
 */
export async function createHttpApp<TBindings extends object = HonoNodeBindings>(
  serverFactory: FrameworkServerFactory,
  parentContext: RequestContext,
  manifest: ServerManifest,
  bus?: ServerEventBus,
): Promise<{
  app: Hono<{ Bindings: TBindings }>;
  /**
   * Starts draining, then tears down every in-flight exchange: the modern
   * leg's, the stateless legacy leg's, and each live session. Draining is
   * entered before anything is aborted and never left: from then on the MCP
   * endpoint answers every request with a retryable `503`, and every response
   * the app finishes carries `Connection: close`.
   */
  close: () => Promise<void>;
  /** The modern handler's `subscriptions/listen` bus and publish facade. */
  handler: McpHttpHandler;
  sessionStore: SessionStore | null;
}> {
  const app = new Hono<{ Bindings: TBindings }>();
  const transportContext = withExtra(parentContext, { component: 'HttpTransportSetup' });

  /**
   * Shutdown admission. `close()` sets `draining` before it aborts anything.
   * From then on the MCP endpoint refuses every request, and every response
   * the app finishes, whatever its route, closes its socket, so the server's
   * drain never waits on a keep-alive connection it answered during shutdown.
   */
  let draining = false;
  /**
   * One controller per JSON request handed to `handler.fetch`, joined to that
   * request's signal and held until its response stream ends; `close()` aborts
   * every one. The SDK's stateless legacy serving tears an exchange down only on
   * its request's signal, and `handler.close()` leaves that serving untouched. A
   * non-JSON POST keeps its own request, body included, since the SDK answers
   * it with a 415 at once.
   * Each controller lives only as long as its exchange: a signal joined to one
   * process-lifetime controller is retained by it, so every request would leak
   * (#786).
   * Absent on a Worker, which never shuts the app down and binds a signal to
   * the request that created it, so a later request touching it fails.
   */
  const inFlight = runtimeCaps.isWorkerLike ? undefined : new Set<AbortController>();

  app.use('*', async (c, next) => {
    await next();
    if (draining) c.header('Connection', 'close');
  });

  /**
   * The answer to an MCP request that arrives, or reaches dispatch, after
   * draining starts. No MCP work has begun, so the request is safe to resend.
   */
  const refuseWhileDraining = (c: Context, id?: RequestId): Response => {
    const requestContext = requestContextService.createRequestContext({
      operation: 'HttpDrainGate',
      additionalContext: { component: 'HttpTransport' },
    });
    logger.info(
      'Refused MCP request: the server is shutting down.',
      withExtra(requestContext, { method: c.req.method }),
    );
    return c.json(
      {
        jsonrpc: '2.0',
        id: id ?? null,
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: 'The server is shutting down. Retry the request.',
        },
      },
      503,
      { 'Retry-After': '1' },
    );
  };

  // Initialize session store for stateful mode. `auto` is resolved by the
  // shared resolution the manifest advertises, so what the server does and what
  // it publishes can never disagree (#357).
  const isStateful = resolveSessionMode(config.mcpSessionMode) === 'stateful';
  const sessionStore = isStateful
    ? new SessionStore(config.mcpStatefulSessionStaleTimeoutMs)
    : null;

  // Wire session count to OTel observable gauge for durable metrics.
  // Registered unconditionally so the series exists from startup (reports 0 when stateless/stdio).
  createObservableGauge(
    'mcp.sessions.active',
    'Number of active MCP sessions',
    () => sessionStore?.getSessionCount() ?? 0,
    '{sessions}',
  );

  // OpenTelemetry request tracing — outermost middleware on the MCP endpoint
  // so the span captures the full lifecycle (CORS, auth, handler).
  // On Bun, Node.js HTTP auto-instrumentation is a no-op; this fills that gap.
  // @hono/otel is a Tier 3 optional peer — lazy import inside the guard.
  if (config.openTelemetry.enabled) {
    try {
      const { httpInstrumentationMiddleware } = await import('@hono/otel');
      app.use(
        config.mcpHttpEndpointPath,
        httpInstrumentationMiddleware({
          captureRequestHeaders: ['mcp-session-id'],
        }),
      );
      logger.debug('OTel request tracing middleware enabled for MCP endpoint.', transportContext);
    } catch {
      logger.warning(
        '@hono/otel not installed — HTTP instrumentation disabled. Install with: bun add @hono/otel',
        transportContext,
      );
    }
  }

  // CORS + Origin guard. These are two independent concerns:
  //
  //   - CORS controls which browsers can read responses cross-origin.
  //   - The Origin guard (DNS-rebinding protection, MCP Spec 2025-06-18) rejects
  //     MCP endpoint requests whose Origin header doesn't match the allowlist.
  //
  // When MCP_ALLOWED_ORIGINS is unset, CORS falls back to wildcard (so non-browser
  // CLI clients still work — they send no Origin header, so wildcard CORS is a
  // no-op for them) while the Origin guard falls back to loopback-only. This
  // fails closed for browser-CSRF attacks against unauthenticated dev servers.
  //
  // Set MCP_ALLOWED_ORIGINS='*' to explicitly disable Origin validation (public
  // API on an authenticated transport). That is an opt-in, not a default.
  const explicitOrigins =
    Array.isArray(config.mcpAllowedOrigins) && config.mcpAllowedOrigins.length > 0
      ? config.mcpAllowedOrigins
      : undefined;
  const wildcardExplicitlyAllowed = explicitOrigins?.includes('*') ?? false;
  const corsOrigin: string | string[] =
    !explicitOrigins || wildcardExplicitlyAllowed ? '*' : explicitOrigins;

  /** Whether the Origin guard admits a browser `Origin` value. */
  const isAdmittedOrigin = (origin: string): boolean =>
    wildcardExplicitlyAllowed ||
    (explicitOrigins ? explicitOrigins.includes(origin) : LOOPBACK_ORIGIN_RE.test(origin));

  if (!explicitOrigins) {
    logger.warning(
      'MCP_ALLOWED_ORIGINS is not set — CORS is wildcard for CLI clients; browser Origin headers are restricted to loopback. Set MCP_ALLOWED_ORIGINS for production deployments accepting remote browser origins.',
      transportContext,
    );
  } else if (wildcardExplicitlyAllowed) {
    logger.warning(
      "MCP_ALLOWED_ORIGINS contains '*' — DNS-rebinding protection is disabled. Rely on MCP_AUTH_MODE for access control.",
      transportContext,
    );
  }

  // Per Fetch spec, Access-Control-Allow-Origin: * with
  // Access-Control-Allow-Credentials: true is invalid — browsers reject the
  // preflight. Only enable credentials when origin is explicitly configured.
  //
  // A browser sends only the request headers the preflight lists (#571). An
  // origin the Origin guard admits is offered every header a request here can
  // carry; any other origin keeps the 2025-era set, so a page the guard would
  // refuse learns no `headerParam` designation names from the preflight.
  //
  // The answer therefore turns on the request's Origin, as the Origin guard's
  // does, so every response names Origin in Vary; otherwise a shared cache
  // could hand one origin's answer to another. Hono appends it, preflight and
  // actual response alike, for every origin option but the literal '*', so the
  // wildcard goes in as a function that always answers '*'.
  const corsWith = (allowHeaders: string[]) =>
    cors({
      origin: corsOrigin === '*' ? () => '*' : corsOrigin,
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders,
      exposeHeaders: CORS_EXPOSE_HEADERS,
      ...(corsOrigin !== '*' && { credentials: true }),
    });
  const baseCors = corsWith(BASE_CORS_ALLOW_HEADERS);
  const admittedCors = corsWith([
    ...BASE_CORS_ALLOW_HEADERS,
    ...MCP_CORS_ALLOW_HEADERS,
    ...mcpParamHeaders(manifest),
  ]);
  app.use('*', (c, next) => {
    const origin = c.req.header('origin');
    return (origin && isAdmittedOrigin(origin) ? admittedCors : baseCors)(c, next);
  });

  // Centralized error handling
  app.onError(httpErrorHandler);

  // Drain gate: after CORS, so a browser can read the refusal, and ahead of
  // auth and body parsing, so a refused request costs nothing. Dispatch checks
  // again below for a request that passed here before draining started.
  app.use(config.mcpHttpEndpointPath, async (c, next) => {
    if (draining) return refuseWhileDraining(c);
    return await next();
  });

  // MCP Spec 2025-06-18: Origin header validation for DNS rebinding protection.
  // https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#security-warning
  //
  // Requests without an Origin header (CLI clients) pass through. Requests with
  // an Origin are checked against: the explicit allowlist when set; loopback-only
  // when unset; or unconditionally accepted when MCP_ALLOWED_ORIGINS='*' is
  // explicitly configured.
  app.use(config.mcpHttpEndpointPath, async (c, next) => {
    const origin = c.req.header('origin');
    if (origin) {
      if (!isAdmittedOrigin(origin)) {
        const requestContext = requestContextService.createRequestContext({
          operation: 'HttpOriginGuard',
          additionalContext: { component: 'HttpTransport' },
        });
        logger.warning(
          'Rejected request with invalid Origin header',
          withExtra(requestContext, {
            origin,
            allowedOrigins: explicitOrigins ?? 'loopback-only',
          }),
        );
        return c.json({ error: 'Invalid origin. DNS rebinding protection.' }, 403);
      }
    }
    // Origin is valid or not present, continue
    return await next();
  });

  // MCP Spec hardening (issue #157): reject oversized request bodies before the
  // per-request McpServer/transport are allocated and before the SDK parses the
  // body. A declared Content-Length over the cap is rejected with zero
  // buffering; otherwise the body stream is read only to the first chunk that
  // crosses the limit, then cancelled. Valid bodies are cached so downstream
  // `c.req.json()` reuses the preserved bytes. This closes the bypass where a
  // client omits or under-declares Content-Length. `MCP_HTTP_MAX_BODY_BYTES=0`
  // disables the guard. It is the only limit in force: the SDK caps just the
  // body reads it performs itself (4 MiB by default), and every arm below is
  // handed the body already parsed.
  const maxBodyBytes = config.mcpHttpMaxBodyBytes;
  if (maxBodyBytes > 0) {
    app.use(config.mcpHttpEndpointPath, async (c, next) => {
      const method = c.req.method;
      if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
        return await next();
      }

      const rejectOversized = (bytes: number): Response => {
        const requestContext = requestContextService.createRequestContext({
          operation: 'HttpBodyLimit',
          additionalContext: { component: 'HttpTransport' },
        });
        logger.warning(
          'Rejected request exceeding body size limit',
          withExtra(requestContext, { bytes, maxBodyBytes }),
        );
        return c.json(
          {
            error: `Request body exceeds the ${maxBodyBytes}-byte limit (configurable via MCP_HTTP_MAX_BODY_BYTES).`,
          },
          413,
        );
      };

      // Zero-copy early reject when the client honestly declares an over-limit body.
      const declared = Number(c.req.header('content-length'));
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        return rejectOversized(declared);
      }

      // Authoritative streaming check — catches missing or under-declared
      // Content-Length without draining an unbounded upload.
      const bodyRead = await readBodyWithinLimit(c.req.raw, maxBodyBytes);
      if (bodyRead.exceeded) {
        return rejectOversized(bodyRead.bytesRead);
      }

      // Hono's body cache stores promises internally even though its public
      // BodyCache type describes resolved values. Seeding it preserves the body
      // for the SDK after the raw stream has been consumed above.
      Object.assign(c.req.bodyCache, { arrayBuffer: Promise.resolve(bodyRead.body) });

      return await next();
    });
    logger.debug(`HTTP request body limit enabled: ${maxBodyBytes} bytes.`, transportContext);
  }

  // Health and GET /mcp status remain unprotected for convenience
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // RFC 9728 Protected Resource Metadata — unauthenticated, but only mounted
  // when the server actually is a protected resource. Serving this document
  // declares it one, sending a discovering client into an OAuth flow it cannot
  // finish: there is no `authorization_servers` to register with in `none`
  // mode. The 404 is the signal that the resource is unauthenticated.
  // https://datatracker.ietf.org/doc/html/rfc9728
  if (config.mcpAuthMode !== 'none') {
    const protectedResourcePath = '/.well-known/oauth-protected-resource';
    app.get(protectedResourcePath, protectedResourceMetadataHandler);

    // RFC 8414 §3 path-suffixed variant — clients also probe
    // `/.well-known/oauth-protected-resource{mcpHttpEndpointPath}` when the MCP
    // endpoint is not at the root. Mount the same handler at that path too.
    if (config.mcpHttpEndpointPath !== '/') {
      const suffixedProtectedResourcePath = `${protectedResourcePath}${config.mcpHttpEndpointPath}`;
      app.get(suffixedProtectedResourcePath, protectedResourceMetadataHandler);
      logger.debug(
        `RFC 8414 path-suffixed metadata mounted at ${suffixedProtectedResourcePath}.`,
        transportContext,
      );
    }
  } else {
    logger.debug(
      'MCP_AUTH_MODE=none — Protected Resource Metadata not mounted (server is not an OAuth-protected resource).',
      transportContext,
    );
  }

  // SEP-1649 MCP Server Card — machine-readable discovery document.
  // Collision guard: skip the mount if the MCP endpoint is configured to use
  // this path (unusual, but avoid shadowing the real transport).
  const serverCardPath = '/.well-known/mcp.json';
  if (config.mcpHttpEndpointPath !== serverCardPath) {
    app.get(serverCardPath, createServerCardHandler(manifest));
    logger.debug(`SEP-1649 Server Card mounted at ${serverCardPath}.`, transportContext);
  } else {
    logger.warning(
      `MCP endpoint is configured at ${serverCardPath}; Server Card not mounted (would collide).`,
      transportContext,
    );
  }

  // Create the auth strategy once — used by the MCP endpoint's auth middleware
  // AND by the landing page when `landing.requireAuth=true`, so both surfaces
  // apply the same token validation (JWT/OAuth) the operator configured.
  const authStrategy = createAuthStrategy();

  // robots.txt — allow `/`, disallow the MCP JSON-RPC endpoint. Only mounted
  // alongside the landing page; if landing is disabled the host is treated as
  // an API-only deployment and a robots policy is the operator's call.
  const robotsTxtPath = '/robots.txt';
  if (manifest.landing.enabled && config.mcpHttpEndpointPath !== robotsTxtPath) {
    app.get(robotsTxtPath, createRobotsTxtHandler(manifest));
    logger.debug(`robots.txt mounted at ${robotsTxtPath}.`, transportContext);
  }

  // HTML landing page at `/` — unauthenticated by default (`landing.requireAuth`
  // is honored inside the handler when enabled). Skipped when landing.enabled=false
  // or when the MCP endpoint is (unusually) configured at `/`.
  const landingPath = '/';
  if (manifest.landing.enabled && config.mcpHttpEndpointPath !== landingPath) {
    if (manifest.landing.requireAuth && !authStrategy) {
      logger.warning(
        'landing.requireAuth=true but MCP_AUTH_MODE=none — the landing page inventory will be hidden for all callers. Configure an auth mode (jwt/oauth) or set landing.requireAuth=false.',
        transportContext,
      );
    }
    app.get(landingPath, createLandingPageHandler(manifest, authStrategy));
    logger.debug(`Landing page mounted at ${landingPath}.`, transportContext);
  } else if (!manifest.landing.enabled) {
    logger.debug('Landing page disabled via landing.enabled=false.', transportContext);
  } else {
    logger.warning(
      `MCP endpoint is configured at ${landingPath}; landing page not mounted (would collide).`,
      transportContext,
    );
  }

  // MCP Spec 2025-06-18: GET with Accept: text/event-stream opens an SSE stream
  // for server-initiated messages. Plain GET (browser, health check) returns info.
  //
  // Security: When auth is enabled, unauthenticated plain-GET callers receive only
  // { status: 'ok' }. Full server metadata is gated behind authentication to
  // avoid leaking server name, version, environment, and capability details.
  // SSE requests always fall through to the auth middleware + transport handler.
  app.get(config.mcpHttpEndpointPath, (c, next) => {
    if (c.req.header('accept')?.includes('text/event-stream')) {
      return next(); // Fall through to transport handler for SSE
    }

    // When auth is enabled, this handler runs before auth middleware.
    // Return minimal info to avoid leaking server metadata to unauthenticated callers.
    if (config.mcpAuthMode !== 'none') {
      return c.json({ status: 'ok' });
    }

    return c.json({
      status: 'ok',
      server: {
        name: manifest.server.name,
        version: manifest.server.version,
        description: manifest.server.description,
        ...(manifest.server.keywords?.length && { keywords: manifest.server.keywords }),
        ...(manifest.server.homepage && { homepage: manifest.server.homepage }),
        environment: manifest.server.environment,
        transport: manifest.transport.type,
        sessionMode: manifest.transport.sessionMode,
      },
      protocolVersions: manifest.protocol.supportedVersions,
      capabilities: {
        logging: manifest.capabilities.logging,
        prompts: manifest.capabilities.prompts,
        resources: manifest.capabilities.resources,
        tools: manifest.capabilities.tools,
      },
      extensions: {
        'io.modelcontextprotocol/ui': 'io.modelcontextprotocol/ui' in (manifest.extensions ?? {}),
      },
      framework: manifest.framework,
      auth: {
        mode: manifest.auth.mode,
      },
    });
  });

  // Auth middleware is registered BEFORE the MCP endpoint route handlers below
  // so Hono applies it to all subsequent routes on this path. The strategy
  // itself was created above so the landing page can share it.
  if (authStrategy) {
    const authMiddleware = createAuthMiddleware(authStrategy);
    app.use(config.mcpHttpEndpointPath, authMiddleware);
    logger.info('Authentication middleware enabled for MCP endpoint.', transportContext);
  } else {
    logger.info('Authentication is disabled; MCP endpoint is unprotected.', transportContext);
  }

  /** Extract session identity from the current auth context (ALS). */
  function extractSessionIdentity(): SessionIdentity | undefined {
    const authInfo = authContext.getStore()?.authInfo;
    if (!authInfo) return;
    return Object.fromEntries(
      Object.entries({
        tenantId: authInfo.tenantId,
        clientId: authInfo.clientId,
        subject: authInfo.subject,
      }).filter(([, v]) => v != null),
    ) as SessionIdentity;
  }

  // DELETE terminates a session. Ownership is validated here, before the SDK
  // transport is allowed to tear the session down; the transport itself owns
  // the spec-shaped response and fires `onsessionclosed`.
  // https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
  app.delete(config.mcpHttpEndpointPath, async (c, next) => {
    if (draining) return refuseWhileDraining(c);
    const requestContext = requestContextService.createRequestContext({
      operation: 'HttpSessionTermination',
      additionalContext: { component: 'HttpTransport' },
    });
    const sessionId = c.req.header('mcp-session-id');

    // Stateless mode has no session to terminate — the stateless handler
    // answers with the spec's 405.
    if (!sessionStore) return await next();

    if (!sessionId) {
      logger.warning('DELETE request without session ID', requestContext);
      return c.json({ error: 'Mcp-Session-Id header required' }, 400);
    }

    logger.info('Session termination requested', { ...requestContext, sessionId });

    // SECURITY: validate session ownership before termination.
    if (!sessionStore.isValidForIdentity(sessionId, extractSessionIdentity())) {
      logger.warning('Session termination rejected - ownership validation failed', {
        ...requestContext,
        sessionId,
      });
      return c.json({ error: 'Session not found or access denied' }, 404);
    }

    const connection = sessionStore.getConnection(sessionId);
    if (!connection) {
      // Identity-valid but no live connection (already torn down). Drop the
      // record and answer exactly as the transport does below — one status and
      // one body shape for one operation.
      await sessionStore.terminate(sessionId);
      return c.body(null, 200);
    }

    return await connection.transport.handleRequest(c.req.raw);
  });

  // -------------------------------------------------------------------------
  // JSON-RPC over HTTP (Streamable)
  // -------------------------------------------------------------------------

  /** Validated auth info for pass-through to the SDK's `ctx.http.authInfo`. */
  const currentAuthInfo = (): AuthInfo | undefined => authContext.getStore()?.authInfo;

  // The modern (2026-07-28) leg. In stateless mode the same handler also serves
  // 2025-era traffic per request (`legacy: 'stateless'`, the default); in
  // stateful mode it is strict and the sessionful arm below owns 2025.
  const handler = createMcpHandler(serverFactory, {
    ...(bus && { bus }),
    ...(isStateful && { legacy: 'reject' as const }),
    onerror: (error) => {
      logger.debug(`MCP handler reported: ${error.message}`, transportContext);
    },
  });

  /** Serves one 2025-era request on the sessionful arm. */
  const handleLegacySessionful = async (
    store: SessionStore,
    request: Request,
    parsedBody: unknown,
    requestContext: RequestContext,
  ): Promise<Response> => {
    const authInfo = currentAuthInfo();
    const identity = extractSessionIdentity();
    const providedSessionId = request.headers.get('mcp-session-id') ?? undefined;
    const options = {
      ...(parsedBody !== undefined && { parsedBody }),
      ...(authInfo && { authInfo }),
    };

    if (providedSessionId) {
      // SECURITY: identity binding is checked before the session is reachable,
      // so a stolen session ID alone cannot resume someone else's session.
      if (!store.isValidForIdentity(providedSessionId, identity)) {
        logger.warning('Session validation failed - invalid or hijacked session', {
          ...requestContext,
          sessionId: providedSessionId,
        });
        return Response.json({ error: 'Session not found or expired' }, { status: 404 });
      }
      const connection = store.getConnection(providedSessionId);
      if (!connection) {
        return Response.json({ error: 'Session not found or expired' }, { status: 404 });
      }
      const response = await connection.transport.handleRequest(request, options);

      // The SDK transport never frees the per-POST SSE stream of a request
      // whose response `Protocol` suppressed after a cancellation, so the
      // stream and its keep-alive timer would live until the session closes
      // (#401). Close it here when the cancelled id arrived as a single-request
      // POST and is still in flight: that request is the stream's only
      // occupant, so no other response is lost. An id from a batched POST
      // shares its stream with its siblings and is left to the SDK.
      for (const id of cancelledRequestIds(parsedBody)) {
        if (connection.singleRequestIds.has(id)) connection.transport.closeSSEStream(id);
      }

      const requestId = singleRequestId(parsedBody);
      if (requestId === undefined || response.status !== 200) return response;
      connection.singleRequestIds.add(requestId);
      return onStreamEnd(response, () => connection.singleRequestIds.delete(requestId));
    }

    // No session yet: this is an `initialize` (anything else is rejected by the
    // SDK transport with the spec's 400). Capacity is checked before the
    // instance is built so a saturated server never allocates one.
    store.assertCapacity();

    const server = await serverFactory({
      era: 'legacy',
      ...(authInfo && { authInfo }),
      requestInfo: request,
    });
    // One bounded event store per session, so a `Last-Event-ID` reconnect
    // replays what the dropped stream missed and the buffer is released with
    // the session that owns it (#215). Stateless serving and the 2026-07-28
    // era have no session to resume, so neither reaches this path.
    const eventStore = config.mcpHttpResumability
      ? createBoundedEventStore({
          maxEvents: config.mcpHttpResumabilityMaxEvents,
          ttlMs: config.mcpHttpResumabilityTtlMs,
        })
      : undefined;

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: generateSecureSessionId,
      ...(eventStore && { eventStore }),
      onsessioninitialized: (sessionId) => {
        store.register(sessionId, { server, singleRequestIds: new Set(), transport }, identity);
        logger.debug('Session initialized', { ...requestContext, sessionId });
      },
      onsessionclosed: (sessionId) => {
        // Release the replay buffer at the DELETE itself. Every other way a
        // session ends drops the store along with the transport holding it.
        eventStore?.clear();
        return store.terminate(sessionId);
      },
    });

    await server.connect(transport);
    try {
      const response = await transport.handleRequest(request, options);
      // A handshake the transport refused never mints a session, so the
      // instance pair it would have owned has no owner — close it here.
      if (!transport.sessionId) await closeConnection({ server, transport });
      return response;
    } catch (error) {
      await closeConnection({ server, transport });
      throw error;
    }
  };

  app.all(config.mcpHttpEndpointPath, async (c) => {
    const requestContext = requestContextService.createRequestContext({
      operation: 'HttpRpcRequest',
      additionalContext: { component: 'HttpTransport' },
    });
    logger.debug(
      'Handling MCP request.',
      withExtra(requestContext, { path: c.req.path, method: c.req.method }),
    );

    // Media type before body: a POST whose Content-Type is not JSON is a 415,
    // not a parse error, and the SDK answers it that way. Parsing first turns
    // even a well-formed body into a misleading `-32700`, so hand those
    // straight to the handler and let it produce the canonical response.
    if (c.req.method === 'POST' && !isJsonContentType(c.req.header('content-type'))) {
      if (draining) return refuseWhileDraining(c);
      const authInfo = currentAuthInfo();
      return await handler.fetch(c.req.raw, { ...(authInfo && { authInfo }) });
    }

    // Read the POST body once, from the cache the body-limit guard may have
    // seeded. Every downstream consumer takes it as `parsedBody` because the raw
    // stream is not guaranteed re-readable after that guard runs — which also
    // keeps the SDK's own read cap out of play, so a configured limit above it
    // (or `0`) holds.
    let parsedBody: unknown;
    if (c.req.method === 'POST') {
      try {
        parsedBody = await c.req.json();
      } catch {
        // Malformed JSON never reaches classification — answer the spec's parse
        // error directly rather than letting an unreadable body reach a transport.
        return c.json(
          { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
          400,
        );
      }
    }

    const legacySessionful =
      sessionStore !== null && (await isLegacyRequest(c.req.raw, parsedBody));

    // Auth and the body read above can outlast the start of draining, so check
    // again with no await left before dispatch: a request that cleared the gate
    // never reaches the closed handler or starts a session once draining began.
    if (draining) return refuseWhileDraining(c, singleRequestId(parsedBody));

    if (legacySessionful) {
      return await handleLegacySessionful(sessionStore, c.req.raw, parsedBody, requestContext);
    }

    const authInfo = currentAuthInfo();
    const options = {
      ...(parsedBody !== undefined && { parsedBody }),
      ...(authInfo && { authInfo }),
    };
    if (!inFlight) return await handler.fetch(c.req.raw, options);

    const exchange = new AbortController();
    inFlight.add(exchange);
    const release = () => inFlight.delete(exchange);
    try {
      const response = await handler.fetch(withAddedSignal(c.req.raw, exchange.signal), options);
      return onStreamEnd(response, release);
    } catch (error) {
      release();
      throw error;
    }
  });

  logger.info('Hono application setup complete.', transportContext);
  return {
    app,
    handler,
    sessionStore,
    close: async () => {
      draining = true;
      for (const exchange of inFlight ?? []) exchange.abort();
      await handler.close();
      await sessionStore?.destroy();
    },
  };
}

/**
 * @fileoverview Test suite for HTTP transport implementation
 * @module tests/mcp-server/transports/http/httpTransport.test
 */

import { type McpRequestContext, McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { authContext } from '@/mcp-server/transports/auth/lib/authContext.js';
import type { AuthInfo } from '@/mcp-server/transports/auth/lib/authTypes.js';
import { createHttpApp } from '@/mcp-server/transports/http/httpTransport.js';
import type { HonoNodeBindings } from '@/mcp-server/transports/http/httpTypes.js';
import type { SessionStore } from '@/mcp-server/transports/http/sessionStore.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { defaultServerManifest as defaultMeta } from '../../../../helpers/fixtures.js';
import { parseSSEEvents } from '../../../../helpers/http-helpers.js';

// Mock dependencies — factory is hoisted, so all values must be inline.
vi.mock('@/config/index.js', () => ({
  config: {
    mcpSessionMode: 'stateless',
    mcpStatefulSessionStaleTimeoutMs: 60000,
    mcpAllowedOrigins: ['http://localhost:3000'],
    mcpHttpEndpointPath: '/mcp',
    mcpServerName: 'test-mcp-server',
    mcpServerVersion: '1.0.0',
    mcpServerDescription: 'Test MCP Server',
    environment: 'test',
    mcpTransportType: 'http',
    mcpAuthMode: 'none',
    oauthIssuerUrl: '',
    mcpServerResourceIdentifier: '',
    oauthAudience: '',
    oauthJwksUri: '',
    openTelemetry: { enabled: false },
  },
  FRAMEWORK_NAME: '@cyanheads/mcp-ts-core',
  FRAMEWORK_VERSION: '0.0.0-test',
}));

vi.mock('@/mcp-server/transports/auth/authFactory.js', () => ({
  createAuthStrategy: vi.fn(() => null),
}));

vi.mock('@/mcp-server/transports/auth/authMiddleware.js', () => ({
  createAuthMiddleware: vi.fn(),
}));

vi.mock('@/mcp-server/transports/auth/lib/authContext.js', () => {
  const { AsyncLocalStorage } = require('node:async_hooks');
  return {
    authContext: new AsyncLocalStorage(),
  };
});

vi.mock('@/mcp-server/transports/http/httpErrorHandler.js', () => ({
  httpErrorHandler: vi.fn(async (err, c) => c.json({ error: err.message }, 500)),
}));

/** Helper to temporarily override config properties within a test. */
async function withConfigOverrides<T>(
  overrides: Record<string, unknown>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const { config } = await import('@/config/index.js');
  const saved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = (config as Record<string, unknown>)[key];
    Object.defineProperty(config, key, { value, writable: true, configurable: true });
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      Object.defineProperty(config, key, { value, writable: true, configurable: true });
    }
  }
}

/** Runs `fn` inside a stateful-mode config override. */
const withStatefulMode = <T>(fn: () => T | Promise<T>): Promise<T> =>
  withConfigOverrides({ mcpSessionMode: 'stateful' }, fn);

// ---------------------------------------------------------------------------
// Harness
//
// The transport genuinely connects the instance the factory returns, so the
// factory builds a real `McpServer` with one trivial tool and requests actually
// round-trip. `factory.mock.calls` is therefore also the instance-identity
// probe: one call per constructed instance, so a session that reuses its pinned
// server shows exactly one call across every request it serves.
// ---------------------------------------------------------------------------

/** A factory over real `McpServer` instances, plus the instances it produced. */
function createTestFactory() {
  const servers: McpServer[] = [];
  const factory = vi.fn(async (_ctx: McpRequestContext): Promise<McpServer> => {
    const server = new McpServer(
      { name: 'test-mcp-server', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.registerTool(
      'echo',
      { description: 'Echoes its input.', inputSchema: z.object({ value: z.string() }) },
      ({ value }) => ({ content: [{ type: 'text' as const, text: value }] }),
    );
    servers.push(server);
    return server;
  });
  return { factory, servers };
}

/** The Hono app `createHttpApp` returns. */
type TestApp = Awaited<ReturnType<typeof createHttpApp<HonoNodeBindings>>>['app'];

const ORIGIN = 'http://localhost:3000';
const ENDPOINT = '/mcp';

/** Headers a 2025-era client sends on the MCP endpoint. */
const legacyHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  origin: ORIGIN,
  ...extra,
});

const initializeBody = (id = 1): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    method: 'initialize',
    id,
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    },
  });

/**
 * A 2026-07-28 request: the three routing headers plus the per-request `_meta`
 * envelope that `isLegacyRequest` classifies as modern.
 */
const modernToolCall = (toolName: string): { headers: Record<string, string>; body: string } => ({
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    origin: ORIGIN,
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': 'tools/call',
    'mcp-name': toolName,
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: { value: 'hello' },
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  }),
});

/**
 * Reads a JSON-RPC response, which may arrive as a plain JSON body or as an SSE
 * stream — in the latter case every `data:` frame is decoded and the one
 * carrying an `id` (the result, not a mid-call notification) is returned.
 */
async function readJsonRpc(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    return JSON.parse(text) as Record<string, unknown>;
  }
  const frames = parseSSEEvents(text).map(
    (event) => JSON.parse(event.data) as Record<string, unknown>,
  );
  const result = frames.find((frame) => frame.id !== undefined);
  if (!result) throw new Error(`No id-carrying SSE frame in: ${text}`);
  return result;
}

const AUTH_A: AuthInfo = {
  token: 'token-a',
  clientId: 'client-a',
  scopes: [],
  subject: 'user-a',
  tenantId: 'tenant-a',
};
const AUTH_B: AuthInfo = {
  token: 'token-b',
  clientId: 'client-b',
  scopes: [],
  subject: 'user-b',
  tenantId: 'tenant-b',
};

/** Serves one request with `authInfo` visible to the transport's identity extraction. */
const asIdentity = (
  authInfo: AuthInfo,
  run: () => Response | Promise<Response>,
): Promise<Response> => authContext.run({ authInfo }, async () => await run());

describe('HTTP Transport', () => {
  let factory: ReturnType<typeof createTestFactory>['factory'];
  let servers: McpServer[];
  let mockContext: RequestContext;
  let teardown: Array<() => Promise<void>>;

  beforeEach(() => {
    ({ factory, servers } = createTestFactory());
    teardown = [];

    mockContext = {
      requestId: 'test-request-123',
      timestamp: Date.now() as unknown as string,
      operation: 'test-http-transport',
    };
  });

  afterEach(async () => {
    for (const close of teardown) await close();
    vi.restoreAllMocks();
  });

  /** Builds the app under test and registers its teardown. */
  async function buildApp(manifest = defaultMeta) {
    const created = await createHttpApp(factory, mockContext, manifest);
    teardown.push(created.close);
    return created;
  }

  describe('createHttpApp', () => {
    test('should create Hono app instance', async () => {
      const { app } = await buildApp();

      expect(app).toBeDefined();
      expect(typeof app.fetch).toBe('function');
      expect(typeof app.get).toBe('function');
      expect(typeof app.post).toBe('function');
      expect(typeof app.delete).toBe('function');
    });

    test('should configure CORS middleware', async () => {
      const { app } = await buildApp();

      const response = await app.request('/test', {
        method: 'OPTIONS',
        headers: { Origin: ORIGIN },
      });

      expect(response.headers.get('access-control-allow-origin')).toBeTruthy();
    });

    test('should register health endpoint', async () => {
      const { app } = await buildApp();

      const response = await app.request('/healthz', { method: 'GET' });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual({ status: 'ok' });
    });

    test('should register MCP status endpoint', async () => {
      const { app } = await buildApp();

      const response = await app.request(ENDPOINT, { method: 'GET' });
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data.status).toBe('ok');
      expect(data.server).toMatchObject({
        name: 'test-mcp-server',
        version: '1.0.0',
        description: 'Test MCP Server',
        keywords: ['test', 'fixture'],
        environment: 'test',
        transport: 'http',
        sessionMode: 'stateless',
      });
    });

    test('should serve SEP-1649 Server Card at /.well-known/mcp.json', async () => {
      const { app } = await buildApp();

      const response = await app.request('/.well-known/mcp.json', { method: 'GET' });
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(data.server_name).toBe('test-mcp-server');
      expect(data.mcp_version).toBeDefined();
      expect((data.endpoints as Record<string, unknown>)?.streamable_http).toContain(ENDPOINT);
      expect(data.capabilities).toBeDefined();
    });

    test('should serve HTML landing page at /', async () => {
      const { app } = await buildApp();

      const response = await app.request('/', { method: 'GET' });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('cache-control')).toContain('public');
      const body = await response.text();
      expect(body).toContain('<!DOCTYPE html>');
      expect(body).toContain('test-mcp-server');
      expect(body).toContain('/.well-known/mcp.json');
    });

    test('should skip landing page when landing.enabled=false', async () => {
      const { app } = await buildApp({
        ...defaultMeta,
        landing: { ...defaultMeta.landing, enabled: false },
      });

      const response = await app.request('/');
      expect(response.status).toBe(404);
    });

    test('should serve robots.txt alongside the landing page', async () => {
      const { app } = await buildApp();

      const response = await app.request('/robots.txt', { method: 'GET' });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Disallow');
    });

    test('should pass SSE GET requests through to transport handler', async () => {
      const { app } = await buildApp();

      const response = await app.request(ENDPOINT, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', Origin: ORIGIN },
      });

      // Falls through to the MCP handler rather than returning the status JSON.
      const text = await response.text();
      expect(text).not.toContain('"status":"ok"');
    });

    test('should serve OAuth metadata endpoint with minimal metadata when OAuth not configured', async () => {
      await withConfigOverrides({ mcpAuthMode: 'jwt' }, async () => {
        const { app } = await buildApp();

        const response = await app.request('/.well-known/oauth-protected-resource', {
          method: 'GET',
        });
        const data = (await response.json()) as Record<string, unknown>;

        expect(response.status).toBe(200);
        expect(data.bearer_methods_supported).toEqual(['header']);
        // No authorization_servers when OAuth is not configured
        expect(data.authorization_servers).toBeUndefined();
      });
    });

    test('should also serve OAuth metadata at the RFC 8414 path-suffixed variant', async () => {
      await withConfigOverrides({ mcpAuthMode: 'jwt' }, async () => {
        const { app } = await buildApp();

        const bare = await app.request('/.well-known/oauth-protected-resource', { method: 'GET' });
        const suffixed = await app.request('/.well-known/oauth-protected-resource/mcp', {
          method: 'GET',
        });

        expect(suffixed.status).toBe(200);
        const bareBody = (await bare.json()) as Record<string, unknown>;
        const suffixedBody = (await suffixed.json()) as Record<string, unknown>;
        expect(suffixedBody).toEqual(bareBody);
      });
    });

    // Serving Protected Resource Metadata declares the server an OAuth-protected
    // resource. In `none` mode that sends a discovering client into an OAuth flow
    // it can never complete — no authorization_servers to register with — so the
    // routes must not exist at all. (#293)
    test('should not mount Protected Resource Metadata when auth mode is none', async () => {
      const { app } = await buildApp();

      const bare = await app.request('/.well-known/oauth-protected-resource', { method: 'GET' });
      const suffixed = await app.request('/.well-known/oauth-protected-resource/mcp', {
        method: 'GET',
      });

      expect(bare.status).toBe(404);
      expect(suffixed.status).toBe(404);
    });

    test('should mount Protected Resource Metadata with authorization servers in oauth mode', async () => {
      await withConfigOverrides(
        { mcpAuthMode: 'oauth', oauthIssuerUrl: 'https://auth.example.com' },
        async () => {
          const { app } = await buildApp();

          const response = await app.request('/.well-known/oauth-protected-resource', {
            method: 'GET',
          });

          expect(response.status).toBe(200);
          const data = (await response.json()) as Record<string, unknown>;
          expect(data.authorization_servers).toEqual(['https://auth.example.com']);
        },
      );
    });

    test('should reject requests with invalid origin', async () => {
      const { app } = await buildApp();

      const response = await app.request(ENDPOINT, {
        method: 'POST',
        headers: legacyHeaders({ origin: 'http://evil.com' }),
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
      });
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(403);
      expect(data.error).toContain('Invalid origin');
    });

    test('should allow requests with valid origin', async () => {
      const { app } = await buildApp();

      const response = await app.request(ENDPOINT, {
        method: 'POST',
        headers: legacyHeaders(),
        body: initializeBody(),
      });

      expect(response.status).not.toBe(403);
    });

    test('should include credentials in CORS when origin is explicitly configured', async () => {
      const { app } = await buildApp();

      const response = await app.request(ENDPOINT, {
        method: 'OPTIONS',
        headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
      });

      expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    });

    test('should omit credentials in CORS when origin is wildcard', async () => {
      await withConfigOverrides({ mcpAllowedOrigins: [] }, async () => {
        const { app } = await buildApp();

        const response = await app.request(ENDPOINT, {
          method: 'OPTIONS',
          headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
        });

        // Wildcard origin must not set credentials (browsers reject the preflight)
        expect(response.headers.get('access-control-allow-credentials')).toBeNull();
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
      });
    });

    test('Origin guard: rejects non-loopback browser Origin when no allowlist configured', async () => {
      await withConfigOverrides({ mcpAllowedOrigins: [] }, async () => {
        const { app } = await buildApp();

        const response = await app.request(ENDPOINT, {
          method: 'POST',
          headers: legacyHeaders({ origin: 'http://evil.example' }),
          body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
        });

        expect(response.status).toBe(403);
        const data = (await response.json()) as Record<string, unknown>;
        expect(data.error).toContain('Invalid origin');
      });
    });

    test.each([
      ['http://localhost', 'http://localhost'],
      ['localhost with port', 'http://localhost:8080'],
      ['127.0.0.1', 'http://127.0.0.1'],
      ['127.0.0.1 with port', 'http://127.0.0.1:3000'],
      ['IPv6 loopback', 'http://[::1]:3010'],
    ])(
      'Origin guard: accepts %s (%s) as loopback when no allowlist configured',
      async (_label, origin) => {
        await withConfigOverrides({ mcpAllowedOrigins: [] }, async () => {
          const { app } = await buildApp();

          const response = await app.request(ENDPOINT, {
            method: 'POST',
            headers: legacyHeaders({ origin }),
            body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
          });

          // Not a 403 — Origin passed the guard. The handler may still answer
          // an error for the payload, but the Origin check must have allowed it.
          expect(response.status).not.toBe(403);
        });
      },
    );

    test('Origin guard: MCP_ALLOWED_ORIGINS="*" accepts any Origin (explicit opt-in)', async () => {
      await withConfigOverrides({ mcpAllowedOrigins: ['*'] }, async () => {
        const { app } = await buildApp();

        const response = await app.request(ENDPOINT, {
          method: 'POST',
          headers: legacyHeaders({ origin: 'https://anything.example' }),
          body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
        });

        expect(response.status).not.toBe(403);
      });
    });

    test('Origin guard: passes through when no Origin header (CLI client)', async () => {
      await withConfigOverrides({ mcpAllowedOrigins: [] }, async () => {
        const { app } = await buildApp();

        const response = await app.request(ENDPOINT, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
        });

        expect(response.status).not.toBe(403);
      });
    });

    test('answers malformed JSON with a -32700 parse error before any transport sees it', async () => {
      const { app } = await buildApp();

      const response = await app.request(ENDPOINT, {
        method: 'POST',
        headers: legacyHeaders(),
        body: '{ "jsonrpc": "2.0", ',
      });
      const body = (await response.json()) as { error: { code: number; message: string } };

      expect(response.status).toBe(400);
      expect(body.error).toMatchObject({ code: -32700, message: 'Parse error' });
      expect(factory).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Stateless mode: one `createMcpHandler` answers both eras per request, so
  // there is no session store and no session lifecycle at all.
  // -------------------------------------------------------------------------
  describe('Stateless session mode', () => {
    test('does not create a session store', async () => {
      const { sessionStore } = await buildApp();
      expect(sessionStore).toBeNull();
    });

    test('serves a 2025-era initialize without minting a session', async () => {
      const { app } = await buildApp();

      const response = await app.request(ENDPOINT, {
        method: 'POST',
        headers: legacyHeaders(),
        body: initializeBody(),
      });
      const body = (await readJsonRpc(response)) as { result?: { serverInfo?: unknown } };

      expect(response.status).toBe(200);
      expect(response.headers.get('mcp-session-id')).toBeNull();
      expect(body.result?.serverInfo).toMatchObject({ name: 'test-mcp-server' });
    });

    test.each([['GET'], ['DELETE']])(
      'answers %s on the MCP endpoint with 405 (no session operations)',
      async (method) => {
        const { app } = await buildApp();

        const response = await app.request(ENDPOINT, {
          method,
          headers: { accept: 'text/event-stream', origin: ORIGIN },
        });
        const body = (await response.json()) as { error: { message: string } };

        expect(response.status).toBe(405);
        expect(body.error.message).toContain('Method not allowed');
      },
    );
  });

  // -------------------------------------------------------------------------
  // Stateful mode: 2025-era traffic is served by a persistent McpServer +
  // transport pair per Mcp-Session-Id, held in the session store.
  // -------------------------------------------------------------------------
  describe('Stateful session mode', () => {
    /** Initializes a session and returns its ID. */
    async function initialize(app: TestApp, id = 1): Promise<string> {
      const response = await app.request(ENDPOINT, {
        method: 'POST',
        headers: legacyHeaders(),
        body: initializeBody(id),
      });
      await response.text();
      const sessionId = response.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();
      return sessionId as string;
    }

    test('creates an empty session store', async () => {
      await withStatefulMode(async () => {
        const { sessionStore } = await buildApp();

        expect(sessionStore).not.toBeNull();
        expect((sessionStore as SessionStore).getSessionCount()).toBe(0);
      });
    });

    test('mints a 64-hex session ID on initialize', async () => {
      await withStatefulMode(async () => {
        const { app, sessionStore } = await buildApp();

        const response = await app.request(ENDPOINT, {
          method: 'POST',
          headers: legacyHeaders(),
          body: initializeBody(),
        });
        await response.text();

        expect(response.status).toBe(200);
        expect(response.headers.get('mcp-session-id')).toMatch(/^[0-9a-f]{64}$/);
        expect((sessionStore as SessionStore).getSessionCount()).toBe(1);
      });
    });

    test('routes every request on a session to the SAME McpServer instance', async () => {
      await withStatefulMode(async () => {
        const { app, sessionStore } = await buildApp();
        const sessionId = await initialize(app);

        expect(factory).toHaveBeenCalledTimes(1);
        expect(factory.mock.calls[0]?.[0]).toMatchObject({ era: 'legacy' });

        for (const id of [2, 3]) {
          const response = await app.request(ENDPOINT, {
            method: 'POST',
            headers: legacyHeaders({ 'mcp-session-id': sessionId }),
            body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id }),
          });
          const body = (await readJsonRpc(response)) as {
            result: { tools: Array<{ name: string }> };
          };
          expect(response.status).toBe(200);
          expect(body.result.tools.map((tool) => tool.name)).toEqual(['echo']);
        }

        // One instance for the whole session — not one per request.
        expect(factory).toHaveBeenCalledTimes(1);
        expect(servers).toHaveLength(1);
        expect(sessionStore?.getConnection(sessionId)?.server).toBe(servers[0]);
      });
    });

    test('answers an unknown session ID with 404', async () => {
      await withStatefulMode(async () => {
        const { app } = await buildApp();

        const response = await app.request(ENDPOINT, {
          method: 'POST',
          headers: legacyHeaders({ 'mcp-session-id': 'f'.repeat(64) }),
          body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
        });

        expect(response.status).toBe(404);
        expect(factory).not.toHaveBeenCalled();
      });
    });

    test('answers a non-initialize request with no session ID with the transport 400', async () => {
      await withStatefulMode(async () => {
        const { app, sessionStore } = await buildApp();

        const response = await app.request(ENDPOINT, {
          method: 'POST',
          headers: legacyHeaders(),
          body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
        });
        const body = (await response.json()) as { error: { message: string } };

        expect(response.status).toBe(400);
        expect(body.error.message).toContain('Bad Request');
        expect((sessionStore as SessionStore).getSessionCount()).toBe(0);
      });
    });

    test('refuses a new session once the store is at capacity, before building an instance', async () => {
      await withStatefulMode(async () => {
        const { app, sessionStore } = await buildApp();
        await initialize(app);
        expect(factory).toHaveBeenCalledTimes(1);

        // Saturate: the one live session now equals the cap.
        (sessionStore as unknown as { maxSessions: number }).maxSessions = 1;

        const response = await app.request(ENDPOINT, {
          method: 'POST',
          headers: legacyHeaders(),
          body: initializeBody(2),
        });
        const body = (await response.json()) as { error: string };

        expect(response.ok).toBe(false);
        expect(body.error).toContain('Maximum session capacity reached');
        // No second instance was allocated only to be thrown away.
        expect(factory).toHaveBeenCalledTimes(1);
        expect((sessionStore as SessionStore).getSessionCount()).toBe(1);
      });
    });

    describe('DELETE', () => {
      test('terminates the session and makes it unreachable', async () => {
        await withStatefulMode(async () => {
          const { app, sessionStore } = await buildApp();
          const sessionId = await initialize(app);

          const response = await app.request(ENDPOINT, {
            method: 'DELETE',
            headers: { origin: ORIGIN, 'mcp-session-id': sessionId },
          });

          expect(response.status).toBe(200);
          expect((sessionStore as SessionStore).getSessionCount()).toBe(0);

          const afterwards = await app.request(ENDPOINT, {
            method: 'POST',
            headers: legacyHeaders({ 'mcp-session-id': sessionId }),
            body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 9 }),
          });
          expect(afterwards.status).toBe(404);
        });
      });

      test('requires the Mcp-Session-Id header', async () => {
        await withStatefulMode(async () => {
          const { app } = await buildApp();

          const response = await app.request(ENDPOINT, {
            method: 'DELETE',
            headers: { origin: ORIGIN },
          });
          const data = (await response.json()) as Record<string, unknown>;

          expect(response.status).toBe(400);
          expect(data.error).toContain('Mcp-Session-Id header required');
        });
      });

      test('refuses a session bound to a different identity with 404', async () => {
        await withStatefulMode(async () => {
          const { app, sessionStore } = await buildApp();

          const initialized = await asIdentity(AUTH_A, () =>
            app.request(ENDPOINT, {
              method: 'POST',
              headers: legacyHeaders(),
              body: initializeBody(),
            }),
          );
          await initialized.text();
          const sessionId = initialized.headers.get('mcp-session-id') as string;
          expect(sessionId).toBeTruthy();

          const response = await asIdentity(AUTH_B, () =>
            app.request(ENDPOINT, {
              method: 'DELETE',
              headers: { origin: ORIGIN, 'mcp-session-id': sessionId },
            }),
          );
          const data = (await response.json()) as Record<string, unknown>;

          expect(response.status).toBe(404);
          expect(data.error).toContain('Session not found or access denied');
          // The rightful owner's session survives the refused termination.
          expect((sessionStore as SessionStore).getSessionCount()).toBe(1);
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // In stateful mode `isLegacyRequest` splits the traffic: 2026-07-28 requests
  // go to the strict (`legacy: 'reject'`) modern handler, which is per-request
  // by construction; claim-less requests go to the sessionful arm.
  // -------------------------------------------------------------------------
  describe('Legacy/modern request split (stateful)', () => {
    test('serves a 2026-07-28 request on the modern handler, minting no session', async () => {
      await withStatefulMode(async () => {
        const { app, sessionStore } = await buildApp();
        const { headers, body } = modernToolCall('echo');

        const response = await app.request(ENDPOINT, { method: 'POST', headers, body });
        const result = (await readJsonRpc(response)) as {
          result: { content: Array<{ text: string }> };
        };

        expect(response.status).toBe(200);
        expect(response.headers.get('mcp-session-id')).toBeNull();
        expect(result.result.content[0]?.text).toBe('hello');
        expect((sessionStore as SessionStore).getSessionCount()).toBe(0);
        expect(factory.mock.calls.map((call) => call[0]?.era)).toEqual(['modern']);
      });
    });

    test('serves a claim-less request on the sessionful arm', async () => {
      await withStatefulMode(async () => {
        const { app, sessionStore } = await buildApp();

        const response = await app.request(ENDPOINT, {
          method: 'POST',
          headers: legacyHeaders(),
          body: initializeBody(),
        });
        await response.text();

        expect(response.headers.get('mcp-session-id')).toMatch(/^[0-9a-f]{64}$/);
        expect((sessionStore as SessionStore).getSessionCount()).toBe(1);
        expect(factory.mock.calls.map((call) => call[0]?.era)).toEqual(['legacy']);
      });
    });
  });

  describe('Request body size limit (issue #157)', () => {
    const overLimitBody = JSON.stringify({
      jsonrpc: '2.0',
      method: 'ping',
      id: 1,
      params: { padding: 'x'.repeat(2000) },
    });

    test('rejects an over-limit POST body with 413', async () => {
      await withConfigOverrides({ mcpHttpMaxBodyBytes: 200 }, async () => {
        const { app } = await buildApp();

        const response = await app.request(ENDPOINT, {
          method: 'POST',
          headers: legacyHeaders(),
          body: overLimitBody,
        });

        expect(response.status).toBe(413);
        const data = (await response.json()) as Record<string, unknown>;
        expect(data.error).toContain('exceeds');
      });
    });

    test('rejects an over-limit body with no Content-Length (streamed) with 413', async () => {
      await withConfigOverrides({ mcpHttpMaxBodyBytes: 200 }, async () => {
        const { app } = await buildApp();

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('x'.repeat(2000)));
            controller.close();
          },
        });

        const response = await app.request(ENDPOINT, {
          method: 'POST',
          headers: legacyHeaders(),
          body: stream,
          duplex: 'half',
        } as RequestInit);

        expect(response.status).toBe(413);
      });
    });

    test('allows an under-limit POST body (not 413)', async () => {
      await withConfigOverrides({ mcpHttpMaxBodyBytes: 1024 * 1024 }, async () => {
        const { app } = await buildApp();

        const response = await app.request(ENDPOINT, {
          method: 'POST',
          headers: legacyHeaders(),
          body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
        });

        expect(response.status).not.toBe(413);
      });
    });

    test('disabled (0) accepts an otherwise-over-limit body', async () => {
      await withConfigOverrides({ mcpHttpMaxBodyBytes: 0 }, async () => {
        const { app } = await buildApp();

        const response = await app.request(ENDPOINT, {
          method: 'POST',
          headers: legacyHeaders(),
          body: overLimitBody,
        });

        expect(response.status).not.toBe(413);
      });
    });

    test('does not apply the limit to GET status requests', async () => {
      await withConfigOverrides({ mcpHttpMaxBodyBytes: 1 }, async () => {
        const { app } = await buildApp();

        const response = await app.request(ENDPOINT, { method: 'GET' });

        expect(response.status).toBe(200);
        const data = (await response.json()) as Record<string, unknown>;
        expect(data.status).toBe('ok');
      });
    });

    test('accepts a small canvas-style request even under a tight limit', async () => {
      // A dataframe_query request is tiny even though the canvas it targets may
      // hold hundreds of MB — the staged data was fetched upstream server-side
      // and lives in DuckDB, never in the request body. The cap measures the
      // inbound JSON-RPC body only, so canvas servers are unaffected by it.
      await withConfigOverrides({ mcpHttpMaxBodyBytes: 2048 }, async () => {
        const { app } = await buildApp();

        const response = await app.request(ENDPOINT, {
          method: 'POST',
          headers: legacyHeaders(),
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'tools/call',
            id: 1,
            params: {
              name: 'dataframe_query',
              arguments: {
                canvas_id: 'a1b2c3d4e5',
                sql: 'SELECT * FROM spilled_0a1b2c3d LIMIT 100',
              },
            },
          }),
        });

        expect(response.status).not.toBe(413);
      });
    });

    test('preserves a valid streamed body for the downstream SDK handler', async () => {
      // The guard drains the raw stream to measure it, so the body it caches is
      // the only copy the SDK can still read. A real round-trip is the proof:
      // an initialize split across two chunks still produces an initialize result.
      await withConfigOverrides({ mcpHttpMaxBodyBytes: 2048 }, async () => {
        const encoded = new TextEncoder().encode(initializeBody());
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoded.subarray(0, 10));
            controller.enqueue(encoded.subarray(10));
            controller.close();
          },
        });
        const { app } = await buildApp();

        const response = await app.request(ENDPOINT, {
          method: 'POST',
          headers: legacyHeaders(),
          body: stream,
          duplex: 'half',
        } as RequestInit);
        const body = (await readJsonRpc(response)) as {
          result?: { protocolVersion?: string };
        };

        expect(response.status).toBe(200);
        expect(body.result?.protocolVersion).toBeTruthy();
      });
    });
  });

  // Verification for issue #244. The #157 tests above only assert an eventual
  // 413 — they pass even when the entire over-limit body is buffered first.
  // These assert the property that actually protects memory: when no
  // Content-Length is present, the cap must be enforced by a streaming read
  // that stops shortly after the limit is exceeded — not by buffering the whole
  // body via arrayBuffer() and checking afterward.
  describe('Body-size cap must bound buffering, not just eventually reject (issue #244)', () => {
    const CAP = 200;

    /** A lazy stream that records how many bytes were pulled and whether it was
     * cancelled. Offers `chunkSize × chunks` bytes total, far over the cap, but
     * only as the consumer pulls — so `bytesPulled` reflects how much the
     * middleware actually read before responding. */
    function instrumentedStream(chunkSize: number, chunks: number) {
      const state = { bytesPulled: 0, cancelled: false, pulls: 0 };
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (state.pulls >= chunks) {
            controller.close();
            return;
          }
          state.pulls++;
          state.bytesPulled += chunkSize;
          controller.enqueue(new Uint8Array(chunkSize));
        },
        cancel() {
          state.cancelled = true;
        },
      });
      return { stream, state };
    }

    test('rejects an over-limit no-Content-Length body without buffering all of it', async () => {
      await withConfigOverrides({ mcpHttpMaxBodyBytes: CAP }, async () => {
        const { app } = await buildApp();

        // 64 KiB offered in 1 KiB pulls — 327x the 200-byte cap.
        const { stream, state } = instrumentedStream(1024, 64);

        const response = await app.request(ENDPOINT, {
          method: 'POST',
          headers: legacyHeaders(),
          body: stream,
          duplex: 'half',
        } as RequestInit);

        expect(response.status).toBe(413);

        // A streaming cap stops reading shortly after the limit is exceeded
        // (8 KiB slack for read-ahead).
        expect(state.cancelled).toBe(true);
        expect(state.bytesPulled).toBeLessThan(CAP + 8 * 1024);
      });
    });

    test('rejects and cancels an over-limit body with dishonest Content-Length', async () => {
      await withConfigOverrides({ mcpHttpMaxBodyBytes: CAP }, async () => {
        const { app } = await buildApp();
        const { stream, state } = instrumentedStream(1024, 64);

        const response = await app.request(ENDPOINT, {
          method: 'POST',
          headers: legacyHeaders({ 'content-length': '100' }),
          body: stream,
          duplex: 'half',
        } as RequestInit);

        expect(response.status).toBe(413);
        expect(state.cancelled).toBe(true);
        expect(state.bytesPulled).toBeLessThan(CAP + 8 * 1024);
      });
    });
  });

  describe('Error handling integration', () => {
    test('should use centralized error handler', async () => {
      const { app } = await buildApp();

      // Simulate an error by accessing a non-existent route with proper method
      const response = await app.request('/nonexistent', { method: 'GET' });

      // Should return 404 for non-existent route
      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Teardown. `close()` owns the whole MCP layer: the modern handler (which
  // aborts its in-flight exchanges and closes their per-request instances) and
  // the session store (which closes every live session's server + transport).
  // -------------------------------------------------------------------------
  describe('close() teardown', () => {
    test('closes the modern handler', async () => {
      const { handler, close } = await createHttpApp(factory, mockContext, defaultMeta);
      const handlerCloseSpy = vi.spyOn(handler, 'close');

      await close();

      expect(handlerCloseSpy).toHaveBeenCalledTimes(1);
    });

    test('closes every live session exactly once and empties the store', async () => {
      await withStatefulMode(async () => {
        const { app, close, sessionStore } = await createHttpApp(factory, mockContext, defaultMeta);
        const store = sessionStore as SessionStore;

        const sessionIds: string[] = [];
        for (const id of [1, 2]) {
          const response = await app.request(ENDPOINT, {
            method: 'POST',
            headers: legacyHeaders(),
            body: initializeBody(id),
          });
          await response.text();
          sessionIds.push(response.headers.get('mcp-session-id') as string);
        }
        expect(store.getSessionCount()).toBe(2);

        const closeSpies = sessionIds.map((sessionId) => {
          const connection = store.getConnection(sessionId);
          if (!connection) throw new Error(`missing connection for ${sessionId}`);
          return {
            server: vi.spyOn(connection.server, 'close'),
            transport: vi.spyOn(connection.transport, 'close'),
          };
        });

        await close();

        expect(store.getSessionCount()).toBe(0);
        for (const spy of closeSpies) {
          expect(spy.server).toHaveBeenCalledTimes(1);
          expect(spy.transport).toHaveBeenCalledTimes(1);
        }
      });
    });

    test('is safe to call when no session was ever created', async () => {
      await withStatefulMode(async () => {
        const { close, sessionStore } = await createHttpApp(factory, mockContext, defaultMeta);

        await expect(close()).resolves.toBeUndefined();
        expect((sessionStore as SessionStore).getSessionCount()).toBe(0);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Per-request log context — issue #194 regression
  //
  // Per-request route handlers previously logged with the setup-time
  // `transportContext` (built once in createHttpApp from the boot parent
  // context), freezing requestId/timestamp/traceId/spanId at boot — so a
  // session-termination logged hours after startup carried boot's timestamp
  // and trace IDs. Each handler now derives its own context via
  // createRequestContext, so every per-request log line gets a fresh
  // requestId + timestamp (and live trace/span IDs when OTel is enabled).
  // -------------------------------------------------------------------------
  describe('Per-request log context (issue #194)', () => {
    test('per-request handler logs carry a fresh context, not the frozen boot context', async () => {
      await withStatefulMode(async () => {
        const warnSpy = vi.spyOn(logger, 'warning').mockImplementation(() => {});
        const { app } = await buildApp();

        // DELETE without a session ID hits a per-request handler log.
        await app.request(ENDPOINT, { method: 'DELETE', headers: { origin: ORIGIN } });

        const call = warnSpy.mock.calls.find(
          ([msg]) => msg === 'DELETE request without session ID',
        );
        expect(call).toBeDefined();
        const ctx = call?.[1] as RequestContext;

        // Fresh per-request requestId — not the boot context's id.
        expect(ctx.requestId).toBeTruthy();
        expect(ctx.requestId).not.toBe(mockContext.requestId);
        // Fresh ISO 8601 timestamp — not the boot context's (numeric) stamp.
        expect(typeof ctx.timestamp).toBe('string');
        expect(ctx.timestamp).not.toBe(mockContext.timestamp);
        expect(Number.isNaN(Date.parse(ctx.timestamp as string))).toBe(false);
      });
    });

    test('distinct requests get distinct per-request contexts (not frozen at boot)', async () => {
      await withStatefulMode(async () => {
        const warnSpy = vi.spyOn(logger, 'warning').mockImplementation(() => {});
        const { app } = await buildApp();

        await app.request(ENDPOINT, { method: 'DELETE', headers: { origin: ORIGIN } });
        await app.request(ENDPOINT, { method: 'DELETE', headers: { origin: ORIGIN } });

        const ids = warnSpy.mock.calls
          .filter(([msg]) => msg === 'DELETE request without session ID')
          .map(([, ctx]) => (ctx as RequestContext).requestId);

        expect(ids).toHaveLength(2);
        expect(ids[0]).not.toBe(ids[1]);
      });
    });
  });
});

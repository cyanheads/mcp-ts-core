/**
 * @fileoverview Integration tests for HTTP transport using Hono's `.request()` method.
 * Validates the Hono middleware chain (health, CORS, 404 handling) without
 * booting a real HTTP server, avoiding port conflicts in CI.
 * @module tests/mcp-server/transports/http/httpTransport.integration.test
 */

import { type McpRequestContext, McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — hoisted by vitest, so all values must be inline.
// ---------------------------------------------------------------------------

vi.mock('@/config/index.js', () => ({
  config: {
    environment: 'testing',
    mcpServerVersion: '1.0.0-test',
    mcpServerName: 'test-mcp-server',
    mcpServerDescription: 'Test MCP Server',
    mcpHttpPort: 0,
    mcpHttpHost: '127.0.0.1',
    mcpHttpEndpointPath: '/mcp',
    mcpTransportType: 'http',
    mcpSessionMode: 'stateless',
    mcpStatefulSessionStaleTimeoutMs: 600000,
    mcpAllowedOrigins: [],
    mcpAuthMode: 'none',
    oauthIssuerUrl: '',
    oauthAudience: '',
    oauthJwksUri: '',
    mcpServerResourceIdentifier: '',
    openTelemetry: { enabled: false },
    logsPath: undefined,
  },
}));

vi.mock('@/utils/internal/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    crit: vi.fn(),
    emerg: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('@/utils/internal/requestContext.js', () => ({
  requestContextService: {
    createRequestContext: vi.fn(() => ({
      requestId: 'test-req-id',
      timestamp: new Date().toISOString(),
    })),
  },
}));

vi.mock('@/utils/telemetry/metrics.js', () => ({
  createCounter: vi.fn(() => ({ add: vi.fn() })),
  createHistogram: vi.fn(() => ({ record: vi.fn() })),
  createObservableGauge: vi.fn(),
}));

vi.mock('@/mcp-server/transports/auth/authFactory.js', () => ({
  createAuthStrategy: vi.fn(() => null),
}));

vi.mock('@/mcp-server/transports/auth/authMiddleware.js', () => ({
  createAuthMiddleware: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => await next()),
}));

vi.mock('@/mcp-server/transports/auth/lib/authContext.js', () => ({
  authContext: { get: vi.fn(() => undefined), getStore: vi.fn(() => undefined) },
}));

vi.mock('@/mcp-server/transports/http/protectedResourceMetadata.js', () => ({
  protectedResourceMetadataHandler: vi.fn(async (c: any) => c.json({})),
}));

vi.mock('@/utils/internal/startupBanner.js', () => ({
  logStartupBanner: vi.fn(),
}));

vi.mock('@hono/otel', () => ({
  httpInstrumentationMiddleware: vi.fn(
    () => async (_c: unknown, next: () => Promise<void>) => await next(),
  ),
}));

vi.mock('@/mcp-server/transports/http/httpErrorHandler.js', () => ({
  httpErrorHandler: vi.fn(async (err: Error, c: any) => c.json({ error: err.message }, 500)),
}));

// ---------------------------------------------------------------------------
// Import under test — after all mocks are declared.
// ---------------------------------------------------------------------------

import { config } from '@/config/index.js';
import { createHttpApp } from '@/mcp-server/transports/http/httpTransport.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { defaultServerManifest as defaultMeta } from '../helpers/fixtures.js';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('HTTP Transport Integration', () => {
  let mockServerFactory: ReturnType<typeof vi.fn>;
  let mockContext: RequestContext;

  beforeEach(() => {
    mockServerFactory = vi.fn(async () => ({
      connect: vi.fn(),
      close: vi.fn(),
    })) as any;

    mockContext = {
      requestId: 'test-req-id',
      timestamp: new Date().toISOString(),
      operation: 'http-transport-integration-test',
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('GET /healthz returns 200 with status ok', async () => {
    const { app } = await createHttpApp(
      mockServerFactory as () => Promise<McpServer>,
      mockContext,
      defaultMeta,
    );

    const res = await app.request('/healthz');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  test('GET /healthz includes CORS headers', async () => {
    const { app } = await createHttpApp(
      mockServerFactory as () => Promise<McpServer>,
      mockContext,
      defaultMeta,
    );

    const req = new Request('http://localhost/healthz', {
      method: 'GET',
      headers: { Origin: 'http://example.com' },
    });
    const res = await app.request(req);

    expect(res.status).toBe(200);
    // Wildcard CORS is configured — the response must include the allow-origin header.
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('unknown routes return 404', async () => {
    const { app } = await createHttpApp(
      mockServerFactory as () => Promise<McpServer>,
      mockContext,
      defaultMeta,
    );

    const res = await app.request('/nonexistent');

    expect(res.status).toBe(404);
  });

  describe('stateful session gate', () => {
    /** A real server the sessionful transport can actually connect. */
    const realFactory = () =>
      vi.fn(
        async (requestContext: McpRequestContext) =>
          new McpServer(
            { name: `session-gate-test-${requestContext.era}`, version: '0.0.0' },
            { capabilities: { tools: { listChanged: true } } },
          ),
      );

    const post = (body: unknown, headers: Record<string, string> = {}) =>
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-06-18',
          ...headers,
        },
        body: JSON.stringify(body),
      });

    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    };

    afterEach(() => {
      // Restore stateless for other tests
      (config as any).mcpSessionMode = 'stateless';
    });

    test('rejects non-initialize POST without session ID in stateful mode', async () => {
      (config as any).mcpSessionMode = 'stateful';

      const { app, close } = await createHttpApp(realFactory(), mockContext, defaultMeta);

      const res = await app.request(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));

      // The SDK transport owns this rejection now: a session-less non-initialize
      // request reaches an uninitialized instance and is refused.
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { message?: string } };
      expect(body.error?.message).toContain('Server not initialized');
      await close();
    });

    test('rejects GET SSE without session ID in stateful mode', async () => {
      (config as any).mcpSessionMode = 'stateful';

      const { app, close } = await createHttpApp(realFactory(), mockContext, defaultMeta);

      const res = await app.request(
        new Request('http://localhost/mcp', {
          method: 'GET',
          headers: { Accept: 'text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
        }),
      );

      expect(res.status).toBe(400);
      await close();
    });

    test('mints a session on initialize and reuses one instance for it', async () => {
      (config as any).mcpSessionMode = 'stateful';

      const factory = realFactory();
      const { app, close, sessionStore } = await createHttpApp(factory, mockContext, defaultMeta);

      const res = await app.request(post(initialize));
      expect(res.status).toBe(200);
      const sessionId = res.headers.get('mcp-session-id');
      expect(sessionId).toMatch(/^[0-9a-f]{64}$/);
      await res.text();

      expect(sessionStore?.getSessionCount()).toBe(1);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(factory.mock.calls[0]?.[0]).toMatchObject({ era: 'legacy' });

      // A follow-up on the same session reaches the SAME instance — the factory
      // is not called again.
      const follow = await app.request(
        post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'Mcp-Session-Id': sessionId! }),
      );
      expect(follow.status).toBe(200);
      await follow.text();
      expect(factory).toHaveBeenCalledTimes(1);
      await close();
    });

    test('rejects an unknown session ID with 404', async () => {
      (config as any).mcpSessionMode = 'stateful';

      const { app, close } = await createHttpApp(realFactory(), mockContext, defaultMeta);

      const res = await app.request(
        post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'Mcp-Session-Id': 'f'.repeat(64) }),
      );

      expect(res.status).toBe(404);
      expect((await res.json()) as unknown).toMatchObject({ error: expect.any(String) });
      await close();
    });

    test('DELETE terminates the session and later use is refused', async () => {
      (config as any).mcpSessionMode = 'stateful';

      const { app, close, sessionStore } = await createHttpApp(
        realFactory(),
        mockContext,
        defaultMeta,
      );

      const init = await app.request(post(initialize));
      const sessionId = init.headers.get('mcp-session-id') as string;
      await init.text();

      const deleted = await app.request(
        new Request('http://localhost/mcp', {
          method: 'DELETE',
          headers: { 'Mcp-Session-Id': sessionId },
        }),
      );
      expect(deleted.status).toBe(200);
      expect(sessionStore?.getSessionCount()).toBe(0);

      const after = await app.request(
        post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'Mcp-Session-Id': sessionId }),
      );
      expect(after.status).toBe(404);
      await close();
    });

    test('DELETE without a session ID is a 400', async () => {
      (config as any).mcpSessionMode = 'stateful';

      const { app, close } = await createHttpApp(realFactory(), mockContext, defaultMeta);

      const res = await app.request(new Request('http://localhost/mcp', { method: 'DELETE' }));

      expect(res.status).toBe(400);
      await close();
    });

    test('serves a 2026-07-28 request per-request, minting no session', async () => {
      (config as any).mcpSessionMode = 'stateful';

      const { app, close, sessionStore } = await createHttpApp(
        realFactory(),
        mockContext,
        defaultMeta,
      );

      const res = await app.request(
        post(
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            },
          },
          { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' },
        ),
      );

      expect(res.status).toBe(200);
      // The 2026-07-28 revision has no session: no header, no session minted.
      expect(res.headers.get('mcp-session-id')).toBeNull();
      expect(sessionStore?.getSessionCount()).toBe(0);
      await res.text();
      await close();
    });

    test('allows non-initialize POST without session ID in stateless mode', async () => {
      // config.mcpSessionMode is already 'stateless' by default
      const { app, close, sessionStore } = await createHttpApp(
        realFactory(),
        mockContext,
        defaultMeta,
      );

      const res = await app.request(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));

      // Stateless serving has no session gate — and mints no session header.
      expect(res.status).toBe(200);
      expect(sessionStore).toBeNull();
      expect(res.headers.get('mcp-session-id')).toBeNull();
      await res.text();
      await close();
    });

    test('answers a malformed POST body with a parse error', async () => {
      const { app, close } = await createHttpApp(realFactory(), mockContext, defaultMeta);

      const res = await app.request(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: '{ not json',
        }),
      );

      expect(res.status).toBe(400);
      expect((await res.json()) as unknown).toMatchObject({
        jsonrpc: '2.0',
        error: { code: -32700 },
      });
      await close();
    });
  });

  test('OPTIONS preflight returns CORS headers', async () => {
    const { app } = await createHttpApp(
      mockServerFactory as () => Promise<McpServer>,
      mockContext,
      defaultMeta,
    );

    const req = new Request('http://localhost/mcp', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
      },
    });
    const res = await app.request(req);

    // Hono's CORS middleware returns 204 for preflight.
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');

    // Mcp-Session-Id must be exposed so clients can read it from cross-origin responses.
    const exposedHeaders = res.headers.get('access-control-expose-headers') ?? '';
    expect(exposedHeaders.toLowerCase()).toContain('mcp-session-id');
  });
});

/**
 * @fileoverview Integration tests for HTTP transport using Hono's `.request()` method.
 * Validates the Hono middleware chain (health, CORS, 404 handling) without
 * booting a real HTTP server, avoiding port conflicts in CI.
 * @module tests/mcp-server/transports/http/httpTransport.integration.test
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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

vi.mock('@/mcp-server/transports/http/sessionIdUtils.js', () => ({
  generateSecureSessionId: vi.fn(() => 'test-session-id'),
  validateSessionIdFormat: vi.fn(() => true),
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
    afterEach(() => {
      // Restore stateless for other tests
      (config as any).mcpSessionMode = 'stateless';
    });

    test('rejects non-initialize POST without session ID in stateful mode', async () => {
      (config as any).mcpSessionMode = 'stateful';

      const { app } = await createHttpApp(
        mockServerFactory as () => Promise<McpServer>,
        mockContext,
        defaultMeta,
      );

      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-06-18',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      const res = await app.request(req);

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toContain('Mcp-Session-Id header is required');
    });

    test('rejects GET SSE without session ID in stateful mode', async () => {
      (config as any).mcpSessionMode = 'stateful';

      const { app } = await createHttpApp(
        mockServerFactory as () => Promise<McpServer>,
        mockContext,
        defaultMeta,
      );

      const req = new Request('http://localhost/mcp', {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'MCP-Protocol-Version': '2025-06-18',
        },
      });
      const res = await app.request(req);

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toContain('Mcp-Session-Id header is required');
    });

    test('allows initialize POST without session ID in stateful mode', async () => {
      (config as any).mcpSessionMode = 'stateful';

      // Need a factory that produces a server with a connect method
      const factory = vi.fn(async () => ({
        connect: vi.fn(),
        close: vi.fn(),
      }));

      const { app } = await createHttpApp(factory as any, mockContext, defaultMeta);

      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-06-18',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      });
      const res = await app.request(req);

      // The request should pass the session gate (not 400).
      // It may fail downstream (SDK, etc.) but the point is it wasn't rejected by our guard.
      expect(res.status).not.toBe(400);
    });

    test('allows non-initialize POST without session ID in stateless mode', async () => {
      // config.mcpSessionMode is already 'stateless' by default
      const factory = vi.fn(async () => ({
        connect: vi.fn(),
        close: vi.fn(),
      }));

      const { app } = await createHttpApp(factory as any, mockContext, defaultMeta);

      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-06-18',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      const res = await app.request(req);

      // Should NOT be rejected — stateless mode has no session gate
      expect(res.status).not.toBe(400);
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

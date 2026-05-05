/**
 * @fileoverview Test suite for HTTP transport implementation
 * @module tests/mcp-server/transports/http/httpTransport.test
 */

import { StreamableHTTPTransport } from '@hono/mcp';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHttpApp } from '@/mcp-server/transports/http/httpTransport.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { defaultServerManifest as defaultMeta } from '../../../../helpers/fixtures.js';

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

describe('HTTP Transport', () => {
  let mockMcpServer: Partial<McpServer>;
  let mockContext: RequestContext;

  beforeEach(() => {
    mockMcpServer = {
      // Mock McpServer methods if needed
    } as any;

    mockContext = {
      requestId: 'test-request-123',
      timestamp: Date.now() as any,
      operation: 'test-http-transport',
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createHttpApp', () => {
    test('should create Hono app instance', async () => {
      const { app } = await createHttpApp(
        () => Promise.resolve(mockMcpServer as McpServer),
        mockContext,
        defaultMeta,
      );

      expect(app).toBeDefined();
      expect(typeof app.fetch).toBe('function');
      expect(typeof app.get).toBe('function');
      expect(typeof app.post).toBe('function');
      expect(typeof app.delete).toBe('function');
    });

    test('should configure CORS middleware', async () => {
      const { app } = await createHttpApp(
        () => Promise.resolve(mockMcpServer as McpServer),
        mockContext,
        defaultMeta,
      );

      // Make an OPTIONS request to test CORS
      const request = new Request('http://localhost:3000/test', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:3000',
        },
      });

      const response = await app.fetch(request);

      // CORS headers should be present
      expect(response.headers.get('access-control-allow-origin')).toBeTruthy();
    });

    test('should register health endpoint', async () => {
      const { app } = await createHttpApp(
        () => Promise.resolve(mockMcpServer as McpServer),
        mockContext,
        defaultMeta,
      );

      const request = new Request('http://localhost:3000/healthz', {
        method: 'GET',
      });

      const response = await app.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual({ status: 'ok' });
    });

    test('should register MCP status endpoint', async () => {
      const { app } = await createHttpApp(
        () => Promise.resolve(mockMcpServer as McpServer),
        mockContext,
        defaultMeta,
      );

      const request = new Request('http://localhost:3000/mcp', {
        method: 'GET',
      });

      const response = await app.fetch(request);
      const data: any = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe('ok');
      expect(data.server).toMatchObject({
        name: 'test-mcp-server',
        version: '1.0.0',
        description: 'Test MCP Server',
        environment: 'test',
        transport: 'http',
        sessionMode: 'stateless',
      });
    });

    test('should serve SEP-1649 Server Card at /.well-known/mcp.json', async () => {
      const { app } = await createHttpApp(
        () => Promise.resolve(mockMcpServer as McpServer),
        mockContext,
        defaultMeta,
      );

      const response = await app.fetch(
        new Request('http://localhost:3000/.well-known/mcp.json', { method: 'GET' }),
      );
      const data: any = await response.json();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(data.server_name).toBe('test-mcp-server');
      expect(data.mcp_version).toBeDefined();
      expect(data.endpoints?.streamable_http).toBe('http://localhost:3000/mcp');
      expect(data.capabilities).toBeDefined();
    });

    test('should serve HTML landing page at /', async () => {
      const { app } = await createHttpApp(
        () => Promise.resolve(mockMcpServer as McpServer),
        mockContext,
        defaultMeta,
      );

      const response = await app.fetch(new Request('http://localhost:3000/', { method: 'GET' }));

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('cache-control')).toContain('public');
      const body = await response.text();
      expect(body).toContain('<!DOCTYPE html>');
      expect(body).toContain('test-mcp-server');
      expect(body).toContain('/.well-known/mcp.json');
    });

    test('should skip landing page when landing.enabled=false', async () => {
      const disabled = {
        ...defaultMeta,
        landing: { ...defaultMeta.landing, enabled: false },
      };
      const { app } = await createHttpApp(
        () => Promise.resolve(mockMcpServer as McpServer),
        mockContext,
        disabled,
      );

      const response = await app.fetch(new Request('http://localhost:3000/'));
      expect(response.status).toBe(404);
    });

    test('should pass SSE GET requests through to transport handler', async () => {
      const { app } = await createHttpApp(
        () => Promise.resolve(mockMcpServer as McpServer),
        mockContext,
        defaultMeta,
      );

      const request = new Request('http://localhost:3000/mcp', {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Origin: 'http://localhost:3000',
          'Mcp-Protocol-Version': '2025-03-26',
        },
      });

      const response = await app.fetch(request);

      // Should NOT return the info JSON — it falls through to the transport handler.
      // Without a fully wired McpServer the response won't be a valid SSE stream,
      // but we verify it did not return the status endpoint response.
      const text = await response.text();
      expect(text).not.toContain('"status":"ok"');
    });

    test('should serve OAuth metadata endpoint with minimal metadata when OAuth not configured', async () => {
      const { app } = await createHttpApp(
        () => Promise.resolve(mockMcpServer as McpServer),
        mockContext,
        defaultMeta,
      );

      const request = new Request('http://localhost:3000/.well-known/oauth-protected-resource', {
        method: 'GET',
      });

      const response = await app.fetch(request);
      const data: any = await response.json();

      expect(response.status).toBe(200);
      expect(data.bearer_methods_supported).toEqual(['header']);
      // No authorization_servers when OAuth is not configured
      expect(data.authorization_servers).toBeUndefined();
    });

    test('should handle DELETE request in stateless mode', async () => {
      const { app } = await createHttpApp(
        () => Promise.resolve(mockMcpServer as McpServer),
        mockContext,
        defaultMeta,
      );

      const request = new Request('http://localhost:3000/mcp', {
        method: 'DELETE',
        headers: {
          'Mcp-Session-Id': 'test-session',
        },
      });

      const response = await app.fetch(request);
      const data: any = await response.json();

      expect(response.status).toBe(405);
      expect(data.error).toContain('not supported in stateless mode');
    });

    test('should handle DELETE request without session ID', async () => {
      const { app } = await createHttpApp(
        () => Promise.resolve(mockMcpServer as McpServer),
        mockContext,
        defaultMeta,
      );

      const request = new Request('http://localhost:3000/mcp', {
        method: 'DELETE',
      });

      const response = await app.fetch(request);
      const data: any = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Mcp-Session-Id header required');
    });

    test('should handle DELETE request in stateful mode', async () => {
      await withConfigOverrides({ mcpSessionMode: 'stateful' }, async () => {
        const { app, sessionStore } = await createHttpApp(
          () => Promise.resolve(mockMcpServer as McpServer),
          mockContext,
          defaultMeta,
        );

        // Seed session
        const testSessionId = 'b'.repeat(64);
        sessionStore!.getOrCreate(testSessionId);

        const request = new Request('http://localhost:3000/mcp', {
          method: 'DELETE',
          headers: { 'Mcp-Session-Id': testSessionId },
        });

        const response = await app.fetch(request);
        const data: any = await response.json();

        expect(response.status).toBe(200);
        expect(data.status).toBe('terminated');
        expect(data.sessionId).toBe(testSessionId);

        sessionStore!.destroy();
      });
    });

    test('should reject requests with invalid origin', async () => {
      const { app } = await createHttpApp(
        () => Promise.resolve(mockMcpServer as McpServer),
        mockContext,
        defaultMeta,
      );

      const request = new Request('http://localhost:3000/mcp', {
        method: 'POST',
        headers: {
          Origin: 'http://evil.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'ping',
          id: 1,
        }),
      });

      const response = await app.fetch(request);
      const data: any = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toContain('Invalid origin');
    });

    test('should allow requests with valid origin', async () => {
      const { app } = await createHttpApp(
        () => Promise.resolve(mockMcpServer as McpServer),
        mockContext,
        defaultMeta,
      );

      const request = new Request('http://localhost:3000/mcp', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:3000',
          'Content-Type': 'application/json',
          'Mcp-Protocol-Version': '2025-03-26',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0.0' },
          },
        }),
      });

      // This will fail because we haven't set up full MCP server mock,
      // but it should pass the origin check
      const response = await app.fetch(request);

      // Should not be rejected with 403 (origin validation)
      expect(response.status).not.toBe(403);
    });

    test('should include credentials in CORS when origin is explicitly configured', async () => {
      const { app } = await createHttpApp(
        () => Promise.resolve(mockMcpServer as McpServer),
        mockContext,
        defaultMeta,
      );

      const request = new Request('http://localhost:3000/mcp', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:3000',
          'Access-Control-Request-Method': 'POST',
        },
      });

      const response = await app.fetch(request);
      expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    });

    test('should omit credentials in CORS when origin is wildcard', async () => {
      await withConfigOverrides({ mcpAllowedOrigins: [] }, async () => {
        const { app } = await createHttpApp(
          () => Promise.resolve(mockMcpServer as McpServer),
          mockContext,
          defaultMeta,
        );

        const request = new Request('http://localhost:3000/mcp', {
          method: 'OPTIONS',
          headers: {
            Origin: 'http://localhost:3000',
            'Access-Control-Request-Method': 'POST',
          },
        });

        const response = await app.fetch(request);
        // Wildcard origin must not set credentials (browsers reject the preflight)
        expect(response.headers.get('access-control-allow-credentials')).toBeNull();
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
      });
    });

    test('Origin guard: rejects non-loopback browser Origin when no allowlist configured', async () => {
      await withConfigOverrides({ mcpAllowedOrigins: [] }, async () => {
        const { app } = await createHttpApp(
          () => Promise.resolve(mockMcpServer as McpServer),
          mockContext,
          defaultMeta,
        );

        const request = new Request('http://localhost:3000/mcp', {
          method: 'POST',
          headers: {
            Origin: 'http://evil.example',
            'Content-Type': 'application/json',
            'Mcp-Protocol-Version': '2025-03-26',
          },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
        });

        const response = await app.fetch(request);
        expect(response.status).toBe(403);
        const data: any = await response.json();
        expect(data.error).toContain('Invalid origin');
      });
    });

    test.each([
      ['http://localhost', 'http://localhost'],
      ['localhost with port', 'http://localhost:8080'],
      ['127.0.0.1', 'http://127.0.0.1'],
      ['127.0.0.1 with port', 'http://127.0.0.1:3000'],
      ['IPv6 loopback', 'http://[::1]:3010'],
    ])('Origin guard: accepts %s (%s) as loopback when no allowlist configured', async (_label, origin) => {
      await withConfigOverrides({ mcpAllowedOrigins: [] }, async () => {
        const { app } = await createHttpApp(
          () => Promise.resolve(mockMcpServer as McpServer),
          mockContext,
          defaultMeta,
        );

        const request = new Request('http://localhost:3000/mcp', {
          method: 'POST',
          headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            'Mcp-Protocol-Version': '2025-03-26',
          },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
        });

        const response = await app.fetch(request);
        // Not a 403 — Origin passed the guard. Handler may 4xx/5xx on the
        // JSON-RPC payload, but the Origin check must have allowed it.
        expect(response.status).not.toBe(403);
      });
    });

    test('Origin guard: MCP_ALLOWED_ORIGINS="*" accepts any Origin (explicit opt-in)', async () => {
      await withConfigOverrides({ mcpAllowedOrigins: ['*'] }, async () => {
        const { app } = await createHttpApp(
          () => Promise.resolve(mockMcpServer as McpServer),
          mockContext,
          defaultMeta,
        );

        const request = new Request('http://localhost:3000/mcp', {
          method: 'POST',
          headers: {
            Origin: 'https://anything.example',
            'Content-Type': 'application/json',
            'Mcp-Protocol-Version': '2025-03-26',
          },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
        });

        const response = await app.fetch(request);
        expect(response.status).not.toBe(403);
      });
    });

    test('Origin guard: passes through when no Origin header (CLI client)', async () => {
      await withConfigOverrides({ mcpAllowedOrigins: [] }, async () => {
        const { app } = await createHttpApp(
          () => Promise.resolve(mockMcpServer as McpServer),
          mockContext,
          defaultMeta,
        );

        const request = new Request('http://localhost:3000/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Mcp-Protocol-Version': '2025-03-26',
          },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
        });

        const response = await app.fetch(request);
        expect(response.status).not.toBe(403);
      });
    });

    test('should reject unsupported MCP protocol version', async () => {
      const { app } = await createHttpApp(
        () => Promise.resolve(mockMcpServer as McpServer),
        mockContext,
        defaultMeta,
      );

      const request = new Request('http://localhost:3000/mcp', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:3000',
          'Content-Type': 'application/json',
          'Mcp-Protocol-Version': '1999-01-01',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
        }),
      });

      const response = await app.fetch(request);
      const data: any = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Unsupported MCP protocol version');
    });

    test('should default to protocol version 2025-03-26 when not provided', async () => {
      const { app } = await createHttpApp(
        () => Promise.resolve(mockMcpServer as McpServer),
        mockContext,
        defaultMeta,
      );

      const request = new Request('http://localhost:3000/mcp', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:3000',
          'Content-Type': 'application/json',
          // No MCP-Protocol-Version header
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0.0' },
          },
        }),
      });

      const response = await app.fetch(request);

      // Should not be rejected for unsupported protocol version
      expect(response.status).not.toBe(400);
    });
  });

  describe('Error handling integration', () => {
    test('should use centralized error handler', async () => {
      const { app } = await createHttpApp(
        () => Promise.resolve(mockMcpServer as McpServer),
        mockContext,
        defaultMeta,
      );

      // Simulate an error by accessing a non-existent route with proper method
      const request = new Request('http://localhost:3000/nonexistent', {
        method: 'GET',
      });

      const response = await app.fetch(request);

      // Should return 404 for non-existent route
      expect(response.status).toBe(404);
    });
  });

  describe('Session management', () => {
    test('should create session store in stateful mode', async () => {
      await withConfigOverrides({ mcpSessionMode: 'stateful' }, async () => {
        const { sessionStore } = await createHttpApp(
          () => Promise.resolve(mockMcpServer as McpServer),
          mockContext,
          defaultMeta,
        );

        expect(sessionStore).not.toBeNull();
        expect(sessionStore!.getSessionCount()).toBe(0);
        sessionStore!.destroy();
      });
    });

    test('should not create session store in stateless mode', async () => {
      const { sessionStore } = await createHttpApp(
        () => Promise.resolve(mockMcpServer as McpServer),
        mockContext,
        defaultMeta,
      );

      expect(sessionStore).toBeNull();
    });

    test('should return Mcp-Session-Id header on successful initialize in stateful mode', async () => {
      await withConfigOverrides({ mcpSessionMode: 'stateful' }, async () => {
        // Wire up a mock server whose connect + transport.handleRequest succeed
        const mockServer = {
          connect: vi.fn().mockResolvedValue(undefined),
        } as unknown as McpServer;

        const { app, sessionStore } = await createHttpApp(
          () => Promise.resolve(mockServer),
          mockContext,
          defaultMeta,
        );

        const request = new Request('http://localhost:3000/mcp', {
          method: 'POST',
          headers: {
            Origin: 'http://localhost:3000',
            'Content-Type': 'application/json',
            'Mcp-Protocol-Version': '2025-03-26',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'initialize',
            id: 1,
            params: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'test-client', version: '1.0.0' },
            },
          }),
        });

        const response = await app.fetch(request);

        // The SDK transport processes the request — if it returns a successful
        // response the session header must be present.
        if (response.ok) {
          expect(response.headers.get('mcp-session-id')).toBeTruthy();
          // Session should also be registered in the store
          expect(sessionStore!.getSessionCount()).toBe(1);
        }
        // Regardless of SDK outcome, should not be a 403/400 (our guards passed)
        expect(response.status).not.toBe(403);

        sessionStore!.destroy();
      });
    });

    test('should NOT return Mcp-Session-Id header in stateless mode', async () => {
      const mockServer = {
        connect: vi.fn().mockResolvedValue(undefined),
      } as unknown as McpServer;

      const { app } = await createHttpApp(
        () => Promise.resolve(mockServer),
        mockContext,
        defaultMeta,
      );

      const request = new Request('http://localhost:3000/mcp', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:3000',
          'Content-Type': 'application/json',
          'Mcp-Protocol-Version': '2025-03-26',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0.0' },
          },
        }),
      });

      const response = await app.fetch(request);

      // Stateless mode never emits the session header
      expect(response.headers.get('mcp-session-id')).toBeNull();
    });

    test('should not mint a session for requests that fail protocol validation', async () => {
      await withConfigOverrides({ mcpSessionMode: 'stateful' }, async () => {
        const mockServer = {
          connect: vi.fn().mockResolvedValue(undefined),
        } as unknown as McpServer;

        const { app, sessionStore } = await createHttpApp(
          () => Promise.resolve(mockServer),
          mockContext,
          defaultMeta,
        );

        // Send a request with an unsupported protocol version — should fail
        // before reaching the transport handler, so no session is minted.
        const request = new Request('http://localhost:3000/mcp', {
          method: 'POST',
          headers: {
            Origin: 'http://localhost:3000',
            'Content-Type': 'application/json',
            'Mcp-Protocol-Version': '1999-01-01',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'initialize',
            id: 1,
          }),
        });

        const response = await app.fetch(request);

        expect(response.status).toBe(400);
        // No session should have been created
        expect(sessionStore!.getSessionCount()).toBe(0);
        expect(response.headers.get('mcp-session-id')).toBeNull();

        sessionStore!.destroy();
      });
    });

    test('should handle DELETE in stateful mode and terminate session', async () => {
      await withConfigOverrides({ mcpSessionMode: 'stateful' }, async () => {
        const { app, sessionStore } = await createHttpApp(
          () => Promise.resolve(mockMcpServer as McpServer),
          mockContext,
          defaultMeta,
        );

        // Manually seed a session in the store
        const testSessionId = 'a'.repeat(64);
        sessionStore!.getOrCreate(testSessionId);
        expect(sessionStore!.getSessionCount()).toBe(1);

        const request = new Request('http://localhost:3000/mcp', {
          method: 'DELETE',
          headers: {
            'Mcp-Session-Id': testSessionId,
          },
        });

        const response = await app.fetch(request);
        const data: any = await response.json();

        expect(response.status).toBe(200);
        expect(data.status).toBe('terminated');
        expect(sessionStore!.getSessionCount()).toBe(0);

        sessionStore!.destroy();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Per-request close — issue #50 regression
  //
  // The HTTP transport constructs a fresh McpServer + McpSessionTransport per
  // request. Production telemetry showed a 1:1 correlation between SSE GETs
  // and unfinalized server/transport pairs because @hono/mcp's stream.onAbort
  // does not fire transport.close() on ungraceful client disconnect — so the
  // framework's onclose path never ran. We bind cleanup to c.req.raw.signal
  // for SSE responses; on abort, closePerRequestInstances runs both closes.
  // -------------------------------------------------------------------------
  describe('Per-request close on SSE abort (issue #50)', () => {
    let transportCloseSpy: ReturnType<typeof vi.spyOn>;
    let serverCloseSpy: ReturnType<typeof vi.fn>;
    let app: Awaited<ReturnType<typeof createHttpApp>>['app'];

    beforeEach(async () => {
      transportCloseSpy = vi.spyOn(StreamableHTTPTransport.prototype, 'close');
      serverCloseSpy = vi.fn().mockResolvedValue(undefined);
      const mockServer = {
        connect: vi.fn().mockResolvedValue(undefined),
        close: serverCloseSpy,
      } as unknown as McpServer;
      ({ app } = await createHttpApp(() => Promise.resolve(mockServer), mockContext, defaultMeta));
    });

    afterEach(() => {
      transportCloseSpy.mockRestore();
    });

    /** Two `setImmediate` ticks cover: abort listener → `void closePerRequestInstances`
     * → `Promise.all([transport.close, server.close])`. */
    const flushCleanup = async (): Promise<void> => {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    };

    const sseRequest = (signal: AbortSignal): Request =>
      new Request('http://localhost:3000/mcp', {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Origin: 'http://localhost:3000',
          'Mcp-Protocol-Version': '2025-03-26',
        },
        signal,
      });

    test('aborting an SSE GET triggers per-request transport.close + server.close', async () => {
      const controller = new AbortController();
      const response = await app.fetch(sseRequest(controller.signal));

      // Sanity: streamSSE response, not the GET-status fallback.
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      // Pre-abort: cleanup must NOT have fired — the SSE stream is alive.
      expect(transportCloseSpy).not.toHaveBeenCalled();
      expect(serverCloseSpy).not.toHaveBeenCalled();

      controller.abort();
      await flushCleanup();

      expect(transportCloseSpy).toHaveBeenCalledTimes(1);
      expect(serverCloseSpy).toHaveBeenCalledTimes(1);
    });

    test('SSE GET with a pre-aborted signal still runs cleanup', async () => {
      const controller = new AbortController();
      // Exercise the `signal.aborted` queueMicrotask branch.
      controller.abort();
      await app.fetch(sseRequest(controller.signal));
      await flushCleanup();

      expect(transportCloseSpy).toHaveBeenCalledTimes(1);
      expect(serverCloseSpy).toHaveBeenCalledTimes(1);
    });

    test('aborting twice only fires cleanup once', async () => {
      // Guards against regressions in `{ once: true }` on the abort listener
      // and AbortController's own once-only abort semantics.
      const controller = new AbortController();
      await app.fetch(sseRequest(controller.signal));

      controller.abort();
      controller.abort();
      await flushCleanup();

      expect(transportCloseSpy).toHaveBeenCalledTimes(1);
      expect(serverCloseSpy).toHaveBeenCalledTimes(1);
    });

    test('non-SSE POST (notifications-only) cleans up via the success path', async () => {
      // Notifications-only POST: @hono/mcp returns `ctx.json(null, 202)` —
      // a plain JSON response, not an SSE stream — so the framework takes
      // the queueMicrotask cleanup branch, not the abort-signal branch.
      const request = new Request('http://localhost:3000/mcp', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:3000',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Protocol-Version': '2025-03-26',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }),
      });

      const response = await app.fetch(request);
      expect(response.headers.get('content-type')).not.toContain('text/event-stream');

      await flushCleanup();

      expect(transportCloseSpy).toHaveBeenCalledTimes(1);
      expect(serverCloseSpy).toHaveBeenCalledTimes(1);
    });
  });
});

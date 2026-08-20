/**
 * @fileoverview Integration tests for the HTTP Streamable transport. Starts
 * the server as a subprocess, then validates both SDK client connectivity
 * and raw HTTP endpoint behavior.
 * @module tests/integration/http
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  expectDefaultServerCapabilities,
  expectDefaultServerDiscoverySurface,
  expectDefaultServerLoggingSurface,
  expectDefaultServerProtocolErrors,
  expectDefaultServerSubscriptionSurface,
} from '../helpers/default-server-mcp.js';
import { initializeBody, MCP_HEADERS } from '../helpers/http-helpers.js';
import { assertServerBuilt, type ServerHandle, startServer } from '../helpers/server-process.js';

describe('HTTP transport integration', () => {
  let handle: ServerHandle;

  beforeAll(async () => {
    assertServerBuilt();
    handle = await startServer('http', { MCP_ALLOWED_ORIGINS: 'http://example.com' });
  });

  afterAll(async () => {
    await handle?.kill();
  });

  describe('SDK Client', () => {
    let client: Client;
    let transport: StreamableHTTPClientTransport;

    beforeAll(async () => {
      transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${handle.port}/mcp`));
      client = new Client({ name: 'http-integration', version: '1.0.0' });
      // SDK type mismatch with exactOptionalPropertyTypes — sessionId?: string vs string | undefined
      await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    });

    afterAll(async () => {
      try {
        await client?.close();
      } catch {
        // Client may already be closed
      }
    });

    it('completes the MCP handshake over HTTP', () => {
      const version = client.getServerVersion();
      expect(version).toBeDefined();
      expect(version?.name).toBeTruthy();
    });

    it('responds to ping', async () => {
      // Core server has no tools — just verify the transport is functional
      const result = await client.ping();
      expect(result).toBeDefined();
    });

    it('advertises the expected MCP capabilities', () => {
      expectDefaultServerCapabilities(client);
    });

    it('returns empty tool, resource, and prompt lists for the default server', async () => {
      await expectDefaultServerDiscoverySurface(client);
    });

    it('returns MCP not-found behavior for missing tools, resources, and prompts', async () => {
      await expectDefaultServerProtocolErrors(client);
    });

    it('resolves logging and resource-subscription operations', async () => {
      await expectDefaultServerLoggingSurface(client);
      await expectDefaultServerSubscriptionSurface(client);
    });
  });

  describe('Raw HTTP endpoints', () => {
    it('GET /healthz returns 200 with status ok', async () => {
      const res = await fetch(`http://localhost:${handle.port}/healthz`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { status: string };
      expect(body.status).toBe('ok');
    });

    it('GET /mcp returns server info', async () => {
      const res = await fetch(`http://localhost:${handle.port}/mcp`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        server?: { name?: string | undefined; version?: string | undefined } | undefined;
        status?: string | undefined;
      };
      expect(body.status).toBe('ok');
      expect(body.server?.name).toBeTruthy();
      expect(body.server?.version).toBeTruthy();
    });

    it('rejects an unsupported MCP-Protocol-Version on a post-initialize request', async () => {
      // The header is only meaningful after the handshake — an `initialize`
      // POST carries its version in the body, so the SDK transport ignores the
      // header there and validates it on every subsequent request instead.
      const init = await fetch(`http://localhost:${handle.port}/mcp`, {
        body: initializeBody(),
        headers: MCP_HEADERS,
        method: 'POST',
      });
      const sessionId = init.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();
      await init.text();

      const res = await fetch(`http://localhost:${handle.port}/mcp`, {
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        headers: {
          ...MCP_HEADERS,
          'Mcp-Session-Id': sessionId as string,
          'MCP-Protocol-Version': '1900-01-01',
        },
        method: 'POST',
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { message?: string } };
      expect(body.error?.message).toContain('Unsupported protocol version: 1900-01-01');
    });

    it('rejects disallowed Origin headers on the MCP endpoint', async () => {
      const res = await fetch(`http://localhost:${handle.port}/mcp`, {
        body: initializeBody(),
        headers: {
          ...MCP_HEADERS,
          'MCP-Protocol-Version': '2025-06-18',
          Origin: 'http://evil.example.com',
        },
        method: 'POST',
      });

      expect(res.status).toBe(403);

      const body = (await res.json()) as { error?: string | undefined };
      expect(body.error).toBe('Invalid origin. DNS rebinding protection.');
    });

    it('OPTIONS /mcp returns CORS headers', async () => {
      const res = await fetch(`http://localhost:${handle.port}/mcp`, {
        headers: {
          'Access-Control-Request-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
          'Access-Control-Request-Method': 'POST',
          Origin: 'http://example.com',
        },
        method: 'OPTIONS',
      });

      // Hono CORS middleware returns 204 for preflight
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBeTruthy();
      expect(res.headers.get('access-control-allow-methods')).toContain('POST');

      const exposedHeaders = res.headers.get('access-control-expose-headers') ?? '';
      expect(exposedHeaders.toLowerCase()).toContain('mcp-session-id');
    });
  });
});

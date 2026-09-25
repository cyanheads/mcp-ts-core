/**
 * @fileoverview Integration tests for the HTTP Streamable transport. Starts
 * the server as a subprocess, then validates both SDK client connectivity
 * and raw HTTP endpoint behavior.
 * @module tests/integration/http
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  expectDefaultServerCapabilities,
  expectDefaultServerDiscoverySurface,
  expectDefaultServerLoggingSurface,
  expectDefaultServerProtocolErrors,
  expectDefaultServerSubscriptionSurface,
} from '../helpers/default-server-mcp.js';
import { initializeBody, MCP_HEADERS, parseSSEEvents } from '../helpers/http-helpers.js';
import { type ServerHandle, startServer } from '../helpers/server-process.js';

/** Reverses the landing page's HTML escaping (the five entity characters). */
function unescapeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** The server reports the manifest of the application root it runs from. */
const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};

describe('HTTP transport integration', () => {
  let handle: ServerHandle;

  beforeAll(async () => {
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
      expect(client.getServerVersion()).toMatchObject({ name: pkg.name, version: pkg.version });
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
      expect(body.server).toMatchObject({ name: pkg.name, version: pkg.version });
    });

    it('runs the landing page curl snippet verbatim and gets a negotiated initialize result', async () => {
      // Copy-paste is the contract: the tab's snippet is executed as a shell
      // command, not re-derived, so a quoting or header mistake fails here.
      const page = await fetch(`http://localhost:${handle.port}/`);
      expect(page.status).toBe(200);
      const match = (await page.text()).match(
        /<pre id="connect-snippet-curl"><code><!--email_off-->([\s\S]*?)<!--\/email_off--><\/code><\/pre>/,
      );
      expect(match).not.toBeNull();
      const snippet = unescapeHtml(match?.[1] ?? '');
      expect(snippet.startsWith('curl -X POST ')).toBe(true);

      const run = spawnSync('sh', ['-c', `${snippet} -sS -w '\\n%{http_code}'`], {
        encoding: 'utf-8',
      });
      expect(run.stderr).toBe('');
      const lines = run.stdout.trimEnd().split('\n');
      expect(lines.pop()).toBe('200');
      const body = lines.join('\n');
      // The transport may answer JSON or a one-event SSE stream; both carry the result.
      const payload = body.trimStart().startsWith('{')
        ? body
        : (parseSSEEvents(body).find((event) => event.data.includes('"result"'))?.data ?? '');
      const reply = JSON.parse(payload) as {
        id: number;
        result?: { protocolVersion?: string };
        error?: unknown;
      };
      expect(reply.id).toBe(1);
      expect(reply.error).toBeUndefined();
      expect(reply.result?.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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
      expect(res.headers.get('access-control-allow-origin')).toBe('http://example.com');
      expect(res.headers.get('access-control-allow-methods')).toContain('POST');

      const exposedHeaders = res.headers.get('access-control-expose-headers') ?? '';
      expect(exposedHeaders.toLowerCase()).toContain('mcp-session-id');
    });
  });
});

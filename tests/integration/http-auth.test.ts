/**
 * @fileoverview Integration tests for HTTP authentication. Starts the server
 * with JWT auth enabled and validates token enforcement (the 401 echoing the
 * request's JSON-RPC id), expiry rejection, unprotected endpoint
 * accessibility, and the discovery URLs derived from MCP_HTTP_ENDPOINT_PATH.
 * @module tests/integration/http-auth
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateTestJwt, initializeBody, MCP_HEADERS } from '../helpers/http-helpers.js';
import { type ServerHandle, startServer } from '../helpers/server-process.js';

const AUTH_SECRET = 'test-secret-key-for-conformance!';
const BROWSER_ORIGIN = 'https://app.example';

describe('HTTP auth integration', () => {
  let handle: ServerHandle;

  beforeAll(async () => {
    handle = await startServer('http', {
      MCP_ALLOWED_ORIGINS: BROWSER_ORIGIN,
      MCP_AUTH_MODE: 'jwt',
      MCP_AUTH_SECRET_KEY: AUTH_SECRET,
    });
  });

  afterAll(async () => {
    await handle?.kill();
  });

  it.each([77, 'abc'])(
    'rejects unauthenticated POST /mcp with 401, echoing the request id %j',
    async (id) => {
      const res = await fetch(`http://localhost:${handle.port}/mcp`, {
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }),
        headers: { ...MCP_HEADERS },
        method: 'POST',
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id });
    },
  );

  // A browser hides every response header CORS does not expose, so without
  // this a cross-origin client cannot read the RFC 9728 challenge that points
  // it at the authorization server.
  it('exposes the 401 WWW-Authenticate challenge to an allowlisted browser origin', async () => {
    const res = await fetch(`http://localhost:${handle.port}/mcp`, {
      body: initializeBody(),
      headers: { ...MCP_HEADERS, Origin: BROWSER_ORIGIN },
      method: 'POST',
    });
    const exposed = (res.headers.get('access-control-expose-headers') ?? '')
      .split(',')
      .map((header) => header.trim().toLowerCase());

    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe(BROWSER_ORIGIN);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect(exposed).toEqual(
      expect.arrayContaining(['www-authenticate', 'mcp-session-id', 'retry-after']),
    );
  });

  it('accepts a valid JWT and completes initialize', async () => {
    const token = generateTestJwt(
      {
        cid: 'test-client',
        scp: ['tool:echo:read'],
        sub: 'test-user',
        tid: 'test-tenant',
      },
      AUTH_SECRET,
    );

    const res = await fetch(`http://localhost:${handle.port}/mcp`, {
      body: initializeBody(),
      headers: {
        ...MCP_HEADERS,
        Authorization: `Bearer ${token}`,
      },
      method: 'POST',
    });

    expect(res.status).toBe(200);
  });

  it('rejects an expired JWT with 401', async () => {
    const token = generateTestJwt(
      {
        cid: 'test-client',
        scp: ['tool:echo:read'],
        sub: 'test-user',
        tid: 'test-tenant',
      },
      AUTH_SECRET,
      -1, // Already expired
    );

    const res = await fetch(`http://localhost:${handle.port}/mcp`, {
      body: initializeBody(),
      headers: {
        ...MCP_HEADERS,
        Authorization: `Bearer ${token}`,
      },
      method: 'POST',
    });

    expect(res.status).toBe(401);
  });

  it('allows GET /healthz without auth', async () => {
    const res = await fetch(`http://localhost:${handle.port}/healthz`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('allows GET /mcp without auth (info endpoint)', async () => {
    const res = await fetch(`http://localhost:${handle.port}/mcp`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      auth?: unknown;
      capabilities?: unknown;
      framework?: unknown;
      server?: unknown;
      status?: string | undefined;
    };
    expect(body).toEqual({ status: 'ok' });
  });

  it('rejects unauthenticated SSE GET /mcp requests', async () => {
    const res = await fetch(`http://localhost:${handle.port}/mcp`, {
      headers: { Accept: 'text/event-stream' },
    });

    expect(res.status).toBe(401);
  });

  it('serves protected resource metadata without requiring auth', async () => {
    const res = await fetch(`http://localhost:${handle.port}/.well-known/oauth-protected-resource`);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');

    const body = (await res.json()) as {
      authorization_servers?: unknown;
      bearer_methods_supported?: string[] | undefined;
      resource?: string | undefined;
    };

    expect(body).toMatchObject({
      bearer_methods_supported: ['header'],
      resource: `http://localhost:${handle.port}/mcp`,
    });
    expect(body.authorization_servers).toBeUndefined();
  });
});

describe('HTTP auth with the body-limit guard off', () => {
  let handle: ServerHandle;

  beforeAll(async () => {
    handle = await startServer('http', {
      MCP_AUTH_MODE: 'jwt',
      MCP_AUTH_SECRET_KEY: AUTH_SECRET,
      MCP_HTTP_MAX_BODY_BYTES: '0',
    });
  });

  afterAll(async () => {
    await handle?.kill();
  });

  it('rejects unauthenticated POST /mcp with 401, echoing the request id', async () => {
    const res = await fetch(`http://localhost:${handle.port}/mcp`, {
      body: JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'tools/list' }),
      headers: { ...MCP_HEADERS },
      method: 'POST',
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id: 77 });
  });
});

describe('MCP_HTTP_ENDPOINT_PATH written without a leading slash', () => {
  let handle: ServerHandle;
  let origin: string;

  beforeAll(async () => {
    handle = await startServer('http', {
      MCP_AUTH_MODE: 'jwt',
      MCP_AUTH_SECRET_KEY: AUTH_SECRET,
      MCP_HTTP_ENDPOINT_PATH: 'api/mcp',
    });
    origin = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle?.kill();
  });

  it('serves the endpoint at /api/mcp', async () => {
    const res = await fetch(`${origin}/api/mcp`, {
      body: initializeBody(),
      headers: { ...MCP_HEADERS },
      method: 'POST',
    });

    expect(res.status).toBe(401);
  });

  it('advertises /api/mcp on the server card', async () => {
    const res = await fetch(`${origin}/.well-known/mcp.json`);
    const card = (await res.json()) as { endpoints?: { streamable_http?: string } };

    expect(card.endpoints?.streamable_http).toBe(`${origin}/api/mcp`);
  });

  it.each([
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/api/mcp',
  ])('names /api/mcp as the resource at %s', async (metadataPath) => {
    const res = await fetch(`${origin}${metadataPath}`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { resource?: string }).resource).toBe(`${origin}/api/mcp`);
  });

  it('mounts no metadata at the host-fused path', async () => {
    const res = await fetch(`${origin}/.well-known/oauth-protected-resourceapi/mcp`);

    expect(res.status).toBe(404);
  });

  it('disallows /api/mcp in robots.txt', async () => {
    const res = await fetch(`${origin}/robots.txt`);

    expect((await res.text()).split('\n')).toContain('Disallow: /api/mcp');
  });
});

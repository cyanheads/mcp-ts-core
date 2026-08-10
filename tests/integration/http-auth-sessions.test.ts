/**
 * @fileoverview Integration tests for JWT-authenticated HTTP sessions.
 * Verifies that stateful session IDs are bound to the authenticated identity
 * and cannot be reused or terminated by a different tenant or client.
 * @module tests/integration/http-auth-sessions
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateTestJwt, initializeBody, jsonrpc, MCP_HEADERS } from '../helpers/http-helpers.js';
import { assertServerBuilt, type ServerHandle, startServer } from '../helpers/server-process.js';

const AUTH_SECRET = 'test-secret-key-for-conformance!';
const PROTOCOL_VERSION = '2025-06-18';

function createToken(overrides: Record<string, unknown> = {}): string {
  return generateTestJwt(
    {
      cid: 'test-client',
      scp: ['tool:echo:read'],
      sub: 'test-user',
      tid: 'test-tenant',
      ...overrides,
    },
    AUTH_SECRET,
  );
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
  };
}

async function initializeAuthenticatedSession(
  handle: ServerHandle,
  token: string,
): Promise<string> {
  const res = await fetch(`http://localhost:${handle.port}/mcp`, {
    body: initializeBody(),
    headers: {
      ...MCP_HEADERS,
      ...authHeaders(token),
    },
    method: 'POST',
  });

  expect(res.status).toBe(200);

  const sessionId = res.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

describe('HTTP auth session integration', () => {
  let handle: ServerHandle;

  beforeAll(async () => {
    assertServerBuilt();
    handle = await startServer('http', {
      MCP_AUTH_MODE: 'jwt',
      MCP_AUTH_SECRET_KEY: AUTH_SECRET,
      MCP_SESSION_MODE: 'stateful',
    });
  });

  afterAll(async () => {
    await handle?.kill();
  });

  it('accepts a stateful session when reused by the same authenticated identity', async () => {
    const token = createToken();
    const sessionId = await initializeAuthenticatedSession(handle, token);

    await fetch(`http://localhost:${handle.port}/mcp`, {
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
      headers: {
        ...MCP_HEADERS,
        ...authHeaders(token),
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Session-Id': sessionId,
      },
      method: 'POST',
    });

    const listRes = await fetch(`http://localhost:${handle.port}/mcp`, {
      body: jsonrpc(2, 'tools/list', {}),
      headers: {
        ...MCP_HEADERS,
        ...authHeaders(token),
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Session-Id': sessionId,
      },
      method: 'POST',
    });

    expect(listRes.status).toBe(200);
  });

  it('rejects reuse of an authenticated session from a different tenant', async () => {
    const sessionId = await initializeAuthenticatedSession(handle, createToken());
    const hijackToken = createToken({ tid: 'other-tenant' });

    const res = await fetch(`http://localhost:${handle.port}/mcp`, {
      body: jsonrpc(2, 'tools/list', {}),
      headers: {
        ...MCP_HEADERS,
        ...authHeaders(hijackToken),
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Session-Id': sessionId,
      },
      method: 'POST',
    });

    expect(res.status).toBe(404);

    const body = (await res.json()) as { error?: string | undefined };
    expect(body.error).toBe('Session not found or expired');
  });

  it('rejects DELETE for a bound session from a different client identity', async () => {
    const sessionId = await initializeAuthenticatedSession(handle, createToken());
    const hijackToken = createToken({
      cid: 'other-client',
      sub: 'other-user',
    });

    const res = await fetch(`http://localhost:${handle.port}/mcp`, {
      headers: {
        ...authHeaders(hijackToken),
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Session-Id': sessionId,
      },
      method: 'DELETE',
    });

    expect(res.status).toBe(404);

    const body = (await res.json()) as { error?: string | undefined };
    expect(body.error).toBe('Session not found or access denied');
  });
});

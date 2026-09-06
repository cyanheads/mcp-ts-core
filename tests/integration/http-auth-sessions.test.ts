/**
 * @fileoverview JWT session ownership checked independently for tenant, client, and subject.
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

  function headers(token: string, sessionId?: string) {
    return {
      ...MCP_HEADERS,
      Authorization: `Bearer ${token}`,
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      ...(sessionId && { 'Mcp-Session-Id': sessionId }),
    };
  }

  async function initialize(token: string): Promise<string> {
    const response = await fetch(`http://localhost:${handle.port}/mcp`, {
      method: 'POST',
      headers: headers(token),
      body: initializeBody(),
      signal: AbortSignal.timeout(5_000),
    });
    await response.text();
    expect(response.status).toBe(200);
    const sessionId = response.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    const initialized = await fetch(`http://localhost:${handle.port}/mcp`, {
      method: 'POST',
      headers: headers(token, sessionId!),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(5_000),
    });
    await initialized.text();
    expect(initialized.status).toBe(202);
    return sessionId!;
  }

  async function list(token: string, sessionId: string) {
    const response = await fetch(`http://localhost:${handle.port}/mcp`, {
      method: 'POST',
      headers: headers(token, sessionId),
      body: jsonrpc(2, 'tools/list'),
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('"tools"');
  }

  async function terminate(token: string, sessionId: string) {
    const response = await fetch(`http://localhost:${handle.port}/mcp`, {
      method: 'DELETE',
      headers: headers(token, sessionId),
      signal: AbortSignal.timeout(5_000),
    });
    await response.text();
    expect(response.status).toBe(200);
  }

  it('accepts a newly issued token for the same bound identity', async () => {
    const owner = createToken();
    const sessionId = await initialize(owner);
    try {
      // A fresh token can change non-identity claims without changing session ownership.
      await list(
        createToken({ jti: 'refreshed-token', scp: ['tool:echo:read', 'extra:scope'] }),
        sessionId,
      );
    } finally {
      await terminate(owner, sessionId);
    }
  });

  describe.each(['GET', 'POST', 'DELETE'])('%s ownership', (method) => {
    it.each([
      ['different tenant', { tid: 'other-tenant' }],
      ['different client', { cid: 'other-client' }],
      ['different subject', { sub: 'other-subject' }],
      ['missing tenant', { tid: undefined }],
      ['missing subject', { sub: undefined }],
    ] as const)('rejects %s and leaves the owner session usable', async (_name, overrides) => {
      const owner = createToken();
      const sessionId = await initialize(owner);
      try {
        const response = await fetch(`http://localhost:${handle.port}/mcp`, {
          method,
          headers: headers(createToken(overrides), sessionId),
          ...(method === 'POST' && { body: jsonrpc(3, 'tools/list') }),
          signal: AbortSignal.timeout(5_000),
        });
        const body = await response.json();
        expect(response.status).toBe(404);
        expect(body).toEqual({
          error:
            method === 'DELETE'
              ? 'Session not found or access denied'
              : 'Session not found or expired',
        });
        await list(owner, sessionId);
      } finally {
        await terminate(owner, sessionId);
      }
    });
  });
});

/**
 * @fileoverview JWT authorization and tenant isolation through real HTTP handlers and storage.
 * @module tests/integration/http-storage-security.int.test
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTestJwt, jsonrpc, MCP_HEADERS, parseSSEEvents } from '../helpers/http-helpers.js';
import { type ServerHandle, startServerFromEntrypoint } from '../helpers/server-process.js';

const SECRET = 'test-secret-key-for-conformance!';
function token(tenant: string | undefined, scopes = ['state:read', 'state:write']): string {
  return generateTestJwt(
    { cid: 'state-client', sub: 'state-user', tid: tenant, scp: scopes },
    SECRET,
  );
}

describe('HTTP storage security boundaries', () => {
  let server: ServerHandle;
  beforeAll(async () => {
    server = await startServerFromEntrypoint('tests/fixtures/auth-scoped-server.js', 'http', {
      MCP_AUTH_MODE: 'jwt',
      MCP_AUTH_SECRET_KEY: SECRET,
      MCP_SESSION_MODE: 'stateless',
      MCP_AUTH_DISABLE_SCOPE_CHECKS: 'false',
      STORAGE_PROVIDER_TYPE: 'in-memory',
    });
  });
  afterAll(async () => {
    await server?.kill();
  });

  async function call(
    bearer: string,
    name: string,
    args: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(`http://localhost:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        ...MCP_HEADERS,
        ...headers,
        Authorization: `Bearer ${bearer}`,
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': name,
      },
      body: jsonrpc(1, 'tools/call', {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'security-test', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const payload = response.headers.get('content-type')?.includes('text/event-stream')
      ? parseSSEEvents(text).find((event) => event.data.includes('"result"'))?.data
      : text;
    const body = JSON.parse(payload ?? '') as { result: CallToolResult };
    expect(body).toHaveProperty('result');
    return body.result;
  }

  it('denies missing write scope before a handler can overwrite stored data', async () => {
    const key = 'protected';
    const owner = token('scope-tenant');
    expect((await call(owner, 'state_write', { key, value: 'original' })).isError).toBeUndefined();
    const denied = await call(token('scope-tenant', ['state:read']), 'state_write', {
      key,
      value: 'unauthorized',
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      error: { message: expect.stringContaining('Insufficient permissions') },
    });
    expect((await call(owner, 'state_read', { key })).structuredContent).toEqual({
      value: 'original',
    });
  });

  it('isolates the same key across interleaved tenant writes and subsequent reads', async () => {
    const tenants = ['tenant-a', 'tenant-b'];
    const calls = Array.from({ length: 12 }, (_, i) =>
      tenants.map(async (tenant) => {
        const result = await call(token(tenant), 'state_write', {
          key: `shared-${i}`,
          value: tenant,
        });
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toEqual({ value: tenant, tenant });
      }),
    ).flat();
    await Promise.all(calls);
    for (const tenant of tenants) {
      expect(
        (await call(token(tenant), 'state_read', { key: 'shared-11' })).structuredContent,
      ).toEqual({ value: tenant });
    }
  });

  it('fails closed for missing tenant claims instead of sharing the default namespace', async () => {
    const bearer = token(undefined);
    expect(
      (await call(bearer, 'state_write', { key: 'missing-tenant', value: 'secret' })).isError,
    ).toBe(true);
    expect((await call(bearer, 'state_read', { key: 'missing-tenant' })).isError).toBe(true);
    expect(
      (await call(token('default'), 'state_read', { key: 'missing-tenant' })).structuredContent,
    ).toEqual({ value: null });
  });

  it('does not let untrusted headers replace the JWT tenant or scopes', async () => {
    const key = 'spoofed-tenant';
    const spoofed = {
      'X-Tenant-Id': 'victim',
      'X-MCP-Tenant-Id': 'victim',
      'X-MCP-Scopes': 'state:write',
    };
    const result = await call(
      token('attacker'),
      'state_write',
      { key, value: 'own-data' },
      spoofed,
    );
    expect(result.structuredContent).toEqual({ value: 'own-data', tenant: 'attacker' });
    expect((await call(token('victim'), 'state_read', { key })).structuredContent).toEqual({
      value: null,
    });
    const denied = await call(
      token('attacker', ['state:read']),
      'state_write',
      { key, value: 'forbidden' },
      spoofed,
    );
    expect(denied.isError).toBe(true);
    expect((await call(token('attacker'), 'state_read', { key })).structuredContent).toEqual({
      value: 'own-data',
    });
  });
});

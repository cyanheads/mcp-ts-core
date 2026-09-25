/**
 * @fileoverview Worker-runtime tenant resolution under `MCP_AUTH_MODE=jwt`.
 * A Worker never binds `MCP_TRANSPORT_TYPE`; the handler's tenant default still
 * has to resolve as HTTP there, so a token without a `tid` claim fails closed on
 * `ctx.state` instead of sharing the `'default'` tenant.
 * @module tests/worker/tenant-default.worker.test
 */

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { tool, z } from '@/core/index.js';
import { createWorkerHandler } from '@/core/worker.js';
import { jsonrpc, MCP_HEADERS, parseSseDataFrames } from './wire-helpers.js';

const SECRET = 'worker-tenant-test-secret-0123456789abcdef';

const tenantProbe = tool('tenant_probe', {
  description: 'Reports the tenant a request resolved to, after touching ctx.state.',
  input: z.object({}),
  output: z.object({ tenantId: z.string().describe('Resolved tenant') }),
  async handler(_input, ctx) {
    await ctx.state.get('probe');
    return { tenantId: ctx.tenantId ?? '(none)' };
  },
  format: (result) => [{ type: 'text', text: result.tenantId }],
});

// `name` makes composeServices re-parse config after the bindings are injected.
const worker = createWorkerHandler({ name: 'worker-tenant-test', tools: [tenantProbe] });
const jwtEnv = { ...env, MCP_AUTH_MODE: 'jwt', MCP_AUTH_SECRET_KEY: SECRET };

type ProbeFrame = {
  result: {
    isError?: boolean;
    structuredContent: { tenantId?: string; error?: { code: number } };
  };
};

function sign(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT({ client_id: 'worker-test-client', scope: 'tool:probe:read', ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(SECRET));
}

async function post(body: string, headers: Record<string, string>): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request('http://example.com/mcp', {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...headers },
      body,
    }),
    jwtEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** Opens a session with `token` and calls the tenant probe on it. */
async function probeWith(token: string): Promise<ProbeFrame['result']> {
  const auth = { Authorization: `Bearer ${token}` };
  const init = await post(
    jsonrpc(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'worker-tenant-test', version: '0.0.0' },
    }),
    auth,
  );
  expect(init.status).toBe(200);
  const sessionId = init.headers.get('Mcp-Session-Id');
  const call = await post(jsonrpc(2, 'tools/call', { name: 'tenant_probe', arguments: {} }), {
    ...auth,
    ...(sessionId && { 'Mcp-Session-Id': sessionId }),
  });
  const [frame] = parseSseDataFrames(await call.text()) as ProbeFrame[];
  if (!frame) throw new Error('tools/call returned no frame');
  return frame.result;
}

describe('tenant default on a Worker with MCP_AUTH_MODE=jwt', () => {
  it('leaves a token without tid tenant-less, so ctx.state fails closed', async () => {
    const result = await probeWith(await sign({}));

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe(-32600);
  });

  it('scopes a token with tid to that tenant', async () => {
    const result = await probeWith(await sign({ tid: 'tenant-a' }));

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.tenantId).toBe('tenant-a');
  });
});

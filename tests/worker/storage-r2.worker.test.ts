/**
 * @fileoverview Worker-runtime integration test for the Cloudflare R2 storage provider.
 * Drives a set / get round trip through the MCP HTTP surface with the fixture
 * worker's `STORAGE_PROVIDER_TYPE=cloudflare-r2` bound to the miniflare-emulated
 * R2_BUCKET, then reads the bucket directly to prove the write landed there and
 * not in the default KV backend. Each test file runs in its own miniflare
 * isolate, so `appPromise` starts null and the first fetch initialises the
 * singleton with the overridden env.
 * @module tests/worker/storage-r2.worker.test
 */

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../fixtures/worker-runtime.fixture.js';
import { jsonrpc, MCP_HEADERS, parseSseDataFrames } from './wire-helpers.js';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ENVIRONMENT: string;
      KV_NAMESPACE: KVNamespace;
      LOG_LEVEL: string;
      MCP_ALLOWED_ORIGINS: string;
      R2_BUCKET: R2Bucket;
      STORAGE_PROVIDER_TYPE: string;
    }
  }
}

/** Env override that routes storage to the miniflare-emulated R2 bucket. */
const r2Env = { ...env, STORAGE_PROVIDER_TYPE: 'cloudflare-r2' };

type ToolCallResult = {
  jsonrpc: '2.0';
  id: number;
  result: {
    content: Array<{ type: string; text: string }>;
    structuredContent: Record<string, unknown>;
  };
};

/** MCP session: initialize + return session ID. */
async function openSession(sessionEnv: typeof r2Env): Promise<string> {
  const ctx = createExecutionContext();
  const initResp = await worker.fetch(
    new Request('http://example.com/mcp', {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'r2-storage-test', version: '0.0.0' },
        },
      }),
    }),
    sessionEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const sessionId = initResp.headers.get('Mcp-Session-Id');
  if (!sessionId) throw new Error('No session ID returned from initialize');
  return sessionId;
}

/** Call a storage probe tool and return structuredContent. */
async function callTool(
  sessionId: string,
  id: number,
  toolName: string,
  args: Record<string, unknown>,
  sessionEnv: typeof r2Env,
): Promise<Record<string, unknown>> {
  const ctx = createExecutionContext();
  const resp = await worker.fetch(
    new Request('http://example.com/mcp', {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'Mcp-Session-Id': sessionId },
      body: jsonrpc(id, 'tools/call', { name: toolName, arguments: args }),
    }),
    sessionEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const frames = parseSseDataFrames(await resp.text()) as ToolCallResult[];
  const frame = frames[0];
  if (!frame?.result?.structuredContent)
    throw new Error(`No structuredContent in ${toolName} response`);
  return frame.result.structuredContent;
}

describe('cloudflare-r2 storage provider via worker handler', () => {
  let sessionId: string;

  beforeAll(async () => {
    // First fetch in this isolate — initialises the appPromise singleton with
    // STORAGE_PROVIDER_TYPE=cloudflare-r2. Subsequent calls reuse the same app.
    sessionId = await openSession(r2Env);
  });

  it('round-trips a value through the R2 bucket', async () => {
    await callTool(sessionId, 10, 'storage_set', { key: 'r2-hello', value: 'world' }, r2Env);
    const got = await callTool(sessionId, 11, 'storage_get', { key: 'r2-hello' }, r2Env);
    expect(got).toMatchObject({ found: true, value: 'world' });

    // The write must be in the bound bucket, not in the default KV backend.
    expect(await env.R2_BUCKET.head('default:r2-hello')).not.toBeNull();
    expect(await env.KV_NAMESPACE.get('default:r2-hello')).toBeNull();
  });
});

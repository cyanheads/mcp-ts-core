/**
 * @fileoverview Worker-runtime integration test for the Cloudflare D1 storage provider.
 * Drives a set / get round trip through the MCP HTTP surface with the fixture
 * worker's `STORAGE_PROVIDER_TYPE=cloudflare-d1` bound to the miniflare-emulated
 * D1 database, then reads the `kv_store` table directly to prove the write
 * landed there and not in the default KV backend. The table is created via
 * `applyD1Migrations` before the test runs. Each test file runs in its own
 * miniflare isolate, so `appPromise` starts null and the first fetch initialises
 * the singleton with the overridden env.
 * @module tests/worker/storage-d1.worker.test
 */

import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
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

/** Env override that routes storage to the miniflare-emulated D1 database. */
const d1Env = { ...env, STORAGE_PROVIDER_TYPE: 'cloudflare-d1' };

/** D1Provider table schema — must match src/storage/providers/cloudflare/d1Provider.ts. */
const KV_STORE_MIGRATION = `
CREATE TABLE IF NOT EXISTS kv_store (
  tenant_id TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (tenant_id, key)
)
`;

type ToolCallResult = {
  jsonrpc: '2.0';
  id: number;
  result: {
    content: Array<{ type: string; text: string }>;
    structuredContent: Record<string, unknown>;
  };
};

/** MCP session: initialize + return session ID. */
async function openSession(sessionEnv: typeof d1Env): Promise<string> {
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
          clientInfo: { name: 'd1-storage-test', version: '0.0.0' },
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
  sessionEnv: typeof d1Env,
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

describe('cloudflare-d1 storage provider via worker handler', () => {
  let sessionId: string;

  beforeAll(async () => {
    // Apply the kv_store schema to the miniflare-emulated D1 database before
    // any worker requests are made. The DB binding in env is the same instance
    // the worker will use once it initialises.
    await applyD1Migrations(env.DB, [
      { name: '0001_create_kv_store', queries: [KV_STORE_MIGRATION] },
    ]);

    // First fetch in this isolate — initialises the appPromise singleton with
    // STORAGE_PROVIDER_TYPE=cloudflare-d1. Subsequent calls reuse the same app.
    sessionId = await openSession(d1Env);
  });

  it('round-trips a value through the kv_store table', async () => {
    await callTool(sessionId, 10, 'storage_set', { key: 'd1-hello', value: 'world' }, d1Env);
    const got = await callTool(sessionId, 11, 'storage_get', { key: 'd1-hello' }, d1Env);
    expect(got).toMatchObject({ found: true, value: 'world' });

    // The write must be a kv_store row, not an entry in the default KV backend.
    const row = await env.DB.prepare('SELECT tenant_id FROM kv_store WHERE key = ?')
      .bind('d1-hello')
      .first<{ tenant_id: string }>();
    expect(row).toEqual({ tenant_id: 'default' });
    expect(await env.KV_NAMESPACE.get('default:d1-hello')).toBeNull();
  });
});

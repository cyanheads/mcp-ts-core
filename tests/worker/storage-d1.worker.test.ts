/**
 * @fileoverview Worker-runtime integration tests for the Cloudflare D1 storage provider.
 * Exercises set / get / delete / list / expiry through the MCP HTTP surface by
 * driving the fixture worker with `STORAGE_PROVIDER_TYPE=cloudflare-d1` bound to
 * the miniflare-emulated D1 database. The `kv_store` table is created via
 * `applyD1Migrations` before any tests run. Each test file runs in its own
 * miniflare isolate, so `appPromise` starts null and the first fetch initialises
 * the singleton with the overridden env.
 * @module tests/worker/storage-d1.worker.test
 */

import {
  applyD1Migrations,
  createExecutionContext,
  reset,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import worker from '../fixtures/worker-runtime.fixture.js';

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

const MCP_HEADERS = {
  Accept: 'application/json, text/event-stream',
  'Content-Type': 'application/json',
  Origin: 'http://example.com',
} as const;

function jsonrpc(id: number, method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

/** Parses SSE event frames into their JSON `data:` payloads. */
function parseSseDataFrames(body: string): unknown[] {
  return body
    .split('\n\n')
    .filter(Boolean)
    .flatMap((block) => {
      const dataLines = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      if (dataLines.length === 0) return [];
      return [JSON.parse(dataLines.join('\n'))];
    });
}

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

  afterEach(async () => {
    // Clear all D1 binding state between tests to prevent cross-test leakage.
    // Re-apply the schema immediately after reset: miniflare's reset() wipes all
    // D1 row data and schema, so the kv_store table must be recreated for
    // subsequent tests in the same file.
    await reset();
    await applyD1Migrations(env.DB, [
      { name: '0001_create_kv_store', queries: [KV_STORE_MIGRATION] },
    ]);
  });

  it('sets and gets a value', async () => {
    await callTool(sessionId, 10, 'storage_set', { key: 'd1-hello', value: 'world' }, d1Env);
    const got = await callTool(sessionId, 11, 'storage_get', { key: 'd1-hello' }, d1Env);
    expect(got).toMatchObject({ found: true, value: 'world' });
  });

  it('returns null for a missing key', async () => {
    const got = await callTool(sessionId, 20, 'storage_get', { key: 'd1-missing' }, d1Env);
    expect(got).toMatchObject({ found: false, value: null });
  });

  it('deletes a key', async () => {
    await callTool(sessionId, 30, 'storage_set', { key: 'd1-to-delete', value: 'bye' }, d1Env);
    await callTool(sessionId, 31, 'storage_delete', { key: 'd1-to-delete' }, d1Env);
    const got = await callTool(sessionId, 32, 'storage_get', { key: 'd1-to-delete' }, d1Env);
    expect(got).toMatchObject({ found: false, value: null });
  });

  it('lists keys by prefix', async () => {
    await callTool(sessionId, 40, 'storage_set', { key: 'd1-list-a', value: '1' }, d1Env);
    await callTool(sessionId, 41, 'storage_set', { key: 'd1-list-b', value: '2' }, d1Env);
    await callTool(sessionId, 42, 'storage_set', { key: 'd1-other', value: '3' }, d1Env);
    const listed = await callTool(sessionId, 43, 'storage_list', { prefix: 'd1-list-' }, d1Env);
    expect(listed).toMatchObject({ count: 2 });
    const keys = listed.keys as string[];
    expect(keys).toContain('d1-list-a');
    expect(keys).toContain('d1-list-b');
    expect(keys).not.toContain('d1-other');
  });

  it('respects TTL expiry (value vanishes after TTL elapses)', async () => {
    // Set with ttl=1 second. D1Provider stores expiry as expires_at (Unix ms)
    // and filters on get(). The miniflare D1 emulator uses real wall-clock time.
    await callTool(
      sessionId,
      50,
      'storage_set',
      { key: 'd1-ttl', value: 'ephemeral', ttl: 1 },
      d1Env,
    );
    // Immediate read — should still be present (within the 1s window).
    const before = await callTool(sessionId, 51, 'storage_get', { key: 'd1-ttl' }, d1Env);
    expect(before).toMatchObject({ found: true });

    // Wait 1.1s for expiry to elapse.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const after = await callTool(sessionId, 52, 'storage_get', { key: 'd1-ttl' }, d1Env);
    expect(after).toMatchObject({ found: false });
  });
});

/**
 * @fileoverview Worker-runtime integration tests for the Cloudflare R2 storage provider.
 * Exercises set / get / delete / list / expiry through the MCP HTTP surface by
 * driving the fixture worker with `STORAGE_PROVIDER_TYPE=cloudflare-r2` bound to
 * the miniflare-emulated R2_BUCKET. Each test file runs in its own miniflare
 * isolate, so `appPromise` starts null and the first fetch initialises the
 * singleton with the overridden env.
 * @module tests/worker/storage-r2.worker.test
 */

import { createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
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

/** Env override that routes storage to the miniflare-emulated R2 bucket. */
const r2Env = { ...env, STORAGE_PROVIDER_TYPE: 'cloudflare-r2' };

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

  afterEach(async () => {
    // Clear all R2 binding state between tests to prevent cross-test leakage.
    await reset();
  });

  it('sets and gets a value', async () => {
    await callTool(sessionId, 10, 'storage_set', { key: 'r2-hello', value: 'world' }, r2Env);
    const got = await callTool(sessionId, 11, 'storage_get', { key: 'r2-hello' }, r2Env);
    expect(got).toMatchObject({ found: true, value: 'world' });
  });

  it('returns null for a missing key', async () => {
    const got = await callTool(sessionId, 20, 'storage_get', { key: 'r2-missing' }, r2Env);
    expect(got).toMatchObject({ found: false, value: null });
  });

  it('deletes a key', async () => {
    await callTool(sessionId, 30, 'storage_set', { key: 'r2-to-delete', value: 'bye' }, r2Env);
    await callTool(sessionId, 31, 'storage_delete', { key: 'r2-to-delete' }, r2Env);
    const got = await callTool(sessionId, 32, 'storage_get', { key: 'r2-to-delete' }, r2Env);
    expect(got).toMatchObject({ found: false, value: null });
  });

  it('lists keys by prefix', async () => {
    await callTool(sessionId, 40, 'storage_set', { key: 'r2-list-a', value: '1' }, r2Env);
    await callTool(sessionId, 41, 'storage_set', { key: 'r2-list-b', value: '2' }, r2Env);
    await callTool(sessionId, 42, 'storage_set', { key: 'r2-other', value: '3' }, r2Env);
    const listed = await callTool(sessionId, 43, 'storage_list', { prefix: 'r2-list-' }, r2Env);
    expect(listed).toMatchObject({ count: 2 });
    const keys = listed.keys as string[];
    expect(keys).toContain('r2-list-a');
    expect(keys).toContain('r2-list-b');
    expect(keys).not.toContain('r2-other');
  });

  it('respects TTL expiry (value vanishes after TTL elapses)', async () => {
    // Set with ttl=1 second. R2Provider stores expiry in an envelope and filters
    // on get(). We rely on miniflare advancing simulated time or real elapsed time.
    // Use ttl=1 and a small real-time wait to confirm expiry logic fires.
    await callTool(
      sessionId,
      50,
      'storage_set',
      { key: 'r2-ttl', value: 'ephemeral', ttl: 1 },
      r2Env,
    );
    // Immediate read — should still be present (within the 1s window).
    const before = await callTool(sessionId, 51, 'storage_get', { key: 'r2-ttl' }, r2Env);
    expect(before).toMatchObject({ found: true });

    // Wait 1.1s for expiry to elapse.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const after = await callTool(sessionId, 52, 'storage_get', { key: 'r2-ttl' }, r2Env);
    expect(after).toMatchObject({ found: false });
  });
});

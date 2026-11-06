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
import { StorageService } from '@/storage/core/StorageService.js';
import { D1Provider } from '@/storage/providers/cloudflare/d1Provider.js';
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

/**
 * `list` against real D1, where the prefix predicate is evaluated: D1 caps a
 * `LIKE`/`GLOB` pattern at 50 bytes and evaluates it only when the tenant holds
 * a row, so every case here writes rows first.
 */
describe('D1Provider.list prefix matching on real D1', () => {
  const provider = new D1Provider(env.DB);
  const storage = new StorageService(provider);
  const contextFor = (tenantId: string) => ({
    tenantId,
    requestId: 'd1-list-prefix',
    timestamp: '2026-11-06T00:00:00Z',
  });

  /** Every key `list` returns for `prefix`, following cursors one key per page. */
  async function walk(tenantId: string, prefix: string): Promise<string[][]> {
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await storage.list(prefix, contextFor(tenantId), {
        limit: 1,
        ...(cursor && { cursor }),
      });
      pages.push(page.keys);
      cursor = page.nextCursor;
    } while (cursor && pages.length < 20);
    return pages;
  }

  beforeAll(async () => {
    await applyD1Migrations(env.DB, [
      { name: '0001_create_kv_store', queries: [KV_STORE_MIGRATION] },
    ]);
  });

  it('lists prefixes past D1’s 50-byte pattern limit, returning exactly the keys that start with them', async () => {
    const context = contextFor('d1-long');
    const x50 = 'x'.repeat(50);
    const under25 = '_'.repeat(25);
    const a512 = 'a'.repeat(512);
    await storage.setMany(
      new Map<string, unknown>(
        [
          x50,
          `${x50}/1`,
          `${'x'.repeat(49)}y`,
          `${under25}/k`,
          `${'_'.repeat(24)}a/k`,
          a512,
          `${a512}/x`,
          `${'a'.repeat(511)}b`,
        ].map((key) => [key, key.length]),
      ),
      context,
    );

    await expect(storage.list(x50, context)).resolves.toMatchObject({ keys: [x50, `${x50}/1`] });
    await expect(storage.list(under25, context)).resolves.toMatchObject({
      keys: [`${under25}/k`],
    });
    await expect(storage.list(a512, context)).resolves.toMatchObject({ keys: [a512, `${a512}/x`] });
    expect(await walk('d1-long', a512)).toEqual([[a512], [`${a512}/x`]]);
  });

  it('matches a prefix case-sensitively and pages the match once', async () => {
    const context = contextFor('d1-case');
    await storage.setMany(
      new Map<string, unknown>([
        ['user/1', 1],
        ['User/2', 2],
        ['USER/3', 3],
        ['uSer/5', 5],
      ]),
      context,
    );

    await expect(storage.list('user/', context)).resolves.toMatchObject({ keys: ['user/1'] });
    expect(await walk('d1-case', 'user/')).toEqual([['user/1']]);
  });

  it('lists every live key of the tenant for an empty prefix, in key order, one page at a time', async () => {
    const tenant = 'd1-walk';
    await storage.setMany(
      new Map<string, unknown>([
        ['b', 2],
        ['a', 1],
        ['c/1', 3],
        ['lit_x/c', 4],
        ['litax/d', 5],
      ]),
      contextFor(tenant),
    );
    await storage.set('a0', 'other tenant', contextFor('d1-walk-other'));
    await env.DB.prepare(
      'INSERT INTO kv_store (tenant_id, key, value, expires_at) VALUES (?, ?, ?, ?)',
    )
      .bind(tenant, 'a-expired', '"stale"', Date.now() - 1_000)
      .run();

    expect(await walk(tenant, '')).toEqual([['a'], ['b'], ['c/1'], ['lit_x/c'], ['litax/d']]);
    await expect(storage.list('lit_x/', contextFor(tenant))).resolves.toMatchObject({
      keys: ['lit_x/c'],
    });
    await expect(storage.list('a', contextFor(tenant))).resolves.toMatchObject({ keys: ['a'] });
  });

  it('bounds a prefix whose last code point has no successor, or is a lone surrogate', async () => {
    const tenant = 'd1-edges';
    const context = contextFor(tenant);
    const keys = [
      'm\u{10FFFE}',
      'm\u{10FFFF}',
      'm\u{10FFFF}z',
      'n',
      '\u{10FFFF}',
      '\u{10FFFF}a',
      's퟿',
      's\uD800',
      's\uD800t',
      's\uD801',
      's',
    ];
    for (const key of keys) await provider.set(tenant, key, 1, context);

    await expect(provider.list(tenant, 'm\u{10FFFF}', context)).resolves.toMatchObject({
      keys: ['m\u{10FFFF}', 'm\u{10FFFF}z'],
    });
    await expect(provider.list(tenant, '\u{10FFFF}', context)).resolves.toMatchObject({
      keys: ['\u{10FFFF}', '\u{10FFFF}a'],
    });
    // D1 reads a stored lone surrogate back lossily, so the match is counted, not compared.
    const loneSurrogate = await provider.list(tenant, 's\uD800', context);
    expect(loneSurrogate.keys).toHaveLength(2);
    expect(loneSurrogate.keys.filter((key) => key.endsWith('t'))).toHaveLength(1);
  });
});

/** @fileoverview Standalone Worker startup and request isolation, outside the Workerd test-pool loader. */
import { expect, it } from 'vitest';
import { callTool } from '../benchmarks/io/harness/mcp-request.js';
import { generateTestJwt } from '../helpers/http-helpers.js';
import { startStandaloneWorker } from '../helpers/standalone-worker.js';

it('boots the built Worker and preserves tenants across overlapping KV requests', async () => {
  const secret = 'standalone-worker-test-key-not-a-secret';
  // #406: static imports execute at isolate startup, where randomBytes() is forbidden.
  const server = await startStandaloneWorker(secret);
  try {
    const tokens = ['tenant-a', 'tenant-b'].map((tid) =>
      generateTestJwt({ tid, sub: tid, cid: 'worker-test', scp: ['test'] }, secret),
    );
    const responses = await Promise.allSettled(
      Array.from({ length: 16 }, (_, i) =>
        callTool(server.url, tokens[i % 2]!, i, 'load_state', {
          key: `shared-${Math.floor(i / 2)}`,
          value: `value-${i}`,
        }),
      ),
    );
    for (const [i, outcome] of responses.entries()) {
      if (outcome.status === 'rejected') throw outcome.reason;
      const response = outcome.value;
      expect(response.status).toBe(200);
      expect(response.body.id).toBe(i);
      expect(response.body.result.isError).toBeUndefined();
      expect(response.body.result.structuredContent).toEqual({
        value: `value-${i}`,
        tenant: i % 2 === 0 ? 'tenant-a' : 'tenant-b',
      });
    }
    // Read without overwriting: each tenant must retain its own value after the burst.
    for (let i = 0; i < 16; i++) {
      const stored = await callTool(server.url, tokens[i % 2]!, i + 16, 'load_state', {
        key: `shared-${Math.floor(i / 2)}`,
      });
      expect(stored.status).toBe(200);
      expect(stored.body.result.structuredContent).toEqual({
        value: `value-${i}`,
        tenant: i % 2 === 0 ? 'tenant-a' : 'tenant-b',
      });
    }
    // First cursor use must generate randomness inside a Workerd request, then reuse the key.
    const first = await callTool(server.url, tokens[0]!, 50, 'load_list', {});
    expect(first.status).toBe(200);
    expect(first.body.result.isError).toBeUndefined();
    const { items, cursor } = first.body.result.structuredContent;
    expect(items).toEqual([
      { key: 'shared-0', value: 'value-0' },
      { key: 'shared-1', value: 'value-2' },
      { key: 'shared-2', value: 'value-4' },
    ]);
    expect(cursor).toEqual(expect.any(String));
    const second = await callTool(server.url, tokens[0]!, 51, 'load_list', { cursor });
    expect(second.body.result.isError).toBeUndefined();
    expect(second.body.result.structuredContent.items).toEqual([
      { key: 'shared-3', value: 'value-6' },
      { key: 'shared-4', value: 'value-8' },
      { key: 'shared-5', value: 'value-10' },
    ]);
    const last = await callTool(server.url, tokens[0]!, 52, 'load_list', {
      cursor: second.body.result.structuredContent.cursor,
    });
    expect(last.body.result.structuredContent).toEqual({
      items: [
        { key: 'shared-6', value: 'value-12' },
        { key: 'shared-7', value: 'value-14' },
      ],
    });
    const [payload, signature] = cursor.split('.');
    const alteredPayload = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, 'base64').toString()),
        t: 'tenant-b',
      }),
    ).toString('base64');
    const alteredSignature = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    for (const [token, rejectedCursor] of [
      [tokens[1]!, cursor],
      [tokens[1]!, `${alteredPayload}.${signature}`],
      [tokens[0]!, `${payload}.${alteredSignature}`],
    ]) {
      const rejected = await callTool(server.url, token, 53, 'load_list', {
        cursor: rejectedCursor,
      });
      expect(rejected.body.result.isError).toBe(true);
      expect(rejected.body.result.structuredContent.items).toBeUndefined();
    }
    const retry = await callTool(server.url, tokens[0]!, 54, 'load_list', { cursor });
    expect(retry.body.result.structuredContent).toEqual(second.body.result.structuredContent);
    const denied = await callTool(server.url, 'invalid-token', 99, 'load_echo', {
      payload: 'denied',
    });
    expect(denied.status).toBe(401);
    expect(denied.body.result).toBeUndefined();
    const owner = await callTool(server.url, tokens[0]!, 100, 'load_echo', { payload: 'allowed' });
    expect(owner.status).toBe(200);
    expect(owner.body.result.structuredContent).toEqual({ payload: 'allowed' });
  } finally {
    await server.close();
  }
});

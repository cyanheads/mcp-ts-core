/** @fileoverview Shared HTTP workloads so Workerd and Node/Bun run identical requests. */
import { expect } from 'vitest';
import { generateTestJwt } from '../../../helpers/http-helpers.js';
import { callTool } from './mcp-request.js';
import { measure } from './measure.js';
import type { Measurement } from './report.js';

/** Fixture-only key; never used outside local test processes. */
export const LOAD_SECRET = 'local-load-test-key-not-a-real-secret';

/** Warm each case, then measure three fixed rounds while validating every wire result. */
export async function transportWorkloads(url: string): Promise<Measurement[]> {
  const tokens = ['tenant-a', 'tenant-b'].map((tid) =>
    generateTestJwt({ tid, sub: tid, cid: 'load-client', scp: ['load:read'] }, LOAD_SECRET, 3600),
  );
  const results: Measurement[] = [];
  for (const concurrency of [1, 8, 32]) {
    for (const bytes of [128, 16_384]) {
      const payload = 'x'.repeat(bytes);
      for (let round = 1; round <= 3; round++) {
        const result = await measure({
          concurrency,
          operations: 256,
          warmup: 32,
          run: (i) => callTool(url, tokens[i % 2]!, i, 'load_echo', { payload }),
          verify: ({ status, body }, id) => {
            expect(status, JSON.stringify(body)).toBe(200);
            expect(body).toMatchObject({
              jsonrpc: '2.0',
              id,
              result: { structuredContent: { payload } },
            });
            expect(body.error).toBeUndefined();
            expect(body.result.isError).toBeUndefined();
          },
        });
        results.push({ name: `echo / ${bytes} bytes / concurrency ${concurrency}`, round, result });
      }
    }
  }
  for (let round = 1; round <= 3; round++) {
    results.push({
      name: 'state set+get / 2 tenants / concurrency 16',
      round,
      result: await measure({
        concurrency: 16,
        operations: 256,
        warmup: 32,
        run: (i) =>
          callTool(url, tokens[i % 2]!, i, 'load_state', {
            key: `key-${Math.floor(i / 2)}`,
            value: `value-${i}`,
          }),
        verify: ({ status, body }, i) => {
          expect(status, JSON.stringify(body)).toBe(200);
          expect(body.id).toBe(i);
          expect(body.result.isError).toBeUndefined();
          expect(body.result.structuredContent).toEqual({
            value: `value-${i}`,
            tenant: i % 2 === 0 ? 'tenant-a' : 'tenant-b',
          });
        },
      }),
    });
  }
  // Outside reported measurements, verify persisted isolation without rewriting any key.
  for (let i = 0; i < 256; i++) {
    const stored = await callTool(url, tokens[i % 2]!, i, 'load_state', {
      key: `key-${Math.floor(i / 2)}`,
    });
    expect(stored.status).toBe(200);
    expect(stored.body.result.structuredContent).toEqual({
      value: `value-${i}`,
      tenant: i % 2 === 0 ? 'tenant-a' : 'tenant-b',
    });
  }
  // Rejected JWTs are measured separately; they must never produce a tool result.
  for (let round = 1; round <= 3; round++) {
    results.push({
      name: 'invalid JWT rejection / concurrency 16',
      round,
      result: await measure({
        concurrency: 16,
        operations: 256,
        warmup: 32,
        run: (i) => callTool(url, 'invalid-token', i, 'load_echo', { payload: 'unauthorized' }),
        verify: ({ status, body }) => {
          expect(status).toBe(401);
          expect(body.result).toBeUndefined();
        },
      }),
    });
  }
  // A rejection burst must not poison a subsequent authorized request.
  const recovered = await callTool(url, tokens[0]!, 1, 'load_echo', {
    payload: 'after-rejections',
  });
  expect(recovered.status).toBe(200);
  expect(recovered.body.result.structuredContent).toEqual({ payload: 'after-rejections' });
  return results;
}

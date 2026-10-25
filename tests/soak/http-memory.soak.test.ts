/**
 * @fileoverview Memory soak over loopback HTTP against the built package: sustained
 * stateless traffic in both protocol eras must not grow the server's post-GC heap.
 * @module tests/soak/http-memory.soak
 */
import { expect, it } from 'vitest';
import { jsonrpc, MCP_HEADERS, parseSSEEvents } from '../helpers/http-helpers.js';
import { assertBuildFresh, startServerFromEntrypoint } from '../helpers/server-process.js';

/** Requests before the baseline reading, so the heap reaches its steady state first. */
const WARMUP_REQUESTS = 5_000;
const ROUNDS = 4;
const REQUESTS_PER_ROUND = 5_000;
const CONCURRENCY = 16;
/**
 * Allowed post-GC heap growth across the measured rounds — about 3.4 KiB per
 * request. A healthy server's post-GC heap wanders within roughly 30 MiB from
 * reading to reading with no trend, even over 50,000 requests; a per-request
 * leak climbs every round (0.13.16 retained ~71 KiB per request, #786).
 */
const HEAP_GROWTH_BUDGET_BYTES = 64 * 1024 * 1024;

const MODERN_PROTOCOL = '2026-07-28';
const LEGACY_PROTOCOL = '2025-06-18';

type ToolResult = { structuredContent?: Record<string, unknown>; isError?: boolean };

/** One stateless `tools/call`, alternating protocol eras by id. */
async function callTool(url: string, id: number, name: string, args: Record<string, unknown>) {
  const modern = id % 2 === 0;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...MCP_HEADERS,
      'MCP-Protocol-Version': modern ? MODERN_PROTOCOL : LEGACY_PROTOCOL,
      ...(modern && { 'Mcp-Method': 'tools/call', 'Mcp-Name': name }),
    },
    body: jsonrpc(id, 'tools/call', {
      name,
      arguments: args,
      ...(modern && {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL,
          'io.modelcontextprotocol/clientInfo': { name: 'soak-test', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      }),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  const payloads = response.headers.get('content-type')?.includes('text/event-stream')
    ? parseSSEEvents(text).map(({ data }) => JSON.parse(data))
    : [JSON.parse(text)];
  const body = payloads.find((payload) => payload.id === id);
  if (response.status !== 200 || !body?.result || body.result.isError) {
    throw new Error(
      `Request ${id} (${name}) failed with ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  return body.result as ToolResult;
}

/** Sends `count` echo calls at fixed concurrency, checking every response. */
async function sendEchoes(url: string, firstId: number, count: number): Promise<void> {
  let next = firstId;
  const end = firstId + count;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < end) {
        const id = next++;
        const payload = `soak-${id}`;
        const result = await callTool(url, id, 'load_echo', { payload });
        if (result.structuredContent?.payload !== payload) {
          throw new Error(`Request ${id} echoed ${JSON.stringify(result.structuredContent)}`);
        }
      }
    }),
  );
}

async function heapUsedBytes(url: string, id: number): Promise<number> {
  const { structuredContent } = await callTool(url, id, 'soak_heap', {});
  if (structuredContent?.collected !== true) {
    throw new Error('The soak lane needs a runtime with a forced full GC (Bun).');
  }
  return structuredContent.heapUsedBytes as number;
}

it(`holds the post-GC heap flat across ${ROUNDS * REQUESTS_PER_ROUND} stateless requests`, async () => {
  assertBuildFresh();
  const server = await startServerFromEntrypoint('tests/fixtures/soak-http-server.js', 'http', {
    MCP_SESSION_MODE: 'stateless',
    MCP_AUTH_MODE: 'none',
    STORAGE_PROVIDER_TYPE: 'in-memory',
    MCP_LOG_LEVEL: 'emerg',
    OTEL_ENABLED: 'false',
  });
  const url = `http://127.0.0.1:${server.port}/mcp`;
  const readings: number[] = [];
  try {
    let id = 1;
    await sendEchoes(url, id, WARMUP_REQUESTS);
    id += WARMUP_REQUESTS;
    readings.push(await heapUsedBytes(url, id++));
    for (let round = 0; round < ROUNDS; round++) {
      await sendEchoes(url, id, REQUESTS_PER_ROUND);
      id += REQUESTS_PER_ROUND;
      readings.push(await heapUsedBytes(url, id++));
    }
  } finally {
    await server.kill();
  }

  const mib = (bytes: number) => `${(bytes / 2 ** 20).toFixed(1)} MiB`;
  const growth = (readings.at(-1) ?? 0) - (readings[0] ?? 0);
  expect(
    growth,
    `post-GC heap by round: ${readings.map(mib).join(' → ')} (growth ${mib(growth)}, ${Math.round(growth / (ROUNDS * REQUESTS_PER_ROUND))} bytes/request)`,
  ).toBeLessThanOrEqual(HEAP_GROWTH_BUDGET_BYTES);
});

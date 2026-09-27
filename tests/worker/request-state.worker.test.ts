/**
 * @fileoverview `MCP_REQUEST_STATE_KEY` under real workerd. The key reaches
 * `process.env` through `CORE_ENV_BINDINGS`, so a Worker seals the
 * `requestState` its handlers return and refuses one it never minted — each
 * 2026-07-28 request is served by a fresh per-request `McpServer`, so the
 * round is minted by one instance and verified by another holding the key.
 * @module tests/worker/request-state.worker.test
 */

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { tool, z } from '@/core/index.js';
import { createWorkerHandler } from '@/core/worker.js';
import { MCP_HEADERS, parseSseDataFrames } from './wire-helpers.js';

const MODERN = '2026-07-28';

/** Echoes the state a round carried, or asks for one round with `round-1`. */
const stateEcho = tool('state_echo', {
  description: 'Carries state across a round without asking the client for anything.',
  input: z.object({}),
  output: z.object({ state: z.string().describe('The state this round carried.') }),
  handler(_input, ctx) {
    const state = ctx.inputs.state<string>();
    if (state === undefined) return ctx.requestInput({ requestState: 'round-1' });
    return { state };
  },
  format: (result) => [{ type: 'text', text: result.state }],
});

// `name` makes composeServices re-parse config after the bindings are injected.
const worker = createWorkerHandler({ name: 'worker-request-state-test', tools: [stateEcho] });
const keyedEnv = { ...env, MCP_REQUEST_STATE_KEY: 'worker-request-state-key-0123456789abcdef' };

type Frame = {
  error?: { code: number; data?: { reason?: string } };
  result?: { requestState?: string; resultType?: string; structuredContent?: { state?: string } };
};

/** One 2026-07-28 `tools/call` of `state_echo`, optionally carrying `requestState`. */
async function call(requestState?: string): Promise<Frame> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request('http://example.com/mcp', {
      method: 'POST',
      headers: {
        ...MCP_HEADERS,
        'MCP-Protocol-Version': MODERN,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'state_echo',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'state_echo',
          arguments: {},
          ...(requestState !== undefined && { requestState }),
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN,
            'io.modelcontextprotocol/clientInfo': { name: 'worker-test', version: '0.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
    keyedEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const body = await response.text();
  return (
    body.trimStart().startsWith('{') ? JSON.parse(body) : parseSseDataFrames(body)[0]
  ) as Frame;
}

describe('MCP_REQUEST_STATE_KEY on a Worker', () => {
  it('seals a round and verifies it on the next request', async () => {
    const first = await call();
    const sealed = first.result?.requestState;

    expect(first.result?.resultType).toBe('input_required');
    expect(sealed).toMatch(/^v1\./);

    const retry = await call(sealed);
    expect(retry.result?.structuredContent).toEqual({ state: 'round-1' });
  });

  it('refuses a requestState it never minted', async () => {
    const forged = await call('round-1');

    expect(forged.error).toMatchObject({
      code: -32602,
      data: { reason: 'invalid_request_state' },
    });
  });
});

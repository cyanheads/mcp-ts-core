/**
 * @fileoverview Official-SDK black-box regressions for stateful Streamable
 * HTTP sessions. A session's `McpServer` and transport are persistent, which is
 * what lets an interactive multi-round-trip exchange and an ordinary
 * cancellation cross POSTs on the same session.
 * @module tests/integration/http-protocol-session.int.test
 */

import { resolve } from 'node:path';
import {
  Client,
  ProtocolError,
  ProtocolErrorCode,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type ServerHandle, startServerFromEntrypoint } from '../helpers/server-process.js';

const FIXTURE = resolve(process.cwd(), 'tests/fixtures/http-protocol-session-server.js');

type ClientOptions = ConstructorParameters<typeof Client>[1];
type Observations = {
  resourceActive: number;
  resourceCancellations: number;
  resourceStarts: number;
  toolActive: number;
  toolCancellations: number;
  toolStarts: number;
};

describe('stateful HTTP protocol sessions', () => {
  let server: ServerHandle;
  const clients: Client[] = [];

  beforeAll(async () => {
    server = await startServerFromEntrypoint(FIXTURE, 'http', {
      MCP_HEARTBEAT_INTERVAL_MS: '0',
      MCP_SESSION_MODE: 'stateful',
    });
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  });

  afterAll(async () => {
    await server?.kill();
  });

  async function connect(
    options?: ClientOptions,
    configure?: (client: Client) => void,
  ): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${server.port}/mcp`),
    );
    const client = new Client(
      { name: `protocol-session-${crypto.randomUUID()}`, version: '1.0.0' },
      options,
    );
    configure?.(client);
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  async function readObservations(client: Client): Promise<Observations> {
    const result = await client.callTool({ name: 'session_observations', arguments: {} });
    return result.structuredContent as Observations;
  }

  async function waitForIncrease(
    client: Client,
    field: keyof Observations,
    baseline: number,
  ): Promise<Observations> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const observations = await readObservations(client);
      if (observations[field] > baseline) return observations;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    throw new Error(`Observation ${field} did not increase within 5000ms.`);
  }

  it('fails cleanly for a session that cannot fulfil an input request', async () => {
    const plain = await connect();
    const result = await plain.callTool({
      name: 'session_elicitation_probe',
      arguments: { mode: 'form' },
    });

    expect(result.isError).toBe(true);
  });

  it('completes a form input round trip across stateful HTTP requests', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const capable = await connect(
      { capabilities: { elicitation: { form: {}, url: {} } } },
      (client) => {
        client.setRequestHandler('elicitation/create', (request) => {
          requests.push(request.params as unknown as Record<string, unknown>);
          return { action: 'accept', content: { value: 'state-restored' } };
        });
      },
    );

    const form = await capable.callTool(
      { name: 'session_elicitation_probe', arguments: { mode: 'form' } },
      { timeout: 5_000 },
    );

    // `reentered: true` can only hold if the requestState minted on the first
    // POST came back on the retry — the session's server carried the exchange.
    expect(form.structuredContent).toEqual({
      action: 'accept',
      reentered: true,
      value: 'state-restored',
    });
    expect(requests.map((request) => request.mode)).toEqual(['form']);
  });

  it('completes a URL input round trip across stateful HTTP requests', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const capable = await connect(
      { capabilities: { elicitation: { form: {}, url: {} } } },
      (client) => {
        client.setRequestHandler('elicitation/create', (request) => {
          requests.push(request.params as unknown as Record<string, unknown>);
          return { action: 'accept' };
        });
      },
    );

    const url = await capable.callTool(
      { name: 'session_elicitation_probe', arguments: { mode: 'url' } },
      { timeout: 5_000 },
    );

    expect(url.structuredContent).toEqual({ action: 'accept', reentered: true, value: null });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      mode: 'url',
      url: 'https://example.test/authorize',
    });
  });

  it('re-issues the request when accepted content fails the advertised schema', async () => {
    // Neither era re-validates accepted content, so the handler's
    // `ctx.inputs.accepted(key, schema)` is what catches it — and the retry
    // budget is what stops the loop.
    const client = await connect(
      { capabilities: { elicitation: { form: {}, url: {} } } },
      (configuredClient) => {
        configuredClient.setRequestHandler('elicitation/create', () => ({
          action: 'accept',
          content: { value: 42 },
        }));
      },
    );

    const result = await client.callTool(
      { name: 'session_elicitation_probe', arguments: { mode: 'form' } },
      { timeout: 10_000 },
    );

    expect(result.isError).toBe(true);
  });

  it('surfaces a client error response to the originating handler', async () => {
    const client = await connect(
      { capabilities: { elicitation: { form: {}, url: {} } } },
      (configuredClient) => {
        configuredClient.setRequestHandler('elicitation/create', () => {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            'Client refused the elicitation request.',
          );
        });
      },
    );

    const result = await client.callTool(
      { name: 'session_elicitation_probe', arguments: { mode: 'form' } },
      { timeout: 5_000 },
    );

    expect(result.isError).toBe(true);
  });

  it('correlates concurrent input responses in reverse completion order', async () => {
    const client = await connect(
      { capabilities: { elicitation: { form: {}, url: {} } } },
      (configuredClient) => {
        configuredClient.setRequestHandler('elicitation/create', async (request) => {
          const label = request.params.message.includes('slow') ? 'slow' : 'fast';
          if (label === 'slow') {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
          }
          return { action: 'accept', content: { value: label } };
        });
      },
    );

    const [slow, fast] = await Promise.all([
      client.callTool(
        { name: 'session_elicitation_probe', arguments: { mode: 'form', label: 'slow' } },
        { timeout: 5_000 },
      ),
      client.callTool(
        { name: 'session_elicitation_probe', arguments: { mode: 'form', label: 'fast' } },
        { timeout: 5_000 },
      ),
    ]);

    expect(slow.structuredContent).toMatchObject({ value: 'slow' });
    expect(fast.structuredContent).toMatchObject({ value: 'fast' });
  });

  it('routes an ordinary tool cancellation POST into the in-flight handler signal', async () => {
    const client = await connect();
    const before = await readObservations(client);
    const controller = new AbortController();
    const pending = client.callTool(
      { name: 'session_cancellable_tool', arguments: { label: 'tool-cancel' } },
      { signal: controller.signal, timeout: 10_000 },
    );

    await waitForIncrease(client, 'toolStarts', before.toolStarts);
    controller.abort(new DOMException('cancel tool request', 'AbortError'));

    await expect(pending).rejects.toMatchObject({
      message: expect.stringContaining('cancel tool request'),
    });
    const after = await waitForIncrease(client, 'toolCancellations', before.toolCancellations);
    expect(after.toolActive).toBe(0);
  });

  it('routes an ordinary resource cancellation POST into the in-flight handler signal', async () => {
    const client = await connect();
    const before = await readObservations(client);
    const controller = new AbortController();
    const pending = client.readResource(
      { uri: 'session-test://wait/resource-cancel' },
      { signal: controller.signal, timeout: 10_000 },
    );

    await waitForIncrease(client, 'resourceStarts', before.resourceStarts);
    controller.abort(new DOMException('cancel resource request', 'AbortError'));

    await expect(pending).rejects.toMatchObject({
      message: expect.stringContaining('cancel resource request'),
    });
    const after = await waitForIncrease(
      client,
      'resourceCancellations',
      before.resourceCancellations,
    );
    expect(after.resourceActive).toBe(0);
  });
});

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

import { initializeBody, MCP_HEADERS, parseSSEEvents } from '../helpers/http-helpers.js';
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

  /**
   * Raw-wire cases (#401). The SDK client tears down its own side of the
   * original POST when it cancels, so the server-side stream a cancellation
   * leaves behind is only observable by holding that POST open on one
   * connection and sending the cancellation on another.
   */
  describe('per-request stream release on cancellation', () => {
    type Frame = { id?: number; result?: { structuredContent?: unknown } };

    const endpoint = () => `http://127.0.0.1:${server.port}/mcp`;
    const callTool = (id: number, name: string, args: Record<string, unknown>) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      });
    const cancelled = (requestId: number) =>
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId, reason: 'raw-wire probe' },
      });

    async function openRawSession(protocolVersion: string): Promise<Record<string, string>> {
      const init = await fetch(endpoint(), {
        body: initializeBody(1, protocolVersion),
        headers: MCP_HEADERS,
        method: 'POST',
      });
      expect(init.status).toBe(200);
      const sessionId = init.headers.get('mcp-session-id');
      if (!sessionId) throw new Error('initialize returned no Mcp-Session-Id');
      await init.text();
      const headers = {
        ...MCP_HEADERS,
        'Mcp-Session-Id': sessionId,
        'MCP-Protocol-Version': protocolVersion,
      };
      const ack = await fetch(endpoint(), {
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        headers,
        method: 'POST',
      });
      expect(ack.status).toBe(202);
      return headers;
    }

    async function post(headers: Record<string, string>, body: string): Promise<Response> {
      return fetch(endpoint(), { body, headers, method: 'POST' });
    }

    /**
     * Reads SSE text from `reader` until the stream ends, `until` matches, or
     * `timeoutMs` elapses. `ended` is true only when the server closed the stream.
     */
    async function read(
      reader: ReadableStreamDefaultReader<Uint8Array>,
      timeoutMs: number,
      until?: (text: string) => boolean,
    ): Promise<{ ended: boolean; text: string }> {
      const decoder = new TextDecoder();
      const deadline = Date.now() + timeoutMs;
      let text = '';
      while (Date.now() < deadline) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout('timeout'), deadline - Date.now());
        });
        const next = await Promise.race([reader.read(), timeout]);
        clearTimeout(timer);
        if (next === 'timeout') break;
        if (next.done) return { ended: true, text };
        text += decoder.decode(next.value, { stream: true });
        if (until?.(text)) break;
      }
      return { ended: false, text };
    }

    /** The complete JSON-RPC frames in `text`; the priming event's empty `data:` is skipped. */
    function frames(text: string): Frame[] {
      const complete = text.lastIndexOf('\n\n');
      if (complete < 0) return [];
      return parseSSEEvents(text.slice(0, complete + 2))
        .filter((event) => event.data.startsWith('{'))
        .map((event) => JSON.parse(event.data) as Frame);
    }

    async function rawObservations(headers: Record<string, string>): Promise<Observations> {
      const response = await post(headers, callTool(900, 'session_observations', {}));
      const { text } = await read(response.body!.getReader(), 5_000);
      const frame = frames(text).find((candidate) => candidate.id === 900);
      return frame?.result?.structuredContent as Observations;
    }

    it('closes the cancelled request stream instead of holding it open to the keep-alive', async () => {
      const headers = await openRawSession('2025-11-25');
      const before = await rawObservations(headers);
      const pending = await post(
        headers,
        callTool(77, 'session_cancellable_tool', { label: 'raw' }),
      );
      expect(pending.status).toBe(200);
      expect(pending.headers.get('content-type')).toContain('text/event-stream');

      const deadline = Date.now() + 5_000;
      while ((await rawObservations(headers)).toolStarts === before.toolStarts) {
        if (Date.now() > deadline) throw new Error('handler did not start within 5000ms');
      }
      const ack = await post(headers, cancelled(77));
      expect(ack.status).toBe(202);

      // The transport's keep-alive comment lands at 15s; a released stream ends long before.
      const { ended, text } = await read(pending.body!.getReader(), 5_000);
      expect(ended).toBe(true);
      expect(text).not.toContain(': keepalive');
      expect(frames(text).some((frame) => frame.id === 77)).toBe(false);
      expect((await rawObservations(headers)).toolCancellations).toBe(before.toolCancellations + 1);
    });

    it('answers a cancellation for an unknown id with 202 and leaves other streams alone', async () => {
      const headers = await openRawSession('2025-11-25');
      const pending = await post(headers, callTool(10, 'session_delay', { ms: 400 }));
      expect(pending.status).toBe(200);

      const stray = await post(headers, cancelled(999));
      expect(stray.status).toBe(202);

      const { ended, text } = await read(pending.body!.getReader(), 5_000);
      expect(ended).toBe(true);
      const result = frames(text).find((frame) => frame.id === 10);
      expect(result?.result?.structuredContent).toEqual({ completed: true });
    });

    it('leaves a batched request stream open so a sibling response still arrives', async () => {
      // Batching exists only on the two oldest revisions; the sessionful arm still serves it.
      const headers = await openRawSession('2025-03-26');
      const pending = await post(
        headers,
        `[${callTool(1, 'session_cancellable_tool', { label: 'batch' })},${callTool(2, 'session_delay', { ms: 300 })}]`,
      );
      expect(pending.status).toBe(200);
      const ack = await post(headers, cancelled(1));
      expect(ack.status).toBe(202);

      const reader = pending.body!.getReader();
      const first = await read(reader, 5_000, (text) =>
        frames(text).some((frame) => frame.id === 2),
      );
      const sibling = frames(first.text).find((frame) => frame.id === 2);
      expect(sibling?.result?.structuredContent).toEqual({ completed: true });
      expect(frames(first.text).some((frame) => frame.id === 1)).toBe(false);

      // The shared stream is not closed on the cancelled id's behalf.
      const rest = await read(reader, 500);
      expect(rest.ended).toBe(false);
      await reader.cancel();
    });
  });
});

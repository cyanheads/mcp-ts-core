/**
 * @fileoverview Official-SDK black-box regressions for stateful Streamable
 * HTTP protocol state. Verifies initialize capabilities are restored onto
 * per-request servers and ordinary tool/resource cancellations cross POSTs.
 * @module tests/integration/http-protocol-session.int.test
 */

import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
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
    // SDK 1.26.0's concrete HTTP transport declares `sessionId` as
    // `string | undefined`, while its Transport interface uses an exact
    // optional property. Match the established integration-test boundary cast.
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    clients.push(client);
    return client;
  }

  /** Reads an SSE tool-call stream until the server's elicitation request arrives. */
  async function readFirstElicitationId(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Tool call returned no SSE stream.');
    const decoder = new TextDecoder();
    let buffered = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error('SSE stream ended before the elicitation request.');
      buffered += decoder.decode(value, { stream: true });
      for (const line of buffered.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const message = JSON.parse(line.slice('data: '.length)) as {
          id?: string;
          method?: string;
        };
        if (message.method === 'elicitation/create' && message.id) {
          reader.releaseLock();
          return message.id;
        }
      }
    }
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

  it('does not expose elicitation to sessions that did not advertise it', async () => {
    const plain = await connect();
    const result = await plain.callTool({
      name: 'session_elicitation_probe',
      arguments: { mode: 'form' },
    });

    expect(result.structuredContent).toEqual({ action: null, available: false, value: null });
  });

  it('completes form elicitation across stateful HTTP requests', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const capable = await connect(
      { capabilities: { elicitation: { form: {}, url: {} } } },
      (client) => {
        client.setRequestHandler(ElicitRequestSchema, (request) => {
          requests.push(request.params as Record<string, unknown>);
          return { action: 'accept', content: { value: 'state-restored' } };
        });
      },
    );

    const form = await capable.callTool(
      { name: 'session_elicitation_probe', arguments: { mode: 'form' } },
      CallToolResultSchema,
      { timeout: 1_000 },
    );

    expect(form.structuredContent).toEqual({
      action: 'accept',
      available: true,
      value: 'state-restored',
    });
    expect(requests.map((request) => request.mode)).toEqual(['form']);
  });

  it('completes URL elicitation across stateful HTTP requests', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const capable = await connect(
      { capabilities: { elicitation: { form: {}, url: {} } } },
      (client) => {
        client.setRequestHandler(ElicitRequestSchema, (request) => {
          requests.push(request.params as Record<string, unknown>);
          return { action: 'accept' };
        });
      },
    );

    const url = await capable.callTool(
      { name: 'session_elicitation_probe', arguments: { mode: 'url' } },
      CallToolResultSchema,
      { timeout: 1_000 },
    );

    expect(url.structuredContent).toEqual({ action: 'accept', available: true, value: null });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      mode: 'url',
      elicitationId: expect.any(String),
      url: 'https://example.test/authorize',
    });
  });

  it('rejects invalid accepted form content across stateful HTTP requests', async () => {
    const client = await connect(
      { capabilities: { elicitation: { form: {}, url: {} } } },
      (configuredClient) => {
        configuredClient.setRequestHandler(ElicitRequestSchema, () => ({
          action: 'accept',
          content: { value: 42 },
        }));
      },
    );

    const result = await client.callTool(
      { name: 'session_elicitation_probe', arguments: { mode: 'form' } },
      CallToolResultSchema,
      { timeout: 1_000 },
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'elicitation_response_invalid' },
        },
      },
    });
  });

  it('routes a client elicitation error response to the originating server', async () => {
    const client = await connect(
      { capabilities: { elicitation: { form: {}, url: {} } } },
      (configuredClient) => {
        configuredClient.setRequestHandler(ElicitRequestSchema, () => {
          throw new McpError(
            JsonRpcErrorCode.InvalidParams,
            'Client refused the elicitation request.',
          );
        });
      },
    );

    const result = await client.callTool({
      name: 'session_elicitation_probe',
      arguments: { mode: 'form' },
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.InternalError,
          message: expect.stringContaining('Client refused the elicitation request.'),
        },
      },
    });
  });

  it('correlates concurrent elicitation responses in reverse completion order', async () => {
    const client = await connect(
      { capabilities: { elicitation: { form: {}, url: {} } } },
      (configuredClient) => {
        configuredClient.setRequestHandler(ElicitRequestSchema, async (request) => {
          const label = request.params.message.includes('slow') ? 'slow' : 'fast';
          if (label === 'slow') {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
          }
          return { action: 'accept', content: { value: label } };
        });
      },
    );

    const [slow, fast] = await Promise.all([
      client.callTool({
        name: 'session_elicitation_probe',
        arguments: { mode: 'form', label: 'slow' },
      }),
      client.callTool({
        name: 'session_elicitation_probe',
        arguments: { mode: 'form', label: 'fast' },
      }),
    ]);

    expect(slow.structuredContent).toMatchObject({ value: 'slow' });
    expect(fast.structuredContent).toMatchObject({ value: 'fast' });
  });

  /**
   * A POST carrying only a routed server response still reaches the transport,
   * which owns the Accept and Content-Type checks. Short-circuiting the reply
   * here would silently exempt that one path from them.
   */
  it('applies transport header validation to a routed elicitation response', async () => {
    const endpoint = `http://127.0.0.1:${server.port}/mcp`;
    const baseHeaders = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2025-06-18',
    };

    const initialize = await fetch(endpoint, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: { elicitation: { form: {} } },
          clientInfo: { name: 'raw-http-probe', version: '1.0.0' },
        },
      }),
    });
    const sessionId = initialize.headers.get('mcp-session-id');
    await initialize.body?.cancel();
    expect(sessionId).toBeTruthy();
    const sessionHeaders = { ...baseHeaders, 'Mcp-Session-Id': sessionId as string };

    const call = await fetch(endpoint, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'session_elicitation_probe', arguments: { mode: 'form' } },
      }),
    });
    const elicitationId = await readFirstElicitationId(call);

    const rejected = await fetch(endpoint, {
      method: 'POST',
      headers: { ...sessionHeaders, 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: elicitationId,
        result: { action: 'accept', content: { value: 'raw' } },
      }),
    });
    await rejected.body?.cancel();
    await call.body?.cancel();

    expect(rejected.status).toBe(415);
  });

  it('routes an ordinary tool cancellation POST into the in-flight handler signal', async () => {
    const client = await connect();
    const before = await readObservations(client);
    const controller = new AbortController();
    const pending = client.callTool(
      { name: 'session_cancellable_tool', arguments: { label: 'tool-cancel' } },
      CallToolResultSchema,
      { signal: controller.signal, timeout: 10_000 },
    );

    await waitForIncrease(client, 'toolStarts', before.toolStarts);
    controller.abort(new DOMException('cancel tool request', 'AbortError'));

    await expect(pending).rejects.toMatchObject({
      code: ErrorCode.RequestTimeout,
      message: expect.stringContaining('AbortError: cancel tool request'),
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
      code: ErrorCode.RequestTimeout,
      message: expect.stringContaining('AbortError: cancel resource request'),
    });
    const after = await waitForIncrease(
      client,
      'resourceCancellations',
      before.resourceCancellations,
    );
    expect(after.resourceActive).toBe(0);
  });
});

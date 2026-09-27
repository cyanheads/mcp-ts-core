/**
 * @fileoverview The multi-round-trip input seam driven through the SDK, with
 * the framework's own `createMcpServerInstance` behind every connection: stdio
 * (the SDK's `serveStdio` over an in-memory transport pair) and stateful /
 * stateless Streamable HTTP (the framework's `createHttpApp`), on both
 * protocol eras. Covers the client-capability view handlers see (#580), the
 * capability filter over `ctx.inputs` that closes the pre-answered consent-gate
 * bypass (#496), and the opt-in `requestState` sealing keyed by
 * `MCP_REQUEST_STATE_KEY` — the last through the real composition root.
 * @module tests/unit/mcp-server/inputRequired.serving.test
 */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  type CreateMessageResultWithTools,
  InMemoryTransport,
  inputRequired,
  type JSONRPCMessage,
  type McpRequestContext,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { config, resetConfig } from '@/config/index.js';
import { composeServices } from '@/core/app.js';
import { createRequestStateSealer, type RequestStateSealer } from '@/mcp-server/inputRequired.js';
import { PromptRegistry } from '@/mcp-server/prompts/prompt-registration.js';
import { ResourceRegistry } from '@/mcp-server/resources/resource-registration.js';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { createMcpServerInstance } from '@/mcp-server/server.js';
import { ToolRegistry } from '@/mcp-server/tools/tool-registration.js';
import { type AnyToolDefinition, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { createHttpApp } from '@/mcp-server/transports/http/httpTransport.js';
import { type FrameworkServerFactory, MODERN_PROTOCOL_REVISION } from '@/mcp-server/types.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { JsonRpcErrorCode, McpError, validationError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { defaultServerManifest } from '../../helpers/fixtures.js';
import { generateTestJwt } from '../../helpers/http-helpers.js';

const LEGACY_REVISION = '2025-11-25';
const KEY = 'k'.repeat(40);
const OTHER_KEY = 'z'.repeat(40);
const JWT_SECRET = 's'.repeat(40);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const Confirm = z.object({ confirm: z.boolean().describe('Proceed?') });

/** Every target a gate below actually removed, in order. */
const removed: string[] = [];

/** File contents the record gate hashes, so a same-path swap is observable. */
const files = new Map<string, string>();

/** The consent gate as the docs showed it before #496: trusts `ctx.inputs`. */
const deletePath = tool('delete_path', {
  description: 'Delete a path after confirmation.',
  input: z.object({ path: z.string().describe('Path') }),
  output: z.object({ deleted: z.string().describe('Deleted path') }),
  annotations: { destructiveHint: true },
  handler(input, ctx) {
    const answer = ctx.inputs.accepted('confirm', Confirm);
    if (!answer) {
      return ctx.requestInput({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: `Delete ${input.path}?`,
            requestedSchema: Confirm,
          }),
        },
      });
    }
    removed.push(input.path);
    return { deleted: input.path };
  },
});

const ConsentRecord = z.object({
  operation: z.string().describe('Tool the record was minted for'),
  clientId: z.string().describe('Authenticated client that was asked; empty without auth'),
  subject: z.string().describe('Authenticated subject that was asked; empty without auth'),
  target: z.string().describe('Confirmed target'),
  contentHash: z.string().describe('Hash of the content the user confirmed'),
});

const contentHashOf = (path: string) =>
  createHash('sha256')
    .update(files.get(path) ?? '')
    .digest('hex');

/**
 * The consent gate the docs now show: a server record bound to the operation,
 * the caller, the target, and its content, keyed by a random id that is the
 * only thing `requestState` carries, redeemed before anything else in the
 * handler.
 */
const deleteWithRecord = tool('delete_with_record', {
  description: 'Delete a path after confirmation, redeeming a single-use consent record.',
  input: z.object({ path: z.string().describe('Path') }),
  output: z.object({ deleted: z.string().describe('Deleted path') }),
  annotations: { destructiveHint: true },
  async handler(input, ctx) {
    const id = ctx.inputs.state();
    const record =
      typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)
        ? await ctx.state.get(`consent/${id}`, ConsentRecord)
        : null;
    if (record) await ctx.state.delete(`consent/${id}`);

    const expected = {
      operation: 'delete_with_record',
      clientId: ctx.auth?.clientId ?? '',
      subject: ctx.auth?.sub ?? '',
      target: input.path,
      contentHash: contentHashOf(input.path),
    };
    const matches = record !== null && isDeepStrictEqual(record, expected);

    const view = ctx.inputs.view('confirm');
    if (matches && view.kind === 'elicit' && view.action !== 'accept') {
      throw validationError(`Deletion ${view.action}ed.`);
    }
    const answer = matches ? ctx.inputs.accepted('confirm', Confirm) : undefined;
    if (!answer) {
      const fresh = randomUUID();
      await ctx.state.set(`consent/${fresh}`, expected, { ttl: 600 });
      return ctx.requestInput({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: `Delete ${input.path}?`,
            requestedSchema: Confirm,
          }),
        },
        requestState: fresh,
      });
    }
    if (!answer.confirm) throw validationError('Deletion not confirmed.');
    removed.push(input.path);
    return { deleted: input.path };
  },
});

/** A resource read that trusts `ctx.inputs` the way `delete_path` does. */
const unlockedDoc = resource('gated://doc', {
  name: 'gated_doc',
  description: 'A document read only after the user confirms.',
  output: z.object({ body: z.string().describe('Document body.') }),
  handler(_params, ctx) {
    const answer = ctx.inputs.accepted('confirm', Confirm);
    if (!answer) {
      return ctx.requestInput({
        inputRequests: {
          confirm: inputRequired.elicit({ message: 'Read it?', requestedSchema: Confirm }),
        },
      });
    }
    removed.push('gated://doc');
    return { body: 'secret' };
  },
});

/** Reports what a tool handler sees of the client's declared capabilities. */
const capsProbe = tool('caps_probe', {
  description: 'Reports ctx.clientCapabilities.',
  input: z.object({}),
  output: z.object({ caps: z.string().describe('ctx.clientCapabilities as JSON') }),
  handler: (_input, ctx) => ({ caps: JSON.stringify(ctx.clientCapabilities ?? null) }),
});

/** The same, from a resource handler. */
const capsDoc = resource('caps://doc', {
  name: 'caps_doc',
  description: 'Reports ctx.clientCapabilities.',
  mimeType: 'text/plain',
  handler: (_params, ctx) => JSON.stringify(ctx.clientCapabilities ?? null),
});

/** How often `roots_fallback` asked the client for its roots. */
let rootsAsked = 0;

/** #580's optional-context handler: roots when the client can answer, else fall through. */
const rootsFallback = tool('roots_fallback', {
  description: 'Resolves a working directory from the client roots when it can, else a default.',
  input: z.object({}),
  output: z.object({ source: z.string().describe('Where the directory came from') }),
  handler(_input, ctx) {
    const roots = ctx.inputs.view('roots');
    if (roots.kind === 'roots') {
      return { source: `roots:${roots.roots.map((root) => root.uri).join(',')}` };
    }
    if (ctx.clientCapabilities?.roots) {
      rootsAsked++;
      return ctx.requestInput({ inputRequests: { roots: inputRequired.listRoots() } });
    }
    return { source: 'launch-directory' };
  },
});

/** Echoes the `requestState` a round carried, or asks for one round with `round-1`. */
const stateEcho = tool('state_echo', {
  description: 'Carries state across a round without asking the client for anything.',
  input: z.object({}),
  output: z.object({ state: z.string().describe('The state this round carried.') }),
  handler(_input, ctx) {
    const state = ctx.inputs.state<string>();
    if (state === undefined) return ctx.requestInput({ requestState: 'round-1' });
    return { state };
  },
});

/** Reports which of the request's input responses reached `ctx.inputs`. */
const inputsProbe = tool('inputs_probe', {
  description: 'Reports the keys of ctx.inputs.responses.',
  input: z.object({}),
  output: z.object({ kept: z.array(z.string()).describe('Response keys that reached ctx.inputs') }),
  handler: (_input, ctx) => ({ kept: Object.keys(ctx.inputs.responses ?? {}).sort() }),
});

/** A URL-mode round: sends the user to a link and reports how they answered. */
const visitLink = tool('visit_link', {
  description: 'Sends the user to a sign-in link and reports how they answered.',
  input: z.object({}),
  output: z.object({ action: z.string().describe('How the user answered the URL prompt') }),
  handler(_input, ctx) {
    const view = ctx.inputs.view('link');
    if (view.kind === 'elicit') return { action: view.action };
    return ctx.requestInput({
      inputRequests: {
        link: inputRequired.elicitUrl({
          message: 'Sign in to continue.',
          url: 'https://example.com/sign-in',
        }),
      },
    });
  },
});

/** A tool-enabled sampling round: reports the content block types the client model answered with. */
const pickTool = tool('pick_tool', {
  description: 'Asks the client model to pick a tool and reports what it answered.',
  input: z.object({}),
  output: z.object({ blocks: z.array(z.string()).describe('Content block types of the answer') }),
  handler(_input, ctx) {
    const view = ctx.inputs.view('pick');
    if (view.kind === 'sampling') {
      const { content } = view.result;
      return { blocks: (Array.isArray(content) ? content : [content]).map((block) => block.type) };
    }
    return ctx.requestInput({
      inputRequests: {
        pick: inputRequired.createMessage({
          messages: [{ role: 'user', content: { type: 'text', text: 'Pick a tool.' } }],
          maxTokens: 50,
          tools: [{ name: 'lookup', inputSchema: { type: 'object' } }],
        }),
      },
    });
  },
});

const ALL_TOOLS = [
  deletePath,
  deleteWithRecord,
  capsProbe,
  rootsFallback,
  stateEcho,
  inputsProbe,
  visitLink,
  pickTool,
] as AnyToolDefinition[];

const ACCEPT = { confirm: { action: 'accept', content: { confirm: true } } };

/** A tool-enabled sampling answer: the model chose to call `lookup`. */
const TOOL_USE_ANSWER: CreateMessageResultWithTools = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: {} }],
  model: 'test-model',
  stopReason: 'toolUse',
};

/** One answer of each shape the filter tells apart. */
const EVERY_SHAPE = {
  form: { action: 'accept', content: { confirm: true } },
  url: { action: 'accept' },
  decline: { action: 'decline' },
  plain: { role: 'assistant', content: { type: 'text', text: 'hi' }, model: 'test-model' },
  tools: TOOL_USE_ANSWER,
};

// ---------------------------------------------------------------------------
// Server factories
// ---------------------------------------------------------------------------

/** `createMcpServerInstance` over shared registries, as `composeServices` builds them. */
function serverFactory(sealer?: RequestStateSealer): FrameworkServerFactory {
  const shared = {
    logger,
    storage: new StorageService(new InMemoryProvider()),
    ...(sealer && { requestState: sealer }),
  };
  const toolRegistry = new ToolRegistry(ALL_TOOLS, shared);
  const resourceRegistry = new ResourceRegistry([unlockedDoc, capsDoc], shared);
  const promptRegistry = new PromptRegistry([], logger, sealer);
  return async (requestContext: McpRequestContext) =>
    await createMcpServerInstance({
      config,
      era: requestContext.era,
      ...(sealer && { requestState: sealer }),
      promptRegistry,
      resourceRegistry,
      toolRegistry,
    });
}

// ---------------------------------------------------------------------------
// Wire harnesses
// ---------------------------------------------------------------------------

type RpcResponse = {
  error?: { code: number; data?: Record<string, any>; message: string };
  id: number | string;
  result?: Record<string, any>;
};

function envelope(capabilities: Record<string, unknown>) {
  return {
    'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_REVISION,
    'io.modelcontextprotocol/clientCapabilities': capabilities,
    'io.modelcontextprotocol/clientInfo': { name: 'serving-test', version: '0.0.0' },
  };
}

const cleanups: Array<() => Promise<void> | void> = [];

/** A raw JSON-RPC client over the SDK's `serveStdio`, backed by an in-memory pair. */
async function stdioConnection(factory: FrameworkServerFactory = serverFactory()) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(factory, { transport: serverSide });
  cleanups.push(() => handle.close());
  const pending = new Map<number | string, (message: RpcResponse) => void>();
  const serverRequests: string[] = [];
  let answerServerRequest: (method: string) => unknown = () => ({ action: 'cancel' });
  clientSide.onmessage = (message) => {
    const msg = message as { id?: number | string; method?: string };
    if (msg.method !== undefined && msg.id !== undefined) {
      serverRequests.push(msg.method);
      const result = answerServerRequest(msg.method);
      void clientSide.send({ jsonrpc: '2.0', id: msg.id, result } as JSONRPCMessage);
      return;
    }
    if (msg.id !== undefined) {
      pending.get(msg.id)?.(message as RpcResponse);
      pending.delete(msg.id);
    }
  };
  await clientSide.start();
  let nextId = 1;
  return {
    onServerRequest(answer: (method: string) => unknown) {
      answerServerRequest = answer;
    },
    request(method: string, params: Record<string, unknown>) {
      const id = nextId++;
      return new Promise<RpcResponse>((resolve) => {
        pending.set(id, resolve);
        void clientSide.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
      });
    },
    serverRequests,
  };
}

/** A 2025-era stdio connection whose `initialize` declared `capabilities`. */
async function legacyStdio(
  capabilities: Record<string, unknown>,
  factory: FrameworkServerFactory = serverFactory(),
) {
  const connection = await stdioConnection(factory);
  const init = await connection.request('initialize', {
    protocolVersion: LEGACY_REVISION,
    capabilities,
    clientInfo: { name: 'serving-test', version: '0.0.0' },
  });
  expect(init.result?.protocolVersion).toBe(LEGACY_REVISION);
  return connection;
}

/** A 2026-07-28 call over a stdio connection, with its own envelope. */
function modernStdioCall(
  connection: Awaited<ReturnType<typeof stdioConnection>>,
  params: Record<string, unknown>,
  capabilities: Record<string, unknown>,
  method = 'tools/call',
) {
  return connection.request(method, { ...params, _meta: envelope(capabilities) });
}

/** The official SDK client over in-memory stdio: it answers the legacy shim's requests. */
async function sdkStdioClient(
  capabilities: Record<string, object>,
  factory: FrameworkServerFactory = serverFactory(),
) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(factory, { transport: serverSide });
  cleanups.push(() => handle.close());
  const client = new Client({ name: 'serving-test', version: '0.0.0' }, { capabilities });
  cleanups.push(() => client.close());
  return { client, connect: () => client.connect(clientSide) };
}

/** The slice of the framework's Hono app these tests drive. */
type HttpApp = { request(input: string, init?: RequestInit): Response | Promise<Response> };

/** Framework HTTP app in the given session mode, over `factory`. */
async function httpApp(
  mode: 'stateful' | 'stateless',
  factory: FrameworkServerFactory = serverFactory(),
  env: Record<string, string> = {},
): Promise<HttpApp> {
  resetConfig({ MCP_TRANSPORT_TYPE: 'http', MCP_SESSION_MODE: mode, ...env });
  const { app, close } = await createHttpApp(
    factory,
    requestContextService.createRequestContext({ operation: 'inputRequired.serving' }),
    defaultServerManifest,
  );
  cleanups.push(close);
  return app;
}

/** The single JSON-RPC response in a JSON or SSE body. */
function responseOf(body: string, id: number | string): RpcResponse {
  if (body.trimStart().startsWith('{')) return JSON.parse(body);
  const frames = body
    .split('\n')
    .filter((line) => line.startsWith('data:') && line.slice(5).trim().length > 0)
    .map((line) => JSON.parse(line.slice(5)) as RpcResponse);
  const found = frames.find((frame) => frame.id === id && ('result' in frame || 'error' in frame));
  if (!found) throw new Error(`No response for id ${id} in: ${body}`);
  return found;
}

const HTTP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
} as const;

/** A raw 2025-era HTTP client: `initialize` (and its session, when stateful), then calls. */
async function legacyHttp(app: HttpApp, capabilities: Record<string, unknown>) {
  const init = await app.request('http://localhost/mcp', {
    method: 'POST',
    headers: HTTP_HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LEGACY_REVISION,
        capabilities,
        clientInfo: { name: 'serving-test', version: '0.0.0' },
      },
    }),
  });
  const session = init.headers.get('mcp-session-id');
  await init.text();
  const headers = {
    ...HTTP_HEADERS,
    'mcp-protocol-version': LEGACY_REVISION,
    ...(session && { 'mcp-session-id': session }),
  };
  if (session) {
    await (
      await app.request('http://localhost/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      })
    ).text();
  }
  let nextId = 2;
  return {
    async request(method: string, params: Record<string, unknown>) {
      const id = nextId++;
      const res = await app.request('http://localhost/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      return responseOf(await res.text(), id);
    },
  };
}

/** One 2026-07-28 request over HTTP, carrying its own envelope. */
async function modernHttp(
  app: HttpApp,
  method: string,
  params: Record<string, unknown>,
  capabilities: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  const name = typeof params.name === 'string' ? params.name : (params.uri as string | undefined);
  const res = await app.request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      ...HTTP_HEADERS,
      'mcp-protocol-version': MODERN_PROTOCOL_REVISION,
      'mcp-method': method,
      ...(name && { 'mcp-name': name }),
      ...extraHeaders,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method,
      params: { ...params, _meta: envelope(capabilities) },
    }),
  });
  return responseOf(await res.text(), 7);
}

/** A tool result's error envelope, or `undefined` on success. */
function toolError(response: RpcResponse) {
  return response.result?.structuredContent?.error as
    | { code: number; data?: Record<string, any>; message: string }
    | undefined;
}

/** What `caps_probe` reported, parsed back. */
function reportedCaps(response: RpcResponse): unknown {
  expect(response.error, JSON.stringify(response)).toBeUndefined();
  return JSON.parse(response.result?.structuredContent?.caps as string);
}

/** The `-32602 invalid_request_state` refusal the SDK answers a failed verification with. */
const INVALID_STATE = {
  code: JsonRpcErrorCode.InvalidParams,
  data: { reason: 'invalid_request_state' },
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  removed.length = 0;
  files.clear();
  rootsAsked = 0;
});

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()?.();
    } catch {
      // Already closed.
    }
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetConfig();
});

// ---------------------------------------------------------------------------
// #580 — ctx.clientCapabilities
// ---------------------------------------------------------------------------

describe('ctx.clientCapabilities (#580)', () => {
  describe('stdio', () => {
    it.each([
      ['declared nothing', {}, {}],
      ['declared form elicitation', { elicitation: { form: {} } }, { elicitation: { form: {} } }],
      ['declared bare elicitation', { elicitation: {} }, { elicitation: { form: {} } }],
      [
        'declared an extension',
        { extensions: { 'io.modelcontextprotocol/ui': {} } },
        { extensions: { 'io.modelcontextprotocol/ui': {} } },
      ],
    ])(
      '2025-era: the SDK-parsed initialize value when the client %s',
      async (_label, declared, parsed) => {
        const connection = await legacyStdio(declared);

        const response = await connection.request('tools/call', {
          name: 'caps_probe',
          arguments: {},
        });

        expect(reportedCaps(response)).toEqual(parsed);
      },
    );

    it('2025-era: an envelope capabilities key on the call does not change it', async () => {
      const connection = await legacyStdio({ roots: {} });

      const response = await connection.request('tools/call', {
        name: 'caps_probe',
        arguments: {},
        _meta: { 'io.modelcontextprotocol/clientCapabilities': { elicitation: {}, sampling: {} } },
      });

      expect(reportedCaps(response)).toEqual({ roots: {} });
    });

    it('2026-07-28: the envelope value as sent, per request on one connection', async () => {
      const connection = await stdioConnection();

      const first = await modernStdioCall(connection, { name: 'caps_probe', arguments: {} }, {});
      const second = await modernStdioCall(
        connection,
        { name: 'caps_probe', arguments: {} },
        { sampling: {} },
      );
      const bare = await modernStdioCall(
        connection,
        { name: 'caps_probe', arguments: {} },
        { elicitation: {} },
      );

      expect(reportedCaps(first)).toEqual({});
      expect(reportedCaps(second)).toEqual({ sampling: {} });
      expect(reportedCaps(bare)).toEqual({ elicitation: {} });
    });

    it('a resource handler sees the same value as a tool handler, on both eras', async () => {
      const legacy = await legacyStdio({ roots: {} });
      const legacyRead = await legacy.request('resources/read', { uri: 'caps://doc' });
      const modern = await stdioConnection();
      const modernRead = await modernStdioCall(
        modern,
        { uri: 'caps://doc' },
        { sampling: {} },
        'resources/read',
      );

      expect(JSON.parse(legacyRead.result?.contents[0].text)).toEqual({ roots: {} });
      expect(JSON.parse(modernRead.result?.contents[0].text)).toEqual({ sampling: {} });
    });
  });

  describe.each(['stateful', 'stateless'] as const)('%s HTTP', (mode) => {
    it(`2025-era: ${mode === 'stateful' ? 'the initialize value' : 'undefined — no view exists'}`, async () => {
      const app = await httpApp(mode);
      const client = await legacyHttp(app, { roots: {} });

      const response = await client.request('tools/call', { name: 'caps_probe', arguments: {} });

      expect(reportedCaps(response)).toEqual(mode === 'stateful' ? { roots: {} } : null);
    });

    it('2025-era: an envelope capabilities key on the call does not change it', async () => {
      const app = await httpApp(mode);
      const client = await legacyHttp(app, { roots: {} });

      const response = await client.request('tools/call', {
        name: 'caps_probe',
        arguments: {},
        _meta: { 'io.modelcontextprotocol/clientCapabilities': { elicitation: {} } },
      });

      expect(reportedCaps(response)).toEqual(mode === 'stateful' ? { roots: {} } : null);
    });

    it('2026-07-28: the request envelope value', async () => {
      const app = await httpApp(mode);

      const declared = await modernHttp(
        app,
        'tools/call',
        { name: 'caps_probe', arguments: {} },
        { sampling: {} },
      );
      const empty = await modernHttp(app, 'tools/call', { name: 'caps_probe', arguments: {} }, {});

      expect(reportedCaps(declared)).toEqual({ sampling: {} });
      expect(reportedCaps(empty)).toEqual({});
    });
  });
});

describe('an optional-context handler falls through when roots is undeclared (#580)', () => {
  it('2025-era stdio: no roots declared — the next source, no error, nothing sent', async () => {
    const connection = await legacyStdio({ elicitation: {} });

    const response = await connection.request('tools/call', {
      name: 'roots_fallback',
      arguments: {},
    });

    expect(response.result?.structuredContent).toEqual({ source: 'launch-directory' });
    expect(connection.serverRequests).toEqual([]);
  });

  it('2025-era stdio: roots declared — asks once through the shim and completes', async () => {
    const { client, connect } = await sdkStdioClient({ roots: {} });
    client.setRequestHandler('roots/list', () => ({ roots: [{ uri: 'file:///work' }] }));
    await connect();

    const result = await client.callTool({ name: 'roots_fallback', arguments: {} });

    expect(result.structuredContent).toEqual({ source: 'roots:file:///work' });
    expect(rootsAsked).toBe(1);
  });

  it('2026-07-28 stdio: no roots declared — the next source, where a request would be -32021', async () => {
    const connection = await stdioConnection();

    const response = await modernStdioCall(
      connection,
      { name: 'roots_fallback', arguments: {} },
      { elicitation: {} },
    );

    expect(response.result?.structuredContent).toEqual({ source: 'launch-directory' });
  });

  it('2026-07-28 stdio: roots declared — asks, then completes on the retry without asking again', async () => {
    const connection = await stdioConnection();
    const caps = { roots: {} };

    const first = await modernStdioCall(
      connection,
      { name: 'roots_fallback', arguments: {} },
      caps,
    );
    expect(first.result).toMatchObject({
      resultType: 'input_required',
      inputRequests: { roots: { method: 'roots/list' } },
    });

    const retry = await modernStdioCall(
      connection,
      {
        name: 'roots_fallback',
        arguments: {},
        inputResponses: { roots: { roots: [{ uri: 'file:///work' }] } },
      },
      caps,
    );

    expect(retry.result?.structuredContent).toEqual({ source: 'roots:file:///work' });
    expect(rootsAsked).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #496 — the capability filter over ctx.inputs
// ---------------------------------------------------------------------------

describe('a pre-answered first call from a client that declared no elicitation (#496)', () => {
  describe('stdio', () => {
    it('2025-era: refused as client_capability_missing, nothing deleted, nothing sent', async () => {
      const connection = await legacyStdio({});

      const response = await connection.request('tools/call', {
        name: 'delete_path',
        arguments: { path: '/tmp/x' },
        inputResponses: ACCEPT,
      });

      expect(removed).toEqual([]);
      expect(toolError(response)).toMatchObject({
        code: JsonRpcErrorCode.InvalidRequest,
        data: { reason: 'client_capability_missing' },
      });
      expect(connection.serverRequests).toEqual([]);
    });

    it('2025-era: a hand-built requestState alongside changes nothing', async () => {
      const connection = await legacyStdio({ sampling: {} });

      const response = await connection.request('tools/call', {
        name: 'delete_path',
        arguments: { path: '/tmp/x' },
        inputResponses: ACCEPT,
        requestState: JSON.stringify({ path: '/etc/passwd', confirmed: true }),
      });

      expect(removed).toEqual([]);
      expect(toolError(response)?.data?.reason).toBe('client_capability_missing');
    });

    it('2026-07-28: refused with -32021, nothing deleted', async () => {
      const connection = await stdioConnection();

      const response = await modernStdioCall(
        connection,
        { name: 'delete_path', arguments: { path: '/tmp/y' }, inputResponses: ACCEPT },
        { sampling: {}, roots: {} },
      );

      expect(removed).toEqual([]);
      expect(response.error?.code).toBe(-32021);
    });

    it('2025-era resource read: refused, nothing read', async () => {
      const connection = await legacyStdio({});

      const response = await connection.request('resources/read', {
        uri: 'gated://doc',
        inputResponses: ACCEPT,
      });

      expect(removed).toEqual([]);
      expect(response.error).toMatchObject({
        code: JsonRpcErrorCode.InvalidRequest,
        data: { reason: 'client_capability_missing' },
      });
    });

    it('2026-07-28 resource read: refused with -32021, nothing read', async () => {
      const connection = await stdioConnection();

      const response = await modernStdioCall(
        connection,
        { uri: 'gated://doc', inputResponses: ACCEPT },
        {},
        'resources/read',
      );

      expect(removed).toEqual([]);
      expect(response.error?.code).toBe(-32021);
    });
  });

  describe.each(['stateful', 'stateless'] as const)('%s HTTP', (mode) => {
    it('2025-era: refused as client_capability_missing, nothing deleted', async () => {
      const app = await httpApp(mode);
      const client = await legacyHttp(app, {});

      const response = await client.request('tools/call', {
        name: 'delete_path',
        arguments: { path: '/tmp/h' },
        inputResponses: ACCEPT,
      });

      expect(removed).toEqual([]);
      expect(toolError(response)?.data?.reason).toBe('client_capability_missing');
    });

    it('2026-07-28: refused with -32021, nothing deleted', async () => {
      const app = await httpApp(mode);

      const response = await modernHttp(
        app,
        'tools/call',
        { name: 'delete_path', arguments: { path: '/tmp/m' }, inputResponses: ACCEPT },
        {},
      );

      expect(removed).toEqual([]);
      expect(response.error?.code).toBe(-32021);
    });
  });
});

describe('legitimate rounds still complete (#496 positive controls)', () => {
  it('2025-era stdio: the legacy shim round trip deletes once', async () => {
    const { client, connect } = await sdkStdioClient({ elicitation: { form: {} } });
    const asked: string[] = [];
    client.setRequestHandler('elicitation/create', (request) => {
      asked.push((request.params as { message: string }).message);
      return { action: 'accept', content: { confirm: true } };
    });
    await connect();

    const result = await client.callTool({ name: 'delete_path', arguments: { path: '/tmp/ok' } });

    expect(result.structuredContent).toEqual({ deleted: '/tmp/ok' });
    expect(asked).toEqual(['Delete /tmp/ok?']);
    expect(removed).toEqual(['/tmp/ok']);
  });

  it('2025-era stateful HTTP: the legacy shim round trip deletes once', async () => {
    const app = await httpApp('stateful');
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: async (url, init) => await app.request(String(url), init),
    });
    const client = new Client(
      { name: 'serving-test', version: '0.0.0' },
      { capabilities: { elicitation: {} } },
    );
    client.setRequestHandler('elicitation/create', () => ({
      action: 'accept',
      content: { confirm: true },
    }));
    await client.connect(transport);
    cleanups.push(() => client.close());

    const result = await client.callTool({ name: 'delete_path', arguments: { path: '/tmp/http' } });

    expect(result.structuredContent).toEqual({ deleted: '/tmp/http' });
    expect(removed).toEqual(['/tmp/http']);
  });

  it('2026-07-28 stdio: a capable client asks, then retries with the answer', async () => {
    const connection = await stdioConnection();
    const caps = { elicitation: { form: {} } };

    const first = await modernStdioCall(
      connection,
      { name: 'delete_path', arguments: { path: '/tmp/ok2' } },
      caps,
    );
    expect(first.result?.resultType).toBe('input_required');
    expect(removed).toEqual([]);

    const retry = await modernStdioCall(
      connection,
      { name: 'delete_path', arguments: { path: '/tmp/ok2' }, inputResponses: ACCEPT },
      caps,
    );

    expect(retry.result?.structuredContent).toEqual({ deleted: '/tmp/ok2' });
    expect(removed).toEqual(['/tmp/ok2']);
  });

  it.each(['stateful', 'stateless'] as const)(
    '2026-07-28 %s HTTP: a capable client retries with the answer',
    async (mode) => {
      const app = await httpApp(mode);
      const caps = { elicitation: {} };

      const first = await modernHttp(
        app,
        'tools/call',
        { name: 'delete_path', arguments: { path: '/tmp/ok3' } },
        caps,
      );
      expect(first.result?.resultType).toBe('input_required');

      const retry = await modernHttp(
        app,
        'tools/call',
        { name: 'delete_path', arguments: { path: '/tmp/ok3' }, inputResponses: ACCEPT },
        caps,
      );

      expect(retry.result?.structuredContent).toEqual({ deleted: '/tmp/ok3' });
      expect(removed).toEqual(['/tmp/ok3']);
    },
  );
});

// ---------------------------------------------------------------------------
// #496 — the filter applies the gate's mode-level requirements
// ---------------------------------------------------------------------------

describe('the filter asks of an answer what the gate asks of its request (#496)', () => {
  const MATRIX = [
    ['bare elicitation, read as form', { elicitation: {} }, ['decline', 'form', 'url']],
    ['elicitation.form', { elicitation: { form: {} } }, ['decline', 'form', 'url']],
    ['elicitation.url only', { elicitation: { url: {} } }, ['decline', 'url']],
    ['sampling without tools', { sampling: {} }, ['plain']],
    ['sampling.tools', { sampling: { tools: {} } }, ['plain', 'tools']],
  ] as const;

  describe.each(MATRIX)('a client that declared %s', (_label, declared, kept) => {
    it('2025-era stdio: keeps only the answers its modes cover', async () => {
      const connection = await legacyStdio(declared);

      const response = await connection.request('tools/call', {
        name: 'inputs_probe',
        arguments: {},
        inputResponses: EVERY_SHAPE,
      });

      expect(response.result?.structuredContent).toEqual({ kept });
    });

    it('2026-07-28 stdio: keeps only the answers its modes cover', async () => {
      const connection = await stdioConnection();

      const response = await modernStdioCall(
        connection,
        { name: 'inputs_probe', arguments: {}, inputResponses: EVERY_SHAPE },
        declared,
      );

      expect(response.result?.structuredContent).toEqual({ kept });
    });
  });

  describe('a url-only client pre-answers a form consent gate', () => {
    const URL_ONLY = { elicitation: { url: {} } };

    it('2025-era stdio: refused as client_capability_missing, nothing deleted, nothing sent', async () => {
      const connection = await legacyStdio(URL_ONLY);

      const response = await connection.request('tools/call', {
        name: 'delete_path',
        arguments: { path: '/tmp/url-only' },
        inputResponses: ACCEPT,
      });

      expect(removed).toEqual([]);
      expect(toolError(response)).toMatchObject({
        code: JsonRpcErrorCode.InvalidRequest,
        data: { reason: 'client_capability_missing' },
      });
      expect(connection.serverRequests).toEqual([]);
    });

    it('2026-07-28 stdio: refused with -32021, nothing deleted', async () => {
      const connection = await stdioConnection();

      const response = await modernStdioCall(
        connection,
        { name: 'delete_path', arguments: { path: '/tmp/url-only' }, inputResponses: ACCEPT },
        URL_ONLY,
      );

      expect(removed).toEqual([]);
      expect(response.error?.code).toBe(-32021);
    });

    it('2025-era stateful HTTP: refused as client_capability_missing, nothing deleted', async () => {
      const app = await httpApp('stateful');
      const client = await legacyHttp(app, URL_ONLY);

      const response = await client.request('tools/call', {
        name: 'delete_path',
        arguments: { path: '/tmp/url-only' },
        inputResponses: ACCEPT,
      });

      expect(removed).toEqual([]);
      expect(toolError(response)?.data?.reason).toBe('client_capability_missing');
    });

    it.each(['stateful', 'stateless'] as const)(
      '2026-07-28 %s HTTP: refused with -32021, nothing deleted',
      async (mode) => {
        const app = await httpApp(mode);

        const response = await modernHttp(
          app,
          'tools/call',
          { name: 'delete_path', arguments: { path: '/tmp/url-only' }, inputResponses: ACCEPT },
          URL_ONLY,
        );

        expect(removed).toEqual([]);
        expect(response.error?.code).toBe(-32021);
      },
    );
  });

  describe('a client without sampling.tools pre-answers a tool-enabled sampling round', () => {
    const NO_TOOLS = { sampling: {} };

    it('2025-era stdio: the answer never arrives, and the request is refused', async () => {
      const connection = await legacyStdio(NO_TOOLS);

      const response = await connection.request('tools/call', {
        name: 'pick_tool',
        arguments: {},
        inputResponses: { pick: TOOL_USE_ANSWER },
      });

      expect(toolError(response)?.data?.reason).toBe('client_capability_missing');
      expect(connection.serverRequests).toEqual([]);
    });

    it('2026-07-28 stdio: the answer never arrives, and the request fails with -32021', async () => {
      const connection = await stdioConnection();

      const response = await modernStdioCall(
        connection,
        { name: 'pick_tool', arguments: {}, inputResponses: { pick: TOOL_USE_ANSWER } },
        NO_TOOLS,
      );

      expect(response.error?.code).toBe(-32021);
    });
  });

  describe('positive controls: rounds the declared modes cover still complete', () => {
    it('2025-era stdio: a url-mode round through the shim', async () => {
      const { client, connect } = await sdkStdioClient({ elicitation: { url: {} } });
      const modes: unknown[] = [];
      client.setRequestHandler('elicitation/create', (request) => {
        modes.push((request.params as { mode?: string }).mode);
        return { action: 'accept' };
      });
      await connect();

      const result = await client.callTool({ name: 'visit_link', arguments: {} });

      expect(result.structuredContent).toEqual({ action: 'accept' });
      expect(modes).toEqual(['url']);
    });

    it('2026-07-28 stdio: a url-mode round, asked then answered on the retry', async () => {
      const connection = await stdioConnection();
      const caps = { elicitation: { url: {} } };

      const first = await modernStdioCall(connection, { name: 'visit_link', arguments: {} }, caps);
      expect(first.result).toMatchObject({
        resultType: 'input_required',
        inputRequests: { link: { method: 'elicitation/create', params: { mode: 'url' } } },
      });

      const retry = await modernStdioCall(
        connection,
        { name: 'visit_link', arguments: {}, inputResponses: { link: { action: 'accept' } } },
        caps,
      );

      expect(retry.result?.structuredContent).toEqual({ action: 'accept' });
    });

    it('2025-era stdio: a tool-enabled sampling round through the shim', async () => {
      const { client, connect } = await sdkStdioClient({ sampling: { tools: {} } });
      client.setRequestHandler('sampling/createMessage', () => TOOL_USE_ANSWER);
      await connect();

      const result = await client.callTool({ name: 'pick_tool', arguments: {} });

      expect(result.structuredContent).toEqual({ blocks: ['tool_use'] });
    });

    it('2026-07-28 stdio: a tool-enabled sampling round, asked then answered on the retry', async () => {
      const connection = await stdioConnection();
      const caps = { sampling: { tools: {} } };

      const first = await modernStdioCall(connection, { name: 'pick_tool', arguments: {} }, caps);
      expect(first.result?.resultType).toBe('input_required');

      const retry = await modernStdioCall(
        connection,
        { name: 'pick_tool', arguments: {}, inputResponses: { pick: TOOL_USE_ANSWER } },
        caps,
      );

      expect(retry.result?.structuredContent).toEqual({ blocks: ['tool_use'] });
    });
  });
});

// ---------------------------------------------------------------------------
// MCP_REQUEST_STATE_KEY — through the composition root
// ---------------------------------------------------------------------------

/** `composeServices` under `env`, with its rate limiter released on cleanup. */
async function composed(env: Record<string, string | undefined>) {
  resetConfig(env);
  const app = await composeServices({ tools: ALL_TOOLS });
  cleanups.push(() => app.coreServices.rateLimiter.dispose());
  return app;
}

/** Every logger call from here on, as `[level, serialized args]`. */
function recordLogs() {
  const recorded: Array<[string, string]> = [];
  for (const level of ['debug', 'info', 'notice', 'warning', 'error'] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      recorded.push([level, JSON.stringify(args, (_k, v) => (v instanceof Error ? v.message : v))]);
    });
  }
  return recorded;
}

/** Round one of `state_echo` on a fresh modern stdio connection to `factory`. */
async function mintedState(factory: FrameworkServerFactory) {
  const connection = await stdioConnection(factory);
  const first = await modernStdioCall(connection, { name: 'state_echo', arguments: {} }, {});
  expect(first.result?.resultType).toBe('input_required');
  return first.result?.requestState as string;
}

describe('MCP_REQUEST_STATE_KEY unset', () => {
  it.each(['2025-era', '2026-07-28'] as const)(
    '%s: no verifier runs, and the handler reads the raw wire string',
    async (era) => {
      const { createServer } = await composed({ MCP_REQUEST_STATE_KEY: undefined });
      const connection =
        era === '2025-era'
          ? await legacyStdio({}, createServer)
          : await stdioConnection(createServer);
      const params = { name: 'state_echo', arguments: {}, requestState: 'hand-built' };

      const response =
        era === '2025-era'
          ? await connection.request('tools/call', params)
          : await modernStdioCall(connection, params, {});

      expect(response.result?.structuredContent).toEqual({ state: 'hand-built' });
    },
  );

  it('returns a handler state to the client exactly as written', async () => {
    const { createServer } = await composed({ MCP_REQUEST_STATE_KEY: undefined });

    await expect(mintedState(createServer)).resolves.toBe('round-1');
  });

  it('treats an empty value as unset', async () => {
    const { createServer } = await composed({ MCP_REQUEST_STATE_KEY: '' });

    await expect(mintedState(createServer)).resolves.toBe('round-1');
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('logs nothing about sealing at startup when the key is %s', async (_label, value) => {
    const recorded = recordLogs();

    await composed({ MCP_REQUEST_STATE_KEY: value });

    expect(recorded.filter(([, text]) => text.includes('MCP_REQUEST_STATE_KEY'))).toEqual([]);
  });
});

describe('MCP_REQUEST_STATE_KEY set', () => {
  it('fails startup on a key shorter than 32 bytes, naming the variable and not the key', async () => {
    resetConfig({ MCP_REQUEST_STATE_KEY: 'short-secret-value' });

    const error = await composeServices({ tools: ALL_TOOLS }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      data: { variable: 'MCP_REQUEST_STATE_KEY' },
    });
    expect((error as McpError).message).toContain('MCP_REQUEST_STATE_KEY');
    expect(JSON.stringify({ ...(error as McpError) })).not.toContain('short-secret-value');
    expect((error as McpError).message).not.toContain('short-secret-value');
  });

  it('logs one info record at startup naming the variable, never the key', async () => {
    const recorded = recordLogs();

    await composed({ MCP_REQUEST_STATE_KEY: KEY });

    const sealing = recorded.filter(([, text]) => text.includes('MCP_REQUEST_STATE_KEY'));
    expect(sealing.map(([level]) => level)).toEqual(['info']);
    expect(recorded.map(([, text]) => text).join('\n')).not.toContain(KEY);
  });

  it('seals a round and verifies it back to the handler’s own string (2026-07-28)', async () => {
    const { createServer } = await composed({ MCP_REQUEST_STATE_KEY: KEY });
    const connection = await stdioConnection(createServer);

    const first = await modernStdioCall(connection, { name: 'state_echo', arguments: {} }, {});
    const sealed = first.result?.requestState as string;
    const retry = await modernStdioCall(
      connection,
      { name: 'state_echo', arguments: {}, requestState: sealed },
      {},
    );

    expect(sealed).toMatch(/^v1\./);
    expect(retry.result?.structuredContent).toEqual({ state: 'round-1' });
  });

  it('carries a sealed state through the legacy shim, and the consent record deletes once (2025-era)', async () => {
    const { createServer } = await composed({ MCP_REQUEST_STATE_KEY: KEY });
    const { client, connect } = await sdkStdioClient({ elicitation: {} }, createServer);
    client.setRequestHandler('elicitation/create', () => ({
      action: 'accept',
      content: { confirm: true },
    }));
    await connect();

    const result = await client.callTool({
      name: 'delete_with_record',
      arguments: { path: '/tmp/r' },
    });

    expect(result.structuredContent).toEqual({ deleted: '/tmp/r' });
    expect(removed).toEqual(['/tmp/r']);
  });

  describe('refuses before the handler as -32602 invalid_request_state', () => {
    it.each([
      ['a hand-built string', async () => 'round-1'],
      ['a forged v1 envelope', async () => 'v1.eyJwIjoicm91bmQtMSIsImV4cCI6OTk5OTk5OTk5OX0.AAAA'],
      [
        'a tampered sealed state',
        async (factory: FrameworkServerFactory) => {
          const sealed = await mintedState(factory);
          const [, body, mac] = sealed.split('.');
          const payload = JSON.parse(Buffer.from(body as string, 'base64url').toString());
          payload.p = 'round-2';
          return `v1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}`;
        },
      ],
      [
        'a state sealed under another key',
        async () => await mintedState(serverFactory(createRequestStateSealer(OTHER_KEY))),
      ],
    ])('%s (2026-07-28 stdio)', async (_label, make) => {
      const { createServer } = await composed({ MCP_REQUEST_STATE_KEY: KEY });
      const state = await make(createServer);
      const connection = await stdioConnection(createServer);

      const response = await modernStdioCall(
        connection,
        { name: 'state_echo', arguments: {}, requestState: state },
        {},
      );

      expect(response.result).toBeUndefined();
      expect(response.error).toMatchObject(INVALID_STATE);
    });

    it('a hand-built string (2025-era stdio)', async () => {
      const { createServer } = await composed({ MCP_REQUEST_STATE_KEY: KEY });
      const connection = await legacyStdio({}, createServer);

      const response = await connection.request('tools/call', {
        name: 'state_echo',
        arguments: {},
        requestState: 'round-1',
      });

      expect(response.error).toMatchObject(INVALID_STATE);
    });

    it('a state past its 900 s lifetime', async () => {
      vi.useFakeTimers({ now: new Date('2026-09-26T12:00:00Z'), toFake: ['Date'] });
      const { createServer } = await composed({ MCP_REQUEST_STATE_KEY: KEY });
      const sealed = await mintedState(createServer);
      const connection = await stdioConnection(createServer);
      const retry = () =>
        modernStdioCall(
          connection,
          { name: 'state_echo', arguments: {}, requestState: sealed },
          {},
        );

      vi.setSystemTime(new Date('2026-09-26T12:14:59Z'));
      expect((await retry()).result?.structuredContent).toEqual({ state: 'round-1' });

      vi.setSystemTime(new Date('2026-09-26T12:15:02Z'));
      expect((await retry()).error).toMatchObject(INVALID_STATE);
    });

    it.each(['stateful', 'stateless'] as const)(
      'a hand-built string over %s HTTP (2026-07-28)',
      async (mode) => {
        const { createServer } = await composed({ MCP_REQUEST_STATE_KEY: KEY });
        const app = await httpApp(mode, createServer, { MCP_REQUEST_STATE_KEY: KEY });

        const response = await modernHttp(
          app,
          'tools/call',
          { name: 'state_echo', arguments: {}, requestState: 'round-1' },
          {},
        );

        expect(response.error).toMatchObject(INVALID_STATE);
      },
    );
  });

  it('logs nothing that carries the key while refusing', async () => {
    const recorded = recordLogs();
    const { createServer } = await composed({ MCP_REQUEST_STATE_KEY: KEY });
    const connection = await stdioConnection(createServer);

    const response = await modernStdioCall(
      connection,
      { name: 'state_echo', arguments: {}, requestState: 'forged' },
      {},
    );

    expect(response.error).toMatchObject(INVALID_STATE);
    expect(JSON.stringify(response)).not.toContain(KEY);
    expect(recorded.map(([, text]) => text).join('\n')).not.toContain(KEY);
  });

  it('verifies a round minted by one instance on another holding the same key', async () => {
    const minter = await composed({ MCP_REQUEST_STATE_KEY: KEY });
    const sealed = await mintedState(minter.createServer);
    const verifier = await composed({ MCP_REQUEST_STATE_KEY: KEY });
    const connection = await stdioConnection(verifier.createServer);

    const retry = await modernStdioCall(
      connection,
      { name: 'state_echo', arguments: {}, requestState: sealed },
      {},
    );

    expect(retry.result?.structuredContent).toEqual({ state: 'round-1' });
  });

  describe('binds a state to the principal that minted it (stateless HTTP, jwt)', () => {
    const token = (clientId: string, sub: string, tid: string) =>
      generateTestJwt({ client_id: clientId, sub, tid, scp: ['mcp'] }, JWT_SECRET);
    const env = {
      MCP_REQUEST_STATE_KEY: KEY,
      MCP_AUTH_MODE: 'jwt',
      MCP_AUTH_SECRET_KEY: JWT_SECRET,
    };

    async function roundTrip(minter: string, retrier: string) {
      const { createServer } = await composed({ ...env, MCP_TRANSPORT_TYPE: 'http' });
      const app = await httpApp('stateless', createServer, env);
      const first = await modernHttp(
        app,
        'tools/call',
        { name: 'state_echo', arguments: {} },
        {},
        { authorization: `Bearer ${minter}` },
      );
      expect(first.result?.requestState).toMatch(/^v1\./);
      return await modernHttp(
        app,
        'tools/call',
        { name: 'state_echo', arguments: {}, requestState: first.result?.requestState },
        {},
        { authorization: `Bearer ${retrier}` },
      );
    }

    it('the same principal verifies', async () => {
      const alice = token('client-a', 'alice', 't1');

      const retry = await roundTrip(alice, alice);

      expect(retry.result?.structuredContent).toEqual({ state: 'round-1' });
    });

    it.each([
      ['another client', token('client-b', 'alice', 't1')],
      ['another subject', token('client-a', 'bob', 't1')],
      ['another tenant', token('client-a', 'alice', 't2')],
    ])('%s is refused', async (_label, other) => {
      const retry = await roundTrip(token('client-a', 'alice', 't1'), other);

      expect(retry.error).toMatchObject(INVALID_STATE);
    });
  });

  describe('a replayed sealed state against the consent record', () => {
    it('2026-07-28 stdio: deletes once, then asks again', async () => {
      const { createServer } = await composed({ MCP_REQUEST_STATE_KEY: KEY });
      const connection = await stdioConnection(createServer);
      const caps = { elicitation: {} };
      const call = (requestState?: string) =>
        modernStdioCall(
          connection,
          {
            name: 'delete_with_record',
            arguments: { path: '/tmp/once' },
            ...(requestState && { requestState, inputResponses: ACCEPT }),
          },
          caps,
        );

      const first = await call();
      const sealed = first.result?.requestState as string;
      const confirmed = await call(sealed);
      const replayed = await call(sealed);

      expect(confirmed.result?.structuredContent).toEqual({ deleted: '/tmp/once' });
      expect(replayed.result?.resultType).toBe('input_required');
      expect(removed).toEqual(['/tmp/once']);
    });

    it('stateless HTTP: a retry on another per-request instance redeems once', async () => {
      const { createServer } = await composed({ MCP_REQUEST_STATE_KEY: KEY });
      const app = await httpApp('stateless', createServer, { MCP_REQUEST_STATE_KEY: KEY });
      const caps = { elicitation: {} };
      const call = (requestState?: string) =>
        modernHttp(
          app,
          'tools/call',
          {
            name: 'delete_with_record',
            arguments: { path: '/tmp/once' },
            ...(requestState && { requestState, inputResponses: ACCEPT }),
          },
          caps,
        );

      const sealed = (await call()).result?.requestState as string;
      await call(sealed);
      const replayed = await call(sealed);

      expect(replayed.result?.resultType).toBe('input_required');
      expect(removed).toEqual(['/tmp/once']);
    });

    it('a content change between the prompt and the answer asks again', async () => {
      const { createServer } = await composed({ MCP_REQUEST_STATE_KEY: KEY });
      const connection = await stdioConnection(createServer);
      const caps = { elicitation: {} };
      files.set('/tmp/doc', 'version one');

      const first = await modernStdioCall(
        connection,
        { name: 'delete_with_record', arguments: { path: '/tmp/doc' } },
        caps,
      );
      files.set('/tmp/doc', 'version two');
      const answered = await modernStdioCall(
        connection,
        {
          name: 'delete_with_record',
          arguments: { path: '/tmp/doc' },
          requestState: first.result?.requestState,
          inputResponses: ACCEPT,
        },
        caps,
      );

      expect(answered.result?.resultType).toBe('input_required');
      expect(removed).toEqual([]);
    });
  });
});

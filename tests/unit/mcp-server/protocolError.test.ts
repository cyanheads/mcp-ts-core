/**
 * @fileoverview Tests for the SDK `ProtocolError` a tool, prompt, or resource
 * handler throws: what a client of each protocol era receives from each
 * surface, read off the wire of a server built as `createApp` builds it and
 * compared with what the SDK alone answers for the same throw.
 * @module tests/mcp-server/protocolError.test
 */

import { UrlElicitationRequiredError as ClientUrlElicitationRequiredError } from '@modelcontextprotocol/client';
import {
  InMemoryTransport,
  type JSONRPCMessage,
  McpServer,
  ProtocolError,
  ResourceNotFoundError,
  ResourceTemplate,
  UrlElicitationRequiredError,
} from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { resolveDeclaredFailure } from '@/core/context.js';
import { prompt } from '@/mcp-server/prompts/utils/promptDefinition.js';
import { fromProtocolError, urlElicitationHandback } from '@/mcp-server/protocolError.js';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { createHttpApp } from '@/mcp-server/transports/http/httpTransport.js';
import { MODERN_PROTOCOL_REVISION } from '@/mcp-server/types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { asRequestCancelled } from '@/utils/internal/error-handler/errorHandler.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { TELEMETRY_LOG_MESSAGES } from '@/utils/internal/telemetryMessages.js';
import {
  type FixtureSet,
  LATEST_2025_REVISION,
  openLegacySession,
  openModernApp,
  type WireResponse,
} from '../../contract/harness.js';
import { defaultServerManifest } from '../../helpers/fixtures.js';

const elicitations = [
  {
    mode: 'url' as const,
    message: 'Sign in to continue.',
    url: 'https://example.com/sign-in',
    elicitationId: 'e1',
  },
];

/** A framework-generated request id. */
const REQUEST_ID = /^[A-Z0-9]{5}-[A-Z0-9]{5}$/;

// ---------------------------------------------------------------------------
// The handback, at its seam
// ---------------------------------------------------------------------------

describe('urlElicitationHandback', () => {
  it('hands a converted UrlElicitationRequiredError back as a ProtocolError with the request id', () => {
    const handback = urlElicitationHandback(
      fromProtocolError(new UrlElicitationRequiredError(elicitations)),
      'REQ01-ID001',
    );

    expect(handback).toBeInstanceOf(ProtocolError);
    expect(handback).not.toBeInstanceOf(McpError);
    expect(handback).toMatchObject({
      code: -32042,
      message: 'URL elicitation required',
      data: { elicitations, requestId: 'REQ01-ID001' },
    });
  });

  it('recognizes one another bundled copy of the SDK built', () => {
    expect(ClientUrlElicitationRequiredError).not.toBe(UrlElicitationRequiredError);

    const handback = urlElicitationHandback(
      fromProtocolError(new ClientUrlElicitationRequiredError(elicitations)),
    );

    expect(handback).toMatchObject({ code: -32042, data: { elicitations } });
  });

  it('adds no request id without one, and leaves a thrown one off', () => {
    const withThrownId = new ProtocolError(-32042, 'Sign in first.', {
      elicitations,
      requestId: 'upstream-7',
    });

    expect(urlElicitationHandback(fromProtocolError(withThrownId))?.data).toEqual({
      elicitations,
    });
    expect(
      urlElicitationHandback(fromProtocolError(new ProtocolError(-32042, 'bare')))?.data,
    ).toBeUndefined();
  });

  it('carries a declared recovery the contract filled', () => {
    const contract = [
      {
        reason: 'sign_in',
        code: JsonRpcErrorCode.InvalidRequest,
        when: 'The upstream account is not linked.',
        recovery: 'Open the sign-in link, then call the tool again.',
      },
    ];
    const { failure } = resolveDeclaredFailure(
      contract,
      fromProtocolError(
        new ProtocolError(-32042, 'Sign in first.', { elicitations, reason: 'sign_in' }),
      ),
    );

    expect(urlElicitationHandback(failure, 'REQ01-ID001')?.data).toEqual({
      elicitations,
      reason: 'sign_in',
      recovery: { hint: 'Open the sign-in link, then call the tool again.' },
      requestId: 'REQ01-ID001',
    });
  });

  it.each([
    [
      'an McpError a handler built with -32042',
      () => new McpError(-32042 as JsonRpcErrorCode, 'Sign in first.', { elicitations }),
    ],
    [
      'one built with a converted elicitation as its cause',
      () =>
        new McpError(-32042 as JsonRpcErrorCode, 'Sign in first.', undefined, {
          cause: new UrlElicitationRequiredError(elicitations),
        }),
    ],
    ['any other converted ProtocolError', () => fromProtocolError(new ProtocolError(-32099, 'x'))],
    [
      'a cancellation that outranked the elicitation',
      () =>
        asRequestCancelled(
          fromProtocolError(new UrlElicitationRequiredError(elicitations)),
          AbortSignal.abort('client disconnected'),
        ),
    ],
    [
      'an unconverted UrlElicitationRequiredError',
      () => new UrlElicitationRequiredError(elicitations),
    ],
  ])('hands back nothing for %s', (_label, failure) => {
    expect(urlElicitationHandback(failure(), 'REQ01-ID001')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The wire, per era and surface
// ---------------------------------------------------------------------------

describe('a handler-thrown ProtocolError on the wire', () => {
  /** What every handler below throws; set per case. */
  let thrown: () => unknown;

  const fixtures: FixtureSet = {
    tools: [
      tool('throws_tool', {
        description: 'Throws the case value.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('Never returned.') }),
        handler: () => {
          throw thrown();
        },
      }) as never,
    ],
    prompts: [
      prompt('throws_prompt', {
        description: 'Throws the case value.',
        generate: () => {
          throw thrown();
        },
      }) as never,
    ],
    resources: [
      resource('throws://{id}', {
        name: 'throws-resource',
        description: 'Throws the case value.',
        params: z.object({ id: z.string().describe('Id.') }),
        handler: () => {
          throw thrown();
        },
      }) as never,
    ],
  };

  /** The same three on a bare SDK server: what the SDK alone answers is the oracle. */
  function sdkServer(): McpServer {
    const server = new McpServer(
      { name: 'sdk-only', version: '0.0.0' },
      { capabilities: { tools: {}, prompts: {}, resources: {} } },
    );
    server.registerTool('throws_tool', { inputSchema: z.object({}) }, () => {
      throw thrown();
    });
    server.registerPrompt('throws_prompt', {}, () => {
      throw thrown();
    });
    server.registerResource(
      'throws-resource',
      new ResourceTemplate('throws://{id}', { list: undefined }),
      {},
      () => {
        throw thrown();
      },
    );
    return server;
  }

  type Request = (method: string, params: Record<string, unknown>) => Promise<WireResponse>;

  /** A 2025-era session with the SDK-only server: `initialize`, then raw JSON-RPC. */
  async function sdkLegacy(): Promise<{ close(): Promise<void>; request: Request }> {
    const server = sdkServer();
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    const pending = new Map<number, (message: WireResponse) => void>();
    client.onmessage = (message) => {
      const { id, method } = message as { id?: unknown; method?: unknown };
      if (typeof id !== 'number' || method !== undefined) return;
      const { error, result } = message as WireResponse;
      pending.get(id)?.({ ...(error && { error }), ...(result && { result }) });
      pending.delete(id);
    };
    await server.connect(serverSide);
    await client.start();
    let nextId = 1;
    const request: Request = (method, params) =>
      new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        void client.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
      });
    await request('initialize', {
      protocolVersion: LATEST_2025_REVISION,
      capabilities: {},
      clientInfo: { name: 'sdk-only-client', version: '0.0.0' },
    });
    return { request, close: () => server.close() };
  }

  /** The SDK-only server over the HTTP app at 2026-07-28, as the harness reaches the framework. */
  async function sdkModern(): Promise<{ close(): Promise<void>; request: Request }> {
    const { app, close } = await createHttpApp(
      async () => sdkServer(),
      requestContextService.createRequestContext({ operation: 'sdk-only' }),
      defaultServerManifest,
    );
    const request: Request = async (method, params) => {
      const name = typeof params.uri === 'string' ? params.uri : params.name;
      const response = await app.request(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': MODERN_PROTOCOL_REVISION,
            'Mcp-Method': method,
            ...(typeof name === 'string' && { 'Mcp-Name': name }),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method,
            params: {
              ...params,
              _meta: {
                'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_REVISION,
                'io.modelcontextprotocol/clientInfo': { name: 'sdk-only-client', version: '0.0.0' },
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            },
          }),
        }),
      );
      const body = await response.text();
      const line = body.split('\n').find((candidate) => candidate.startsWith('data:'));
      const { error, result } = JSON.parse(line?.slice(5) ?? body) as WireResponse;
      return { ...(error && { error }), ...(result && { result }) };
    };
    return { request, close };
  }

  /** Both servers at `era`, closed after the case. */
  const opened: Array<{ close(): Promise<void> }> = [];
  async function open(era: string): Promise<{ framework: Request; sdk: Request }> {
    const framework =
      era === MODERN_PROTOCOL_REVISION
        ? await openModernApp(fixtures)
        : await openLegacySession(fixtures);
    const sdk = era === MODERN_PROTOCOL_REVISION ? await sdkModern() : await sdkLegacy();
    opened.push(framework, sdk);
    return { framework: framework.request, sdk: sdk.request };
  }

  const CALLS = {
    tool: ['tools/call', { name: 'throws_tool', arguments: {} }],
    prompt: ['prompts/get', { name: 'throws_prompt' }],
    resource: ['resources/read', { uri: 'throws://x' }],
  } as const;

  /** Every completion record the calls wrote, as `[message, metrics.errorCode]`. */
  let completions: Array<[string, unknown]>;

  beforeEach(() => {
    completions = [];
    for (const level of ['debug', 'info', 'notice', 'warning', 'error'] as const) {
      vi.spyOn(logger, level).mockImplementation(((message: string, context?: unknown) => {
        if (/ finished\.$/.test(message)) {
          const extra = (context as { extra?: { metrics?: { errorCode?: unknown } } }).extra;
          completions.push([message, extra?.metrics?.errorCode]);
        }
      }) as never);
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    while (opened.length) await opened.pop()?.close();
  });

  describe.each([LATEST_2025_REVISION, MODERN_PROTOCOL_REVISION])('on %s', (era) => {
    it.each(Object.keys(CALLS) as Array<keyof typeof CALLS>)(
      'answers a %s’s UrlElicitationRequiredError as the SDK does, the request id added where it reaches the client',
      async (surface) => {
        thrown = () => new UrlElicitationRequiredError(elicitations);
        const { framework, sdk } = await open(era);
        const [method, params] = CALLS[surface];

        const answered = await framework(method, params);
        const oracle = await sdk(method, params);

        if (era === MODERN_PROTOCOL_REVISION) {
          // The 2026-07-28 revision has no -32042; the SDK steers to inputRequired.elicitUrl.
          expect(oracle.error?.code).toBe(-32603);
          expect(answered).toEqual(oracle);
        } else {
          expect(oracle).toEqual({
            error: { code: -32042, message: 'URL elicitation required', data: { elicitations } },
          });
          expect(answered).toEqual({
            error: {
              ...oracle.error,
              data: { elicitations, requestId: expect.stringMatching(REQUEST_ID) },
            },
          });
        }
      },
    );

    it('keeps any other ProtocolError’s code, message, and data on every surface, adding the request id', async () => {
      thrown = () => new ProtocolError(-32099, 'custom', { detail: 1 });
      const { framework } = await open(era);
      const expected = {
        code: -32099,
        message: 'custom',
        data: { detail: 1, requestId: expect.stringMatching(REQUEST_ID) },
      };

      const toolCall = await framework(...CALLS.tool);
      const promptGet = await framework(...CALLS.prompt);
      const resourceRead = await framework(...CALLS.resource);

      expect(toolCall.result).toMatchObject({ isError: true });
      expect(toolCall.result?.structuredContent).toEqual({ error: expected });
      expect(promptGet).toEqual({ error: expected });
      expect(resourceRead).toEqual({ error: expected });
      expect(completions).toEqual([
        [TELEMETRY_LOG_MESSAGES.toolExecutionFinished, '-32099'],
        [TELEMETRY_LOG_MESSAGES.promptGenerationFinished, '-32099'],
        [TELEMETRY_LOG_MESSAGES.resourceReadFinished, '-32099'],
      ]);
    });

    it('answers a tool’s or prompt’s ResourceNotFoundError with its uri and the request id, and a read’s in the not-found shape', async () => {
      thrown = () => new ResourceNotFoundError('throws://gone');
      const { framework } = await open(era);
      const notFound = { code: -32602, message: 'Resource not found: throws://gone' };

      const toolCall = await framework(...CALLS.tool);
      const promptGet = await framework(...CALLS.prompt);
      const resourceRead = await framework(...CALLS.resource);

      const withRequestId = {
        ...notFound,
        data: { uri: 'throws://gone', requestId: expect.stringMatching(REQUEST_ID) },
      };
      expect(toolCall.result?.structuredContent).toEqual({ error: withRequestId });
      expect(promptGet).toEqual({ error: withRequestId });
      expect(resourceRead).toEqual({ error: { ...notFound, data: { uri: 'throws://gone' } } });
    });

    it('answers a read’s legacy -32002 not-found as the SDK does (#829)', async () => {
      thrown = () => new ProtocolError(-32002, 'Resource not found', { uri: 'throws://old' });
      const { framework, sdk } = await open(era);

      const answered = await framework(...CALLS.resource);
      const oracle = await sdk(...CALLS.resource);

      expect(oracle).toEqual({
        error: { code: -32602, message: 'Resource not found', data: { uri: 'throws://old' } },
      });
      expect(answered).toEqual(oracle);
    });
  });
});

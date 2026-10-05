/**
 * @fileoverview Tests for createResourceHandler — the production handler factory
 * for all `resource()` builder definitions. Verifies context creation with uri,
 * param validation, error re-throwing, response formatting, multi-round-trip
 * input, and notification routing.
 * @module tests/mcp-server/resources/utils/resourceHandlerFactory.test
 */

import {
  type InputRequiredResult,
  inputRequired,
  type ReadResourceResult,
} from '@modelcontextprotocol/server';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import {
  EVERY_INPUT_CAPABILITY,
  legacyCapabilityView,
  makeSenderlessServerContext,
  makeServerContext,
} from '../../../../helpers/server-context.js';

// ---------------------------------------------------------------------------
// Module mocks — vi.hoisted ensures variables are available during vi.mock hoisting
// ---------------------------------------------------------------------------

const { mockConfig, mockLogger } = vi.hoisted(() => ({
  mockConfig: {
    environment: 'testing',
    mcpServerVersion: '1.0.0-test',
    mcpAuthMode: 'none',
    mcpSessionMode: 'auto' as 'auto' | 'stateful' | 'stateless',
    openTelemetry: { serviceName: 'test', serviceVersion: '0.0.0' },
  },
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    crit: vi.fn(),
    emerg: vi.fn(),
    child: vi.fn(),
    isLevelEnabled: vi.fn((_level: string) => true),
  },
}));

vi.mock('@/config/index.js', () => ({
  config: mockConfig,
}));

vi.mock('@/utils/internal/logger.js', () => ({
  logger: mockLogger,
  Logger: { getInstance: () => mockLogger },
}));

vi.mock('@/utils/internal/requestContext.js', () => ({
  toCanonicalContext: (context: Record<string, unknown>) =>
    Object.fromEntries(
      [
        'auth',
        'extra',
        'operation',
        'requestId',
        'sessionId',
        'spanId',
        'tenantId',
        'timestamp',
        'traceId',
      ]
        .filter((k) => context[k] !== undefined)
        .map((k) => [k, context[k]]),
    ),
  withExtra: (ctx: { extra?: Record<string, unknown> }, fields: Record<string, unknown>) => ({
    ...ctx,
    extra: { ...ctx.extra, ...fields },
  }),
  withActiveSpan: <T>(ctx: T): T => ctx,
  requestContextService: {
    createRequestContext: vi.fn((opts: any) => ({
      requestId: 'test-req-id',
      timestamp: new Date().toISOString(),
      operation: opts?.operation ?? 'test',
      ...(opts?.additionalContext ?? {}),
    })),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createRequestStateSealer } from '@/mcp-server/inputRequired.js';
import type { ResourceSubscriptions } from '@/mcp-server/notifications.js';
import type { AnyResourceDefinition } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
import {
  createResourceHandler,
  type HandlerServices,
  type NotifierSources,
} from '@/mcp-server/resources/utils/resourceHandlerFactory.js';
import { TELEMETRY_LOG_MESSAGES } from '@/utils/internal/telemetryMessages.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Narrows a handler result to the `resources/read` arm. The factory returns
 * `ReadResourceResult | InputRequiredResult`, so every content assertion goes
 * through here rather than casting at each call site.
 */
function readContents(
  result: ReadResourceResult | InputRequiredResult,
): ReadResourceResult['contents'] {
  expect(result).toHaveProperty('contents');
  return (result as ReadResourceResult).contents;
}

/** The `metrics` payload of the completion log the most recent read emitted. */
function completionMetrics(): Record<string, unknown> {
  const call = mockLogger.info.mock.calls.findLast(
    ([message]) => message === TELEMETRY_LOG_MESSAGES.resourceReadFinished,
  );
  if (!call) throw new Error('No resource completion log was emitted');
  return (call[1] as { extra: { metrics: Record<string, unknown> } }).extra.metrics;
}

const mockStorage = {
  get: vi.fn(async () => null),
  set: vi.fn(async () => {}),
  delete: vi.fn(async () => {}),
  list: vi.fn(async () => ({ keys: [] })),
  getMany: vi.fn(async () => new Map()),
};

const services: HandlerServices = {
  logger: mockLogger as any,
  storage: mockStorage as any,
};

const notifiers: NotifierSources = {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createResourceHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset session mode between tests so the durability gate isn't sticky.
    // 'auto' is the production default and resolves to stateful for HTTP.
    mockConfig.mcpSessionMode = 'auto';
  });

  // -----------------------------------------------------------------------
  // Basic execution
  // -----------------------------------------------------------------------

  describe('Basic execution', () => {
    it('should call handler with validated params and Context, return formatted response', async () => {
      let capturedCtx: any;
      let capturedParams: any;

      const def = resource('items://{itemId}/data', {
        description: 'Get item data.',
        params: z.object({ itemId: z.string().describe('Item ID') }),
        async handler(params, ctx) {
          capturedParams = params;
          capturedCtx = ctx;
          return { id: params.itemId, status: 'active' };
        },
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      const uri = new URL('items://item-42/data');
      const contents = readContents(await handler(uri, { itemId: 'item-42' }, makeServerContext()));

      // Response
      expect(contents).toHaveLength(1);
      const content = contents[0]!;
      expect(content.uri).toBe('items://item-42/data');
      expect(content.mimeType).toBe('application/json');
      const parsed = JSON.parse((content as { text: string }).text);
      expect(parsed).toEqual({ id: 'item-42', status: 'active' });

      // Context
      expect(capturedCtx.requestId).toBe('test-req-id');
      expect(capturedCtx.uri).toBe(uri);
      expect(typeof capturedCtx.log.info).toBe('function');

      // Params
      expect(capturedParams).toEqual({ itemId: 'item-42' });
    });

    it('should use custom format function when provided', async () => {
      const def = resource('custom://{id}', {
        description: 'Custom format.',
        params: z.object({ id: z.string().describe('ID') }),
        handler: (params) => ({ value: params.id }),
        format: (result, meta) => [
          { uri: meta.uri.href, text: `Custom: ${(result as any).value}`, mimeType: meta.mimeType },
        ],
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      const contents = readContents(
        await handler(new URL('custom://abc'), { id: 'abc' }, makeServerContext()),
      );

      expect((contents[0] as { text: string }).text).toBe('Custom: abc');
    });

    it('should preserve plain text and JSON-encode vendor JSON resources', async () => {
      const plain = resource('plain://text', {
        description: 'Plain text.',
        mimeType: 'text/plain; charset=utf-8',
        handler: () => 'hello',
      });
      const vendorJson = resource('vendor://json', {
        description: 'Vendor JSON.',
        mimeType: 'application/problem+json; charset=utf-8',
        handler: () => 'hello',
      });

      const plainContents = readContents(
        await createResourceHandler(plain as AnyResourceDefinition, services, notifiers)(
          new URL('plain://text'),
          {},
          makeServerContext(),
        ),
      );
      const jsonContents = readContents(
        await createResourceHandler(vendorJson as AnyResourceDefinition, services, notifiers)(
          new URL('vendor://json'),
          {},
          makeServerContext(),
        ),
      );

      expect((plainContents[0] as { text: string }).text).toBe('hello');
      expect((jsonContents[0] as { text: string }).text).toBe('"hello"');
    });

    it('should pass string handler results through without JSON quote wrapping', async () => {
      const html = '<!DOCTYPE html><html><body>Hello</body></html>';
      const def = resource('ui://app/app.html', {
        description: 'Static app UI.',
        mimeType: 'text/html;profile=mcp-app',
        handler: () => html,
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      const contents = readContents(
        await handler(new URL('ui://app/app.html'), {}, makeServerContext()),
      );

      expect(contents[0]).toMatchObject({
        uri: 'ui://app/app.html',
        mimeType: 'text/html;profile=mcp-app',
        text: html,
      });
    });

    it('should JSON-encode string handler results for JSON mime types', async () => {
      const def = resource('json://app/data', {
        description: 'String JSON payload.',
        mimeType: 'application/json',
        handler: () => 'hello',
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      const contents = readContents(
        await handler(new URL('json://app/data'), {}, makeServerContext()),
      );

      expect(contents[0]).toMatchObject({
        uri: 'json://app/data',
        mimeType: 'application/json',
        text: '"hello"',
      });
    });
  });

  // -----------------------------------------------------------------------
  // Context construction
  // -----------------------------------------------------------------------

  describe('Context construction', () => {
    it('should default tenantId to "default" (no auth)', async () => {
      let capturedTenant: string | undefined;

      const def = resource('t://{id}', {
        description: 'Tenant test.',
        handler: (_params, ctx) => {
          capturedTenant = ctx.tenantId;
          return {};
        },
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      await handler(new URL('t://x'), { id: 'x' }, makeServerContext());

      expect(capturedTenant).toBe('default');
    });

    it('threads the request scope cancellation signal onto ctx.signal', async () => {
      const controller = new AbortController();
      let capturedSignal: AbortSignal | undefined;

      const def = resource('signal://{id}', {
        description: 'Signal test.',
        handler: (_params, ctx) => {
          capturedSignal = ctx.signal;
          return {};
        },
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      await handler(
        new URL('signal://x'),
        { id: 'x' },
        makeServerContext({ signal: controller.signal }),
      );

      expect(capturedSignal).toBe(controller.signal);
    });
  });

  // -----------------------------------------------------------------------
  // Multi-round-trip input (ctx.requestInput / ctx.inputs)
  // -----------------------------------------------------------------------

  describe('multi-round-trip input', () => {
    const confirmingResource = resource('confirm://{id}', {
      description: 'Requests confirmation before answering.',
      params: z.object({ id: z.string().describe('id') }),
      handler: (params, ctx) => {
        const confirmed = ctx.inputs.accepted<{ ok: boolean }>('confirm');
        if (!confirmed) {
          return ctx.requestInput({
            inputRequests: {
              confirm: inputRequired.elicit({
                message: `Read ${params.id}?`,
                requestedSchema: z.object({ ok: z.boolean().describe('Confirm the read.') }),
              }),
            },
            requestState: 'awaiting-confirm',
          });
        }
        return { id: params.id, confirmed: confirmed.ok };
      },
    });

    it('returns the SDK input_required result instead of throwing an McpError', async () => {
      const handler = createResourceHandler(
        confirmingResource as AnyResourceDefinition,
        services,
        notifiers,
      );

      const result = await handler(
        new URL('confirm://item-1'),
        { id: 'item-1' },
        makeServerContext(),
      );

      expect(result).toMatchObject({
        resultType: 'input_required',
        requestState: 'awaiting-confirm',
        inputRequests: {
          confirm: {
            method: 'elicitation/create',
            params: expect.objectContaining({ message: 'Read item-1?', mode: 'form' }),
          },
        },
      });
      expect(result).not.toHaveProperty('contents');
    });

    it('completes normally on the retried request carrying the input responses', async () => {
      const handler = createResourceHandler(
        confirmingResource as AnyResourceDefinition,
        services,
        notifiers,
        legacyCapabilityView(EVERY_INPUT_CAPABILITY),
      );

      const contents = readContents(
        await handler(
          new URL('confirm://item-1'),
          { id: 'item-1' },
          makeServerContext({
            inputResponses: { confirm: { action: 'accept', content: { ok: true } } },
            requestState: 'awaiting-confirm',
          }),
        ),
      );

      expect(JSON.parse((contents[0] as { text: string }).text)).toEqual({
        id: 'item-1',
        confirmed: true,
      });
    });

    it('keeps a pre-answered read from a client without elicitation off ctx.inputs (#496)', async () => {
      const handler = createResourceHandler(
        confirmingResource as AnyResourceDefinition,
        services,
        notifiers,
        legacyCapabilityView({ roots: {} }),
      );

      const error = await handler(
        new URL('confirm://item-1'),
        { id: 'item-1' },
        makeServerContext({
          inputResponses: { confirm: { action: 'accept', content: { ok: true } } },
        }),
      ).catch((e: unknown) => e);

      // The answer never reached the handler, so it asked — and was refused.
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.InvalidRequest,
        data: { reason: 'client_capability_missing' },
      });
    });

    it('exposes the view it resolved as ctx.clientCapabilities (#580)', async () => {
      let seen: unknown = 'unset';
      const def = resource('caps://{id}', {
        description: 'Reads the client capabilities.',
        handler: (_params, ctx) => {
          seen = ctx.clientCapabilities;
          return { ok: true };
        },
      });
      const declared = { sampling: {} };
      const handler = createResourceHandler(
        def as AnyResourceDefinition,
        services,
        notifiers,
        legacyCapabilityView(declared),
      );

      await handler(new URL('caps://x'), { id: 'x' }, makeServerContext());

      expect(seen).toEqual(declared);
    });

    it('seals the requestState it returns when a key is configured', async () => {
      const sealer = createRequestStateSealer('k'.repeat(32));
      const handler = createResourceHandler(
        confirmingResource as AnyResourceDefinition,
        { ...services, ...(sealer && { requestState: sealer }) },
        notifiers,
      );
      const serverContext = makeServerContext();

      const result = (await handler(
        new URL('confirm://item-1'),
        { id: 'item-1' },
        serverContext,
      )) as InputRequiredResult;

      expect(result.resultType).toBe('input_required');
      expect(result.requestState).toMatch(/^v1\./);
      await expect(sealer?.verify(result.requestState ?? '', serverContext)).resolves.toBe(
        'awaiting-confirm',
      );
    });

    it('fails the read as a classified InternalError when sealing fails', async () => {
      const handler = createResourceHandler(
        confirmingResource as AnyResourceDefinition,
        {
          ...services,
          requestState: {
            seal: async () => {
              throw new Error('HMAC key import failed');
            },
            verify: async () => 'unused',
          },
        },
        notifiers,
      );

      const error = await handler(
        new URL('confirm://item-1'),
        { id: 'item-1' },
        makeServerContext(),
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.InternalError,
        data: { requestId: 'test-req-id' },
      });
      // The measured read ends failed, so its one completion record carries the code.
      expect(completionMetrics().errorCode).toBe(String(JsonRpcErrorCode.InternalError));
    });

    it('refuses with a JSON-RPC error when the connection declares no capability (#379)', async () => {
      // The 2025-era shim's own refusal is a bare `-32603` above the callback;
      // gating before the signal is returned keeps the reason and hint.
      const handler = createResourceHandler(
        confirmingResource as AnyResourceDefinition,
        services,
        notifiers,
        legacyCapabilityView({}),
      );

      const error = await handler(
        new URL('confirm://item-1'),
        { id: 'item-1' },
        makeServerContext(),
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.InvalidRequest,
        data: {
          reason: 'client_capability_missing',
          recovery: { hint: expect.stringContaining('`elicitation.form`') },
        },
      });
      // #495: a consent gate has no input field to fall back on, so the default
      // hint stops at the reconnect sentence.
      expect((error as McpError).data?.recovery).toEqual({
        hint: 'Reconnect with a client that declares the `elicitation.form` capability.',
      });
    });

    it('appends a per-call fallbackHint to the refusal hint (#495)', async () => {
      const passphraseResource = resource('vault://{id}', {
        description: 'Asks for a passphrase unless the URI already carries one.',
        params: z.object({ id: z.string().describe('id') }),
        handler: (params, ctx) =>
          ctx.requestInput(
            {
              inputRequests: {
                passphrase: inputRequired.elicit({
                  message: `Passphrase for ${params.id}?`,
                  requestedSchema: z.object({ value: z.string().describe('The passphrase.') }),
                }),
              },
            },
            { fallbackHint: 'Or read vault://{id}/{passphrase} instead.' },
          ),
      });
      const handler = createResourceHandler(
        passphraseResource as AnyResourceDefinition,
        services,
        notifiers,
        legacyCapabilityView({}),
      );

      const error = await handler(new URL('vault://a'), { id: 'a' }, makeServerContext()).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.InvalidRequest,
        message:
          "Cannot request input 'passphrase' (elicitation/create): the client on this 2025-era " +
          'connection did not declare the `elicitation.form` capability',
        data: {
          reason: 'client_capability_missing',
          recovery: {
            hint:
              'Reconnect with a client that declares the `elicitation.form` capability. ' +
              'Or read vault://{id}/{passphrase} instead.',
          },
        },
      });
    });

    it('records a refused read as a failed measurement, not an input-required one (#379)', async () => {
      // `ctx.requestInput` throws the refusal from inside the handler, so the
      // measured region sees an `McpError`. Resolved any later — in the
      // factory's catch, after the span closed — the read would be recorded as
      // a successful input-required round while the caller gets a JSON-RPC
      // error.
      const span = {
        setAttributes: vi.fn(),
        setAttribute: vi.fn(),
        setStatus: vi.fn(),
        recordException: vi.fn(),
        end: vi.fn(),
      };
      const tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue({
        startActiveSpan: (_name: string, cb: (s: unknown) => unknown) => cb(span),
      } as never);

      try {
        const handler = createResourceHandler(
          confirmingResource as AnyResourceDefinition,
          services,
          notifiers,
          legacyCapabilityView({}),
        );
        await handler(new URL('confirm://item-1'), { id: 'item-1' }, makeServerContext()).catch(
          (e: unknown) => e,
        );

        expect(span.setStatus).toHaveBeenCalledWith(
          expect.objectContaining({ code: SpanStatusCode.ERROR }),
        );
        expect(span.setAttributes).toHaveBeenLastCalledWith(
          expect.objectContaining({ 'mcp.resource.success': false }),
        );
        expect(span.setAttribute).toHaveBeenCalledWith(
          'mcp.resource.error_code',
          String(JsonRpcErrorCode.InvalidRequest),
        );
        expect(span.setAttribute).not.toHaveBeenCalledWith('mcp.resource.input_required', true);
      } finally {
        tracerSpy.mockRestore();
      }
    });

    it('lets the signal through when the capability is declared (#379)', async () => {
      const handler = createResourceHandler(
        confirmingResource as AnyResourceDefinition,
        services,
        notifiers,
        legacyCapabilityView({ elicitation: { form: {} } }),
      );

      const result = await handler(
        new URL('confirm://item-1'),
        { id: 'item-1' },
        makeServerContext(),
      );

      expect(result).toMatchObject({ resultType: 'input_required' });
    });

    it('exposes the round state and dropped response keys on ctx.inputs', async () => {
      let capturedState: string | undefined;
      let capturedDropped: readonly string[] | undefined;

      const def = resource('state://{id}', {
        description: 'Reads round state.',
        handler: (_params, ctx) => {
          capturedState = ctx.inputs.state<string>();
          capturedDropped = ctx.inputs.dropped;
          return { ok: true };
        },
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      await handler(
        new URL('state://x'),
        { id: 'x' },
        makeServerContext({
          requestState: 'round-2',
          droppedInputResponseKeys: ['stale'],
        }),
      );

      expect(capturedState).toBe('round-2');
      expect(capturedDropped).toEqual(['stale']);
    });
  });

  // -----------------------------------------------------------------------
  // Session extraction & durability gate
  // -----------------------------------------------------------------------

  describe('Session extraction', () => {
    /**
     * Builds a resource whose handler captures `ctx.sessionId` for assertion.
     * Returned `getSessionId()` reads it after the handler ran.
     */
    function makeSessionCapturingResource() {
      let captured: string | undefined;
      const def = resource('session://{id}', {
        description: 'Captures ctx.sessionId.',
        handler: (_params, ctx) => {
          captured = ctx.sessionId;
          return { ok: true };
        },
      });
      return { def, getSessionId: () => captured };
    }

    it('always forwards sessionId into RequestContext for log correlation', async () => {
      // Strictest gate (stateless + no opt-in) still threads the raw SDK
      // sessionId into RequestContext for tracing.
      mockConfig.mcpSessionMode = 'stateless';
      const { requestContextService } = await import('@/utils/internal/requestContext.js');

      const def = resource('log://{id}', {
        description: 'Log correlation test.',
        handler: () => ({ ok: true }),
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      await handler(new URL('log://x'), { id: 'x' }, makeServerContext({ sessionId: 'sess-r' }));

      expect(requestContextService.createRequestContext).toHaveBeenCalledWith(
        expect.objectContaining({
          parentContext: expect.objectContaining({ sessionId: 'sess-r' }),
        }),
      );
    });

    it('carries the client id into RequestContext as jsonRpcId, never as the requestId (#584)', async () => {
      const { requestContextService } = await import('@/utils/internal/requestContext.js');

      const def = resource('reqid://{id}', {
        description: 'Request id correlation.',
        handler: () => ({ ok: true }),
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      await handler(new URL('reqid://x'), { id: 'x' }, makeServerContext({ requestId: 'req-77' }));

      const params = vi.mocked(requestContextService.createRequestContext).mock.calls.at(-1)?.[0];
      expect(params?.parentContext).not.toHaveProperty('requestId');
      expect(params?.parentContext?.extra).toEqual({ jsonRpcId: 'req-77' });
    });

    it('answers a failed read with the generated requestId its records carry, beside jsonRpcId (#584)', async () => {
      const actual = await vi.importActual<typeof import('@/utils/internal/requestContext.js')>(
        '@/utils/internal/requestContext.js',
      );
      const { requestContextService } = await import('@/utils/internal/requestContext.js');
      vi.mocked(requestContextService.createRequestContext).mockImplementationOnce(
        actual.requestContextService.createRequestContext,
      );
      const def = resource('rid://{id}', {
        description: 'Logs, then fails.',
        params: z.object({ id: z.string().describe('id') }),
        handler: (_params, ctx) => {
          ctx.log.info('rid read entered');
          throw new Error('gone');
        },
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      const rejection = (await handler(
        new URL('rid://x'),
        { id: 'x' },
        makeServerContext({ requestId: 'res-str-1' }),
      ).catch((error: unknown) => error)) as McpError;

      const recordOf = (message: string) =>
        mockLogger.info.mock.calls.findLast(([logged]) => logged === message)?.[1] as
          | { extra?: Record<string, unknown>; requestId?: string }
          | undefined;
      const requestId = rejection.data?.requestId;
      expect(requestId).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
      for (const record of [
        recordOf(TELEMETRY_LOG_MESSAGES.resourceReadFinished),
        recordOf('rid read entered'),
      ]) {
        expect(record?.requestId).toBe(requestId);
        expect(record?.extra).toMatchObject({ jsonRpcId: 'res-str-1', resourceUri: 'rid://x' });
      }
    });

    it('surfaces ctx.sessionId in stateful HTTP mode', async () => {
      mockConfig.mcpSessionMode = 'stateful';
      const { def, getSessionId } = makeSessionCapturingResource();

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      await handler(
        new URL('session://x'),
        { id: 'x' },
        makeServerContext({ sessionId: 'sess-stateful' }),
      );

      expect(getSessionId()).toBe('sess-stateful');
    });

    it('surfaces ctx.sessionId in auto mode (resolves to stateful for HTTP)', async () => {
      mockConfig.mcpSessionMode = 'auto';
      const { def, getSessionId } = makeSessionCapturingResource();

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      await handler(
        new URL('session://x'),
        { id: 'x' },
        makeServerContext({ sessionId: 'sess-auto' }),
      );

      expect(getSessionId()).toBe('sess-auto');
    });

    it('hides ctx.sessionId in stateless mode by default (fail-closed)', async () => {
      mockConfig.mcpSessionMode = 'stateless';
      const { def, getSessionId } = makeSessionCapturingResource();

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      await handler(
        new URL('session://x'),
        { id: 'x' },
        makeServerContext({ sessionId: 'sess-stateless' }),
      );

      expect(getSessionId()).toBeUndefined();
    });

    it('surfaces ctx.sessionId in stateless mode when exposeStatelessSessionId is true', async () => {
      mockConfig.mcpSessionMode = 'stateless';
      const optInServices: HandlerServices = {
        ...services,
        exposeStatelessSessionId: true,
      };
      const { def, getSessionId } = makeSessionCapturingResource();

      const handler = createResourceHandler(def as AnyResourceDefinition, optInServices, notifiers);
      await handler(
        new URL('session://x'),
        { id: 'x' },
        makeServerContext({ sessionId: 'sess-opt-in' }),
      );

      expect(getSessionId()).toBe('sess-opt-in');
    });

    it('leaves ctx.sessionId undefined when the SDK provides none, in any mode', async () => {
      const { def, getSessionId } = makeSessionCapturingResource();
      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);

      for (const mode of ['stateful', 'auto', 'stateless'] as const) {
        mockConfig.mcpSessionMode = mode;
        await handler(new URL('session://x'), { id: 'x' }, makeServerContext());
        expect(getSessionId()).toBeUndefined();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Param validation
  // -----------------------------------------------------------------------

  describe('Param validation', () => {
    it('should surface a flat message and structured issues on Zod failure', async () => {
      const def = resource('clinical://{nctId}', {
        description: 'NCT-formatted param.',
        params: z.object({
          nctId: z.string().regex(/^NCT\d{8}$/, 'NCT IDs must match NCTxxxxxxxx'),
        }),
        handler: () => ({ ok: true }),
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);

      const err = await handler(
        new URL('clinical://INVALID'),
        { nctId: 'INVALID' } as any,
        makeServerContext(),
      ).catch((e) => e);

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      // Flat human-readable message — no JSON blob
      expect(err.message).not.toContain('[\n');
      expect(err.message).not.toContain('"code":');
      expect(err.message).toBe('nctId: NCT IDs must match NCTxxxxxxxx');
      // Structured issues preserved in data
      expect(err.data).toBeDefined();
      expect(Array.isArray(err.data.issues)).toBe(true);
      expect(err.data.issues).toHaveLength(1);
    });

    it('should pass variables through when no params schema is defined', async () => {
      let capturedParams: any;

      const def = resource('loose://{id}', {
        description: 'No schema.',
        handler: (params) => {
          capturedParams = params;
          return {};
        },
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      await handler(new URL('loose://x'), { id: 'x', extra: 'field' }, makeServerContext());

      expect(capturedParams).toEqual({ id: 'x', extra: 'field' });
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe('Error handling', () => {
    it('leaves a declared severity inert on the resource path (#380)', async () => {
      // Resources re-throw after `classifyOnly` and the SDK owns the log, so
      // there is no `handleError` call for a severity to move. The field is
      // accepted on the contract and changes nothing here.
      const def = resource('sev://{id}', {
        description: 'Declines a read.',
        params: z.object({ id: z.string().describe('id') }),
        errors: [
          {
            reason: 'consent_declined',
            code: JsonRpcErrorCode.InvalidRequest,
            when: 'The caller declined the confirmation prompt.',
            severity: 'notice',
            recovery: 'Re-run the read and confirm the prompt to proceed.',
          },
        ],
        handler: (_params, ctx) => {
          throw ctx.fail('consent_declined', 'Declined.');
        },
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);

      await expect(
        handler(new URL('sev://x'), { id: 'x' }, makeServerContext()),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.InvalidRequest });
      expect(mockLogger.notice).not.toHaveBeenCalledWith(
        expect.stringContaining('Error in'),
        expect.anything(),
      );
      expect(mockLogger.error).not.toHaveBeenCalledWith(
        expect.stringContaining('Error in'),
        expect.anything(),
      );
    });

    describe('declared recovery fill (#579) and the request id (#576)', () => {
      const RECOVERY = 'List the available records and read one of those instead.';

      /** Two layers below the handler, as a real service's fetch path sits. */
      const recordService = {
        read(id: string): never {
          return recordService.fetch(id);
        },
        fetch(id: string): never {
          throw new McpError(JsonRpcErrorCode.NotFound, `Record ${id} is gone.`, {
            reason: 'gone',
          });
        },
      };

      /** Reads through a resource under `errors` (`null` for none) whose handler throws `fail`. */
      async function readFailing(
        fail: (ctx: any) => unknown,
        errors: readonly unknown[] | null = [
          {
            reason: 'gone',
            code: JsonRpcErrorCode.NotFound,
            when: 'The record is gone.',
            recovery: RECOVERY,
          },
        ],
      ): Promise<McpError> {
        const def = resource('fill://{id}', {
          description: 'Fails in a chosen way.',
          params: z.object({ id: z.string().describe('id') }),
          ...(errors && { errors: errors as never }),
          handler: (_params, ctx) => {
            throw fail(ctx);
          },
        });
        const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
        const rejection = await handler(new URL('fill://x'), { id: 'x' }, makeServerContext()).then(
          () => {
            throw new Error('expected the read to fail');
          },
          (error: unknown) => error,
        );
        expect(rejection).toBeInstanceOf(McpError);
        return rejection as McpError;
      }

      it('fills a bare ctx.fail from the declared entry', async () => {
        const rejection = await readFailing((ctx) => ctx.fail('gone'));

        expect(rejection.code).toBe(JsonRpcErrorCode.NotFound);
        expect(rejection.data?.recovery).toEqual({ hint: RECOVERY });
      });

      it('fills a declared reason thrown by a service below the handler', async () => {
        const rejection = await readFailing(() => recordService.read('x'));

        expect(rejection.message).toBe('Record x is gone.');
        expect(rejection.data?.recovery).toEqual({ hint: RECOVERY });
      });

      it('leaves a throw-site hint unchanged', async () => {
        const rejection = await readFailing((ctx) =>
          ctx.fail('gone', 'Gone.', { recovery: { hint: 'Read fill://y instead.' } }),
        );

        expect(rejection.data?.recovery).toEqual({ hint: 'Read fill://y instead.' });
      });

      it.each([
        [
          'an undeclared reason',
          () => new McpError(JsonRpcErrorCode.NotFound, 'Gone.', { reason: 'other' }),
        ],
        ['a non-McpError', () => new Error('gone')],
      ])('adds no hint for %s under a contract', async (_label, fail) => {
        const rejection = await readFailing(fail);

        expect(rejection.data?.recovery).toBeUndefined();
      });

      it('adds no hint for a declared-looking reason on a resource with no contract', async () => {
        const rejection = await readFailing(
          () => new McpError(JsonRpcErrorCode.NotFound, 'Gone.', { reason: 'gone' }),
          null,
        );

        expect(rejection.data).toEqual({ reason: 'gone', requestId: 'test-req-id' });
      });

      it('carries the read’s request id, the id its completion record logs', async () => {
        const rejection = await readFailing((ctx) => ctx.fail('gone'));

        expect(rejection.data).toEqual({
          reason: 'gone',
          recovery: { hint: RECOVERY },
          requestId: 'test-req-id',
        });
        const finished = mockLogger.info.mock.calls.findLast(
          ([message]) => message === TELEMETRY_LOG_MESSAGES.resourceReadFinished,
        );
        expect((finished?.[1] as { requestId?: string } | undefined)?.requestId).toBe(
          rejection.data?.requestId,
        );
      });

      it('replaces a thrown data.requestId and fills a classified error’s empty data', async () => {
        const thrown = await readFailing(
          () => new McpError(JsonRpcErrorCode.NotFound, 'Gone.', { requestId: 'upstream-7' }),
          null,
        );
        const classified = await readFailing(() => new Error('socket hang up'), null);

        expect(thrown.data).toEqual({ requestId: 'test-req-id' });
        expect(classified.data).toEqual({ requestId: 'test-req-id' });
      });

      it('passes a resource-not-found -32602 whose data is exactly { uri } through untouched', async () => {
        const rejection = await readFailing(
          () =>
            new McpError(JsonRpcErrorCode.InvalidParams, 'Resource not found', { uri: 'fill://x' }),
          null,
        );

        expect(rejection.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(rejection.data).toEqual({ uri: 'fill://x' });
      });

      it('adds the request id to any other -32602', async () => {
        const rejection = await readFailing(
          () =>
            new McpError(JsonRpcErrorCode.InvalidParams, 'Bad id', {
              uri: 'fill://x',
              field: 'id',
            }),
          null,
        );

        expect(rejection.data).toEqual({ uri: 'fill://x', field: 'id', requestId: 'test-req-id' });
      });
    });
  });

  // -----------------------------------------------------------------------
  // Cancellation precedence (#421)
  // -----------------------------------------------------------------------

  describe('cancellation precedence (#421)', () => {
    /** Drives a read whose handler throws `thrown`, with `signal` as the request's. */
    async function codeOfThrow(
      uriTemplate: string,
      thrown: unknown,
      signal?: AbortSignal,
    ): Promise<number> {
      const def = resource(uriTemplate, {
        description: 'Throws, so the catch path can be observed.',
        handler: () => {
          throw thrown;
        },
      });
      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      const rejection = await handler(
        new URL(uriTemplate),
        {},
        makeServerContext(signal ? { signal } : {}),
      ).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(rejection).toBeInstanceOf(McpError);
      return (rejection as McpError).code;
    }

    /** The reason a `notifications/cancelled` carrying no `reason` leaves on the signal. */
    const abortException = () => new DOMException('The operation was aborted.', 'AbortError');

    it('classifies a thrown string as InternalError while the signal is live', async () => {
      expect(await codeOfThrow('live://string', 'probe')).toBe(JsonRpcErrorCode.InternalError);
    });

    it('classifies a DOMException named AbortError as Timeout while the signal is live', async () => {
      expect(await codeOfThrow('live://abort', abortException())).toBe(JsonRpcErrorCode.Timeout);
    });

    it("keeps an McpError's own code while the signal is live", async () => {
      const thrown = new McpError(JsonRpcErrorCode.NotFound, 'Item not found');

      expect(await codeOfThrow('live://mcperr', thrown)).toBe(JsonRpcErrorCode.NotFound);
    });

    it('classifies a rethrown cancellation reason string as RequestCancelled', async () => {
      expect(await codeOfThrow('cancelled://string', 'probe', AbortSignal.abort('probe'))).toBe(
        JsonRpcErrorCode.RequestCancelled,
      );
    });

    it('classifies a DOMException named AbortError as RequestCancelled, not Timeout', async () => {
      const reason = abortException();

      expect(await codeOfThrow('cancelled://abort', reason, AbortSignal.abort(reason))).toBe(
        JsonRpcErrorCode.RequestCancelled,
      );
    });

    it("overrides an explicit McpError's own code", async () => {
      const thrown = new McpError(JsonRpcErrorCode.InternalError, 'Overpass request failed');

      expect(await codeOfThrow('cancelled://mcperr', thrown, AbortSignal.abort('probe'))).toBe(
        JsonRpcErrorCode.RequestCancelled,
      );
    });

    it('carries the cancellation code into the completion log', async () => {
      await codeOfThrow('cancelled://metrics', 'probe', AbortSignal.abort('probe'));

      expect(completionMetrics()).toMatchObject({
        errorCode: String(JsonRpcErrorCode.RequestCancelled),
        isSuccess: false,
      });
    });
  });

  // -----------------------------------------------------------------------
  // Post-handler failure telemetry (#346)
  // -----------------------------------------------------------------------

  describe('post-handler failure telemetry (#346)', () => {
    it('reports a completed read as a success', async () => {
      const def = resource('measured://ok', {
        description: 'Returns a value matching its output contract.',
        output: z.object({ value: z.number().describe('A number.') }),
        handler: () => ({ value: 1 }),
      });
      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);

      await handler(new URL('measured://ok'), {}, makeServerContext());

      expect(completionMetrics()).toMatchObject({ isSuccess: true, errorCode: undefined });
    });

    it('reports an output-schema failure as a failed read', async () => {
      const def = resource('broken://thing', {
        description: 'Violates its declared output schema.',
        output: z.object({ value: z.number().describe('A number the handler never returns.') }),
        handler: () => ({}) as { value: number },
      });
      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);

      await expect(
        handler(new URL('broken://thing'), {}, makeServerContext()),
      ).rejects.toBeInstanceOf(McpError);

      expect(completionMetrics()).toMatchObject({ isSuccess: false });
      expect(completionMetrics().outputBytes).toBe(0);
    });

    it('fails an output-schema violation as an InternalError naming the contract (#480)', async () => {
      const def = resource('broken://contract', {
        name: 'broken-contract',
        description: 'Violates its declared output schema.',
        output: z.object({ value: z.number().describe('A number the handler never returns.') }),
        handler: () => ({}) as { value: number },
      });
      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);

      const rejection = await handler(new URL('broken://contract'), {}, makeServerContext()).then(
        () => {
          throw new Error('expected the read to fail');
        },
        (error: unknown) => error,
      );

      expect(rejection).toBeInstanceOf(McpError);
      expect(rejection).toMatchObject({
        code: JsonRpcErrorCode.InternalError,
        message: expect.stringMatching(
          /^Resource broken-contract returned output that does not match its output schema: value: /,
        ),
      });
      // The read's request id is the only data (#576).
      expect((rejection as McpError).data).toEqual({ requestId: 'test-req-id' });
      expect(completionMetrics()).toMatchObject({
        isSuccess: false,
        errorCode: String(JsonRpcErrorCode.InternalError),
      });
    });

    it('reports a formatter failure as a failed read', async () => {
      const def = resource('broken://format', {
        description: 'Formatter throws.',
        handler: () => ({ value: 1 }),
        format: () => {
          throw new Error('formatter blew up');
        },
      });
      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);

      await expect(
        handler(new URL('broken://format'), {}, makeServerContext()),
      ).rejects.toBeInstanceOf(McpError);

      expect(completionMetrics()).toMatchObject({ isSuccess: false });
    });
  });

  describe('log payload redaction', () => {
    it('does not attach raw inputParams, credentials, query, or fragments to observability context', async () => {
      const { requestContextService } = await import('@/utils/internal/requestContext.js');

      const def = resource('resource://{itemId}', {
        description: 'Redaction test.',
        mimeType: 'application/json',
        params: z.object({ itemId: z.string().describe('id') }),
        handler: () => ({ itemId: 'safe' }),
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      await handler(
        new URL(
          'resource://user:password@sensitive-item-id-value/path?api_key=SUPERSECRET#fragment-secret',
        ),
        { itemId: 'sensitive-item-id-value' },
        makeServerContext(),
      );

      const call = vi
        .mocked(requestContextService.createRequestContext)
        .mock.calls.find((args) => (args[0] as any)?.operation === 'HandleResourceRead');

      expect(call).toBeDefined();
      const additionalContext = (call![0] as any).additionalContext as Record<string, unknown>;
      expect(additionalContext).not.toHaveProperty('inputParams');
      expect(additionalContext.resourceUri).toBe('resource://sensitive-item-id-value/path');
      expect(additionalContext.resourceHasQuery).toBe(true);

      const serializedCalls = JSON.stringify(
        vi.mocked(requestContextService.createRequestContext).mock.calls,
      );
      expect(serializedCalls).not.toContain('SUPERSECRET');
      expect(serializedCalls).not.toContain('password');
      expect(serializedCalls).not.toContain('fragment-secret');
    });

    // #617 — the projection had no length bound, so every record of a read
    // carried whatever the client sent.
    describe('URI length cap (#617)', () => {
      const BASE = 'artic://artworks/';
      const CAP = 1024;
      let seenUri: string | undefined;

      const artwork = resource('artic://artworks/{id}', {
        name: 'artwork',
        description: 'Artwork by numeric id.',
        mimeType: 'application/json',
        params: z.object({ id: z.string().regex(/^\d+$/).describe('Numeric artwork id') }),
        handler(params, ctx) {
          seenUri = ctx.uri?.href;
          ctx.log.info('resource handler entered');
          if (params.id.length > 12) throw new Error('Artwork id out of range');
          return { id: params.id };
        },
      });

      /** Reads `uri` with the tracer stubbed; returns the outcome and what the read recorded. */
      async function read(uri: string, id: string) {
        const span = {
          setAttributes: vi.fn(),
          setAttribute: vi.fn(),
          setStatus: vi.fn(),
          recordException: vi.fn(),
          end: vi.fn(),
        };
        const tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue({
          startActiveSpan: (_name: string, cb: (s: unknown) => unknown) => cb(span),
        } as never);
        try {
          const handler = createResourceHandler(
            artwork as AnyResourceDefinition,
            services,
            notifiers,
          );
          const outcome = await handler(new URL(uri), { id }, makeServerContext()).then(
            (result) => ({ result, error: undefined }),
            (error: unknown) => ({ result: undefined, error }),
          );
          const recordOf = (message: string) =>
            mockLogger.info.mock.calls.findLast(([logged]) => logged === message)?.[1] as
              | Record<string, any>
              | undefined;
          return {
            ...outcome,
            completion: recordOf(TELEMETRY_LOG_MESSAGES.resourceReadFinished),
            handlerLine: recordOf('resource handler entered'),
            spanAttributes: Object.assign(
              {},
              ...span.setAttributes.mock.calls.map(([attributes]) => attributes),
            ) as Record<string, unknown>,
          };
        } finally {
          tracerSpy.mockRestore();
        }
      }

      it('records the first 1,024 characters and the uncut length on every record and the span', async () => {
        const id = '7'.repeat(200_000);
        const projection = `${BASE}${id}`;

        const { error, completion, handlerLine, spanAttributes } = await read(projection, id);

        expect(error).toBeInstanceOf(McpError);
        const capped = projection.slice(0, CAP);
        expect(completion?.resourceUri).toBe(capped);
        expect(completion?.resourceUriLength).toBe(200_017);
        expect(completion?.extra.metrics.uri).toBe(capped);
        expect(handlerLine?.resourceUri).toBe(capped);
        expect(handlerLine?.resourceUriLength).toBe(200_017);
        expect(spanAttributes['mcp.resource.uri']).toBe(capped);
        expect(spanAttributes['mcp.resource.uri_length']).toBe(200_017);
      });

      it.each([
        [CAP, false],
        [CAP + 1, true],
      ])('a %i-character projection is cut: %s', async (length, cut) => {
        const id = '4'.repeat(length - BASE.length);
        const projection = `${BASE}${id}`;

        const { completion, handlerLine, spanAttributes } = await read(projection, id);

        expect(completion?.resourceUri).toBe(projection.slice(0, CAP));
        for (const record of [completion, handlerLine]) {
          if (cut) expect(record?.resourceUriLength).toBe(length);
          else expect(record).not.toHaveProperty('resourceUriLength');
        }
        if (cut) expect(spanAttributes['mcp.resource.uri_length']).toBe(length);
        else expect(spanAttributes).not.toHaveProperty('mcp.resource.uri_length');
      });

      it('strips userinfo, query, and fragment before the cap applies', async () => {
        const id = '9'.repeat(2_000);
        const query = `?api_key=SUPERSECRET&pad=${'x'.repeat(5_000)}`;

        const long = await read(`artic://user:pw@artworks/${id}${query}#frag`, id);
        const short = await read(`artic://user:pw@artworks/42${query}#frag`, '42');

        expect(long.completion?.resourceUri).toBe(`${BASE}${id}`.slice(0, CAP));
        expect(long.completion?.resourceUriLength).toBe(BASE.length + id.length);
        expect(short.completion?.resourceUri).toBe(`${BASE}42`);
        expect(short.completion).not.toHaveProperty('resourceUriLength');
        expect(JSON.stringify(mockLogger.info.mock.calls)).not.toContain('SUPERSECRET');
      });

      it('hands the handler and the response the full URI, query included', async () => {
        const id = '5'.repeat(12);
        const uri = `${BASE}${id}?page=${'p'.repeat(3_000)}`;

        const { result, completion } = await read(uri, id);

        expect(completion).not.toHaveProperty('resourceUriLength');
        expect(seenUri).toBe(uri);
        expect(readContents(result!)[0]?.uri).toBe(uri);
      });

      it('keeps the full URI and the full response for a successful read past the cap', async () => {
        // A path under the handler's own id guard but over the cap needs a long
        // host, since the guard rejects ids past 12 digits.
        const host = `artworks${'h'.repeat(1_100)}`;
        const uri = `artic://${host}/42`;

        const { result, completion } = await read(uri, '42');

        expect(completion?.resourceUri).toHaveLength(CAP);
        expect(completion?.resourceUriLength).toBe(uri.length);
        expect(seenUri).toBe(uri);
        expect(readContents(result!)[0]?.uri).toBe(uri);
      });

      it('records a URI within the cap unchanged', async () => {
        const { completion, handlerLine, spanAttributes } = await read(`${BASE}42`, '42');

        expect(completion?.resourceUri).toBe(`${BASE}42`);
        expect(completion?.extra.metrics.uri).toBe(`${BASE}42`);
        expect(completion).not.toHaveProperty('resourceUriLength');
        expect(handlerLine?.resourceUri).toBe(`${BASE}42`);
        expect(handlerLine).not.toHaveProperty('resourceUriLength');
        expect(spanAttributes['mcp.resource.uri']).toBe(`${BASE}42`);
        expect(spanAttributes).not.toHaveProperty('mcp.resource.uri_length');
      });
    });
  });

  // -----------------------------------------------------------------------
  // List-changed notification routing (#135)
  // -----------------------------------------------------------------------

  describe('list-changed notification routing (#135)', () => {
    const notifyingResource = resource('notify://{id}', {
      description: 'Fires every list-changed notification.',
      params: z.object({ id: z.string().describe('id') }),
      handler: (_params, ctx) => {
        ctx.notifyToolListChanged?.();
        ctx.notifyResourceListChanged?.();
        ctx.notifyPromptListChanged?.();
        ctx.notifyResourceUpdated?.('notify://updated');
        return { ok: true };
      },
    });

    it('routes handler-time notifications through the request-scoped sender (relatedRequestId path)', async () => {
      const notify = vi.fn(async () => {});
      const handler = createResourceHandler(
        notifyingResource as AnyResourceDefinition,
        services,
        notifiers,
      );
      await handler(new URL('notify://1'), { id: '1' }, makeServerContext({ notify }));

      // Routing through `ctx.mcpReq.notify` stamps relatedRequestId, so the
      // message lands on this request's own response stream (#135).
      expect(notify).toHaveBeenCalledWith({ method: 'notifications/tools/list_changed' });
      expect(notify).toHaveBeenCalledWith({ method: 'notifications/resources/list_changed' });
      expect(notify).toHaveBeenCalledWith({ method: 'notifications/prompts/list_changed' });
      expect(notify).toHaveBeenCalledWith({
        method: 'notifications/resources/updated',
        params: { uri: 'notify://updated' },
      });
    });

    it('falls back to the server-level notifiers when the request scope exposes no sender', async () => {
      const serverNotifiers: NotifierSources = {
        notifyToolListChanged: vi.fn(),
        notifyResourceListChanged: vi.fn(),
        notifyPromptListChanged: vi.fn(),
        notifyResourceUpdated: vi.fn(),
      };
      const handler = createResourceHandler(
        notifyingResource as AnyResourceDefinition,
        services,
        serverNotifiers,
      );
      await handler(new URL('notify://1'), { id: '1' }, makeSenderlessServerContext());

      expect(serverNotifiers.notifyResourceListChanged).toHaveBeenCalledOnce();
      expect(serverNotifiers.notifyResourceUpdated).toHaveBeenCalledWith('notify://updated');
    });

    it('suppresses resources/updated for a URI the connection never subscribed to (#354)', async () => {
      const notify = vi.fn(async () => {});
      const subscriptions: ResourceSubscriptions = { has: vi.fn(() => false) };
      const handler = createResourceHandler(notifyingResource as AnyResourceDefinition, services, {
        subscriptions,
      });

      await handler(new URL('notify://1'), { id: '1' }, makeServerContext({ notify }));

      expect(subscriptions.has).toHaveBeenCalledWith('notify://updated');
      expect(notify).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: 'notifications/resources/updated' }),
      );
      expect(notify).toHaveBeenCalledWith({ method: 'notifications/tools/list_changed' });
    });
  });
});

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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import {
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

import type { ResourceSubscriptions } from '@/mcp-server/notifications.js';
import type { AnyResourceDefinition } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
import {
  createResourceHandler,
  type ResourceHandlerFactoryServices,
  type ResourceHandlerNotifiers,
} from '@/mcp-server/resources/utils/resourceHandlerFactory.js';

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

const mockStorage = {
  get: vi.fn(async () => null),
  set: vi.fn(async () => {}),
  delete: vi.fn(async () => {}),
  list: vi.fn(async () => ({ keys: [] })),
  getMany: vi.fn(async () => new Map()),
};

const services: ResourceHandlerFactoryServices = {
  logger: mockLogger as any,
  storage: mockStorage as any,
};

const notifiers: ResourceHandlerNotifiers = {};

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

    it('should default mimeType to application/json', async () => {
      const def = resource('plain://{id}', {
        description: 'No mimeType specified.',
        handler: () => ({ ok: true }),
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      const contents = readContents(
        await handler(new URL('plain://x'), { id: 'x' }, makeServerContext()),
      );

      expect(contents[0]!.mimeType).toBe('application/json');
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
    it('should set ctx.uri to the resource URI', async () => {
      let capturedUri: URL | undefined;

      const def = resource('scheme://{id}', {
        description: 'URI test.',
        handler: (_params, ctx) => {
          capturedUri = ctx.uri;
          return {};
        },
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      const uri = new URL('scheme://test-123');
      await handler(uri, { id: 'test-123' }, makeServerContext());

      expect(capturedUri).toBe(uri);
    });

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
          additionalContext: expect.objectContaining({ sessionId: 'sess-r' }),
          parentContext: expect.objectContaining({ sessionId: 'sess-r' }),
        }),
      );
    });

    it('carries the request scope id into RequestContext', async () => {
      const { requestContextService } = await import('@/utils/internal/requestContext.js');

      const def = resource('reqid://{id}', {
        description: 'Request id correlation.',
        handler: () => ({ ok: true }),
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      await handler(new URL('reqid://x'), { id: 'x' }, makeServerContext({ requestId: 'req-77' }));

      expect(requestContextService.createRequestContext).toHaveBeenCalledWith(
        expect.objectContaining({
          parentContext: expect.objectContaining({ requestId: 'req-77' }),
        }),
      );
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
      const optInServices: ResourceHandlerFactoryServices = {
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
    it('should reject invalid params by throwing (re-thrown for SDK)', async () => {
      const def = resource('strict://{count}', {
        description: 'Strict params.',
        params: z.object({ count: z.coerce.number().int().positive().describe('cnt') }),
        handler: () => ({ ok: true }),
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);

      await expect(
        handler(new URL('strict://abc'), { count: 'not-a-number' } as any, makeServerContext()),
      ).rejects.toThrow();
    });

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
      expect(err.message).toContain('at nctId');
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
    it('should re-throw errors (unlike tool handler which returns isError)', async () => {
      const def = resource('err://{id}', {
        description: 'Throws.',
        handler: () => {
          throw new Error('resource broke');
        },
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);

      await expect(handler(new URL('err://x'), { id: 'x' }, makeServerContext())).rejects.toThrow();
    });

    it('should re-throw McpError with code preserved', async () => {
      const def = resource('mcperr://{id}', {
        description: 'Throws McpError.',
        handler: () => {
          throw new McpError(JsonRpcErrorCode.NotFound, 'Resource not found');
        },
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);

      try {
        await handler(new URL('mcperr://x'), { id: 'x' }, makeServerContext());
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
      }
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
      const serverNotifiers: ResourceHandlerNotifiers = {
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

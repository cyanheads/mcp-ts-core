/**
 * @fileoverview Tests for createResourceHandler — the production handler factory
 * for all `resource()` builder definitions. Verifies context creation with uri,
 * param validation, error re-throwing, response formatting, and capability wrapping.
 * @module tests/mcp-server/resources/utils/resourceHandlerFactory.test
 */

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

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

type MockSdkContext = RequestHandlerExtra<ServerRequest, ServerNotification>;

function createMockSdkContext(overrides: Record<string, unknown> = {}): MockSdkContext {
  return {
    signal: new AbortController().signal,
    requestId: 'sdk-request-id',
    sendNotification: () => Promise.resolve(),
    sendRequest: () => Promise.resolve({}) as never,
    ...overrides,
  } as MockSdkContext;
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
      const result = await handler(uri, { itemId: 'item-42' }, createMockSdkContext());

      // Response
      expect(result.contents).toHaveLength(1);
      const content = result.contents[0]!;
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
      const result = await handler(new URL('custom://abc'), { id: 'abc' }, createMockSdkContext());

      expect((result.contents[0] as { text: string }).text).toBe('Custom: abc');
    });

    it('should default mimeType to application/json', async () => {
      const def = resource('plain://{id}', {
        description: 'No mimeType specified.',
        handler: () => ({ ok: true }),
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      const result = await handler(new URL('plain://x'), { id: 'x' }, createMockSdkContext());

      expect(result.contents[0]!.mimeType).toBe('application/json');
    });

    it('should pass string handler results through without JSON quote wrapping', async () => {
      const html = '<!DOCTYPE html><html><body>Hello</body></html>';
      const def = resource('ui://app/app.html', {
        description: 'Static app UI.',
        mimeType: 'text/html;profile=mcp-app',
        handler: () => html,
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      const result = await handler(new URL('ui://app/app.html'), {}, createMockSdkContext());

      expect(result.contents[0]).toMatchObject({
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
      const result = await handler(new URL('json://app/data'), {}, createMockSdkContext());

      expect(result.contents[0]).toMatchObject({
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
      await handler(uri, { id: 'test-123' }, createMockSdkContext());

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
      await handler(new URL('t://x'), { id: 'x' }, createMockSdkContext());

      expect(capturedTenant).toBe('default');
    });

    it('should wire elicit/sample from SDK context when available', async () => {
      let capturedCtx: any;
      const mockElicit = vi.fn();
      const mockCreate = vi.fn();

      const def = resource('cap://{id}', {
        description: 'Capability test.',
        handler: (_params, ctx) => {
          capturedCtx = ctx;
          return {};
        },
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      await handler(
        new URL('cap://x'),
        { id: 'x' },
        createMockSdkContext({ elicitInput: mockElicit, createMessage: mockCreate }),
      );

      expect(capturedCtx.elicit).toBeDefined();
      expect(capturedCtx.sample).toBeDefined();
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
      await handler(new URL('log://x'), { id: 'x' }, createMockSdkContext({ sessionId: 'sess-r' }));

      expect(requestContextService.createRequestContext).toHaveBeenCalledWith(
        expect.objectContaining({
          additionalContext: expect.objectContaining({ sessionId: 'sess-r' }),
          parentContext: expect.objectContaining({ sessionId: 'sess-r' }),
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
        createMockSdkContext({ sessionId: 'sess-stateful' }),
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
        createMockSdkContext({ sessionId: 'sess-auto' }),
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
        createMockSdkContext({ sessionId: 'sess-stateless' }),
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
        createMockSdkContext({ sessionId: 'sess-opt-in' }),
      );

      expect(getSessionId()).toBe('sess-opt-in');
    });

    it('leaves ctx.sessionId undefined when SDK provides none, in any mode', async () => {
      const { def, getSessionId } = makeSessionCapturingResource();
      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);

      for (const mode of ['stateful', 'auto', 'stateless'] as const) {
        mockConfig.mcpSessionMode = mode;
        await handler(new URL('session://x'), { id: 'x' }, createMockSdkContext());
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
        handler(new URL('strict://abc'), { count: 'not-a-number' } as any, createMockSdkContext()),
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
        createMockSdkContext(),
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
      await handler(new URL('loose://x'), { id: 'x', extra: 'field' }, createMockSdkContext());

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

      await expect(
        handler(new URL('err://x'), { id: 'x' }, createMockSdkContext()),
      ).rejects.toThrow();
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
        await handler(new URL('mcperr://x'), { id: 'x' }, createMockSdkContext());
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
      }
    });
  });

  describe('log payload redaction', () => {
    it('does not attach raw inputParams to the RequestContext', async () => {
      const { requestContextService } = await import('@/utils/internal/requestContext.js');

      const def = resource('resource://{itemId}', {
        description: 'Redaction test.',
        mimeType: 'application/json',
        params: z.object({ itemId: z.string().describe('id') }),
        handler: () => ({ itemId: 'safe' }),
      });

      const handler = createResourceHandler(def as AnyResourceDefinition, services, notifiers);
      await handler(
        new URL('resource://sensitive-item-id-value'),
        { itemId: 'sensitive-item-id-value' },
        createMockSdkContext(),
      );

      const call =
        vi
          .mocked(requestContextService.createRequestContext)
          .mock.calls.find(
            (args) => (args[0] as any)?.additionalContext?.operation === 'HandleResourceRead',
          ) ??
        vi
          .mocked(requestContextService.createRequestContext)
          .mock.calls.find((args) =>
            (args[0] as any)?.additionalContext?.resourceUri?.includes('sensitive'),
          );

      expect(call).toBeDefined();
      const additionalContext = (call![0] as any).additionalContext as Record<string, unknown>;
      expect(additionalContext).not.toHaveProperty('inputParams');
    });
  });
});

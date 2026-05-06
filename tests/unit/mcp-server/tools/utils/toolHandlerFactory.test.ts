/**
 * @fileoverview Tests for createToolHandler — the production handler factory
 * for all `tool()` builder definitions. Verifies the full plumbing chain:
 * input validation, context creation, auth checking, error classification,
 * response formatting, and capability wrapping.
 * @module tests/mcp-server/tools/utils/toolHandlerFactory.test
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

vi.mock('@/utils/internal/performance.js', () => ({
  measureToolExecution: vi.fn((fn: () => unknown) => fn()),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type { AnyToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import {
  createToolHandler,
  type HandlerFactoryServices,
  type HandlerNotifiers,
} from '@/mcp-server/tools/utils/toolHandlerFactory.js';

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

const services: HandlerFactoryServices = {
  logger: mockLogger as any,
  storage: mockStorage as any,
};

const notifiers: HandlerNotifiers = {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createToolHandler', () => {
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
    it('should validate input, call handler with Context, and return formatted response', async () => {
      let capturedCtx: any;

      const def = tool('echo_tool', {
        description: 'Echoes input.',
        input: z.object({ message: z.string().describe('msg') }),
        output: z.object({ echo: z.string().describe('echo') }),
        async handler(input, ctx) {
          capturedCtx = ctx;
          return { echo: input.message };
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({ message: 'hello' }, createMockSdkContext());

      // Response structure
      expect(result.structuredContent).toEqual({ echo: 'hello' });
      expect(result.content).toHaveLength(1);
      expect(result.content![0]!.type).toBe('text');
      expect(result.isError).toBeUndefined();

      // Context was created with correct fields
      expect(capturedCtx).toBeDefined();
      expect(capturedCtx.requestId).toBe('test-req-id');
      expect(typeof capturedCtx.log.info).toBe('function');
      expect(typeof capturedCtx.state.get).toBe('function');
      expect(capturedCtx.signal).toBeDefined();
    });

    it('should use custom format function when provided', async () => {
      const def = tool('formatted_tool', {
        description: 'Returns custom format.',
        input: z.object({ n: z.number().describe('num') }),
        output: z.object({ doubled: z.number().describe('result') }),
        handler: (input) => ({ doubled: input.n * 2 }),
        format: (result) => [{ type: 'text', text: `Result: ${result.doubled}` }],
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({ n: 5 }, createMockSdkContext());

      expect((result.content![0] as { text: string }).text).toBe('Result: 10');
    });

    it('should default to JSON stringify when no format is provided', async () => {
      const def = tool('json_tool', {
        description: 'Returns JSON.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: () => ({ ok: true }),
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, createMockSdkContext());

      const text = (result.content![0] as { text: string }).text;
      expect(JSON.parse(text)).toEqual({ ok: true });
    });
  });

  // -----------------------------------------------------------------------
  // Input validation
  // -----------------------------------------------------------------------

  describe('Input validation', () => {
    it('should reject invalid input with isError: true', async () => {
      const def = tool('strict_tool', {
        description: 'Requires a string.',
        input: z.object({ name: z.string().describe('name') }),
        output: z.object({ ok: z.boolean() }),
        handler: () => ({ ok: true }),
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({ name: 123 } as any, createMockSdkContext());

      expect(result.isError).toBe(true);
      // Input validation errors flow through the same error-shaping path:
      // structuredContent.error carries the code, message, and ZodError issues.
      const sc = result.structuredContent as {
        error: { code: number; data?: { issues?: unknown[] } };
      };
      expect(sc.error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(sc.error.data?.issues).toBeDefined();
    });

    it('should not call handler when input validation fails', async () => {
      const handlerFn = vi.fn(() => ({ ok: true }));
      const def = tool('guarded_tool', {
        description: 'Guarded.',
        input: z.object({ required: z.string().describe('r') }),
        output: z.object({ ok: z.boolean() }),
        handler: handlerFn,
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({} as any, createMockSdkContext());

      expect(handlerFn).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe('Error handling', () => {
    it('should catch plain Error and emit structuredContent.error with code + message', async () => {
      const def = tool('failing_tool', {
        description: 'Throws.',
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          throw new Error('something broke');
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, createMockSdkContext());

      expect(result.isError).toBe(true);
      expect((result.content![0] as { text: string }).text).toContain('something broke');
      // _meta.error is no longer emitted — error data lives on structuredContent.error
      expect(result._meta).toBeUndefined();
      // Plain errors get classified as InternalError, no data
      expect(result.structuredContent).toEqual({
        error: { code: JsonRpcErrorCode.InternalError, message: 'something broke' },
      });
    });

    it('should catch McpError and surface code + message + data via structuredContent.error', async () => {
      const def = tool('mcp_error_tool', {
        description: 'Throws McpError.',
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          throw new McpError(JsonRpcErrorCode.NotFound, 'Item not found', { id: '123' });
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, createMockSdkContext());

      expect(result.isError).toBe(true);
      expect((result.content![0] as { text: string }).text).toContain('Item not found');
      expect(result._meta).toBeUndefined();
      expect(result.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message: 'Item not found',
          data: { id: '123' },
        },
      });
    });

    it('should handle ZodError from handler (not input validation) as error', async () => {
      const def = tool('zod_throw_tool', {
        description: 'Internal Zod parse fails.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler: () => {
          // Simulate handler internally parsing bad data
          z.object({ required: z.string() }).parse({});
          return { ok: true };
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, createMockSdkContext());

      expect(result.isError).toBe(true);
      // ZodError data.issues should appear in structuredContent.error
      const sc = result.structuredContent as { error: { data?: { issues?: unknown[] } } };
      expect(sc.error.data?.issues).toBeDefined();
    });

    it('should propagate McpError code, message, and data via structuredContent.error', async () => {
      const errorData = { field: 'email', constraint: 'format' };

      const def = tool('meta_error_tool', {
        description: 'McpError with data.',
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          throw new McpError(JsonRpcErrorCode.ValidationError, 'Validation failed', errorData);
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, createMockSdkContext());

      expect(result.isError).toBe(true);
      expect(result._meta).toBeUndefined();
      expect(result.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message: 'Validation failed',
          data: errorData,
        },
      });
      const text = (result.content![0] as { text: string }).text;
      expect(text).toContain('Validation failed');
    });

    it('should handle non-Error throws (string)', async () => {
      const def = tool('string_throw_tool', {
        description: 'Throws a string.',
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          throw 'raw string error';
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, createMockSdkContext());

      expect(result.isError).toBe(true);
      expect(result._meta).toBeUndefined();
      const sc = result.structuredContent as { error: { code: number; message: string } };
      expect(sc.error.code).toBeDefined();
    });

    it('should mirror data.recovery.hint into content[] text when present', async () => {
      const def = tool('recovery_tool', {
        description: 'Throws with recovery hint.',
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          throw new McpError(JsonRpcErrorCode.NotFound, 'No items returned', {
            reason: 'no_match',
            recovery: { hint: 'Try the search tool with broader terms.' },
          });
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, createMockSdkContext());

      expect(result.isError).toBe(true);
      const text = (result.content![0] as { text: string }).text;
      // content[] text carries the recovery hint for format()-only clients (Claude Desktop)
      expect(text).toContain('No items returned');
      expect(text).toContain('Recovery: Try the search tool with broader terms.');
      // structuredContent.error.data.recovery.hint carries the hint for structuredContent-only clients (Claude Code)
      const sc = result.structuredContent as {
        error: { data?: { recovery?: { hint?: string } } };
      };
      expect(sc.error.data?.recovery?.hint).toBe('Try the search tool with broader terms.');
    });

    it('should not append recovery section when data.recovery.hint is missing', async () => {
      const def = tool('no_recovery_tool', {
        description: 'Throws without recovery hint.',
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          throw new McpError(JsonRpcErrorCode.InternalError, 'Boom', { reason: 'boom' });
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, createMockSdkContext());

      const text = (result.content![0] as { text: string }).text;
      expect(text).toBe('Error: Boom');
      expect(text).not.toContain('Recovery:');
    });

    it('should ignore non-string recovery.hint', async () => {
      const def = tool('bad_recovery_tool', {
        description: 'Throws with malformed recovery.',
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          throw new McpError(JsonRpcErrorCode.InternalError, 'Boom', {
            recovery: { hint: 42 },
          });
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, createMockSdkContext());

      const text = (result.content![0] as { text: string }).text;
      expect(text).toBe('Error: Boom');
    });
  });

  // -----------------------------------------------------------------------
  // Context construction
  // -----------------------------------------------------------------------

  describe('Context construction', () => {
    it('should create Context with tenantId defaulted to "default" (no auth)', async () => {
      let capturedCtx: any;

      const def = tool('ctx_tool', {
        description: 'Captures context.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler: (_input, ctx) => {
          capturedCtx = ctx;
          return { ok: true };
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({}, createMockSdkContext());

      // Without auth, tenantId should be defaulted to 'default' by createContext
      expect(capturedCtx.tenantId).toBe('default');
    });

    it('should wire ctx.signal from SDK context', async () => {
      let capturedSignal: AbortSignal | undefined;
      const controller = new AbortController();

      const def = tool('signal_tool', {
        description: 'Checks signal.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler: (_input, ctx) => {
          capturedSignal = ctx.signal;
          return { ok: true };
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({}, createMockSdkContext({ signal: controller.signal }));

      expect(capturedSignal).toBe(controller.signal);
    });
  });

  // -----------------------------------------------------------------------
  // Capability detection (elicit / sample)
  // -----------------------------------------------------------------------

  describe('Capability detection', () => {
    it('should wrap elicitInput when SDK context has it', async () => {
      let capturedCtx: any;
      const mockElicitInput = vi.fn(async () => ({
        action: 'accept' as const,
        data: { format: 'json' },
      }));

      const def = tool('elicit_tool', {
        description: 'Uses elicitation.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler: (_input, ctx) => {
          capturedCtx = ctx;
          return { ok: true };
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({}, createMockSdkContext({ elicitInput: mockElicitInput }));

      expect(capturedCtx.elicit).toBeDefined();
      expect(typeof capturedCtx.elicit).toBe('function');
    });

    it('should leave elicit undefined when SDK context lacks elicitInput', async () => {
      let capturedCtx: any;

      const def = tool('no_elicit_tool', {
        description: 'No elicitation.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler: (_input, ctx) => {
          capturedCtx = ctx;
          return { ok: true };
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({}, createMockSdkContext());

      expect(capturedCtx.elicit).toBeUndefined();
    });

    it('should wrap createMessage when SDK context has it', async () => {
      let capturedCtx: any;
      const mockCreateMessage = vi.fn(async () => ({
        role: 'assistant',
        content: { type: 'text', text: 'hi' },
        model: 'test',
      }));

      const def = tool('sample_tool', {
        description: 'Uses sampling.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler: (_input, ctx) => {
          capturedCtx = ctx;
          return { ok: true };
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({}, createMockSdkContext({ createMessage: mockCreateMessage }));

      expect(capturedCtx.sample).toBeDefined();
      expect(typeof capturedCtx.sample).toBe('function');
    });

    it('should leave sample undefined when SDK context lacks createMessage', async () => {
      let capturedCtx: any;

      const def = tool('no_sample_tool', {
        description: 'No sampling.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler: (_input, ctx) => {
          capturedCtx = ctx;
          return { ok: true };
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({}, createMockSdkContext());

      expect(capturedCtx.sample).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Session extraction & durability gate
  // -----------------------------------------------------------------------

  describe('Session extraction', () => {
    /**
     * Builds a tool whose handler captures `ctx.sessionId` for assertion.
     * Returned `getSessionId()` reads it after the handler ran.
     */
    function makeSessionCapturingTool() {
      let captured: string | undefined;
      const def = tool('session_capture_tool', {
        description: 'Captures ctx.sessionId.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler: (_input, ctx) => {
          captured = ctx.sessionId;
          return { ok: true };
        },
      });
      return { def, getSessionId: () => captured };
    }

    it('always forwards sessionId into RequestContext for log correlation', async () => {
      // Even with the strictest gate (stateless + no opt-in), the raw SDK
      // sessionId still flows into the RequestContext for tracing — so logs
      // can correlate against the SDK's per-request token regardless of
      // whether the handler sees it on `ctx.sessionId`.
      mockConfig.mcpSessionMode = 'stateless';
      const { requestContextService } = await import('@/utils/internal/requestContext.js');

      const def = tool('session_log_tool', {
        description: 'Log correlation test.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler: () => ({ ok: true }),
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({}, createMockSdkContext({ sessionId: 'sess-abc' }));

      expect(requestContextService.createRequestContext).toHaveBeenCalledWith(
        expect.objectContaining({
          additionalContext: expect.objectContaining({ sessionId: 'sess-abc' }),
          parentContext: expect.objectContaining({ sessionId: 'sess-abc' }),
        }),
      );
    });

    it('surfaces ctx.sessionId in stateful HTTP mode', async () => {
      mockConfig.mcpSessionMode = 'stateful';
      const { def, getSessionId } = makeSessionCapturingTool();

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({}, createMockSdkContext({ sessionId: 'sess-stateful' }));

      expect(getSessionId()).toBe('sess-stateful');
    });

    it('surfaces ctx.sessionId in auto mode (resolves to stateful for HTTP)', async () => {
      mockConfig.mcpSessionMode = 'auto';
      const { def, getSessionId } = makeSessionCapturingTool();

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({}, createMockSdkContext({ sessionId: 'sess-auto' }));

      expect(getSessionId()).toBe('sess-auto');
    });

    it('hides ctx.sessionId in stateless mode by default (fail-closed)', async () => {
      mockConfig.mcpSessionMode = 'stateless';
      const { def, getSessionId } = makeSessionCapturingTool();

      // Default services — no exposeStatelessSessionId opt-in.
      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({}, createMockSdkContext({ sessionId: 'sess-stateless' }));

      expect(getSessionId()).toBeUndefined();
    });

    it('surfaces ctx.sessionId in stateless mode when exposeStatelessSessionId is true', async () => {
      mockConfig.mcpSessionMode = 'stateless';
      const optInServices: HandlerFactoryServices = {
        ...services,
        exposeStatelessSessionId: true,
      };
      const { def, getSessionId } = makeSessionCapturingTool();

      const handler = createToolHandler(def as AnyToolDefinition, optInServices, notifiers);
      await handler({}, createMockSdkContext({ sessionId: 'sess-opt-in' }));

      expect(getSessionId()).toBe('sess-opt-in');
    });

    it('leaves ctx.sessionId undefined when SDK provides none, in any mode', async () => {
      const { def, getSessionId } = makeSessionCapturingTool();
      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);

      for (const mode of ['stateful', 'auto', 'stateless'] as const) {
        mockConfig.mcpSessionMode = mode;
        // No sessionId on the SDK extra (e.g. stdio).
        await handler({}, createMockSdkContext());
        expect(getSessionId()).toBeUndefined();
      }
    });
  });

  describe('log payload redaction', () => {
    it('does not attach raw input to the RequestContext', async () => {
      const { requestContextService } = await import('@/utils/internal/requestContext.js');

      const def = tool('redact_tool', {
        description: 'Input redaction test.',
        input: z.object({ secret: z.string().describe('secret') }),
        output: z.object({ ok: z.boolean() }),
        handler: () => ({ ok: true }),
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({ secret: 'super-sensitive-value' }, createMockSdkContext());

      const call = vi
        .mocked(requestContextService.createRequestContext)
        .mock.calls.find((args) => (args[0] as any)?.additionalContext?.toolName === 'redact_tool');

      expect(call).toBeDefined();
      const additionalContext = (call![0] as any).additionalContext as Record<string, unknown>;
      expect(additionalContext).not.toHaveProperty('input');
      expect(JSON.stringify(additionalContext)).not.toContain('super-sensitive-value');
    });
  });
});

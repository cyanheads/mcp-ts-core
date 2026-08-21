/**
 * @fileoverview Tests for createToolHandler — the production handler factory
 * for all `tool()` builder definitions. Verifies the full plumbing chain:
 * input validation, context creation, auth checking, error classification,
 * response formatting, and capability wrapping.
 * @module tests/mcp-server/tools/utils/toolHandlerFactory.test
 */

import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/server';
import { inputRequired } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import type { ServerContextOverrides } from '../../../../helpers/server-context.js';
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

vi.mock('@/utils/internal/performance.js', () => ({
  // Passes the span-bound context through, as the real implementation does —
  // the handler factory builds its `ctx` from that argument. The second
  // argument designates the payload the output-size metrics measure; this stub
  // records nothing.
  measureToolExecution: vi.fn(
    (
      fn: (spanContext: unknown, recordOutput: (payload: unknown) => void) => unknown,
      context: unknown,
    ) => fn(context, () => {}),
  ),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type { AnyToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import {
  advertisedOutputSchema,
  buildToolErrorResult,
  createToolHandler,
  effectiveOutputSchema,
  type HandlerFactoryServices,
  type HandlerNotifiers,
} from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { measureToolExecution } from '@/utils/internal/performance.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** What `createToolHandler` resolves with: a tool result, or `input_required`. */
type HandlerResult = Awaited<ReturnType<ReturnType<typeof createToolHandler>>>;

/**
 * First `content[]` block of a completed tool result. Narrows off the
 * `input_required` branch of the union, which carries no `content`.
 */
function firstBlock(result: HandlerResult): ContentBlock {
  return (result as CallToolResult).content![0]!;
}

/**
 * A `ctx.mcpReq.log` sink typed with the SDK's real signature, so the
 * `toHaveBeenCalledWith(level, data)` assertions are arity-checked.
 */
function makeWireLog(
  impl: NonNullable<ServerContextOverrides['log']> = async () => {},
): ReturnType<typeof vi.fn<NonNullable<ServerContextOverrides['log']>>> {
  return vi.fn(impl);
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
      const result = await handler({ message: 'hello' }, makeServerContext());

      // Response structure
      expect(result.structuredContent).toEqual({ echo: 'hello' });
      expect(result.content).toHaveLength(1);
      expect(firstBlock(result).type).toBe('text');
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
      const result = await handler({ n: 5 }, makeServerContext());

      expect((firstBlock(result) as { text: string }).text).toBe('Result: 10');
    });

    it('should default to JSON stringify when no format is provided', async () => {
      const def = tool('json_tool', {
        description: 'Returns JSON.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: () => ({ ok: true }),
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, makeServerContext());

      const text = (firstBlock(result) as { text: string }).text;
      expect(JSON.parse(text)).toEqual({ ok: true });
    });

    it.each([
      [
        'Error',
        () => {
          throw new Error('formatter error');
        },
        'formatter error',
      ],
      [
        'non-Error',
        () => {
          throw 'formatter string';
        },
        'formatter string',
      ],
    ])('should classify %s formatter failures as tool errors', async (_kind, format, message) => {
      const def = tool('bad_formatter_tool', {
        description: 'Formatter failure.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: () => ({ ok: true }),
        format,
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, makeServerContext());

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { message: `Output formatting failed: ${message}` },
      });
    });

    it('should prepend handler-collected media to formatted content', async () => {
      const def = tool('media_tool', {
        description: 'Collects media.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: (_input, ctx) => {
          ctx.content.image('aW1hZ2U=', 'image/png');
          return { ok: true };
        },
        format: () => [{ type: 'text', text: 'done' }],
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, makeServerContext());

      expect(result.content).toEqual([
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
        { type: 'text', text: 'done' },
      ]);
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
      const result = await handler({ name: 123 } as any, makeServerContext());

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
      await handler({} as any, makeServerContext());

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
      const result = await handler({}, makeServerContext());

      expect(result.isError).toBe(true);
      expect((firstBlock(result) as { text: string }).text).toContain('something broke');
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
      const result = await handler({}, makeServerContext());

      expect(result.isError).toBe(true);
      expect((firstBlock(result) as { text: string }).text).toContain('Item not found');
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
      const result = await handler({}, makeServerContext());

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
      const result = await handler({}, makeServerContext());

      expect(result.isError).toBe(true);
      expect(result._meta).toBeUndefined();
      expect(result.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message: 'Validation failed',
          data: errorData,
        },
      });
      const text = (firstBlock(result) as { text: string }).text;
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
      const result = await handler({}, makeServerContext());

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
      const result = await handler({}, makeServerContext());

      expect(result.isError).toBe(true);
      const text = (firstBlock(result) as { text: string }).text;
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
      const result = await handler({}, makeServerContext());

      const text = (firstBlock(result) as { text: string }).text;
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
      const result = await handler({}, makeServerContext());

      const text = (firstBlock(result) as { text: string }).text;
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
      await handler({}, makeServerContext());

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
      await handler({}, makeServerContext({ signal: controller.signal }));

      expect(capturedSignal).toBe(controller.signal);
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
      await handler({}, makeServerContext({ sessionId: 'sess-abc' }));

      expect(requestContextService.createRequestContext).toHaveBeenCalledWith(
        expect.objectContaining({
          parentContext: expect.objectContaining({ sessionId: 'sess-abc' }),
        }),
      );
    });

    it('surfaces ctx.sessionId in stateful HTTP mode', async () => {
      mockConfig.mcpSessionMode = 'stateful';
      const { def, getSessionId } = makeSessionCapturingTool();

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({}, makeServerContext({ sessionId: 'sess-stateful' }));

      expect(getSessionId()).toBe('sess-stateful');
    });

    it('surfaces ctx.sessionId in auto mode (resolves to stateful for HTTP)', async () => {
      mockConfig.mcpSessionMode = 'auto';
      const { def, getSessionId } = makeSessionCapturingTool();

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({}, makeServerContext({ sessionId: 'sess-auto' }));

      expect(getSessionId()).toBe('sess-auto');
    });

    it('hides ctx.sessionId in stateless mode by default (fail-closed)', async () => {
      mockConfig.mcpSessionMode = 'stateless';
      const { def, getSessionId } = makeSessionCapturingTool();

      // Default services — no exposeStatelessSessionId opt-in.
      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({}, makeServerContext({ sessionId: 'sess-stateless' }));

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
      await handler({}, makeServerContext({ sessionId: 'sess-opt-in' }));

      expect(getSessionId()).toBe('sess-opt-in');
    });

    it('leaves ctx.sessionId undefined when SDK provides none, in any mode', async () => {
      const { def, getSessionId } = makeSessionCapturingTool();
      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);

      for (const mode of ['stateful', 'auto', 'stateless'] as const) {
        mockConfig.mcpSessionMode = mode;
        // No sessionId on the SDK extra (e.g. stdio).
        await handler({}, makeServerContext());
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
      await handler({ secret: 'super-sensitive-value' }, makeServerContext());

      const call = vi
        .mocked(requestContextService.createRequestContext)
        .mock.calls.find((args) => (args[0] as any)?.additionalContext?.toolName === 'redact_tool');

      expect(call).toBeDefined();
      const additionalContext = (call![0] as any).additionalContext as Record<string, unknown>;
      expect(additionalContext).not.toHaveProperty('input');
      expect(JSON.stringify(additionalContext)).not.toContain('super-sensitive-value');
    });
  });

  // -----------------------------------------------------------------------
  // List-changed notification routing (#135)
  // -----------------------------------------------------------------------

  describe('list-changed notification routing (#135)', () => {
    const notifyingTool = tool('notify_tool', {
      description: 'Fires every list-changed notification.',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handler: (_input, ctx) => {
        ctx.notifyToolListChanged?.();
        ctx.notifyResourceListChanged?.();
        ctx.notifyPromptListChanged?.();
        ctx.notifyResourceUpdated?.('items://42');
        return { ok: true };
      },
    });

    it('routes handler-time notifications through the request-scoped sender (relatedRequestId path)', async () => {
      const notify = vi.fn(async () => {});
      const handler = createToolHandler(notifyingTool as AnyToolDefinition, services, notifiers);
      await handler({}, makeServerContext({ notify }));

      // Routing through ctx.mcpReq.notify is what stamps relatedRequestId, so
      // the message lands on this request's own response stream (#135).
      expect(notify).toHaveBeenCalledWith({ method: 'notifications/tools/list_changed' });
      expect(notify).toHaveBeenCalledWith({ method: 'notifications/resources/list_changed' });
      expect(notify).toHaveBeenCalledWith({ method: 'notifications/prompts/list_changed' });
      expect(notify).toHaveBeenCalledWith({
        method: 'notifications/resources/updated',
        params: { uri: 'items://42' },
      });
    });

    it('falls back to the server-level notifiers when the request scope exposes no sender', async () => {
      const serverNotifiers: HandlerNotifiers = {
        notifyToolListChanged: vi.fn(),
        notifyResourceListChanged: vi.fn(),
        notifyPromptListChanged: vi.fn(),
        notifyResourceUpdated: vi.fn(),
      };
      const handler = createToolHandler(
        notifyingTool as AnyToolDefinition,
        services,
        serverNotifiers,
      );
      await handler({}, makeSenderlessServerContext());

      expect(serverNotifiers.notifyToolListChanged).toHaveBeenCalledOnce();
      expect(serverNotifiers.notifyResourceListChanged).toHaveBeenCalledOnce();
      expect(serverNotifiers.notifyPromptListChanged).toHaveBeenCalledOnce();
      expect(serverNotifiers.notifyResourceUpdated).toHaveBeenCalledWith('items://42');
    });

    it('does not let a failed notification flush reject the handler', async () => {
      const notify = vi.fn(() => Promise.reject(new Error('stream closed')));
      const handler = createToolHandler(notifyingTool as AnyToolDefinition, services, notifiers);

      const result = await handler({}, makeServerContext({ notify }));

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ ok: true });
    });
  });

  // -----------------------------------------------------------------------
  // Subscription-scoped resource updates (#354)
  // -----------------------------------------------------------------------

  describe('notifyResourceUpdated subscription gate (#354)', () => {
    const updatingTool = tool('update_tool', {
      description: 'Announces a resource update.',
      input: z.object({ uri: z.string().describe('uri') }),
      output: z.object({ ok: z.boolean() }),
      handler: (input, ctx) => {
        ctx.notifyResourceUpdated?.(input.uri);
        return { ok: true };
      },
    });

    /** A `resources/subscribe` registry holding exactly the listed URIs. */
    function subscriptionsFor(...uris: string[]) {
      return { has: vi.fn((uri: string) => uris.includes(uri)) };
    }

    it('suppresses the notification for a URI the client never subscribed to', async () => {
      const notify = vi.fn(async () => {});
      const subscriptions = subscriptionsFor('items://subscribed');
      const handler = createToolHandler(updatingTool as AnyToolDefinition, services, {
        subscriptions,
      });

      await handler({ uri: 'items://other' }, makeServerContext({ notify }));

      expect(subscriptions.has).toHaveBeenCalledWith('items://other');
      expect(notify).not.toHaveBeenCalled();
    });

    it('emits the notification for a subscribed URI', async () => {
      const notify = vi.fn(async () => {});
      const handler = createToolHandler(updatingTool as AnyToolDefinition, services, {
        subscriptions: subscriptionsFor('items://subscribed'),
      });

      await handler({ uri: 'items://subscribed' }, makeServerContext({ notify }));

      expect(notify).toHaveBeenCalledWith({
        method: 'notifications/resources/updated',
        params: { uri: 'items://subscribed' },
      });
    });

    it('emits every URI when no subscription registry is available', async () => {
      // No `subscriptions` means no per-connection tracking to consult — the
      // gate is skipped rather than defaulting to "nothing is subscribed".
      const notify = vi.fn(async () => {});
      const handler = createToolHandler(updatingTool as AnyToolDefinition, services, notifiers);

      await handler({ uri: 'items://untracked' }, makeServerContext({ notify }));

      expect(notify).toHaveBeenCalledWith({
        method: 'notifications/resources/updated',
        params: { uri: 'items://untracked' },
      });
    });
  });

  // -----------------------------------------------------------------------
  // Multi-round-trip input (ctx.requestInput / ctx.inputs)
  // -----------------------------------------------------------------------

  describe('ctx.requestInput', () => {
    const confirmSchema = z.object({ confirm: z.boolean().describe('confirm') });

    /** Asks for confirmation on the first round; echoes it back on the retry. */
    const confirmingTool = tool('confirming_tool', {
      description: 'Requests confirmation before acting.',
      input: z.object({ path: z.string().describe('path') }),
      output: z.object({ confirmed: z.boolean().describe('confirmed') }),
      handler: (input, ctx) => {
        const accepted = ctx.inputs.accepted('confirm', confirmSchema);
        if (!accepted) {
          ctx.requestInput({
            inputRequests: {
              confirm: inputRequired.elicit({
                message: `Delete ${input.path}?`,
                requestedSchema: confirmSchema,
              }),
            },
            requestState: 'round-1',
          });
        }
        // `requestInput` never returns — past the guard the value is present.
        return { confirmed: (accepted as { confirm: boolean }).confirm };
      },
    });

    it('returns the SDK input_required result rather than an isError envelope', async () => {
      const handleError = vi.spyOn(ErrorHandler, 'handleError');
      const handler = createToolHandler(confirmingTool as AnyToolDefinition, services, notifiers);

      const result = (await handler({ path: '/tmp/x' }, makeServerContext())) as Record<
        string,
        any
      >;

      // Protocol control flow, not a failure: no isError, no error envelope,
      // and the classifier/telemetry path is never entered.
      expect(result.resultType).toBe('input_required');
      expect(result.requestState).toBe('round-1');
      expect(result.inputRequests.confirm.method).toBe('elicitation/create');
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toBeUndefined();
      expect(handleError).not.toHaveBeenCalled();
      handleError.mockRestore();
    });

    it('completes normally once the retry carries the accepted response', async () => {
      const handler = createToolHandler(confirmingTool as AnyToolDefinition, services, notifiers);

      const result = await handler(
        { path: '/tmp/x' },
        makeServerContext({
          inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
          requestState: 'round-1',
        }),
      );

      expect(result.structuredContent).toEqual({ confirmed: true });
      expect(result.isError).toBeUndefined();
    });
  });

  describe('ctx.inputs', () => {
    const confirmSchema = z.object({ confirm: z.boolean().describe('confirm') });

    /** Runs a probe handler against a request scope and returns what it read. */
    async function readInputs(
      overrides: Parameters<typeof makeServerContext>[0],
      read: (ctx: any) => unknown,
    ): Promise<unknown> {
      let captured: unknown;
      const def = tool('inputs_probe', {
        description: 'Reads ctx.inputs.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler: (_input, ctx) => {
          captured = read(ctx);
          return { ok: true };
        },
      });
      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, makeServerContext(overrides));
      expect(result.isError).toBeUndefined();
      return captured;
    }

    it('returns the validated content of an accepted response', async () => {
      const accepted = await readInputs(
        { inputResponses: { confirm: { action: 'accept', content: { confirm: true } } } },
        (ctx) => ctx.inputs.accepted('confirm', confirmSchema),
      );

      expect(accepted).toEqual({ confirm: true });
    });

    it.each([
      ['declined', { confirm: { action: 'decline' } }],
      ['cancelled', { confirm: { action: 'cancel' } }],
      ['missing', { other: { action: 'accept', content: { confirm: true } } }],
      ['schema-invalid', { confirm: { action: 'accept', content: { confirm: 'yes' } } }],
    ])('returns undefined for a %s entry', async (_kind, inputResponses) => {
      // Every `undefined` reads the same to a handler: re-issue, or give up.
      const accepted = await readInputs({ inputResponses }, (ctx) =>
        ctx.inputs.accepted('confirm', confirmSchema),
      );

      expect(accepted).toBeUndefined();
    });

    it('returns undefined when the request carried no responses at all', async () => {
      const accepted = await readInputs({}, (ctx) => ctx.inputs.accepted('confirm', confirmSchema));

      expect(accepted).toBeUndefined();
    });

    it.each([
      [
        'elicit',
        { confirm: { action: 'accept', content: { confirm: true } } },
        { kind: 'elicit', action: 'accept', content: { confirm: true } },
      ],
      [
        'sampling',
        { confirm: { role: 'assistant', content: { type: 'text', text: 'hi' }, model: 'test' } },
        {
          kind: 'sampling',
          result: { role: 'assistant', content: { type: 'text', text: 'hi' }, model: 'test' },
        },
      ],
      [
        'roots',
        { confirm: { roots: [{ uri: 'file:///work' }] } },
        { kind: 'roots', roots: [{ uri: 'file:///work' }] },
      ],
    ])('discriminates a %s response via view()', async (_kind, inputResponses, expected) => {
      const view = await readInputs({ inputResponses }, (ctx) => ctx.inputs.view('confirm'));

      expect(view).toEqual(expected);
    });

    it('reads a missing key as { kind: "missing" }', async () => {
      const view = await readInputs({}, (ctx) => ctx.inputs.view('confirm'));

      expect(view).toEqual({ kind: 'missing' });
    });

    it('surfaces the SDK-dropped keys and the round-trip request state', async () => {
      const seen = await readInputs(
        { droppedInputResponseKeys: ['confirm'], requestState: 'round-2' },
        (ctx) => ({ dropped: [...ctx.inputs.dropped], state: ctx.inputs.state() }),
      );

      expect(seen).toEqual({ dropped: ['confirm'], state: 'round-2' });
    });
  });

  // -----------------------------------------------------------------------
  // ctx.log → notifications/message mirroring
  // -----------------------------------------------------------------------

  describe('ctx.log wire mirroring', () => {
    /** Runs a tool whose handler logs once against the supplied wire sink. */
    async function logOnce(emit: (ctx: any) => void, log = makeWireLog()) {
      const def = tool('logging_tool', {
        description: 'Logs from the handler.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler: (_input, ctx) => {
          emit(ctx);
          return { ok: true };
        },
      });
      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, makeServerContext({ log }));
      return { log, result };
    }

    it.each([
      ['debug', (ctx: any) => ctx.log.debug('msg', { k: 1 })],
      ['info', (ctx: any) => ctx.log.info('msg', { k: 1 })],
      ['notice', (ctx: any) => ctx.log.notice('msg', { k: 1 })],
      ['warning', (ctx: any) => ctx.log.warning('msg', { k: 1 })],
      ['error', (ctx: any) => ctx.log.error('msg', undefined, { k: 1 })],
    ])('mirrors ctx.log.%s onto ctx.mcpReq.log at the RFC 5424 level', async (level, emit) => {
      const { log } = await logOnce(emit);

      expect(log).toHaveBeenCalledWith(level, { message: 'msg', k: 1 });
    });

    it('carries the Error message alongside the data on the error level', async () => {
      const { log } = await logOnce((ctx) => ctx.log.error('failed', new Error('boom'), { k: 1 }));

      expect(log).toHaveBeenCalledWith('error', { message: 'failed', k: 1, error: 'boom' });
    });

    it('sends the message alone when the call carried no data payload', async () => {
      const { log } = await logOnce((ctx) => ctx.log.info('bare'));

      expect(log).toHaveBeenCalledWith('info', { message: 'bare' });
    });

    it('still writes to the process logger', async () => {
      await logOnce((ctx) => ctx.log.info('msg', { k: 1 }));

      expect(mockLogger.info).toHaveBeenCalledWith(
        'msg',
        expect.objectContaining({ extra: expect.objectContaining({ k: 1 }) }),
      );
    });

    it('does not fail the handler when the wire log rejects', async () => {
      // A log that cannot flush (client gone, stream never upgraded) must never
      // turn a successful tool call into an error.
      const rejecting = makeWireLog(async () => {
        throw new Error('stream closed');
      });
      const { result } = await logOnce((ctx) => ctx.log.warning('degraded'), rejecting);

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ ok: true });
    });
  });

  // -----------------------------------------------------------------------
  // Advertised vs. effective output schema (#241)
  // -----------------------------------------------------------------------

  describe('advertisedOutputSchema (#241)', () => {
    const searchTool = tool('advertised_search', {
      description: 'Search with a declared error contract.',
      input: z.object({ q: z.string().describe('q') }),
      output: z.object({
        items: z.array(z.string()).describe('matches'),
        cursor: z.string().optional().describe('next page cursor'),
      }),
      enrichment: { totalCount: z.number().describe('total before limit') },
      errors: [
        {
          reason: 'no_match',
          code: JsonRpcErrorCode.NotFound,
          when: 'No items match the query',
          recovery: 'Broaden the query and try again.',
        },
        {
          reason: 'rate_limited',
          code: JsonRpcErrorCode.RateLimited,
          when: 'Upstream rate limit hit',
          retryable: true,
          recovery: 'Wait a few seconds before retrying.',
        },
      ],
      handler: (_input, ctx) => {
        ctx.enrich.total(0);
        return { items: [] };
      },
    });

    const plainTool = tool('advertised_plain', {
      description: 'Search with no declared error contract.',
      input: z.object({ q: z.string().describe('q') }),
      output: z.object({ items: z.array(z.string()).describe('matches') }),
      handler: () => ({ items: [] }),
    });

    /** The JSON Schema a client actually receives in `tools/list`. */
    function emitted(def: AnyToolDefinition): Record<string, any> {
      return z.toJSONSchema(advertisedOutputSchema(def)) as Record<string, any>;
    }

    it('keeps the root an object rather than an anyOf-only union', () => {
      // A discriminated union emits `anyOf` with no `type`, which SEP-2106's
      // legacy projection rewrites to `{ result: … }` — breaking the success
      // path for 2025-era clients to fix the error path.
      const schema = emitted(searchTool as AnyToolDefinition);

      expect(schema.type).toBe('object');
      expect(schema.oneOf).toBeUndefined();
    });

    it('makes every success field optional so an error envelope can never be missing one', () => {
      const schema = emitted(searchTool as AnyToolDefinition);

      expect(schema.required).toBeUndefined();
      expect(Object.keys(schema.properties).sort()).toEqual([
        'cursor',
        'error',
        'items',
        'totalCount',
      ]);
    });

    it('declares the error envelope with code, message, and a loose optional data', () => {
      const error = emitted(searchTool as AnyToolDefinition).properties.error;

      expect(error.type).toBe('object');
      expect(error.required).toEqual(['code', 'message']);
      expect(error.properties.data.type).toBe('object');
      // Loose at every level — a throw site's arbitrary keys must not recreate
      // on the error path the very -32602 this envelope exists to prevent.
      expect(error.additionalProperties).toEqual({});
      expect(error.properties.data.additionalProperties).toEqual({});
      expect(error.required).not.toContain('data');
    });

    it("documents the definition's declared reasons without constraining data.reason", () => {
      const reason = emitted(searchTool as AnyToolDefinition).properties.error.properties.data
        .properties.reason;

      // Annotations, not a constraint. An enum would reject every failure a
      // service raises below the handler with its own `data.reason` — the very
      // `-32602` the widened schema exists to prevent.
      expect(reason.enum).toBeUndefined();
      expect(reason.type).toBe('string');
      expect(reason.examples).toEqual(['no_match', 'rate_limited']);
      expect(reason.description).toContain('no_match');
      expect(reason.description).toContain('No items match the query');
    });

    it('validates an envelope whose reason came from below the handler', () => {
      const validate = new AjvJsonSchemaValidator().getValidator(
        emitted(searchTool as AnyToolDefinition),
      );
      // What the SQL gate, the YAML parser, or any other service throws: a
      // `data.reason` the tool's own `errors[]` never declared.
      const envelope = buildToolErrorResult(
        JsonRpcErrorCode.ValidationError,
        'Function not permitted.',
        { reason: 'denied_function' },
      ).structuredContent;

      expect(validate(envelope).valid).toBe(true);
    });

    it('leaves data.reason an open string when no contract is declared', () => {
      const reason = emitted(plainTool as AnyToolDefinition).properties.error.properties.data
        .properties.reason;

      expect(reason.type).toBe('string');
      expect(reason.enum).toBeUndefined();
    });

    it('carries the two-branch anyOf refinement that the dropped `required` no longer expresses', () => {
      expect(emitted(searchTool as AnyToolDefinition).anyOf).toEqual([
        { not: { required: ['error'] }, required: ['items', 'totalCount'] },
        { required: ['error'] },
      ]);
      expect(emitted(plainTool as AnyToolDefinition).anyOf).toEqual([
        { not: { required: ['error'] }, required: ['items'] },
        { required: ['error'] },
      ]);
    });

    it('accepts a real error envelope and rejects an empty result', () => {
      const validate = new AjvJsonSchemaValidator().getValidator(
        emitted(searchTool as AnyToolDefinition),
      );
      const envelope = buildToolErrorResult(JsonRpcErrorCode.NotFound, 'No items returned', {
        reason: 'no_match',
        recovery: { hint: 'Broaden the query and try again.' },
        retryable: false,
      }).structuredContent;

      expect(validate(envelope).valid).toBe(true);
      expect(validate({ items: [], totalCount: 0 }).valid).toBe(true);
      // `{}` — a handler that returned nothing — is what the success-only
      // schema never caught either.
      expect(validate({}).valid).toBe(false);
    });

    it.each([
      [
        'refine',
        z
          .object({ a: z.string().describe('a'), b: z.number().describe('b') })
          .refine((v) => v.a.length > 0, 'a must be set'),
      ],
      [
        'superRefine',
        z
          .object({ a: z.string().describe('a'), b: z.number().describe('b') })
          .superRefine(() => {}),
      ],
    ])('widens an output schema carrying a .%s() check', (_label, output) => {
      // `.refine()` / `.superRefine()` return a ZodObject, so `tool()` accepts
      // them — and Zod rejects `.partial()` on one. Widening through `.partial()`
      // therefore threw during registration and took the server down at startup.
      const refinedTool = tool('refined_output_tool', {
        description: 'Declares a refined output schema.',
        input: z.object({ q: z.string().describe('q') }),
        output: output as never,
        handler: () => ({ a: 'x', b: 1 }) as never,
      });

      const emittedSchema = z.toJSONSchema(
        advertisedOutputSchema(refinedTool as AnyToolDefinition),
        { io: 'output' },
      ) as { properties: Record<string, unknown>; required?: string[] };

      expect(Object.keys(emittedSchema.properties).sort()).toEqual(['a', 'b', 'error']);
      expect(emittedSchema.required).toBeUndefined();
    });

    it('leaves effectiveOutputSchema strict — the authoring check is unchanged', async () => {
      const strict = effectiveOutputSchema(searchTool as AnyToolDefinition);

      expect(Object.keys(strict.shape).sort()).toEqual(['cursor', 'items', 'totalCount']);
      expect(strict.safeParse({ items: [], totalCount: 0 }).success).toBe(true);
      // The advertised schema drops `required`; the parse schema does not.
      expect(strict.safeParse({ items: [] }).success).toBe(false);
      expect(strict.safeParse({ error: { code: -32001, message: 'x' } }).success).toBe(false);
    });

    it('still fails the call when a required enrichment field is never populated', async () => {
      const forgetful = tool('forgets_enrichment', {
        description: 'Declares enrichment but never populates it.',
        input: z.object({ q: z.string().describe('q') }),
        output: z.object({ items: z.array(z.string()).describe('items') }),
        enrichment: { totalCount: z.number().describe('required total') },
        handler: () => ({ items: [] }),
      });
      const handler = createToolHandler(forgetful as AnyToolDefinition, services, notifiers);

      const result = await handler({ q: 'x' }, makeServerContext());

      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Measured region coverage (#346)
  // -----------------------------------------------------------------------

  describe('post-handler failures stay inside the measured region (#346)', () => {
    /**
     * Whether the callback handed to `measureToolExecution` rejected. A
     * post-handler failure that settles outside it leaves the callback
     * resolved, so the call is recorded as a success while the client is told
     * it failed.
     */
    async function measuredCallbackRejected(): Promise<boolean> {
      const last = vi.mocked(measureToolExecution).mock.results.at(-1);
      if (!last) throw new Error('measureToolExecution was never called');
      if (last.type === 'throw') return true;
      return await Promise.resolve(last.value).then(
        () => false,
        () => true,
      );
    }

    const brokenOutput = tool('broken_output', {
      description: 'Returns a value that fails its own output contract.',
      input: z.object({}),
      output: z.object({ value: z.number().describe('A number the handler never returns.') }),
      handler: () => ({}) as { value: number },
    });

    const brokenFormat = tool('broken_format', {
      description: 'Returns a valid value whose formatter throws.',
      input: z.object({}),
      output: z.object({ value: z.number().describe('A number.') }),
      handler: () => ({ value: 1 }),
      format: () => {
        throw new Error('formatter blew up');
      },
    });

    const brokenEnrichment = tool('broken_enrichment', {
      description: 'Declares a required enrichment field the handler never populates.',
      input: z.object({}),
      output: z.object({ value: z.number().describe('A number.') }),
      enrichment: { total: z.number().describe('Required enrichment field.') },
      handler: (_input, ctx) => {
        ctx.enrich({ other: 'populates a different key' } as never);
        return { value: 1 };
      },
    });

    const brokenTrailer = tool('broken_trailer', {
      description: 'Declares a trailer renderer that throws.',
      input: z.object({}),
      output: z.object({ value: z.number().describe('A number.') }),
      enrichment: { total: z.number().describe('Populated enrichment field.') },
      enrichmentTrailer: {
        total: {
          render: () => {
            throw new Error('trailer render blew up');
          },
        },
      },
      handler: (_input, ctx) => {
        ctx.enrich({ total: 1 });
        return { value: 1 };
      },
    });

    it.each([
      ['output-schema validation', brokenOutput],
      ['format()', brokenFormat],
      ['the enrichment merge', brokenEnrichment],
      ['a trailer render()', brokenTrailer],
    ])('measures a failure in %s', async (_surface, def) => {
      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);

      const result = await handler({}, makeServerContext());

      expect(result.isError).toBe(true);
      await expect(measuredCallbackRejected()).resolves.toBe(true);
    });

    it('leaves a successful call resolving through the measured region', async () => {
      const def = tool('measured_success', {
        description: 'Succeeds.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: () => ({ ok: true }),
      });
      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);

      const result = await handler({}, makeServerContext());

      expect(result.structuredContent).toEqual({ ok: true });
      await expect(measuredCallbackRejected()).resolves.toBe(false);
    });
  });
});

/**
 * @fileoverview Test suite for HTTP error handler
 * @module tests/mcp-server/transports/http/httpErrorHandler.test
 */

import { trace } from '@opentelemetry/api';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { httpErrorHandler } from '@/mcp-server/transports/http/httpErrorHandler.js';
import type { HonoNodeBindings } from '@/mcp-server/transports/http/httpTypes.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { logger } from '@/utils/internal/logger.js';

const { mockConfig, mockCounterAdd } = vi.hoisted(() => ({
  mockCounterAdd: vi.fn(),
  mockConfig: {
    mcpServerName: 'test-server',
    mcpPublicUrl: undefined as string | undefined,
    openTelemetry: {
      serviceName: 'test-server',
      serviceVersion: '0.0.0',
    },
  },
}));

// Mock config
vi.mock('@/config/index.js', () => ({
  config: mockConfig,
}));

vi.mock('@/utils/telemetry/metrics.js', () => ({
  createCounter: vi.fn(() => ({ add: mockCounterAdd })),
  createHistogram: vi.fn(() => ({ record: vi.fn() })),
}));

vi.mock('@/utils/internal/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
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
  requestContextService: {
    createRequestContext: vi.fn(() => ({
      requestId: 'test-req-id',
      timestamp: new Date().toISOString(),
    })),
  },
}));

describe('HTTP Error Handler', () => {
  let mockContext: Partial<Context<{ Bindings: HonoNodeBindings }>>;
  let statusValue: number;
  let headers: Map<string, string>;
  let jsonResponseData: unknown;

  beforeEach(() => {
    mockConfig.mcpPublicUrl = undefined;
    statusValue = 200;
    headers = new Map();
    jsonResponseData = null;

    mockContext = {
      req: {
        path: '/test',
        method: 'POST',
        url: 'http://localhost:3000/test',
        header: vi.fn((name: string) => headers.get(name.toLowerCase())),
        raw: {
          bodyUsed: false,
          signal: new AbortController().signal,
        } as Request,
        json: vi.fn(async () => ({ id: 'test-request-123' })),
      } as any,
      status: vi.fn((code: number) => {
        statusValue = code;
      }),
      header: vi.fn((name: string, value: string | undefined) => {
        if (value) headers.set(name.toLowerCase(), value);
      }) as any,
      json: vi.fn((data: unknown) => {
        jsonResponseData = data;
        return new Response(JSON.stringify(data), {
          status: statusValue,
          headers: { 'content-type': 'application/json' },
        });
      }) as any,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic error handling', () => {
    test('should preserve Hono protocol responses and annotate an active span', async () => {
      const recordException = vi.fn();
      const setStatus = vi.fn();
      vi.spyOn(trace, 'getActiveSpan').mockReturnValue({ recordException, setStatus } as never);
      const error = new HTTPException(405, { message: 'Method not allowed' });

      const response = await httpErrorHandler(
        error,
        mockContext as Context<{ Bindings: HonoNodeBindings }>,
      );

      expect(response.status).toBe(405);
      expect(recordException).toHaveBeenCalledWith(error);
      expect(setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Method not allowed' }),
      );
      expect(mockContext.json).not.toHaveBeenCalled();
    });

    test('should preserve Hono protocol responses when no span is active', async () => {
      vi.spyOn(trace, 'getActiveSpan').mockReturnValue(undefined);
      const error = new HTTPException(400, { message: 'Bad protocol request' });

      const response = await httpErrorHandler(
        error,
        mockContext as Context<{ Bindings: HonoNodeBindings }>,
      );

      expect(response.status).toBe(400);
    });

    test('should handle generic Error and return 500', async () => {
      const error = new Error('Something went wrong');

      const response = await httpErrorHandler(
        error,
        mockContext as Context<{ Bindings: HonoNodeBindings }>,
      );

      expect(statusValue).toBe(500);
      expect(jsonResponseData).toMatchObject({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: expect.stringContaining('Something went wrong'),
        },
        id: 'test-request-123',
      });
      expect(response).toBeInstanceOf(Response);
    });

    test('should handle numeric request ID', async () => {
      mockContext.req!.json = vi.fn(async () => ({ id: 42 })) as any;
      const error = new Error('Test error');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect((jsonResponseData as any).id).toBe(42);
    });

    test('should use null id when body has no id', async () => {
      mockContext.req!.json = vi.fn(async () => ({ data: 'test' })) as any;
      const error = new Error('Test error');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect((jsonResponseData as any).id).toBeNull();
    });

    test('should use null id when body parsing fails', async () => {
      mockContext.req!.json = vi.fn(async () => {
        throw new Error('Invalid JSON');
      });
      const error = new Error('Test error');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect((jsonResponseData as any).id).toBeNull();
    });

    test('should use null id when body already consumed', async () => {
      mockContext.req!.raw = {
        bodyUsed: true,
        signal: new AbortController().signal,
      } as Request;
      const error = new Error('Test error');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(mockContext.req?.json).not.toHaveBeenCalled();
      expect((jsonResponseData as any).id).toBeNull();
    });
  });

  describe('McpError status mapping and log treatment', () => {
    let handleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.mocked(logger.warning).mockClear();
      handleErrorSpy = vi
        .spyOn(ErrorHandler, 'handleError')
        .mockReturnValue(new McpError(JsonRpcErrorCode.InternalError, 'handled'));
    });

    afterEach(() => {
      handleErrorSpy.mockRestore();
    });

    test.each([
      ['NotFound', JsonRpcErrorCode.NotFound, 404],
      ['Unauthorized', JsonRpcErrorCode.Unauthorized, 401],
      ['Forbidden', JsonRpcErrorCode.Forbidden, 403],
      ['InvalidParams', JsonRpcErrorCode.InvalidParams, 400],
      ['ValidationError', JsonRpcErrorCode.ValidationError, 400],
      ['InvalidRequest', JsonRpcErrorCode.InvalidRequest, 400],
    ])(
      'maps client error %s to %i with a warning log, skipping ErrorHandler.handleError',
      async (label, code, status) => {
        const message = `${label} failure`;

        await httpErrorHandler(
          new McpError(code, message),
          mockContext as Context<{ Bindings: HonoNodeBindings }>,
        );

        expect(statusValue).toBe(status);
        expect((jsonResponseData as any).error.code).toBe(code);
        expect(handleErrorSpy).not.toHaveBeenCalled();
        expect(logger.warning).toHaveBeenCalledWith(
          expect.stringContaining(message),
          expect.objectContaining({ extra: expect.objectContaining({ errorCode: code }) }),
        );
      },
    );

    test.each([
      ['Conflict', JsonRpcErrorCode.Conflict, 409],
      ['RateLimited', JsonRpcErrorCode.RateLimited, 429],
      ['Timeout', JsonRpcErrorCode.Timeout, 504],
      ['ServiceUnavailable', JsonRpcErrorCode.ServiceUnavailable, 503],
      /**
       * Matches what the SDK's own handler answers for a closed connection, so
       * a cancellation reports the same status wherever it is caught (#386).
       */
      ['RequestCancelled', JsonRpcErrorCode.RequestCancelled, 499],
      ['an unknown code', -99999 as JsonRpcErrorCode, 500],
    ])(
      'maps server error %s to %i through ErrorHandler.handleError',
      async (label, code, status) => {
        await httpErrorHandler(
          new McpError(code, `${label} failure`),
          mockContext as Context<{ Bindings: HonoNodeBindings }>,
        );

        expect(statusValue).toBe(status);
        expect((jsonResponseData as any).error.code).toBe(code);
        expect(handleErrorSpy).toHaveBeenCalledOnce();
        expect(logger.warning).not.toHaveBeenCalled();
      },
    );

    test('server error (InternalError) invokes ErrorHandler.handleError', async () => {
      const error = new Error('Unexpected failure');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(handleErrorSpy).toHaveBeenCalledOnce();
      expect(statusValue).toBe(500);
    });
  });

  describe('WWW-Authenticate header for 401', () => {
    test.each(['http://internal.container:8080/mcp', 'https://malicious-host.example/mcp'])(
      'prefers MCP_PUBLIC_URL over the inbound origin for %s',
      async (requestUrl) => {
        mockConfig.mcpPublicUrl = 'https://public.example.com/';
        mockContext = {
          ...mockContext,
          req: { ...mockContext.req, url: requestUrl } as any,
        };
        const error = new McpError(JsonRpcErrorCode.Unauthorized, 'Unauthorized');

        await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

        expect(headers.get('www-authenticate')).toBe(
          'Bearer realm="test-server", resource_metadata="https://public.example.com/.well-known/oauth-protected-resource"',
        );
      },
    );

    test('falls back to the inbound origin when MCP_PUBLIC_URL is unset', async () => {
      mockContext = {
        ...mockContext,
        req: { ...mockContext.req, url: 'https://trusted.example:8443/mcp' } as any,
      };
      const error = new McpError(JsonRpcErrorCode.Unauthorized, 'Unauthorized');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(headers.get('www-authenticate')).toBe(
        'Bearer realm="test-server", resource_metadata="https://trusted.example:8443/.well-known/oauth-protected-resource"',
      );
    });

    test('should not add WWW-Authenticate header for non-401 errors', async () => {
      const error = new McpError(JsonRpcErrorCode.Forbidden, 'Forbidden');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      const wwwAuthHeader = headers.get('www-authenticate');
      expect(wwwAuthHeader).toBeUndefined();
    });
  });

  describe('JSON-RPC response format', () => {
    test('should include error object with code and message', async () => {
      const error = new McpError(JsonRpcErrorCode.InvalidParams, 'Invalid params');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect((jsonResponseData as any).error).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        message: 'Invalid params',
      });
    });

    test('should preserve explicitly declared McpError data', async () => {
      const error = new McpError(JsonRpcErrorCode.NotFound, 'Missing', {
        reason: 'missing_item',
      });

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect((jsonResponseData as any).error.data).toEqual({ reason: 'missing_item' });
    });
  });

  describe('caller disconnect before a handler runs (#507)', () => {
    const abortedSignal = (): AbortSignal => {
      const controller = new AbortController();
      controller.abort(new Error('aborted'));
      return controller.signal;
    };
    /** What Node raises when the body stream is cut off mid-read. */
    const bodyStreamAborted = (): Error =>
      Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
    const handle = (error: Error) =>
      httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

    beforeEach(() => {
      vi.clearAllMocks();
    });

    test('reads as RequestCancelled: info log without a stack, 499, -32011 metric', async () => {
      mockContext.req!.raw = { bodyUsed: true, signal: abortedSignal() } as Request;

      await handle(bodyStreamAborted());

      expect(statusValue).toBe(499);
      expect((jsonResponseData as any).error).toEqual({
        code: JsonRpcErrorCode.RequestCancelled,
        message: 'aborted',
      });
      expect(logger.error).not.toHaveBeenCalled();
      const record = vi
        .mocked(logger.info)
        .mock.calls.find(([msg]) => msg === 'Cancelled httpTransport: aborted')?.[1] as {
        extra: Record<string, any>;
      };
      expect(record).toBeDefined();
      expect(record.extra).not.toHaveProperty('stack');
      expect(record.extra.errorData).not.toHaveProperty('originalStack');
      expect(record.extra.errorData).not.toHaveProperty('causeChain');
      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        'mcp.error.classified_code': String(JsonRpcErrorCode.RequestCancelled),
        operation: 'httpTransport',
      });
    });

    test('keeps a raw AbortError as Timeout / 504 while the signal is live', async () => {
      await handle(new DOMException('This operation was aborted', 'AbortError'));

      expect(statusValue).toBe(504);
      expect((jsonResponseData as any).error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        'mcp.error.classified_code': String(JsonRpcErrorCode.Timeout),
        operation: 'httpTransport',
      });
    });

    test('keeps an McpError code, status, and data while the signal is live', async () => {
      await handle(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Upstream down', { reason: 'x' }),
      );

      expect(statusValue).toBe(503);
      expect((jsonResponseData as any).error).toEqual({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: 'Upstream down',
        data: { reason: 'x' },
      });
    });

    test('leaves an HTTPException response untouched even after the caller left', async () => {
      mockContext.req!.raw = { bodyUsed: false, signal: abortedSignal() } as Request;

      const response = await handle(new HTTPException(405, { message: 'Method not allowed' }));

      expect(response.status).toBe(405);
      expect(mockContext.json).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('Cancelled'),
        expect.anything(),
      );
    });
  });
});

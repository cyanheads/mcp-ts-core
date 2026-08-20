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

const { mockConfig } = vi.hoisted(() => ({
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

    test('should extract request ID from body', async () => {
      const error = new Error('Test error');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(mockContext.req?.json).toHaveBeenCalled();
      expect((jsonResponseData as any).id).toBe('test-request-123');
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
      } as Request;
      const error = new Error('Test error');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(mockContext.req?.json).not.toHaveBeenCalled();
      expect((jsonResponseData as any).id).toBeNull();
    });
  });

  describe('McpError status code mapping', () => {
    test('should map NotFound to 404', async () => {
      const error = new McpError(JsonRpcErrorCode.NotFound, 'Not found');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(statusValue).toBe(404);
      expect((jsonResponseData as any).error.code).toBe(JsonRpcErrorCode.NotFound);
    });

    test('should map Unauthorized to 401', async () => {
      const error = new McpError(JsonRpcErrorCode.Unauthorized, 'Unauthorized');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(statusValue).toBe(401);
      expect((jsonResponseData as any).error.code).toBe(JsonRpcErrorCode.Unauthorized);
    });

    test('should map Forbidden to 403', async () => {
      const error = new McpError(JsonRpcErrorCode.Forbidden, 'Forbidden');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(statusValue).toBe(403);
      expect((jsonResponseData as any).error.code).toBe(JsonRpcErrorCode.Forbidden);
    });

    test('should map ValidationError to 400', async () => {
      const error = new McpError(JsonRpcErrorCode.ValidationError, 'Validation failed');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(statusValue).toBe(400);
      expect((jsonResponseData as any).error.code).toBe(JsonRpcErrorCode.ValidationError);
    });

    test('should map InvalidRequest to 400', async () => {
      const error = new McpError(JsonRpcErrorCode.InvalidRequest, 'Invalid request');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(statusValue).toBe(400);
      expect((jsonResponseData as any).error.code).toBe(JsonRpcErrorCode.InvalidRequest);
    });

    test('should map Conflict to 409', async () => {
      const error = new McpError(JsonRpcErrorCode.Conflict, 'Conflict');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(statusValue).toBe(409);
      expect((jsonResponseData as any).error.code).toBe(JsonRpcErrorCode.Conflict);
    });

    test('should map RateLimited to 429', async () => {
      const error = new McpError(JsonRpcErrorCode.RateLimited, 'Rate limited');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(statusValue).toBe(429);
      expect((jsonResponseData as any).error.code).toBe(JsonRpcErrorCode.RateLimited);
    });

    test('should map Timeout to 504', async () => {
      const error = new McpError(JsonRpcErrorCode.Timeout, 'Timed out');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(statusValue).toBe(504);
    });

    test('should map ServiceUnavailable to 503', async () => {
      const error = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Unavailable');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(statusValue).toBe(503);
    });

    test('should default to 500 for unknown error codes', async () => {
      const error = new McpError(-99999 as JsonRpcErrorCode, 'Unknown error');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(statusValue).toBe(500);
      expect((jsonResponseData as any).error.code).toBe(-99999);
    });
  });

  describe('WWW-Authenticate header for 401', () => {
    test('should always add WWW-Authenticate header on 401', async () => {
      const error = new McpError(JsonRpcErrorCode.Unauthorized, 'Unauthorized');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      const wwwAuthHeader = headers.get('www-authenticate');
      expect(wwwAuthHeader).toBeDefined();
      expect(wwwAuthHeader).toContain('Bearer realm="test-server"');
      expect(wwwAuthHeader).toContain('resource_metadata=');
      expect(wwwAuthHeader).toContain('.well-known/oauth-protected-resource');
    });

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
    test('should include jsonrpc version 2.0', async () => {
      const error = new Error('Test error');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect((jsonResponseData as any).jsonrpc).toBe('2.0');
    });

    test('should include error object with code and message', async () => {
      const error = new McpError(JsonRpcErrorCode.InvalidParams, 'Invalid params');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect((jsonResponseData as any).error).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        message: 'Invalid params',
      });
    });

    test('should preserve error message from McpError', async () => {
      const error = new McpError(JsonRpcErrorCode.MethodNotFound, 'Custom error message');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect((jsonResponseData as any).error.message).toBe('Custom error message');
    });

    test('should preserve explicitly declared McpError data', async () => {
      const error = new McpError(JsonRpcErrorCode.NotFound, 'Missing', {
        reason: 'missing_item',
      });

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect((jsonResponseData as any).error.data).toEqual({ reason: 'missing_item' });
    });
  });

  describe('Client vs server error log treatment', () => {
    let handleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      handleErrorSpy = vi
        .spyOn(ErrorHandler, 'handleError')
        .mockReturnValue(new McpError(JsonRpcErrorCode.InternalError, 'handled'));
    });

    afterEach(() => {
      handleErrorSpy.mockRestore();
    });

    test('Unauthorized error logs at warning level, skips ErrorHandler.handleError', async () => {
      const error = new McpError(JsonRpcErrorCode.Unauthorized, 'Invalid token');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(handleErrorSpy).not.toHaveBeenCalled();
      expect(logger.warning).toHaveBeenCalledWith(
        expect.stringContaining('Invalid token'),
        expect.objectContaining({
          extra: expect.objectContaining({ errorCode: JsonRpcErrorCode.Unauthorized }),
        }),
      );
      expect(statusValue).toBe(401);
    });

    test('Forbidden error logs at warning level, skips ErrorHandler.handleError', async () => {
      const error = new McpError(JsonRpcErrorCode.Forbidden, 'Insufficient scopes');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(handleErrorSpy).not.toHaveBeenCalled();
      expect(logger.warning).toHaveBeenCalledWith(
        expect.stringContaining('Insufficient scopes'),
        expect.objectContaining({
          extra: expect.objectContaining({ errorCode: JsonRpcErrorCode.Forbidden }),
        }),
      );
      expect(statusValue).toBe(403);
    });

    test('ValidationError logs at warning level, skips ErrorHandler.handleError', async () => {
      const error = new McpError(JsonRpcErrorCode.ValidationError, 'Bad input');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(handleErrorSpy).not.toHaveBeenCalled();
      expect(logger.warning).toHaveBeenCalledWith(
        expect.stringContaining('Bad input'),
        expect.objectContaining({
          extra: expect.objectContaining({ errorCode: JsonRpcErrorCode.ValidationError }),
        }),
      );
      expect(statusValue).toBe(400);
    });

    test('InvalidRequest error logs at warning level, skips ErrorHandler.handleError', async () => {
      const error = new McpError(JsonRpcErrorCode.InvalidRequest, 'Missing field');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(handleErrorSpy).not.toHaveBeenCalled();
      expect(logger.warning).toHaveBeenCalledWith(
        expect.stringContaining('Missing field'),
        expect.objectContaining({
          extra: expect.objectContaining({ errorCode: JsonRpcErrorCode.InvalidRequest }),
        }),
      );
      expect(statusValue).toBe(400);
    });

    test('NotFound error logs at warning level, skips ErrorHandler.handleError', async () => {
      const error = new McpError(JsonRpcErrorCode.NotFound, 'Session expired');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(handleErrorSpy).not.toHaveBeenCalled();
      expect(logger.warning).toHaveBeenCalledWith(
        expect.stringContaining('Session expired'),
        expect.objectContaining({
          extra: expect.objectContaining({ errorCode: JsonRpcErrorCode.NotFound }),
        }),
      );
      expect(statusValue).toBe(404);
    });

    test('server error (InternalError) invokes ErrorHandler.handleError', async () => {
      const error = new Error('Unexpected failure');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(handleErrorSpy).toHaveBeenCalledOnce();
      expect(statusValue).toBe(500);
    });

    test('RateLimited error invokes ErrorHandler.handleError (not a client error)', async () => {
      const error = new McpError(JsonRpcErrorCode.RateLimited, 'Too many requests');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(handleErrorSpy).toHaveBeenCalledOnce();
      expect(statusValue).toBe(429);
    });

    test('ServiceUnavailable error invokes ErrorHandler.handleError', async () => {
      const error = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Upstream down');

      await httpErrorHandler(error, mockContext as Context<{ Bindings: HonoNodeBindings }>);

      expect(handleErrorSpy).toHaveBeenCalledOnce();
      expect(statusValue).toBe(503);
    });
  });
});

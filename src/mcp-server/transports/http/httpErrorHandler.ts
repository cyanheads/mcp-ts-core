/**
 * @fileoverview Centralized error handler for the Hono HTTP transport.
 * This middleware intercepts errors that occur during request processing,
 * standardizes them using the application's ErrorHandler utility, and
 * formats them into a consistent JSON-RPC error response.
 * @module src/mcp-server/transports/http/httpErrorHandler
 */
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { StatusCode } from 'hono/utils/http-status';

import { config } from '@/config/index.js';
import type { HonoNodeBindings } from '@/mcp-server/transports/http/httpTypes.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { getProperty } from '@/utils/types/guards.js';

/**
 * A centralized error handling middleware for Hono.
 * This function is registered with `app.onError()` and will catch any errors
 * thrown from preceding middleware or route handlers.
 *
 * Generic to support different binding types (Node.js, Cloudflare Workers, etc).
 *
 * @template TBindings - The Hono binding type (defaults to HonoNodeBindings)
 * @param err - The error that was thrown.
 * @param c - The Hono context object for the request.
 * @returns A Response object containing the formatted JSON-RPC error.
 */
export const httpErrorHandler = async <TBindings extends object = HonoNodeBindings>(
  err: Error,
  c: Context<{ Bindings: TBindings }>,
): Promise<Response> => {
  // @hono/mcp throws HTTPException for protocol errors — honor its pre-built response.
  // Annotate the active span so traces capture the error detail, then log for debugging.
  if (err instanceof HTTPException) {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.recordException(err);
      activeSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    }
    logger.debug(
      `Protocol error: HTTP ${err.status}`,
      requestContextService.createRequestContext({
        operation: 'httpErrorHandler',
        additionalContext: {
          status: err.status,
          message: err.message,
          path: c.req.path,
          method: c.req.method,
        },
      }),
    );
    return err.getResponse();
  }

  const context = requestContextService.createRequestContext({
    operation: 'httpErrorHandler',
    additionalContext: {
      path: c.req.path,
      method: c.req.method,
    },
  });
  logger.debug('HTTP error handler invoked.', context);

  // Capture original McpError data before enrichment — handleError adds internal
  // details (stack traces, cause chains, operation context) that must not leak.
  const originalData = err instanceof McpError ? err.data : undefined;

  // Pre-classify to split expected client errors (4xx) from unexpected server
  // errors (5xx). Client errors get a compact warning log without stack traces;
  // server errors go through the full ErrorHandler pipeline with stacks + OTel.
  const classified = ErrorHandler.classifyOnly(err);

  const EXPECTED_CLIENT_CODES: ReadonlySet<number> = new Set([
    JsonRpcErrorCode.Unauthorized,
    JsonRpcErrorCode.Forbidden,
    JsonRpcErrorCode.InvalidParams,
    JsonRpcErrorCode.ValidationError,
    JsonRpcErrorCode.InvalidRequest,
    JsonRpcErrorCode.NotFound,
  ]);

  const isExpectedClientError = EXPECTED_CLIENT_CODES.has(classified.code);

  if (isExpectedClientError) {
    logger.warning(`Client error: ${classified.message}`, {
      ...context,
      errorCode: classified.code,
    });
  } else {
    ErrorHandler.handleError(err, {
      operation: 'httpTransport',
      context,
    });
  }

  const errorCode = classified.code;
  let status: StatusCode = 500;
  switch (errorCode) {
    case JsonRpcErrorCode.NotFound:
      status = 404;
      break;
    case JsonRpcErrorCode.Unauthorized:
      status = 401;
      // RFC 9728 §7: 401 responses MUST include WWW-Authenticate with resource_metadata URL.
      // /.well-known/oauth-protected-resource is always mounted regardless of auth mode.
      // https://datatracker.ietf.org/doc/html/rfc9728#section-7
      {
        const origin = new URL(c.req.url).origin;
        const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource`;
        c.header(
          'WWW-Authenticate',
          `Bearer realm="${config.mcpServerName}", resource_metadata="${resourceMetadataUrl}"`,
        );
        logger.debug('Added WWW-Authenticate header for 401 response.', {
          ...context,
          resourceMetadataUrl,
        });
      }
      break;
    case JsonRpcErrorCode.Forbidden:
      status = 403;
      break;
    case JsonRpcErrorCode.InvalidParams:
    case JsonRpcErrorCode.ValidationError:
    case JsonRpcErrorCode.InvalidRequest:
      status = 400;
      break;
    case JsonRpcErrorCode.Timeout:
      status = 504;
      break;
    case JsonRpcErrorCode.ServiceUnavailable:
      status = 503;
      break;
    case JsonRpcErrorCode.Conflict:
      status = 409;
      break;
    case JsonRpcErrorCode.RateLimited:
      status = 429;
      break;
    default:
      status = 500;
  }
  logger.debug(`Mapping error to HTTP status ${status}.`, {
    ...context,
    status,
    errorCode,
  });

  // Attempt to get the request ID from the body, but don't fail if it's not there or unreadable.
  let requestId: string | number | null = null;
  // Only attempt to read the body if it hasn't been consumed already.
  if (c.req.raw.bodyUsed === false) {
    try {
      const body: unknown = await c.req.json();
      const id = getProperty(body, 'id');
      requestId = typeof id === 'string' || typeof id === 'number' ? id : null;
      logger.debug('Extracted JSON-RPC request ID from body.', {
        ...context,
        jsonRpcId: requestId,
      });
    } catch {
      logger.warning('Could not parse request body to extract JSON-RPC ID.', context);
      // Ignore parsing errors, requestId will remain null
    }
  } else {
    logger.debug('Request body already consumed, cannot extract JSON-RPC ID.', context);
  }

  c.status(status);
  const errorResponse = {
    jsonrpc: '2.0',
    error: {
      code: errorCode,
      message: classified.message,
      ...(originalData !== undefined && { data: originalData }),
    },
    id: requestId,
  };
  logger.info(`Sending formatted error response for request.`, {
    ...context,
    status,
    errorCode,
    jsonRpcId: requestId,
  });
  return c.json(errorResponse);
};

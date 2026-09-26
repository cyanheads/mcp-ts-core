/**
 * @fileoverview Tests that ErrorHandler.handleError records the `mcp.errors.classified`
 * counter with the correct classified error code and operation attributes.
 * @module tests/unit/utils/internal/errorHandler.metrics.test
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Shared mock captures — must precede source imports
const mockCounterAdd = vi.fn();

vi.mock('@/utils/telemetry/metrics.js', () => ({
  createCounter: vi.fn(() => ({ add: mockCounterAdd })),
  createHistogram: vi.fn(() => ({ record: vi.fn() })),
}));

vi.mock('@opentelemetry/api', () => ({
  trace: { getActiveSpan: vi.fn(() => undefined) },
  SpanStatusCode: { ERROR: 2 },
}));

vi.mock('@/utils/internal/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/utils/security/idGenerator.js', () => ({
  generateUUID: vi.fn(() => 'test-uuid-0000'),
}));

vi.mock('@/utils/security/sanitization.js', () => ({
  sanitizeInputForLogging: vi.fn((v: unknown) => v),
}));

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';

describe('ErrorHandler — mcp.errors.classified counter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records classified counter with McpError code and operation', () => {
    const error = new McpError(JsonRpcErrorCode.NotFound, 'Item missing');

    ErrorHandler.handleError(error, { operation: 'findItem' });

    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.error.classified_code': String(JsonRpcErrorCode.NotFound),
      'mcp.error.category': 'client',
      operation: 'findItem',
    });
  });

  it('records classified counter with auto-classified code for plain Error', () => {
    const error = new Error('something went wrong');

    ErrorHandler.handleError(error, { operation: 'processJob' });

    // Plain Error with no recognizable pattern falls back to InternalError
    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.error.classified_code': String(JsonRpcErrorCode.InternalError),
      'mcp.error.category': 'server',
      operation: 'processJob',
    });
  });

  it('records classified counter with explicit errorCode override', () => {
    const error = new Error('disk full');

    ErrorHandler.handleError(error, {
      operation: 'writeFile',
      errorCode: JsonRpcErrorCode.ServiceUnavailable,
    });

    // The category follows the override, not the message.
    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.error.classified_code': String(JsonRpcErrorCode.ServiceUnavailable),
      'mcp.error.category': 'upstream',
      operation: 'writeFile',
    });
  });

  it('increments counter exactly once per handleError call', () => {
    ErrorHandler.handleError(new Error('fail'), { operation: 'op1' });
    ErrorHandler.handleError(new Error('fail again'), { operation: 'op2' });

    expect(mockCounterAdd).toHaveBeenCalledTimes(2);
  });
});

// Issue #481 — the counter carries the same origin bucket the per-surface
// counters do, so a consumer never re-derives it from the code.
describe('ErrorHandler — mcp.error.category on mcp.errors.classified (#481)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Attributes of the single increment `handleError` made for `error`. */
  function attributesFor(error: unknown, operation = 'tool:t'): Record<string, unknown> {
    ErrorHandler.handleError(error, { operation });
    expect(mockCounterAdd).toHaveBeenCalledTimes(1);
    return mockCounterAdd.mock.calls[0]?.[1] as Record<string, unknown>;
  }

  it.each([
    [
      'the canvas tenant-cap refusal',
      new McpError(JsonRpcErrorCode.RateLimited, 'capped', {
        reason: 'canvas_capacity_exhausted',
      }),
      JsonRpcErrorCode.RateLimited,
      'server',
    ],
    [
      'any other RateLimited',
      new McpError(JsonRpcErrorCode.RateLimited, 'slow down', { reason: 'ncbi_throttled' }),
      JsonRpcErrorCode.RateLimited,
      'upstream',
    ],
    [
      'an argument rejection',
      new McpError(JsonRpcErrorCode.InvalidParams, 'bad args', { reason: 'invalid_arguments' }),
      JsonRpcErrorCode.InvalidParams,
      'client',
    ],
    [
      'a cancellation',
      new McpError(JsonRpcErrorCode.RequestCancelled, 'caller went away'),
      JsonRpcErrorCode.RequestCancelled,
      'client',
    ],
    ['a plain Error', new Error('boom'), JsonRpcErrorCode.InternalError, 'server'],
    [
      'a classified timeout message',
      new Error('Request timed out'),
      JsonRpcErrorCode.Timeout,
      'upstream',
    ],
  ])('files %s under its category', (_label, error, code, category) => {
    expect(attributesFor(error)).toEqual({
      'mcp.error.classified_code': String(code),
      'mcp.error.category': category,
      operation: 'tool:t',
    });
  });

  it('carries the category through tryCatch in services', async () => {
    await expect(
      ErrorHandler.tryCatch(
        () => {
          throw new Error('status code 503');
        },
        { operation: 'Upstream.fetch' },
      ),
    ).rejects.toThrow();

    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.error.classified_code': String(JsonRpcErrorCode.ServiceUnavailable),
      'mcp.error.category': 'upstream',
      operation: 'Upstream.fetch',
    });
  });

  it('adds mcp.error.severity only when a declared severity resolved', () => {
    ErrorHandler.handleError(new McpError(JsonRpcErrorCode.InvalidRequest, 'declined'), {
      operation: 'tool:t',
      severity: 'warning',
    });

    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.error.classified_code': String(JsonRpcErrorCode.InvalidRequest),
      'mcp.error.category': 'client',
      'mcp.error.severity': 'warning',
      operation: 'tool:t',
    });
  });
});

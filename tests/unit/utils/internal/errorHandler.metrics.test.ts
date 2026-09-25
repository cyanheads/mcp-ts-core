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
      operation: 'findItem',
    });
  });

  it('records classified counter with auto-classified code for plain Error', () => {
    const error = new Error('something went wrong');

    ErrorHandler.handleError(error, { operation: 'processJob' });

    // Plain Error with no recognizable pattern falls back to InternalError
    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.error.classified_code': String(JsonRpcErrorCode.InternalError),
      operation: 'processJob',
    });
  });

  it('records classified counter with explicit errorCode override', () => {
    const error = new Error('disk full');

    ErrorHandler.handleError(error, {
      operation: 'writeFile',
      errorCode: JsonRpcErrorCode.ServiceUnavailable,
    });

    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.error.classified_code': String(JsonRpcErrorCode.ServiceUnavailable),
      operation: 'writeFile',
    });
  });

  it('increments counter exactly once per handleError call', () => {
    ErrorHandler.handleError(new Error('fail'), { operation: 'op1' });
    ErrorHandler.handleError(new Error('fail again'), { operation: 'op2' });

    expect(mockCounterAdd).toHaveBeenCalledTimes(2);
  });
});

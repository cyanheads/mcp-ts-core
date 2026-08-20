/**
 * @fileoverview Type-satisfaction tests for error handler type definitions.
 * Verifies that ErrorContext, ErrorHandlerOptions, BaseErrorMapping, and ErrorMapping
 * are well-formed and usable as type constraints at runtime.
 * @module tests/utils/internal/error-handler/types.test
 */

import { describe, expect, it } from 'vitest';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import type {
  BaseErrorMapping,
  ErrorContext,
  ErrorHandlerOptions,
  ErrorMapping,
} from '@/utils/internal/error-handler/types.js';

describe('ErrorContext', () => {
  it('should accept the canonical fields plus an open `extra` bag', () => {
    const ctx: ErrorContext = {
      requestId: 'req-123',
      operation: 'test',
      extra: { attempt: 42 },
    };

    expect(ctx.requestId).toBe('req-123');
    expect(ctx.extra).toEqual({ attempt: 42 });
  });
});

describe('ErrorHandlerOptions', () => {
  it('should be satisfiable with required fields only', () => {
    const opts: ErrorHandlerOptions = {
      operation: 'TestOperation',
    };

    expect(opts.operation).toBe('TestOperation');
  });

  it('should accept all optional fields', () => {
    const opts: ErrorHandlerOptions = {
      operation: 'TestOperation',
      context: { requestId: 'req-1' },
      critical: true,
      errorCode: JsonRpcErrorCode.InternalError,
      rethrow: false,
      includeStack: true,
      input: { key: 'value' },
      errorMapper: (err) => new Error(String(err)),
    };

    expect(opts.critical).toBe(true);
    expect(opts.errorCode).toBe(JsonRpcErrorCode.InternalError);
    expect(typeof opts.errorMapper).toBe('function');
  });
});

describe('BaseErrorMapping', () => {
  it('should be satisfiable with a string pattern', () => {
    const mapping: BaseErrorMapping = {
      pattern: 'not found',
      errorCode: JsonRpcErrorCode.NotFound,
    };

    expect(mapping.pattern).toBe('not found');
    expect(mapping.errorCode).toBe(JsonRpcErrorCode.NotFound);
  });

  it('should accept a RegExp pattern and message template', () => {
    const mapping: BaseErrorMapping = {
      pattern: /timeout/i,
      errorCode: JsonRpcErrorCode.Timeout,
      messageTemplate: 'Operation timed out',
    };

    expect(mapping.pattern).toBeInstanceOf(RegExp);
    expect(mapping.messageTemplate).toBe('Operation timed out');
  });
});

describe('ErrorMapping', () => {
  it('should extend BaseErrorMapping with a factory', () => {
    const mapping: ErrorMapping = {
      pattern: 'conflict',
      errorCode: JsonRpcErrorCode.Conflict,
      factory: (err) => new Error(`Conflict: ${String(err)}`),
    };

    expect(typeof mapping.factory).toBe('function');
    const result = mapping.factory('duplicate key');
    expect(result).toBeInstanceOf(Error);
  });
});

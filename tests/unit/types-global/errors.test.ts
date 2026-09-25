/**
 * @fileoverview Test suite for global error types
 * @module tests/types-global/errors.test
 */

import { describe, expect, it } from 'vitest';
import {
  configurationError,
  conflict,
  databaseError,
  ErrorSchema,
  forbidden,
  internalError,
  invalidParams,
  invalidRequest,
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  requestCancelled,
  serializationError,
  serviceUnavailable,
  timeout,
  unauthorized,
  validationError,
} from '@/types-global/errors.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

describe('Global Error Types', () => {
  describe('JsonRpcErrorCode', () => {
    it('should have all standard JSON-RPC 2.0 error codes', () => {
      expect(JsonRpcErrorCode.ParseError).toBe(-32700);
      expect(JsonRpcErrorCode.InvalidRequest).toBe(-32600);
      expect(JsonRpcErrorCode.MethodNotFound).toBe(-32601);
      expect(JsonRpcErrorCode.InvalidParams).toBe(-32602);
      expect(JsonRpcErrorCode.InternalError).toBe(-32603);
    });

    it('should have implementation-defined error codes in correct range (-32000 to -32099)', () => {
      expect(JsonRpcErrorCode.ServiceUnavailable).toBe(-32000);
      expect(JsonRpcErrorCode.NotFound).toBe(-32001);
      expect(JsonRpcErrorCode.Conflict).toBe(-32002);
      expect(JsonRpcErrorCode.RateLimited).toBe(-32003);
      expect(JsonRpcErrorCode.Timeout).toBe(-32004);
      expect(JsonRpcErrorCode.Forbidden).toBe(-32005);
      expect(JsonRpcErrorCode.Unauthorized).toBe(-32006);
      expect(JsonRpcErrorCode.ValidationError).toBe(-32007);
      expect(JsonRpcErrorCode.ConfigurationError).toBe(-32008);
      expect(JsonRpcErrorCode.InitializationFailed).toBe(-32009);
      expect(JsonRpcErrorCode.DatabaseError).toBe(-32010);
      expect(JsonRpcErrorCode.RequestCancelled).toBe(-32011);
      expect(JsonRpcErrorCode.SerializationError).toBe(-32070);
      expect(JsonRpcErrorCode.UnknownError).toBe(-32099);
    });

    it('assigns every code a distinct value', () => {
      // A reused value would make the reverse mapping (and every switch keyed on
      // the enum) silently resolve to the wrong member.
      const values = Object.values(JsonRpcErrorCode).filter((v) => typeof v === 'number');
      expect(new Set(values).size).toBe(values.length);
    });
  });

  describe('McpError', () => {
    it('should create an error with code and message', () => {
      const error = new McpError(JsonRpcErrorCode.InvalidParams, 'Invalid parameter provided');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(McpError);
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.message).toBe('Invalid parameter provided');
      expect(error.name).toBe('McpError');
      expect(error.data).toBeUndefined();
    });

    it('should create an error with code, message, and data', () => {
      const data = { field: 'username', reason: 'too short' };
      const error = new McpError(JsonRpcErrorCode.ValidationError, 'Validation failed', data);

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toBe('Validation failed');
      expect(error.data).toEqual(data);
    });

    it('should create an error with just code (no message)', () => {
      const error = new McpError(JsonRpcErrorCode.InternalError);

      expect(error.code).toBe(JsonRpcErrorCode.InternalError);
      expect(error.message).toBe('');
      expect(error.data).toBeUndefined();
    });

    it('should support cause option', () => {
      const cause = new Error('Original error');
      const error = new McpError(JsonRpcErrorCode.InternalError, 'Wrapped error', undefined, {
        cause,
      });

      expect(error.cause).toBe(cause);
    });

    it('should capture stack trace', () => {
      const error = new McpError(JsonRpcErrorCode.InternalError, 'Test error');

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('McpError');
    });
  });

  describe('ErrorSchema', () => {
    it('should validate a correct error object', () => {
      const validError = {
        code: JsonRpcErrorCode.InvalidParams,
        message: 'Parameter validation failed',
      };

      const result = ErrorSchema.safeParse(validError);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(result.data.message).toBe('Parameter validation failed');
      }
    });

    it('should validate an error object with data', () => {
      const validError = {
        code: JsonRpcErrorCode.ValidationError,
        message: 'Validation error',
        data: { field: 'email', reason: 'invalid format' },
      };

      const result = ErrorSchema.safeParse(validError);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.data).toEqual({
          field: 'email',
          reason: 'invalid format',
        });
      }
    });

    it('should reject an error object with missing code', () => {
      const invalidError = {
        message: 'Error message',
      };

      const result = ErrorSchema.safeParse(invalidError);
      expect(result.success).toBe(false);
    });

    it('should reject an error object with missing message', () => {
      const invalidError = {
        code: JsonRpcErrorCode.InternalError,
      };

      const result = ErrorSchema.safeParse(invalidError);
      expect(result.success).toBe(false);
    });

    it('should reject an error object with empty message', () => {
      const invalidError = {
        code: JsonRpcErrorCode.InternalError,
        message: '',
      };

      const result = ErrorSchema.safeParse(invalidError);
      expect(result.success).toBe(false);
    });

    it('should reject an error object with invalid code', () => {
      const invalidError = {
        code: 999,
        message: 'Invalid code',
      };

      const result = ErrorSchema.safeParse(invalidError);
      expect(result.success).toBe(false);
    });

    it('should reject an error object with non-string message', () => {
      const invalidError = {
        code: JsonRpcErrorCode.InternalError,
        message: 123,
      };

      const result = ErrorSchema.safeParse(invalidError);
      expect(result.success).toBe(false);
    });
  });

  describe('Error factory functions', () => {
    const factories = [
      { fn: invalidParams, name: 'invalidParams', code: JsonRpcErrorCode.InvalidParams },
      { fn: invalidRequest, name: 'invalidRequest', code: JsonRpcErrorCode.InvalidRequest },
      { fn: notFound, name: 'notFound', code: JsonRpcErrorCode.NotFound },
      { fn: forbidden, name: 'forbidden', code: JsonRpcErrorCode.Forbidden },
      { fn: unauthorized, name: 'unauthorized', code: JsonRpcErrorCode.Unauthorized },
      { fn: validationError, name: 'validationError', code: JsonRpcErrorCode.ValidationError },
      { fn: conflict, name: 'conflict', code: JsonRpcErrorCode.Conflict },
      { fn: rateLimited, name: 'rateLimited', code: JsonRpcErrorCode.RateLimited },
      { fn: timeout, name: 'timeout', code: JsonRpcErrorCode.Timeout },
      {
        fn: serviceUnavailable,
        name: 'serviceUnavailable',
        code: JsonRpcErrorCode.ServiceUnavailable,
      },
      {
        fn: configurationError,
        name: 'configurationError',
        code: JsonRpcErrorCode.ConfigurationError,
      },
      { fn: internalError, name: 'internalError', code: JsonRpcErrorCode.InternalError },
      {
        fn: serializationError,
        name: 'serializationError',
        code: JsonRpcErrorCode.SerializationError,
      },
      { fn: databaseError, name: 'databaseError', code: JsonRpcErrorCode.DatabaseError },
      {
        fn: requestCancelled,
        name: 'requestCancelled',
        code: JsonRpcErrorCode.RequestCancelled,
      },
    ];

    for (const { fn, name, code } of factories) {
      it(`${name}() should create McpError with code ${code}`, () => {
        const err = fn('test message');
        expect(err).toBeInstanceOf(McpError);
        expect(err.code).toBe(code);
        expect(err.message).toBe('test message');
        expect(err.data).toBeUndefined();
      });

      it(`${name}() should accept optional data`, () => {
        const err = fn('msg', { key: 'val' });
        expect(err.data).toEqual({ key: 'val' });
      });
    }

    it('should pass through cause option', () => {
      const cause = new Error('upstream failure');
      const err = serviceUnavailable('API down', { url: '/foo' }, { cause });
      expect(err.cause).toBe(cause);
      expect(err.data).toEqual({ url: '/foo' });
    });

    it('should pass cause without data', () => {
      const cause = new Error('connection reset');
      const err = timeout('Request timed out', undefined, { cause });
      expect(err.cause).toBe(cause);
      expect(err.data).toBeUndefined();
    });
  });
});

describe('McpError — auth is never carried in error data', () => {
  it('drops `auth` from a RequestContext passed as data', () => {
    const context: RequestContext = {
      requestId: 'req-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      operation: 'probe',
      tenantId: 't1',
      auth: { clientId: 'cid', scopes: ['a'], sub: 'sub', token: 'SECRET' },
    };

    const error = invalidParams('boom', context);

    // `data` goes to the client on the wire and into every error log and span;
    // `auth.token` is the raw bearer credential.
    expect(error.data).toEqual({
      requestId: 'req-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      operation: 'probe',
      tenantId: 't1',
    });
    expect(JSON.stringify(error.data)).not.toContain('SECRET');
  });

  it('drops a bare `auth` key from a plain data payload too', () => {
    const error = internalError('boom', { auth: { token: 'SECRET' }, attempted: 3 });

    expect(error.data).toEqual({ attempted: 3 });
  });

  it('leaves data without `auth` untouched', () => {
    const error = notFound('missing', { uri: 'thing://1', reason: 'gone' });

    expect(error.data).toEqual({ uri: 'thing://1', reason: 'gone' });
  });
});

describe('McpError — subclassing', () => {
  class QuotaError extends McpError {
    constructor(readonly quota: number) {
      super(JsonRpcErrorCode.RateLimited, 'quota spent', { quota });
    }

    remaining(): number {
      return 0;
    }
  }

  class DailyQuotaError extends QuotaError {}

  it('keeps the subclass identity and its own methods', () => {
    const error = new QuotaError(5);

    expect(error).toBeInstanceOf(QuotaError);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toBeInstanceOf(Error);
    expect(error.remaining()).toBe(0);
    expect(error.quota).toBe(5);
  });

  it('keeps identity past the first level of inheritance', () => {
    const error = new DailyQuotaError(1);

    expect(error).toBeInstanceOf(DailyQuotaError);
    expect(error).toBeInstanceOf(QuotaError);
    expect(error).toBeInstanceOf(McpError);
  });

  it('leaves a directly constructed McpError and the factories as McpError', () => {
    expect(new McpError(JsonRpcErrorCode.InternalError, 'x')).toBeInstanceOf(McpError);
    expect(Object.getPrototypeOf(notFound('gone'))).toBe(McpError.prototype);
  });
});

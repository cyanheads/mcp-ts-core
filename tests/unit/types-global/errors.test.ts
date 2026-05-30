/**
 * @fileoverview Test suite for global error types
 * @module tests/types-global/errors.test
 */

import { describe, expect, it } from 'vitest';
import {
  configurationError,
  conflict,
  databaseError,
  type ErrorResponse,
  ErrorSchema,
  forbidden,
  internalError,
  invalidParams,
  invalidRequest,
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  serializationError,
  serviceUnavailable,
  timeout,
  unauthorized,
  validationError,
} from '@/types-global/errors.js';

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
      expect(JsonRpcErrorCode.SerializationError).toBe(-32070);
      expect(JsonRpcErrorCode.UnknownError).toBe(-32099);
    });

    it('should be a valid TypeScript enum', () => {
      expect(typeof JsonRpcErrorCode.ParseError).toBe('number');
      expect(JsonRpcErrorCode[JsonRpcErrorCode.ParseError]).toBe('ParseError');
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

    it('should maintain proper prototype chain', () => {
      const error = new McpError(JsonRpcErrorCode.NotFound, 'Not found');

      expect(Object.getPrototypeOf(error)).toBe(McpError.prototype);
      expect(error instanceof McpError).toBe(true);
      expect(error instanceof Error).toBe(true);
    });

    it('should capture stack trace', () => {
      const error = new McpError(JsonRpcErrorCode.InternalError, 'Test error');

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('McpError');
    });

    it('should set name to "McpError"', () => {
      const error = new McpError(JsonRpcErrorCode.Timeout, 'Request timeout');

      expect(error.name).toBe('McpError');
    });

    it('should handle empty data object', () => {
      const error = new McpError(JsonRpcErrorCode.InvalidRequest, 'Invalid', {});

      expect(error.data).toEqual({});
    });

    it('should handle complex nested data', () => {
      const complexData = {
        nested: { field: 'value' },
        array: [1, 2, 3],
        null: null,
        number: 42,
      };
      const error = new McpError(
        JsonRpcErrorCode.ValidationError,
        'Complex validation error',
        complexData,
      );

      expect(error.data).toEqual(complexData);
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

    it('should allow optional data field', () => {
      const errorWithoutData = {
        code: JsonRpcErrorCode.NotFound,
        message: 'Resource not found',
      };

      const result = ErrorSchema.safeParse(errorWithoutData);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.data).toBeUndefined();
      }
    });

    it('should validate data as a record', () => {
      const errorWithComplexData = {
        code: JsonRpcErrorCode.ValidationError,
        message: 'Complex validation',
        data: {
          errors: [{ field: 'name' }, { field: 'email' }],
          count: 2,
        },
      };

      const result = ErrorSchema.safeParse(errorWithComplexData);
      expect(result.success).toBe(true);
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

    it('should be throwable and catchable as McpError', () => {
      expect(() => {
        throw notFound('Item not found', { itemId: '123' });
      }).toThrow(McpError);
    });

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

  describe('ErrorResponse type', () => {
    it('should correctly type valid error responses', () => {
      const errorResponse: ErrorResponse = {
        code: JsonRpcErrorCode.Forbidden,
        message: 'Access denied',
      };

      expect(errorResponse.code).toBe(JsonRpcErrorCode.Forbidden);
      expect(errorResponse.message).toBe('Access denied');
    });

    it('should correctly type error responses with data', () => {
      const errorResponse: ErrorResponse = {
        code: JsonRpcErrorCode.RateLimited,
        message: 'Too many requests',
        data: { retryAfter: 60 },
      };

      expect(errorResponse.data).toEqual({ retryAfter: 60 });
    });

    it('should be compatible with ErrorSchema', () => {
      const errorResponse: ErrorResponse = {
        code: JsonRpcErrorCode.Timeout,
        message: 'Request timeout',
      };

      const result = ErrorSchema.safeParse(errorResponse);
      expect(result.success).toBe(true);
    });
  });
});

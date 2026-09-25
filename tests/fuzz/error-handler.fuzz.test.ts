/**
 * @fileoverview Fuzz tests for the ErrorHandler classification pipeline.
 * Throws exotic error types and adversarial messages to verify the classifier
 * never crashes and always returns a valid error code.
 * @module tests/fuzz/error-handler.fuzz.test
 */

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

vi.mock('@/config/index.js', () => ({
  config: {
    environment: 'testing',
    mcpServerVersion: '1.0.0-test',
    openTelemetry: { serviceName: 'test', serviceVersion: '0.0.0' },
  },
}));

vi.mock('@/utils/internal/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    crit: vi.fn(),
    emerg: vi.fn(),
    child: vi.fn(),
  },
  Logger: {
    getInstance: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      notice: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      crit: vi.fn(),
      emerg: vi.fn(),
      child: vi.fn(),
    }),
  },
}));

import { ADVERSARIAL_STRINGS } from '@/testing/fuzz.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';

// All valid JSON-RPC error codes the classifier can return
const VALID_CODES = new Set(Object.values(JsonRpcErrorCode).filter((v) => typeof v === 'number'));

describe('ErrorHandler Fuzz Tests', () => {
  describe('determineErrorCode', () => {
    it('always returns a valid JsonRpcErrorCode for random Error messages', () => {
      fc.assert(
        fc.property(fc.string(), (message) => {
          const code = ErrorHandler.determineErrorCode(new Error(message));
          expect(VALID_CODES.has(code)).toBe(true);
        }),
        { numRuns: 200 },
      );
    });

    it('always returns a valid code for adversarial string messages', () => {
      for (const str of ADVERSARIAL_STRINGS) {
        const code = ErrorHandler.determineErrorCode(new Error(str));
        expect(VALID_CODES.has(code)).toBe(true);
      }
    });

    it('handles non-Error thrown values without crashing', () => {
      const exoticValues: unknown[] = [
        'string error',
        42,
        null,
        undefined,
        true,
        false,
        { message: 'object error' },
        [1, 2, 3],
        Symbol('sym'),
        () => {},
        new Map(),
        new Set(),
        new Date(),
        /regex/,
        new Uint8Array(10),
        Object.create(null),
      ];

      for (const value of exoticValues) {
        const code = ErrorHandler.determineErrorCode(value);
        expect(VALID_CODES.has(code)).toBe(true);
      }
    });

    it('preserves McpError codes', () => {
      fc.assert(
        fc.property(fc.constantFrom(...[...VALID_CODES]), fc.string(), (code, message) => {
          const err = new McpError(code as JsonRpcErrorCode, message);
          expect(ErrorHandler.determineErrorCode(err)).toBe(code);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe('classifyOnly', () => {
    it('always returns code + message for any thrown value', () => {
      const values: unknown[] = [
        new Error('test'),
        new TypeError('type'),
        new RangeError('range'),
        new McpError(JsonRpcErrorCode.NotFound, 'not found'),
        'string',
        42,
        null,
        undefined,
        { code: 'ENOENT' },
      ];

      for (const value of values) {
        const result = ErrorHandler.classifyOnly(value);
        expect(VALID_CODES.has(result.code)).toBe(true);
        expect(typeof result.message).toBe('string');
      }
    });
  });

  describe('handleError', () => {
    it('always returns an McpError for random thrown values', () => {
      fc.assert(
        fc.property(fc.string(), (message) => {
          const result = ErrorHandler.handleError(new Error(message), {
            operation: 'fuzz-test',
          });
          expect(result).toBeInstanceOf(McpError);
          expect(typeof result.message).toBe('string');
        }),
        { numRuns: 100 },
      );
    });

    it('handles exotic thrown values', () => {
      const exoticValues: unknown[] = [
        'string',
        42,
        null,
        undefined,
        { code: 'ENOENT' },
        new TypeError('type error'),
        new RangeError('range error'),
        new SyntaxError('syntax error'),
        new URIError('uri error'),
      ];

      for (const value of exoticValues) {
        const result = ErrorHandler.handleError(value, {
          operation: 'fuzz-test',
        });
        expect(result).toBeInstanceOf(McpError);
      }
    });

    it('never leaks internal details in the error message for random inputs', () => {
      fc.assert(
        fc.property(fc.string(), (message) => {
          const result = ErrorHandler.handleError(new Error(message), {
            operation: 'fuzz-test',
            context: { requestId: 'fuzz-req' } as any,
          });
          expect(result.message).not.toMatch(/node_modules/);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('tryCatch', () => {
    it('re-throws as McpError for any thrown value', async () => {
      const exoticThrows: Array<() => never> = [
        () => {
          throw new Error('normal');
        },
        () => {
          throw 'string';
        },
        () => {
          throw 42;
        },
        () => {
          throw null;
        },
        () => {
          throw undefined;
        },
        () => {
          throw { custom: true };
        },
        () => {
          throw new McpError(JsonRpcErrorCode.InternalError, 'mcp');
        },
      ];

      for (const throwFn of exoticThrows) {
        await expect(
          ErrorHandler.tryCatch(async () => throwFn(), { operation: 'fuzz-test' }),
        ).rejects.toBeInstanceOf(McpError);
      }
    });
  });
});

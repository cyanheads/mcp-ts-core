/**
 * @fileoverview Unit tests targeting uncovered branches in ErrorHandler.
 * @module tests/utils/internal/errorHandler.unit.test
 */
import { trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { getErrorMessage } from '@/utils/internal/error-handler/helpers.js';
import { JsonRpcErrorCode, McpError } from '../../../../src/types-global/errors.js';
import { logger } from '../../../../src/utils/internal/logger.js';

describe('ErrorHandler (unit)', () => {
  let getActiveSpanSpy: MockInstance;
  let errorSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    getActiveSpanSpy = vi.spyOn(trace, 'getActiveSpan').mockReturnValue({
      recordException: vi.fn(),
      setStatus: vi.fn(),
      isRecording: vi.fn().mockReturnValue(true),
    } as never);
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    getActiveSpanSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('determineErrorCode - additional branches', () => {
    it('falls back to AbortError special-case when regex patterns are bypassed', () => {
      const abortError = new Error('no matching keywords');
      (abortError as any).name = 'AbortError';

      const originalTest = RegExp.prototype.test;
      const testSpy = vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (
        this: RegExp,
        str: string,
      ) {
        if (this.source.includes('abort') || this.source.includes('cancell')) {
          return false;
        }
        return originalTest.call(this, str);
      });

      try {
        expect(ErrorHandler.determineErrorCode(abortError)).toBe(JsonRpcErrorCode.Timeout);
      } finally {
        testSpy.mockRestore();
      }
    });
  });

  describe('formatError - non-Error input', () => {
    it('returns UnknownError for non-Error values and includes errorType', () => {
      const formatted = ErrorHandler.formatError(42);
      expect(formatted).toMatchObject({
        code: JsonRpcErrorCode.UnknownError,
        message: '42',
        data: { errorType: 'numberEncountered' },
      });
    });
  });

  describe('mapError - defaultFactory path', () => {
    it('normalizes regex flags to include case-insensitive matching', () => {
      const result = ErrorHandler.mapError(
        'FAIL STATE',
        [
          {
            pattern: /fail/g,
            errorCode: JsonRpcErrorCode.ValidationError,
            factory: () => new Error('Regex matched without explicit i flag'),
          },
        ],
        () => new Error('Should not use default factory'),
      );

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('Regex matched without explicit i flag');
    });

    it('supports string patterns for mapping rules', () => {
      const result = ErrorHandler.mapError('literal trigger', [
        {
          pattern: 'literal trigger',
          errorCode: JsonRpcErrorCode.ValidationError,
          factory: () => new Error('String pattern matched'),
        },
      ]);

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('String pattern matched');
    });

    it('passes additional context to mapping factories', () => {
      const factory = vi.fn(() => new Error('Context aware'));
      const result = ErrorHandler.mapError('CTX', [
        {
          pattern: 'ctx',
          errorCode: JsonRpcErrorCode.InternalError,
          additionalContext: { foo: 'bar' },
          factory,
        },
      ]);

      expect(factory).toHaveBeenCalledWith('CTX', { foo: 'bar' });
      expect(result).toBeInstanceOf(Error);
    });
  });

  describe('handleError - includeStack, explicit code, critical', () => {
    it('omits stack when includeStack is false and respects explicit errorCode and critical flag', () => {
      const err = new Error('network down');
      err.stack = 'STACK_LINE_1\nSTACK_LINE_2';
      const final = ErrorHandler.handleError(err, {
        operation: 'explicitCodeTest',
        context: { requestId: 'rid-1' },
        input: { foo: 'bar' },
        includeStack: false,
        critical: true,
        errorCode: JsonRpcErrorCode.ServiceUnavailable,
      });

      // Returned error
      expect(final).toBeInstanceOf(McpError);
      expect((final as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);

      // Logged context
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const call = errorSpy.mock.calls[0];
      if (!call) throw new Error('errorSpy was not called');
      const [msg, ctx] = call;
      expect(String(msg)).toContain('Error in explicitCodeTest:');
      expect(ctx).toMatchObject({
        requestId: 'rid-1',
        operation: 'explicitCodeTest',
        extra: {
          critical: true,
          errorCode: JsonRpcErrorCode.ServiceUnavailable,
        },
      });
      // stack should be omitted in logContext
      expect((ctx as Record<string, any>).extra.stack).toBeUndefined();
    });

    it('preserves original McpError data and does not duplicate originalStack when already present', () => {
      const original = new McpError(JsonRpcErrorCode.InternalError, 'oops', {
        originalStack: 'ORIG_STACK',
        foo: 'bar',
      });
      const final = ErrorHandler.handleError(original, {
        operation: 'mcpDataTest',
        context: { requestId: 'rid-2' },
      });

      expect(final).toBeInstanceOf(McpError);
      expect((final as McpError).code).toBe(JsonRpcErrorCode.InternalError);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const call = errorSpy.mock.calls[0];
      if (!call) throw new Error('errorSpy was not called');
      const [, ctx] = call;
      const data = (ctx as Record<string, any>).extra.errorData;
      expect(data).toMatchObject({
        originalErrorName: 'McpError',
        originalMessage: 'oops',
        foo: 'bar',
        originalStack: 'ORIG_STACK', // carried through, not duplicated
      });
    });

    it('captures nested causes, reuses original stack when mapper clears it, and sanitizes diverse inputs', () => {
      const root = new Error('root-cause');
      const mid = new Error('mid-level');
      (mid as any).cause = root;
      const outer = new Error('outermost');
      (outer as any).cause = mid;
      outer.stack = 'OUTER_STACK';

      const final = ErrorHandler.handleError(outer, {
        operation: 'rootCauseTest',
        context: { extra: { detail: 'details' } },
        input: function sampleFn() {
          return 'noop';
        },
        errorMapper: (err) => {
          const mapped = new Error(`mapped: ${(err as Error).message}`);
          delete mapped.stack;
          return mapped;
        },
      });

      expect(final).toBeInstanceOf(Error);
      expect(final.message).toBe('mapped: outermost');
      expect(final.stack).toBe('OUTER_STACK');

      const call = errorSpy.mock.calls[0];
      if (!call) throw new Error('errorSpy was not called');
      const [, ctx] = call;
      const errorData = (ctx as Record<string, any>).extra.errorData;
      expect(errorData.rootCause).toEqual({
        name: 'Error',
        message: 'root-cause',
      });
      const loggedInput = (ctx as Record<string, any>).extra.input;
      expect(typeof loggedInput).toBe('function');
      expect((loggedInput as (...args: unknown[]) => unknown).name).toBe('sampleFn');
    });
  });

  describe('returned data vs. log record (#519)', () => {
    /** The `errorData` of the most recent `error`-level log record. */
    const loggedErrorData = (): Record<string, any> => {
      const ctx = errorSpy.mock.calls.at(-1)?.[1] as Record<string, any> | undefined;
      if (!ctx) throw new Error('errorSpy was not called');
      return ctx.extra.errorData;
    };

    it('keeps originalStack and causeChain out of the returned data and in the log', () => {
      const err = new Error('db read failed', { cause: new Error('EACCES') });

      const final = ErrorHandler.handleError(err, {
        operation: 'stackSplit',
        context: { requestId: 'rid-519' },
      }) as McpError;

      expect(final.code).toBe(JsonRpcErrorCode.InternalError);
      expect(final.data).toEqual({
        requestId: 'rid-519',
        originalErrorName: 'Error',
        originalMessage: 'db read failed',
        rootCause: { name: 'Error', message: 'EACCES' },
      });

      const errorData = loggedErrorData();
      expect(errorData.originalStack).toBe(err.stack);
      expect(errorData.causeChain).toHaveLength(2);
      for (const node of errorData.causeChain) expect(node.stack).toEqual(expect.any(String));
      expect(errorData.rootCause).toEqual({ name: 'Error', message: 'EACCES' });
    });

    it('throws a tryCatch error whose data carries no stack while the log keeps the throw site', async () => {
      const thrown = await ErrorHandler.tryCatch(
        () => {
          throw new Error('db read failed', { cause: new Error('EACCES') });
        },
        { operation: 'MyService.read' },
      ).catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(McpError);
      expect((thrown as McpError).code).toBe(JsonRpcErrorCode.InternalError);
      expect(JSON.stringify((thrown as McpError).data)).not.toMatch(/stack|causeChain/i);

      const errorData = loggedErrorData();
      expect(errorData.originalStack).toContain('errorHandler.unit.test.ts');
      expect(errorData.causeChain.map((n: { message: string }) => n.message)).toEqual([
        'db read failed',
        'EACCES',
      ]);
    });

    it('leaves a cancellation with neither a stack nor a cause chain, in data or log', () => {
      const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
      try {
        const final = ErrorHandler.handleError(
          new McpError(JsonRpcErrorCode.RequestCancelled, 'gone', undefined, {
            cause: new Error('socket closed'),
          }),
          { operation: 'cancelSplit' },
        ) as McpError;

        const ctx = infoSpy.mock.calls.at(-1)?.[1] as Record<string, any>;
        for (const data of [final.data, ctx.extra.errorData]) {
          expect(data).not.toHaveProperty('originalStack');
          expect(data).not.toHaveProperty('causeChain');
        }
        expect(ctx.extra).not.toHaveProperty('stack');
      } finally {
        infoSpy.mockRestore();
      }
    });
  });

  describe('formatError helper coverage', () => {
    it('handles null, undefined, function, symbol, and complex objects', () => {
      const nullResult = ErrorHandler.formatError(null);
      const undefinedResult = ErrorHandler.formatError(undefined);
      const fnResult = ErrorHandler.formatError(function namedFn() {
        return 1;
      });
      const symbol = Symbol('tok');
      const symbolResult = ErrorHandler.formatError(symbol);
      const jsonResult = ErrorHandler.formatError({ foo: 'bar' });
      const bigintResult = ErrorHandler.formatError(BigInt(123));

      expect(nullResult).toMatchObject({
        code: JsonRpcErrorCode.UnknownError,
        message: 'Null value encountered as error',
        data: { errorType: 'NullValueEncountered' },
      });
      expect(undefinedResult).toMatchObject({
        message: 'Undefined value encountered as error',
        data: { errorType: 'UndefinedValueEncountered' },
      });
      expect(fnResult.message).toBe('[function namedFn]');
      expect(symbolResult.message).toBe(symbol.toString());
      expect(jsonResult.message).toBe(JSON.stringify({ foo: 'bar' }));
      expect(bigintResult.message).toBe('123');
    });

    it('recovers when symbol stringification fails', () => {
      const original = Symbol.prototype.toString;
      Object.defineProperty(Symbol.prototype, 'toString', {
        configurable: true,
        writable: true,
        value(): string {
          throw new Error('symbol toString unavailable');
        },
      });

      try {
        const result = ErrorHandler.formatError(Symbol('boom'));
        expect(result).toMatchObject({
          code: JsonRpcErrorCode.UnknownError,
          message: expect.stringContaining('symbol toString unavailable'),
        });
      } finally {
        Object.defineProperty(Symbol.prototype, 'toString', {
          configurable: true,
          writable: true,
          value: original,
        });
      }
    });

    it('falls back when reading aggregate errors fails unexpectedly', () => {
      const aggregate = new AggregateError([], 'aggregate failure');
      const proxyError = new Proxy(aggregate, {
        has(target, prop) {
          if (prop === 'errors') {
            throw new Error('errors accessor failed');
          }
          return Reflect.has(target, prop);
        },
      });

      expect(getErrorMessage(proxyError)).toBe(
        'Error converting error to string: errors accessor failed',
      );
      expect(ErrorHandler.determineErrorCode(proxyError)).toBe(JsonRpcErrorCode.InternalError);
    });

    // Additional edge cases are exercised via other tests to ensure helper fallbacks work.
  });
});

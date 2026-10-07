/**
 * @fileoverview Unit tests targeting uncovered branches in ErrorHandler.
 * @module tests/utils/internal/errorHandler.unit.test
 */
import { SpanStatusCode, trace } from '@opentelemetry/api';
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

    it('omits the throw-site originalStack from the record under includeStack: false (#586)', () => {
      const err = new Error('network down');
      err.stack = 'STACK_LINE_1\nSTACK_LINE_2';

      ErrorHandler.handleError(err, { operation: 'noStackTest', includeStack: false });

      const ctx = errorSpy.mock.calls.at(-1)?.[1] as Record<string, any>;
      expect(ctx.extra.errorData).toMatchObject({
        originalErrorName: 'Error',
        originalMessage: 'network down',
      });
      expect(ctx.extra.errorData).not.toHaveProperty('originalStack');
      expect(JSON.stringify(ctx)).not.toContain('STACK_LINE_1');
    });

    it('drops an originalStack carried in a thrown McpError from the log, not from the returned data (#586)', () => {
      const original = new McpError(JsonRpcErrorCode.InternalError, 'oops', {
        originalStack: 'ORIG_STACK',
        foo: 'bar',
      });

      const final = ErrorHandler.handleError(original, {
        operation: 'mcpDataNoStackTest',
        includeStack: false,
      }) as McpError;

      const ctx = errorSpy.mock.calls.at(-1)?.[1] as Record<string, any>;
      expect(ctx.extra.errorData).toMatchObject({ originalErrorName: 'McpError', foo: 'bar' });
      expect(ctx.extra.errorData).not.toHaveProperty('originalStack');
      expect(final.data).toMatchObject({ originalStack: 'ORIG_STACK', foo: 'bar' });
      expect(original.data).toEqual({ originalStack: 'ORIG_STACK', foo: 'bar' });
    });

    it.each([
      ['stack', 'boom'],
      ['message', '[Unreadable]'],
      ['name', 'boom'],
    ])(
      'marks a recording span failed, never throwing, for an Error whose %s getter throws (#697)',
      (key, message) => {
        // The OTel SDK's recordException reads code, name, message, and stack unguarded.
        const span = {
          recordException: vi.fn((e: Error) => {
            void [e.name, e.message, e.stack];
          }),
          setStatus: vi.fn(),
          isRecording: () => true,
        };
        getActiveSpanSpy.mockReturnValue(span as never);
        const err = Object.defineProperty(new Error('boom'), key, {
          configurable: true,
          get() {
            throw new Error(`${key} getter`);
          },
        });

        let returned: Error | undefined;
        expect(() => {
          returned = ErrorHandler.handleError(err, { operation: 'spanUnreadable' });
        }).not.toThrow();

        expect(returned).toBeInstanceOf(McpError);
        expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message });
        expect(errorSpy).toHaveBeenCalledTimes(1);
      },
    );

    it('still records the exception, stack intact, on the active span under includeStack: false', () => {
      const err = new Error('span keeps it');
      const span = { recordException: vi.fn(), setStatus: vi.fn(), isRecording: () => true };
      getActiveSpanSpy.mockReturnValue(span as never);

      ErrorHandler.handleError(err, { operation: 'spanTest', includeStack: false });

      expect(span.recordException).toHaveBeenCalledWith(err);
      expect(err.stack).toEqual(expect.any(String));
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
    /** The `extra` of the most recent `error`-level log record. */
    const loggedExtra = (): Record<string, any> => {
      const ctx = errorSpy.mock.calls.at(-1)?.[1] as Record<string, any> | undefined;
      if (!ctx) throw new Error('errorSpy was not called');
      return ctx.extra;
    };
    const loggedErrorData = (): Record<string, any> => loggedExtra().errorData;

    it('keeps the stack and causeChain out of the returned data and in the log', () => {
      const err = new Error('db read failed', { cause: new Error('EACCES') });

      const final = ErrorHandler.handleError(err, {
        operation: 'stackSplit',
        context: { requestId: 'rid-519' },
      }) as McpError;

      expect(final.code).toBe(JsonRpcErrorCode.InternalError);
      // No `requestId`: the context rides the log record only (#548), and no
      // `rootCause`: nothing derived from a cause reaches `data` (#644).
      expect(final.data).toEqual({
        originalErrorName: 'Error',
        originalMessage: 'db read failed',
      });

      // The record's one stack is the throw site's (#694): the chain's first
      // node is the thrown error and does not repeat it; the cause keeps its own.
      expect(loggedExtra().stack).toBe(err.stack);
      const errorData = loggedErrorData();
      expect(errorData).not.toHaveProperty('originalStack');
      expect(errorData.causeChain).toHaveLength(2);
      expect(errorData.causeChain[0]).not.toHaveProperty('stack');
      expect(errorData.causeChain[1].stack).toBe((err.cause as Error).stack);
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

      expect(loggedExtra().stack).toContain('errorHandler.unit.test.ts');
      expect((thrown as McpError).stack).toBe(loggedExtra().stack);
      const errorData = loggedErrorData();
      expect(errorData).not.toHaveProperty('originalStack');
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

    it('keeps a cancellation stack-free and chain-free under includeStack: false too', () => {
      const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
      try {
        ErrorHandler.handleError(
          new McpError(JsonRpcErrorCode.RequestCancelled, 'gone', undefined, {
            cause: new Error('socket closed'),
          }),
          { operation: 'cancelSplit', includeStack: false },
        );

        expect(errorSpy).not.toHaveBeenCalled();
        const ctx = infoSpy.mock.calls.at(-1)?.[1] as Record<string, any>;
        expect(ctx.extra).not.toHaveProperty('stack');
        expect(ctx.extra.errorData).not.toHaveProperty('originalStack');
        expect(ctx.extra.errorData).not.toHaveProperty('causeChain');
      } finally {
        infoSpy.mockRestore();
      }
    });
  });

  // Issue #644 — nothing derived from a cause reaches the returned error's
  // `data`, so a redaction that keeps the raw error on `cause` stays redacted.
  describe('a cause stays off the returned data (#644)', () => {
    const HOST_DIR = '/srv/exports';
    const redacted = 'IO Error: Cannot open file "[path]/out.csv": Permission denied';
    const causes: ReadonlyArray<readonly [string, () => unknown]> = [
      [
        'an Error',
        () => new Error(`IO Error: Cannot open file "${HOST_DIR}/out.csv": Permission denied`),
      ],
      ['a string', () => `open ${HOST_DIR}/out.csv: EACCES`],
      ['a plain object', () => ({ path: `${HOST_DIR}/out.csv`, errno: -13 })],
    ];
    const throwers: ReadonlyArray<readonly [string, (cause: unknown) => Error]> = [
      [
        'an McpError',
        (cause) =>
          new McpError(JsonRpcErrorCode.DatabaseError, redacted, { table: 'out' }, { cause }),
      ],
      ['a plain Error', (cause) => new Error(redacted, { cause })],
    ];
    const matrix = throwers.flatMap(([thrower, make]) =>
      causes.map(([cause, makeCause]) => [thrower, cause, () => make(makeCause())] as const),
    );

    /** What `tryCatch` rethrows for `thrown`. */
    async function rethrown(thrown: Error): Promise<McpError> {
      const error = await ErrorHandler.tryCatch(
        () => {
          throw thrown;
        },
        { operation: 'exportTable' },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McpError);
      return error as McpError;
    }

    it.each(matrix)(
      'tryCatch over %s whose cause is %s rethrows data with no host path',
      async (_thrower, _cause, make) => {
        const error = await rethrown(make());

        expect(error.message).toBe(redacted);
        expect(error.data).not.toHaveProperty('rootCause');
        expect(error.data).toMatchObject({ originalMessage: redacted });
        expect(JSON.stringify(error.data)).not.toContain(HOST_DIR);
      },
    );

    it.each(matrix)(
      'the record for %s whose cause is %s keeps the raw rootCause and causeChain',
      async (_thrower, _cause, make) => {
        await rethrown(make());

        const { errorData } = (errorSpy.mock.calls.at(-1)?.[1] as Record<string, any>)?.extra ?? {};
        expect(errorData.rootCause.message).toContain(HOST_DIR);
        expect(errorData.causeChain.at(-1)).toMatchObject({
          name: errorData.rootCause.name,
          message: errorData.rootCause.message,
        });
      },
    );

    it("passes a thrown McpError's own data through, a rootCause it set itself included", async () => {
      const own = { rootCause: { name: 'QuotaError', message: 'Quota exhausted.' }, table: 'out' };

      const error = await rethrown(
        new McpError(JsonRpcErrorCode.DatabaseError, redacted, own, {
          cause: new Error(`open ${HOST_DIR}/out.csv: EACCES`),
        }),
      );

      expect(error.data).toEqual({
        ...own,
        originalErrorName: 'McpError',
        originalMessage: redacted,
      });
    });

    it('re-derives nothing from the chain in a nested tryCatch', async () => {
      const inner = await rethrown(
        new Error(redacted, { cause: new Error(`open ${HOST_DIR}/out.csv: EACCES`) }),
      );

      const outer = await rethrown(inner);

      expect(outer.data).toEqual({ originalErrorName: 'McpError', originalMessage: redacted });
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

    it('recovers when symbol stringification fails, writing the message [Unreadable] (#697)', () => {
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
          message: '[Unreadable]',
        });
      } finally {
        Object.defineProperty(Symbol.prototype, 'toString', {
          configurable: true,
          writable: true,
          value: original,
        });
      }
    });

    it('falls back to [Unreadable] when reading aggregate errors fails unexpectedly (#697)', () => {
      const aggregate = new AggregateError([], 'aggregate failure');
      const proxyError = new Proxy(aggregate, {
        has(target, prop) {
          if (prop === 'errors') {
            throw new Error('errors accessor failed');
          }
          return Reflect.has(target, prop);
        },
      });

      // The trap's own text is not the error's message.
      expect(getErrorMessage(proxyError)).toBe('[Unreadable]');
      expect(ErrorHandler.determineErrorCode(proxyError)).toBe(JsonRpcErrorCode.InternalError);
    });

    // Additional edge cases are exercised via other tests to ensure helper fallbacks work.
  });
});

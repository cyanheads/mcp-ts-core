/**
 * @fileoverview Test suite for ErrorHandler class — error classification, formatting,
 * tryCatch, mapError, and handleError behavior.
 * @module tests/utils/internal/error-handler/errorHandler.test
 */

import { SdkError, SdkErrorCode } from '@modelcontextprotocol/server';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { z } from 'zod';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { logger } from '@/utils/internal/logger.js';

// Suppress logger output in tests
vi.mock('@/utils/internal/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    crit: vi.fn(),
  },
}));

describe('ErrorHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── determineErrorCode ──────────────────────────────────────────────────────

  describe('determineErrorCode', () => {
    it('should return McpError code directly', () => {
      const err = new McpError(JsonRpcErrorCode.Forbidden, 'denied');
      expect(ErrorHandler.determineErrorCode(err)).toBe(JsonRpcErrorCode.Forbidden);
    });

    it('should leave TypeError unmapped (InternalError)', () => {
      expect(ErrorHandler.determineErrorCode(new TypeError('bad'))).toBe(
        JsonRpcErrorCode.InternalError,
      );
    });

    it('should map SyntaxError to ValidationError', () => {
      expect(ErrorHandler.determineErrorCode(new SyntaxError('parse'))).toBe(
        JsonRpcErrorCode.ValidationError,
      );
    });

    it('should map RangeError to ValidationError', () => {
      expect(ErrorHandler.determineErrorCode(new RangeError('out'))).toBe(
        JsonRpcErrorCode.ValidationError,
      );
    });

    // Issue #482 — the engine's resource-limit errors are RangeErrors too, but
    // name nothing a caller can change.
    describe('engine resource-limit RangeErrors (#482)', () => {
      /** The value `run` throws, for classifying what this engine actually raises. */
      function thrownBy(run: () => unknown): unknown {
        try {
          run();
        } catch (error) {
          return error;
        }
        throw new Error('expected the probe to throw');
      }

      it.each([
        'Maximum call stack size exceeded', // V8
        'Maximum call stack size exceeded.', // JavaScriptCore
        'Invalid string length', // V8 string-size limit
        'Out of memory', // JavaScriptCore string-size limit
      ])('maps a RangeError reading "%s" to InternalError', (message) => {
        expect(ErrorHandler.determineErrorCode(new RangeError(message))).toBe(
          JsonRpcErrorCode.InternalError,
        );
      });

      it('maps the stack overflow this engine raises to InternalError', () => {
        const recurse = (): number => recurse() + 1;
        const overflow = thrownBy(recurse);

        expect(overflow).toBeInstanceOf(RangeError);
        expect(ErrorHandler.determineErrorCode(overflow)).toBe(JsonRpcErrorCode.InternalError);
      });

      it.each([
        ['new Array(-1)', () => new Array(-1)],
        ['(1).toFixed(101)', () => (1).toFixed(101)],
        ['new Date(NaN).toISOString()', () => new Date(Number.NaN).toISOString()],
        ['1n / 0n', () => 1n / BigInt(0)],
      ])('keeps the RangeError from %s on ValidationError', (_label, run) => {
        const error = thrownBy(run);

        expect(error).toBeInstanceOf(RangeError);
        expect(ErrorHandler.determineErrorCode(error)).toBe(JsonRpcErrorCode.ValidationError);
      });

      it.each([
        'Invalid array length', // V8, new Array(-1)
        'Array length must be a positive integer of safe magnitude.', // JavaScriptCore
        'Division by zero', // V8, 1n / 0n
        '0 is an invalid divisor value.', // JavaScriptCore
        'Invalid time value', // V8, Invalid Date
        'Invalid Date', // JavaScriptCore
        'Wrapped: Maximum call stack size exceeded',
        'Maximum call stack size exceeded while parsing',
      ])('keeps a RangeError reading "%s" on ValidationError', (message) => {
        expect(ErrorHandler.determineErrorCode(new RangeError(message))).toBe(
          JsonRpcErrorCode.ValidationError,
        );
      });

      it('leaves a non-RangeError carrying a limit text to the ladder', () => {
        expect(ErrorHandler.determineErrorCode(new Error('Out of memory'))).toBe(
          JsonRpcErrorCode.InternalError,
        );
        expect(ErrorHandler.determineErrorCode(new SyntaxError('Invalid string length'))).toBe(
          JsonRpcErrorCode.ValidationError,
        );
      });
    });

    it('should map ReferenceError to InternalError', () => {
      expect(ErrorHandler.determineErrorCode(new ReferenceError('undef'))).toBe(
        JsonRpcErrorCode.InternalError,
      );
    });

    it('should classify auth-related message as Unauthorized', () => {
      expect(ErrorHandler.determineErrorCode(new Error('unauthorized access'))).toBe(
        JsonRpcErrorCode.Unauthorized,
      );
    });

    it('should classify "Invalid auth token format" as ValidationError not Unauthorized', () => {
      // Regression: bare "auth" substring previously matched Unauthorized before ValidationError
      expect(ErrorHandler.determineErrorCode(new Error('Invalid auth token format'))).toBe(
        JsonRpcErrorCode.ValidationError,
      );
    });

    it('should not misclassify "missing required field" as NotFound', () => {
      // Regression: bare "missing" previously matched NotFound before ValidationError
      expect(ErrorHandler.determineErrorCode(new Error('missing required field: name'))).toBe(
        JsonRpcErrorCode.ValidationError,
      );
    });

    it('should classify permission-related message as Forbidden', () => {
      expect(ErrorHandler.determineErrorCode(new Error('permission denied'))).toBe(
        JsonRpcErrorCode.Forbidden,
      );
    });

    it('should classify not-found message as NotFound', () => {
      expect(ErrorHandler.determineErrorCode(new Error('resource not found'))).toBe(
        JsonRpcErrorCode.NotFound,
      );
    });

    it('should classify validation message as ValidationError', () => {
      expect(ErrorHandler.determineErrorCode(new Error('invalid input format'))).toBe(
        JsonRpcErrorCode.ValidationError,
      );
    });

    it('should classify conflict message as Conflict', () => {
      expect(ErrorHandler.determineErrorCode(new Error('already exists'))).toBe(
        JsonRpcErrorCode.Conflict,
      );
    });

    it('should classify rate limit message as RateLimited', () => {
      expect(ErrorHandler.determineErrorCode(new Error('rate limit exceeded'))).toBe(
        JsonRpcErrorCode.RateLimited,
      );
    });

    it('should classify timeout message as Timeout', () => {
      expect(ErrorHandler.determineErrorCode(new Error('request timed out'))).toBe(
        JsonRpcErrorCode.Timeout,
      );
    });

    it('should classify service unavailable message', () => {
      expect(ErrorHandler.determineErrorCode(new Error('service unavailable'))).toBe(
        JsonRpcErrorCode.ServiceUnavailable,
      );
    });

    it.each([
      ['access denied', JsonRpcErrorCode.Forbidden],
      ['operation cancelled', JsonRpcErrorCode.Timeout],
    ])('should classify "%s" by its pattern alternation', (message, code) => {
      expect(ErrorHandler.determineErrorCode(new Error(message))).toBe(code);
    });

    it('should classify AbortError special case as Timeout', () => {
      const err = { name: 'AbortError', message: 'signal aborted' };
      expect(ErrorHandler.determineErrorCode(err)).toBe(JsonRpcErrorCode.Timeout);
    });

    // Provider-specific patterns
    it('should classify AWS ThrottlingException as RateLimited', () => {
      expect(ErrorHandler.determineErrorCode(new Error('ThrottlingException'))).toBe(
        JsonRpcErrorCode.RateLimited,
      );
    });

    it('should classify HTTP status code 401 as Unauthorized', () => {
      expect(ErrorHandler.determineErrorCode(new Error('status code 401'))).toBe(
        JsonRpcErrorCode.Unauthorized,
      );
    });

    it('should classify ECONNREFUSED as ServiceUnavailable', () => {
      expect(ErrorHandler.determineErrorCode(new Error('ECONNREFUSED'))).toBe(
        JsonRpcErrorCode.ServiceUnavailable,
      );
    });

    it('should classify a transport-closed SdkError as RequestCancelled (#386)', () => {
      // The SDK rejects a request in flight when the transport closes. The
      // caller went away — that is a cancellation, not a fault in this server.
      const err = new SdkError(
        SdkErrorCode.ConnectionClosed,
        'Connection closed before a response was produced',
      );
      expect(ErrorHandler.determineErrorCode(err)).toBe(JsonRpcErrorCode.RequestCancelled);
    });

    it('classifies the pre-dispatch abort variant as RequestCancelled too (#386)', () => {
      // Same code, different message — matched structurally, so the wording of
      // either message is free to change upstream. This one would otherwise hit
      // the generic `abort(ed)?` pattern and read as a Timeout.
      const err = new SdkError(
        SdkErrorCode.ConnectionClosed,
        'The request was aborted before it could be handled',
      );
      expect(ErrorHandler.determineErrorCode(err)).toBe(JsonRpcErrorCode.RequestCancelled);
    });

    it('leaves a non-cancellation SdkError to the normal pattern ladder', () => {
      const err = new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out');
      expect(ErrorHandler.determineErrorCode(err)).toBe(JsonRpcErrorCode.Timeout);
    });

    it('should default unknown errors to InternalError', () => {
      expect(ErrorHandler.determineErrorCode(new Error('something weird'))).toBe(
        JsonRpcErrorCode.InternalError,
      );
    });

    it('should handle non-Error values', () => {
      expect(ErrorHandler.determineErrorCode('raw string error')).toBe(
        JsonRpcErrorCode.InternalError,
      );
    });
  });

  // ─── classifyOnly ────────────────────────────────────────────────────────────

  describe('classifyOnly', () => {
    it('should preserve McpError code and message without data', () => {
      const err = new McpError(JsonRpcErrorCode.NotFound, 'gone', { id: 1 });
      const result = ErrorHandler.classifyOnly(err);
      expect(result.code).toBe(JsonRpcErrorCode.NotFound);
      expect(result.message).toBe('gone');
      expect(result.data).toBeUndefined();
    });

    it('should flatten ZodError message and surface issues in data', () => {
      const zodErr = z.object({ name: z.string() }).safeParse({ name: 42 });
      expect(zodErr.success).toBe(false);
      if (zodErr.success) return;

      const result = ErrorHandler.classifyOnly(zodErr.error);

      expect(result.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(result.message).not.toContain('[\n');
      expect(result.message).not.toContain('"code":');
      expect(result.data).toBeDefined();
      expect(Array.isArray((result.data as { issues: unknown[] }).issues)).toBe(true);
    });

    it('should classify plain Error without data', () => {
      const result = ErrorHandler.classifyOnly(new Error('boom'));
      expect(result.message).toBe('boom');
      expect(result.data).toBeUndefined();
    });
  });

  // ─── handleError ─────────────────────────────────────────────────────────────

  describe('handleError', () => {
    it('should wrap generic Error as McpError preserving original message', () => {
      const result = ErrorHandler.handleError(new Error('generic'), {
        operation: 'testOp',
      });
      expect(result).toBeInstanceOf(McpError);
      // Message should be the original error message — no `Error in ${operation}:` prefix.
      // Operation context is preserved in the log line and logContext, not the message.
      expect(result.message).toBe('generic');
    });

    it('should rethrow when rethrow option is true', () => {
      expect(() =>
        ErrorHandler.handleError(new Error('boom'), {
          operation: 'test',
          rethrow: true,
        }),
      ).toThrow();
    });

    it('should use custom errorMapper when provided', () => {
      const custom = new Error('custom mapped');
      const result = ErrorHandler.handleError(new Error('original'), {
        operation: 'op',
        errorMapper: () => custom,
      });
      expect(result).toBe(custom);
    });

    it('should handle non-Error values', () => {
      const result = ErrorHandler.handleError('string error', {
        operation: 'op',
      });
      expect(result).toBeInstanceOf(McpError);
      expect(result.message).toContain('string error');
    });

    it('logs a cancellation at info without a stack (#386)', () => {
      const err = new SdkError(
        SdkErrorCode.ConnectionClosed,
        'Connection closed before a response was produced',
      );

      const result = ErrorHandler.handleError(err, { operation: 'tool:demo' }) as McpError;

      expect(result.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('tool:demo'),
        expect.objectContaining({
          extra: expect.objectContaining({ errorCode: JsonRpcErrorCode.RequestCancelled }),
        }),
      );
      const logged = vi.mocked(logger.info).mock.calls.at(-1)?.[1] as {
        extra?: Record<string, unknown>;
      };
      expect(logged.extra).not.toHaveProperty('stack');
    });

    it('logs a cancelled fetch at info without a stack (#386)', () => {
      // The other half of the same failure: `fetchWithTimeout`'s own abort error
      // arrives here already carrying the cancellation code.
      const err = new McpError(
        JsonRpcErrorCode.RequestCancelled,
        'fetch GET https://x was aborted.',
      );

      ErrorHandler.handleError(err, { operation: 'tool:demo' });

      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledOnce();
    });

    it('still logs every other code at error, with the stack (#386 regression guard)', () => {
      ErrorHandler.handleError(new Error('upstream exploded'), { operation: 'tool:demo' });

      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledOnce();
      const logged = vi.mocked(logger.error).mock.calls.at(-1)?.[1] as {
        extra?: Record<string, unknown>;
      };
      expect(typeof logged.extra?.stack).toBe('string');
    });

    // Issue #380 — a failure a definition declared in its `errors[]` contract
    // is a modeled result, not an incident. `severity` moves the level of that
    // one record and nothing else.
    describe('declared severity (#380)', () => {
      it.each(['debug', 'info', 'notice', 'warning'] as const)(
        'emits the record at %s instead of error',
        (severity) => {
          ErrorHandler.handleError(
            new McpError(JsonRpcErrorCode.InvalidRequest, 'The delete was not confirmed.', {
              reason: 'consent_declined',
            }),
            { operation: 'tool:delete_thing', severity },
          );

          expect(logger.error).not.toHaveBeenCalled();
          expect(logger[severity]).toHaveBeenCalledWith(
            'Error in tool:delete_thing: The delete was not confirmed.',
            expect.objectContaining({
              operation: 'tool:delete_thing',
              extra: expect.objectContaining({ errorCode: JsonRpcErrorCode.InvalidRequest }),
            }),
          );
        },
      );

      it('changes the level and nothing else about the record', () => {
        const thrown = new McpError(JsonRpcErrorCode.InvalidRequest, 'Declined.', {
          reason: 'consent_declined',
        });
        // `includeStack: false` on both legs: the record's own `stack` is the
        // handler's rebuilt error, whose frames name the call site, so the two
        // legs differ there for a reason that has nothing to do with severity.
        const shared = {
          operation: 'tool:demo',
          context: { requestId: 'req-severity', timestamp: '2026-01-01T00:00:00.000Z' },
          includeStack: false,
        };

        ErrorHandler.handleError(thrown, { ...shared, severity: 'notice' });
        const noticed = vi.mocked(logger.notice).mock.calls.at(-1);

        vi.clearAllMocks();
        ErrorHandler.handleError(thrown, shared);
        const errored = vi.mocked(logger.error).mock.calls.at(-1);

        expect(noticed?.[0]).toBe(errored?.[0]);
        expect(noticed?.[1]).toEqual(errored?.[1]);
      });

      it('returns the same McpError it would without a severity', () => {
        const thrown = new McpError(JsonRpcErrorCode.InvalidRequest, 'Declined.', {
          reason: 'consent_declined',
        });

        const quiet = ErrorHandler.handleError(thrown, {
          operation: 'tool:demo',
          severity: 'notice',
        }) as McpError;
        const loud = ErrorHandler.handleError(thrown, { operation: 'tool:demo' }) as McpError;

        expect(quiet.code).toBe(loud.code);
        expect(quiet.message).toBe(loud.message);
        expect(quiet.data).toEqual(loud.data);
      });

      it('never outranks the cancellation path', () => {
        // A caller who withdrew the request is logged at info with no stack
        // whatever the contract says about the reason.
        ErrorHandler.handleError(
          new McpError(JsonRpcErrorCode.RequestCancelled, 'Caller went away.'),
          { operation: 'tool:demo', severity: 'warning' },
        );

        expect(logger.warning).not.toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledOnce();
        expect(vi.mocked(logger.info).mock.calls.at(-1)?.[0]).toContain('Cancelled tool:demo');
      });
    });

    it('honors includeStack: false independently of the code', () => {
      ErrorHandler.handleError(new Error('upstream exploded'), {
        operation: 'tool:demo',
        includeStack: false,
      });

      const logged = vi.mocked(logger.error).mock.calls.at(-1)?.[1] as {
        extra?: Record<string, unknown>;
      };
      expect(logged.extra).not.toHaveProperty('stack');
    });

    describe('OpenTelemetry span recording', () => {
      const span = {
        recordException: vi.fn(),
        setStatus: vi.fn(),
        isRecording: vi.fn(),
      };
      let getActiveSpanSpy: MockInstance;

      beforeEach(() => {
        span.isRecording.mockReturnValue(true);
        getActiveSpanSpy = vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span as never);
      });

      afterEach(() => {
        getActiveSpanSpy.mockRestore();
      });

      it('records the exception and an ERROR status on the active span', () => {
        const error = new Error('Telemetry test');
        ErrorHandler.handleError(error, { operation: 'otelTest' });

        expect(span.recordException).toHaveBeenCalledWith(error);
        expect(span.setStatus).toHaveBeenCalledWith({
          code: SpanStatusCode.ERROR,
          message: 'Telemetry test',
        });
      });

      it('sets a stringified ERROR status without recordException for a non-Error value', () => {
        ErrorHandler.handleError('plain failure', { operation: 'otelTest' });

        expect(span.recordException).not.toHaveBeenCalled();
        expect(span.setStatus).toHaveBeenCalledWith({
          code: SpanStatusCode.ERROR,
          message: 'plain failure',
        });
      });

      it('skips the span write when the active span is no longer recording (#93)', () => {
        // measure*Execution already recorded and ended the span before re-throwing;
        // writing again triggers "Cannot execute the operation on ended Span".
        span.isRecording.mockReturnValue(false);
        ErrorHandler.handleError(new Error('post-end write'), { operation: 'endedSpanTest' });

        expect(span.recordException).not.toHaveBeenCalled();
        expect(span.setStatus).not.toHaveBeenCalled();
      });
    });
  });

  // ─── formatError ─────────────────────────────────────────────────────────────

  describe('formatError', () => {
    it('should format McpError with code, message, data', () => {
      const err = new McpError(JsonRpcErrorCode.InvalidParams, 'bad', {
        field: 'x',
      });
      const formatted = ErrorHandler.formatError(err);
      expect(formatted).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        message: 'bad',
        data: { field: 'x' },
      });
    });

    it('should format generic Error', () => {
      const formatted = ErrorHandler.formatError(new TypeError('wrong'));
      expect(formatted).toMatchObject({
        code: JsonRpcErrorCode.InternalError,
        message: 'wrong',
        data: { errorType: 'TypeError' },
      });
    });
  });

  // ─── tryCatch ────────────────────────────────────────────────────────────────

  describe('tryCatch', () => {
    it('should handle sync functions', async () => {
      const result = await ErrorHandler.tryCatch(() => 'sync', {
        operation: 'test',
      });
      expect(result).toBe('sync');
    });
  });

  // ─── mapError ────────────────────────────────────────────────────────────────

  describe('mapError', () => {
    it('should call factory when pattern matches error message', () => {
      const custom = new Error('custom');
      const mappings = [
        {
          pattern: /timeout/i,
          errorCode: JsonRpcErrorCode.Timeout,
          factory: () => custom,
        },
      ];
      const result = ErrorHandler.mapError(new Error('connection timeout'), mappings);
      expect(result).toBe(custom);
    });

    it('should use defaultFactory when no pattern matches', () => {
      const fallback = new Error('fallback');
      const mappings = [
        {
          pattern: /never-match/,
          errorCode: JsonRpcErrorCode.Timeout,
          factory: () => new Error('not this'),
        },
      ];
      const result = ErrorHandler.mapError(new Error('something else'), mappings, () => fallback);
      expect(result).toBe(fallback);
    });

    it('should return original error when no match and no defaultFactory', () => {
      const original = new Error('original');
      const result = ErrorHandler.mapError(original, []);
      expect(result).toBe(original);
    });

    it('should wrap non-Error input when no match and no defaultFactory', () => {
      const result = ErrorHandler.mapError('string error', []);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('string error');
    });
  });
});

describe('ErrorHandler context projection', () => {
  /**
   * A handler `ctx` satisfies the `RequestContext` parameter — excess-property
   * checking only applies to object literals — so the documented
   * `{ context: ctx }` service pattern hands over the whole object. Everything
   * in `McpError.data` reaches the client as `structuredContent.error.data`.
   */
  const handlerShapedContext = {
    requestId: 'req-leak',
    timestamp: '2026-08-20T00:00:00.000Z',
    operation: 'HandleToolRequest',
    tenantId: 'tenant-1',
    extra: { toolName: 'leaky_tool' },
    auth: { clientId: 'client-1', scopes: ['tools:read'], token: 'secret-bearer' },
    inputs: {
      responses: { creds: { action: 'accept', content: { passphrase: 'hunter2' } } },
      dropped: [],
    },
    log: { info: () => {} },
    signal: new AbortController().signal,
    state: new Map(),
    requestInput: () => {},
    notifyResourceUpdated: () => {},
  };

  it('keeps user-entered input out of the serialized error payload', () => {
    const handled = ErrorHandler.handleError(new Error('upstream failed'), {
      operation: 'svc',
      context: handlerShapedContext as never,
    });

    const data = (handled as McpError).data as Record<string, unknown>;
    expect(JSON.stringify(data)).not.toContain('hunter2');
    expect(data).not.toHaveProperty('inputs');
    expect(data).not.toHaveProperty('log');
    expect(data).not.toHaveProperty('signal');
    expect(data).not.toHaveProperty('state');
    expect(data).not.toHaveProperty('requestInput');
    expect(data).not.toHaveProperty('notifyResourceUpdated');
  });

  it('keeps the credential out too (#355)', () => {
    const handled = ErrorHandler.handleError(new Error('upstream failed'), {
      operation: 'svc',
      context: handlerShapedContext as never,
    });

    const data = (handled as McpError).data as Record<string, unknown>;
    expect(JSON.stringify(data)).not.toContain('secret-bearer');
    expect(data).not.toHaveProperty('auth');
  });

  // #548 — the context goes to the log record only. `data` is client-visible
  // and `extra` carries whatever additionalContext a server attached.
  it('keeps the correlation fields and extra out of data and in the log record', () => {
    const withSession = {
      ...handlerShapedContext,
      sessionId: 'session-1',
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      extra: { toolName: 'leaky_tool', requiredScopes: ['tool:secret:write'] },
    };
    const handled = ErrorHandler.handleError(
      new McpError(JsonRpcErrorCode.NotFound, 'no such item', { itemId: 'x-1', reason: 'no_item' }),
      { operation: 'svc', context: withSession as never },
    );

    const data = (handled as McpError).data as Record<string, unknown>;
    expect(data).toEqual({
      itemId: 'x-1',
      reason: 'no_item',
      originalErrorName: 'McpError',
      originalMessage: 'no such item',
    });
    expect(JSON.stringify(data)).not.toContain('tool:secret:write');

    expect(logger.error).toHaveBeenCalledWith(
      'Error in svc: no such item',
      expect.objectContaining({
        requestId: 'req-leak',
        operation: 'HandleToolRequest',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        traceId: 'a'.repeat(32),
        extra: expect.objectContaining({
          toolName: 'leaky_tool',
          requiredScopes: ['tool:secret:write'],
          errorData: expect.objectContaining({ itemId: 'x-1' }),
        }),
      }),
    );
  });

  it('carries rootCause on data for a chained error, but no context', () => {
    const handled = ErrorHandler.handleError(
      new Error('wrapper', { cause: new TypeError('inner boom') }),
      { operation: 'svc', context: handlerShapedContext as never },
    );

    expect((handled as McpError).data).toEqual({
      originalErrorName: 'Error',
      originalMessage: 'wrapper',
      rootCause: { name: 'TypeError', message: 'inner boom' },
    });
  });
});

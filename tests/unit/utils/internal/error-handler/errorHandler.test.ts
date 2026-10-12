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
import { asRequestCancelled, ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { logger } from '@/utils/internal/logger.js';
import { cpuMs } from '../../../../helpers/cpu-time.js';

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

    it('falls back to Timeout for a value named AbortError that no pattern matches', () => {
      // A non-enumerable `name` leaves the patterns nothing to read: the message
      // is the bare-object fallback and the name `objectEncountered`. Only the
      // AbortError special case can classify it.
      const err = Object.defineProperty({}, 'name', { value: 'AbortError' });
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

    // Each step of the ladder outranks the next: a value two steps could
    // classify takes the earlier step's code, and each case below would read
    // as the later step's code were the two swapped.
    describe('resolution order', () => {
      it.each([
        [
          "an McpError's own code over the pattern ladder",
          new McpError(
            JsonRpcErrorCode.Forbidden,
            'Request failed with status code 404: not found',
          ),
          JsonRpcErrorCode.Forbidden,
        ],
        [
          'the constructor table over the message patterns',
          new SyntaxError('Unexpected token N in JSON: "Not Found" is not valid JSON'),
          JsonRpcErrorCode.ValidationError,
        ],
        [
          'a provider pattern over a common pattern',
          new Error('Request failed with status code 503: upstream request timed out'),
          JsonRpcErrorCode.ServiceUnavailable,
        ],
        [
          'an HTTP status over a validation word',
          new Error('Request failed with status code 404: invalid id'),
          JsonRpcErrorCode.NotFound,
        ],
        [
          'a common pattern over the AbortError special case',
          Object.assign(new Error('resource not found'), { name: 'AbortError' }),
          JsonRpcErrorCode.NotFound,
        ],
      ])('classifies %s', (_label, error, code) => {
        expect(ErrorHandler.determineErrorCode(error)).toBe(code);
      });
    });
  });

  // ─── asRequestCancelled ──────────────────────────────────────────────────────

  describe('asRequestCancelled', () => {
    it('returns an McpError that already carries RequestCancelled as is, data intact', () => {
      const cancelled = new McpError(
        JsonRpcErrorCode.RequestCancelled,
        'fetch GET x was aborted.',
        {
          errorSource: 'FetchAborted',
        },
      );

      const settled = asRequestCancelled(cancelled, AbortSignal.abort('probe'));

      expect(settled).toBe(cancelled);
      expect((settled as McpError).data).toEqual({ errorSource: 'FetchAborted' });
    });

    it('wraps any other value thrown after the abort, keeping its message and chaining it', () => {
      const thrown = new Error('socket hang up');

      const settled = asRequestCancelled(thrown, AbortSignal.abort('probe')) as McpError;

      expect(settled).toBeInstanceOf(McpError);
      expect(settled.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(settled.message).toBe('socket hang up');
      expect(settled.cause).toBe(thrown);
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

    describe('bounds a ZodError’s data.issues (#710)', () => {
      const Ids = z.object({
        ids: z.array(z.string().regex(/^\d+$/).describe('Id')).describe('Ids'),
      });
      /** The ZodError `n` non-digit ids raise: one issue per id. */
      const idsError = (n: number) =>
        Ids.safeParse({ ids: Array.from({ length: n }, (_, i) => `x${i}`) }).error as z.ZodError;
      const bytes = (value: unknown) => JSON.stringify(value).length;

      it('carries Zod’s own issues array, uncut, at exactly 10 issues', () => {
        const error = idsError(10);
        const result = ErrorHandler.classifyOnly(error);
        expect(result.data).toEqual({ issues: error.issues });
        expect(result.data?.issues).toBe(error.issues);
        expect(result.message).toBe('ids.0: Invalid string: must match pattern /^\\d+$/ (+9 more)');
      });

      it('carries an empty issues list, and the fallback message, unchanged', () => {
        const result = ErrorHandler.classifyOnly(new z.ZodError([]));
        expect(result).toEqual({
          code: JsonRpcErrorCode.ValidationError,
          message: 'Validation failed',
          data: { issues: [] },
        });
      });

      it('keeps the first 10 issues and issuesCount beside them at 11', () => {
        const error = idsError(11);
        const result = ErrorHandler.classifyOnly(error);
        expect(result.data).toEqual({ issues: error.issues.slice(0, 10), issuesCount: 11 });
      });

      it('keeps the first 10 of 10,000 issues, byte-identical to Zod’s, under 4 KiB', () => {
        const error = idsError(10_000);
        const result = ErrorHandler.classifyOnly(error);
        expect(result.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(result.message).toBe(
          'ids.0: Invalid string: must match pattern /^\\d+$/ (+9999 more)',
        );
        expect(result.data).toEqual({ issues: error.issues.slice(0, 10), issuesCount: 10_000 });
        expect(bytes(result.data)).toBeLessThan(4096);
      });

      it('cuts an issue message past 1,024 characters, with its uncut length beside it', () => {
        const long = 'm'.repeat(5000);
        const error = z.object({ id: z.string().regex(/^\d+$/, long) }).safeParse({ id: 'x' })
          .error as z.ZodError;
        const result = ErrorHandler.classifyOnly(error);
        const [issue] = (result.data?.issues ?? []) as Array<Record<string, unknown>>;
        expect(issue?.message).toBe('m'.repeat(1024));
        expect(issue?.messageLength).toBe(5000);
        expect(issue?.path).toEqual(['id']);
        expect(result.data).not.toHaveProperty('issuesCount');
      });

      it('cuts the message’s path to 1,025 characters when the first issue’s path is a 1,000,000-character key', () => {
        const key = 'k'.repeat(1_000_000);
        const error = z.record(z.string(), z.number()).safeParse({ [key]: 'x' })
          .error as z.ZodError;
        const result = ErrorHandler.classifyOnly(error);
        expect(result.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(result.message).toBe(
          `${'k'.repeat(1_024)}…: Invalid input: expected number, received string`,
        );
        expect(bytes(result)).toBeLessThan(4096);
      });

      it('carries a 250-option enum’s message whole, though data.issues keeps 10 of its values', () => {
        const options = Array.from({ length: 250 }, (_, i) => `C${String(i).padStart(3, '0')}`);
        const error = z
          .object({ code: z.enum(options as [string, ...string[]]) })
          .safeParse({ code: 'nope' }).error as z.ZodError;
        const message = error.issues[0]?.message ?? '';
        expect(message.length).toBeGreaterThan(1_024);

        const result = ErrorHandler.classifyOnly(error);
        expect(result.message).toBe(`code: ${message}`);
        const [issue] = (result.data?.issues ?? []) as Array<Record<string, unknown>>;
        expect(issue?.values).toEqual(options.slice(0, 10));
      });

      it('carries an unreadable issues field as [Unreadable]', () => {
        const error = new Proxy(new z.ZodError([]), {
          get(target, key, receiver) {
            if (key === 'issues') throw new Error('nope');
            return Reflect.get(target, key, receiver);
          },
        });
        expect(ErrorHandler.classifyOnly(error)).toEqual({
          code: JsonRpcErrorCode.ValidationError,
          message: '[Unreadable]',
          data: { issues: '[Unreadable]' },
        });
      });

      it('writes an issue field whose read throws as [Unreadable], and never throws', () => {
        const issue = {
          code: 'custom',
          message: 'Rejected.',
          path: ['ids', 0],
          get params(): never {
            throw new Error('params getter threw');
          },
        };
        const result = ErrorHandler.classifyOnly(new z.ZodError([issue as never]));
        expect(result).toEqual({
          code: JsonRpcErrorCode.ValidationError,
          message: 'ids.0: Rejected.',
          data: {
            issues: [
              { code: 'custom', message: 'Rejected.', path: ['ids', 0], params: '[Unreadable]' },
            ],
          },
        });
        expect(() => JSON.stringify(result)).not.toThrow();
      });

      it('writes an issues list that cannot be inspected as [Unreadable], and never throws', () => {
        const { proxy, revoke } = Proxy.revocable([] as never[], {});
        revoke();
        expect(ErrorHandler.classifyOnly(new z.ZodError(proxy))).toEqual({
          code: JsonRpcErrorCode.ValidationError,
          message: '[Unreadable]',
          data: { issues: '[Unreadable]' },
        });
      });

      describe('a recursive union whose branches share one clause list', () => {
        /**
         * The `and` and `or` branches both parse the same clause list, and Zod
         * lists the clause's issues under both, so a bad leaf's issue tree is
         * 2^depth issues wide while its distinct issues grow with the depth.
         */
        const Filter: z.ZodType = z.lazy(() =>
          z.union([
            z.object({ op: z.literal('and'), filters: z.array(Filter) }),
            z.object({ op: z.literal('or'), filters: z.array(Filter) }),
            z.object({ op: z.literal('eq'), field: z.string(), value: z.string() }),
          ]),
        );
        /** One bad leaf, `value: 5`, under `depth` levels alternating `or` and `and`. */
        const nested = (depth: number) => {
          let node: unknown = { op: 'eq', field: 'name', value: 5 };
          for (let level = 0; level < depth; level++) {
            node = { op: level % 2 ? 'and' : 'or', filters: [node] };
          }
          return node;
        };
        /** Objects held in arrays anywhere in `value`: what the 30-issue budget counts. */
        const issueObjects = (value: unknown): number => {
          if (value === null || typeof value !== 'object') return 0;
          let count = 0;
          for (const entry of Array.isArray(value) ? value : Object.values(value)) {
            const isObject = entry !== null && typeof entry === 'object' && !Array.isArray(entry);
            if (Array.isArray(value) && isObject) count++;
            count += issueObjects(entry);
          }
          return count;
        };

        it('keeps at most 30 issues of the tree, in a bounded walk, at every depth to 24', () => {
          const costs: number[] = [];
          for (const depth of [8, 16, 24]) {
            const error = Filter.safeParse(nested(depth)).error as z.ZodError;
            const result = ErrorHandler.classifyOnly(error);
            expect(result.code, `depth ${depth}`).toBe(JsonRpcErrorCode.ValidationError);
            // Checked per depth, so a carried tree that doubles per level fails at 8.
            expect(bytes(result.data), `depth ${depth}`).toBeLessThan(16_384);
            expect(issueObjects(result.data?.issues), `depth ${depth}`).toBeLessThanOrEqual(30);
            costs.push(cpuMs(() => ErrorHandler.classifyOnly(error)));
          }
          // 3× the depth: a bounded walk stays flat, one that doubles per level is 65,536×.
          expect(costs[2]! / costs[0]!).toBeLessThan(6);
        });
      });
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

    it('rethrows the processed McpError, not the original, when rethrow is true', () => {
      const original = new Error('status code 503');
      let thrown: unknown;
      try {
        ErrorHandler.handleError(original, { operation: 'test', rethrow: true });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(McpError);
      expect(thrown).not.toBe(original);
      expect((thrown as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });

    it.each([
      ['no context', undefined],
      ['an empty requestId and timestamp', { requestId: '', timestamp: '' }],
    ])('generates the record requestId and timestamp for %s', (_label, context) => {
      ErrorHandler.handleError(new Error('boom'), { operation: 'op', ...(context && { context }) });

      const logged = vi.mocked(logger.error).mock.calls.at(-1)?.[1] as {
        requestId: string;
        timestamp: string;
      };
      expect(logged.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(new Date(logged.timestamp).toISOString()).toBe(logged.timestamp);
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

    // Issue #586 — `includeStack: false` governs every stack the record holds,
    // not only `extra.stack`: the throw-site `originalStack`, one carried in a
    // thrown `McpError`'s own `data`, and each cause-chain node's.
    describe('includeStack: false leaves no stack in the record (#586)', () => {
      type CauseNode = Record<string, unknown> & { data?: Record<string, unknown> };
      type Logged = {
        extra: Record<string, unknown> & {
          errorData: Record<string, unknown> & { causeChain?: CauseNode[] };
        };
      };
      const lastErrorRecord = () =>
        vi.mocked(logger.error).mock.calls.at(-1)?.[1] as unknown as Logged;

      /** `outer` → `McpError` carrying its own `originalStack` → plain root. */
      function threeLevelChain() {
        const root = new Error('db down');
        const mid = new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'pool exhausted',
          { originalStack: 'MID_DATA_STACK', pool: 'primary' },
          { cause: root },
        );
        return { mid, outer: new Error('lookup failed', { cause: mid }) };
      }

      /** Asserts the record is stack-free and its chain kept every other field. */
      function expectStackFree(logged: Logged) {
        expect(logged.extra).not.toHaveProperty('stack');
        expect(logged.extra.errorData).not.toHaveProperty('originalStack');
        const chain = logged.extra.errorData.causeChain ?? [];
        expect(chain.map(({ name, message, depth }) => [name, message, depth])).toEqual([
          ['Error', 'lookup failed', 0],
          ['McpError', 'pool exhausted', 1],
          ['Error', 'db down', 2],
        ]);
        for (const node of chain) expect(node).not.toHaveProperty('stack');
        expect(chain[1]?.data).toEqual({ pool: 'primary' });
        const serialized = JSON.stringify(logged);
        expect(serialized).not.toContain('errorHandler.test.ts');
        expect(serialized).not.toContain('MID_DATA_STACK');
      }

      it('logs the cause chain without a stack on any node, past the first level', () => {
        const { mid, outer } = threeLevelChain();

        ErrorHandler.handleError(outer, { operation: 'probe', includeStack: false });

        expectStackFree(lastErrorRecord());
        // The logged copy is stripped; the thrown cause's own data is untouched.
        expect(mid.data).toEqual({ originalStack: 'MID_DATA_STACK', pool: 'primary' });
      });

      it('logs the same stack-free record from tryCatch, and still rethrows', async () => {
        const { outer } = threeLevelChain();

        const thrown = await ErrorHandler.tryCatch(
          () => {
            throw outer;
          },
          { operation: 'probe', includeStack: false },
        ).catch((e: unknown) => e);

        expect(thrown).toBeInstanceOf(McpError);
        expect((thrown as McpError).message).toBe('lookup failed');
        expectStackFree(lastErrorRecord());
      });

      it.each([
        ['omitted', undefined],
        ['true', true],
      ])('logs every stack when includeStack is %s', (_label, includeStack) => {
        const { mid, outer } = threeLevelChain();

        ErrorHandler.handleError(outer, {
          operation: 'probe',
          ...(includeStack !== undefined && { includeStack }),
        });

        const { extra } = lastErrorRecord();
        // The throw site's stack, once, as the record's `stack` (#694): node 0
        // is the thrown error, so it does not repeat it; each cause keeps its own.
        expect(extra.stack).toBe(outer.stack);
        expect(extra.errorData).not.toHaveProperty('originalStack');
        const chain = extra.errorData.causeChain ?? [];
        expect(chain).toHaveLength(3);
        expect(chain[0]).not.toHaveProperty('stack');
        expect(chain[1]?.stack).toBe(mid.stack);
        expect(chain[2]?.stack).toBe((mid.cause as Error).stack);
        expect(chain[1]?.data).toEqual({ originalStack: 'MID_DATA_STACK', pool: 'primary' });
      });

      it('returns the same code, message, and data either way', () => {
        const thrown = new McpError(
          JsonRpcErrorCode.NotFound,
          'missing',
          { originalStack: 'CARRIED_STACK', itemId: 'x-1' },
          { cause: new Error('db down') },
        );

        const withStack = ErrorHandler.handleError(thrown, {
          operation: 'probe',
          includeStack: true,
        }) as McpError;
        const without = ErrorHandler.handleError(thrown, {
          operation: 'probe',
          includeStack: false,
        }) as McpError;

        expect(without.code).toBe(withStack.code);
        expect(without.message).toBe(withStack.message);
        expect(without.data).toEqual(withStack.data);
        expect(without.data).toMatchObject({ originalStack: 'CARRIED_STACK', itemId: 'x-1' });
      });

      it('drops a stack the caller put in the context extra, keeping its other fields', () => {
        ErrorHandler.handleError(new Error('boom'), {
          operation: 'probe',
          context: {
            requestId: 'req-extra-stack',
            timestamp: '2026-01-01T00:00:00.000Z',
            extra: { stack: 'CALLER_STACK', toolName: 'probe_tool' },
          },
          includeStack: false,
        });

        const { extra } = lastErrorRecord();
        expect(extra).not.toHaveProperty('stack');
        expect(extra.toolName).toBe('probe_tool');
        expect(JSON.stringify(extra)).not.toContain('CALLER_STACK');
      });
    });

    describe('a ZodError reaches the record as its one-line summary (#736)', () => {
      type CauseNode = { name: string; message: string; depth: number; stack?: string };
      type Logged = {
        extra: Record<string, unknown> & {
          stack?: string;
          errorData: Record<string, unknown> & {
            rootCause?: { name: string; message: string };
            causeChain?: CauseNode[];
          };
        };
      };
      const lastErrorRecord = () =>
        vi.mocked(logger.error).mock.calls.at(-1)?.[1] as unknown as Logged;
      const fixedContext = { requestId: 'req-736', timestamp: '2026-10-12T00:00:00.000Z' };

      const Ids = z.object({ ids: z.array(z.string().regex(/^\d+$/).describe('Id')) });
      /** What `Ids.parse` throws for `n` non-digit ids: one issue each, frames and all on V8. */
      function thrownIdsError(n: number): z.ZodError {
        try {
          Ids.parse({ ids: Array.from({ length: n }, (_, i) => `x${i}`) });
        } catch (error) {
          return error as z.ZodError;
        }
        throw new Error('expected Ids.parse to throw');
      }
      const summary = (n: number) =>
        `ids.0: Invalid string: must match pattern /^\\d+$/${n > 1 ? ` (+${n - 1} more)` : ''}`;
      const IS_BUN = typeof process.versions.bun === 'string';
      /**
       * Whether `error`'s stack starts `ZodError: <its JSON message>`: always on
       * V8; on Bun only under a stack formatter such as the test runner's, since
       * Bun's own carries no message.
       */
      const carriesMessage = (error: z.ZodError) =>
        typeof error.stack === 'string' && error.stack.startsWith(`ZodError: ${error.message}`);

      /**
       * The stack the record writes for `error`: a header carrying the message
       * becomes the summary and every frame of the thrown stack is kept; one
       * that carries none is written as read.
       */
      function expectSummaryStack(stack: unknown, error: z.ZodError, n: number) {
        if (!carriesMessage(error)) {
          expect(stack).toBe(error.stack);
          return;
        }
        const [header, ...frames] = String(stack).split('\n');
        expect(header).toBe(`ZodError: ${summary(n)}`);
        if (!IS_BUN) expect(frames.length).toBeGreaterThan(0);
        for (const frame of frames) expect(frame.startsWith('    at ')).toBe(true);
        expect(error.stack?.endsWith(frames.map((frame) => `\n${frame}`).join(''))).toBe(true);
      }

      it.runIf(!IS_BUN)(
        'V8 starts a thrown ZodError’s stack with its JSON message (the precondition)',
        () => {
          expect(carriesMessage(thrownIdsError(3))).toBe(true);
        },
      );

      it('writes a non-Zod error’s stack and cause-chain messages as read (characterization)', () => {
        const root = new TypeError('socket closed');
        const mid = new Error('pool exhausted', { cause: root });
        const outer = new Error('lookup failed', { cause: mid });

        ErrorHandler.handleError(outer, { operation: 'probe', context: fixedContext });

        const { extra } = lastErrorRecord();
        expect(extra.stack).toBe(outer.stack);
        expect(extra.errorData.rootCause).toEqual({ name: 'TypeError', message: 'socket closed' });
        expect(extra.errorData.causeChain).toEqual([
          { name: 'Error', message: 'lookup failed', depth: 0 },
          { name: 'Error', message: 'pool exhausted', depth: 1, stack: mid.stack },
          { name: 'TypeError', message: 'socket closed', depth: 2, stack: root.stack },
        ]);
        expect(vi.mocked(logger.error).mock.calls.at(-1)?.[0]).toBe(
          'Error in probe: lookup failed',
        );
      });

      it('writes a thrown ZodError’s stack header as the summary, frames kept, flat from 100 to 10,000 issues', () => {
        const sizes: number[] = [];
        for (const n of [100, 10_000]) {
          const error = thrownIdsError(n);

          ErrorHandler.handleError(error, { operation: 'probe', context: fixedContext });

          const logged = lastErrorRecord();
          expectSummaryStack(logged.extra.stack, error, n);
          expect(vi.mocked(logger.error).mock.calls.at(-1)?.[0]).toBe(
            `Error in probe: ${summary(n)}`,
          );
          const serialized = JSON.stringify(logged);
          expect(serialized).not.toContain('invalid_format');
          sizes.push(serialized.length);
        }
        // `(+99 more)` against `(+9999 more)`: two characters, nothing per issue.
        expect(sizes[1]! - sizes[0]!).toBeLessThan(64);
      });

      it('writes a ZodError two causes deep as its summary in the cause chain and rootCause', () => {
        const error = thrownIdsError(500);
        const mid = new McpError(JsonRpcErrorCode.ValidationError, 'record rejected', undefined, {
          cause: error,
        });
        const outer = new Error('lookup failed', { cause: mid });

        ErrorHandler.handleError(outer, { operation: 'probe', context: fixedContext });

        const { extra } = lastErrorRecord();
        expect(extra.stack).toBe(outer.stack);
        expect(extra.errorData.rootCause).toEqual({ name: 'ZodError', message: summary(500) });
        const chain = extra.errorData.causeChain ?? [];
        expect(chain.map(({ name, message, depth }) => [name, message, depth])).toEqual([
          ['Error', 'lookup failed', 0],
          ['McpError', 'record rejected', 1],
          ['ZodError', summary(500), 2],
        ]);
        expect(chain[1]?.stack).toBe(mid.stack);
        expectSummaryStack(chain[2]?.stack, error, 500);
        expect(JSON.stringify(extra)).not.toContain('invalid_format');
      });

      it('writes the summary at every level a nested tryCatch rebuilds, each stack once', async () => {
        const error = thrownIdsError(500);

        const rethrown = await ErrorHandler.tryCatch(
          () =>
            ErrorHandler.tryCatch(
              () => {
                throw error;
              },
              { operation: 'inner', context: fixedContext },
            ),
          { operation: 'outer', context: fixedContext },
        ).catch((e: unknown) => e as McpError);

        expect(rethrown.message).toBe(summary(500));
        expectSummaryStack(rethrown.stack, error, 500);
        const calls = vi.mocked(logger.error).mock.calls;
        expect(calls.map(([message]) => message)).toEqual([
          `Error in inner: ${summary(500)}`,
          `Error in outer: ${summary(500)}`,
        ]);
        for (const [, record] of calls)
          expect(JSON.stringify(record)).not.toContain('invalid_format');
        const { extra } = lastErrorRecord();
        expectSummaryStack(extra.stack, error, 500);
        // Every level shares the throw site's stack, so no node repeats it.
        expect(extra.errorData.causeChain).toEqual([
          {
            name: 'McpError',
            message: summary(500),
            depth: 0,
            data: { originalErrorName: 'ZodError', originalMessage: summary(500) },
          },
          { name: 'ZodError', message: summary(500), depth: 1 },
        ]);
      });

      it('logs the summary when an errorMapper returns the ZodError itself', () => {
        const error = thrownIdsError(500);

        const handled = ErrorHandler.handleError(error, {
          operation: 'probe',
          context: fixedContext,
          errorMapper: (e) => e as Error,
        });

        expect(handled).toBe(error);
        expect(vi.mocked(logger.error).mock.calls.at(-1)?.[0]).toBe(
          `Error in probe: ${summary(500)}`,
        );
        expect(JSON.stringify(lastErrorRecord())).not.toContain('invalid_format');
      });

      it('writes a single root-level issue as its bare message, with no count', () => {
        let error: z.ZodError | undefined;
        try {
          z.string().regex(/^\d+$/).parse('x');
        } catch (thrown) {
          error = thrown as z.ZodError;
        }
        const line = 'Invalid string: must match pattern /^\\d+$/';
        const header = `ZodError: ${error?.message}`;
        const rawStack = error?.stack;

        ErrorHandler.handleError(error, { operation: 'probe', context: fixedContext });

        expect(vi.mocked(logger.error).mock.calls.at(-1)?.[0]).toBe(`Error in probe: ${line}`);
        expect(lastErrorRecord().extra.stack).toBe(
          rawStack?.startsWith(header)
            ? `ZodError: ${line}${rawStack.slice(header.length)}`
            : rawStack,
        );
        expect(JSON.stringify(lastErrorRecord())).not.toContain('invalid_format');
      });

      it('writes a stack the caller replaced as given', () => {
        const error = thrownIdsError(500);
        error.stack = 'ZodError: replaced by the caller\n    at caller (caller.ts:1:1)';

        ErrorHandler.handleError(error, { operation: 'probe', context: fixedContext });

        expect(lastErrorRecord().extra.stack).toBe(error.stack);
      });

      it('writes a ZodError whose stack cannot be read with [Unreadable], and its summary', () => {
        const error = new Proxy(thrownIdsError(500), {
          get(target, key, receiver) {
            if (key === 'stack') throw new Error('stack getter threw');
            return Reflect.get(target, key, receiver);
          },
        });

        expect(() =>
          ErrorHandler.handleError(error, { operation: 'probe', context: fixedContext }),
        ).not.toThrow();

        expect(vi.mocked(logger.error).mock.calls.at(-1)?.[0]).toBe(
          `Error in probe: ${summary(500)}`,
        );
        expect(lastErrorRecord().extra.stack).toBe('[Unreadable]');
      });

      it('writes a ZodError an AggregateError holds as its summary, on the wire and in the record', () => {
        const error = new AggregateError([thrownIdsError(500)], 'every source failed');
        const message = `every source failed: ${summary(500)}`;

        expect(ErrorHandler.classifyOnly(error).message).toBe(message);
        ErrorHandler.handleError(error, { operation: 'probe', context: fixedContext });

        expect(vi.mocked(logger.error).mock.calls.at(-1)?.[0]).toBe(`Error in probe: ${message}`);
        expect(JSON.stringify(lastErrorRecord())).not.toContain('invalid_format');
      });
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

      it('records a ZodError as its summary, on the exception event and the status (#736)', () => {
        const Ids = z.array(z.string().regex(/^\d+$/));
        let error: z.ZodError | undefined;
        try {
          Ids.parse(Array.from({ length: 1000 }, (_, i) => `x${i}`));
        } catch (thrown) {
          error = thrown as z.ZodError;
        }
        const message = '0: Invalid string: must match pattern /^\\d+$/ (+999 more)';
        const rawStack = error?.stack;
        const header = `ZodError: ${error?.message}`;

        ErrorHandler.handleError(error, { operation: 'otelTest' });

        expect(span.recordException).toHaveBeenCalledTimes(1);
        const recorded = span.recordException.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(recorded).toMatchObject({ name: 'ZodError', message });
        expect(recorded.stack).toBe(
          rawStack?.startsWith(header)
            ? `ZodError: ${message}${rawStack.slice(header.length)}`
            : rawStack,
        );
        expect(JSON.stringify(recorded)).not.toContain('invalid_format');
        expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message });
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

  // ─── a value whose reads throw (#697) ────────────────────────────────────────

  describe('a thrown value whose reads throw (#697)', () => {
    /** `target` with an own `key` whose read throws. */
    function unreadable<T extends object>(target: T, key: string): T {
      return Object.defineProperty(target, key, {
        configurable: true,
        get() {
          throw new Error(`${key} getter`);
        },
      });
    }

    /** A revoked Proxy: every operation on it, `instanceof` included, throws. */
    function revoked(): object {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return proxy;
    }

    it.each([
      [
        'an Error whose message getter throws',
        () => unreadable(new Error('boom'), 'message'),
        {
          code: JsonRpcErrorCode.InternalError,
          message: '[Unreadable]',
          data: { errorType: 'Error' },
        },
      ],
      [
        'an Error whose name getter throws',
        () => unreadable(new TypeError('boom'), 'name'),
        {
          code: JsonRpcErrorCode.InternalError,
          message: 'boom',
          data: { errorType: '[Unreadable]' },
        },
      ],
      [
        'an McpError whose message getter throws',
        () => unreadable(new McpError(JsonRpcErrorCode.NotFound, 'gone', { id: 1 }), 'message'),
        { code: JsonRpcErrorCode.NotFound, message: '[Unreadable]', data: { id: 1 } },
      ],
      [
        'an McpError whose data getter throws',
        () => unreadable(new McpError(JsonRpcErrorCode.NotFound, 'gone', { id: 1 }), 'data'),
        { code: JsonRpcErrorCode.NotFound, message: 'gone', data: {} },
      ],
      [
        'an McpError whose data is a revoked Proxy',
        () =>
          Object.defineProperty(new McpError(JsonRpcErrorCode.NotFound, 'gone'), 'data', {
            configurable: true,
            enumerable: true,
            value: revoked(),
          }),
        { code: JsonRpcErrorCode.NotFound, message: 'gone', data: {} },
      ],
      [
        'a revoked Proxy',
        revoked,
        {
          code: JsonRpcErrorCode.UnknownError,
          message: '[Unreadable]',
          data: { errorType: '[Unreadable]' },
        },
      ],
    ])('formatError writes %s as [Unreadable] where it cannot read', (_label, make, expected) => {
      expect(ErrorHandler.formatError(make())).toEqual(expected);
    });

    it.each([
      [
        'an McpError whose message getter throws',
        () => unreadable(new McpError(JsonRpcErrorCode.NotFound, 'gone'), 'message'),
        { code: JsonRpcErrorCode.NotFound, message: '[Unreadable]' },
      ],
      [
        'an McpError whose code getter throws',
        () => unreadable(new McpError(JsonRpcErrorCode.NotFound, 'gone'), 'code'),
        { code: JsonRpcErrorCode.InternalError, message: 'gone' },
      ],
      [
        'a revoked Proxy',
        revoked,
        { code: JsonRpcErrorCode.InternalError, message: '[Unreadable]' },
      ],
    ])('classifyOnly classifies %s without throwing', (_label, make, expected) => {
      expect(ErrorHandler.classifyOnly(make())).toEqual(expected);
    });

    it('determineErrorCode classifies a revoked Proxy and an unreadable SdkError code as InternalError', () => {
      expect(ErrorHandler.determineErrorCode(revoked())).toBe(JsonRpcErrorCode.InternalError);
      expect(
        ErrorHandler.determineErrorCode(
          unreadable(new SdkError(SdkErrorCode.ConnectionClosed, 'something weird'), 'code'),
        ),
      ).toBe(JsonRpcErrorCode.InternalError);
    });

    it.each([
      ['a revoked Proxy', revoked],
      ['a null-prototype object', () => Object.create(null) as object],
    ])('mapError wraps %s, which it cannot convert, as an [Unreadable] Error', (_label, make) => {
      const result = ErrorHandler.mapError(make(), []);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('[Unreadable]');
    });

    it('asRequestCancelled cancels an McpError whose code it cannot read, keeping a cancelled one as is', () => {
      const aborted = AbortSignal.abort();
      const cancelled = new McpError(JsonRpcErrorCode.RequestCancelled, 'gone');
      const thrown = unreadable(new McpError(JsonRpcErrorCode.NotFound, 'gone'), 'code');

      expect(asRequestCancelled(cancelled, aborted)).toBe(cancelled);
      const resolved = asRequestCancelled(thrown, aborted);
      expect(resolved).toBeInstanceOf(McpError);
      expect(resolved).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled, message: 'gone' });
      expect((resolved as McpError).cause).toBe(thrown);
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

  // #644 — a cause's message reaches the log record, never `data`.
  it('logs a chained error’s rootCause, keeping it and the context out of data', () => {
    const handled = ErrorHandler.handleError(
      new Error('wrapper', { cause: new TypeError('inner boom') }),
      { operation: 'svc', context: handlerShapedContext as never },
    );

    expect((handled as McpError).data).toEqual({
      originalErrorName: 'Error',
      originalMessage: 'wrapper',
    });
    expect(logger.error).toHaveBeenCalledWith(
      'Error in svc: wrapper',
      expect.objectContaining({
        extra: expect.objectContaining({
          errorData: expect.objectContaining({
            rootCause: { name: 'TypeError', message: 'inner boom' },
          }),
        }),
      }),
    );
  });
});

/**
 * @fileoverview Test suite for error handler helper utilities — getErrorName, getErrorMessage,
 * formatZodErrorMessage, extractErrorCauseChain.
 * @module tests/utils/internal/error-handler/helpers.test
 */

import { type Span, SpanStatusCode } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import {
  asError,
  extractErrorCauseChain,
  formatZodErrorMessage,
  getErrorMessage,
  getErrorName,
  isInstance,
  recordSpanFailure,
} from '@/utils/internal/error-handler/helpers.js';

describe('Error Handler Helpers', () => {
  // ─── getErrorName ────────────────────────────────────────────────────────────

  describe('getErrorName', () => {
    it('should return name from Error instance', () => {
      expect(getErrorName(new Error('test'))).toBe('Error');
    });

    it('should return NullValueEncountered for null', () => {
      expect(getErrorName(null)).toBe('NullValueEncountered');
    });

    it('should return UndefinedValueEncountered for undefined', () => {
      expect(getErrorName(undefined)).toBe('UndefinedValueEncountered');
    });

    it('should return constructor name for custom class instances', () => {
      class MyClass {}
      expect(getErrorName(new MyClass())).toBe('MyClassEncountered');
    });

    it('should return typeof for plain object', () => {
      expect(getErrorName({})).toBe('objectEncountered');
    });
  });

  // ─── getErrorMessage ─────────────────────────────────────────────────────────

  describe('getErrorMessage', () => {
    it('should return message from Error instance', () => {
      expect(getErrorMessage(new Error('test message'))).toBe('test message');
    });

    it('should combine AggregateError messages', () => {
      const agg = new AggregateError(
        [new Error('first'), new Error('second'), new Error('third')],
        'aggregate',
      );
      const msg = getErrorMessage(agg);
      expect(msg).toContain('aggregate');
      expect(msg).toContain('first');
      expect(msg).toContain('second');
      expect(msg).toContain('third');
    });

    it('should slice AggregateError inner messages to 3', () => {
      const errors = Array.from({ length: 5 }, (_, i) => new Error(`err${i}`));
      const agg = new AggregateError(errors, 'many');
      const msg = getErrorMessage(agg);
      expect(msg).toContain('err0');
      expect(msg).toContain('err2');
      expect(msg).not.toContain('err3');
    });

    it('should return special message for null', () => {
      expect(getErrorMessage(null)).toBe('Null value encountered as error');
    });

    it('should return special message for undefined', () => {
      expect(getErrorMessage(undefined)).toBe('Undefined value encountered as error');
    });

    it('should return string value directly', () => {
      expect(getErrorMessage('direct string')).toBe('direct string');
    });

    it('should stringify bigint', () => {
      expect(getErrorMessage(BigInt(123))).toBe('123');
    });

    it('should format function name', () => {
      function myFn() {}
      expect(getErrorMessage(myFn)).toBe('[function myFn]');
    });

    it('should format anonymous function', () => {
      expect(getErrorMessage(() => {})).toBe('[function anonymous]');
    });

    it('should format symbol', () => {
      expect(getErrorMessage(Symbol('test'))).toBe('Symbol(test)');
    });

    it('should JSON.stringify plain object', () => {
      expect(getErrorMessage({ code: 500 })).toBe('{"code":500}');
    });

    it('should handle object that fails JSON.stringify', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const msg = getErrorMessage(circular);
      expect(msg).toContain('Non-Error object');
    });

    it('should handle empty object', () => {
      const msg = getErrorMessage({});
      expect(msg).toContain('Non-Error object');
    });

    it('should format ZodError as a single-line sentence (not raw JSON)', () => {
      const result = z.object({ name: z.string() }).safeParse({ name: 123 });
      expect(result.success).toBe(false);
      if (result.success) return;
      const msg = getErrorMessage(result.error);
      expect(msg).not.toContain('[\n');
      expect(msg).not.toContain('"code":');
      expect(msg).toBe('name: Invalid input: expected string, received number');
    });
  });

  // ─── formatZodErrorMessage ───────────────────────────────────────────────────

  describe('formatZodErrorMessage', () => {
    /** The ZodError `schema` raises for `value`. */
    const zodErrorFor = (schema: z.ZodType, value: unknown) => {
      const result = schema.safeParse(value);
      expect(result.success).toBe(false);
      return result.error as z.ZodError;
    };

    it('should format single-issue error with path', () => {
      const msg = formatZodErrorMessage(
        zodErrorFor(z.object({ nctId: z.string().regex(/^NCT\d{8}$/) }), { nctId: 'X' }),
      );
      expect(msg).toBe('nctId: Invalid string: must match pattern /^NCT\\d{8}$/');
      expect(msg).not.toContain('(+');
    });

    it('leads with the path when a custom message is a full sentence (#620)', () => {
      const schema = z.object({
        recid: z.string().regex(/^\d+$/, 'A recid is digits, such as 6004.'),
      });
      expect(formatZodErrorMessage(zodErrorFor(schema, { recid: 'abc' }))).toBe(
        'recid: A recid is digits, such as 6004.',
      );
    });

    it('joins an array index into the dotted path', () => {
      const schema = z.object({
        ids: z.array(z.string().regex(/^\d+$/, 'A recid is digits, such as 6004.')),
      });
      expect(formatZodErrorMessage(zodErrorFor(schema, { ids: ['6004', 'abc'] }))).toBe(
        'ids.1: A recid is digits, such as 6004.',
      );
    });

    it('names every level of a nested path', () => {
      const schema = z.object({
        filter: z.object({ range: z.object({ from: z.string().min(4) }) }),
      });
      expect(
        formatZodErrorMessage(zodErrorFor(schema, { filter: { range: { from: 'ab' } } })),
      ).toBe('filter.range.from: Too small: expected string to have >=4 characters');
    });

    it('should append overflow count when multiple issues', () => {
      const msg = formatZodErrorMessage(
        zodErrorFor(z.object({ a: z.string(), b: z.number(), c: z.boolean() }), {
          a: 1,
          b: 'x',
          c: 'y',
        }),
      );
      expect(msg).toMatch(/\(\+\d+ more\)/);
      expect(msg).toBe('a: Invalid input: expected string, received number (+2 more)');
    });

    it('should render a root-level issue as its bare message', () => {
      expect(formatZodErrorMessage(zodErrorFor(z.string(), 42))).toBe(
        'Invalid input: expected string, received number',
      );
    });

    it('should render an object-level refine as exactly its own message', () => {
      const schema = z
        .object({ start: z.number(), end: z.number() })
        .refine((range) => range.start < range.end, 'start must come before end.');
      expect(formatZodErrorMessage(zodErrorFor(schema, { start: 2, end: 1 }))).toBe(
        'start must come before end.',
      );
    });

    it('should fall back to a fixed sentence for an error with no issues', () => {
      expect(formatZodErrorMessage(new z.ZodError([]))).toBe('Validation failed');
    });
  });

  // ─── extractErrorCauseChain ──────────────────────────────────────────────────

  describe('extractErrorCauseChain', () => {
    it('should extract single error with no cause', () => {
      const chain = extractErrorCauseChain(new Error('root'));
      expect(chain).toHaveLength(1);
      expect(chain[0]?.message).toBe('root');
      expect(chain[0]?.depth).toBe(0);
    });

    it('should extract chained errors', () => {
      const root = new Error('root cause');
      const middle = new Error('middle', { cause: root });
      const top = new Error('top', { cause: middle });
      const chain = extractErrorCauseChain(top);
      expect(chain).toHaveLength(3);
      expect(chain[0]?.message).toBe('top');
      expect(chain[1]?.message).toBe('middle');
      expect(chain[2]?.message).toBe('root cause');
    });

    it('should detect circular references', () => {
      const err1 = new Error('err1');
      const err2 = new Error('err2', { cause: err1 });
      // Force circular reference
      Object.defineProperty(err1, 'cause', { value: err2 });
      const chain = extractErrorCauseChain(err2);
      const lastNode = chain[chain.length - 1]!;
      expect(lastNode.name).toBe('CircularReference');
    });

    it('should respect maxDepth limit', () => {
      let current: Error = new Error('deep-0');
      for (let i = 1; i <= 5; i++) {
        current = new Error(`deep-${i}`, { cause: current });
      }
      const chain = extractErrorCauseChain(current, 3);
      expect(chain.map(({ name, message, depth }) => [name, message, depth])).toEqual([
        ['Error', 'deep-5', 0],
        ['Error', 'deep-4', 1],
        ['Error', 'deep-3', 2],
        ['MaxDepthExceeded', 'Error cause chain exceeded maximum depth of 3', 3],
      ]);
    });

    it('should include McpError data', () => {
      const err = new McpError(JsonRpcErrorCode.NotFound, 'gone', {
        resource: 'user',
      });
      const chain = extractErrorCauseChain(err);
      expect(chain[0]?.data).toEqual({ resource: 'user' });
    });

    it('should handle string cause', () => {
      const err = new Error('top');
      Object.defineProperty(err, 'cause', { value: 'string cause' });
      const chain = extractErrorCauseChain(err);
      expect(chain).toHaveLength(2);
      expect(chain[1]?.name).toBe('StringError');
      expect(chain[1]?.message).toBe('string cause');
    });

    it('should handle non-Error non-string cause', () => {
      const err = new Error('top');
      Object.defineProperty(err, 'cause', { value: { code: 500 } });
      const chain = extractErrorCauseChain(err);
      expect(chain).toHaveLength(2);
      expect(chain[1]).toEqual({ name: 'objectEncountered', message: '{"code":500}', depth: 1 });
    });

    it('should return empty chain for falsy input', () => {
      expect(extractErrorCauseChain(null)).toHaveLength(0);
      expect(extractErrorCauseChain(undefined)).toHaveLength(0);
    });

    it('carries a string code on every node that has one, past the first level (#615)', () => {
      // Node's undici shape: the transport code sits on the cause of `fetch failed`.
      const socket = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      const fetchFailed = new TypeError('fetch failed', { cause: socket });
      const wrapper = new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'Network error',
        undefined,
        {
          cause: fetchFailed,
        },
      );

      const chain = extractErrorCauseChain(wrapper);

      expect(chain).toHaveLength(3);
      expect(chain[2]).toMatchObject({
        name: 'Error',
        message: 'read ECONNRESET',
        code: 'ECONNRESET',
        depth: 2,
      });
      // McpError's numeric JSON-RPC code is not a transport code.
      expect(chain[0]).not.toHaveProperty('code');
      expect(chain[1]).not.toHaveProperty('code');
    });

    it('reads the code off the outermost error itself', () => {
      // Bun's shape: the code rides the fetch rejection, which has no cause.
      const rejection = Object.assign(
        new TypeError('Unable to connect. Is the computer able to access the url?'),
        { code: 'ConnectionRefused' },
      );

      expect(extractErrorCauseChain(rejection)).toEqual([
        {
          name: 'TypeError',
          message: 'Unable to connect. Is the computer able to access the url?',
          code: 'ConnectionRefused',
          depth: 0,
          stack: expect.any(String),
        },
      ]);
    });

    it('ignores a code that is not a string', () => {
      const node = extractErrorCauseChain(Object.assign(new Error('odd'), { code: 42 }))[0];
      expect(node).not.toHaveProperty('code');
    });
  });

  // ─── Values whose reads throw (#697) ─────────────────────────────────────────

  describe('a value whose reads throw (#697)', () => {
    /** `target` with an own `key` whose read throws. */
    function unreadable<T extends object>(target: T, key: string): T {
      return Object.defineProperty(target, key, {
        configurable: true,
        get() {
          throw new Error(`${key} getter`);
        },
      });
    }

    /** A revoked Proxy: every operation on it throws. */
    function revoked(): object {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return proxy;
    }

    const UNREADABLE_NODE = { name: '[Unreadable]', message: '[Unreadable]' };

    it('names an Error whose name getter throws, and a revoked Proxy, [Unreadable]', () => {
      expect(getErrorName(unreadable(new TypeError('boom'), 'name'))).toBe('[Unreadable]');
      expect(getErrorName(revoked())).toBe('[Unreadable]');
    });

    it('reads an Error’s message getter that throws as [Unreadable], an AggregateError’s members kept', () => {
      expect(getErrorMessage(unreadable(new Error('boom'), 'message'))).toBe('[Unreadable]');
      expect(
        getErrorMessage(unreadable(new AggregateError([new Error('a')], 'outer'), 'message')),
      ).toBe('[Unreadable]: a');
    });

    it.each([
      ['a revoked Proxy', revoked],
      [
        'an object whose JSON and constructor reads throw',
        () => unreadable(unreadable({ id: 1 }, 'toJSON'), 'constructor'),
      ],
    ])('reads %s, which it cannot inspect, as [Unreadable], not the thrower’s text', (_l, make) => {
      expect(getErrorMessage(make())).toBe('[Unreadable]');
    });

    it('reads an AggregateError member it cannot read as [Unreadable], the rest kept', () => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      const aggregate = new AggregateError(
        [unreadable(new Error('a'), 'message'), proxy, 'b'],
        'outer',
      );

      expect(getErrorMessage(aggregate)).toBe('outer: [Unreadable]; [Unreadable]; b');
    });

    it('writes each unreadable field of a node, past the first level', () => {
      // `stack` first: on Bun, redefining `stack` materializes it, which reads `message`.
      const inner = unreadable(
        unreadable(unreadable(new RangeError('inner'), 'stack'), 'message'),
        'code',
      );
      const middle = unreadable(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'middle',
          { pool: 'p' },
          { cause: inner },
        ),
        'data',
      );
      const outer = unreadable(new Error('outer', { cause: middle }), 'name');

      expect(extractErrorCauseChain(outer)).toEqual([
        { name: '[Unreadable]', message: 'outer', depth: 0, stack: expect.any(String) },
        { name: 'McpError', message: 'middle', depth: 1, stack: expect.any(String) },
        { name: 'RangeError', message: '[Unreadable]', depth: 2, stack: '[Unreadable]' },
      ]);
    });

    it.each([
      ['whose getter throws', () => unreadable(new Error('outer'), 'cause')],
      ['that is a revoked Proxy', () => new Error('outer', { cause: revoked() })],
    ])('ends the chain at a cause %s', (_label, make) => {
      expect(extractErrorCauseChain(make())).toEqual([
        { name: 'Error', message: 'outer', depth: 0, stack: expect.any(String) },
        { ...UNREADABLE_NODE, depth: 1 },
      ]);
    });

    it('writes a revoked Proxy passed as the error itself as one [Unreadable] node', () => {
      expect(extractErrorCauseChain(revoked())).toEqual([{ ...UNREADABLE_NODE, depth: 0 }]);
    });

    it('isInstance answers instanceof, and false for a value the check cannot inspect', () => {
      const mcp = new McpError(JsonRpcErrorCode.NotFound, 'gone');
      expect(isInstance(mcp, McpError)).toBe(true);
      expect(isInstance(mcp, Error)).toBe(true);
      expect(isInstance(new Error('x'), McpError)).toBe(false);
      expect(isInstance('x', Error)).toBe(false);
      expect(isInstance(revoked(), Error)).toBe(false);
    });

    it('asError keeps an Error, wraps any other value by its string form, and [Unreadable] past that', () => {
      const error = new TypeError('kept');
      expect(asError(error)).toBe(error);
      const unreadableMessage = unreadable(new Error('kept'), 'message');
      expect(asError(unreadableMessage)).toBe(unreadableMessage);
      expect(asError('plain failure')).toEqual(new Error('plain failure'));
      expect(asError(503)).toEqual(new Error('503'));
      expect(asError(Object.create(null))).toEqual(new Error('[Unreadable]'));
      expect(asError(revoked())).toEqual(new Error('[Unreadable]'));
    });

    describe('an Error whose message or name is not a string', () => {
      /** `error` with an own `key` holding `value`. */
      const withField = <E extends Error>(error: E, key: string, value: unknown): E =>
        Object.defineProperty(error, key, { configurable: true, writable: true, value });
      const unconvertible = {
        toString(): string {
          throw new Error('toString trap');
        },
      };

      it.each([
        ['a Symbol', Symbol('sym'), 'Symbol(sym)'],
        ['a number', 404, '404'],
        ['a BigInt', 10n, '10'],
        ['undefined', undefined, 'undefined'],
        ['an object whose toString throws', unconvertible, '[Unreadable]'],
        ['a plain object', { code: 1 }, '[Unreadable]'],
        ['a function', () => 'text', '[Unreadable]'],
      ])(
        'reads %s message as a string: String() for a primitive, [Unreadable] past that',
        (_l, value, text) => {
          const error = withField(new Error('x'), 'message', value);
          const mcp = withField(new McpError(JsonRpcErrorCode.NotFound, 'x'), 'message', value);

          expect(getErrorMessage(error)).toBe(text);
          expect(ErrorHandler.classifyOnly(error).message).toBe(text);
          expect(ErrorHandler.classifyOnly(mcp).message).toBe(text);
          expect(ErrorHandler.formatError(error).message).toBe(text);
          expect(ErrorHandler.formatError(mcp).message).toBe(text);
        },
      );

      it('reads each AggregateError member’s message by the same rule', () => {
        const aggregate = new AggregateError(
          [withField(new Error('a'), 'message', Symbol('inner')), new Error('b')],
          'outer',
        );
        withField(aggregate, 'message', 404);

        expect(getErrorMessage(aggregate)).toBe('404: Symbol(inner); b');
      });

      it.each([
        ['a Symbol', Symbol('sym-name'), 'Symbol(sym-name)'],
        ['an object whose toString throws', unconvertible, '[Unreadable]'],
        ['an empty string', '', 'Error'],
      ])('names an Error whose name is %s with a string', (_l, value, name) => {
        expect(getErrorName(withField(new Error('x'), 'name', value))).toBe(name);
      });

      it('writes each cause-chain node’s name and message as strings, past the first level', () => {
        const inner = withField(
          withField(new Error('inner'), 'message', unconvertible),
          'name',
          Symbol('inner-name'),
        );
        const outer = withField(new Error('outer', { cause: inner }), 'message', 404);

        expect(extractErrorCauseChain(outer)).toEqual([
          { name: 'Error', message: '404', depth: 0, stack: expect.any(String) },
          {
            name: 'Symbol(inner-name)',
            message: '[Unreadable]',
            depth: 1,
            stack: expect.any(String),
          },
        ]);
      });
    });

    it('still stops at maxDepth when the unreadable cause lies past it', () => {
      expect(extractErrorCauseChain(unreadable(new Error('outer'), 'cause'), 1)).toEqual([
        { name: 'Error', message: 'outer', depth: 0, stack: expect.any(String) },
        {
          name: 'MaxDepthExceeded',
          message: 'Error cause chain exceeded maximum depth of 1',
          depth: 1,
        },
      ]);
    });
  });

  // ─── recordSpanFailure ───────────────────────────────────────────────────────

  describe('recordSpanFailure', () => {
    /** A span double whose `recordException` reads the fields the OTel SDK's does. */
    function sdkLikeSpan() {
      return {
        recordException: vi.fn((e: Error & { code?: unknown }) => {
          void [e.code, e.name, e.message, e.stack];
        }),
        setStatus: vi.fn(),
      };
    }

    it('records an Error and sets the ERROR status with its message', () => {
      const span = sdkLikeSpan();
      const error = new Error('boom');

      recordSpanFailure(span as unknown as Span, error);

      expect(span.recordException).toHaveBeenCalledWith(error);
      expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'boom' });
    });

    it.each([
      ['a string', 'plain failure', 'plain failure'],
      ['a number', 503, '503'],
      ['a null-prototype object', Object.create(null), '[Unreadable]'],
      ['a revoked Proxy', revokedProxy(), '[Unreadable]'],
    ])('sets the status for %s without recording an exception', (_label, value, message) => {
      const span = sdkLikeSpan();

      recordSpanFailure(span as unknown as Span, value);

      expect(span.recordException).not.toHaveBeenCalled();
      expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message });
    });

    it.each([
      ['stack', 'boom'],
      ['name', 'boom'],
      ['message', '[Unreadable]'],
    ])(
      'never throws for an Error whose %s getter throws, the span still marked failed',
      (key, message) => {
        const span = sdkLikeSpan();
        const error = Object.defineProperty(new Error('boom'), key, {
          configurable: true,
          get() {
            throw new Error(`${key} getter`);
          },
        });

        expect(() => recordSpanFailure(span as unknown as Span, error)).not.toThrow();
        expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message });
      },
    );
  });
});

/** A revoked Proxy, built at module scope for `it.each` tables. */
function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

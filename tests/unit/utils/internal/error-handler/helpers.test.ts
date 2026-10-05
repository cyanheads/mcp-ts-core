/**
 * @fileoverview Test suite for error handler helper utilities — getErrorName, getErrorMessage,
 * formatZodErrorMessage, extractErrorCauseChain.
 * @module tests/utils/internal/error-handler/helpers.test
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import {
  extractErrorCauseChain,
  formatZodErrorMessage,
  getErrorMessage,
  getErrorName,
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
      const lastNode = chain[chain.length - 1]!;
      expect(lastNode.name).toBe('MaxDepthExceeded');
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
});

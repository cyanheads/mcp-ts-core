/**
 * @fileoverview Fuzz tests for the ErrorHandler classification pipeline.
 * Throws exotic error types and adversarial messages to verify the classifier
 * never crashes and always returns a valid error code.
 * @module tests/fuzz/error-handler.fuzz.test
 */

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
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
import { logger } from '@/utils/internal/logger.js';

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

    it('carries a ZodError’s issues whole within 10, and the first 10 with issuesCount past them (#710)', () => {
      /** Rows whose ids must be digits and whose tags at most 3 characters: issues two arrays deep. */
      const Rows = z.array(
        z.object({
          id: z.string().regex(/^\d+$/).describe('Row ID'),
          tags: z.array(z.string().max(3).describe('Tag')).describe('Tags'),
        }),
      );
      const row = fc.record({
        id: fc.oneof(fc.stringMatching(/^\d{1,4}$/), fc.string({ maxLength: 8 })),
        tags: fc.array(fc.string({ maxLength: 6 }), { maxLength: 6 }),
      });

      fc.assert(
        fc.property(fc.array(row, { maxLength: 12 }), (rows) => {
          const parsed = Rows.safeParse(rows);
          if (parsed.success) return;
          const { issues } = parsed.error;
          const { code, data } = ErrorHandler.classifyOnly(parsed.error);
          expect(code).toBe(JsonRpcErrorCode.ValidationError);
          if (issues.length <= 10) {
            expect(data?.issues).toBe(issues);
            expect(data).not.toHaveProperty('issuesCount');
          } else {
            expect(data).toEqual({ issues: issues.slice(0, 10), issuesCount: issues.length });
          }
        }),
        { numRuns: 200, seed: 20_261_012 },
      );
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

    it('returns data carrying no stack, cause chain, root cause, or context for any non-McpError throw', () => {
      // The returned error's `data` reaches the client verbatim; diagnostics, what
      // the cause chain says (#644), and the caller's context belong in the log
      // record alone.
      const DATA_KEYS = new Set(['originalErrorName', 'originalMessage']);
      const thrownValue = fc.oneof(
        fc.string(),
        fc.integer(),
        fc.constant(null),
        fc.dictionary(fc.string(), fc.string()),
        fc.string().map((message) => new Error(message)),
        fc
          .array(fc.string(), { minLength: 2, maxLength: 4 })
          .map(
            (messages) =>
              messages.reduceRight<Error | undefined>(
                (cause, message) => new Error(message, { cause }),
                undefined,
              ) as Error,
          ),
      );

      fc.assert(
        fc.property(thrownValue, (thrown) => {
          const result = ErrorHandler.handleError(thrown, {
            operation: 'fuzz-test',
            context: { requestId: 'fuzz-req', extra: { contextOnly: 'context-only-marker' } },
          }) as McpError;

          expect(Object.keys(result.data ?? {}).filter((key) => !DATA_KEYS.has(key))).toEqual([]);
          expect(JSON.stringify(result.data)).not.toMatch(/\n\s+at |context-only-marker/);
        }),
        { numRuns: 100 },
      );
    });

    it('logs a ZodError at any cause depth as its summary, never its JSON of every issue (#736)', () => {
      const Rows = z.array(
        z.object({
          id: z.string().regex(/^\d+$/).describe('Row ID'),
          tags: z.array(z.string().max(3).describe('Tag')).describe('Tags'),
        }),
      );
      const row = fc.record({
        id: fc.oneof(fc.stringMatching(/^\d{1,4}$/), fc.string({ maxLength: 8 })),
        tags: fc.array(fc.string({ maxLength: 6 }), { maxLength: 6 }),
      });
      /** A pretty-printed issue's key, as Zod's own `message` writes every one. */
      const ISSUE_JSON = '"code": "';

      fc.assert(
        fc.property(
          fc.array(row, { maxLength: 12 }),
          fc.integer({ min: 0, max: 3 }),
          (rows, depth) => {
            let zodError: z.ZodError | undefined;
            try {
              Rows.parse(rows);
            } catch (error) {
              zodError = error as z.ZodError;
            }
            if (!zodError) return;
            const summary = ErrorHandler.classifyOnly(zodError).message;
            let thrown: Error = zodError;
            for (let level = 0; level < depth; level++) {
              thrown = new Error(`level ${level}`, { cause: thrown });
            }

            ErrorHandler.handleError(thrown, { operation: 'fuzz-zod' });

            const [message, record] = vi.mocked(logger.error).mock.calls.at(-1) as unknown as [
              string,
              { extra: { stack?: string; errorData: Record<string, unknown> } },
            ];
            const { stack, errorData } = record.extra;
            const chain = (errorData.causeChain ?? []) as Array<{
              message: string;
              stack?: string;
            }>;
            const written = [
              message,
              stack,
              (errorData.rootCause as { message?: string } | undefined)?.message,
              ...chain.flatMap((node) => [node.message, node.stack]),
            ];
            for (const text of written) expect(text ?? '').not.toContain(ISSUE_JSON);
            if (depth === 0) expect(message).toBe(`Error in fuzz-zod: ${summary}`);
            else expect(chain.at(-1)?.message).toBe(summary);
          },
        ),
        { numRuns: 200, seed: 20_261_012 },
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

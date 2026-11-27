/**
 * @fileoverview Unit tests for pagination utilities.
 * Tests cursor-based pagination per MCP specification 2025-06-18.
 * @module tests/utils/pagination/index.test
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { z } from 'zod';
import { type AnyToolDefinition, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { createToolHandler } from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { runToolContract } from '@/testing/index.js';
import { logger } from '@/utils/internal/logger.js';
import { type RequestContext, requestContextService } from '@/utils/internal/requestContext.js';
import { JsonRpcErrorCode, McpError } from '../../../../src/types-global/errors.js';
import {
  DEFAULT_PAGINATION_CONFIG,
  decodeCursor,
  encodeCursor,
  extractCursor,
  type PaginationState,
  paginateArray,
} from '../../../../src/utils/pagination/pagination.js';
import { legacyCapabilityView, makeServerContext } from '../../../helpers/server-context.js';

describe('Pagination Utilities', () => {
  let context: RequestContext;
  let warningSpy: MockInstance;

  beforeEach(() => {
    context = requestContextService.createRequestContext({
      operation: 'test-pagination',
    });
    warningSpy = vi.spyOn(logger, 'warning').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('encodeCursor()', () => {
    it('should encode a valid pagination state to base64url', () => {
      // Standard base64 of this state is `…I/Pz4+In0=` — it carries `+`, `/`, and `=`.
      const state: PaginationState = { offset: 10, limit: 50, q: '??>>' };
      const cursor = encodeCursor(state);

      expect(cursor).toBe('eyJvZmZzZXQiOjEwLCJsaW1pdCI6NTAsInEiOiI_Pz4-In0');
      expect(cursor).not.toMatch(/[+/=]/);
      expect(decodeCursor(cursor, context)).toEqual(state);
    });

    it('should throw McpError if encoding fails due to circular reference', () => {
      const circularState: PaginationState = { offset: 0, limit: 10 };
      // Create circular reference
      (circularState as { self?: PaginationState }).self = circularState;

      expect(() => encodeCursor(circularState)).toThrow(McpError);
      try {
        encodeCursor(circularState);
      } catch (error) {
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.InternalError);
        expect(mcpError.message).toContain('Failed to encode pagination cursor');
      }
    });

    // #611 — a state the decoder rejects is never issued as a cursor.
    it.each([
      ['a fractional offset and limit', { offset: 2.5, limit: 2.5 }],
      ['a fractional limit', { offset: 0, limit: 0.1 }],
      ['an offset past the safe-integer range', { offset: 2 ** 53, limit: 10 }],
      ['an infinite limit', { offset: 0, limit: Number.POSITIVE_INFINITY }],
      ['a NaN offset', { offset: Number.NaN, limit: 10 }],
      ['a negative offset', { offset: -1, limit: 10 }],
      ['a zero limit', { offset: 0, limit: 0 }],
    ])('throws InternalError instead of encoding %s', (_label, state) => {
      expect(() => encodeCursor(state)).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.InternalError,
          message:
            'Failed to encode pagination cursor: offset must be a non-negative safe integer and limit a positive safe integer.',
          data: { offset: state.offset, limit: state.limit },
        }),
      );
    });

    it.each([
      [{ offset: 0, limit: 1 }, 'eyJvZmZzZXQiOjAsImxpbWl0IjoxfQ'],
      [
        { offset: Number.MAX_SAFE_INTEGER, limit: Number.MAX_SAFE_INTEGER },
        'eyJvZmZzZXQiOjkwMDcxOTkyNTQ3NDA5OTEsImxpbWl0Ijo5MDA3MTk5MjU0NzQwOTkxfQ',
      ],
    ])('encodes the integer state %j to the same cursor as before', (state, expected) => {
      expect(encodeCursor(state)).toBe(expected);
    });
  });

  describe('decodeCursor()', () => {
    it('should throw McpError with InvalidParams for invalid base64 string', () => {
      const invalidCursor = 'not-valid-base64!!!';

      expect(() => decodeCursor(invalidCursor, context)).toThrow(McpError);
      try {
        decodeCursor(invalidCursor, context);
      } catch (error) {
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(mcpError.message).toContain('Invalid pagination cursor');
        expect(warningSpy).toHaveBeenCalledWith(
          'Failed to decode pagination cursor',
          expect.objectContaining({
            extra: expect.objectContaining({ cursor: invalidCursor }),
          }),
        );
      }
    });

    it.each([
      ['offset is missing', { limit: 50 }],
      ['limit is missing', { offset: 10 }],
      ['offset is negative', { offset: -5, limit: 50 }],
      ['limit is zero', { offset: 0, limit: 0 }],
      ['limit is negative', { offset: 0, limit: -10 }],
      ['offset is not a number', { offset: 'not-a-number', limit: 50 }],
      ['limit is not a number', { offset: 10, limit: 'not-a-number' }],
    ])('should throw McpError with InvalidParams when %s', (_label, invalidState) => {
      const cursor = Buffer.from(JSON.stringify(invalidState), 'utf-8').toString('base64url');

      expect(() => decodeCursor(cursor, context)).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.InvalidParams,
          message: expect.stringContaining('Invalid pagination cursor'),
        }),
      );
    });

    // #611 — `offset` and `limit` must be safe integers. Written as JSON text so
    // `1e400` and `1e21` reach the decoder as the caller spelled them.
    it.each(
      ['1.5', '0.1', '1e-300', '1e400', '9007199254740992', '1e21'].flatMap((value) => [
        [`offset ${value}`, `{"offset":${value},"limit":50}`],
        [`limit ${value}`, `{"offset":0,"limit":${value}}`],
      ]),
    )('rejects %s as invalid_cursor', (_label, json) => {
      const cursor = Buffer.from(json, 'utf-8').toString('base64url');

      expect(() => decodeCursor(cursor, context)).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.InvalidParams,
          data: expect.objectContaining({ reason: 'invalid_cursor' }),
        }),
      );
    });

    // Every cursor these forms produce decodes today and keeps decoding (#611, #681).
    describe('accepted cursor forms', () => {
      const states = [
        { offset: 0, limit: 1 },
        { offset: 10, limit: 50, q: '??>>' },
        { offset: Number.MAX_SAFE_INTEGER, limit: Number.MAX_SAFE_INTEGER, u: 'é漢🙂' },
      ];
      const pad = (token: string) => token + '='.repeat((4 - (token.length % 4)) % 4);
      const standard = (token: string) => token.replace(/-/g, '+').replace(/_/g, '/');
      const transports: Array<[string, (token: string) => string]> = [
        ['as issued', (token) => token],
        ['with = padding', pad],
        ['in the standard alphabet', standard],
        ['in the standard alphabet with padding', (token) => pad(standard(token))],
        ['inside surrounding spaces', (token) => ` ${token} `],
        ['inside a tab and a newline', (token) => `\t${token}\n`],
      ];

      it.each(
        states.flatMap((state) =>
          transports.map(([form, transform]) => [JSON.stringify(state), form, state, transform]),
        ),
      )('decodes the encodeCursor output for %s %s', (_json, _form, state, transform) => {
        const token = (transform as (token: string) => string)(
          encodeCursor(state as PaginationState),
        );
        expect(decodeCursor(token, context)).toEqual(state);
      });

      it.each([
        ['a leading space', ' {"offset":10,"limit":5}', 10, 5],
        ['extra keys', '{"offset":10,"limit":5,"q":"a","n":null,"arr":[1,2]}', 10, 5],
        ['reordered keys', '{"limit":5,"offset":10}', 10, 5],
        ['-0', '{"offset":-0,"limit":5}', -0, 5],
        ['1e3', '{"offset":1e3,"limit":1e3}', 1000, 1000],
        ['1.0', '{"offset":1.0,"limit":1.0}', 1, 1],
        [
          'Number.MAX_SAFE_INTEGER',
          '{"offset":9007199254740991,"limit":9007199254740991}',
          Number.MAX_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
        ],
      ])('decodes JSON with %s', (_label, json, offset, limit) => {
        const state = decodeCursor(Buffer.from(json, 'utf-8').toString('base64url'), context);
        expect(state.offset).toBe(offset);
        expect(state.limit).toBe(limit);
      });

      it('decodes a limit above maxPageSize, which paginateArray clamps', () => {
        const cursor = Buffer.from('{"offset":0,"limit":1000000}', 'utf-8').toString('base64url');
        expect(decodeCursor(cursor, context).limit).toBe(1_000_000);

        const page = paginateArray(
          Array.from({ length: 30 }, (_, i) => i),
          cursor,
          10,
          20,
          context,
        );
        expect(page.items).toHaveLength(20);
        expect(page.nextCursor).toBe(encodeCursor({ offset: 20, limit: 20 }));
      });
    });

    // #504 — the rejection carries a reason and recovery hint like every other
    // classified failure, so it renders the `Recovery:` line and reason trailer.
    it.each([
      ['non-base64 text', 'not-a-cursor!!!'],
      ['base64 that is not JSON', Buffer.from('not json', 'utf-8').toString('base64url')],
      ['a negative offset', Buffer.from('{"offset":-1,"limit":5}').toString('base64url')],
      ['a zero limit', Buffer.from('{"offset":0,"limit":0}').toString('base64url')],
      ['JSON missing offset and limit', Buffer.from('{"page":2}').toString('base64url')],
      ['JSON null', Buffer.from('null').toString('base64url')],
    ])(
      'tags a cursor built from %s with reason invalid_cursor and a recovery hint',
      (_label, cursor) => {
        let caught: unknown;
        try {
          decodeCursor(cursor, context);
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(McpError);
        const mcpError = caught as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(mcpError.message).toBe(
          'Invalid pagination cursor. The cursor may be expired, corrupted, or from a different request.',
        );
        expect(mcpError.data).toEqual({
          cursor,
          reason: 'invalid_cursor',
          recovery: {
            hint: 'Omit cursor to start from the first page, or pass the next-page cursor from the previous response unchanged.',
          },
        });
        expect(mcpError.literals).toEqual(['cursor']);
      },
    );

    it('decodes a cursor produced by encodeCursor unchanged', () => {
      const state = { offset: 40, limit: 20, filter: 'x' };
      expect(decodeCursor(encodeCursor(state), context)).toEqual(state);
    });

    // #873 — the rejected cursor is echoed in `data.cursor` and the warning record
    // whole up to 50 characters, and past that as its first 50 followed by `...`.
    // The cut never splits a surrogate pair: a lone half is not well-formed text,
    // and strict JSON parsers reject the `\ud83d` escape it serializes to.
    it.each([
      ['50 characters', 'x'.repeat(50), 'x'.repeat(50)],
      ['51 characters', `${'x'.repeat(50)}y`, `${'x'.repeat(50)}...`],
      ['10,000 characters', `${'a'.repeat(50)}${'b'.repeat(9_950)}`, `${'a'.repeat(50)}...`],
      ['a pair ending at the 50th unit', `${'x'.repeat(48)}🙂yz`, `${'x'.repeat(48)}🙂...`],
      ['a pair across the 50th unit', `${'x'.repeat(49)}🙂🙂`, `${'x'.repeat(49)}...`],
    ])('echoes a rejected cursor of %s', (_label, cursor, echoed) => {
      let caught: unknown;
      try {
        decodeCursor(cursor, context);
      } catch (error) {
        caught = error;
      }

      const mcpError = caught as McpError;
      expect(mcpError.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(mcpError.message).toBe(
        'Invalid pagination cursor. The cursor may be expired, corrupted, or from a different request.',
      );
      expect(mcpError.data).toMatchObject({ cursor: echoed, reason: 'invalid_cursor' });
      expect(warningSpy).toHaveBeenCalledTimes(1);
      expect(warningSpy).toHaveBeenCalledWith(
        'Failed to decode pagination cursor',
        expect.objectContaining({ extra: expect.objectContaining({ cursor: echoed }) }),
      );
    });
  });

  describe('invalid cursor on a tool surface (#504)', () => {
    const pagedTool = tool('paged_items', {
      description: 'Lists items a page at a time.',
      input: z.object({ cursor: z.string().optional().describe('Opaque page cursor') }),
      output: z.object({
        items: z.array(z.string().describe('Item')).describe('Page of items'),
        nextCursor: z.string().optional().describe('Cursor for the next page'),
      }),
      handler: (input, ctx) => {
        const page = paginateArray(['a', 'b', 'c'], input.cursor, 2, 10, ctx);
        return { items: page.items, ...(page.nextCursor && { nextCursor: page.nextCursor }) };
      },
    });

    it('renders the Recovery line and reason trailer in content[] and the reason on structuredContent', async () => {
      const result = await runToolContract(pagedTool, { cursor: 'not-a-cursor' });

      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: McpError }).error;
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data).toMatchObject({
        cursor: 'not-a-cursor',
        reason: 'invalid_cursor',
        recovery: { hint: expect.stringContaining('Omit cursor') },
      });
      const block = result.content?.[0];
      expect(block?.type).toBe('text');
      const text = block?.type === 'text' ? block.text : '';
      // The declared parameter names render as code spans; the raw hint carries none (#818).
      expect(text).toContain('Error: Invalid pagination `cursor`.');
      // The hint names no output field: tools call theirs `cursor`, `nextCursor`, `next_cursor`… (#603).
      expect(text).toContain(
        'Recovery: Omit `cursor` to start from the first page, or pass the next-page `cursor` from the previous response unchanged.',
      );
      expect(text).not.toContain('nextCursor');
      expect(text).toContain('(reason invalid_cursor)');
    });

    /**
     * #873 — through the production handler factory, so the `Error in
     * tool:paged_items` record `ErrorHandler` writes is in scope beside the
     * decoder's own warning. `LOG_TOOL_FAILURE_PAYLOADS` is off by default, so
     * no failure-payload record is written.
     */
    it('carries the rejected cursor no further than data.cursor on the result and every log record', async () => {
      const levels = [
        'debug',
        'info',
        'notice',
        'warning',
        'error',
        'crit',
        'alert',
        'emerg',
        'fatal',
      ] as const;
      const records: Array<{ level: string; message: string; json: string }> = [];
      /** Expands an `Error` into its fields, which `JSON.stringify` otherwise drops. */
      const replacer = (_key: string, value: unknown) =>
        value instanceof Error
          ? { ...value, name: value.name, message: value.message, stack: value.stack }
          : value;
      for (const level of levels) {
        vi.spyOn(logger, level).mockImplementation(((message: string, ...rest: unknown[]) => {
          records.push({ level, message, json: JSON.stringify(rest, replacer) });
        }) as never);
      }
      const cursor = 'x'.repeat(10_000);
      const echoed = `${'x'.repeat(50)}...`;

      const handler = createToolHandler(
        pagedTool as AnyToolDefinition,
        { logger: logger as never } as never,
        {},
        legacyCapabilityView({}),
      );
      const result = (await handler({ cursor }, makeServerContext({}))) as CallToolResult;

      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: McpError }).error;
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.message).toBe(
        'Invalid pagination cursor. The cursor may be expired, corrupted, or from a different request.',
      );
      expect(error.data).toMatchObject({ cursor: echoed, reason: 'invalid_cursor' });

      const decodeRecord = records.find((r) => r.message === 'Failed to decode pagination cursor');
      const toolRecord = records.find((r) => r.message.startsWith('Error in tool:paged_items: '));
      expect(decodeRecord?.json).toContain(`"cursor":"${echoed}"`);
      expect(toolRecord?.json).toContain(`"cursor":"${echoed}"`);
      expect(records.length).toBeGreaterThanOrEqual(2);
      for (const record of records) {
        expect(record.json, `${record.level}: ${record.message}`).not.toContain('x'.repeat(51));
      }
    });

    it('pages normally with a cursor the tool itself issued', async () => {
      const first = await runToolContract(pagedTool, {});
      const nextCursor = (first.structuredContent as { nextCursor?: string }).nextCursor;
      expect(nextCursor).toBeTypeOf('string');

      const second = await runToolContract(pagedTool, { cursor: nextCursor });
      expect(second.structuredContent).toEqual({ items: ['c'] });
    });
  });

  describe('extractCursor()', () => {
    it('should extract cursor from params.cursor', () => {
      const params = { cursor: 'test-cursor-123' };
      const cursor = extractCursor(params);

      expect(cursor).toBe('test-cursor-123');
    });

    it('should extract cursor from params._meta.cursor', () => {
      const params = { _meta: { cursor: 'meta-cursor-456' } };
      const cursor = extractCursor(params);

      expect(cursor).toBe('meta-cursor-456');
    });

    it('should prefer params.cursor over params._meta.cursor', () => {
      const params = {
        cursor: 'direct-cursor',
        _meta: { cursor: 'meta-cursor' },
      };
      const cursor = extractCursor(params);

      expect(cursor).toBe('direct-cursor');
    });

    it('should return undefined when params is undefined', () => {
      const cursor = extractCursor(undefined);

      expect(cursor).toBeUndefined();
    });

    it('should return undefined when neither cursor location exists', () => {
      const params = {};
      const cursor = extractCursor(params);

      expect(cursor).toBeUndefined();
    });

    it('should return undefined when _meta exists but cursor does not', () => {
      const params = { _meta: {} };
      const cursor = extractCursor(params);

      expect(cursor).toBeUndefined();
    });

    it('should handle empty string cursor', () => {
      const params = { cursor: '' };
      const cursor = extractCursor(params);

      expect(cursor).toBe('');
    });
  });

  describe('paginateArray()', () => {
    const testItems = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      name: `Item ${i + 1}`,
    }));

    it('should return first page when no cursor provided', () => {
      const result = paginateArray(testItems, undefined, 10, 100, context);

      expect(result.items).toHaveLength(10);
      expect(result.items[0]?.id).toBe(1);
      expect(result.items[9]?.id).toBe(10);
      expect(result.nextCursor).toBeDefined();
      expect(result.totalCount).toBe(100);
    });

    it('should return subsequent page with valid cursor', () => {
      const firstPageResult = paginateArray(testItems, undefined, 10, 100, context);
      const cursor = firstPageResult.nextCursor!;

      const secondPageResult = paginateArray(testItems, cursor, 10, 100, context);

      expect(secondPageResult.items).toHaveLength(10);
      expect(secondPageResult.items[0]?.id).toBe(11);
      expect(secondPageResult.items[9]?.id).toBe(20);
      expect(secondPageResult.nextCursor).toBeDefined();
    });

    it('should handle empty array', () => {
      const emptyArray: typeof testItems = [];
      const result = paginateArray(emptyArray, undefined, 10, 100, context);

      expect(result.items).toHaveLength(0);
      expect(result.nextCursor).toBeUndefined();
      expect(result.totalCount).toBe(0);
    });

    it('should handle offset beyond array length', () => {
      const cursor = encodeCursor({ offset: 200, limit: 10 });
      const result = paginateArray(testItems, cursor, 10, 100, context);

      expect(result.items).toHaveLength(0);
      expect(result.nextCursor).toBeUndefined();
      expect(result.totalCount).toBe(100);
    });

    it('should enforce maxPageSize when cursor specifies larger limit', () => {
      const cursor = encodeCursor({ offset: 0, limit: 500 }); // Request 500 items
      const result = paginateArray(testItems, cursor, 10, 100, context); // Max 100

      expect(result.items).toHaveLength(100); // Should be capped at maxPageSize
      expect(result.items[0]?.id).toBe(1);
      expect(result.items[99]?.id).toBe(100);
      expect(result.nextCursor).toBeUndefined(); // No more items
    });

    it('should handle partial last page', () => {
      const cursor = encodeCursor({ offset: 95, limit: 10 });
      const result = paginateArray(testItems, cursor, 10, 100, context);

      expect(result.items).toHaveLength(5); // Only 5 items remaining
      expect(result.items[0]?.id).toBe(96);
      expect(result.items[4]?.id).toBe(100);
      expect(result.nextCursor).toBeUndefined();
    });

    it('should handle single item array', () => {
      const singleItem = [{ id: 1, name: 'Only Item' }];
      const result = paginateArray(singleItem, undefined, 10, 100, context);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.id).toBe(1);
      expect(result.nextCursor).toBeUndefined();
      expect(result.totalCount).toBe(1);
    });

    it('should handle exact page boundary', () => {
      const exactItems = Array.from({ length: 20 }, (_, i) => ({
        id: i + 1,
        name: `Item ${i + 1}`,
      }));

      // First page of 10
      const firstPage = paginateArray(exactItems, undefined, 10, 100, context);
      expect(firstPage.items).toHaveLength(10);
      expect(firstPage.nextCursor).toBeDefined();

      // Second (last) page of 10
      const secondPage = paginateArray(exactItems, firstPage.nextCursor!, 10, 100, context);
      expect(secondPage.items).toHaveLength(10);
      expect(secondPage.items[0]?.id).toBe(11);
      expect(secondPage.items[9]?.id).toBe(20);
      expect(secondPage.nextCursor).toBeUndefined(); // Exactly at boundary
    });

    it('should handle cursor with custom fields (ignore non-pagination fields)', () => {
      const stateWithCustomFields: PaginationState = {
        offset: 10,
        limit: 20,
        sortBy: 'name',
        customMetadata: 'test',
      };
      const cursor = encodeCursor(stateWithCustomFields);
      const result = paginateArray(testItems, cursor, 10, 100, context);

      expect(result.items).toHaveLength(20);
      expect(result.items[0]?.id).toBe(11);
    });

    // #611 — a page size the decoder would refuse fails on the call that would
    // issue the cursor, as a server fault, instead of one call later as the caller's.
    it.each([
      ['a fractional defaultPageSize', undefined, 2.5, 100],
      ['a fractional maxPageSize', encodeCursor({ offset: 0, limit: 50 }), 10, 7.5],
      ['a zero defaultPageSize', undefined, 0, 100],
    ])(
      'throws InternalError for %s over a list longer than one page',
      (_label, cursor, size, max) => {
        expect(() => paginateArray(testItems, cursor, size, max, context)).toThrow(
          expect.objectContaining({ code: JsonRpcErrorCode.InternalError }),
        );
      },
    );

    it('serves a fractional page size that fits one page, issuing no cursor', () => {
      const result = paginateArray(testItems.slice(0, 2), undefined, 2.5, 100, context);

      expect(result.items).toHaveLength(2);
      expect(result.nextCursor).toBeUndefined();
    });
  });

  describe('Integration Scenarios', () => {
    it('should successfully navigate through all pages of data', () => {
      const items = Array.from({ length: 47 }, (_, i) => ({ id: i + 1 }));
      const pageSize = 10;
      const collectedItems: typeof items = [];
      let cursor: string | undefined;
      let pageCount = 0;
      let hasMore = true;

      // Navigate through all pages
      while (hasMore) {
        const result = paginateArray(items, cursor, pageSize, 100, context);
        collectedItems.push(...result.items);
        pageCount++;

        if (!result.nextCursor) {
          hasMore = false;
        } else {
          cursor = result.nextCursor;
        }
      }

      expect(collectedItems).toHaveLength(47);
      expect(pageCount).toBe(5); // 10+10+10+10+7
      expect(collectedItems[0]?.id).toBe(1);
      expect(collectedItems[46]?.id).toBe(47);
    });

    it('should handle pagination with extractCursor helper', () => {
      const items = Array.from({ length: 30 }, (_, i) => ({ id: i + 1 }));

      // First request (no cursor)
      const params1 = {};
      const cursor1 = extractCursor(params1);
      const result1 = paginateArray(items, cursor1, 10, 100, context);

      expect(result1.items).toHaveLength(10);
      expect(result1.nextCursor).toBeDefined();

      // Second request (cursor in params)
      expect(result1.nextCursor).toBeDefined();
      const params2 = { cursor: result1.nextCursor! };
      const cursor2 = extractCursor(params2);
      const result2 = paginateArray(items, cursor2, 10, 100, context);

      expect(result2.items).toHaveLength(10);
      expect(result2.items[0]?.id).toBe(11);

      // Third request (cursor in _meta)
      expect(result2.nextCursor).toBeDefined();
      const params3 = { _meta: { cursor: result2.nextCursor! } };
      const cursor3 = extractCursor(params3);
      const result3 = paginateArray(items, cursor3, 10, 100, context);

      expect(result3.items).toHaveLength(10);
      expect(result3.items[0]?.id).toBe(21);
      expect(result3.nextCursor).toBeUndefined(); // Last page
    });

    it('should handle cursor created with different page size', () => {
      const items = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));

      // First page with pageSize 15
      const result1 = paginateArray(items, undefined, 15, 100, context);
      expect(result1.items).toHaveLength(15);

      // Continue with same cursor (should preserve limit=15)
      const result2 = paginateArray(items, result1.nextCursor!, 20, 100, context);
      expect(result2.items).toHaveLength(15); // Uses cursor's limit, not defaultPageSize
      expect(result2.items[0]?.id).toBe(16);
    });
  });

  describe('DEFAULT_PAGINATION_CONFIG', () => {
    it('should have valid default configuration values', () => {
      expect(DEFAULT_PAGINATION_CONFIG.DEFAULT_PAGE_SIZE).toBe(50);
      expect(DEFAULT_PAGINATION_CONFIG.MAX_PAGE_SIZE).toBe(1000);
      expect(DEFAULT_PAGINATION_CONFIG.MIN_PAGE_SIZE).toBe(1);

      // Validate relationships
      expect(DEFAULT_PAGINATION_CONFIG.MIN_PAGE_SIZE).toBeLessThan(
        DEFAULT_PAGINATION_CONFIG.DEFAULT_PAGE_SIZE,
      );
      expect(DEFAULT_PAGINATION_CONFIG.DEFAULT_PAGE_SIZE).toBeLessThan(
        DEFAULT_PAGINATION_CONFIG.MAX_PAGE_SIZE,
      );
    });
  });

  /**
   * Padding stripping moved from `=+$` to `={1,2}$` (#431). base64 never emits
   * more than two padding characters, so the bounded quantifier is equivalent —
   * these pin one state per padding length.
   */
  describe('encodeCursor padding (#431)', () => {
    it.each([
      [{ offset: 50, limit: 25 }, 'eyJvZmZzZXQiOjUwLCJsaW1pdCI6MjV9'],
      [{ offset: 0, limit: 1, ab: 1 }, 'eyJvZmZzZXQiOjAsImxpbWl0IjoxLCJhYiI6MX0'],
      [{ offset: 0, limit: 1, a: 1 }, 'eyJvZmZzZXQiOjAsImxpbWl0IjoxLCJhIjoxfQ'],
    ])('encodes %j to a padding-free, round-trippable cursor', (state, expected) => {
      const cursor = encodeCursor(state as PaginationState);
      expect(cursor).toBe(expected);
      expect(cursor).not.toContain('=');
      expect(decodeCursor(cursor, context)).toEqual(state);
    });
  });
});

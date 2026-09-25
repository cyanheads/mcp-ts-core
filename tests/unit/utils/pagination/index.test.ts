/**
 * @fileoverview Unit tests for pagination utilities.
 * Tests cursor-based pagination per MCP specification 2025-06-18.
 * @module tests/utils/pagination/index.test
 */
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
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

    it('should throw McpError with InvalidParams for valid base64 but invalid JSON', () => {
      const invalidJsonCursor = Buffer.from('not json', 'utf-8').toString('base64url');

      expect(() => decodeCursor(invalidJsonCursor, context)).toThrow(McpError);
      try {
        decodeCursor(invalidJsonCursor, context);
      } catch (error) {
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.InvalidParams);
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

    it('should throw McpError for invalid cursor', () => {
      const invalidCursor = 'invalid-cursor-string';

      expect(() => paginateArray(testItems, invalidCursor, 10, 100, context)).toThrow(McpError);
      try {
        paginateArray(testItems, invalidCursor, 10, 100, context);
      } catch (error) {
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.InvalidParams);
      }
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

    it('should handle round-trip encode/decode preserving all fields', () => {
      const originalState: PaginationState = {
        offset: 42,
        limit: 73,
        sortBy: 'name',
        sortOrder: 'desc',
        filterApplied: true,
      };

      const cursor = encodeCursor(originalState);
      const decodedState = decodeCursor(cursor, context);

      expect(decodedState.offset).toBe(originalState.offset);
      expect(decodedState.limit).toBe(originalState.limit);
      expect(decodedState.sortBy).toBe(originalState.sortBy);
      expect(decodedState.sortOrder).toBe(originalState.sortOrder);
      expect(decodedState.filterApplied).toBe(originalState.filterApplied);
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

/**
 * @fileoverview Pagination utilities for MCP list operations.
 * Implements cursor-based pagination per MCP specification 2025-06-18.
 *
 * MCP Pagination Model:
 * - Opaque cursor-based approach (not numbered pages)
 * - Cursor is an opaque string token representing a position in the result set
 * - Page size is determined by server (clients MUST NOT assume fixed page size)
 * - Invalid cursors should result in error code -32602 (Invalid params)
 *
 * @see {@link https://modelcontextprotocol.io/specification/2025-06-18/utils/pagination | MCP Pagination Spec}
 * @module src/utils/pagination/pagination
 */

import { invalidParams, JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { base64ToString, stringToBase64 } from '@/utils/internal/encoding.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

/**
 * Generic pagination state that can be encoded into a cursor.
 * Implementations can extend this with additional fields as needed.
 * This is the data structure serialized into the opaque cursor token.
 */
export interface PaginationState {
  /** Maximum number of items per page; must be a positive integer */
  limit: number;
  /** Zero-based index of the first item in the current page */
  offset: number;
  /** Optional additional state preserved across pages (implementation-specific) */
  // allow open-indexed-named: generic pagination state for implementer extension
  [key: string]: unknown;
}

/**
 * Result of a paginated operation.
 * Returned by {@link paginateArray} and should be the shape returned by MCP list handlers.
 * Per MCP spec, `nextCursor` must be omitted (not set to `null` or `""`) when no further pages exist.
 */
export interface PaginatedResult<T> {
  /** Items for the current page */
  items: T[];
  /**
   * Opaque cursor token for the next page.
   * Omitted entirely when this is the last page — do not set to `null` or `""`.
   */
  nextCursor?: string;
  /**
   * Total item count across all pages, if cheaply available.
   * Optional — some backends cannot compute this efficiently.
   */
  totalCount?: number;
}

/**
 * Encodes pagination state into an opaque base64url cursor string.
 * Serializes `state` to JSON, then encodes as base64url (URL-safe, no padding).
 * The format is an implementation detail — callers must treat the returned string as opaque.
 *
 * @param state - Pagination state to encode; must have `offset >= 0` and `limit > 0`
 * @returns Base64url-encoded cursor string (no `+`, `/`, or `=` characters)
 * @throws {McpError} With code `InternalError` (-32603) if JSON serialization fails
 * @example
 * const cursor = encodeCursor({ offset: 50, limit: 25 });
 * // cursor is an opaque string like "eyJvZmZzZXQiOjUwLCJsaW1pdCI6MjV9"
 */
export function encodeCursor(state: PaginationState): string {
  try {
    const jsonString = JSON.stringify(state);
    // Use cross-platform encoding, then convert standard base64 to base64url
    const base64 = stringToBase64(jsonString)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return base64;
  } catch (error: unknown) {
    throw new McpError(JsonRpcErrorCode.InternalError, 'Failed to encode pagination cursor', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Decodes an opaque cursor string back into pagination state.
 * Reverses base64url encoding, parses the JSON, and validates the required fields:
 * `offset` must be a non-negative number and `limit` must be a positive number.
 * Logs a warning and throws `InvalidParams` on any failure, per MCP spec.
 *
 * @param cursor - Opaque cursor string previously returned by {@link encodeCursor}
 * @param context - Request context used to correlate warning log entries
 * @returns Validated `PaginationState` decoded from the cursor
 * @throws {McpError} With code `InvalidParams` (-32602) if the cursor is malformed,
 *   base64-invalid, not valid JSON, or has an invalid `offset`/`limit` structure
 * @example
 * const state = decodeCursor(req.params.cursor, ctx);
 * // state.offset and state.limit are safe to use directly
 */
export function decodeCursor(cursor: string, context: RequestContext): PaginationState {
  try {
    // Convert base64url back to standard base64, then decode cross-platform
    const standardBase64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const jsonString = base64ToString(standardBase64);
    const state = JSON.parse(jsonString) as PaginationState;

    // Validate required fields
    if (
      typeof state.offset !== 'number' ||
      typeof state.limit !== 'number' ||
      state.offset < 0 ||
      state.limit <= 0
    ) {
      throw new Error('Invalid pagination state structure');
    }

    return state;
  } catch (error: unknown) {
    logger.warning('Failed to decode pagination cursor', {
      ...context,
      cursor,
      error: error instanceof Error ? error.message : String(error),
    });
    throw invalidParams(
      'Invalid pagination cursor. The cursor may be expired, corrupted, or from a different request.',
      { cursor },
    );
  }
}

/**
 * Extracts the cursor parameter from an MCP request's params object.
 * Checks `params.cursor` first, then falls back to `params._meta.cursor`,
 * matching both locations where MCP clients may supply the cursor token.
 *
 * @param params - Optional request params object; may contain `cursor` at the top
 *   level or nested under `_meta`
 * @returns The cursor string if found in either location, `undefined` otherwise
 * @example
 * // Top-level cursor
 * extractCursor({ cursor: 'abc123' }); // => 'abc123'
 *
 * // Nested under _meta
 * extractCursor({ _meta: { cursor: 'abc123' } }); // => 'abc123'
 *
 * // No cursor present
 * extractCursor({}); // => undefined
 * extractCursor(undefined); // => undefined
 */
export function extractCursor(params?: {
  cursor?: string;
  _meta?: { cursor?: string };
}): string | undefined {
  return params?.cursor ?? params?._meta?.cursor;
}

/**
 * Paginates an in-memory array using opaque cursor-based pagination.
 * Decodes the cursor (if provided) to determine offset and limit, slices the array,
 * and returns a {@link PaginatedResult} with `nextCursor` set only when more items follow.
 * When `cursorStr` is `undefined`, pagination starts from the beginning using `defaultPageSize`.
 * When the decoded cursor's offset is beyond the array length, returns an empty items array.
 * The cursor's `limit` is clamped to `maxPageSize` even if the encoded value is larger.
 *
 * @param items - Complete array of items to paginate; not mutated
 * @param cursorStr - Opaque cursor token from the client, or `undefined` for the first page
 * @param defaultPageSize - Page size to use when no cursor is present; must be a positive integer
 * @param maxPageSize - Upper bound on items per page; cursor limit values are clamped to this
 * @param context - Request context used for logging when cursor decoding fails
 * @returns `PaginatedResult<T>` with the current page's items, `totalCount` set to `items.length`,
 *   and `nextCursor` included only if additional pages remain
 * @throws {McpError} With code `InvalidParams` (-32602) if `cursorStr` is present but invalid,
 *   propagated from {@link decodeCursor}
 * @example
 * const allItems = ['a', 'b', 'c', 'd', 'e'];
 *
 * // First page (no cursor)
 * const page1 = paginateArray(allItems, undefined, 2, 100, ctx);
 * // => { items: ['a', 'b'], nextCursor: '<opaque>', totalCount: 5 }
 *
 * // Second page (using cursor from page1)
 * const page2 = paginateArray(allItems, page1.nextCursor, 2, 100, ctx);
 * // => { items: ['c', 'd'], nextCursor: '<opaque>', totalCount: 5 }
 *
 * // Last page
 * const page3 = paginateArray(allItems, page2.nextCursor, 2, 100, ctx);
 * // => { items: ['e'], totalCount: 5 }  (no nextCursor)
 */
export function paginateArray<T>(
  items: T[],
  cursorStr: string | undefined,
  defaultPageSize: number,
  maxPageSize: number,
  context: RequestContext,
): PaginatedResult<T> {
  let offset = 0;
  let limit = defaultPageSize;

  // Decode cursor if provided
  if (cursorStr) {
    const state = decodeCursor(cursorStr, context);
    offset = state.offset;
    limit = Math.min(state.limit, maxPageSize); // Enforce max page size
  }

  // Validate bounds
  if (offset >= items.length) {
    return {
      items: [],
      totalCount: items.length,
    };
  }

  // Extract page
  const pageItems = items.slice(offset, offset + limit);
  const hasMore = offset + limit < items.length;

  // Build result, conditionally adding nextCursor only if it exists
  const result: PaginatedResult<T> = {
    items: pageItems,
    totalCount: items.length,
  };

  // Only add nextCursor if more results exist
  if (hasMore) {
    result.nextCursor = encodeCursor({ offset: offset + limit, limit });
  }

  return result;
}

/**
 * Default pagination configuration values used by {@link paginateArray} callers.
 * These serve as sensible defaults; individual call sites may pass different values
 * or defer to environment-variable-driven config parsed in the config module.
 *
 * @example
 * import { DEFAULT_PAGINATION_CONFIG, paginateArray } from '@/utils/pagination/pagination.js';
 * const result = paginateArray(
 *   items,
 *   cursorStr,
 *   DEFAULT_PAGINATION_CONFIG.DEFAULT_PAGE_SIZE,
 *   DEFAULT_PAGINATION_CONFIG.MAX_PAGE_SIZE,
 *   ctx,
 * );
 */
export const DEFAULT_PAGINATION_CONFIG = {
  /** Default number of items per page */
  DEFAULT_PAGE_SIZE: 50,
  /** Maximum allowed items per page */
  MAX_PAGE_SIZE: 1000,
  /** Minimum allowed items per page */
  MIN_PAGE_SIZE: 1,
} as const;

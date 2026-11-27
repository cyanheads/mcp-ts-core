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

import { internalError, invalidParams, JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { base64ToString, stringToBase64 } from '@/utils/internal/encoding.js';
import { logger } from '@/utils/internal/logger.js';
import { echoRejected } from '@/utils/internal/observabilityCap.js';
import { type RequestContext, withExtra } from '@/utils/internal/requestContext.js';

/**
 * Generic pagination state that can be encoded into a cursor.
 * Implementations can extend this with additional fields as needed.
 * This is the data structure serialized into the opaque cursor token.
 */
export interface PaginationState {
  /** Maximum number of items per page; a positive safe integer */
  limit: number;
  /** Zero-based index of the first item in the current page; a non-negative safe integer */
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
 * Whether `state` holds a position {@link decodeCursor} accepts: `offset` a
 * non-negative safe integer and `limit` a positive one. The encoder checks the
 * same predicate, so the framework never issues a cursor its decoder refuses.
 */
function isPaginationState(state: unknown): state is PaginationState {
  if (typeof state !== 'object' || state === null) return false;
  const { offset, limit } = state as { offset?: unknown; limit?: unknown };
  return (
    typeof offset === 'number' &&
    typeof limit === 'number' &&
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(limit) &&
    offset >= 0 &&
    limit > 0
  );
}

/**
 * Encodes pagination state into an opaque base64url cursor string.
 * Serializes `state` to JSON, then encodes as base64url (URL-safe, no padding).
 * The format is an implementation detail — callers must treat the returned string as opaque.
 *
 * @param state - Pagination state to encode; `offset` must be a non-negative safe
 *   integer and `limit` a positive safe integer, the values {@link decodeCursor} accepts
 * @returns Base64url-encoded cursor string (no `+`, `/`, or `=` characters)
 * @throws {McpError} With code `InternalError` (-32603) when `offset` or `limit` is
 *   outside those values (`data: { offset, limit }`), or when JSON serialization fails
 * @example
 * const cursor = encodeCursor({ offset: 50, limit: 25 });
 * // cursor is an opaque string like "eyJvZmZzZXQiOjUwLCJsaW1pdCI6MjV9"
 */
export function encodeCursor(state: PaginationState): string {
  const { offset, limit } = state;
  if (!isPaginationState(state)) {
    throw internalError(
      'Failed to encode pagination cursor: offset must be a non-negative safe integer and limit a positive safe integer.',
      { offset, limit },
    );
  }
  try {
    const jsonString = JSON.stringify(state);
    // Use cross-platform encoding, then convert standard base64 to base64url
    // `={1,2}$` rather than `=+$`: base64 padding is never longer than two
    // characters, and the unbounded quantifier is quadratic on a long run of
    // `=` (CodeQL `js/polynomial-redos`).
    const base64 = stringToBase64(jsonString)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/={1,2}$/, '');
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
 * `offset` must be a non-negative safe integer and `limit` a positive safe integer.
 * Logs a warning and throws `InvalidParams` on any failure, per MCP spec.
 *
 * @param cursor - Opaque cursor string previously returned by {@link encodeCursor}
 * @param context - Request context used to correlate warning log entries
 * @returns Validated `PaginationState` decoded from the cursor
 * @throws {McpError} With code `InvalidParams` (-32602) if the cursor is malformed,
 *   base64-invalid, not valid JSON, or has an invalid `offset`/`limit` structure.
 *   `data` carries the rejected `cursor` (past 50 characters, its first 50 and
 *   `...`, one fewer where the 50th would split a surrogate pair; the warning
 *   record carries the same), `reason: 'invalid_cursor'`, and
 *   a `recovery.hint` naming no output field, so a tool surfaces it like any
 *   other classified failure; `cursor` is declared in `literals`, so a tool's
 *   `content[]` renders it as code.
 * @example
 * const state = decodeCursor(req.params.cursor, ctx);
 * // state.offset and state.limit are safe to use directly
 */
export function decodeCursor(cursor: string, context: RequestContext): PaginationState {
  try {
    // Convert base64url back to standard base64, then decode cross-platform
    const standardBase64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const jsonString = base64ToString(standardBase64);
    const state: unknown = JSON.parse(jsonString);

    if (!isPaginationState(state)) {
      throw new Error('Invalid pagination state structure');
    }

    return state;
  } catch (error: unknown) {
    // Cut past 50 characters, as `validateKey` cuts a rejected storage key.
    const echoed = echoRejected(cursor);
    logger.warning(
      'Failed to decode pagination cursor',
      withExtra(context, {
        cursor: echoed,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw invalidParams(
      'Invalid pagination cursor. The cursor may be expired, corrupted, or from a different request.',
      {
        cursor: echoed,
        reason: 'invalid_cursor',
        recovery: {
          hint: 'Omit cursor to start from the first page, or pass the next-page cursor from the previous response unchanged.',
        },
      },
      { literals: ['cursor'] },
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
 * @param defaultPageSize - Page size to use when no cursor is present; must be a positive safe integer
 * @param maxPageSize - Upper bound on items per page; cursor limit values are clamped to this.
 *   Must be a positive safe integer
 * @param context - Request context used for logging when cursor decoding fails
 * @returns `PaginatedResult<T>` with the current page's items, `totalCount` set to `items.length`,
 *   and `nextCursor` included only if additional pages remain
 * @throws {McpError} With code `InvalidParams` (-32602) if `cursorStr` is present but invalid,
 *   propagated from {@link decodeCursor}
 * @throws {McpError} With code `InternalError` (-32603) when more items remain and the page
 *   size in effect is not a positive safe integer, propagated from {@link encodeCursor}
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

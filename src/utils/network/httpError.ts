/**
 * @fileoverview Helpers for converting HTTP `Response` objects into properly
 * classified `McpError` instances. Replaces the hand-rolled status → code ladder
 * that consumer servers tend to write (and get wrong, especially for 401/403/408).
 * @module src/utils/network/httpError
 */

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

/**
 * Maps an HTTP status code to a `JsonRpcErrorCode`. Covers the full client/server
 * 4xx/5xx range, with specific mappings for the codes most upstream APIs use to
 * signal authoritative outcomes (auth failures, conflicts, validation, rate limits).
 *
 * Returns `undefined` when the status is in the 1xx/2xx/3xx range — those are not
 * errors and the caller should not be invoking error mapping on them.
 *
 * | Status | Code |
 * |:-------|:-----|
 * | 400 | `InvalidParams` |
 * | 401 | `Unauthorized` |
 * | 402 | `Forbidden` (payment-required, treated as access denial) |
 * | 403 | `Forbidden` |
 * | 404 | `NotFound` |
 * | 405, 406, 410, 415 | `InvalidRequest` |
 * | 408 | `Timeout` |
 * | 409 | `Conflict` |
 * | 412, 416, 417 | `InvalidRequest` |
 * | 422 | `ValidationError` |
 * | 423, 424 | `Conflict` |
 * | 425 | `Timeout` |
 * | 428 | `InvalidRequest` |
 * | 429 | `RateLimited` |
 * | 431, 451 | `InvalidRequest` |
 * | 4xx (other) | `InvalidRequest` |
 * | 500, 501 | `InternalError` |
 * | 502, 503 | `ServiceUnavailable` |
 * | 504 | `Timeout` |
 * | 5xx (other) | `ServiceUnavailable` |
 */
export function httpStatusToErrorCode(status: number): JsonRpcErrorCode | undefined {
  if (status < 400) return;

  switch (status) {
    case 400:
      return JsonRpcErrorCode.InvalidParams;
    case 401:
      return JsonRpcErrorCode.Unauthorized;
    case 402:
    case 403:
      return JsonRpcErrorCode.Forbidden;
    case 404:
      return JsonRpcErrorCode.NotFound;
    case 408:
      return JsonRpcErrorCode.Timeout;
    case 409:
      return JsonRpcErrorCode.Conflict;
    case 422:
      return JsonRpcErrorCode.ValidationError;
    case 423:
    case 424:
      return JsonRpcErrorCode.Conflict;
    case 425:
      return JsonRpcErrorCode.Timeout;
    case 429:
      return JsonRpcErrorCode.RateLimited;
    case 500:
    case 501:
      return JsonRpcErrorCode.InternalError;
    case 502:
    case 503:
      return JsonRpcErrorCode.ServiceUnavailable;
    case 504:
      return JsonRpcErrorCode.Timeout;
    default:
      return status >= 500 ? JsonRpcErrorCode.ServiceUnavailable : JsonRpcErrorCode.InvalidRequest;
  }
}

/** Configuration for {@link httpErrorFromResponse}. */
export interface HttpErrorFromResponseOptions {
  /**
   * Maximum number of bytes captured from the response body when `captureBody`
   * is enabled. Larger bodies are truncated. Default: `500`.
   */
  bodyLimit?: number;
  /**
   * Read the response body and include it (truncated) in `error.data.body`.
   * Default: `true`. Set `false` if the body has already been consumed elsewhere
   * or for binary responses where text capture is not useful.
   */
  captureBody?: boolean;
  /**
   * Underlying cause for the `cause` chain. Useful when wrapping a fetch error
   * that already has its own context.
   */
  cause?: unknown;
  /**
   * Override the default status → code mapping for specific cases. Return
   * `undefined` to fall through to the default mapping.
   */
  codeOverride?: (status: number) => JsonRpcErrorCode | undefined;
  /**
   * Additional fields merged into `error.data`. Always includes
   * `{ url, status, statusText, body? }` from the response itself, plus the
   * legacy aliases `statusCode` (= `status`) and `responseBody` (= `body`) for
   * consumers reading `fetchWithTimeout`'s shape — slated for consolidation in a
   * future major. Fields passed here override the defaults on key collision.
   */
  data?: Record<string, unknown>;
  /**
   * Logical service name included in the error message
   * (e.g., `'NCBI'` → `"NCBI returned HTTP 429"`). When omitted, the message
   * uses the response URL host.
   */
  service?: string;
}

const DEFAULT_BODY_LIMIT = 500;

/**
 * Builds an `McpError` from an HTTP `Response`, with status-aware classification
 * and optional body capture.
 *
 * Reads the response body (consuming it) when `captureBody` is true, so callers
 * must `response.clone()` first if they intend to read the body elsewhere.
 *
 * Always returns an `McpError` even for 1xx/2xx/3xx — the caller is expected to
 * have verified `!response.ok` first, but the helper falls back to a sensible
 * code (`InternalError`) instead of silently producing nothing.
 *
 * @example
 * ```ts
 * const response = await fetch(url);
 * if (!response.ok) {
 *   throw await httpErrorFromResponse(response, {
 *     service: 'NCBI',
 *     data: { endpoint: 'esearch' },
 *   });
 * }
 * ```
 *
 * @example Wrapping a network failure
 * ```ts
 * try {
 *   const response = await fetch(url);
 *   if (!response.ok) {
 *     throw await httpErrorFromResponse(response, { service: 'NCBI' });
 *   }
 *   return await response.text();
 * } catch (error) {
 *   if (error instanceof McpError) throw error;
 *   throw new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI request failed', { url }, { cause: error });
 * }
 * ```
 */
export async function httpErrorFromResponse(
  response: Response,
  options: HttpErrorFromResponseOptions = {},
): Promise<McpError> {
  const {
    captureBody = true,
    bodyLimit = DEFAULT_BODY_LIMIT,
    service,
    data: extraData,
    cause,
    codeOverride,
  } = options;

  const code =
    codeOverride?.(response.status) ??
    httpStatusToErrorCode(response.status) ??
    JsonRpcErrorCode.InternalError;

  const subject = service ?? safeHost(response.url) ?? 'Upstream';
  const statusText = response.statusText ? ` ${response.statusText}` : '';

  let body: string | undefined;
  if (captureBody) {
    try {
      const raw = await response.text();
      body = raw.length > bodyLimit ? `${raw.slice(0, bodyLimit)}…` : raw;
    } catch {
      /* body unreadable (already consumed, network error mid-stream) */
    }
  }

  const retryAfter = response.headers.get('retry-after') ?? undefined;

  const data: Record<string, unknown> = {
    url: response.url || undefined,
    // Canonical (Fetch `Response`-aligned) field names.
    status: response.status,
    statusText: response.statusText || undefined,
    ...(body !== undefined && { body }),
    // Legacy aliases — mirror fetchWithTimeout's original shape so a consumer can
    // classify either helper's error without knowing which raised it; slated for
    // consolidation onto `status`/`body` in a future major.
    statusCode: response.status,
    ...(body !== undefined && { responseBody: body }),
    ...(retryAfter !== undefined && { retryAfter }),
    ...extraData,
  };

  return new McpError(
    code,
    `${subject} returned HTTP ${response.status}${statusText}.`,
    data,
    cause !== undefined ? { cause } : undefined,
  );
}

/** Returns the hostname from a URL string, or `undefined` if it can't be parsed. */
function safeHost(url: string): string | undefined {
  if (!url) return;
  try {
    return new URL(url).host;
  } catch {
    return;
  }
}

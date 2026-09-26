/**
 * @fileoverview Shared error classification constants used by the error handler.
 * Enhanced with regex caching for performance and provider-specific error patterns.
 * @module src/utils/internal/error-handler/mappings
 */

import { JsonRpcErrorCode } from '@/types-global/errors.js';
import type { BaseErrorMapping } from './types.js';

/**
 * Compiled regex cache for performance optimization.
 * Prevents repeated regex compilation on every error classification.
 * @private
 */
const COMPILED_PATTERN_CACHE = new Map<string, RegExp>();

/**
 * Compiles and caches a regex pattern for repeated use without re-compilation overhead.
 *
 * - String patterns are compiled with the `i` (case-insensitive) flag.
 * - `RegExp` patterns are re-compiled without the `g` flag (global flag is removed to prevent
 *   stateful `lastIndex` bugs when the same pattern is reused across multiple `.test()` calls)
 *   and with `i` added if absent.
 * - Cache key for `RegExp` inputs is `source + flags`; for strings it is the string itself.
 *
 * @param pattern - A string or `RegExp` to compile and cache.
 * @returns The compiled, cached `RegExp` instance.
 *
 * @example
 * ```ts
 * const re = getCompiledPattern('not found');
 * re.test('Resource not found'); // → true
 *
 * const re2 = getCompiledPattern(/ThrottlingException/i);
 * re2.test('ThrottlingException: rate exceeded'); // → true
 * ```
 */
export function getCompiledPattern(pattern: string | RegExp): RegExp {
  // Create a stable cache key
  const cacheKey = pattern instanceof RegExp ? pattern.source + pattern.flags : pattern;

  // Return cached pattern if available
  if (COMPILED_PATTERN_CACHE.has(cacheKey)) {
    return COMPILED_PATTERN_CACHE.get(cacheKey) as RegExp;
  }

  // Compile new pattern
  let compiled: RegExp;
  if (pattern instanceof RegExp) {
    // Remove global flag, ensure case-insensitive
    let flags = pattern.flags.replace('g', '');
    if (!flags.includes('i')) {
      flags += 'i';
    }
    compiled = new RegExp(pattern.source, flags);
  } else {
    compiled = new RegExp(pattern, 'i');
  }

  // Cache for future use
  COMPILED_PATTERN_CACHE.set(cacheKey, compiled);
  return compiled;
}

/**
 * Extended error mapping interface that includes pre-compiled regex pattern.
 * @private
 */
interface CompiledErrorMapping extends BaseErrorMapping {
  /** Pre-compiled regex pattern for efficient matching */
  compiledPattern: RegExp;
}

/**
 * Maps standard JavaScript error constructor names to `JsonRpcErrorCode` values.
 *
 * Consulted by `ErrorHandler.determineErrorCode` as the first pattern-match step after
 * checking for `McpError` instances. Constructor names are matched via `getErrorName()`.
 *
 * | Constructor | Mapped Code |
 * |-------------|-------------|
 * | `SyntaxError` | `ValidationError` |
 * | `RangeError` | `ValidationError` (except an engine resource limit — see below) |
 * | `URIError` | `ValidationError` |
 * | `ReferenceError` | `InternalError` |
 * | `EvalError` | `InternalError` |
 * | `AggregateError` | `InternalError` |
 * | `ZodError` | `ValidationError` |
 *
 * Note: `TypeError` is intentionally excluded. Runtime TypeErrors (e.g. "Cannot read
 * properties of undefined") are programming errors, not validation failures. Letting them
 * fall through to message-pattern matching or the `InternalError` fallback is more accurate.
 *
 * A `RangeError` whose whole message is in {@link ENGINE_RESOURCE_LIMIT_MESSAGES} never
 * reaches this table: `determineErrorCode` maps it to `InternalError` first (#482).
 *
 * @example
 * ```ts
 * ERROR_TYPE_MAPPINGS['SyntaxError']; // → JsonRpcErrorCode.ValidationError
 * ```
 */
export const ERROR_TYPE_MAPPINGS: Readonly<Record<string, JsonRpcErrorCode>> = {
  SyntaxError: JsonRpcErrorCode.ValidationError,
  ReferenceError: JsonRpcErrorCode.InternalError,
  RangeError: JsonRpcErrorCode.ValidationError,
  URIError: JsonRpcErrorCode.ValidationError,
  EvalError: JsonRpcErrorCode.InternalError,
  AggregateError: JsonRpcErrorCode.InternalError,
  ZodError: JsonRpcErrorCode.ValidationError,
};

/**
 * The whole messages V8 and JavaScriptCore give the `RangeError` they raise when the
 * engine itself runs out of a resource: the call stack (JavaScriptCore adds a trailing
 * period) and the maximum string size (V8's `Invalid string length`, JavaScriptCore's
 * `Out of memory`).
 *
 * `ErrorHandler.determineErrorCode` maps a `RangeError` carrying one of these to
 * `InternalError` ahead of {@link ERROR_TYPE_MAPPINGS}: it names nothing a caller can
 * change, so it is a server fault, not the `ValidationError` every other `RangeError` is
 * (#482). Matched by whole message, so a `RangeError` that merely mentions one keeps
 * `ValidationError`.
 */
export const ENGINE_RESOURCE_LIMIT_MESSAGES: ReadonlySet<string> = new Set([
  'Maximum call stack size exceeded',
  'Maximum call stack size exceeded.',
  'Invalid string length',
  'Out of memory',
]);

/**
 * Common error patterns for classifying errors by message/name.
 * Order matters: more specific patterns should precede generic ones.
 * @private — only consumed via COMPILED_ERROR_PATTERNS
 */
const COMMON_ERROR_PATTERNS: ReadonlyArray<Readonly<BaseErrorMapping>> = [
  {
    pattern:
      /unauthorized|unauthenticated|not\s+authorized|not.*logged.*in|invalid[\s_-]+token|expired[\s_-]+token/i,
    errorCode: JsonRpcErrorCode.Unauthorized,
  },
  {
    pattern: /permission|forbidden|access.*denied|not.*allowed/i,
    errorCode: JsonRpcErrorCode.Forbidden,
  },
  {
    pattern: /not found|no such|doesn't exist|couldn't find/i,
    errorCode: JsonRpcErrorCode.NotFound,
  },
  {
    pattern:
      /invalid|validation|malformed|bad request|wrong format|missing\s+(?:required|param|field|input|value|arg)/i,
    errorCode: JsonRpcErrorCode.ValidationError,
  },
  {
    pattern: /conflict|already exists|duplicate|unique constraint/i,
    errorCode: JsonRpcErrorCode.Conflict,
  },
  {
    pattern: /rate limit|too many requests|throttled/i,
    errorCode: JsonRpcErrorCode.RateLimited,
  },
  {
    pattern: /timeout|timed out|deadline exceeded/i,
    errorCode: JsonRpcErrorCode.Timeout,
  },
  {
    pattern: /abort(ed)?|cancell?ed/i,
    errorCode: JsonRpcErrorCode.Timeout,
  },
  {
    pattern: /service unavailable|bad gateway|gateway timeout|upstream error/i,
    errorCode: JsonRpcErrorCode.ServiceUnavailable,
  },
  {
    pattern: /zod|zoderror|schema validation/i,
    errorCode: JsonRpcErrorCode.ValidationError,
  },
];

/**
 * Pre-compiled common error patterns used by `ErrorHandler.determineErrorCode`.
 *
 * Derived from `COMMON_ERROR_PATTERNS` — each entry has its `pattern` compiled via
 * `getCompiledPattern` at module initialization. Checked after `COMPILED_PROVIDER_PATTERNS`
 * (provider patterns are more specific and take priority).
 *
 * Patterns cover: auth/unauthorized, forbidden, not-found, validation, conflict,
 * rate-limit, timeout/abort, service-unavailable, and Zod schema errors.
 */
export const COMPILED_ERROR_PATTERNS: ReadonlyArray<Readonly<CompiledErrorMapping>> =
  COMMON_ERROR_PATTERNS.map((mapping) => ({
    ...mapping,
    compiledPattern: getCompiledPattern(mapping.pattern),
  }));

/**
 * Provider-specific error patterns for external service integration.
 * Covers common error formats from AWS, HTTP status codes, databases, and LLM providers.
 * @private — only consumed via COMPILED_PROVIDER_PATTERNS
 */
const PROVIDER_ERROR_PATTERNS: ReadonlyArray<Readonly<BaseErrorMapping>> = [
  // AWS Service Errors
  {
    pattern: /ThrottlingException|TooManyRequestsException/i,
    errorCode: JsonRpcErrorCode.RateLimited,
  },
  {
    pattern: /AccessDenied|UnauthorizedOperation/i,
    errorCode: JsonRpcErrorCode.Forbidden,
  },
  {
    pattern: /ResourceNotFoundException/i,
    errorCode: JsonRpcErrorCode.NotFound,
  },

  // HTTP Status-based errors
  { pattern: /status code 401/i, errorCode: JsonRpcErrorCode.Unauthorized },
  { pattern: /status code 403/i, errorCode: JsonRpcErrorCode.Forbidden },
  { pattern: /status code 404/i, errorCode: JsonRpcErrorCode.NotFound },
  { pattern: /status code 409/i, errorCode: JsonRpcErrorCode.Conflict },
  { pattern: /status code 429/i, errorCode: JsonRpcErrorCode.RateLimited },
  {
    pattern: /status code 5\d\d/i,
    errorCode: JsonRpcErrorCode.ServiceUnavailable,
  },

  // Database connection and constraint errors
  {
    pattern: /ECONNREFUSED|connection refused/i,
    errorCode: JsonRpcErrorCode.ServiceUnavailable,
  },
  {
    pattern: /ETIMEDOUT|connection timeout/i,
    errorCode: JsonRpcErrorCode.Timeout,
  },
  {
    pattern: /unique constraint|duplicate key/i,
    errorCode: JsonRpcErrorCode.Conflict,
  },
  {
    pattern: /foreign key constraint/i,
    errorCode: JsonRpcErrorCode.ValidationError,
  },

  // Supabase-specific errors
  { pattern: /JWT expired/i, errorCode: JsonRpcErrorCode.Unauthorized },
  {
    pattern: /row level security/i,
    errorCode: JsonRpcErrorCode.Forbidden,
  },

  // OpenRouter/LLM provider errors
  {
    pattern: /insufficient_quota|quota exceeded/i,
    errorCode: JsonRpcErrorCode.RateLimited,
  },
  { pattern: /model_not_found/i, errorCode: JsonRpcErrorCode.NotFound },
  {
    pattern: /context_length_exceeded/i,
    errorCode: JsonRpcErrorCode.ValidationError,
  },

  // Network errors
  { pattern: /ENOTFOUND|DNS/i, errorCode: JsonRpcErrorCode.ServiceUnavailable },
  {
    pattern: /ECONNRESET|connection reset/i,
    errorCode: JsonRpcErrorCode.ServiceUnavailable,
  },
];

/**
 * Pre-compiled provider-specific error patterns used by `ErrorHandler.determineErrorCode`.
 *
 * Derived from `PROVIDER_ERROR_PATTERNS` — each entry has its `pattern` compiled via
 * `getCompiledPattern` at module initialization. Checked before `COMPILED_ERROR_PATTERNS`
 * because provider patterns are more specific (e.g. `status code 429` is more precise than
 * the generic `rate limit` common pattern).
 *
 * Covers: AWS service errors, HTTP status codes (401/403/404/409/429/5xx),
 * database connection/constraint errors, Supabase JWT/RLS, OpenRouter/LLM quota errors,
 * and low-level network errors (ECONNREFUSED, ECONNRESET, ENOTFOUND, ETIMEDOUT).
 */
export const COMPILED_PROVIDER_PATTERNS: ReadonlyArray<Readonly<CompiledErrorMapping>> =
  PROVIDER_ERROR_PATTERNS.map((mapping) => ({
    ...mapping,
    compiledPattern: getCompiledPattern(mapping.pattern),
  }));

// ============================================================================
// Error categories
// ============================================================================

/** Broad error category derived from a classified JSON-RPC error code. */
export type ErrorCategory = 'upstream' | 'server' | 'client';

const UPSTREAM_CODES: ReadonlySet<JsonRpcErrorCode> = new Set([
  JsonRpcErrorCode.ServiceUnavailable,
  JsonRpcErrorCode.RateLimited,
  JsonRpcErrorCode.Timeout,
]);

const SERVER_CODES: ReadonlySet<JsonRpcErrorCode> = new Set([
  JsonRpcErrorCode.InternalError,
  JsonRpcErrorCode.UnknownError,
  JsonRpcErrorCode.DatabaseError,
  JsonRpcErrorCode.ConfigurationError,
  JsonRpcErrorCode.InitializationFailed,
  JsonRpcErrorCode.SerializationError,
]);

/**
 * `data.reason` on the canvas tenant-cap refusal thrown by
 * `CanvasRegistry.enforceTenantCap`. Declared here because this module is what
 * reads it; the registry imports it so the two spellings cannot drift.
 */
export const CANVAS_CAPACITY_EXHAUSTED_REASON = 'canvas_capacity_exhausted';

/**
 * Maps a classified JSON-RPC error code to a broad error category.
 *
 * - `upstream` — external API failures: service unavailable, rate-limited, timeout.
 * - `server` — internal bugs or infrastructure issues.
 * - `client` — bad input, auth failures, not-found: problems with the request itself.
 *
 * `data` refines the one code that legitimately carries two sources: `-32003`
 * is upstream throttling everywhere except the canvas tenant cap, which is a
 * decision this process made about its own resources (#275). Retry semantics
 * and the HTTP 429 mapping are right for both, so the code stays put and the
 * stable `data.reason` discriminator separates the buckets. Called with the
 * code alone, resolution is exactly what it was.
 */
export function getErrorCategory(
  code: JsonRpcErrorCode,
  data?: Record<string, unknown>,
): ErrorCategory {
  // The one local-capacity reason carried on `-32003`; everything else under
  // that code is upstream throttling.
  if (code === JsonRpcErrorCode.RateLimited && data?.reason === CANVAS_CAPACITY_EXHAUSTED_REASON) {
    return 'server';
  }
  if (UPSTREAM_CODES.has(code)) return 'upstream';
  if (SERVER_CODES.has(code)) return 'server';
  return 'client';
}

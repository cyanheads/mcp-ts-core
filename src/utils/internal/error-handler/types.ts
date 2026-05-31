/**
 * @fileoverview Shared type definitions for the error handler utilities.
 * @module src/utils/internal/error-handler/types
 */

import type { JsonRpcErrorCode } from '@/types-global/errors.js';

/**
 * Arbitrary key-value context attached to an error for logging and tracing.
 *
 * Passed as `options.context` to `ErrorHandler.handleError`. All entries are merged
 * into the structured log record. `requestId` and `timestamp` receive special treatment:
 * if present and valid they are used directly; otherwise they are generated automatically.
 *
 * @example
 * ```ts
 * const ctx: ErrorContext = {
 *   requestId: 'req-abc123',
 *   userId: 'usr-456',
 *   resource: '/api/users',
 * };
 * ErrorHandler.handleError(err, { operation: 'getUser', context: ctx });
 * ```
 */
export interface ErrorContext {
  /**
   * A unique identifier for the request or operation during which the error occurred.
   * Used directly in log output if provided; auto-generated via `generateUUID` if absent.
   */
  requestId?: string;

  /**
   * Allows for arbitrary additional context information.
   * Keys are strings, and values can be of any type.
   */
  // allow open-indexed-named: documented arbitrary additional context
  [key: string]: unknown;
}

/**
 * Configuration options for `ErrorHandler.handleError` and `ErrorHandler.tryCatch`.
 *
 * Controls error transformation, log output, and whether the error propagates to the caller.
 *
 * @example
 * ```ts
 * const opts: ErrorHandlerOptions = {
 *   operation: 'fetchArticle',
 *   context: { requestId: 'req-123', articleId: 'art-456' },
 *   input: { id: 'art-456' },
 *   rethrow: true,
 *   critical: false,
 * };
 * ErrorHandler.handleError(err, opts);
 * ```
 */
export interface ErrorHandlerOptions {
  /**
   * The context of the operation that caused the error.
   * This can include `requestId` and other relevant debugging information.
   */
  context?: ErrorContext;

  /**
   * If true, indicates that the error is critical and might require immediate attention
   * or could lead to system instability. This is primarily for logging and alerting.
   * Defaults to `false`.
   */
  critical?: boolean;

  /**
   * A specific `JsonRpcErrorCode` to assign to the error, overriding any
   * automatically determined error code.
   */
  errorCode?: JsonRpcErrorCode;

  /**
   * A custom function to map or transform the original error into a new `Error` instance.
   * If provided, this function is used instead of the default `McpError` creation.
   * @param error - The original error that occurred.
   * @returns The transformed error.
   */
  errorMapper?: (error: unknown) => Error;

  /**
   * If true, stack traces will be included in the logs.
   * Defaults to `true`.
   */
  includeStack?: boolean;

  /**
   * The input data or parameters that were being processed when the error occurred.
   * This input will be sanitized before logging to prevent sensitive data exposure.
   */
  input?: unknown;

  /**
   * A descriptive name of the operation being performed when the error occurred.
   * This helps in identifying the source or nature of the error in logs.
   * Example: "UserLogin", "ProcessPayment", "FetchUserProfile".
   */
  operation: string;

  /**
   * If true, the (potentially transformed) error will be rethrown after handling.
   * Defaults to `false`.
   */
  rethrow?: boolean;
}

/**
 * A basic rule that classifies an error by matching its message or name against a pattern.
 *
 * Used as the element type for `COMMON_ERROR_PATTERNS` and `PROVIDER_ERROR_PATTERNS`, and
 * as the base for the higher-level `ErrorMapping<T>` interface (which adds a `factory`).
 *
 * @example
 * ```ts
 * const rule: BaseErrorMapping = {
 *   pattern: /not found/i,
 *   errorCode: JsonRpcErrorCode.NotFound,
 * };
 * ```
 */
export interface BaseErrorMapping {
  /**
   * The `JsonRpcErrorCode` to assign if the pattern matches.
   */
  errorCode: JsonRpcErrorCode;

  /**
   * An optional custom message template for the mapped error.
   */
  messageTemplate?: string;

  /**
   * A string or regular expression to match against the error message.
   * If a string is provided, it's used for substring matching (case-insensitive).
   */
  pattern: string | RegExp;
}

/**
 * A pattern-based rule used by `ErrorHandler.mapError` to transform errors into a specific type `T`.
 *
 * Extends `BaseErrorMapping` with a `factory` that constructs the target error and an optional
 * `additionalContext` object passed to that factory. Rules are tested in order; the first match wins.
 *
 * @template T The concrete `Error` subtype this mapping produces. Defaults to `Error`.
 *
 * @example
 * ```ts
 * const rule: ErrorMapping<McpError> = {
 *   pattern: /connection refused/i,
 *   errorCode: JsonRpcErrorCode.ServiceUnavailable,
 *   additionalContext: { service: 'database' },
 *   factory: (e, ctx) =>
 *     new McpError(JsonRpcErrorCode.ServiceUnavailable, getErrorMessage(e), ctx),
 * };
 * ```
 */
export interface ErrorMapping<T extends Error = Error> extends BaseErrorMapping {
  /**
   * Additional static context to be merged or passed to the `factory` function
   * when this mapping rule is applied.
   */
  additionalContext?: Record<string, unknown>;

  /**
   * A factory function that creates and returns an instance of the mapped error type `T`.
   * @param error - The original error that occurred.
   * @param context - Optional additional context provided in the mapping rule.
   * @returns The newly created error instance.
   */
  factory: (error: unknown, context?: Record<string, unknown>) => T;
}

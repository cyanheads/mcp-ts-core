/**
 * @fileoverview Main ErrorHandler implementation with logging and telemetry integration.
 * Provides error classification, formatting, and consistent error handling patterns.
 * @module src/utils/internal/error-handler/errorHandler
 */

import { SpanStatusCode, trace } from '@opentelemetry/api';
import { ZodError } from 'zod';

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { generateUUID } from '@/utils/security/idGenerator.js';
import { sanitizeInputForLogging } from '@/utils/security/sanitization.js';
import { ATTR_MCP_ERROR_CLASSIFIED_CODE } from '@/utils/telemetry/attributes.js';
import { createCounter } from '@/utils/telemetry/metrics.js';
import { extractErrorCauseChain, getErrorMessage, getErrorName } from './helpers.js';
import {
  COMPILED_ERROR_PATTERNS,
  COMPILED_PROVIDER_PATTERNS,
  ERROR_TYPE_MAPPINGS,
  getCompiledPattern,
} from './mappings.js';
import type { ErrorHandlerOptions, ErrorMapping } from './types.js';

let errorClassifiedCounter: ReturnType<typeof createCounter> | undefined;

function getErrorMetrics() {
  errorClassifiedCounter ??= createCounter(
    'mcp.errors.classified',
    'Total errors classified by JSON-RPC error code',
    '{errors}',
  );
  return { errorClassifiedCounter };
}

/** Eagerly creates the error classification counter so the series exists from startup. */
export function initErrorMetrics(): void {
  getErrorMetrics();
}

/**
 * A utility class providing static methods for comprehensive error handling.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: public API surface — preserving class for namespace semantics
export class ErrorHandler {
  /**
   * Determines an appropriate `JsonRpcErrorCode` for a given error.
   *
   * Resolution order:
   * 1. `McpError` instances — returns `error.code` directly.
   * 2. Standard JS error constructor names via `ERROR_TYPE_MAPPINGS` (e.g. `TypeError` → `ValidationError`).
   * 3. Provider-specific patterns (AWS, HTTP status codes, Supabase, OpenRouter) — checked before common patterns for specificity.
   * 4. Common message/name patterns (auth, not-found, rate-limit, etc.).
   * 5. `AbortError` name — mapped to `Timeout`.
   * 6. Falls back to `JsonRpcErrorCode.InternalError`.
   *
   * @param error - The error instance or value to classify.
   * @returns The most specific `JsonRpcErrorCode` that fits the error.
   *
   * @example
   * ```ts
   * ErrorHandler.determineErrorCode(new McpError(JsonRpcErrorCode.NotFound, 'missing'));
   * // → JsonRpcErrorCode.NotFound
   *
   * ErrorHandler.determineErrorCode(new TypeError('Cannot read properties of undefined'));
   * // → JsonRpcErrorCode.InternalError (falls through to default)
   *
   * ErrorHandler.determineErrorCode(new Error('status code 429'));
   * // → JsonRpcErrorCode.RateLimited
   * ```
   */
  public static determineErrorCode(error: unknown): JsonRpcErrorCode {
    if (error instanceof McpError) {
      return error.code;
    }

    const errorName = getErrorName(error);
    const errorMessage = getErrorMessage(error);

    // Check against standard JavaScript error types
    const mappedFromType = (ERROR_TYPE_MAPPINGS as Record<string, JsonRpcErrorCode>)[errorName];
    if (mappedFromType) {
      return mappedFromType;
    }

    // Check provider-specific patterns first (more specific)
    for (const mapping of COMPILED_PROVIDER_PATTERNS) {
      if (mapping.compiledPattern.test(errorMessage) || mapping.compiledPattern.test(errorName)) {
        return mapping.errorCode;
      }
    }

    // Then check common error patterns (using pre-compiled patterns for performance)
    for (const mapping of COMPILED_ERROR_PATTERNS) {
      if (mapping.compiledPattern.test(errorMessage) || mapping.compiledPattern.test(errorName)) {
        return mapping.errorCode;
      }
    }
    // Special-case common platform errors
    if (
      typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      (error as { name?: string }).name === 'AbortError'
    ) {
      return JsonRpcErrorCode.Timeout;
    }
    return JsonRpcErrorCode.InternalError;
  }

  /**
   * Handles an error with consistent logging, OpenTelemetry integration, and optional transformation.
   *
   * Steps performed:
   * 1. Records the exception on the active OTel span and sets span status to ERROR.
   * 2. Sanitizes `options.input` via `sanitizeInputForLogging` before including in logs.
   * 3. Extracts and consolidates error data, original stack, and the full cause chain.
   * 4. Wraps non-`McpError` errors in a new `McpError` (or delegates to `options.errorMapper`).
   * 5. Logs the result at `error` level via the global logger with full structured context.
   * 6. Returns the processed error, or rethrows it if `options.rethrow` is `true`.
   *
   * @param error - The error instance or value that occurred.
   * @param options - Configuration controlling transformation, logging, and rethrow behavior.
   * @returns The processed `Error` instance (a `McpError` unless `errorMapper` returns something else).
   *
   * @example
   * ```ts
   * // Log and return without rethrowing
   * const handled = ErrorHandler.handleError(err, { operation: 'fetchUser', context: { requestId } });
   *
   * // Log and rethrow
   * ErrorHandler.handleError(err, { operation: 'fetchUser', rethrow: true });
   *
   * // Custom error transformation
   * ErrorHandler.handleError(err, {
   *   operation: 'fetchUser',
   *   errorMapper: (e) => new MyDomainError(getErrorMessage(e)),
   * });
   * ```
   */
  public static handleError(error: unknown, options: ErrorHandlerOptions): Error {
    // --- OpenTelemetry Integration ---
    // Skip ended/no-op spans — measure*Execution paths already record + end the span before re-throwing.
    const activeSpan = trace.getActiveSpan();
    if (activeSpan?.isRecording()) {
      if (error instanceof Error) {
        activeSpan.recordException(error);
      }
      activeSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    // --- End OpenTelemetry Integration ---

    const {
      context = {},
      operation,
      input,
      rethrow = false,
      errorCode: explicitErrorCode,
      includeStack = true,
      critical = false,
      errorMapper,
    } = options;

    const sanitizedInput = input !== undefined ? sanitizeInputForLogging(input) : undefined;
    const originalErrorName = getErrorName(error);
    const originalErrorMessage = getErrorMessage(error);
    const originalStack = error instanceof Error ? error.stack : undefined;

    let finalError: Error;
    let loggedErrorCode: JsonRpcErrorCode;

    const errorDataSeed =
      error instanceof McpError && typeof error.data === 'object' && error.data !== null
        ? { ...error.data }
        : {};

    const consolidatedData: Record<string, unknown> = {
      ...errorDataSeed,
      ...context,
      originalErrorName,
      originalMessage: originalErrorMessage,
    };
    if (originalStack && !(error instanceof McpError && error.data?.originalStack)) {
      consolidatedData.originalStack = originalStack;
    }

    const cause = error instanceof Error ? error : undefined;

    // Extract cause chain only when the error actually has a cause
    if (error instanceof Error && error.cause) {
      const causeChain = extractErrorCauseChain(error);
      if (causeChain.length > 0) {
        const rootCause = causeChain[causeChain.length - 1];
        if (rootCause) {
          consolidatedData.rootCause = {
            name: rootCause.name,
            message: rootCause.message,
          };
        }
        consolidatedData.causeChain = causeChain;
      }
    }

    if (error instanceof McpError) {
      loggedErrorCode = error.code;
      finalError = errorMapper
        ? errorMapper(error)
        : new McpError(error.code, error.message, consolidatedData, {
            cause,
          });
    } else {
      loggedErrorCode = explicitErrorCode || ErrorHandler.determineErrorCode(error);
      finalError = errorMapper
        ? errorMapper(error)
        : new McpError(loggedErrorCode, originalErrorMessage, consolidatedData, {
            cause,
          });
    }

    // Record error classification metric
    getErrorMetrics().errorClassifiedCounter.add(1, {
      [ATTR_MCP_ERROR_CLASSIFIED_CODE]: String(loggedErrorCode),
      operation,
    });

    if (
      finalError !== error &&
      error instanceof Error &&
      finalError instanceof Error &&
      !finalError.stack &&
      error.stack
    ) {
      finalError.stack = error.stack;
    }

    const logRequestId =
      typeof context.requestId === 'string' && context.requestId
        ? context.requestId
        : generateUUID();

    const logTimestamp =
      typeof context.timestamp === 'string' && context.timestamp
        ? context.timestamp
        : new Date().toISOString();

    const stack = finalError instanceof Error ? finalError.stack : originalStack;
    const logContext: RequestContext = {
      requestId: logRequestId,
      timestamp: logTimestamp,
      operation,
      input: sanitizedInput,
      critical,
      errorCode: loggedErrorCode,
      originalErrorType: originalErrorName,
      finalErrorType: getErrorName(finalError),
      ...Object.fromEntries(
        Object.entries(context).filter(([key]) => key !== 'requestId' && key !== 'timestamp'),
      ),
      errorData:
        finalError instanceof McpError && finalError.data ? finalError.data : consolidatedData,
      ...(includeStack && stack ? { stack } : {}),
    };

    logger.error(
      `Error in ${operation}: ${finalError.message || originalErrorMessage}`,
      logContext,
    );

    if (rethrow) {
      throw finalError;
    }
    return finalError;
  }

  /**
   * Classifies an error and returns its JSON-RPC error code and message without
   * logging, OTel side effects, or error wrapping. Use this when you need error
   * classification but the caller handles logging/rethrowing (e.g., resource
   * handler factory where the SDK logs the re-thrown error).
   *
   * @param error - The error instance or value to classify.
   * @returns `{ code, message, data? }` — the classified error code, a human-readable
   *          message, and optional structured data (populated for `ZodError` with
   *          the full `issues` array so clients can render field-level errors).
   */
  public static classifyOnly(error: unknown): {
    code: JsonRpcErrorCode;
    message: string;
    data?: Record<string, unknown>;
  } {
    if (error instanceof McpError) {
      return { code: error.code, message: error.message };
    }
    if (error instanceof ZodError) {
      return {
        code: JsonRpcErrorCode.ValidationError,
        message: getErrorMessage(error),
        data: { issues: error.issues },
      };
    }
    return {
      code: ErrorHandler.determineErrorCode(error),
      message: getErrorMessage(error),
    };
  }

  /**
   * Maps an error to a specific error type `T` by testing it against an ordered list of `ErrorMapping` rules.
   *
   * Each mapping's `pattern` is tested (case-insensitively) against both the error message and error name.
   * The first matching rule's `factory` is called with the original error and the mapping's `additionalContext`.
   * If no rule matches and `defaultFactory` is provided, it is called instead.
   * If neither matches, returns the original `Error` or wraps non-Error values in a plain `Error`.
   *
   * @template T The target error type, extending `Error`.
   * @param error - The error instance or value to map.
   * @param mappings - An ordered array of mapping rules; first match wins.
   * @param defaultFactory - Optional factory invoked when no mapping rule matches.
   * @returns The mapped error of type `T`, or the original/wrapped error if no rule matched.
   *
   * @example
   * ```ts
   * const mapped = ErrorHandler.mapError(err, [
   *   {
   *     pattern: /not found/i,
   *     errorCode: JsonRpcErrorCode.NotFound,
   *     factory: (e) => new McpError(JsonRpcErrorCode.NotFound, getErrorMessage(e)),
   *   },
   * ]);
   * ```
   */
  public static mapError<T extends Error>(
    error: unknown,
    mappings: ReadonlyArray<ErrorMapping<T>>,
    defaultFactory?: (error: unknown, context?: Record<string, unknown>) => T,
  ): T | Error {
    const errorMessage = getErrorMessage(error);
    const errorName = getErrorName(error);

    for (const mapping of mappings) {
      const regex = getCompiledPattern(mapping.pattern);
      if (regex.test(errorMessage) || regex.test(errorName)) {
        // c8 ignore next
        return mapping.factory(error, mapping.additionalContext);
      }
    }

    if (defaultFactory) {
      return defaultFactory(error);
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /**
   * Formats an error into a consistent `{ code, message, data }` structure for API responses or structured logging.
   *
   * - `McpError` → `{ code: error.code, message: error.message, data: error.data ?? {} }`
   * - `Error` → `{ code: determineErrorCode(error), message: error.message, data: { errorType: error.name } }`
   * - Other values → `{ code: JsonRpcErrorCode.UnknownError, message: getErrorMessage(value), data: { errorType: getErrorName(value) } }`
   *
   * @param error - The error instance or value to format.
   * @returns A plain object with `code` (numeric `JsonRpcErrorCode`), `message` (string), and `data` (object).
   *
   * @example
   * ```ts
   * const formatted = ErrorHandler.formatError(new McpError(JsonRpcErrorCode.NotFound, 'Item missing'));
   * // → { code: -32001, message: 'Item missing', data: {} }
   *
   * const formatted2 = ErrorHandler.formatError(new TypeError('bad arg'));
   * // → { code: -32007, message: 'bad arg', data: { errorType: 'TypeError' } }
   * ```
   */
  public static formatError(error: unknown): Record<string, unknown> {
    if (error instanceof McpError) {
      return {
        code: error.code,
        message: error.message,
        data: typeof error.data === 'object' && error.data !== null ? error.data : {},
      };
    }

    if (error instanceof Error) {
      return {
        code: ErrorHandler.determineErrorCode(error),
        message: error.message,
        data: { errorType: error.name || 'Error' },
      };
    }

    return {
      code: JsonRpcErrorCode.UnknownError,
      message: getErrorMessage(error),
      data: { errorType: getErrorName(error) },
    };
  }

  /**
   * Safely executes a synchronous or asynchronous function, logging and rethrowing any error.
   *
   * Equivalent to wrapping `fn` in a try/catch that calls `ErrorHandler.handleError` with `rethrow: true`.
   * The processed `McpError` (or custom-mapped error) is always thrown — this method never swallows errors.
   * Use this in service code where you want structured logging and OTel integration without duplicating
   * error-handling boilerplate.
   *
   * @template T The expected return type of `fn`.
   * @param fn - The function to execute. May be synchronous or return a `Promise`.
   * @param options - Error handling options passed to `handleError` (`rethrow` is always `true` and cannot be overridden).
   * @returns A promise that resolves with the return value of `fn` on success.
   * @throws {McpError | Error} The processed error from `ErrorHandler.handleError` on failure.
   *
   * @example
   * ```ts
   * const user = await ErrorHandler.tryCatch(
   *   () => db.findUser(id),
   *   { operation: 'findUser', context: { requestId, userId: id } },
   * );
   * ```
   */
  public static async tryCatch<T>(
    fn: () => Promise<T> | T,
    options: Omit<ErrorHandlerOptions, 'rethrow'>,
  ): Promise<T> {
    try {
      return await Promise.resolve(fn());
    } catch (caughtError) {
      const handled = ErrorHandler.handleError(caughtError, {
        ...options,
        rethrow: false,
      });
      throw handled;
    }
  }
}

/**
 * @fileoverview Main ErrorHandler implementation with logging and telemetry integration.
 * Provides error classification, formatting, and consistent error handling patterns.
 * @module src/utils/internal/error-handler/errorHandler
 */

import { SdkError, SdkErrorCode } from '@modelcontextprotocol/server';
import { trace } from '@opentelemetry/api';

import { ZodError } from 'zod';

import { isInputRequiredSignal } from '@/mcp-server/inputRequired.js';
import { JsonRpcErrorCode, McpError, requestCancelled } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { toLogValue } from '@/utils/internal/logValue.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { generateUUID } from '@/utils/security/idGenerator.js';
import { sanitizeInputForLogging } from '@/utils/security/sanitization.js';
import {
  ATTR_MCP_ERROR_CATEGORY,
  ATTR_MCP_ERROR_CLASSIFIED_CODE,
  ATTR_MCP_ERROR_SEVERITY,
} from '@/utils/telemetry/attributes.js';
import { createCounter } from '@/utils/telemetry/metrics.js';
import { isRecord } from '@/utils/types/guards.js';
import {
  asError,
  copyFields,
  errorText,
  extractErrorCauseChain,
  getErrorMessage,
  getErrorName,
  isInstance,
  readErrorData,
  readField,
  readWireErrorData,
  recordSpanFailure,
  UNREADABLE,
} from './helpers.js';
import {
  COMPILED_ERROR_PATTERNS,
  COMPILED_PROVIDER_PATTERNS,
  ENGINE_RESOURCE_LIMIT_MESSAGES,
  ERROR_TYPE_MAPPINGS,
  getCompiledPattern,
  getErrorCategory,
} from './mappings.js';
import type { ErrorContext, ErrorHandlerOptions, ErrorMapping } from './types.js';

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
 * A record's `extra` as a stack-free record writes it, every field in one walk
 * — the context's, `input`, `errorData`: each `Error` written without its
 * `stack`, no `stack`, and none of `errorData`'s stack fields (`originalStack`,
 * and on each `causeChain` node its `stack` and the same fields in its `data`).
 * `extra` is the record's own object literal, so the walk returns an object
 * whatever the context's `extra` was.
 */
function toStackFreeExtra(extra: Record<string, unknown>): Record<string, unknown> {
  const { stack: _stack, ...rest } = toLogValue(extra, { includeStack: false }) as Record<
    string,
    unknown
  >;
  if (isRecord(rest.errorData)) dropStackFields(rest.errorData);
  return rest;
}

/** Deletes the record's stack fields from `data`, a walked copy, down its `causeChain`. */
function dropStackFields(data: Record<string, unknown>): void {
  delete data.originalStack;
  if (!Array.isArray(data.causeChain)) return;
  for (const node of data.causeChain) {
    if (!isRecord(node)) continue;
    delete node.stack;
    if (isRecord(node.data)) dropStackFields(node.data);
  }
}

/**
 * The value a handler unwound with, resolved against its request's cancellation.
 *
 * Once the request's signal has fired, the unwind *is* the cancellation,
 * whatever the handler threw on the way out. A `notifications/cancelled`
 * leaves its `reason` string on the signal — or a `DOMException` named
 * `AbortError` when the notification carried none — a service that noticed the
 * abort may raise its own `McpError`, and the SDK aborts with an
 * `SdkError(ConnectionClosed)` when the transport closes. Classifying by the
 * shape of that value reads a routine caller action as a server fault: an
 * `error`-level log with a stack, and `InternalError` or `Timeout` on the
 * completion log, for every cancelled call (#421).
 *
 * So the cancellation outranks the thrown value's own code, `McpError`
 * included. The accepted cost is that an unrelated fault raised after the abort
 * is recorded as a cancellation too; it is bounded, because the SDK writes no
 * response for a request whose signal it aborted, so the client-visible
 * envelope is the same either way.
 *
 * Applied inside the measured region by both handler factories, so the
 * completion log's `metrics.errorCode` and the execution span's error-code
 * attribute carry `-32011` alongside the classified envelope. The HTTP
 * transport's error handler applies it against the inbound request's signal,
 * and `runToolContract` against the mock context's, over the handler and the
 * success pipeline after it, so a contract test of cancellation sees the
 * envelope the factory emits (#513).
 *
 * Returns the value unchanged while the signal is live, for an `input_required`
 * signal (protocol control flow, never a failure), and for an error already
 * carrying `RequestCancelled`.
 */
export function asRequestCancelled(error: unknown, signal: AbortSignal): unknown {
  if (!signal.aborted || isInputRequiredSignal(error)) return error;
  if (
    isInstance(error, McpError) &&
    readField(error, 'code') === JsonRpcErrorCode.RequestCancelled
  ) {
    return error;
  }
  return requestCancelled(getErrorMessage(error), undefined, { cause: error });
}

/**
 * A utility class providing static methods for comprehensive error handling.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: public API surface — preserving class for namespace semantics
export class ErrorHandler {
  /**
   * Determines an appropriate `JsonRpcErrorCode` for a given error.
   *
   * Classifies the thrown value alone. A handler unwinding after its request's
   * abort signal fired is settled before this runs — see
   * {@link asRequestCancelled}, which the handler factories apply first and
   * which outranks every step below.
   *
   * Resolution order:
   * 1. `McpError` instances — returns `error.code` directly (`InternalError` when the code cannot be read).
   * 2. SDK `ConnectionClosed` rejections — mapped to `RequestCancelled`, ahead of the pattern ladder.
   * 3. Engine resource-limit `RangeError`s — a whole message in `ENGINE_RESOURCE_LIMIT_MESSAGES`
   *    (stack overflow, maximum string size) maps to `InternalError` (#482).
   * 4. Standard JS error constructor names via `ERROR_TYPE_MAPPINGS` (e.g. `SyntaxError` → `ValidationError`).
   * 5. Provider-specific patterns (AWS, HTTP status codes, Supabase, OpenRouter) — checked before common patterns for specificity.
   * 6. Common message/name patterns (auth, not-found, rate-limit, etc.).
   * 7. `AbortError` name — mapped to `Timeout`.
   * 8. Falls back to `JsonRpcErrorCode.InternalError`.
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
    /**
     * Every read of the thrown value is guarded (#697): a value `instanceof`
     * cannot inspect (a revoked `Proxy`) is classified as a non-Error, and a
     * field whose read throws as `'[Unreadable]'`.
     */
    if (isInstance(error, McpError)) {
      const code = readField(error, 'code');
      return code === UNREADABLE ? JsonRpcErrorCode.InternalError : (code as JsonRpcErrorCode);
    }

    /**
     * The SDK rejects every request still in flight when the transport closes,
     * which is what a client disconnect looks like from in here. Matched on the
     * code rather than the message: the SDK uses this same code for more than
     * one wording, and the one that says "aborted" would otherwise be caught by
     * the generic abort pattern below and read as a `Timeout`.
     */
    if (isInstance(error, SdkError) && readField(error, 'code') === SdkErrorCode.ConnectionClosed) {
      return JsonRpcErrorCode.RequestCancelled;
    }

    const errorName = getErrorName(error);
    const errorMessage = getErrorMessage(error);

    /**
     * The engine's own resource limits — a runaway recursion, a string past the
     * maximum size — surface as `RangeError`s whose text names nothing a caller
     * can change. Matched by whole message ahead of the constructor table, which
     * files every other `RangeError` as a caller's `ValidationError`.
     */
    if (errorName === 'RangeError' && ENGINE_RESOURCE_LIMIT_MESSAGES.has(errorMessage)) {
      return JsonRpcErrorCode.InternalError;
    }

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
    if (typeof error === 'object' && error !== null && readField(error, 'name') === 'AbortError') {
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
   * 3. Extracts and consolidates error data and the full cause chain.
   * 4. Rebuilds the error as a new `McpError` carrying the consolidated data — the thrown
   *    error's own `data`, `originalErrorName`, and `originalMessage` — preserving the classified
   *    code (or delegates to `options.errorMapper`). That `data` is client-visible once the error
   *    is thrown toward a handler, so it carries nothing derived from a cause, no stack, and no
   *    `context`: `rootCause`, `causeChain`, and the context ride the log record only. The
   *    rebuilt error takes the thrown error's stack, so it starts at the throw site.
   * 5. Logs the result via the global logger with full structured context — at `error` level,
   *    with the throw site's stack as the record's `stack` (none for a thrown value without one,
   *    and never a context's `extra.stack`), and each stack written once: a `causeChain` node
   *    carrying the record's stack, or the same stack as the node before it, is written without
   *    it. The handler's own fields lead the record, ahead of the context's `extra` and `input`,
   *    and no caller key replaces one. A field of the thrown value whose read throws is written
   *    as `'[Unreadable]'`, so the call never throws on what it reports.
   *    A record is stack-free for `RequestCancelled`, which is a routine caller disconnect logged
   *    at `info`, and under `includeStack: false`: no `stack`, no `errorData.originalStack`, no
   *    `causeChain` node `stack` nor `originalStack` in a node's `data`, and every `Error` in the
   *    record written without its `stack` (see `ErrorHandlerOptions`).
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
    if (activeSpan?.isRecording()) recordSpanFailure(activeSpan, error);
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
      severity,
    } = options;

    const sanitizedInput = input !== undefined ? sanitizeInputForLogging(input) : undefined;
    /**
     * Every read of the thrown value is guarded: a `name`, `message`, `stack`,
     * `cause`, or an `McpError`'s `code` whose read throws (a getter, a revoked
     * `Proxy`), or a `data` that cannot be read or copied, is written as
     * `'[Unreadable]'` or left out, and a value `instanceof` cannot inspect is
     * handled as a non-Error, so reporting a failure never fails itself (#697).
     */
    const originalErrorName = getErrorName(error);
    const originalErrorMessage = getErrorMessage(error);
    const thrownError = isInstance(error, Error) ? error : undefined;
    const thrownMcpError = isInstance(error, McpError) ? error : undefined;
    const originalStack = thrownError ? readField(thrownError, 'stack') : undefined;

    /**
     * Classified before the record is assembled, because the code decides more
     * than the wire response: a caller-abandoned request is a routine event, so
     * it is logged at `info` and carries no stack. Attaching one invites triage
     * to read a client hanging up as a fault in this server.
     */
    const loggedErrorCode: JsonRpcErrorCode = thrownMcpError
      ? ErrorHandler.determineErrorCode(thrownMcpError)
      : explicitErrorCode || ErrorHandler.determineErrorCode(error);
    const isCancellation = loggedErrorCode === JsonRpcErrorCode.RequestCancelled;
    /**
     * A stack-free record has none of the stack fields `ErrorHandlerOptions.includeStack`
     * lists, and writes every `Error` in it without its `stack` — whether this
     * handler, the thrown `McpError`'s own `data`, the context, or `input`
     * supplied it (#650). Any other key named `stack` is a caller's data and is
     * written as given. The returned error is the same either way.
     */
    const stackFree = !includeStack || isCancellation;

    const errorDataSeed: Record<string, unknown> = readErrorData(error) ?? {};

    /**
     * `consolidatedData` becomes `McpError.data`, which the tool handler puts on
     * `structuredContent.error.data`. It carries the thrown error's own data and
     * its classification, never `context`: a service handed the handler `ctx`
     * (the documented `{ context: ctx }` pattern) would otherwise publish
     * request metadata, and `extra` holds whatever a server attached — scope
     * names, identifiers, input. The context reaches the log record below (#548).
     */
    const consolidatedData: Record<string, unknown> = {
      ...errorDataSeed,
      originalErrorName,
      originalMessage: originalErrorMessage,
    };

    /**
     * What the cause chain says goes to the log record only, never into the
     * returned error's `data`: `tryCatch` throws that error, and tools and
     * resources forward an `McpError`'s `data` to the client verbatim (#519),
     * so a message redacted at the throw site would reach the client raw
     * through its cause (#644). A cancellation carries no chain — its every
     * node would hold a stack and invite triage to read a caller hanging up
     * as a fault in this server. `includeStack: false` keeps the chain, and
     * the stack-free record logs none of its nodes' stacks (#586).
     */
    const diagnostics: Record<string, unknown> = {};

    if (!isCancellation && thrownError && readField(thrownError, 'cause')) {
      const causeChain = extractErrorCauseChain(thrownError);
      const rootCause = causeChain.at(-1);
      if (rootCause) {
        diagnostics.rootCause = { name: rootCause.name, message: rootCause.message };
        /**
         * A node whose stack is the record's own, or the node's before it, is
         * written without it — the rule the log walk applies to an `Error`'s
         * `cause` — so the record carries each stack once (#694): the thrown
         * error itself, and every error a nested `tryCatch` rebuilt from
         * another. A stack that could not be read is no stack to repeat.
         */
        diagnostics.causeChain = causeChain.map((node, i) => {
          const { stack } = node;
          const repeated = stack === originalStack || stack === causeChain[i - 1]?.stack;
          if (stack === undefined || stack === UNREADABLE || !repeated) return node;
          const { stack: _stack, ...rest } = node;
          return rest;
        });
      }
    }

    const finalError: Error = errorMapper
      ? errorMapper(error)
      : new McpError(loggedErrorCode, originalErrorMessage, consolidatedData, {
          cause: thrownError,
        });

    /**
     * The rebuilt error takes the throw site's stack, so the error `tryCatch`
     * rethrows starts where the failure happened rather than here (#694). It is
     * copied verbatim: the header line names the class that was thrown, and
     * `finalErrorType` on the record names the rebuilt one. A mapper's result
     * keeps the stack its mapper gave it, and takes the throw site's only when
     * it has none. A throw-site stack that could not be read is not copied.
     */
    if (
      typeof originalStack === 'string' &&
      originalStack &&
      originalStack !== UNREADABLE &&
      finalError !== error &&
      (!errorMapper || !finalError.stack)
    ) {
      finalError.stack = originalStack;
    }

    /**
     * Record error classification metric. The category is the same
     * `getErrorCategory` answer the per-surface error counters carry, handed
     * the thrown `McpError`'s `data` so the canvas tenant-cap refusal files
     * under `server` rather than upstream throttling (#481). The resolved
     * severity is a bounded dimension and rides as an attribute; it is present
     * only when one resolved — a declared entry's, or `notice` for the
     * framework's argument and capability refusals (#567) and a scope check's
     * missing-scope refusal (#585). The `reason` behind any of them never
     * becomes a metric attribute —
     * unbounded across a fleet, so it belongs on the span and in the log.
     */
    getErrorMetrics().errorClassifiedCounter.add(1, {
      [ATTR_MCP_ERROR_CLASSIFIED_CODE]: String(loggedErrorCode),
      [ATTR_MCP_ERROR_CATEGORY]: getErrorCategory(loggedErrorCode, errorDataSeed),
      operation,
      ...(severity !== undefined && { [ATTR_MCP_ERROR_SEVERITY]: severity }),
    });

    /**
     * The context is read once, through these copies: a field that throws when
     * read — an own getter, a `Proxy` trap — would otherwise fail the call that
     * reports a failure. A copy that throws is written as `'[Unreadable]'` in
     * the record, under `context` or `extra`.
     */
    const contextFields = copyFields(context);
    const { extra: contextExtra, ...contextCanonical }: ErrorContext = contextFields ?? {};
    const extraFields = copyFields(contextExtra);

    const logRequestId =
      typeof contextCanonical.requestId === 'string' && contextCanonical.requestId
        ? contextCanonical.requestId
        : generateUUID();

    const logTimestamp =
      typeof contextCanonical.timestamp === 'string' && contextCanonical.timestamp
        ? contextCanonical.timestamp
        : new Date().toISOString();

    /**
     * Read and copied as the thrown value's is: an `errorMapper` may return the
     * very error it was given. A `data` that cannot be read or copied gives way
     * to `consolidatedData`.
     */
    const errorData = { ...(readErrorData(finalError) ?? consolidatedData), ...diagnostics };
    const handlerFields = {
      critical,
      errorCode: loggedErrorCode,
      originalErrorType: originalErrorName,
      finalErrorType: getErrorName(finalError),
      errorData,
      // The record's one stack: the throw site's, absent for a thrown value with none (#694).
      ...(originalStack ? { stack: originalStack } : {}),
    };
    // A context's `extra.stack` never stands in for the throw site's (#694).
    const { stack: _contextStack, ...callerExtra } = extraFields ?? { extra: UNREADABLE };
    /**
     * The handler's own fields lead the record, so the log walk, which works
     * in key order, reaches `errorData` before caller-sized `extra` and `input`
     * can spend its bound on what it writes (#649); spread again last, so a
     * caller's key never replaces one.
     */
    const recordExtra: Record<string, unknown> = {
      ...handlerFields,
      ...callerExtra,
      ...(contextFields === undefined && { context: UNREADABLE }),
      input: sanitizedInput,
      ...handlerFields,
    };
    const logContext: RequestContext = {
      operation,
      ...contextCanonical,
      requestId: logRequestId,
      timestamp: logTimestamp,
      extra: stackFree ? toStackFreeExtra(recordExtra) : recordExtra,
    };

    const finalMessage = readField(finalError, 'message');
    const logDescription = finalMessage ? errorText(finalMessage) : originalErrorMessage;
    if (isCancellation) {
      logger.info(`Cancelled ${operation}: ${logDescription}`, logContext);
    } else if (severity !== undefined) {
      // A modeled outcome the definition declared. Same message, same
      // structured fields — only the level moves (#380).
      logger[severity](`Error in ${operation}: ${logDescription}`, logContext);
    } else {
      logger.error(`Error in ${operation}: ${logDescription}`, logContext);
    }

    if (rethrow) {
      throw finalError;
    }
    return finalError;
  }

  /**
   * Classifies an error and returns its JSON-RPC error code and message without
   * logging, OTel side effects, or error wrapping. Use this when you need error
   * classification but the caller handles logging/rethrowing (e.g., the resource
   * handler factory, whose completion record carries the code).
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
    if (isInstance(error, McpError)) {
      return {
        code: ErrorHandler.determineErrorCode(error),
        message: errorText(readField(error, 'message')),
      };
    }
    if (isInstance(error, ZodError)) {
      return {
        code: JsonRpcErrorCode.ValidationError,
        message: getErrorMessage(error),
        data: { issues: readField(error, 'issues') },
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
    return asError(error);
  }

  /**
   * Formats an error into a consistent `{ code, message, data }` structure for API responses or structured logging.
   *
   * - `McpError` → `{ code: error.code, message: error.message, data: <a copy of error.data> ?? {} }`
   * - `Error` → `{ code: determineErrorCode(error), message: error.message, data: { errorType: error.name } }`
   * - Other values → `{ code: JsonRpcErrorCode.UnknownError, message: getErrorMessage(value), data: { errorType: getErrorName(value) } }`
   *
   * Never throws on the value it formats: a `message` or `name` whose read throws is
   * `'[Unreadable]'`, one that is not a string is written as text (`String` for a
   * primitive, `'[Unreadable]'` for an object), a `data` that cannot be read or copied
   * (a revoked `Proxy`) is `{}`, and a value `instanceof` cannot inspect (a revoked
   * `Proxy`) is formatted as a non-Error. Every `data` field is one a response can
   * carry: one `JSON.stringify` cannot write is `'[Unreadable]'`, and one that takes
   * more than 1,000,000 JSON values to write is `'[Truncated]'`.
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
    if (isInstance(error, McpError)) {
      return {
        code: ErrorHandler.determineErrorCode(error),
        message: errorText(readField(error, 'message')),
        data: readWireErrorData(error) ?? {},
      };
    }

    if (isInstance(error, Error)) {
      return {
        code: ErrorHandler.determineErrorCode(error),
        message: errorText(readField(error, 'message')),
        data: { errorType: getErrorName(error) },
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
   * The thrown error's `data` reaches the client when a tool or resource handler lets it propagate,
   * so it carries the caught error's own `data`, `originalErrorName`, and `originalMessage`, but
   * nothing derived from a cause, no stack, and nothing from `options.context`; the throw-site
   * stack, `rootCause`, the cause chain, and the context are logged (#548, #644).
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
   *   { operation: 'findUser', context: { requestId, extra: { userId: id } } },
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

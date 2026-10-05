/**
 * @fileoverview Helper utilities for error inspection and normalization.
 * Enhanced with cause chain extraction and circular reference detection.
 * @module src/utils/internal/error-handler/helpers
 */

import { ZodError } from 'zod';

import { McpError } from '@/types-global/errors.js';
import { isAggregateError } from '@/utils/types/guards.js';

/**
 * Formats a ZodError as a single readable line: `<dotted.path>: <message>`.
 *
 * `ZodError.message` is a serialized JSON array of `ZodIssue` objects — useful for
 * debugging but unreadable in logs, client error messages, and UI surfaces. This
 * helper renders the first issue (typically the most actionable) with its path
 * leading, the form every other path-bearing renderer in the framework uses, so
 * a custom message written as a full sentence stays intact. An issue with an
 * empty path renders as its bare message, and a count of the remaining issues
 * trails as ` (+N more)`.
 *
 * Pair with `ErrorHandler.classifyOnly` (which returns `data: { issues }`) to
 * preserve the structured issue array for clients that can render field-level
 * errors.
 *
 * @param err - The ZodError to format.
 * @returns A single line, e.g. `"nctId: Invalid input: expected string, received number (+2 more)"`.
 */
export function formatZodErrorMessage(err: ZodError): string {
  const issues = err.issues;
  const first = issues[0];
  if (!first) return 'Validation failed';
  const path = first.path.length > 0 ? `${first.path.map(String).join('.')}: ` : '';
  const rest = issues.length - 1;
  const tail = rest > 0 ? ` (+${rest} more)` : '';
  return `${path}${first.message}${tail}`;
}

/**
 * Retrieves a descriptive name for an error object or value.
 *
 * - `Error` instances → `error.name` (e.g. `'TypeError'`), falling back to `'Error'`.
 * - `null` → `'NullValueEncountered'`
 * - `undefined` → `'UndefinedValueEncountered'`
 * - Non-plain objects with a named constructor → `'<ConstructorName>Encountered'`
 * - Everything else → `'<typeof value>Encountered'` (e.g. `'stringEncountered'`)
 *
 * @param error - The error object or value.
 * @returns A stable, human-readable string identifying the error's type.
 *
 * @example
 * ```ts
 * getErrorName(new TypeError('bad'));   // → 'TypeError'
 * getErrorName('oops');                 // → 'stringEncountered'
 * getErrorName(null);                   // → 'NullValueEncountered'
 * ```
 */
export function getErrorName(error: unknown): string {
  if (error instanceof Error) {
    return error.name || 'Error';
  }
  if (error === null) {
    return 'NullValueEncountered';
  }
  if (error === undefined) {
    return 'UndefinedValueEncountered';
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    error.constructor &&
    typeof error.constructor.name === 'string' &&
    error.constructor.name !== 'Object'
  ) {
    return `${error.constructor.name}Encountered`;
  }
  return `${typeof error}Encountered`;
}

/**
 * Extracts a human-readable message string from any thrown value.
 *
 * Handles every JavaScript type so that `catch (e)` blocks never produce `[object Object]`:
 * - `AggregateError` → combines up to 3 inner error messages after the outer message.
 * - `Error` → `error.message`
 * - `null` / `undefined` → descriptive literal strings.
 * - Primitives (`string`, `number`, `boolean`, `bigint`, `symbol`) → string-coerced value.
 * - Functions → `[function <name>]`
 * - Objects → JSON-serialized if possible; otherwise constructor name fallback.
 * - If conversion itself throws, returns a safe fallback describing the conversion error.
 *
 * @param error - The thrown value to extract a message from.
 * @returns A non-empty string describing the error.
 *
 * @example
 * ```ts
 * getErrorMessage(new Error('oops'));              // → 'oops'
 * getErrorMessage('string thrown');               // → 'string thrown'
 * getErrorMessage(42);                            // → '42'
 * getErrorMessage(null);                          // → 'Null value encountered as error'
 * getErrorMessage(new AggregateError([new Error('a'), new Error('b')], 'multi'));
 * // → 'multi: a; b'
 * ```
 */
export function getErrorMessage(error: unknown): string {
  try {
    if (error instanceof ZodError) {
      return formatZodErrorMessage(error);
    }
    if (error instanceof Error) {
      // AggregateError should surface combined messages succinctly
      if (isAggregateError(error)) {
        const inner = error.errors
          .map((e) => (e instanceof Error ? e.message : String(e)))
          .filter(Boolean)
          .slice(0, 3)
          .join('; ');
        return inner ? `${error.message}: ${inner}` : error.message;
      }
      return error.message;
    }
    if (error === null) {
      return 'Null value encountered as error';
    }
    if (error === undefined) {
      return 'Undefined value encountered as error';
    }
    if (typeof error === 'string') {
      return error;
    }
    if (typeof error === 'number' || typeof error === 'boolean') {
      return String(error);
    }
    if (typeof error === 'bigint') {
      return error.toString();
    }
    if (typeof error === 'function') {
      return `[function ${error.name || 'anonymous'}]`;
    }
    if (typeof error === 'object') {
      try {
        const json = JSON.stringify(error);
        if (json && json !== '{}') return json;
      } catch {
        // fall through
      }
      const ctor = (error as { constructor?: { name?: string } }).constructor?.name;
      return `Non-Error object encountered (constructor: ${ctor || 'Object'})`;
    }
    if (typeof error === 'symbol') {
      return error.toString();
    }
    // c8 ignore next
    return '[unrepresentable error]';
  } catch (conversionError) {
    return `Error converting error to string: ${conversionError instanceof Error ? conversionError.message : 'Unknown conversion error'}`;
  }
}

/**
 * Represents a single node in an error cause chain produced by `extractErrorCauseChain`.
 * Each node captures the identity, message, and optional metadata of one error in the chain,
 * with `depth: 0` being the original (outermost) error and increasing depth tracking nested causes.
 */
export interface ErrorCauseNode {
  /**
   * The error's own string `code`, when it carries one — the transport code a
   * fetch failure keeps: `ECONNREFUSED` on the `cause` of Node's
   * `TypeError: fetch failed`, `ConnectionRefused` on Bun's rejection itself.
   * `McpError`'s numeric JSON-RPC code is not copied.
   */
  code?: string;
  /** Additional data from McpError instances */
  data?: Record<string, unknown>;
  /** Depth in the cause chain (0 = original error) */
  depth: number;
  /** Error message */
  message: string;
  /** Error name/type */
  name: string;
  /** Stack trace if available */
  stack?: string;
}

/**
 * Extracts the complete error cause chain into a flat array of `ErrorCauseNode` objects.
 *
 * Starts at `error` (depth 0) and follows `error.cause` links until:
 * - a non-Error value is encountered (appended as the terminal node, then stops),
 * - a circular reference is detected (sentinel node appended, then stops),
 * - or `maxDepth` is reached (sentinel node appended, then stops).
 *
 * String causes are treated as terminal `StringError` nodes.
 * `McpError` nodes include the `data` property when present, and any `Error`
 * node carrying a string `code` includes it.
 * Circular references are detected via `WeakSet` identity tracking.
 *
 * @param error - The outermost error to start traversal from.
 * @param maxDepth - Maximum number of nodes to traverse before stopping. Defaults to `20`.
 * @returns An array of `ErrorCauseNode` objects ordered from outermost (depth 0) to deepest cause.
 *          An empty array is returned if `error` itself is falsy.
 *
 * @example
 * ```ts
 * const inner = new Error('db connection failed');
 * const outer = new Error('user lookup failed', { cause: inner });
 * const chain = extractErrorCauseChain(outer);
 * // → [
 * //   { name: 'Error', message: 'user lookup failed', depth: 0, stack: '...' },
 * //   { name: 'Error', message: 'db connection failed', depth: 1, stack: '...' },
 * // ]
 * ```
 */
export function extractErrorCauseChain(error: unknown, maxDepth = 20): ErrorCauseNode[] {
  const chain: ErrorCauseNode[] = [];
  const seen = new WeakSet<object>();
  let current = error;
  let depth = 0;

  while (current && depth < maxDepth) {
    // Circular reference detection
    if (typeof current === 'object' && current !== null) {
      if (seen.has(current)) {
        chain.push({
          name: 'CircularReference',
          message: 'Circular reference detected in error cause chain',
          depth,
        });
        break;
      }
      seen.add(current);
    }

    if (current instanceof Error) {
      const node: ErrorCauseNode = {
        name: current.name,
        message: current.message,
        depth,
        ...('code' in current && typeof current.code === 'string' ? { code: current.code } : {}),
        // Only include stack if it exists (exact optional property types)
        ...(current.stack !== undefined ? { stack: current.stack } : {}),
      };

      // Extract data from McpError instances
      if (current instanceof McpError && current.data) {
        node.data = current.data;
      }

      chain.push(node);

      // Continue traversing cause chain
      current = current.cause;
    } else if (typeof current === 'string') {
      chain.push({
        name: 'StringError',
        message: current,
        depth,
      });
      break;
    } else {
      chain.push({
        name: getErrorName(current),
        message: getErrorMessage(current),
        depth,
      });
      break;
    }

    depth++;
  }

  if (depth >= maxDepth) {
    chain.push({
      name: 'MaxDepthExceeded',
      message: `Error cause chain exceeded maximum depth of ${maxDepth}`,
      depth,
    });
  }

  return chain;
}

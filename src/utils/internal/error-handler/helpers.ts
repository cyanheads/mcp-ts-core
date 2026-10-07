/**
 * @fileoverview Helper utilities for error inspection and normalization.
 * Enhanced with cause chain extraction and circular reference detection.
 * @module src/utils/internal/error-handler/helpers
 */

import { type Span, SpanStatusCode } from '@opentelemetry/api';
import { ZodError } from 'zod';

import { McpError } from '@/types-global/errors.js';
import { isAggregateError } from '@/utils/types/guards.js';

/**
 * What the error path writes for a field whose read throws — a getter, a
 * `Proxy` trap, a revoked `Proxy` — as the log-data walk does.
 */
export const UNREADABLE = '[Unreadable]';

/** `value[key]`, or {@link UNREADABLE} when reading it throws. */
export function readField(value: object, key: PropertyKey): unknown {
  try {
    return (value as Record<PropertyKey, unknown>)[key];
  } catch {
    return UNREADABLE;
  }
}

/**
 * An error's `message` or `name`, as read, written as text: a string as it is;
 * any other primitive as `String` converts it, which runs no caller code and
 * never throws, a `Symbol` included (`'Symbol(description)'`), so a `message`
 * set to `404` reads `'404'`; and an object or function as {@link UNREADABLE},
 * since converting one runs its own `toString`, which can throw or return
 * anything.
 */
export function errorText(value: unknown): string {
  if (typeof value === 'string') return value;
  return value === null || (typeof value !== 'object' && typeof value !== 'function')
    ? String(value)
    : UNREADABLE;
}

/**
 * `value instanceof type`, or `false` when the check throws — a revoked
 * `Proxy`, a `getPrototypeOf` trap — so such a value is handled as the
 * non-instance it cannot be shown not to be.
 */
export function isInstance<T>(
  value: unknown,
  type: abstract new (...args: never[]) => T,
): value is T {
  try {
    return value instanceof type;
  } catch {
    return false;
  }
}

/**
 * A copy of `value`'s own enumerable fields, as a spread makes it (`{}` for
 * `undefined`), or `undefined` when making it throws — a getter that throws, a
 * `Proxy` whose trap throws.
 */
export function copyFields<T extends object>(value: T | undefined): T | undefined {
  try {
    return { ...value } as T;
  } catch {
    return;
  }
}

/**
 * A shallow copy of the `data` a thrown `McpError` carries, so the error path
 * reads plain fields rather than the thrown value's. Nothing is serialized: the
 * log record writes the copy through the bounded log walk, and the wire
 * boundaries check it with {@link readWireErrorData}. `undefined` when `error`
 * is not an `McpError`, carries no object `data`, or its `data` cannot be read
 * or copied — a getter, a revoked `Proxy`, a throwing `ownKeys` trap.
 */
export function readErrorData(error: unknown): Record<string, unknown> | undefined {
  if (!isInstance(error, McpError)) return;
  const data = readField(error, 'data');
  return typeof data === 'object' && data !== null
    ? copyFields(data as Record<string, unknown>)
    : undefined;
}

/**
 * JSON values one `data` field may take to write before the wire check gives it
 * up: about 6 MB of JSON, checked in tens of milliseconds. `JSON.stringify`
 * writes a shared object once per reference, so 17 objects that each refer to
 * the next three times write 43 million values: seconds and gigabytes to
 * serialize, and a response a stdio client cannot read.
 */
const WIRE_VALUES = 1_000_000;

/** Thrown by the wire check's replacer once a field passes {@link WIRE_VALUES}. */
const OVER_WIRE_BUDGET = Symbol('over wire budget');

/**
 * `value` when `JSON.stringify` writes it within {@link WIRE_VALUES} values;
 * `'[Truncated]'` when it would take more, and {@link UNREADABLE} when it
 * cannot be written at all — a getter or a revoked `Proxy` that throws on read
 * at any depth, a `BigInt`, a cycle, a `toJSON` that throws.
 */
function wireField(value: unknown): unknown {
  let values = 0;
  try {
    JSON.stringify(value, (_key, field: unknown) => {
      if (++values > WIRE_VALUES) throw OVER_WIRE_BUDGET;
      return field;
    });
    return value;
  } catch (error) {
    return error === OVER_WIRE_BUDGET ? '[Truncated]' : UNREADABLE;
  }
}

/**
 * {@link readErrorData} for a response: every field is one the wire carries.
 * A field `JSON.stringify` cannot write is {@link UNREADABLE}, since a response
 * holding one is never sent and the client waits for it, and a field that takes
 * more than {@link WIRE_VALUES} JSON values to write is `'[Truncated]'`. Every
 * other field is the thrown value itself, so readable `data` is sent byte for
 * byte as thrown.
 */
export function readWireErrorData(error: unknown): Record<string, unknown> | undefined {
  const copy = readErrorData(error);
  if (copy === undefined) return;
  for (const key of Object.keys(copy)) copy[key] = wireField(copy[key]);
  return copy;
}

/**
 * `value` when it is an `Error`, else an `Error` whose message is `String(value)`
 * — or {@link UNREADABLE} when the value can be neither checked nor converted
 * (a revoked `Proxy`, a null-prototype object).
 */
export function asError(value: unknown): Error {
  try {
    return value instanceof Error ? value : new Error(String(value));
  } catch {
    return new Error(UNREADABLE);
  }
}

/**
 * Marks `span` failed with `error`: records an `Error` as the span's exception,
 * then sets the `ERROR` status with its `message` (any other value as `String`
 * converts it). Never throws: an exception the span cannot read — a field
 * whose getter throws, which the SDK's `recordException` reads unguarded — is
 * left unrecorded, and a message that cannot be read is {@link UNREADABLE}.
 */
export function recordSpanFailure(span: Span, error: unknown): void {
  let message: string;
  try {
    if (error instanceof Error) {
      try {
        span.recordException(error);
      } catch {
        // The span could not read it; the status below still marks the failure.
      }
      message = String(error.message);
    } else {
      message = String(error);
    }
  } catch {
    message = UNREADABLE;
  }
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

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
 * - `Error` instances → `error.name` (e.g. `'TypeError'`), falling back to `'Error'`;
 *   a `name` that is not a string is written as {@link errorText} writes it.
 * - `null` → `'NullValueEncountered'`
 * - `undefined` → `'UndefinedValueEncountered'`
 * - Non-plain objects with a named constructor → `'<ConstructorName>Encountered'`
 * - Everything else → `'<typeof value>Encountered'` (e.g. `'stringEncountered'`)
 * - A value whose inspection throws (a `name` getter, a revoked `Proxy`) → `'[Unreadable]'`
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
  try {
    if (error instanceof Error) {
      const name = readField(error, 'name');
      return name ? errorText(name) : 'Error';
    }
    if (error === null) {
      return 'NullValueEncountered';
    }
    if (error === undefined) {
      return 'UndefinedValueEncountered';
    }
    if (
      typeof error === 'object' &&
      error.constructor &&
      typeof error.constructor.name === 'string' &&
      error.constructor.name !== 'Object'
    ) {
      return `${error.constructor.name}Encountered`;
    }
    return `${typeof error}Encountered`;
  } catch {
    return UNREADABLE;
  }
}

/**
 * Extracts a human-readable message string from any thrown value.
 *
 * Handles every JavaScript type so that `catch (e)` blocks never produce `[object Object]`:
 * - `AggregateError` → combines up to 3 inner error messages after the outer message,
 *   each one that cannot be read as `'[Unreadable]'`.
 * - `Error` → `error.message`, or `'[Unreadable]'` when reading it throws (a getter);
 *   a `message` that is not a string, the outer's or a member's, as {@link errorText} writes it.
 * - `null` / `undefined` → descriptive literal strings.
 * - Primitives (`string`, `number`, `boolean`, `bigint`, `symbol`) → string-coerced value.
 * - Functions → `[function <name>]`
 * - Objects → JSON-serialized if possible; otherwise constructor name fallback.
 * - A value whose inspection throws (a getter, a `Proxy` trap, a revoked `Proxy`) →
 *   `'[Unreadable]'`, never the text of what the read threw.
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
      const message = errorText(readField(error, 'message'));
      // AggregateError should surface combined messages succinctly
      if (isAggregateError(error)) {
        const inner = error.errors
          .map((e) => errorText(readField(asError(e), 'message')))
          .filter(Boolean)
          .slice(0, 3)
          .join('; ');
        return inner ? `${message}: ${inner}` : message;
      }
      return message;
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
  } catch {
    return UNREADABLE;
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

/** Stands in, inside {@link extractErrorCauseChain}, for a `cause` whose read threw. */
const UNREADABLE_CAUSE = Symbol('unreadable cause');

/** `value instanceof Error`, or `undefined` when the check throws: a revoked `Proxy`, a `getPrototypeOf` trap. */
function errorCheck(value: unknown): boolean | undefined {
  try {
    return value instanceof Error;
  } catch {
    return;
  }
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
 * Every read is guarded: a `name`, `message`, or `stack` whose read throws is
 * `'[Unreadable]'` on its node, an unreadable `code` or `data` is left out, and
 * a cause that cannot be read or inspected — a throwing `cause` getter, a
 * revoked `Proxy` — ends the chain as a node whose `name` and `message` are
 * both `'[Unreadable]'`.
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

    const isError = current === UNREADABLE_CAUSE ? undefined : errorCheck(current);
    if (isError === undefined) {
      chain.push({ name: UNREADABLE, message: UNREADABLE, depth });
      break;
    }

    if (isError) {
      const err = current as Error;
      const code = readField(err, 'code');
      const stack = readField(err, 'stack');
      const node: ErrorCauseNode = {
        name: errorText(readField(err, 'name')),
        message: errorText(readField(err, 'message')),
        depth,
        ...(typeof code === 'string' && code !== UNREADABLE ? { code } : {}),
        // Only include stack if it exists (exact optional property types)
        ...(stack !== undefined ? { stack: stack as string } : {}),
      };

      // Extract data from McpError instances
      const data = err instanceof McpError ? readField(err, 'data') : undefined;
      if (data && data !== UNREADABLE) node.data = data as Record<string, unknown>;

      chain.push(node);

      // Continue traversing cause chain
      try {
        current = err.cause;
      } catch {
        current = UNREADABLE_CAUSE;
      }
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

/**
 * @fileoverview The length cap on caller-supplied strings that log records and
 * span attributes carry. A client sets the length of a resource URI, a JSON-RPC
 * id, or a tool argument's key, so a record carrying one whole is as large as
 * the client makes it; each such value is cut to a shared limit, with its uncut
 * length recorded beside it whenever the cut removed something.
 * @module src/utils/internal/observabilityCap
 */

/** The longest caller-supplied string a log record or span attribute carries. */
export const OBSERVABILITY_MAX_STRING_LENGTH = 1024;

/**
 * Bounds a caller-supplied string for a log record or span attribute: its first
 * `maxLength` characters (UTF-16 code units; the shared
 * {@link OBSERVABILITY_MAX_STRING_LENGTH} by default), and `length` — the uncut
 * length — only when the cut removed something. A cut never splits a surrogate
 * pair: when the last unit it would keep is a pair's high half, it ends one
 * unit earlier. The caller records `length` beside the value under its own
 * field name (`resourceUriLength`, `jsonRpcIdLength`).
 */
export function capForObservability(
  value: string,
  maxLength = OBSERVABILITY_MAX_STRING_LENGTH,
): { value: string; length?: number } {
  if (value.length <= maxLength) return { value };
  const end = isHighSurrogate(value.charCodeAt(maxLength - 1)) ? maxLength - 1 : maxLength;
  return { value: value.slice(0, end), length: value.length };
}

/** Whether `unit` is the high (leading) half of a UTF-16 surrogate pair. */
function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * A request's JSON-RPC id as log records carry it: `jsonRpcId` holds a number
 * or `null` as sent, and a string cut to its first
 * {@link OBSERVABILITY_MAX_STRING_LENGTH} characters, with `jsonRpcIdLength`
 * holding the uncut length when the cut removed something. Log fields only —
 * the id is never a span or metric attribute, and the response `id` stays whole.
 */
export function jsonRpcIdLogFields(id: string | number | null): {
  jsonRpcId: string | number | null;
  jsonRpcIdLength?: number;
} {
  if (typeof id !== 'string') return { jsonRpcId: id };
  const { value, length } = capForObservability(id);
  return { jsonRpcId: value, ...(length !== undefined && { jsonRpcIdLength: length }) };
}

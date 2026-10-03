/**
 * @fileoverview Growing prefixes of a tool's argument JSON for `ui/notifications/tool-input-partial`
 * streaming. Each prefix of the serialized arguments is closed into a valid JSON object:
 * an open string is terminated, open containers are closed, and a trailing token that
 * cannot be completed (a dangling key, a partial literal) is backed off.
 * @module src/testing/apps/partial-json
 */

/** At most this many partials are produced for one argument object. */
const MAX_PARTIALS = 8;

/**
 * Partial argument objects for growing prefixes of `JSON.stringify(args)`, in order. Every
 * entry is a plain object; consecutive duplicates are dropped and the complete arguments
 * are never included (those go out as `tool-input`).
 */
export function partialArguments(args: Record<string, unknown>): Record<string, unknown>[] {
  const json = JSON.stringify(args);
  const count = Math.min(MAX_PARTIALS, json.length - 1);
  const partials: Record<string, unknown>[] = [];
  let previous = '';
  for (let i = 1; i <= count; i++) {
    const cut = Math.max(1, Math.floor((json.length * i) / (count + 1)));
    const closed = closePrefix(json.slice(0, cut));
    if (closed === undefined || closed === previous || closed === json) continue;
    previous = closed;
    partials.push(JSON.parse(closed) as Record<string, unknown>);
  }
  return partials;
}

/** The longest closing of `prefix` (backing off one character at a time) that parses as an object. */
function closePrefix(prefix: string): string | undefined {
  for (let end = prefix.length; end > 0; end--) {
    const candidate = close(prefix.slice(0, end));
    try {
      const value: unknown = JSON.parse(candidate);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return JSON.stringify(value);
      }
    } catch {
      // Not closable at this length; back off.
    }
  }
  return undefined;
}

/** `text` with its open string and open containers closed. */
function close(text: string): string {
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') closers.push('}');
    else if (ch === '[') closers.push(']');
    else if (ch === '}' || ch === ']') closers.pop();
  }
  return `${text}${inString ? '"' : ''}${closers.reverse().join('')}`;
}

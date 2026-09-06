/**
 * @fileoverview Workerd-safe MCP wire helpers for the Worker lane.
 * The Node equivalents in `tests/helpers/http-helpers.ts` pull in `node:crypto`
 * and `Buffer`, so they cannot be imported under workerd.
 * @module tests/worker/wire-helpers
 */

/** Standard headers for MCP HTTP requests against the Worker fixture. */
export const MCP_HEADERS = {
  Accept: 'application/json, text/event-stream',
  'Content-Type': 'application/json',
  Origin: 'http://example.com',
} as const;

/** Creates a JSON-RPC request body. */
export function jsonrpc(id: number, method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

/** Parses SSE event frames into their JSON `data:` payloads. */
export function parseSseDataFrames(body: string): unknown[] {
  return body
    .split('\n\n')
    .filter(Boolean)
    .flatMap((block) => {
      const dataLines = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      if (dataLines.length === 0) return [];
      return [JSON.parse(dataLines.join('\n'))];
    });
}

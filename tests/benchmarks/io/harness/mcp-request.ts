/** @fileoverview Modern stateless MCP requests with complete body consumption and bounded lifetime. */
import { jsonrpc, MCP_HEADERS, parseSSEEvents } from '../../../helpers/http-helpers.js';

/** Send one real HTTP request; return both wire envelope and status for correctness checks. */
export async function callTool(
  url: string,
  token: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('Load request exceeded 10 seconds')),
    10_000,
  );
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...MCP_HEADERS,
        Authorization: `Bearer ${token}`,
        Origin: 'http://example.com',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': name,
      },
      body: jsonrpc(id, 'tools/call', {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'load-test', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    const payloads = response.headers.get('content-type')?.includes('text/event-stream')
      ? parseSSEEvents(text).map(({ data }) => JSON.parse(data))
      : [JSON.parse(text)];
    return {
      status: response.status,
      body: payloads.find((body) => body.id === id) ?? payloads[0],
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @fileoverview Integration tests for HTTP session management. Starts the
 * server in stateful session mode and validates session creation, reuse,
 * rejection of invalid IDs, and explicit termination via DELETE.
 * @module tests/integration/http-sessions
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initializeBody, jsonrpc, MCP_HEADERS } from '../helpers/http-helpers.js';
import { assertServerBuilt, type ServerHandle, startServer } from '../helpers/server-process.js';

const SERVER_EXISTS = existsSync(resolve(process.cwd(), 'dist/index.js'));
const PROTOCOL_VERSION = '2025-06-18';

describe.skipIf(!SERVER_EXISTS)('HTTP session management integration', () => {
  let handle: ServerHandle;

  beforeAll(async () => {
    assertServerBuilt();
    handle = await startServer('http', {
      MCP_SESSION_MODE: 'stateful',
    });
  });

  afterAll(async () => {
    await handle?.kill();
  });

  it('returns Mcp-Session-Id on initialize', async () => {
    const res = await fetch(`http://localhost:${handle.port}/mcp`, {
      body: initializeBody(),
      headers: { ...MCP_HEADERS },
      method: 'POST',
    });

    expect(res.status).toBe(200);

    const sessionId = res.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    expect(typeof sessionId).toBe('string');
    expect(sessionId!.length).toBeGreaterThan(0);
  });

  it('rejects DELETE requests without a session ID header', async () => {
    const res = await fetch(`http://localhost:${handle.port}/mcp`, {
      headers: {
        'MCP-Protocol-Version': PROTOCOL_VERSION,
      },
      method: 'DELETE',
    });

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error?: string | undefined };
    expect(body.error).toBe('Mcp-Session-Id header required');
  });

  it('accepts subsequent requests with a valid session ID', async () => {
    // Step 1: Initialize to get a session ID
    const initRes = await fetch(`http://localhost:${handle.port}/mcp`, {
      body: initializeBody(),
      headers: { ...MCP_HEADERS },
      method: 'POST',
    });
    expect(initRes.status).toBe(200);

    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    // Step 2: Send initialized notification (required by protocol before requests)
    await fetch(`http://localhost:${handle.port}/mcp`, {
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
      headers: {
        ...MCP_HEADERS,
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Session-Id': sessionId!,
      },
      method: 'POST',
    });

    // Step 3: Use the session for a tools/list request
    const listRes = await fetch(`http://localhost:${handle.port}/mcp`, {
      body: jsonrpc(2, 'tools/list', {}),
      headers: {
        ...MCP_HEADERS,
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Session-Id': sessionId!,
      },
      method: 'POST',
    });

    expect(listRes.status).toBe(200);
  });

  it('rejects non-initialize requests without a session ID with 400', async () => {
    const res = await fetch(`http://localhost:${handle.port}/mcp`, {
      body: jsonrpc(1, 'tools/list', {}),
      headers: {
        ...MCP_HEADERS,
        'MCP-Protocol-Version': PROTOCOL_VERSION,
      },
      method: 'POST',
    });

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error?: string | undefined };
    expect(body.error).toContain('Mcp-Session-Id header is required');
  });

  it('rejects GET SSE without a session ID with 400 in stateful mode', async () => {
    const res = await fetch(`http://localhost:${handle.port}/mcp`, {
      headers: {
        Accept: 'text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
      },
      method: 'GET',
    });

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error?: string | undefined };
    expect(body.error).toContain('Mcp-Session-Id header is required');
  });

  it('allows initialize requests without a session ID', async () => {
    const res = await fetch(`http://localhost:${handle.port}/mcp`, {
      body: initializeBody(),
      headers: { ...MCP_HEADERS },
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });

  it('rejects requests with an invalid session ID with 404', async () => {
    const res = await fetch(`http://localhost:${handle.port}/mcp`, {
      body: jsonrpc(1, 'tools/list', {}),
      headers: {
        ...MCP_HEADERS,
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Session-Id': 'bogus-session-id-that-does-not-exist',
      },
      method: 'POST',
    });

    expect(res.status).toBe(404);
  });

  it('terminates a session via DELETE and rejects subsequent use', async () => {
    // Step 1: Initialize to get a session ID
    const initRes = await fetch(`http://localhost:${handle.port}/mcp`, {
      body: initializeBody(),
      headers: { ...MCP_HEADERS },
      method: 'POST',
    });
    expect(initRes.status).toBe(200);

    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    // Step 2: Terminate via DELETE
    const deleteRes = await fetch(`http://localhost:${handle.port}/mcp`, {
      headers: {
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Session-Id': sessionId!,
      },
      method: 'DELETE',
    });

    expect(deleteRes.status).toBe(200);
    const deleteBody = (await deleteRes.json()) as { status?: string | undefined };
    expect(deleteBody.status).toBe('terminated');

    // Step 3: Attempt to use the terminated session — should fail
    const postRes = await fetch(`http://localhost:${handle.port}/mcp`, {
      body: jsonrpc(2, 'tools/list', {}),
      headers: {
        ...MCP_HEADERS,
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Session-Id': sessionId!,
      },
      method: 'POST',
    });

    expect(postRes.status).toBe(404);
  });
});

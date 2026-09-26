/**
 * @fileoverview End-to-end regression for SSE stream cleanup (issue #50).
 * Boots a real MCP server subprocess in stateful HTTP mode, opens SSE GET
 * streams, ungracefully aborts them (mirroring real-client disconnects that
 * never send DELETE), and asserts the server stays healthy and quiet.
 *
 * The per-request close machinery this originally guarded is gone — a session's
 * `McpServer` and transport now live for the session and are closed by
 * `SessionStore.terminate`. The abort traffic still has to leave the server
 * usable, which is what these cases pin.
 *
 * Every request goes out over `node:http` on a socket of its own rather than
 * global `fetch`: under real Node, undici can throw an uncatchable
 * `setTypeOfService EINVAL` when a write lands on a socket torn down by an
 * earlier abort — see `tests/helpers/node-http.ts`.
 * @module tests/integration/http-sse-abort
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initializeBody, MCP_HEADERS } from '../helpers/http-helpers.js';
import { exchange, openRequest } from '../helpers/node-http.js';
import { type ServerHandle, startServer } from '../helpers/server-process.js';

const PROTOCOL_VERSION = '2025-06-18';

/** Initialize a fresh stateful session and return its session id. */
async function newSession(port: number): Promise<string> {
  const init = await exchange(port, {
    method: 'POST',
    path: '/mcp',
    headers: MCP_HEADERS,
    body: initializeBody(),
  });
  if (init.status !== 200) throw new Error(`init failed: ${init.status} ${init.body}`);
  const sid = init.headers['mcp-session-id'];
  if (typeof sid !== 'string') throw new Error('no mcp-session-id on initialize response');

  // Required notifications/initialized handshake.
  await exchange(port, {
    method: 'POST',
    path: '/mcp',
    headers: { ...MCP_HEADERS, 'Mcp-Session-Id': sid, 'MCP-Protocol-Version': PROTOCOL_VERSION },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sid;
}

/** Terminates a session with DELETE and returns the status. */
async function deleteSession(port: number, sessionId: string): Promise<number> {
  const response = await exchange(port, {
    method: 'DELETE',
    path: '/mcp',
    headers: { 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': PROTOCOL_VERSION },
  });
  return response.status;
}

/** GET /healthz. */
const health = (port: number) => exchange(port, { method: 'GET', path: '/healthz' });

/** Open an SSE GET, wait until response headers, then abort the request. */
function openAndAbortSse(
  port: number,
  sessionId: string,
  holdMs = 50,
): Promise<{ status: number; contentType: string | null }> {
  return new Promise((resolve, reject) => {
    openRequest(
      port,
      {
        method: 'GET',
        path: '/mcp',
        headers: {
          Accept: 'text/event-stream',
          'Mcp-Session-Id': sessionId,
          'MCP-Protocol-Version': PROTOCOL_VERSION,
        },
      },
      (response, request) => {
        const result = {
          status: response.statusCode ?? 0,
          contentType: response.headers['content-type'] ?? null,
        };
        // The abort below surfaces on the response as an expected `aborted` error.
        response.on('error', () => {});
        response.resume();
        // Hold the stream briefly so the server actually sets up the SSE
        // handler, then ungracefully abort — matching real-client disconnect
        // behavior.
        setTimeout(() => {
          request.destroy();
          resolve(result);
        }, holdMs);
      },
      reject,
    );
  });
}

describe('HTTP SSE abort cleanup (issue #50)', () => {
  let handle: ServerHandle;
  let port: number;
  /** Combined stdout + stderr from the server subprocess. */
  let serverOutput = '';

  beforeAll(async () => {
    handle = await startServer('http', {
      MCP_SESSION_MODE: 'stateful',
      // Keep log noise low but allow warnings (close failures log at warning).
      MCP_LOG_LEVEL: 'warning',
    });
    if (!handle.port) throw new Error('expected http transport to allocate a port');
    port = handle.port;
    const capture = (chunk: Buffer): void => {
      serverOutput += chunk.toString();
    };
    handle.process.stderr?.on('data', capture);
    handle.process.stdout?.on('data', capture);
  });

  afterAll(async () => {
    await handle?.kill();
  });

  it('opens an SSE stream, aborts it, and the server stays healthy', async () => {
    const sid = await newSession(port);
    const abortResult = await openAndAbortSse(port, sid);

    expect(abortResult.status).toBe(200);
    expect(abortResult.contentType).toContain('text/event-stream');

    expect((await health(port)).status).toBe(200);
  });

  it('handles 50 SSE GET-abort cycles without breaking the server', async () => {
    // Each cycle uses a fresh session, mirroring production "stateless
    // reconnect" behavior — in production every SSE GET has its own session id
    // (mcp.sessions.active=0 across all 15 hosted servers).
    for (let i = 0; i < 50; i++) {
      const sid = await newSession(port);
      const result = await openAndAbortSse(port, sid, 20);
      expect(result.status).toBe(200);
      expect(result.contentType).toContain('text/event-stream');
    }

    const healthz = await health(port);
    expect(healthz.status).toBe(200);
    expect((JSON.parse(healthz.body) as { status: string }).status).toBe('ok');
  });

  it('logs no close failures or unhandled rejections during abort cycles', async () => {
    // Drain any deferred logger flushes from prior tests.
    await new Promise((r) => setTimeout(r, 200));

    expect(serverOutput).not.toMatch(/Failed to close a session surface/);
    expect(serverOutput).not.toMatch(/UnhandledPromiseRejection/);
  });

  it('a normal POST still works after a long sequence of SSE aborts', async () => {
    for (let i = 0; i < 10; i++) {
      const sid = await newSession(port);
      await openAndAbortSse(port, sid, 10);
    }

    // Fresh session completes the full handshake — proves per-request
    // lifecycle is not corrupted by the cleanup hook.
    const sid = await newSession(port);
    expect(sid).toBeTruthy();

    // DELETE path still functions after all the abort traffic.
    expect(await deleteSession(port, sid)).toBe(200);
  });

  it('aborting a GET against an unknown session fails-closed', async () => {
    // Stateful + unknown session id: framework returns 404 before the transport
    // sees the GET (sessionStore.isValidForIdentity check). Server stays up.
    const res = await exchange(port, {
      method: 'GET',
      path: '/mcp',
      headers: {
        Accept: 'text/event-stream',
        'Mcp-Session-Id': `not-a-real-session-${Date.now()}`,
        'MCP-Protocol-Version': PROTOCOL_VERSION,
      },
    });
    expect(res.status).toBe(404);

    expect((await health(port)).status).toBe(200);
  });

  it('concurrent SSE aborts on different sessions do not cross-contaminate', async () => {
    // Mint 10 sessions, open 10 SSE streams in parallel, abort all in parallel.
    const sessions = await Promise.all(Array.from({ length: 10 }, () => newSession(port)));
    const results = await Promise.all(sessions.map((sid) => openAndAbortSse(port, sid, 30)));

    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.contentType).toContain('text/event-stream');
    }

    // All 10 sessions can still be cleanly DELETEd post-abort.
    const deletes = await Promise.all(sessions.map((sid) => deleteSession(port, sid)));
    expect(deletes).toEqual(sessions.map(() => 200));
  });
});

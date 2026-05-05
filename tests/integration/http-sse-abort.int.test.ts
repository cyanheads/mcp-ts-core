/**
 * @fileoverview End-to-end regression for issue #50 — SSE per-request cleanup.
 * Boots a real MCP server subprocess in stateful HTTP mode, opens SSE GET
 * streams, ungracefully aborts them (mirroring real-client disconnects that
 * never send DELETE), and asserts the server stays healthy and never logs a
 * close-failure warning. Catches reintroduction of the leak path in
 * `httpTransport.ts` (skipping `closePerRequestInstances` for SSE without a
 * compensating abort hook).
 * @module tests/integration/http-sse-abort
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initializeBody, MCP_HEADERS } from '../helpers/http-helpers.js';
import { assertServerBuilt, type ServerHandle, startServer } from '../helpers/server-process.js';

const SERVER_EXISTS = existsSync(resolve(process.cwd(), 'dist/index.js'));
const PROTOCOL_VERSION = '2025-06-18';

/** Initialize a fresh stateful session and return its session id. */
async function newSession(port: number): Promise<string> {
  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: 'POST',
    headers: MCP_HEADERS,
    body: initializeBody(),
  });
  if (!res.ok) throw new Error(`init failed: ${res.status} ${await res.text()}`);
  const sid = res.headers.get('mcp-session-id');
  await res.body?.cancel();
  if (!sid) throw new Error('no mcp-session-id on initialize response');

  // Required notifications/initialized handshake.
  const notifyRes = await fetch(`http://localhost:${port}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, 'Mcp-Session-Id': sid, 'MCP-Protocol-Version': PROTOCOL_VERSION },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  await notifyRes.body?.cancel();
  return sid;
}

/** Open an SSE GET, wait until response headers, then abort the request. */
async function openAndAbortSse(
  port: number,
  sessionId: string,
  holdMs = 50,
): Promise<{ status: number; contentType: string | null }> {
  const ctrl = new AbortController();
  const fetchPromise = fetch(`http://localhost:${port}/mcp`, {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      'Mcp-Session-Id': sessionId,
      'MCP-Protocol-Version': PROTOCOL_VERSION,
    },
    signal: ctrl.signal,
  });

  const res = await fetchPromise;
  const result = { status: res.status, contentType: res.headers.get('content-type') };

  // Hold the stream briefly so the server actually sets up the SSE handler,
  // then ungracefully abort — matching real-client disconnect behavior.
  await new Promise((r) => setTimeout(r, holdMs));
  ctrl.abort();

  // Drain the body to release the underlying response (if not already aborted).
  await res.body?.cancel().catch(() => {});
  return result;
}

describe.skipIf(!SERVER_EXISTS)('HTTP SSE abort cleanup (issue #50)', () => {
  let handle: ServerHandle;
  let port: number;
  /** Combined stdout + stderr from the server subprocess. */
  let serverOutput = '';

  beforeAll(async () => {
    assertServerBuilt();
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

    const health = await fetch(`http://localhost:${port}/healthz`);
    expect(health.status).toBe(200);
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

    const health = await fetch(`http://localhost:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { status: string }).status).toBe('ok');
  });

  it('logs no close-failure warnings during abort cycles', async () => {
    // Drain any deferred logger flushes from prior tests.
    await new Promise((r) => setTimeout(r, 200));

    expect(serverOutput).not.toMatch(/Failed to close (transport|server)/);
    expect(serverOutput).not.toMatch(/mcp\.http\.close_failures/);
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
    const del = await fetch(`http://localhost:${port}/mcp`, {
      method: 'DELETE',
      headers: { 'Mcp-Session-Id': sid, 'MCP-Protocol-Version': PROTOCOL_VERSION },
    });
    expect(del.status).toBe(200);
    const body = (await del.json()) as { status: string };
    expect(body.status).toBe('terminated');
  });

  it('aborting a GET against an unknown session fails-closed', async () => {
    // Stateful + unknown session id: framework returns 404 before the transport
    // sees the GET (sessionStore.isValidForIdentity check). Server stays up.
    const ctrl = new AbortController();
    const res = await fetch(`http://localhost:${port}/mcp`, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'Mcp-Session-Id': `not-a-real-session-${Date.now()}`,
        'MCP-Protocol-Version': PROTOCOL_VERSION,
      },
      signal: ctrl.signal,
    });
    expect(res.status).toBe(404);
    await res.body?.cancel().catch(() => {});

    const health = await fetch(`http://localhost:${port}/healthz`);
    expect(health.status).toBe(200);
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
    const deletes = await Promise.all(
      sessions.map((sid) =>
        fetch(`http://localhost:${port}/mcp`, {
          method: 'DELETE',
          headers: { 'Mcp-Session-Id': sid, 'MCP-Protocol-Version': PROTOCOL_VERSION },
        }),
      ),
    );
    for (const d of deletes) {
      expect(d.status).toBe(200);
      await d.body?.cancel().catch(() => {});
    }
  });
});

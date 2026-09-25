/**
 * @fileoverview End-to-end regression for a client that disconnects while its
 * POST body is still arriving (#507). Boots a real HTTP server subprocess with
 * the default body-limit guard, sends a request that declares more body than it
 * delivers, closes the socket, and asserts the server records a cancellation —
 * info level, no stack, 499, `-32011` — rather than a `Timeout` fault.
 * @module tests/integration/http-body-disconnect
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertServerBuilt, type ServerHandle, startServer } from '../helpers/server-process.js';

/** One structured log record from the server's own log sink. */
interface LogRecord {
  level: number;
  msg: string;
  [key: string]: unknown;
}

/** Writes a POST that declares 500 body bytes, sends a fragment, then destroys the socket. */
async function sendTruncatedBody(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        'POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n' +
          'Accept: application/json, text/event-stream\r\nContent-Length: 500\r\n\r\n' +
          '{"jsonrpc":"2.0","id":1,',
      );
      setTimeout(() => socket.destroy(), 200);
    });
    socket.on('close', () => resolve());
    socket.on('error', reject);
  });
}

describe('HTTP request-body disconnect (#507)', () => {
  let handle: ServerHandle;
  let port: number;
  const logsDir = mkdtempSync(join(tmpdir(), 'mcp-ts-core-body-disconnect-'));

  /** Every structured log record the server has written so far. */
  const logRecords = (): LogRecord[] => {
    let raw: string;
    try {
      raw = readFileSync(join(logsDir, 'combined.log'), 'utf8');
    } catch {
      return [];
    }
    return raw
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as LogRecord);
  };

  beforeAll(async () => {
    assertServerBuilt();
    handle = await startServer('http', { LOGS_DIR: logsDir, MCP_LOG_LEVEL: 'info' });
    if (!handle.port) throw new Error('expected http transport to allocate a port');
    port = handle.port;
  });

  afterAll(async () => {
    await handle?.kill();
    rmSync(logsDir, { force: true, recursive: true });
  });

  it('records the disconnect as a cancellation: info, no stack, 499, -32011', async () => {
    await sendTruncatedBody(port);

    const isResponseRecord = (r: LogRecord) =>
      r.operation === 'httpErrorHandler' &&
      r.msg === 'Sending formatted error response for request.';
    const deadline = Date.now() + 5_000;
    while (!logRecords().some(isResponseRecord) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const records = logRecords();
    const cancelled = records.find((r) => r.msg === 'Cancelled httpTransport: aborted');
    expect(cancelled?.level).toBe(30);
    expect(JSON.stringify(cancelled)).not.toMatch(/"stack"|originalStack|causeChain/);
    expect(records.filter((r) => r.level >= 50)).toEqual([]);
    expect(records.find(isResponseRecord)).toMatchObject({ status: 499, errorCode: -32011 });

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
  });
});

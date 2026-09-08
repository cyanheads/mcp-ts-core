/**
 * @fileoverview Regression coverage for the shell helper embedded in
 * `skills/field-test/SKILL.md` (issue #391). `mcp_init` used to treat a missing
 * `Mcp-Session-Id` header as fatal, so a server running under
 * `MCP_SESSION_MODE=stateless` — which completes a valid 2025-era
 * initialization without minting a session — could not be field-tested at all,
 * and `mcp_call` rejected the empty `sid` that mode produces.
 *
 * The helper is extracted from the skill body itself, so the assertions run
 * against exactly the script an agent pastes. Stub servers stand in for the
 * response shapes that matter; no MCP server is started.
 *
 * @module tests/unit/skills/field-test-helper.test
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const SKILL_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../skills/field-test/SKILL.md',
);

const PROTOCOL = '2025-11-25';
const SESSION_ID = 'sess-abc123';

/** Response shapes a real deployment can produce for `initialize`. */
type StubMode =
  | 'http-500'
  | 'no-protocol'
  | 'rpc-error'
  | 'sse-stateless'
  | 'stateful'
  | 'stateless';

interface Recorded {
  body: string;
  headers: Record<string, string | undefined>;
}

interface Stub {
  close: () => Promise<void>;
  requests: Recorded[];
  url: string;
}

const initializeResult = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: PROTOCOL,
      capabilities: {},
      serverInfo: { name: 'stub', version: '0.0.0' },
      ...extra,
    },
  });

async function startStub(mode: StubMode): Promise<Stub> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      requests.push({ body: raw, headers: { ...req.headers } as Recorded['headers'] });
      const method = /"method":"([^"]*)"/.exec(raw)?.[1];

      if (method !== 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 7, result: { tools: [] } }));
        return;
      }

      switch (mode) {
        case 'stateful':
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': SESSION_ID,
          });
          res.end(initializeResult());
          return;
        case 'stateless':
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(initializeResult());
          return;
        case 'sse-stateless':
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(`event: message\ndata: ${initializeResult()}\n\n`);
          return;
        case 'rpc-error':
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              error: { code: -32600, message: 'Unsupported protocol version' },
            }),
          );
          return;
        case 'http-500':
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('internal error');
          return;
        case 'no-protocol':
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }));
          return;
      }
    });
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    close: () => new Promise<void>((done) => server.close(() => done())),
    requests,
    url: `http://127.0.0.1:${port}/mcp`,
  };
}

let helperPath: string;
let workDir: string;
const stubs: Stub[] = [];

/**
 * Runs helper functions in a fresh bash shell, exactly as the skill sources
 * them. Async on purpose: the stub servers share this process's event loop, so
 * a synchronous spawn would deadlock against the curl calls it is waiting on.
 */
function run(script: string): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((settle) => {
    const child = spawn('bash', ['-c', `. "${helperPath}"\n${script}`]);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (code: number | null) => settle({ code: code ?? -1, stderr, stdout }));
  });
}

async function stub(mode: StubMode): Promise<Stub> {
  const started = await startStub(mode);
  stubs.push(started);
  return started;
}

beforeAll(() => {
  const skill = readFileSync(SKILL_PATH, 'utf-8');
  const body = /<<'HELPER_EOF'\n([\s\S]*?)\nHELPER_EOF/.exec(skill)?.[1];
  if (!body) throw new Error('field-test SKILL.md no longer embeds a HELPER_EOF block');
  workDir = mkdtempSync(resolve(tmpdir(), 'field-test-helper-'));
  helperPath = resolve(workDir, 'helper.sh');
  writeFileSync(helperPath, `${body}\n`);
});

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((entry) => entry.close()));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('field-test helper · mcp_init (#391)', () => {
  it('initializes a stateful server and threads the session onward', async () => {
    const server = await stub('stateful');
    const { code, stdout } = await run(`mcp_init ${server.url}`);

    expect(code).toBe(0);
    expect(stdout).toContain(`sid=${SESSION_ID}`);
    expect(stdout).toContain(`protocol=${PROTOCOL}`);
    expect(server.requests[1]?.body).toContain('notifications/initialized');
    expect(server.requests[1]?.headers['mcp-session-id']).toBe(SESSION_ID);
  });

  it('accepts a successful initialize that mints no session', async () => {
    const server = await stub('stateless');
    const { code, stdout } = await run(`mcp_init ${server.url}`);

    expect(code).toBe(0);
    expect(stdout).toContain('sid= ');
    expect(stdout).toContain(`protocol=${PROTOCOL}`);
    // No session to carry the negotiation — the header does it instead.
    expect(server.requests[1]?.headers['mcp-session-id']).toBeUndefined();
    expect(server.requests[1]?.headers['mcp-protocol-version']).toBe(PROTOCOL);
  });

  it('accepts a sessionless SSE initialize result', async () => {
    const server = await stub('sse-stateless');
    const { code, stdout } = await run(`mcp_init ${server.url}`);

    expect(code).toBe(0);
    expect(stdout).toContain(`protocol=${PROTOCOL}`);
    expect(stdout).toContain('sid= ');
  });

  it('fails visibly on a JSON-RPC error', async () => {
    const server = await stub('rpc-error');
    const { code, stderr } = await run(`mcp_init ${server.url}`);

    expect(code).not.toBe(0);
    expect(stderr).toContain('JSON-RPC error');
    expect(stderr).toContain('Unsupported protocol version');
    expect(server.requests).toHaveLength(1);
  });

  it('fails visibly on a non-success HTTP response', async () => {
    const server = await stub('http-500');
    const { code, stderr } = await run(`mcp_init ${server.url}`);

    expect(code).not.toBe(0);
    expect(stderr).toContain('HTTP 500');
  });

  it('fails visibly when the result carries no negotiated version', async () => {
    const server = await stub('no-protocol');
    const { code, stderr } = await run(`mcp_init ${server.url}`);

    expect(code).not.toBe(0);
    expect(stderr).toContain('no protocolVersion');
  });

  it('fails visibly when nothing is listening', async () => {
    const server = await stub('stateless');
    const dead = server.url;
    await server.close();
    stubs.splice(0);

    const { code, stderr } = await run(`mcp_init ${dead}`);
    expect(code).not.toBe(0);
    expect(stderr).toContain('transport failure');
  });
});

describe('field-test helper · mcp_call (#391)', () => {
  it('calls without a session id and carries the negotiated protocol', async () => {
    const server = await stub('stateless');
    const { code, stdout } = await run(`mcp_call ${server.url} '' tools/list '' ${PROTOCOL}`);

    expect(code).toBe(0);
    expect(stdout).toContain('"result"');
    expect(server.requests[0]?.headers['mcp-session-id']).toBeUndefined();
    expect(server.requests[0]?.headers['mcp-protocol-version']).toBe(PROTOCOL);
  });

  it('still sends the session header when a session exists', async () => {
    const server = await stub('stateful');
    const { code } = await run(`mcp_call ${server.url} ${SESSION_ID} tools/list`);

    expect(code).toBe(0);
    expect(server.requests[0]?.headers['mcp-session-id']).toBe(SESSION_ID);
    expect(server.requests[0]?.headers['mcp-protocol-version']).toBeUndefined();
  });

  it('still rejects a missing url or method', async () => {
    expect((await run(`mcp_call '' '' tools/list`)).code).not.toBe(0);
    expect((await run(`mcp_call http://127.0.0.1:1/mcp '' ''`)).code).not.toBe(0);
  });
});

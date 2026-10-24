/**
 * @fileoverview HTTP shutdown drain, observed on a real process. A `SIGTERM`
 * with a request in flight aborts it and exits without reaching the 5 s drain
 * timeout, whichever arm serves it (#757); a request that arrives on an open
 * connection once shutdown has begun gets a retryable `503` that closes its
 * socket, while a new connection is refused at TCP (#749).
 *
 * Every wait is on an observed event (a stub upstream receiving the call, a
 * log line, a response, a socket closing), never on elapsed time. "Without the
 * drain timeout" is read from the shutdown trace: the warning that timer logs
 * is absent and the server reports a clean close.
 *
 * The fixture is written per run to a temp directory and imports the built
 * package by file URL, so it runs on whichever runtime hosts this lane.
 * @module tests/integration/http-shutdown-drain.int.test
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Agent, createServer, type IncomingMessage, request, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getFreePort } from '../helpers/server-process.js';

const PACKAGE_ENTRY = pathToFileURL(resolve(process.cwd(), 'dist/core/index.js')).href;
const READY_LINE = 'is now running and ready.';
/** Logged in the same tick that enters draining, before anything is aborted. */
const STOP_STARTED = 'Attempting to stop http transport';
/** Logged once `server.close()` has been called. */
const STOPPED_ACCEPTING = 'HTTP server stopped accepting connections';
const DRAIN_TIMEOUT = 'Drain timeout reached';
const CLEAN_CLOSE = 'HTTP server closed successfully.';
const HANDLER_CLOSED = 'This MCP handler has been closed';
const READY_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 20_000;

/** A server with one tool that awaits an upstream (`STUB_URL`) which never answers. */
const FIXTURE = `
import { createApp, tool, z } from ${JSON.stringify(PACKAGE_ENTRY)};

const hang = tool('hang', {
  description: 'Awaits an upstream that never answers.',
  input: z.object({}),
  output: z.object({ ok: z.boolean().describe('Whether the upstream answered.') }),
  async handler(_input, ctx) {
    await fetch(process.env.STUB_URL, { signal: ctx.signal });
    return { ok: true };
  },
});

await createApp({ name: 'http-shutdown-drain-fixture', version: '0.0.0-test', tools: [hang] });
`;

type SessionMode = 'stateful' | 'stateless';

const LEGACY_HEADERS = {
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
  'mcp-protocol-version': '2025-06-18',
};

const MODERN_HEADERS = {
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
  'mcp-protocol-version': '2026-07-28',
  'mcp-method': 'tools/call',
  'mcp-name': 'hang',
};

const legacyCall = (id: number) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'hang', arguments: {} },
  });

const modernCall = (id: number) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: 'hang',
      arguments: {},
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'drain-test', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  });

const initialize = (id: number) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'drain-test', version: '1.0.0' },
    },
  });

interface Run {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  port: number;
  stderr(): string;
  /** Resolves once stderr contains `text`; rejects if the process exits first. */
  waitFor(text: string): Promise<void>;
}

/** An upstream that accepts each request and never answers it. */
interface Stub {
  /** Resolves when the next request arrives, with a promise of that request's socket closing. */
  nextRequest(): Promise<{ closed: Promise<void> }>;
  url: string;
}

/** A keep-alive client response, read to its end. */
interface ClientExchange {
  /** Resolves once the socket under the response closes. */
  closed: Promise<void>;
  /** Resolves once the whole body is read. */
  ended: Promise<string>;
  response: IncomingMessage;
}

describe('HTTP shutdown drain on a real process', () => {
  let fixtureDir: string;
  let fixturePath: string;
  let stubServer: Server;
  let stub: Stub;
  const children: ChildProcess[] = [];
  const agents: Agent[] = [];
  const sockets: Socket[] = [];

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'mcp-http-shutdown-drain-'));
    fixturePath = join(fixtureDir, 'server.mjs');
    await writeFile(fixturePath, FIXTURE, 'utf8');

    const waiters: Array<(arrival: { closed: Promise<void> }) => void> = [];
    stubServer = createServer((req) => {
      const closed = new Promise<void>((settle) => req.socket.once('close', () => settle()));
      waiters.shift()?.({ closed });
    });
    await new Promise<void>((settle) => stubServer.listen(0, '127.0.0.1', settle));
    const address = stubServer.address();
    if (typeof address !== 'object' || !address) throw new Error('stub has no address');
    stub = {
      url: `http://127.0.0.1:${address.port}/never`,
      nextRequest: () => new Promise((settle) => waiters.push(settle)),
    };
  });

  afterAll(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    for (const agent of agents) agent.destroy();
    for (const socket of sockets) socket.destroy();
    stubServer.closeAllConnections();
    await new Promise<void>((settle) => stubServer.close(() => settle()));
    await rm(fixtureDir, { force: true, recursive: true });
  });

  async function start(mode: SessionMode): Promise<Run> {
    const port = await getFreePort();
    const child = spawn(process.execPath, [fixturePath], {
      cwd: fixtureDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MCP_HTTP_HOST: '127.0.0.1',
        MCP_HTTP_PORT: String(port),
        MCP_LOG_LEVEL: 'info',
        MCP_SESSION_MODE: mode,
        MCP_TRANSPORT_TYPE: 'http',
        // The logger installs no stderr sink under `testing`, and stderr is
        // where the shutdown trace this suite reads has to appear.
        NODE_ENV: 'development',
        STUB_URL: stub.url,
      },
    });
    children.push(child);
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdout?.resume();
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle) => {
      child.once('exit', (code, signal) => settle({ code, signal }));
    });
    const waitFor = (text: string) =>
      new Promise<void>((found, failed) => {
        const check = () => {
          if (!stderr.includes(text)) return;
          child.stderr?.off('data', check);
          found();
        };
        child.stderr?.on('data', check);
        void exited.then(() =>
          stderr.includes(text)
            ? found()
            : failed(new Error(`exited before "${text}":\n${stderr}`)),
        );
        check();
      });
    await waitFor(READY_LINE);
    return { child, exited, port, stderr: () => stderr, waitFor };
  }

  /** A keep-alive agent with one socket, so a later request reuses an idle one. */
  function keepAliveAgent(): Agent {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    agents.push(agent);
    return agent;
  }

  /** Sends one request over `agent` and resolves once its response headers arrive. */
  function send(
    run: Run,
    agent: Agent,
    spec: { body?: string; headers?: Record<string, string>; method: 'GET' | 'POST' },
  ): Promise<ClientExchange> {
    return new Promise((settle, fail) => {
      const headers = {
        ...spec.headers,
        ...(spec.body !== undefined && { 'content-length': String(Buffer.byteLength(spec.body)) }),
      };
      const req = request(
        { agent, headers, host: '127.0.0.1', method: spec.method, path: '/mcp', port: run.port },
        (response) => {
          const socket = response.socket;
          const closed = new Promise<void>((done) => socket.once('close', () => done()));
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;
          });
          const ended = new Promise<string>((done) => {
            response.once('end', () => done(body));
            response.once('error', () => done(body));
            response.once('close', () => done(body));
          });
          settle({ closed, ended, response });
        },
      );
      req.on('error', fail);
      req.end(spec.body);
    });
  }

  /** Opens a session on the stateful arm and returns its id. */
  async function openSession(run: Run): Promise<string> {
    const exchange = await send(run, keepAliveAgent(), {
      method: 'POST',
      headers: LEGACY_HEADERS,
      body: initialize(1),
    });
    await exchange.ended;
    const sessionId = exchange.response.headers['mcp-session-id'];
    if (typeof sessionId !== 'string') throw new Error('initialize returned no Mcp-Session-Id');
    return sessionId;
  }

  /** Sends `SIGTERM` and asserts a clean exit that never reached the drain timeout. */
  async function expectCleanStop(run: Run): Promise<void> {
    run.child.kill('SIGTERM');
    expect(await run.exited).toEqual({ code: 0, signal: null });
    expect(run.stderr()).toContain(CLEAN_CLOSE);
    expect(run.stderr()).not.toContain(DRAIN_TIMEOUT);
    expect(run.stderr()).not.toContain(HANDLER_CLOSED);
  }

  describe('a request in flight at SIGTERM is aborted without the drain timeout (#757)', () => {
    it.each<[SessionMode]>([['stateless'], ['stateful']])(
      'a 2026-07-28 call (%s) ends with a 499 that closes its socket',
      async (mode) => {
        const run = await start(mode);
        const upstream = stub.nextRequest();
        const pending = send(run, keepAliveAgent(), {
          method: 'POST',
          headers: MODERN_HEADERS,
          body: modernCall(2),
        });
        const { closed: upstreamClosed } = await upstream;

        await expectCleanStop(run);
        const exchange = await pending;
        expect({
          status: exchange.response.statusCode,
          connection: exchange.response.headers.connection,
        }).toEqual({ status: 499, connection: 'close' });
        await exchange.closed;
        await upstreamClosed;
      },
      EXIT_TIMEOUT_MS + READY_TIMEOUT_MS,
    );

    it(
      'a stateless 2025-era call has its ctx.signal aborted, its upstream fetch cancelled, and its stream ended',
      async () => {
        const run = await start('stateless');
        const upstream = stub.nextRequest();
        const exchange = await send(run, keepAliveAgent(), {
          method: 'POST',
          headers: LEGACY_HEADERS,
          body: legacyCall(2),
        });
        const { closed: upstreamClosed } = await upstream;
        expect(exchange.response.statusCode).toBe(200);

        await expectCleanStop(run);
        await upstreamClosed;
        await exchange.ended;
        await exchange.closed;
      },
      EXIT_TIMEOUT_MS + READY_TIMEOUT_MS,
    );

    it(
      'a stateful 2025-era call still exits cleanly',
      async () => {
        const run = await start('stateful');
        const sessionId = await openSession(run);
        const upstream = stub.nextRequest();
        const exchange = await send(run, keepAliveAgent(), {
          method: 'POST',
          headers: { ...LEGACY_HEADERS, 'mcp-session-id': sessionId },
          body: legacyCall(2),
        });
        const { closed: upstreamClosed } = await upstream;

        await expectCleanStop(run);
        await upstreamClosed;
        await exchange.ended;
      },
      EXIT_TIMEOUT_MS + READY_TIMEOUT_MS,
    );

    it(
      'an idle keep-alive socket still exits cleanly',
      async () => {
        const run = await start('stateless');
        const agent = keepAliveAgent();
        const exchange = await send(run, agent, { method: 'GET', headers: {} });
        await exchange.ended;
        expect(exchange.response.headers.connection).toBe('keep-alive');

        await expectCleanStop(run);
        await exchange.closed;
      },
      EXIT_TIMEOUT_MS + READY_TIMEOUT_MS,
    );

    it(
      'no connection at all still exits cleanly',
      async () => {
        const run = await start('stateful');
        await expectCleanStop(run);
      },
      EXIT_TIMEOUT_MS + READY_TIMEOUT_MS,
    );
  });

  describe('a request on an open connection during shutdown gets a retryable 503 (#749)', () => {
    /** A raw socket whose request is sent up to, but not including, its last body byte. */
    interface HeldRequest {
      /** Sends the last body byte; resolves with the raw response once the server closes the socket. */
      finish(): Promise<string>;
    }

    /**
     * Opens a connection, proves the server accepted it with a complete
     * `/healthz` exchange, then sends `body`'s request short of its last byte
     * and waits for the server's `100 Continue`. Until the server has parsed a
     * request head the socket is idle, and stop closes idle sockets — so
     * without that interim reply, a `SIGTERM` sent right after the write can
     * win the race and the request never reaches the drain gate.
     */
    async function hold(
      run: Run,
      headers: Record<string, string>,
      body: string,
    ): Promise<HeldRequest> {
      const socket = connect(run.port, '127.0.0.1');
      sockets.push(socket);
      socket.setEncoding('utf8');
      let received = '';
      socket.on('data', (chunk: string) => {
        received += chunk;
      });
      const closed = new Promise<void>((settle) => socket.once('close', () => settle()));
      await new Promise<void>((settle) => socket.once('connect', () => settle()));

      const receive = (text: string) =>
        new Promise<void>((settle) => {
          const check = () => {
            if (!received.includes(text)) return;
            socket.off('data', check);
            settle();
          };
          socket.on('data', check);
          check();
        });

      socket.write('GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      await receive('{"status":"ok"}');
      received = '';

      const head = [
        'POST /mcp HTTP/1.1',
        'Host: 127.0.0.1',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        'Expect: 100-continue',
        `Content-Length: ${Buffer.byteLength(body)}`,
        '',
        '',
      ].join('\r\n');
      socket.write(head + body.slice(0, -1));
      await receive('HTTP/1.1 100 Continue\r\n\r\n');
      received = '';
      return {
        finish: async () => {
          socket.write(body.slice(-1));
          await closed;
          return received;
        },
      };
    }

    /** The parts of a raw HTTP/1.1 response a caller and its socket act on. */
    function parse(raw: string) {
      const [head = '', body = ''] = raw.split('\r\n\r\n');
      const [statusLine = '', ...lines] = head.split('\r\n');
      const headers = Object.fromEntries(
        lines.map((line) => {
          const at = line.indexOf(':');
          return [line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()];
        }),
      );
      return {
        status: Number(statusLine.split(' ')[1]),
        retryAfter: headers['retry-after'],
        connection: headers.connection,
        error: (JSON.parse(body) as { error: { code: number } }).error.code,
      };
    }

    const REFUSAL = { status: 503, retryAfter: '1', connection: 'close', error: -32000 };

    /** Resolves with the error code of a connection attempt that fails, or `'connected'`. */
    const tryConnect = (port: number) =>
      new Promise<string>((settle) => {
        const socket = connect(port, '127.0.0.1');
        sockets.push(socket);
        socket.once('connect', () => settle('connected'));
        socket.once('error', (error: NodeJS.ErrnoException) => settle(error.code ?? 'error'));
      });

    it.each<[SessionMode]>([['stateless'], ['stateful']])(
      'refuses every request finished after SIGTERM and closes its socket (%s)',
      async (mode) => {
        const run = await start(mode);
        const sessionId = mode === 'stateful' ? await openSession(run) : undefined;

        const held = [
          await hold(run, LEGACY_HEADERS, legacyCall(3)),
          await hold(run, MODERN_HEADERS, modernCall(4)),
          ...(sessionId
            ? [
                await hold(run, { ...LEGACY_HEADERS, 'mcp-session-id': sessionId }, legacyCall(5)),
                await hold(run, LEGACY_HEADERS, initialize(6)),
              ]
            : []),
        ];
        const last = await hold(run, LEGACY_HEADERS, legacyCall(7));

        run.child.kill('SIGTERM');
        await run.waitFor(STOP_STARTED);
        for (const request of held) expect(parse(await request.finish())).toEqual(REFUSAL);

        await run.waitFor(STOPPED_ACCEPTING);
        expect(await tryConnect(run.port)).toBe('ECONNREFUSED');

        expect(parse(await last.finish())).toEqual(REFUSAL);
        expect(await run.exited).toEqual({ code: 0, signal: null });
        expect(run.stderr()).toContain(CLEAN_CLOSE);
        expect(run.stderr()).not.toContain(DRAIN_TIMEOUT);
        expect(run.stderr()).not.toContain(HANDLER_CLOSED);
      },
      EXIT_TIMEOUT_MS + READY_TIMEOUT_MS,
    );
  });
});

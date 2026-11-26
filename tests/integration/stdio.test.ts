/**
 * @fileoverview Integration tests for the stdio transport. Spawns a real server
 * subprocess and drives it via the official MCP SDK client over stdio pipes.
 * @module tests/integration/stdio
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  expectDefaultServerCapabilities,
  expectDefaultServerDiscoverySurface,
  expectDefaultServerLoggingSurface,
  expectDefaultServerProtocolErrors,
  expectDefaultServerSubscriptionSurface,
} from '../helpers/default-server-mcp.js';
import { getFreePort } from '../helpers/server-process.js';
import { parseLogLines, runStdioSession } from '../helpers/stdio-session.js';

const DIST_INDEX = resolve(process.cwd(), 'dist/index.js');

describe('Stdio transport integration', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'node',
      args: [DIST_INDEX],
      env: {
        ...process.env,
        MCP_LOG_LEVEL: 'error',
        MCP_TRANSPORT_TYPE: 'stdio',
      },
    });

    client = new Client({ name: 'stdio-integration', version: '1.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    try {
      await client?.close();
    } catch {
      // Client may already be closed or process exited
    }
  });

  it('advertises the expected MCP capabilities', () => {
    expectDefaultServerCapabilities(client);
  });

  it('returns empty tool, resource, and prompt lists for the default server', async () => {
    await expectDefaultServerDiscoverySurface(client);
  });

  it('returns MCP not-found behavior for missing tools, resources, and prompts', async () => {
    await expectDefaultServerProtocolErrors(client);
  });

  it('resolves logging and resource-subscription operations', async () => {
    await expectDefaultServerLoggingSurface(client);
    await expectDefaultServerSubscriptionSurface(client);
  });
});

/** Outcome of a server run ended by stdin EOF or by a signal. */
interface TerminatedRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  /** `true` when the child was still alive when the wait window expired. */
  stillAlive: boolean;
}

const READY_LINE = 'is now running and ready';
const READY_TIMEOUT_MS = 15_000;
/**
 * Outlasts the framework's 10 s shutdown ceiling, so a run the ceiling ends is
 * observed exiting with its `did not settle` warning on stderr, not cut off
 * here as merely still alive.
 */
const EXIT_TIMEOUT_MS = 15_000;

/**
 * Resolves once `seen()` holds, polling the output a child has written so far;
 * rejects with its stderr if the child exits or the ready window passes first.
 */
async function waitFor(
  what: string,
  seen: () => boolean,
  child: ChildProcess,
  stderr: () => string,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!seen()) {
    if (Date.now() > deadline || child.exitCode !== null) {
      throw new Error(`never saw ${what}:\n${stderr()}`);
    }
    await new Promise((tick) => setTimeout(tick, 20));
  }
}

/** How a booted server is told to stop. */
type Terminator = (child: ChildProcess) => void;

/** Closes the child's stdin — a host that stops talking without signalling. */
const closeStdin: Terminator = (child) => child.stdin?.end();

/** Sends a signal, leaving stdin open so the EOF path cannot fire first. */
const sendSignal =
  (signal: NodeJS.Signals): Terminator =>
  (child) => {
    child.kill(signal);
  };

/**
 * Boots a server entry point over piped stdio, waits for the ready line, then
 * terminates it and reports how the process ended.
 *
 * Deliberately not routed through `tests/helpers/server-process.ts`: its
 * `killProcess` escalates to `SIGKILL` three seconds after `SIGTERM`, which is
 * exactly the failure these cases have to be able to observe (#435).
 */
async function runUntilTerminated(
  terminate: Terminator,
  { entry = DIST_INDEX, nodeArgs = [] }: { entry?: string; nodeArgs?: readonly string[] } = {},
): Promise<TerminatedRun> {
  const child = spawn('node', [...nodeArgs, entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MCP_LOG_LEVEL: 'info',
      MCP_TRANSPORT_TYPE: 'stdio',
      // The logger installs no stderr sink under `testing`, and stderr is where
      // the shutdown trace this suite reads has to appear.
      NODE_ENV: 'development',
    },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stderr = '';
  let stdout = '';
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });

  try {
    await new Promise<void>((ready, failed) => {
      const timer = setTimeout(
        () => failed(new Error(`server never became ready:\n${stderr}`)),
        READY_TIMEOUT_MS,
      );
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.includes(READY_LINE)) {
          clearTimeout(timer);
          ready();
        }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        failed(new Error(`server exited before it was ready:\n${stderr}`));
      });
    });

    terminate(child);

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null } | null>(
      (settle) => {
        const timer = setTimeout(() => settle(null), EXIT_TIMEOUT_MS);
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          settle({ code, signal });
        });
      },
    );

    return {
      code: exit?.code ?? null,
      signal: exit?.signal ?? null,
      stderr,
      stdout,
      stillAlive: exit === null,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

describe('Stdio transport stdin EOF', () => {
  it('runs the graceful shutdown path and exits when the client closes stdin', async () => {
    const run = await runUntilTerminated(closeStdin);

    expect(run.stillAlive).toBe(false);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('Initiating graceful shutdown');
    expect(run.stderr).toContain('Stdio transport stopped successfully.');
    expect(run.stderr).toContain('Graceful shutdown completed successfully.');
    expect(run.stderr).toContain('Logger shutting down.');
    // stdout carries JSON-RPC and nothing else; this run exchanges no messages.
    expect(run.stdout).toBe('');
  });

  it('exits on stdin EOF even with a non-unref()ed handle registered', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-stdio-eof-'));
    const preload = join(dir, 'ref-timer.mjs');
    await writeFile(preload, 'setInterval(() => {}, 60_000);\n', 'utf8');

    try {
      const run = await runUntilTerminated(closeStdin, {
        nodeArgs: ['--import', pathToFileURL(preload).href],
      });

      expect(run.stillAlive).toBe(false);
      expect(run.code).toBe(0);
      expect(run.stderr).toContain('Graceful shutdown completed successfully.');
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

/**
 * Stdin EOF while a request is still running. The client has hung up, so the
 * request is aborted rather than answered, and the transport closing itself on
 * EOF must not start a second shutdown or report the already-closed connection
 * as a failure.
 */
describe('Stdio transport stdin EOF with a request in flight', () => {
  const INFLIGHT_ENTRY = resolve(process.cwd(), 'tests/fixtures/stdio-inflight-server.js');

  it('aborts the handler, writes no response for it, and shuts down exactly once', async () => {
    const child = spawn('node', [INFLIGHT_ENTRY], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MCP_LOG_LEVEL: 'debug',
        MCP_TRANSPORT_TYPE: 'stdio',
        NODE_ENV: 'development',
      },
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle) => {
      child.once('exit', (code, signal) => settle({ code, signal }));
    });

    const waitForOutput = (what: string, seen: () => boolean): Promise<void> =>
      waitFor(what, seen, child, () => stderr);
    const send = (message: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };
    const stdoutMessages = (): Array<{ id?: unknown }> =>
      stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id?: unknown });

    try {
      await waitForOutput('the ready line', () => stderr.includes(READY_LINE));
      send({
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'stdio-inflight', version: '1.0.0' },
        },
      });
      await waitForOutput('the initialize result', () => stdoutMessages().some((m) => m.id === 1));
      send({ method: 'notifications/initialized' });
      send({ id: 2, method: 'tools/call', params: { name: 'wait_for_abort', arguments: {} } });
      await waitForOutput('the handler start', () => stderr.includes('wait_for_abort started'));

      child.stdin.end();
      const exit = await Promise.race([
        exited,
        new Promise<null>((settle) => setTimeout(() => settle(null), EXIT_TIMEOUT_MS)),
      ]);

      const records = parseLogLines(stderr);
      const count = (msg: string): number => records.filter((record) => record.msg === msg).length;

      expect(exit).toEqual({ code: 0, signal: null });
      // The handler saw the abort; the wire carried no answer to the abandoned call.
      expect(records).toContainEqual(
        expect.objectContaining({ msg: 'wait_for_abort observed abort', aborted: true }),
      );
      const responseIds = stdoutMessages()
        .filter((message) => 'id' in message)
        .map((message) => message.id);
      expect(responseIds).toEqual([1]);
      // One shutdown, one transport stop, and nothing reported as a failure.
      expect(count('Received STDIN_EOF. Initiating graceful shutdown...')).toBe(1);
      expect(count('Stdio transport stopped successfully.')).toBe(1);
      expect(count('Graceful shutdown completed successfully.')).toBe(1);
      expect(records.filter((record) => Number(record.level) >= 40)).toEqual([]);
      expect(
        records.filter((record) => String(record.msg).startsWith('Stdio transport reported')),
      ).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});

describe('Stdio transport signal shutdown (#435)', () => {
  it('runs the graceful shutdown path and exits 0 on SIGTERM', async () => {
    const run = await runUntilTerminated(sendSignal('SIGTERM'));

    expect(run.stillAlive).toBe(false);
    // The ceiling names the step that never settled before it exits 1.
    expect(run.stderr).not.toContain('did not settle');
    expect(run.code).toBe(0);
    expect(run.signal).toBeNull();
    expect(run.stderr).toContain('Initiating graceful shutdown');
    expect(run.stderr).toContain('Graceful shutdown completed successfully.');
    expect(run.stdout).toBe('');
  });

  it('exits on SIGTERM even with a non-unref()ed handle registered', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-stdio-signal-'));
    const preload = join(dir, 'ref-timer.mjs');
    await writeFile(preload, 'setInterval(() => {}, 60_000);\n', 'utf8');

    try {
      const run = await runUntilTerminated(sendSignal('SIGTERM'), {
        nodeArgs: ['--import', pathToFileURL(preload).href],
      });

      expect(run.stillAlive).toBe(false);
      expect(run.stderr).not.toContain('did not settle');
      expect(run.code).toBe(0);
      expect(run.stderr).toContain('Graceful shutdown completed successfully.');
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it('releases a setup()-owned handle through teardown() and exits without the ceiling firing', async () => {
    const run = await runUntilTerminated(sendSignal('SIGTERM'), {
      entry: resolve(process.cwd(), 'tests/fixtures/teardown-server.js'),
    });

    expect(run.stillAlive).toBe(false);
    expect(run.stderr).not.toContain('did not settle');
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('teardown fixture released its handle.');
    expect(run.stderr).toContain('Graceful shutdown completed successfully.');
  });

  it('exits 0 on SIGINT', async () => {
    const run = await runUntilTerminated(sendSignal('SIGINT'));

    expect(run.stillAlive).toBe(false);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('Graceful shutdown completed successfully.');
  });
});

/**
 * What reaches stdout. On stdio it carries JSON-RPC messages and nothing else:
 * console output goes to stderr, from `setup()`, a handler, or a dependency,
 * under concurrent calls too, and each message is one line however a client
 * splits lines. Under HTTP the console is left as it is.
 */
describe('Stdio transport stdout', () => {
  const WIRE_ENTRY = resolve(process.cwd(), 'tests/fixtures/stdio-wire-server.js');
  const STARTUP_LINE = 'stdio-wire-fixture: console.log once the transport is up';
  /** What the fixture's `setup()` writes, before any transport exists. */
  const SETUP_LINES = [
    'stdio-wire-fixture: console.log in setup()',
    'stdio-wire-fixture: console.info in setup()',
  ];
  const STDIO_ENV = { MCP_LOG_LEVEL: 'error', MCP_TRANSPORT_TYPE: 'stdio' };
  const LS = String.fromCodePoint(0x2028);
  const PS = String.fromCodePoint(0x2029);
  /** Both separators raw, beside a backslash followed by `u2028`, which stays text. */
  const SEPARATED_TEXT = `line${LS}separator${PS}paragraph, and \\u2028 as text`;

  const isJsonRpc = (line: string): boolean => {
    try {
      return (JSON.parse(line) as { jsonrpc?: unknown }).jsonrpc === '2.0';
    } catch {
      return false;
    }
  };
  const logAndExtract = (label: string, peers: number) => ({
    method: 'tools/call',
    params: { name: 'log_and_extract', arguments: { label, peers } },
  });
  /** The `console.log`, `console.info`, and `console.debug` lines a `log_and_extract` call writes. */
  const consoleLines = (label: string): string[] =>
    ['before', 'after'].flatMap((phase) =>
      ['log', 'info', 'debug'].map((method) => `console.${method} ${label} ${phase}`),
    );

  it('keeps console output from setup() off stdout', async () => {
    const run = await runStdioSession({ entry: WIRE_ENTRY, env: STDIO_ENV });

    expect(run.code).toBe(0);
    expect(run.stdoutLines.filter((line) => !isJsonRpc(line))).toEqual([]);
    for (const line of SETUP_LINES) {
      expect(run.stderr).toContain(line);
    }
  });

  it('keeps console output, Defuddle debug output included, off stdout', async () => {
    const run = await runStdioSession({
      entry: WIRE_ENTRY,
      env: STDIO_ENV,
      requests: [logAndExtract('solo', 1)],
    });

    expect(run.code).toBe(0);
    expect(run.responses[0]?.result?.structuredContent).toEqual({
      label: 'solo',
      title: 'Fixture',
    });
    expect(run.stdoutLines.filter((line) => !isJsonRpc(line))).toEqual([]);
    for (const line of [...consoleLines('solo'), STARTUP_LINE, 'Defuddle:']) {
      expect(run.stderr).toContain(line);
    }
  });

  it('keeps console output off stdout with two calls in flight at once', async () => {
    const child = spawn(process.execPath, [WIRE_ENTRY], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...STDIO_ENV },
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((settle) => {
      child.once('exit', (code) => settle(code));
    });
    const lines = (): string[] => stdout.split('\n').filter(Boolean);
    const answered = (id: number): boolean =>
      lines().some((line) => isJsonRpc(line) && (JSON.parse(line) as { id?: unknown }).id === id);
    const send = (message: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };

    try {
      send({
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'stdio-wire', version: '1.0.0' },
        },
      });
      await waitFor(
        'the initialize result',
        () => answered(0),
        child,
        () => stderr,
      );
      send({ method: 'notifications/initialized' });
      // Each call waits for the other before writing, so both are in flight at once.
      send({ id: 1, ...logAndExtract('first', 2) });
      send({ id: 2, ...logAndExtract('second', 2) });
      await waitFor(
        'both results',
        () => answered(1) && answered(2),
        child,
        () => stderr,
      );
      child.stdin.end();

      expect(
        await Promise.race([
          exited,
          new Promise<'still alive'>((settle) =>
            setTimeout(() => settle('still alive'), EXIT_TIMEOUT_MS),
          ),
        ]),
      ).toBe(0);
      expect(lines().filter((line) => !isJsonRpc(line))).toEqual([]);
      for (const line of [...consoleLines('first'), ...consoleLines('second')]) {
        expect(stderr).toContain(line);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('writes U+2028 and U+2029 escaped, so a readline client reads each message as one line', async () => {
    const run = await runStdioSession({
      entry: WIRE_ENTRY,
      env: STDIO_ENV,
      requests: [
        {
          method: 'tools/call',
          params: { name: 'echo_text', arguments: { text: SEPARATED_TEXT } },
        },
      ],
    });
    const wire = `${run.stdoutLines.join('\n')}\n`;
    const readLines: string[] = [];
    for await (const line of createInterface({ input: Readable.from([wire]) })) {
      readLines.push(line);
    }

    expect(run.code).toBe(0);
    expect(run.responses[0]?.result).toMatchObject({
      content: [{ type: 'text', text: SEPARATED_TEXT }],
      structuredContent: { text: SEPARATED_TEXT },
    });
    expect([...wire].filter((ch) => ch === LS || ch === PS)).toEqual([]);
    expect(readLines).toEqual(run.stdoutLines);
  });

  it('delivers the same text to an SDK client', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [WIRE_ENTRY],
      env: { ...process.env, ...STDIO_ENV },
    });
    const sdkClient = new Client({ name: 'stdio-wire', version: '1.0.0' });
    await sdkClient.connect(transport);

    try {
      const result = await sdkClient.callTool({
        name: 'echo_text',
        arguments: { text: SEPARATED_TEXT },
      });

      expect(result.content).toEqual([{ type: 'text', text: SEPARATED_TEXT }]);
      expect(result.structuredContent).toEqual({ text: SEPARATED_TEXT });
    } finally {
      await sdkClient.close();
    }
  });

  it("leaves console output, setup()'s included, on stdout under the HTTP transport", async () => {
    const port = await getFreePort();
    const child = spawn(process.execPath, [WIRE_ENTRY], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MCP_HTTP_HOST: '127.0.0.1',
        MCP_HTTP_PORT: String(port),
        MCP_LOG_LEVEL: 'error',
        MCP_TRANSPORT_TYPE: 'http',
      },
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    try {
      await waitFor(
        'the startup line',
        () => stdout.includes(STARTUP_LINE) || stderr.includes(STARTUP_LINE),
        child,
        () => stderr,
      );

      for (const line of [...SETUP_LINES, STARTUP_LINE]) {
        expect(stdout).toContain(line);
        expect(stderr).not.toContain(line);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});

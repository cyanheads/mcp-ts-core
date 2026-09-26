/**
 * @fileoverview Integration tests for the stdio transport. Spawns a real server
 * subprocess and drives it via the official MCP SDK client over stdio pipes.
 * @module tests/integration/stdio
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
import { parseLogLines } from '../helpers/stdio-session.js';

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
const EXIT_TIMEOUT_MS = 10_000;

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

    /** Resolves once `seen()` holds, polling the collected output. */
    const waitFor = async (what: string, seen: () => boolean): Promise<void> => {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (!seen()) {
        if (Date.now() > deadline || child.exitCode !== null) {
          throw new Error(`never saw ${what}:\n${stderr}`);
        }
        await new Promise((tick) => setTimeout(tick, 20));
      }
    };
    const send = (message: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };
    const stdoutMessages = (): Array<{ id?: unknown }> =>
      stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id?: unknown });

    try {
      await waitFor('the ready line', () => stderr.includes(READY_LINE));
      send({
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'stdio-inflight', version: '1.0.0' },
        },
      });
      await waitFor('the initialize result', () => stdoutMessages().some((m) => m.id === 1));
      send({ method: 'notifications/initialized' });
      send({ id: 2, method: 'tools/call', params: { name: 'wait_for_abort', arguments: {} } });
      await waitFor('the handler start', () => stderr.includes('wait_for_abort started'));

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
    expect(run.code).toBe(0);
    expect(run.signal).toBeNull();
    expect(run.stderr).toContain('Initiating graceful shutdown');
    expect(run.stderr).toContain('Graceful shutdown completed successfully.');
    expect(run.stderr).not.toContain('did not settle');
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
      expect(run.code).toBe(0);
      expect(run.stderr).toContain('Graceful shutdown completed successfully.');
      expect(run.stderr).not.toContain('did not settle');
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it('releases a setup()-owned handle through teardown() and exits without the ceiling firing', async () => {
    const run = await runUntilTerminated(sendSignal('SIGTERM'), {
      entry: resolve(process.cwd(), 'tests/fixtures/teardown-server.js'),
    });

    expect(run.stillAlive).toBe(false);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('teardown fixture released its handle.');
    expect(run.stderr).toContain('Graceful shutdown completed successfully.');
    expect(run.stderr).not.toContain('did not settle');
  });

  it('exits 0 on SIGINT', async () => {
    const run = await runUntilTerminated(sendSignal('SIGINT'));

    expect(run.stillAlive).toBe(false);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('Graceful shutdown completed successfully.');
  });
});

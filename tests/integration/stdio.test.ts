/**
 * @fileoverview Integration tests for the stdio transport. Spawns a real server
 * subprocess and drives it via the official MCP SDK client over stdio pipes.
 * @module tests/integration/stdio
 */
import { spawn } from 'node:child_process';
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

  it('completes the MCP handshake and reports server info', () => {
    const version = client.getServerVersion();
    expect(version).toBeDefined();
    expect(version?.name).toBeTruthy();
  });

  it('responds to ping', async () => {
    // Core server has no tools — just verify the transport is functional
    const result = await client.ping();
    expect(result).toBeDefined();
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

  it('shuts down cleanly without hanging', async () => {
    // Closing should resolve without throwing or timing out.
    // The afterAll hook handles the actual close — this test verifies
    // a second close is also safe (idempotent).
    await expect(client.close()).resolves.toBeUndefined();
  });
});

/** Outcome of a server run terminated by closing the child's stdin. */
interface StdinEofRun {
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

/**
 * Boots `dist/index.js` over piped stdio, waits for the ready line, then closes
 * the child's stdin — the disconnect a host produces when it stops talking to
 * the server without signalling it.
 */
async function runUntilStdinEof(nodeArgs: readonly string[] = []): Promise<StdinEofRun> {
  const child = spawn('node', [...nodeArgs, DIST_INDEX], {
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

    child.stdin.end();

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
    const run = await runUntilStdinEof();

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
      const run = await runUntilStdinEof(['--import', pathToFileURL(preload).href]);

      expect(run.stillAlive).toBe(false);
      expect(run.code).toBe(0);
      expect(run.stderr).toContain('Graceful shutdown completed successfully.');
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

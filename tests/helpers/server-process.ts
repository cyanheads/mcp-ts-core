/**
 * @fileoverview Spawns and manages server subprocesses for integration tests.
 * Supports both stdio and HTTP transport modes.
 *
 * The server subprocess runs on the same runtime as the test runner
 * (`process.execPath`): Bun under `bun run test:integration` (the bun-node
 * PATH shim would intercept a bare `node` anyway), real Node under
 * `bun run test:node`. This makes the integration lane's runtime explicit
 * instead of depending on PATH resolution.
 * @module tests/integration/helpers/server-process
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

export interface ServerHandle {
  kill: () => Promise<void>;
  port?: number;
  process: ChildProcess;
}

const DIST_INDEX = resolve(process.cwd(), 'dist/index.js');

function resolveEntrypoint(entrypoint: string): string {
  return entrypoint.startsWith('/') ? entrypoint : resolve(process.cwd(), entrypoint);
}

/**
 * Checks that the built server exists. Call before starting integration tests.
 */
export function assertServerBuilt(): void {
  if (!existsSync(DIST_INDEX)) {
    throw new Error(
      `Built server not found at ${DIST_INDEX}. Run "bun run build" before integration tests.`,
    );
  }
}

/**
 * Checks that a custom server entrypoint exists.
 */
export function assertServerEntrypoint(entrypoint: string): string {
  const resolvedEntrypoint = resolveEntrypoint(entrypoint);
  if (!existsSync(resolvedEntrypoint)) {
    throw new Error(`Server entrypoint not found at ${resolvedEntrypoint}.`);
  }
  return resolvedEntrypoint;
}

/** Finds a free port by briefly binding to port 0 and releasing. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Failed to get free port')));
      }
    });
    srv.on('error', reject);
  });
}

/**
 * Spawns the server as a subprocess and waits for it to be ready.
 * For HTTP mode, assigns a free port and polls /healthz until responsive.
 */
export async function startServer(
  transport: 'http' | 'stdio',
  env?: Record<string, string>,
): Promise<ServerHandle> {
  assertServerBuilt();
  return startServerFromEntrypoint(DIST_INDEX, transport, env);
}

/**
 * Spawns a custom server entrypoint as a subprocess and waits for it to be ready.
 */
export async function startServerFromEntrypoint(
  entrypoint: string,
  transport: 'http' | 'stdio',
  env?: Record<string, string>,
): Promise<ServerHandle> {
  const resolvedEntrypoint = assertServerEntrypoint(entrypoint);
  const port = transport === 'http' ? await getFreePort() : undefined;

  const proc = spawn(process.execPath, [resolvedEntrypoint], {
    env: {
      ...process.env,
      MCP_TRANSPORT_TYPE: transport,
      MCP_LOG_LEVEL: 'error',
      ...(port !== undefined && { MCP_HTTP_PORT: String(port) }),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (transport === 'http' && port !== undefined) {
    await waitForHealthy(port, proc);
    return { process: proc, port, kill: () => killProcess(proc) };
  }

  // For stdio, wait briefly for the process to start
  await new Promise((r) => setTimeout(r, 500));
  return { process: proc, kill: () => killProcess(proc) };
}

/**
 * Polls the server's /healthz endpoint until it responds 200 or the timeout expires.
 * Much more reliable than scraping log output for the port number.
 */
async function waitForHealthy(port: number, proc: ChildProcess, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/healthz`;

  // Capture output for error diagnostics
  let output = '';
  const capture = (chunk: Buffer) => {
    output += chunk.toString();
  };
  proc.stdout?.on('data', capture);
  proc.stderr?.on('data', capture);

  // Fail fast if the process exits before becoming healthy
  const exitPromise = new Promise<never>((_, reject) => {
    proc.on('exit', (code) => {
      reject(
        new Error(
          `Server exited with code ${code} before becoming healthy. Output: ${output.slice(-500)}`,
        ),
      );
    });
  });

  while (Date.now() < deadline) {
    const res = await Promise.race([fetch(url).catch(() => null), exitPromise]);
    if (res && res.status === 200) return;
    await new Promise((r) => setTimeout(r, 100));
  }

  proc.kill();
  throw new Error(
    `Server did not become healthy within ${timeoutMs}ms on port ${port}. Output (${output.length} bytes): ${output.slice(-500)}`,
  );
}

async function killProcess(proc: ChildProcess): Promise<void> {
  if (proc.killed || proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve();
    }, 3000);
    proc.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

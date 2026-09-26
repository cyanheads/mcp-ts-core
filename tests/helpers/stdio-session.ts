/**
 * @fileoverview Drives a server entry point over raw stdio JSON-RPC and ends it
 * with stdin EOF, returning everything the process wrote. For black-box tests
 * that assert on stdout purity, stderr content, and the exit code — the SDK
 * client hides all three.
 *
 * The child runs on the test runner's own runtime (`process.execPath`): Bun
 * under `bun run test:integration`, real Node under `bun run test:node`.
 * @module tests/helpers/stdio-session
 */
import { spawn } from 'node:child_process';

/** One JSON-RPC request sent after the initialize handshake. */
export interface StdioRequest {
  method: string;
  params?: Record<string, unknown>;
}

/** A parsed JSON-RPC response line from the server's stdout. */
export interface JsonRpcResponse {
  error?: { code: number; message: string };
  id: number;
  jsonrpc: '2.0';
  result?: Record<string, unknown>;
}

/** What a session produced, from spawn to exit. */
export interface StdioSessionResult {
  code: number | null;
  /** Responses to the requests passed in, in order (initialize excluded). */
  responses: JsonRpcResponse[];
  signal: NodeJS.Signals | null;
  stderr: string;
  /** Every non-empty stdout line, verbatim. */
  stdoutLines: string[];
  /** `true` when the child was still alive when the exit window expired. */
  stillAlive: boolean;
}

export interface StdioSessionOptions {
  /** Absolute path to the server entry module. */
  entry: string;
  /** Merged over a copy of `process.env` with `OTEL_*`, `LOGS_DIR`, and `MCP_*` removed. */
  env: Record<string, string>;
  exitTimeoutMs?: number;
  requests?: readonly StdioRequest[];
  responseTimeoutMs?: number;
}

const PROTOCOL_VERSION = '2025-06-18';

/** Starts from the parent environment minus anything that would steer the child's logging or telemetry. */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('OTEL_') || key.startsWith('MCP_') || key === 'LOGS_DIR') continue;
    env[key] = value;
  }
  return env;
}

/**
 * Spawns `entry`, completes the initialize handshake, sends each request and
 * awaits its response, then closes stdin and waits for the process to exit.
 * A child still alive after the exit window is killed by its own PID.
 */
export async function runStdioSession(options: StdioSessionOptions): Promise<StdioSessionResult> {
  const { entry, env, requests = [], responseTimeoutMs = 15_000, exitTimeoutMs = 10_000 } = options;
  const child = spawn(process.execPath, [entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...baseEnv(), ...env },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stderr = '';
  let stdoutBuffer = '';
  const stdoutLines: string[] = [];
  const waiters = new Map<number, (response: JsonRpcResponse) => void>();

  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line) {
        stdoutLines.push(line);
        try {
          const message = JSON.parse(line) as Partial<JsonRpcResponse>;
          if (typeof message.id === 'number') waiters.get(message.id)?.(message as JsonRpcResponse);
        } catch {
          // Not JSON — kept in stdoutLines for the caller to assert on.
        }
      }
      newline = stdoutBuffer.indexOf('\n');
    }
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle) => {
    child.once('exit', (code, signal) => settle({ code, signal }));
  });

  const send = (message: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };

  const request = async (id: number, method: string, params?: Record<string, unknown>) => {
    const response = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`no response to ${method} within ${responseTimeoutMs}ms:\n${stderr}`)),
        responseTimeoutMs,
      );
      waiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      exited.then(({ code }) => {
        clearTimeout(timer);
        reject(new Error(`server exited (code ${code}) before answering ${method}:\n${stderr}`));
      });
    });
    send({ id, method, ...(params && { params }) });
    return await response;
  };

  try {
    await request(0, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'stdio-session', version: '1.0.0' },
    });
    send({ method: 'notifications/initialized' });

    const responses: JsonRpcResponse[] = [];
    for (const [index, { method, params }] of requests.entries()) {
      responses.push(await request(index + 1, method, params));
    }

    child.stdin.end();
    const exit = await Promise.race([
      exited,
      new Promise<null>((settle) => setTimeout(() => settle(null), exitTimeoutMs)),
    ]);

    return {
      code: exit?.code ?? null,
      responses,
      signal: exit?.signal ?? null,
      stderr,
      stillAlive: exit === null,
      stdoutLines,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      process.kill(child.pid, 'SIGKILL');
    }
  }
}

/** Parses each stderr line that is a JSON log record; other lines are skipped. */
export function parseLogLines(stderr: string): Array<Record<string, unknown>> {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

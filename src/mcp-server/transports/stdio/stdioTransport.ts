/**
 * @fileoverview Handles the setup and connection for the stdio MCP transport.
 * Communicates over standard input and standard output, the shape a host
 * application uses when it launches the MCP server as a child process.
 *
 * Serving goes through the SDK's `serveStdio` entry, which owns the era
 * decision: the opening exchange selects 2025 or 2026-07-28, ONE instance from
 * the factory is pinned for the connection's lifetime, and everything after
 * passes straight through to it. The same factory serves both eras.
 *
 * --- Authentication Note ---
 * Per the MCP Authorization specification, stdio transports SHOULD NOT
 * implement HTTP-based authentication flows. Authorization is handled
 * implicitly by the host application controlling the server process.
 *
 * @see {@link https://modelcontextprotocol.io/specification/2026-07-28/basic/transports | MCP Transports}
 * @module src/mcp-server/transports/stdioTransport
 */
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import type { McpServerFactory } from '@modelcontextprotocol/server';
import {
  type StdioServerHandle,
  StdioServerTransport,
  serveStdio,
} from '@modelcontextprotocol/server/stdio';

import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { messageText } from '@/utils/internal/error-handler/helpers.js';
import { logger } from '@/utils/internal/logger.js';
import { type RequestContext, withExtra } from '@/utils/internal/requestContext.js';
import { logStartupBanner } from '@/utils/internal/startupBanner.js';

/**
 * The console methods the stderr `Console` takes over: all of a `Console`'s
 * methods but `clear`, which prints nothing while stdout is not a terminal and
 * would start clearing one on stderr. The stateful companions (`time`,
 * `countReset`, `groupEnd`) move with the methods that print, so each timer,
 * counter, and group lives on one console.
 */
const CONSOLE_METHODS = [
  'assert',
  'count',
  'countReset',
  'debug',
  'dir',
  'dirxml',
  'error',
  'group',
  'groupCollapsed',
  'groupEnd',
  'info',
  'log',
  'table',
  'time',
  'timeEnd',
  'timeLog',
  'trace',
  'warn',
] as const satisfies readonly (keyof Console)[];

/** Marks a console {@link routeConsoleToStderr} has already rebound. */
const ROUTED_TO_STDERR = Symbol('routedToStderr');

/**
 * Rebinds the global console to a `Console` over stderr, for the life of the
 * process. A swap restored after each call would reroute whatever other
 * request's code ran inside the window, so nothing is ever put back.
 *
 * Runs once per console. Under stdio, `createApp` calls it before core
 * services start and `setup()` runs, and {@link startStdioTransport} again
 * before serving. The second call changes nothing: a counter, timer, or group
 * started in between carries on, and a console method server code replaced in
 * between stays replaced.
 */
export function routeConsoleToStderr(): void {
  if (Object.hasOwn(console, ROUTED_TO_STDERR)) return;
  const stderrConsole = new Console({ stdout: process.stderr, stderr: process.stderr });
  Object.assign(
    console,
    Object.fromEntries(
      CONSOLE_METHODS.map((method) => [method, stderrConsole[method].bind(stderrConsole)]),
    ),
  );
  // Bun's `console.write(...data)` prints raw text and bytes to stdout.
  if ('write' in console) {
    Object.assign(console, {
      write: (...data: Array<string | ArrayBufferView | ArrayBuffer>): number => {
        let bytes = 0;
        for (const chunk of data) {
          // Bun's stderr takes each kind of chunk its `console.write` does.
          process.stderr.write(chunk as string | Uint8Array);
          bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
        }
        return bytes;
      },
    });
  }
  // Configurable like the methods beside it, so restoring the console's own properties removes it too.
  Object.defineProperty(console, ROUTED_TO_STDERR, { configurable: true, value: true });
}

/** U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR, left raw by `JSON.stringify`. */
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);

/**
 * `process.stdout` as the transport writes to it: each chunk with U+2028 and
 * U+2029 replaced by their JSON escapes, handed to stdout as it is sent. While
 * stdout reports itself full, this stream holds what follows until stdout
 * drains, and a stdout error destroys this stream with it, so the SDK's `drain`
 * wait and error handling see stdout's own.
 */
function escapingStdout(): Writable {
  const stdout = process.stdout;
  const stream = new Writable({
    decodeStrings: false,
    write(chunk: string, _encoding, callback) {
      const escaped = chunk
        .replaceAll(LINE_SEPARATOR, '\\u2028')
        .replaceAll(PARAGRAPH_SEPARATOR, '\\u2029');
      if (stdout.write(escaped)) callback();
      else stdout.once('drain', callback);
    },
  });
  stdout.on('error', (error) => stream.destroy(error));
  return stream;
}

/**
 * Serves MCP over this process's stdio from the supplied server factory.
 *
 * stdout carries JSON-RPC messages and nothing else. Before serving, the
 * console's methods are rebound to a `Console` over stderr for the life of the
 * process ({@link routeConsoleToStderr}, which `createApp` has already run
 * before `setup()`), so console output on this thread, a dependency's
 * included, goes to stderr, which the spec permits; on Bun, so does
 * `console.write`. Logging via the `logger` utility goes to stderr too.
 * `process.stdout` itself is left alone, and the transport writes through it.
 * Only the stdio transport rebinds the console: under HTTP it stays as it is.
 *
 * Each message is written as the SDK's `StdioServerTransport` serializes it,
 * `JSON.stringify(message)` and a newline, with U+2028 and U+2029 written as
 * their six-character JSON escapes. The JSON value is unchanged, and a client
 * that splits lines with `node:readline`, which ends a line at either, still
 * reads one line per message. Inbound lines that are not JSON are skipped.
 *
 * @param serverFactory - Produces the `McpServer` pinned to the connection.
 * @param parentContext - The logging and tracing context from the caller.
 * @returns The connection handle, whose `close()` tears down the pinned
 *   instance and the underlying transport — a no-op once stdin EOF has
 *   already closed them.
 * @throws {Error} If the connection fails during setup.
 */
export function startStdioTransport(
  serverFactory: McpServerFactory,
  parentContext: RequestContext,
): StdioServerHandle {
  const operationContext = withExtra(
    { ...parentContext, operation: 'connectStdioTransport' },
    { transportType: 'Stdio' },
  );
  logger.info('Attempting to connect stdio transport...', operationContext);

  try {
    routeConsoleToStderr();
    const handle = serveStdio(serverFactory, {
      transport: new StdioServerTransport(process.stdin, escapingStdout()),
      // An inbound line failing the SDK's JSON-RPC schema arrives as its ZodError, written as its summary.
      onerror: (error) => {
        logger.debug(`Stdio transport reported: ${messageText(error)}`, operationContext);
      },
    });

    logger.info('MCP Server connected and listening via stdio transport.', operationContext);
    logStartupBanner(`\n🚀 MCP Server running in STDIO mode.\n`, 'stdio');
    return handle;
  } catch (err) {
    // Let the ErrorHandler log the error with all context, then rethrow.
    throw ErrorHandler.handleError(err, {
      operation: 'connectStdioTransport',
      context: operationContext,
      critical: true,
      rethrow: true,
    });
  }
}

/** The slice of a readable stream {@link observeStdinEof} binds. */
export interface StdinEofSource {
  off(event: 'close' | 'end', listener: () => void): unknown;
  on(event: 'close' | 'end', listener: () => void): unknown;
}

/** Options for {@link observeStdinEof}. */
export interface ObserveStdinEofOptions {
  /** Runs once, on the first of `end` / `close`. */
  onEof: () => void;
  /** Stream to watch. Defaults to `process.stdin`. */
  stream?: StdinEofSource;
}

/**
 * Reports the client closing the stdin pipe — the only observable signal that a
 * stdio host has disconnected.
 *
 * `StdioServerTransport` closes itself on the same `end` / `close`, and
 * `serveStdio` tears the pinned instance down through the transport's `onclose`
 * — aborting any request still in flight, which is never answered. That covers
 * the connection only: the handle exposes nothing but `close()`, so the
 * disconnect never reaches the caller through it. Watching the stream directly
 * is what makes EOF reachable by the shutdown path (#322), whose transport stop
 * then finds the connection already closed.
 *
 * Both `end` and `close` are bound because a torn-down pipe can emit either
 * first; `onEof` still runs at most once, and the listeners come off before it
 * does so nothing can re-enter.
 *
 * @param options - The EOF callback and, for tests, the stream to watch.
 * @returns Disposer removing both listeners. Safe to call more than once.
 */
export function observeStdinEof({
  onEof,
  stream = process.stdin,
}: ObserveStdinEofOptions): () => void {
  const dispose = (): void => {
    stream.off('end', handleEof);
    stream.off('close', handleEof);
  };

  let reported = false;
  function handleEof(): void {
    if (reported) return;
    reported = true;
    dispose();
    onEof();
  }

  stream.on('end', handleEof);
  stream.on('close', handleEof);
  return dispose;
}

export async function stopStdioTransport(
  handle: StdioServerHandle,
  parentContext: RequestContext,
): Promise<void> {
  const operationContext = withExtra(
    { ...parentContext, operation: 'stopStdioTransport' },
    { transportType: 'Stdio' },
  );
  logger.info('Attempting to stop stdio transport...', operationContext);
  await handle.close();
  logger.info('Stdio transport stopped successfully.', operationContext);
}

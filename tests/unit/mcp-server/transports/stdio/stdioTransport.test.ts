/**
 * @fileoverview Tests for stdio transport functionality.
 * @module tests/mcp-server/transports/stdio/stdioTransport.test.ts
 *
 * NOTE: The SDK's `serveStdio` owns the connection (it starts the transport and
 * makes the era decision), so it is mocked here; the `StdioServerTransport` the
 * framework hands it is the real one. These tests cover the framework's wrapper:
 * handle pass-through, logging, error escalation, shutdown, the console routed
 * to stderr, and the wire stdout receives. `process.stdin`, `process.stdout`,
 * and `process.stderr` are fakes while `startStdioTransport` runs, and the
 * console it rebinds is restored after each test.
 */

import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import {
  type JSONRPCMessage,
  type McpServer,
  type McpServerFactory,
  ReadBuffer,
} from '@modelcontextprotocol/server';
import { type StdioServerHandle, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { z } from 'zod';
import type { RequestContext } from '@/utils/internal/requestContext.js';

const { handleCloseSpy, serveStdioSpy } = vi.hoisted(() => ({
  handleCloseSpy: vi.fn(async () => {}),
  serveStdioSpy: vi.fn(),
}));

vi.mock('@modelcontextprotocol/server/stdio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@modelcontextprotocol/server/stdio')>()),
  serveStdio: serveStdioSpy,
}));

/** U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR, built so this file holds neither raw. */
const LS = String.fromCodePoint(0x2028);
const PS = String.fromCodePoint(0x2029);

/** A writable standing in for a process stream, keeping everything written to it. */
function captureStream(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    decodeStrings: false,
    write(chunk: string | Buffer, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

/** A writable that completes each write only when released, as a stalled pipe does. */
function heldStream(): { pending: () => number; release: () => void; stream: Writable } {
  const callbacks: Array<() => void> = [];
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callbacks.push(callback);
    },
  });
  return {
    pending: () => callbacks.length,
    release: () => {
      for (const callback of callbacks.splice(0)) callback();
    },
    stream,
  };
}

/** Replaces `process[name]` with `stream` until the returned restorer runs. */
function replaceProcessStream(
  name: 'stderr' | 'stdin' | 'stdout',
  stream: NodeJS.ReadableStream | NodeJS.WritableStream,
): () => void {
  const original = Object.getOwnPropertyDescriptor(process, name);
  Object.defineProperty(process, name, { configurable: true, get: () => stream });
  return () => {
    if (original) Object.defineProperty(process, name, original);
  };
}

/** Every own property of the console, for putting back what `startStdioTransport` rebinds. */
function snapshotConsole(): () => void {
  const saved = Object.getOwnPropertyDescriptors(console);
  return () => {
    for (const key of Reflect.ownKeys(console)) {
      if (!(key in saved)) Reflect.deleteProperty(console, key);
    }
    Object.defineProperties(console, saved);
  };
}

/** The `StdioServerTransport` `startStdioTransport` handed to `serveStdio`. */
function servedTransport(): StdioServerTransport {
  const options = serveStdioSpy.mock.calls[0]?.[1] as { transport?: unknown } | undefined;
  expect(options?.transport).toBeInstanceOf(StdioServerTransport);
  return options?.transport as StdioServerTransport;
}

/** `JSON.stringify(message)` with each raw U+2028 and U+2029 written as its escape, plus the newline. */
const escapedLine = (message: JSONRPCMessage): string =>
  `${JSON.stringify(message).replaceAll(LS, '\\u2028').replaceAll(PS, '\\u2029')}\n`;

/** The raw U+2028 and U+2029 characters in `text`. */
const rawSeparators = (text: string): string[] => [...text].filter((ch) => ch === LS || ch === PS);

/** The messages a reader gets from `wire` with the SDK's own stdio line reader. */
function readMessages(wire: string): JSONRPCMessage[] {
  const buffer = new ReadBuffer();
  buffer.append(Buffer.from(wire, 'utf8'));
  const messages: JSONRPCMessage[] = [];
  for (let message = buffer.readMessage(); message !== null; message = buffer.readMessage()) {
    messages.push(message);
  }
  return messages;
}

describe('Stdio Transport', () => {
  let handle: StdioServerHandle;
  let serverFactory: McpServerFactory;
  let mockContext: RequestContext;
  let loggerSpy: {
    info: ReturnType<typeof vi.spyOn>;
    debug: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };
  let logStartupBannerSpy: ReturnType<typeof vi.spyOn>;
  let errorHandlerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    handle = { close: handleCloseSpy };
    serveStdioSpy.mockReturnValue(handle);
    serverFactory = vi.fn(async () => ({}) as McpServer);

    mockContext = {
      requestId: 'test-stdio',
      timestamp: new Date().toISOString(),
      operation: 'test-stdio-transport',
    };

    const loggerModule = await import('@/utils/internal/logger.js');
    const bannerModule = await import('@/utils/internal/startupBanner.js');
    const errorModule = await import('@/utils/internal/error-handler/errorHandler.js');
    loggerSpy = {
      info: vi.spyOn(loggerModule.logger, 'info').mockImplementation(() => {}),
      debug: vi.spyOn(loggerModule.logger, 'debug').mockImplementation(() => {}),
      error: vi.spyOn(loggerModule.logger, 'error').mockImplementation(() => {}),
    };
    logStartupBannerSpy = vi
      .spyOn(bannerModule, 'logStartupBanner')
      .mockImplementation(() => undefined);
    errorHandlerSpy = vi
      .spyOn(errorModule.ErrorHandler, 'handleError')
      .mockImplementation((err) => err as Error);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('startStdioTransport', () => {
    let stdout: ReturnType<typeof captureStream>;
    let stderr: ReturnType<typeof captureStream>;
    let restorers: Array<() => void>;

    beforeEach(() => {
      stdout = captureStream();
      stderr = captureStream();
      restorers = [
        snapshotConsole(),
        replaceProcessStream('stdin', new PassThrough()),
        replaceProcessStream('stdout', stdout.stream),
        replaceProcessStream('stderr', stderr.stream),
      ];
    });

    afterEach(() => {
      for (const restore of restorers.reverse()) restore();
    });

    it('serves the factory over stdio and returns the connection handle', async () => {
      const { startStdioTransport } = await import(
        '@/mcp-server/transports/stdio/stdioTransport.js'
      );

      const result = startStdioTransport(serverFactory, mockContext);

      expect(result).toBe(handle);
      expect(serveStdioSpy).toHaveBeenCalledTimes(1);
      expect(serveStdioSpy).toHaveBeenCalledWith(
        serverFactory,
        expect.objectContaining({ onerror: expect.any(Function) }),
      );
      // The factory is not called here — `serveStdio` calls it when the
      // connection opens and pins the one instance it returns.
      expect(serverFactory).not.toHaveBeenCalled();
      expect(loggerSpy.info).toHaveBeenCalledWith(
        'Attempting to connect stdio transport...',
        expect.objectContaining({
          operation: 'connectStdioTransport',
          extra: expect.objectContaining({ transportType: 'Stdio' }),
        }),
      );
      expect(logStartupBannerSpy).toHaveBeenCalled();
    });

    it('reports out-of-band transport errors at debug level', async () => {
      const { startStdioTransport } = await import(
        '@/mcp-server/transports/stdio/stdioTransport.js'
      );

      startStdioTransport(serverFactory, mockContext);
      const options = serveStdioSpy.mock.calls[0]?.[1] as { onerror: (error: Error) => void };
      options.onerror(new Error('wire glitch'));

      expect(loggerSpy.debug).toHaveBeenCalledWith(
        'Stdio transport reported: wire glitch',
        expect.objectContaining({ operation: 'connectStdioTransport' }),
      );
    });

    it('reports a ZodError the transport raises by its one-line summary', async () => {
      const { startStdioTransport } = await import(
        '@/mcp-server/transports/stdio/stdioTransport.js'
      );
      // The SDK validates each inbound line against its JSON-RPC schema and reports the ZodError.
      const parsed = z.object({ jsonrpc: z.literal('2.0'), id: z.number() }).safeParse({});
      if (parsed.success) throw new Error('fixture must fail');

      startStdioTransport(serverFactory, mockContext);
      const options = serveStdioSpy.mock.calls[0]?.[1] as { onerror: (error: Error) => void };
      options.onerror(parsed.error);

      expect(loggerSpy.debug).toHaveBeenCalledWith(
        'Stdio transport reported: jsonrpc: Invalid input: expected "2.0" (+1 more)',
        expect.objectContaining({ operation: 'connectStdioTransport' }),
      );
    });

    it('escalates a serving failure through the ErrorHandler and rethrows', async () => {
      const { startStdioTransport } = await import(
        '@/mcp-server/transports/stdio/stdioTransport.js'
      );

      const servingError = new Error('Connection failed');
      serveStdioSpy.mockImplementationOnce(() => {
        throw servingError;
      });

      expect(() => startStdioTransport(serverFactory, mockContext)).toThrow('Connection failed');
      expect(errorHandlerSpy).toHaveBeenCalledWith(
        servingError,
        expect.objectContaining({
          operation: 'connectStdioTransport',
          critical: true,
          rethrow: true,
        }),
      );
    });

    it('routes every console method that prints to stderr, leaving the process streams alone', async () => {
      const { startStdioTransport } = await import(
        '@/mcp-server/transports/stdio/stdioTransport.js'
      );
      const stdoutWrite = process.stdout.write;
      const stderrWrite = process.stderr.write;

      startStdioTransport(serverFactory, mockContext);
      console.log('via log');
      console.info('via info');
      console.debug('via debug');
      console.dir({ via: 'dir' });
      console.dirxml('via dirxml');
      console.table([{ cell: 'via table' }]);
      console.trace('via trace');
      console.count('via count');
      console.group('via group');
      console.groupCollapsed('via groupCollapsed');
      console.groupEnd();
      console.groupEnd();
      console.time('via time');
      console.timeLog('via time', 'and timeLog');
      console.timeEnd('via time');
      console.warn('via warn');
      console.error('via error');
      console.assert(false, 'via assert');

      expect(stdout.text()).toBe('');
      for (const text of [
        'via log',
        'via info',
        'via debug',
        "via: 'dir'",
        'via dirxml',
        'via table',
        'via count: 1',
        'via group',
        'via groupCollapsed',
        'and timeLog',
        'via warn',
        'via error',
        'via assert',
      ]) {
        expect(stderr.text()).toContain(text);
      }
      // A stack frame from `console.trace` (Bun's `Console` prints it without the message).
      expect(stderr.text()).toMatch(/^\s+at /m);
      expect(process.stdout.write).toBe(stdoutWrite);
      expect(process.stderr.write).toBe(stderrWrite);
    });

    it("keeps the console's counters, timers, and groups consistent across its methods", async () => {
      const { startStdioTransport } = await import(
        '@/mcp-server/transports/stdio/stdioTransport.js'
      );

      startStdioTransport(serverFactory, mockContext);
      console.count('counter');
      console.countReset('counter');
      console.count('counter');
      console.time('timer');
      console.timeEnd('timer');
      console.group('group');
      console.groupEnd();
      console.log('after the group');

      const lines = stderr.text().split('\n');
      expect(lines.filter((line) => line === 'counter: 1')).toHaveLength(2);
      expect(lines.some((line) => /^timer: [\d.]+m?s$/.test(line))).toBe(true);
      expect(lines).toContain('after the group');
    });

    it('changes nothing when the console is already routed, as createApp routes it before setup()', async () => {
      const { routeConsoleToStderr, startStdioTransport } = await import(
        '@/mcp-server/transports/stdio/stdioTransport.js'
      );
      const replacedInfo = vi.fn();

      routeConsoleToStderr();
      console.count('counter');
      console.time('timer');
      // A server's own setup() may take over a console method once the console is routed.
      console.info = replacedInfo;
      startStdioTransport(serverFactory, mockContext);
      console.count('counter');
      console.timeEnd('timer');
      console.info('after serving starts');

      const lines = stderr.text().split('\n');
      expect(lines).toContain('counter: 1');
      expect(lines).toContain('counter: 2');
      expect(lines.some((line) => /^timer: [\d.]+m?s$/.test(line))).toBe(true);
      expect(replacedInfo).toHaveBeenCalledWith('after serving starts');
      expect(stdout.text()).toBe('');
    });

    it('routes a console.write, where the runtime provides one, to stderr', async () => {
      const { startStdioTransport } = await import(
        '@/mcp-server/transports/stdio/stdioTransport.js'
      );
      // Stands in for Bun's `console.write(...data)`, which prints raw text and bytes to stdout.
      const nativeWrite = vi.fn(() => 0);
      Object.assign(console, { write: nativeWrite });

      startStdioTransport(serverFactory, mockContext);
      const { write } = console as unknown as { write: (...data: unknown[]) => number };
      const written = write('text, ', new TextEncoder().encode('bytes\n'));

      expect(nativeWrite).not.toHaveBeenCalled();
      expect(stderr.text()).toBe('text, bytes\n');
      expect(stdout.text()).toBe('');
      expect(written).toBe(12);
    });

    it('adds no console.write where the runtime has none', async () => {
      const { startStdioTransport } = await import(
        '@/mcp-server/transports/stdio/stdioTransport.js'
      );

      startStdioTransport(serverFactory, mockContext);

      expect('write' in console).toBe(false);
    });

    it('writes each message to stdout with U+2028 and U+2029 as JSON escapes, the value unchanged', async () => {
      const { startStdioTransport } = await import(
        '@/mcp-server/transports/stdio/stdioTransport.js'
      );
      const messages: JSONRPCMessage[] = [
        { jsonrpc: '2.0', id: 1, result: { text: `line${LS}separator${PS}paragraph` } },
        // The six-character text `\u2028` is not a separator and stays text.
        {
          jsonrpc: '2.0',
          id: 2,
          result: { text: `the text \\u2028, and \\${LS} after a backslash` },
        },
        {
          jsonrpc: '2.0',
          id: 3,
          result: { [`key${PS}`]: `in a key, beside an astral \u{1F600}${LS}` },
        },
        {
          jsonrpc: '2.0',
          method: 'notifications/message',
          params: { level: 'info', data: 'none' },
        },
      ];

      startStdioTransport(serverFactory, mockContext);
      const transport = servedTransport();
      for (const message of messages) await transport.send(message);
      const wire = stdout.text();

      expect(wire).toBe(messages.map(escapedLine).join(''));
      expect(rawSeparators(wire)).toEqual([]);
      expect(wire.split('\n')).toHaveLength(messages.length + 1);
      expect(readMessages(wire)).toEqual(messages);
    });

    it('writes a message without separators exactly as the SDK serializes it', async () => {
      const { startStdioTransport } = await import(
        '@/mcp-server/transports/stdio/stdioTransport.js'
      );
      const message: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: 7,
        result: { text: '\\u2028 as text' },
      };

      startStdioTransport(serverFactory, mockContext);
      await servedTransport().send(message);

      expect(stdout.text()).toBe(`${JSON.stringify(message)}\n`);
    });

    it('keeps the transport writing to stdout, escaped, while the console goes to stderr', async () => {
      const { startStdioTransport } = await import(
        '@/mcp-server/transports/stdio/stdioTransport.js'
      );
      const message: JSONRPCMessage = { jsonrpc: '2.0', id: 1, result: { text: `a${LS}b` } };

      startStdioTransport(serverFactory, mockContext);
      console.log('a console line');
      await servedTransport().send(message);
      console.log('another console line');

      expect(stdout.text()).toBe(escapedLine(message));
      expect(stderr.text()).toBe('a console line\nanother console line\n');
    });

    it('resolves a send only once a stalled stdout drains', async () => {
      const { startStdioTransport } = await import(
        '@/mcp-server/transports/stdio/stdioTransport.js'
      );
      const held = heldStream();
      restorers.push(replaceProcessStream('stdout', held.stream));
      // Larger than any stream's default high-water mark, so `write()` returns false.
      const message: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: 1,
        result: { text: 'x'.repeat(1 << 20) },
      };

      startStdioTransport(serverFactory, mockContext);
      let sent = false;
      const sending = servedTransport()
        .send(message)
        .then(() => {
          sent = true;
        });
      await new Promise((tick) => setImmediate(tick));

      expect(held.pending()).toBe(1);
      expect(sent).toBe(false);
      held.release();
      await sending;
      expect(sent).toBe(true);
    });

    it('reports a stdout error to the transport and closes it', async () => {
      const { startStdioTransport } = await import(
        '@/mcp-server/transports/stdio/stdioTransport.js'
      );
      const onclose = vi.fn();
      const onerror = vi.fn();

      startStdioTransport(serverFactory, mockContext);
      const transport = servedTransport();
      transport.onclose = onclose;
      transport.onerror = onerror;
      await transport.start();
      const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      stdout.stream.emit('error', epipe);
      await new Promise((tick) => setImmediate(tick));

      expect(onerror).toHaveBeenCalledWith(epipe);
      expect(onclose).toHaveBeenCalledTimes(1);
      await expect(transport.send({ jsonrpc: '2.0', id: 1, result: {} })).rejects.toThrow(
        'StdioServerTransport is closed',
      );
    });
  });

  describe('stopStdioTransport', () => {
    it('closes the connection handle', async () => {
      const { stopStdioTransport } = await import(
        '@/mcp-server/transports/stdio/stdioTransport.js'
      );

      await stopStdioTransport(handle, mockContext);

      expect(handleCloseSpy).toHaveBeenCalledTimes(1);
      expect(loggerSpy.info).toHaveBeenCalledWith(
        'Attempting to stop stdio transport...',
        expect.objectContaining({
          operation: 'stopStdioTransport',
          extra: expect.objectContaining({ transportType: 'Stdio' }),
          requestId: mockContext.requestId,
        }),
      );
      expect(loggerSpy.info).toHaveBeenCalledWith(
        'Stdio transport stopped successfully.',
        expect.any(Object),
      );
    });

    it('propagates a close failure rather than reporting a clean stop', async () => {
      const { stopStdioTransport } = await import(
        '@/mcp-server/transports/stdio/stdioTransport.js'
      );
      handleCloseSpy.mockRejectedValueOnce(new Error('already closed'));

      await expect(stopStdioTransport(handle, mockContext)).rejects.toThrow('already closed');
      expect(loggerSpy.info).not.toHaveBeenCalledWith(
        'Stdio transport stopped successfully.',
        expect.any(Object),
      );
    });
  });

  describe('observeStdinEof', () => {
    /**
     * Stands in for `process.stdin`. Never the real stream — an EOF listener on
     * the test runner's own stdin would take the runner down with it.
     */
    let stdin: EventEmitter;
    let onEof: Mock<() => void>;

    beforeEach(() => {
      stdin = new EventEmitter();
      onEof = vi.fn<() => void>();
    });

    it('reports EOF when the pipe ends', async () => {
      const { observeStdinEof } = await import('@/mcp-server/transports/stdio/stdioTransport.js');

      observeStdinEof({ onEof, stream: stdin });
      stdin.emit('end');

      expect(onEof).toHaveBeenCalledTimes(1);
    });

    it('reports EOF when the pipe is torn down without ending', async () => {
      const { observeStdinEof } = await import('@/mcp-server/transports/stdio/stdioTransport.js');

      observeStdinEof({ onEof, stream: stdin });
      stdin.emit('close');

      expect(onEof).toHaveBeenCalledTimes(1);
    });

    it('reports EOF once when both end and close fire', async () => {
      const { observeStdinEof } = await import('@/mcp-server/transports/stdio/stdioTransport.js');

      observeStdinEof({ onEof, stream: stdin });
      stdin.emit('end');
      stdin.emit('close');

      expect(onEof).toHaveBeenCalledTimes(1);
      expect(stdin.listenerCount('end')).toBe(0);
      expect(stdin.listenerCount('close')).toBe(0);
    });

    it('stops reporting once disposed', async () => {
      const { observeStdinEof } = await import('@/mcp-server/transports/stdio/stdioTransport.js');

      const dispose = observeStdinEof({ onEof, stream: stdin });
      dispose();
      dispose();
      stdin.emit('end');

      expect(onEof).not.toHaveBeenCalled();
      expect(stdin.listenerCount('end')).toBe(0);
      expect(stdin.listenerCount('close')).toBe(0);
    });

    it('observes process.stdin when no stream is supplied', async () => {
      const { observeStdinEof } = await import('@/mcp-server/transports/stdio/stdioTransport.js');
      const stdinSpy = vi
        .spyOn(process, 'stdin', 'get')
        .mockReturnValue(stdin as unknown as NodeJS.ReadStream & { fd: 0 });

      const dispose = observeStdinEof({ onEof });
      expect(stdin.listenerCount('end')).toBe(1);
      stdin.emit('end');
      dispose();

      expect(onEof).toHaveBeenCalledTimes(1);
      stdinSpy.mockRestore();
    });
  });
});

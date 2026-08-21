/**
 * @fileoverview Tests for stdio transport functionality.
 * @module tests/mcp-server/transports/stdio/stdioTransport.test.ts
 *
 * NOTE: The SDK's `serveStdio` owns the wire (it binds this process's stdin and
 * stdout and makes the era decision), so it is mocked here. These tests cover
 * the framework's wrapper: handle pass-through, logging, error escalation, and
 * shutdown.
 */

import { EventEmitter } from 'node:events';
import type { McpServer, McpServerFactory } from '@modelcontextprotocol/server';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { RequestContext } from '@/utils/internal/requestContext.js';

const { handleCloseSpy, serveStdioSpy } = vi.hoisted(() => ({
  handleCloseSpy: vi.fn(async () => {}),
  serveStdioSpy: vi.fn(),
}));

vi.mock('@modelcontextprotocol/server/stdio', () => ({
  serveStdio: serveStdioSpy,
}));

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

    it('should log context with correct operation', async () => {
      const { stopStdioTransport } = await import(
        '@/mcp-server/transports/stdio/stdioTransport.js'
      );

      await stopStdioTransport(handle, mockContext);

      expect(loggerSpy.info).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          operation: 'stopStdioTransport',
          extra: expect.objectContaining({ transportType: 'Stdio' }),
          requestId: mockContext.requestId,
        }),
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

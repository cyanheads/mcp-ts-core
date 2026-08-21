/**
 * @fileoverview Unit tests for HTTP transport startup retry and shutdown lifecycle.
 * @module tests/mcp-server/transports/http/httpTransport.lifecycle
 */

import { EventEmitter } from 'node:events';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { RequestContext } from '@/utils/internal/requestContext.js';
import { defaultServerManifest as defaultMeta } from '../../../../helpers/fixtures.js';

const {
  closeAllConnectionsSpy,
  createServerSpy,
  destroySpy,
  probeOutcomes,
  serveSpy,
  serverCloseSpy,
  startupBannerSpy,
} = vi.hoisted(() => ({
  closeAllConnectionsSpy: vi.fn(),
  createServerSpy: vi.fn(),
  destroySpy: vi.fn(),
  probeOutcomes: [] as Array<'free' | 'inUse'>,
  serveSpy: vi.fn(),
  serverCloseSpy: vi.fn(),
  startupBannerSpy: vi.fn(),
}));

vi.mock('@/config/index.js', () => ({
  config: {
    mcpSessionMode: 'stateful',
    mcpStatefulSessionStaleTimeoutMs: 60000,
    mcpAllowedOrigins: ['http://localhost:3000'],
    mcpHttpEndpointPath: '/mcp',
    mcpServerName: 'test-mcp-server',
    mcpServerVersion: '1.0.0',
    mcpServerDescription: 'Test MCP Server',
    environment: 'test',
    mcpTransportType: 'http',
    mcpAuthMode: 'none',
    oauthIssuerUrl: '',
    mcpServerResourceIdentifier: '',
    oauthAudience: '',
    oauthJwksUri: '',
    openTelemetry: { enabled: false },
    mcpHttpPort: 7000,
    mcpHttpHost: '127.0.0.1',
    mcpHttpMaxPortRetries: 2,
    mcpHttpPortRetryDelayMs: 5,
  },
  FRAMEWORK_NAME: '@cyanheads/mcp-ts-core',
  FRAMEWORK_VERSION: '0.0.0-test',
}));

vi.mock('@/mcp-server/transports/auth/authFactory.js', () => ({
  createAuthStrategy: vi.fn(() => null),
}));

vi.mock('@/mcp-server/transports/auth/authMiddleware.js', () => ({
  createAuthMiddleware: vi.fn(),
}));

vi.mock('@/mcp-server/transports/auth/lib/authContext.js', () => {
  const { AsyncLocalStorage } = require('node:async_hooks');
  return {
    authContext: new AsyncLocalStorage(),
  };
});

vi.mock('@/mcp-server/transports/http/httpErrorHandler.js', () => ({
  httpErrorHandler: vi.fn(async (err, c) => c.json({ error: err.message }, 500)),
}));

vi.mock('@/utils/internal/startupBanner.js', () => ({
  logStartupBanner: startupBannerSpy,
}));

vi.mock('@/utils/telemetry/metrics.js', () => ({
  createObservableGauge: vi.fn(),
}));

vi.mock('node:http', () => ({
  createServer: createServerSpy,
  default: {
    createServer: createServerSpy.mockImplementation(() => {
      const handlers: Partial<Record<'error' | 'listening', (arg?: unknown) => void>> = {};
      const server = {
        close: (callback?: () => void) => callback?.(),
        listen: () => {
          const outcome = probeOutcomes.shift() ?? 'free';
          queueMicrotask(() => {
            if (outcome === 'inUse') {
              handlers.error?.({ code: 'EADDRINUSE' });
            } else {
              handlers.listening?.();
            }
          });
          return server;
        },
        once: (event: 'error' | 'listening', handler: (arg?: unknown) => void) => {
          handlers[event] = handler;
          return server;
        },
      };
      return server;
    }),
  },
}));

/**
 * `serve()` hands back a real `node:http` server, so the double is a real
 * EventEmitter: the bind path attaches an `'error'` listener to the returned
 * instance, and the async cases below drive it by emitting on that emitter.
 */
vi.mock('@hono/node-server', () => ({ serve: serveSpy }));

type FakeServer = EventEmitter & {
  close: typeof serverCloseSpy;
  closeAllConnections: typeof closeAllConnectionsSpy;
};

interface DeferredAttempt {
  /** Fires the `serve()` listening callback, as a real bind would once bound. */
  listen: () => void;
  options: { port: number; hostname: string };
  server: FakeServer;
}

function makeFakeServer(): FakeServer {
  return Object.assign(new EventEmitter(), {
    close: serverCloseSpy,
    closeAllConnections: closeAllConnectionsSpy,
  }) as FakeServer;
}

/** Reports `'listening'` synchronously — the baseline happy-path bind. */
function defaultServe(
  options: { port: number; hostname: string },
  onListen: (info: unknown) => void,
): FakeServer {
  const server = makeFakeServer();
  onListen({ address: options.hostname, port: options.port });
  return server;
}

/**
 * Queues `count` `serve()` calls that return an instance without reporting
 * `'listening'` — the shape of a real bind whose outcome only arrives after
 * `serve()` has handed the server back. Each captured attempt lets a test drive
 * that outcome by emitting `'error'` or calling `listen()`.
 */
function deferServeAttempts(count: number): DeferredAttempt[] {
  const attempts: DeferredAttempt[] = [];
  for (let i = 0; i < count; i += 1) {
    serveSpy.mockImplementationOnce(
      (options: { port: number; hostname: string }, onListen: (info: unknown) => void) => {
        const server = makeFakeServer();
        attempts.push({
          server,
          options,
          listen: () => onListen({ address: options.hostname, port: options.port }),
        });
        return server;
      },
    );
  }
  return attempts;
}

function bindError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`bind failed: ${code}`), { code });
}

describe('HTTP Transport lifecycle', () => {
  const mockContext: RequestContext = {
    requestId: 'transport-lifecycle-request',
    timestamp: new Date().toISOString(),
    operation: 'test-http-transport-lifecycle',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    probeOutcomes.length = 0;

    // mockClear leaves queued mockImplementationOnce entries in place, so a test
    // that queues more bind attempts than it consumes would hand them to the next.
    serveSpy.mockReset();
    serveSpy.mockImplementation(defaultServe);
    serverCloseSpy.mockImplementation((callback?: (err?: Error) => void) => callback?.());
    closeAllConnectionsSpy.mockImplementation(() => {});
    destroySpy.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('retries on EADDRINUSE and starts on the next port', async () => {
    vi.useFakeTimers();
    probeOutcomes.push('inUse', 'free');

    const { startHttpTransport } = await import('@/mcp-server/transports/http/httpServer.js');

    const handlePromise = startHttpTransport(
      () => Promise.resolve({} as McpServer),
      mockContext,
      defaultMeta,
    );

    await vi.advanceTimersByTimeAsync(5);
    const handle = await handlePromise;

    expect(createServerSpy).toHaveBeenCalledTimes(2);
    expect(serveSpy).toHaveBeenCalledTimes(1);
    expect(serveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: '127.0.0.1',
        port: 7001,
      }),
      expect.any(Function),
    );
    expect(startupBannerSpy).toHaveBeenCalledWith(
      '\n🚀 MCP Server running at: http://127.0.0.1:7001/mcp',
      'http',
    );
    expect(handle.server).toMatchObject({
      close: serverCloseSpy,
      closeAllConnections: closeAllConnectionsSpy,
    });
  });

  test('fails after exhausting the configured port retries', async () => {
    vi.useFakeTimers();
    probeOutcomes.push('inUse', 'inUse', 'inUse');

    const { startHttpTransport } = await import('@/mcp-server/transports/http/httpServer.js');

    const handlePromise = startHttpTransport(
      () => Promise.resolve({} as McpServer),
      mockContext,
      defaultMeta,
    );

    const rejection = expect(handlePromise).rejects.toThrow(
      'Failed to bind to any port after 2 retries.',
    );
    await vi.advanceTimersByTimeAsync(15);

    await rejection;
    expect(createServerSpy).toHaveBeenCalledTimes(3);
    expect(serveSpy).not.toHaveBeenCalled();
  });

  test('retries when the real server bind throws after a successful port probe', async () => {
    vi.useFakeTimers();
    probeOutcomes.push('free', 'free');
    serveSpy.mockImplementationOnce(() => {
      throw new Error('bind raced');
    });

    const { startHttpTransport } = await import('@/mcp-server/transports/http/httpServer.js');
    const handlePromise = startHttpTransport(
      () => Promise.resolve({} as McpServer),
      mockContext,
      defaultMeta,
    );

    await vi.advanceTimersByTimeAsync(5);
    const handle = await handlePromise;

    expect(serveSpy).toHaveBeenCalledTimes(2);
    expect(handle.server).toBeDefined();
  });

  test('retries when the real bind reports EADDRINUSE after serve() returns', async () => {
    vi.useFakeTimers();
    probeOutcomes.push('free', 'free');
    const attempts = deferServeAttempts(1);

    const { startHttpTransport } = await import('@/mcp-server/transports/http/httpServer.js');
    const handlePromise = startHttpTransport(
      () => Promise.resolve({} as McpServer),
      mockContext,
      defaultMeta,
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.options.port).toBe(7000);
    expect(startupBannerSpy).not.toHaveBeenCalled();

    attempts[0]?.server.emit('error', bindError('EADDRINUSE'));
    await vi.advanceTimersByTimeAsync(5);

    const handle = await handlePromise;
    expect(serveSpy).toHaveBeenCalledTimes(2);
    expect(serveSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ hostname: '127.0.0.1', port: 7001 }),
      expect.any(Function),
    );
    expect(startupBannerSpy).toHaveBeenCalledExactlyOnceWith(
      '\n🚀 MCP Server running at: http://127.0.0.1:7001/mcp',
      'http',
    );
    expect(handle.server).not.toBe(attempts[0]?.server);
  });

  test('rejects with the cause when the real bind reports a non-retryable error', async () => {
    vi.useFakeTimers();
    probeOutcomes.push('free');
    const attempts = deferServeAttempts(1);

    const { logger } = await import('@/utils/internal/logger.js');
    const infoSpy = vi.spyOn(logger, 'info');
    const { startHttpTransport } = await import('@/mcp-server/transports/http/httpServer.js');
    const settled = startHttpTransport(
      () => Promise.resolve({} as McpServer),
      mockContext,
      defaultMeta,
    ).catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(1);
    const permissionDenied = bindError('EACCES');
    attempts[0]?.server.emit('error', permissionDenied);
    await vi.advanceTimersByTimeAsync(20);

    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toBe(permissionDenied);
    // A privileged-port failure must not burn the ladder — port+1 fails the same way.
    expect(serveSpy).toHaveBeenCalledTimes(1);
    expect(startupBannerSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalledWith(
      'HTTP transport started successfully.',
      expect.anything(),
    );
  });

  test('reports no success when async bind errors exhaust the ladder', async () => {
    vi.useFakeTimers();
    probeOutcomes.push('free', 'free', 'free');
    const attempts = deferServeAttempts(3);

    const { logger } = await import('@/utils/internal/logger.js');
    const infoSpy = vi.spyOn(logger, 'info');
    const { startHttpTransport } = await import('@/mcp-server/transports/http/httpServer.js');
    const settled = startHttpTransport(
      () => Promise.resolve({} as McpServer),
      mockContext,
      defaultMeta,
    ).catch((err: unknown) => err);

    const lastError = bindError('EADDRINUSE');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await vi.advanceTimersByTimeAsync(5);
      expect(attempts).toHaveLength(attempt + 1);
      attempts[attempt]?.server.emit('error', attempt === 2 ? lastError : bindError('EADDRINUSE'));
    }
    await vi.advanceTimersByTimeAsync(5);

    const error = await settled;
    expect((error as Error).message).toBe('Failed to bind to any port after 2 retries.');
    expect((error as Error).cause).toBe(lastError);
    expect(attempts.map((a) => a.options.port)).toEqual([7000, 7001, 7002]);
    expect(startupBannerSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalledWith(
      'HTTP transport started successfully.',
      expect.anything(),
    );
  });

  test('ignores bind events that arrive after an attempt has settled', async () => {
    vi.useFakeTimers();
    probeOutcomes.push('free', 'free');
    const attempts = deferServeAttempts(2);

    const { startHttpTransport } = await import('@/mcp-server/transports/http/httpServer.js');
    const handlePromise = startHttpTransport(
      () => Promise.resolve({} as McpServer),
      mockContext,
      defaultMeta,
    );

    await vi.advanceTimersByTimeAsync(1);
    attempts[0]?.server.emit('error', bindError('EADDRINUSE'));
    await vi.advanceTimersByTimeAsync(5);
    attempts[1]?.listen();

    const handle = await handlePromise;
    expect(handle.server).toBe(attempts[1]?.server);
    expect(startupBannerSpy).toHaveBeenCalledTimes(1);

    // The abandoned attempt reporting 'listening' late must not resolve a second
    // time, log a banner for its dead port, or advance the ladder.
    attempts[0]?.listen();
    // A duplicate 'listening' on the settled attempt must not re-announce either.
    attempts[1]?.listen();
    await vi.advanceTimersByTimeAsync(20);

    expect(startupBannerSpy).toHaveBeenCalledExactlyOnceWith(
      '\n🚀 MCP Server running at: http://127.0.0.1:7001/mcp',
      'http',
    );
    expect(serveSpy).toHaveBeenCalledTimes(2);
    await expect(handlePromise).resolves.toBe(handle);
  });

  test('leaves no bind listener attached on any attempt', async () => {
    vi.useFakeTimers();
    probeOutcomes.push('free', 'inUse', 'free');
    const attempts = deferServeAttempts(2);

    const { startHttpTransport } = await import('@/mcp-server/transports/http/httpServer.js');
    const handlePromise = startHttpTransport(
      () => Promise.resolve({} as McpServer),
      mockContext,
      defaultMeta,
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(attempts[0]?.server.listenerCount('error')).toBe(1);
    attempts[0]?.server.emit('error', bindError('EADDRINUSE'));
    // Probe reports 7001 busy, so the third attempt lands on 7002.
    await vi.advanceTimersByTimeAsync(10);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.options.port).toBe(7002);
    expect(attempts[1]?.server.listenerCount('error')).toBe(1);
    attempts[1]?.listen();

    const handle = await handlePromise;
    for (const attempt of attempts) {
      expect(attempt.server.listenerCount('error')).toBe(0);
    }
    // The startup listener is detached once settled, so a later runtime 'error'
    // on the handed-over server surfaces instead of being silently absorbed.
    expect((handle.server as unknown as EventEmitter).listenerCount('error')).toBe(0);
  });

  test('stop destroys the session store and closes the server cleanly', async () => {
    const { SessionStore } = await import('@/mcp-server/transports/http/sessionStore.js');
    vi.spyOn(SessionStore.prototype, 'destroy').mockImplementation(destroySpy);

    probeOutcomes.push('free');

    const { startHttpTransport } = await import('@/mcp-server/transports/http/httpServer.js');

    const handle = await startHttpTransport(
      () => Promise.resolve({} as McpServer),
      mockContext,
      defaultMeta,
    );

    await handle.stop(mockContext);

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(serverCloseSpy).toHaveBeenCalledTimes(1);
    expect(closeAllConnectionsSpy).not.toHaveBeenCalled();
  });

  test('stop rejects when the Node server reports a close error', async () => {
    const closeError = new Error('close failed');
    serverCloseSpy.mockImplementationOnce((callback?: (err?: Error) => void) =>
      callback?.(closeError),
    );
    probeOutcomes.push('free');

    const { startHttpTransport } = await import('@/mcp-server/transports/http/httpServer.js');
    const handle = await startHttpTransport(
      () => Promise.resolve({} as McpServer),
      mockContext,
      defaultMeta,
    );

    await expect(handle.stop(mockContext)).rejects.toBe(closeError);
  });

  test('force-closes lingering connections after the drain timeout', async () => {
    vi.useFakeTimers();
    let closeCallback: ((err?: Error) => void) | undefined;
    serverCloseSpy.mockImplementationOnce((callback?: (err?: Error) => void) => {
      closeCallback = callback;
    });
    probeOutcomes.push('free');

    const { startHttpTransport } = await import('@/mcp-server/transports/http/httpServer.js');
    const handle = await startHttpTransport(
      () => Promise.resolve({} as McpServer),
      mockContext,
      defaultMeta,
    );
    const stopPromise = handle.stop(mockContext);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(closeAllConnectionsSpy).toHaveBeenCalledOnce();
    closeCallback?.();
    await stopPromise;
  });
});

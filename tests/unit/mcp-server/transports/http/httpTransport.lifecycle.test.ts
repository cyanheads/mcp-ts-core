/**
 * @fileoverview Unit tests for HTTP transport startup retry and shutdown lifecycle.
 * @module tests/mcp-server/transports/http/httpTransport.lifecycle
 */

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

vi.mock('@hono/node-server', () => ({
  serve: serveSpy.mockImplementation((options, onListen) => {
    const server = {
      close: serverCloseSpy,
      closeAllConnections: closeAllConnectionsSpy,
    };
    onListen({ address: options.hostname, port: options.port });
    return server;
  }),
}));

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

/**
 * @fileoverview Unit tests for TransportManager lifecycle and transport orchestration.
 * @module tests/mcp-server/transports/manager
 */

import type { McpRequestContext, McpServer, McpServerFactory } from '@modelcontextprotocol/server';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { beforeEach, describe, expect, it, type MockedFunction, vi } from 'vitest';
import type { AppConfig } from '@/config/index.js';
import { config } from '@/config/index.js';
import type { HeartbeatOptions } from '@/mcp-server/transports/heartbeat.js';
import { TransportManager } from '@/mcp-server/transports/manager.js';
import type { FrameworkServerFactory } from '@/mcp-server/types.js';
import { logger } from '@/utils/internal/logger.js';
import { defaultServerManifest as defaultMeta } from '../../../helpers/fixtures.js';

/** Every {@link HeartbeatMonitor} the manager constructed, newest last. */
const { heartbeats } = vi.hoisted(() => ({
  heartbeats: [] as Array<{
    options: HeartbeatOptions;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }>,
}));

// Mock the transport modules
vi.mock('@/mcp-server/transports/http/httpServer.js', () => ({
  startHttpTransport: vi.fn().mockResolvedValue({
    server: 'http-mock',
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/mcp-server/transports/stdio/stdioTransport.js', () => ({
  startStdioTransport: vi.fn(() => ({ close: vi.fn().mockResolvedValue(undefined) })),
  stopStdioTransport: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/mcp-server/transports/heartbeat.js', () => ({
  HeartbeatMonitor: class {
    start = vi.fn();
    stop = vi.fn();
    constructor(public options: HeartbeatOptions) {
      heartbeats.push(this);
    }
  },
  initHeartbeatMetrics: vi.fn(),
}));

/** Creates a config-like object with the given transport type. */
function fakeConfig(transportType: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...config,
    mcpTransportType: transportType,
    mcpHeartbeatIntervalMs: 5_000,
    mcpHeartbeatMissThreshold: 3,
    ...overrides,
  } as AppConfig;
}

/** The factory `startStdioTransport` was handed on the most recent start. */
async function capturedStdioFactory(): Promise<McpServerFactory> {
  const { startStdioTransport } = await import('@/mcp-server/transports/stdio/stdioTransport.js');
  const call = (startStdioTransport as ReturnType<typeof vi.fn>).mock.calls.at(-1);
  return call?.[0] as McpServerFactory;
}

describe('TransportManager', () => {
  let mockCreateMcpServer: MockedFunction<FrameworkServerFactory>;
  let mockMcpServer: McpServer;
  let pingSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    heartbeats.length = 0;

    pingSpy = vi.fn().mockResolvedValue({});
    mockMcpServer = {
      registerTool: vi.fn(),
      registerResource: vi.fn(),
      registerPrompt: vi.fn(),
      server: { request: pingSpy },
    } as unknown as McpServer;

    mockCreateMcpServer = vi.fn(async (_ctx: McpRequestContext) => mockMcpServer);
  });

  describe('start', () => {
    it('should start HTTP transport when configured', async () => {
      const manager = new TransportManager(
        fakeConfig('http'),
        logger,
        mockCreateMcpServer,
        defaultMeta,
      );

      await manager.start();

      const { startHttpTransport } = await import('@/mcp-server/transports/http/httpServer.js');
      expect(startHttpTransport).toHaveBeenCalledTimes(1);
      expect(startHttpTransport).toHaveBeenCalledWith(
        mockCreateMcpServer,
        expect.any(Object),
        defaultMeta,
        undefined,
      );
    });

    it('should start stdio transport when configured', async () => {
      const manager = new TransportManager(
        fakeConfig('stdio'),
        logger,
        mockCreateMcpServer,
        defaultMeta,
      );

      await manager.start();

      const { startStdioTransport } = await import(
        '@/mcp-server/transports/stdio/stdioTransport.js'
      );
      expect(startStdioTransport).toHaveBeenCalledTimes(1);
      expect(startStdioTransport).toHaveBeenCalledWith(expect.any(Function), expect.any(Object));
    });

    it('should throw error for unsupported transport type', async () => {
      const manager = new TransportManager(
        fakeConfig('invalid-transport'),
        logger,
        mockCreateMcpServer,
        defaultMeta,
      );

      await expect(manager.start()).rejects.toThrow(
        'Unsupported transport type: invalid-transport',
      );
    });

    it('creates the MCP server instance lazily, when serveStdio calls the factory', async () => {
      const manager = new TransportManager(
        fakeConfig('stdio'),
        logger,
        mockCreateMcpServer,
        defaultMeta,
      );

      await manager.start();
      // `serveStdio` owns the era decision, so nothing is built until it asks.
      expect(mockCreateMcpServer).not.toHaveBeenCalled();

      const factory = await capturedStdioFactory();
      await expect(factory({ era: 'legacy' })).resolves.toBe(mockMcpServer);
      expect(mockCreateMcpServer).toHaveBeenCalledTimes(1);
      expect(mockCreateMcpServer).toHaveBeenCalledWith({ era: 'legacy' });
    });

    it('should pass factory (not instance) for HTTP transport', async () => {
      const manager = new TransportManager(
        fakeConfig('http'),
        logger,
        mockCreateMcpServer,
        defaultMeta,
      );

      await manager.start();
      // HTTP transport receives factory — does NOT eagerly create an instance
      expect(mockCreateMcpServer).not.toHaveBeenCalled();
    });

    it('should store server instance after successful start', async () => {
      const manager = new TransportManager(config, logger, mockCreateMcpServer, defaultMeta);
      await manager.start();

      const server = manager.getServer();
      expect(server).toBeDefined();
      expect(server).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // The stdio heartbeat is started from inside the factory callback, because
  // only there is the pinned instance — and its era — visible.
  // -------------------------------------------------------------------------
  describe('stdio heartbeat', () => {
    /** Starts a stdio manager and returns it alongside its captured factory. */
    async function startStdio(overrides: Partial<AppConfig> = {}) {
      const manager = new TransportManager(
        fakeConfig('stdio', overrides),
        logger,
        mockCreateMcpServer,
        defaultMeta,
      );
      await manager.start();
      return { manager, factory: await capturedStdioFactory() };
    }

    it('starts for a legacy-era connection', async () => {
      const { factory } = await startStdio();

      await factory({ era: 'legacy' });

      expect(heartbeats).toHaveLength(1);
      expect(heartbeats[0]?.start).toHaveBeenCalledTimes(1);
      expect(heartbeats[0]?.options).toMatchObject({
        intervalMs: 5_000,
        missThreshold: 3,
        transport: 'stdio',
      });
    });

    // The 2026-07-28 revision has no server-to-client request channel, so a
    // server-initiated ping has nowhere to go.
    it('does not start for a modern-era connection', async () => {
      const { factory } = await startStdio();

      await factory({ era: 'modern' });

      expect(heartbeats).toHaveLength(0);
    });

    it('is guarded against re-entry — the factory also runs for a discarded discover probe', async () => {
      const { factory } = await startStdio();

      await factory({ era: 'legacy' });
      await factory({ era: 'legacy' });

      expect(heartbeats).toHaveLength(1);
      expect(mockCreateMcpServer).toHaveBeenCalledTimes(2);
    });

    it('stays off when the heartbeat interval is disabled', async () => {
      const { factory } = await startStdio({ mcpHeartbeatIntervalMs: 0 } as Partial<AppConfig>);

      await factory({ era: 'legacy' });

      expect(heartbeats).toHaveLength(0);
    });

    it('pings through the pinned instance with a bounded timeout', async () => {
      const { factory } = await startStdio({
        mcpHeartbeatIntervalMs: 30_000,
      } as Partial<AppConfig>);
      await factory({ era: 'legacy' });

      await heartbeats[0]?.options.sendPing();

      // The ping timeout is capped at 10s regardless of a longer interval.
      expect(pingSpy).toHaveBeenCalledWith({ method: 'ping' }, { timeout: 10_000 });
    });

    it('stops with the transport', async () => {
      const { manager, factory } = await startStdio();
      await factory({ era: 'legacy' });

      await manager.stop('SIGTERM');

      expect(heartbeats[0]?.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop', () => {
    it('should stop HTTP transport when active', async () => {
      const manager = new TransportManager(
        fakeConfig('http'),
        logger,
        mockCreateMcpServer,
        defaultMeta,
      );
      await manager.start();

      const { startHttpTransport } = await import('@/mcp-server/transports/http/httpServer.js');
      const handle = await (startHttpTransport as ReturnType<typeof vi.fn>).mock.results.at(-1)
        ?.value;

      await manager.stop('SIGTERM');
      expect(handle.stop).toHaveBeenCalledTimes(1);
    });

    it('should stop stdio transport when active', async () => {
      const manager = new TransportManager(
        fakeConfig('stdio'),
        logger,
        mockCreateMcpServer,
        defaultMeta,
      );
      await manager.start();

      const { startStdioTransport, stopStdioTransport } = await import(
        '@/mcp-server/transports/stdio/stdioTransport.js'
      );
      const handle = (startStdioTransport as ReturnType<typeof vi.fn>).mock.results.at(-1)
        ?.value as StdioServerHandle;

      await manager.stop('SIGTERM');

      expect(stopStdioTransport).toHaveBeenCalledTimes(1);
      expect(stopStdioTransport).toHaveBeenCalledWith(handle, expect.any(Object));
    });

    it('should handle stop when no server instance is active', async () => {
      const freshManager = new TransportManager(config, logger, mockCreateMcpServer, defaultMeta);

      await expect(freshManager.stop('SIGTERM')).resolves.toBeUndefined();
    });

    it('clears the stored server instance', async () => {
      const manager = new TransportManager(config, logger, mockCreateMcpServer, defaultMeta);
      await manager.start();
      await manager.stop('SIGINT');

      expect(manager.getServer()).toBeNull();
    });
  });

  describe('getServer', () => {
    it('should return null before start is called', () => {
      const freshManager = new TransportManager(config, logger, mockCreateMcpServer, defaultMeta);

      expect(freshManager.getServer()).toBeNull();
    });

    it('should return server instance after start', async () => {
      const manager = new TransportManager(config, logger, mockCreateMcpServer, defaultMeta);
      await manager.start();

      const server = manager.getServer();
      expect(server).not.toBeNull();
    });
  });
});

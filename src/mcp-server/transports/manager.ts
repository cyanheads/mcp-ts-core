/**
 * @fileoverview Manages the lifecycle of the configured MCP transport.
 * @module src/mcp-server/transports/manager
 */
import type { McpServer } from '@modelcontextprotocol/server';

import type { AppConfig as AppConfigType } from '@/config/index.js';
import type { ServerManifest } from '@/core/serverManifest.js';
import { HeartbeatMonitor } from '@/mcp-server/transports/heartbeat.js';
import { startHttpTransport } from '@/mcp-server/transports/http/httpServer.js';
import type { TransportServer } from '@/mcp-server/transports/ITransport.js';
import {
  startStdioTransport,
  stopStdioTransport,
} from '@/mcp-server/transports/stdio/stdioTransport.js';
import type { FrameworkServerFactory } from '@/mcp-server/types.js';
import type { logger as LoggerType } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

export class TransportManager {
  private serverInstance: TransportServer | null = null;
  private shutdown: ((context: RequestContext) => Promise<void>) | null = null;
  private heartbeat: HeartbeatMonitor | null = null;

  constructor(
    private config: AppConfigType,
    private logger: typeof LoggerType,
    private createMcpServer: FrameworkServerFactory,
    private manifest: ServerManifest,
  ) {}

  async start(): Promise<void> {
    const context = requestContextService.createRequestContext({
      operation: 'TransportManager.start',
      additionalContext: { transport: this.config.mcpTransportType },
    });

    this.logger.info(`Starting transport: ${this.config.mcpTransportType}`, context);

    if (this.config.mcpTransportType === 'http') {
      const handle = await startHttpTransport(this.createMcpServer, context, this.manifest);
      this.serverInstance = handle.server;
      this.shutdown = (ctx) => handle.stop(ctx);
    } else if (this.config.mcpTransportType === 'stdio') {
      // `serveStdio` owns the era decision and pins one instance for the
      // connection, so the factory is where the pinned server becomes visible.
      const handle = startStdioTransport(async (requestContext) => {
        const mcpServer = await this.createMcpServer(requestContext);
        if (requestContext.era === 'legacy') this.startStdioHeartbeat(mcpServer, context);
        return mcpServer;
      }, context);
      this.serverInstance = handle;

      this.shutdown = async (ctx) => {
        this.heartbeat?.stop();
        this.heartbeat = null;
        await stopStdioTransport(handle, ctx);
      };
    } else {
      const transportType = String(this.config.mcpTransportType);
      const error = new Error(`Unsupported transport type: ${transportType}`);
      this.logger.crit(error.message, context);
      throw error;
    }
  }

  /**
   * Periodically pings the client to detect dead connections (orphaned child
   * processes, crashed hosts).
   *
   * Legacy-era connections only: the 2026-07-28 revision removes the
   * server-to-client request channel, so a server-initiated `ping` has nowhere
   * to go there. Guarded against re-entry because the factory also runs for a
   * discarded `server/discover` probe.
   */
  private startStdioHeartbeat(mcpServer: McpServer, context: RequestContext): void {
    if (this.heartbeat || this.config.mcpHeartbeatIntervalMs <= 0) return;

    const timeoutMs = Math.min(this.config.mcpHeartbeatIntervalMs, 10_000);
    this.heartbeat = new HeartbeatMonitor(
      {
        intervalMs: this.config.mcpHeartbeatIntervalMs,
        missThreshold: this.config.mcpHeartbeatMissThreshold,
        sendPing: () => mcpServer.server.request({ method: 'ping' }, { timeout: timeoutMs }),
        onDead: () => void this.stop('heartbeat_timeout'),
        transport: 'stdio',
      },
      context,
    );
    this.heartbeat.start();
  }

  async stop(signal: string): Promise<void> {
    const context = requestContextService.createRequestContext({
      operation: 'TransportManager.stop',
      additionalContext: { signal },
    });

    if (!this.shutdown) {
      this.logger.warning('Stop called but no active server instance found.', context);
      return;
    }

    await this.shutdown(context);

    this.serverInstance = null;
    this.shutdown = null;
  }

  getServer(): TransportServer | null {
    return this.serverInstance;
  }
}

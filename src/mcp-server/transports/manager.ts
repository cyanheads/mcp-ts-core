/**
 * @fileoverview Manages the lifecycle of the configured MCP transport.
 * @module src/mcp-server/transports/manager
 */
import { EmptyResultSchema } from '@modelcontextprotocol/sdk/types.js';

import type { AppConfig as AppConfigType } from '@/config/index.js';
import type { ServerManifest } from '@/core/serverManifest.js';
import type { McpServerFactory } from '@/mcp-server/protocolSession.js';
import type { TaskManager } from '@/mcp-server/tasks/core/taskManager.js';
import { HeartbeatMonitor } from '@/mcp-server/transports/heartbeat.js';
import { startHttpTransport } from '@/mcp-server/transports/http/httpServer.js';
import type { TransportServer } from '@/mcp-server/transports/ITransport.js';
import {
  startStdioTransport,
  stopStdioTransport,
} from '@/mcp-server/transports/stdio/stdioTransport.js';
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
    private createMcpServer: McpServerFactory,
    private taskManager: TaskManager,
    private manifest: ServerManifest,
  ) {}

  async start(): Promise<void> {
    const context = requestContextService.createRequestContext({
      operation: 'TransportManager.start',
      transport: this.config.mcpTransportType,
    });

    this.logger.info(`Starting transport: ${this.config.mcpTransportType}`, context);

    if (this.config.mcpTransportType === 'http') {
      // HTTP: pass factory so each request gets a fresh McpServer+transport pair
      // (SDK 1.26.0 security fix — GHSA-345p-7cg4-v4c7)
      const handle = await startHttpTransport(this.createMcpServer, context, this.manifest);
      this.serverInstance = handle.server;
      this.shutdown = (ctx) => handle.stop(ctx);
    } else if (this.config.mcpTransportType === 'stdio') {
      // Stdio: single client, single connection — one server instance is correct
      const mcpServer = await this.createMcpServer();
      this.serverInstance = await startStdioTransport(mcpServer, context);

      // Start heartbeat for stdio transport — periodically pings the client
      // to detect dead connections (orphaned child processes, crashed hosts).
      if (this.config.mcpHeartbeatIntervalMs > 0) {
        const timeoutMs = Math.min(this.config.mcpHeartbeatIntervalMs, 10_000);
        this.heartbeat = new HeartbeatMonitor(
          {
            intervalMs: this.config.mcpHeartbeatIntervalMs,
            missThreshold: this.config.mcpHeartbeatMissThreshold,
            sendPing: () =>
              mcpServer.server.request({ method: 'ping' }, EmptyResultSchema, {
                timeout: timeoutMs,
              }),
            onDead: () => void this.stop('heartbeat_timeout'),
            transport: 'stdio',
          },
          context,
        );
        this.heartbeat.start();
      }

      this.shutdown = async (ctx) => {
        this.heartbeat?.stop();
        this.heartbeat = null;
        await stopStdioTransport(mcpServer, ctx);
      };
    } else {
      const transportType = String(this.config.mcpTransportType);
      const error = new Error(`Unsupported transport type: ${transportType}`);
      this.logger.crit(error.message, context);
      throw error;
    }
  }

  async stop(signal: string): Promise<void> {
    const context = requestContextService.createRequestContext({
      operation: 'TransportManager.stop',
      signal,
    });

    if (!this.shutdown) {
      this.logger.warning('Stop called but no active server instance found.', context);
      return;
    }

    await this.shutdown(context);

    // Clean up task manager timers to allow clean process exit
    this.taskManager.cleanup();

    this.serverInstance = null;
    this.shutdown = null;
  }

  getServer(): TransportServer | null {
    return this.serverInstance;
  }
}

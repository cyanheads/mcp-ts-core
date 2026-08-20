/**
 * @fileoverview Node.js HTTP server bootstrap for the MCP transport.
 * Splits the Node-only `@hono/node-server` `serve()` start path and `node:http`
 * port-probe out of `httpTransport.ts` so the Worker bundle (which only needs
 * `createHttpApp`) can drop both via tree-shaking.
 * @module src/mcp-server/transports/http/httpServer
 */

import http from 'node:http';
import { type ServerType, serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { config } from '@/config/index.js';
import type { ServerManifest } from '@/core/serverManifest.js';
import { createHttpApp } from '@/mcp-server/transports/http/httpTransport.js';
import type { HonoNodeBindings } from '@/mcp-server/transports/http/httpTypes.js';
import type { FrameworkServerFactory } from '@/mcp-server/types.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { logStartupBanner } from '@/utils/internal/startupBanner.js';

/**
 * Handle returned by {@link startHttpTransport} bundling the HTTP server
 * and a shutdown function that cleans up all associated resources
 * (session store intervals, etc.).
 */
export interface HttpTransportHandle {
  server: ServerType;
  stop: (parentContext: RequestContext) => Promise<void>;
}

function isPortInUse(port: number, host: string, parentContext: RequestContext): Promise<boolean> {
  const context = { ...parentContext, operation: 'isPortInUse', port, host };
  logger.debug(`Checking if port ${port} is in use...`, context);
  return new Promise((resolve) => {
    const tempServer = http.createServer();
    tempServer
      .once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EADDRINUSE'))
      .once('listening', () => tempServer.close(() => resolve(false)))
      .listen(port, host);
  });
}

function startHttpServerWithRetry<TBindings extends object = HonoNodeBindings>(
  app: Hono<{ Bindings: TBindings }>,
  initialPort: number,
  host: string,
  maxRetries: number,
  parentContext: RequestContext,
): Promise<ServerType> {
  const startContext = {
    ...parentContext,
    operation: 'startHttpServerWithRetry',
  };
  logger.info(
    `Attempting to start HTTP server on port ${initialPort} with ${maxRetries} retries.`,
    startContext,
  );

  const { promise, resolve, reject } = Promise.withResolvers<ServerType>();

  const tryBind = (port: number, attempt: number) => {
    if (attempt > maxRetries + 1) {
      const error = new Error(`Failed to bind to any port after ${maxRetries} retries.`);
      logger.fatal(error.message, { ...startContext, port, attempt });
      return reject(error);
    }

    isPortInUse(port, host, { ...startContext, port, attempt })
      .then((inUse) => {
        if (inUse) {
          logger.warning(`Port ${port} is in use, retrying...`, {
            ...startContext,
            port,
            attempt,
          });
          setTimeout(() => tryBind(port + 1, attempt + 1), config.mcpHttpPortRetryDelayMs);
          return;
        }

        try {
          const serverInstance = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
            const serverAddress = `http://${info.address}:${info.port}${config.mcpHttpEndpointPath}`;
            logger.info(`HTTP transport listening at ${serverAddress}`, {
              ...startContext,
              port,
              address: serverAddress,
            });
            logStartupBanner(`\n🚀 MCP Server running at: ${serverAddress}`, 'http');
          });
          resolve(serverInstance);
        } catch (err: unknown) {
          logger.warning(`Binding attempt failed for port ${port}, retrying...`, {
            ...startContext,
            port,
            attempt,
            error: String(err),
          });
          setTimeout(() => tryBind(port + 1, attempt + 1), config.mcpHttpPortRetryDelayMs);
        }
      })
      .catch((err) => reject(err instanceof Error ? err : new Error(String(err))));
  };

  tryBind(initialPort, 1);
  return promise;
}

export async function startHttpTransport(
  serverFactory: FrameworkServerFactory,
  parentContext: RequestContext,
  manifest: ServerManifest,
): Promise<HttpTransportHandle> {
  const transportContext = {
    ...parentContext,
    component: 'HttpTransportStart',
  };
  logger.info('Starting HTTP transport.', transportContext);

  const { app, close } = await createHttpApp(serverFactory, transportContext, manifest);

  const server = await startHttpServerWithRetry(
    app,
    config.mcpHttpPort,
    config.mcpHttpHost,
    config.mcpHttpMaxPortRetries,
    transportContext,
  );

  logger.info('HTTP transport started successfully.', transportContext);

  return {
    server,
    stop: (ctx: RequestContext) => stopHttpTransport(server, close, ctx),
  };
}

/** Max time (ms) to wait for in-flight connections (e.g. SSE streams) to drain. */
const DRAIN_TIMEOUT_MS = 5_000;

async function stopHttpTransport(
  server: ServerType,
  closeApp: () => Promise<void>,
  parentContext: RequestContext,
): Promise<void> {
  const operationContext = {
    ...parentContext,
    operation: 'stopHttpTransport',
    transportType: 'Http',
  };
  logger.info('Attempting to stop http transport...', operationContext);

  // Tear the MCP layer down first: aborts in-flight modern exchanges, closes
  // per-request instances, and closes every live session's server + transport.
  await closeApp();

  return new Promise<void>((resolve, reject) => {
    // Force-close all connections (including pre-existing SSE streams) after a
    // grace period. server.closeAllConnections() (Node 18.2+) covers sockets
    // that were already alive before server.close() — unlike the `connection`
    // event which only fires for new arrivals.
    const drainTimer = setTimeout(() => {
      logger.warning('Drain timeout reached — force-closing all connections.', operationContext);
      (server as http.Server).closeAllConnections();
    }, DRAIN_TIMEOUT_MS);
    drainTimer.unref();

    server.close((err) => {
      clearTimeout(drainTimer);
      if (err) {
        logger.error('Error closing HTTP server.', err, operationContext);
        return reject(err);
      }
      logger.info('HTTP server closed successfully.', operationContext);
      resolve();
    });
  });
}

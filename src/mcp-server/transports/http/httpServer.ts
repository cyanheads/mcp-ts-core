/**
 * @fileoverview Node.js HTTP server bootstrap for the MCP transport.
 * Splits the Node-only `@hono/node-server` `serve()` start path and `node:http`
 * port-probe out of `httpTransport.ts` so the Worker bundle (which only needs
 * `createHttpApp`) can drop both via tree-shaking.
 * @module src/mcp-server/transports/http/httpServer
 */

import http from 'node:http';
import { type ServerType, serve } from '@hono/node-server';
import type { ServerEventBus } from '@modelcontextprotocol/server';
import type { Hono } from 'hono';
import { config } from '@/config/index.js';
import type { ServerManifest } from '@/core/serverManifest.js';
import { createHttpApp } from '@/mcp-server/transports/http/httpTransport.js';
import type { HonoNodeBindings } from '@/mcp-server/transports/http/httpTypes.js';
import type { FrameworkServerFactory } from '@/mcp-server/types.js';
import { logger } from '@/utils/internal/logger.js';
import { type RequestContext, withExtra } from '@/utils/internal/requestContext.js';
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

/**
 * Cheap pre-check for an occupied port. It is a TOCTOU probe and nothing more:
 * the socket it opens is closed before the real bind, another process can claim
 * the port in between, and any failure other than `EADDRINUSE` (e.g. `EACCES` on
 * a privileged port) reports the port as free. The real `serve()` call therefore
 * observes its own bind outcome rather than trusting this answer.
 */
function isPortInUse(port: number, host: string, parentContext: RequestContext): Promise<boolean> {
  const context = withExtra({ ...parentContext, operation: 'isPortInUse' }, { port, host });
  logger.debug(`Checking if port ${port} is in use...`, context);
  return new Promise((resolve) => {
    const tempServer = http.createServer();
    tempServer
      .once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EADDRINUSE'))
      .once('listening', () => tempServer.close(() => resolve(false)))
      .listen(port, host);
  });
}

/**
 * Bind failures that no later rung of the ladder can clear.
 *
 * Each rung only changes the port, so a failure tied to privileges or to the
 * host address fails identically on port+1: walking 81, 82, 83 as a non-root
 * user burns the whole ladder on a condition that will never clear. `EACCES`
 * (privileged port, or blocked by policy) and `EADDRNOTAVAIL` (host address not
 * local to this machine) therefore reject immediately; every other failure —
 * `EADDRINUSE` above all — retries.
 *
 * Runtime split: Node reports a permission-denied bind as `EACCES`, while Bun
 * reports it as `EADDRINUSE` ("Is port 80 in use?"). Nothing can tell Bun's
 * relabeled permission error from a genuine collision, so on Bun a privileged
 * port reads as a collision and walks the ladder before failing.
 */
const NON_RETRYABLE_BIND_CODES = new Set(['EACCES', 'EADDRNOTAVAIL']);

function isRetryableBindError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return code === undefined || !NON_RETRYABLE_BIND_CODES.has(code);
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
  let lastBindError: unknown;

  const scheduleRetry = (port: number, attempt: number) =>
    setTimeout(() => tryBind(port + 1, attempt + 1), config.mcpHttpPortRetryDelayMs);

  /** Routes one attempt's bind failure: reject with the cause, or take the next rung. */
  const handleBindFailure = (err: unknown, port: number, attempt: number) => {
    lastBindError = err;

    if (!isRetryableBindError(err)) {
      const error = new Error(`Failed to bind HTTP server to ${host}:${port}.`, { cause: err });
      logger.fatal(error.message, withExtra(startContext, { port, attempt, error: String(err) }));
      reject(error);
      return;
    }

    logger.warning(
      `Binding attempt failed for port ${port}, retrying...`,
      withExtra(startContext, { port, attempt, error: String(err) }),
    );
    scheduleRetry(port, attempt);
  };

  /**
   * Runs one bind attempt and settles it exactly once.
   *
   * `serve()` returns the `node:http` server synchronously without attaching an
   * `'error'` listener of its own, so this listener is the only thing that
   * observes a bind failure surfacing after that return (a TOCTOU collision the
   * probe could not see, among others). Without it the failure escapes to the
   * process-wide `uncaughtException` handler — after startup has already been
   * reported successful.
   *
   * Whichever of `'listening'` / `'error'` lands first wins: the loser is
   * ignored, and the listener is detached on success so a later runtime error on
   * the handed-over server is not silently absorbed here.
   */
  const bind = (port: number, attempt: number) => {
    let settled = false;
    let listening = false;
    let instance: ServerType | undefined;

    const onError = (err: unknown) => {
      if (settled) return;
      settled = true;
      handleBindFailure(err, port, attempt);
    };

    // Resolve only once the server has confirmed it is listening AND `serve()`
    // has handed back the instance; the callback runs asynchronously on a real
    // bind, but nothing guarantees it runs after `serve()` returns.
    const settleListening = () => {
      if (settled || !listening || !instance) return;
      settled = true;
      instance.off('error', onError);
      resolve(instance);
    };

    try {
      const serverInstance = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
        if (settled) return;
        listening = true;
        const serverAddress = `http://${info.address}:${info.port}${config.mcpHttpEndpointPath}`;
        logger.info(
          `HTTP transport listening at ${serverAddress}`,
          withExtra(startContext, { port, address: serverAddress }),
        );
        logStartupBanner(`\n🚀 MCP Server running at: ${serverAddress}`, 'http');
        settleListening();
      });
      instance = serverInstance;
      serverInstance.once('error', onError);
      settleListening();
    } catch (err: unknown) {
      // A synchronous throw from serve() routes through the same settle guard.
      onError(err);
    }
  };

  const tryBind = (port: number, attempt: number) => {
    if (attempt > maxRetries + 1) {
      const error = new Error(
        `Failed to bind to any port after ${maxRetries} retries.`,
        lastBindError === undefined ? undefined : { cause: lastBindError },
      );
      logger.fatal(error.message, withExtra(startContext, { port, attempt }));
      return reject(error);
    }

    isPortInUse(port, host, withExtra(startContext, { attempt }))
      .then((inUse) => {
        if (inUse) {
          logger.warning(
            `Port ${port} is in use, retrying...`,
            withExtra(startContext, { port, attempt }),
          );
          scheduleRetry(port, attempt);
          return;
        }
        bind(port, attempt);
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
  bus?: ServerEventBus,
): Promise<HttpTransportHandle> {
  const transportContext = withExtra(parentContext, { component: 'HttpTransportStart' });
  logger.info('Starting HTTP transport.', transportContext);

  const { app, close } = await createHttpApp(serverFactory, transportContext, manifest, bus);

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
  const operationContext = withExtra(
    { ...parentContext, operation: 'stopHttpTransport' },
    { transportType: 'Http' },
  );
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

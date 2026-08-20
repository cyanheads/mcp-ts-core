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
import type { McpServerFactory } from '@modelcontextprotocol/server';
import { type StdioServerHandle, serveStdio } from '@modelcontextprotocol/server/stdio';

import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { logStartupBanner } from '@/utils/internal/startupBanner.js';

/**
 * Serves MCP over this process's stdio from the supplied server factory.
 *
 * The SDK's `StdioServerTransport` reads newline-delimited JSON-RPC from stdin
 * and writes it to stdout, skipping non-JSON stdout lines rather than failing on
 * them. Logging via the `logger` utility goes to stderr, which the spec permits.
 *
 * @param serverFactory - Produces the `McpServer` pinned to the connection.
 * @param parentContext - The logging and tracing context from the caller.
 * @returns The connection handle, whose `close()` tears down the pinned
 *   instance and the underlying transport.
 * @throws {Error} If the connection fails during setup.
 */
export function startStdioTransport(
  serverFactory: McpServerFactory,
  parentContext: RequestContext,
): StdioServerHandle {
  const operationContext = {
    ...parentContext,
    operation: 'connectStdioTransport',
    transportType: 'Stdio',
  };
  logger.info('Attempting to connect stdio transport...', operationContext);

  try {
    const handle = serveStdio(serverFactory, {
      onerror: (error) => {
        logger.debug(`Stdio transport reported: ${error.message}`, operationContext);
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

export async function stopStdioTransport(
  handle: StdioServerHandle,
  parentContext: RequestContext,
): Promise<void> {
  const operationContext = {
    ...parentContext,
    operation: 'stopStdioTransport',
    transportType: 'Stdio',
  };
  logger.info('Attempting to stop stdio transport...', operationContext);
  await handle.close();
  logger.info('Stdio transport stopped successfully.', operationContext);
}

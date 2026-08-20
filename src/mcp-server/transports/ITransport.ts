/**
 * @fileoverview Defines transport-related types.
 * @module src/mcp-server/transports/ITransport
 */
import type { ServerType } from '@hono/node-server';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';

export type TransportServer = ServerType | StdioServerHandle;

/**
 * Transport lifecycle contract for HTTP and stdio transports.
 */
export interface ITransport {
  start(): Promise<TransportServer>;
  stop(): Promise<void>;
}

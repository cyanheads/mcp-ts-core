/**
 * @fileoverview Request-spanning protocol state hooks for transports that
 * create a fresh MCP SDK server for every request.
 *
 * The SDK stores negotiated capabilities and cancellation controllers on a
 * `Server` instance. Streamable HTTP deliberately cannot reuse that instance
 * across requests (GHSA-345p-7cg4-v4c7), so the framework carries only the
 * minimal session state needed by handler contexts through these hooks.
 *
 * @module src/mcp-server/protocolSession
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ClientCapabilities, RequestId } from '@modelcontextprotocol/sdk/types.js';

/** A cancellation signal registered for one in-flight JSON-RPC request. */
export interface ProtocolRequestRegistration {
  /** Aborted when a matching `notifications/cancelled` reaches the session. */
  signal: AbortSignal;
  /** Removes only this registration; safe to call more than once. */
  unregister: () => void;
}

/**
 * State restored onto a per-request server from its durable HTTP session.
 * Undefined for stdio and stateless HTTP, where no cross-request restoration
 * is necessary or possible.
 */
export interface ProtocolSessionHooks {
  /** Capabilities captured from the successful initialize request. */
  clientCapabilities?: ClientCapabilities;
  /** Registers a tool/resource request for cross-request cancellation. */
  registerRequest?: (requestId: RequestId) => ProtocolRequestRegistration;
}

/** Factory shared by stdio (no hooks) and per-request HTTP servers. */
export type McpServerFactory = (session?: ProtocolSessionHooks) => Promise<McpServer>;

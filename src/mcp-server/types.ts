/**
 * @fileoverview Shared MCP server types and the cross-transport constants and
 * resolutions they depend on.
 * @module src/mcp-server/types
 */
import type { McpRequestContext, McpServer } from '@modelcontextprotocol/server';

import type { AppConfig } from '@/config/index.js';

/**
 * The framework's server factory: one configured {@link McpServer} per serving
 * unit — one HTTP request under `createMcpHandler`, or one connection under
 * `serveStdio`.
 *
 * Narrower than the SDK's `McpServerFactory` (which also admits the low-level
 * `Server`) so callers keep access to the high-level surface, while staying
 * assignable to it.
 */
export type FrameworkServerFactory = (ctx: McpRequestContext) => Promise<McpServer>;

/**
 * MCP protocol revision 2026-07-28 — the fully per-request era.
 *
 * Not part of the SDK's `SUPPORTED_PROTOCOL_VERSIONS`, which lists only the
 * revisions negotiated through `initialize`. This one is selected per request by
 * the `_meta` envelope, so it has to be named explicitly wherever the framework
 * advertises what it serves.
 */
export const MODERN_PROTOCOL_REVISION = '2026-07-28';

/**
 * The session mode a server actually runs in. `MCP_SESSION_MODE=auto` is a
 * configuration input, never a running state — see {@link resolveSessionMode}.
 */
export type ResolvedSessionMode = 'stateful' | 'stateless';

/**
 * Resolves the configured `MCP_SESSION_MODE` to the mode the server runs in.
 *
 * `auto` resolves to `stateful`: the 2025-era legacy leg needs a live session
 * for the SDK's multi-round-trip shim, and MCP spec conformance expects a
 * session-bearing HTTP server by default. Every consumer of the distinction —
 * the HTTP transport's session store, the handler factories' `ctx.sessionId`
 * gate, and the advertised `transport.sessionMode` on the manifest — reads this
 * one function, so the resolution can never differ between what a server does
 * and what it publishes (#357).
 */
export function resolveSessionMode(mode: AppConfig['mcpSessionMode']): ResolvedSessionMode {
  return mode === 'auto' ? 'stateful' : mode;
}

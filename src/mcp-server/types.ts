/**
 * @fileoverview Shared MCP server types.
 * @module src/mcp-server/types
 */
import type { McpRequestContext, McpServer } from '@modelcontextprotocol/server';

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

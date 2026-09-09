/**
 * @fileoverview The origin the HTTP transport advertises in links it emits.
 * @module src/mcp-server/transports/http/publicOrigin
 */

/**
 * `MCP_PUBLIC_URL` when configured (the server may sit behind a proxy whose
 * public origin the request cannot see), otherwise the request's own origin.
 * Never carries a trailing slash, so callers append paths directly.
 */
export function resolvePublicOrigin(publicUrl: string | undefined, requestUrl: string): string {
  return (publicUrl ?? new URL(requestUrl).origin).replace(/\/$/, '');
}

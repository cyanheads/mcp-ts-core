/**
 * @fileoverview The origin the HTTP transport advertises in links it emits.
 * @module src/mcp-server/transports/http/publicOrigin
 */

/**
 * `MCP_PUBLIC_URL` when configured (the server may sit behind a proxy whose
 * public origin the request cannot see), otherwise the request's own origin.
 * Either comes back in its WHATWG URL serialization — ASCII only, the host
 * punycoded and the path percent-encoded — because it reaches a response
 * header, the 401 challenge's `resource_metadata`. Never carries a trailing
 * slash, so callers append paths directly.
 */
export function resolvePublicOrigin(publicUrl: string | undefined, requestUrl: string): string {
  const url = publicUrl === undefined ? new URL(requestUrl).origin : new URL(publicUrl).href;
  return url.replace(/\/+$/, '');
}

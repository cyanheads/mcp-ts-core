/**
 * @fileoverview Hono route handler for `GET /robots.txt`. Returns a small
 * crawl directive that allows the landing page (so Google / Bing / Mastodon
 * preview crawlers can index the server's tool inventory and structured data)
 * while disallowing the JSON-RPC endpoint (which only accepts POST and would
 * waste bot traffic on 405 responses).
 *
 * @module src/mcp-server/transports/http/robotsTxt
 */

import type { Context } from 'hono';

import type { ServerManifest } from '@/core/serverManifest.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

/**
 * Build the robots.txt body from the manifest. Disallows the MCP JSON-RPC
 * endpoint; everything else (`/`, `/.well-known/mcp.json`,
 * `/.well-known/oauth-protected-resource`, `/healthz`) is implicitly allowed.
 */
export function buildRobotsTxt(manifest: ServerManifest): string {
  const endpoint = manifest.transport.endpointPath;
  return ['User-agent: *', 'Allow: /', `Disallow: ${endpoint}`, ''].join('\n');
}

/**
 * Hono route handler for `GET /robots.txt`.
 * Sets `Content-Type: text/plain` per the robots.txt spec and a 24-hour
 * public cache so polite crawlers don't re-fetch on every visit.
 */
export function createRobotsTxtHandler(manifest: ServerManifest) {
  const body = buildRobotsTxt(manifest);
  return (c: Context): Response => {
    const context = requestContextService.createRequestContext({
      operation: 'robotsTxtHandler',
    });
    logger.debug('Serving robots.txt.', { ...context, bytes: body.length });
    c.header('Content-Type', 'text/plain; charset=utf-8');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(body);
  };
}

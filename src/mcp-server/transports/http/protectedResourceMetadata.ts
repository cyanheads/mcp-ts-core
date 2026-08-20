/**
 * @fileoverview RFC 9728 OAuth Protected Resource Metadata endpoint handler.
 * Serves `/.well-known/oauth-protected-resource` to enable MCP clients to
 * discover the authorization server for this resource. Mounted only when an
 * auth mode is configured — `oauth` includes full authorization server
 * metadata, `jwt` returns a minimal resource identifier. In `none` mode the
 * route is not mounted at all, so discovery 404s and the client treats the
 * resource as unauthenticated.
 * @see {@link https://datatracker.ietf.org/doc/html/rfc9728 | RFC 9728: OAuth 2.0 Protected Resource Metadata}
 * @module src/mcp-server/transports/http/protectedResourceMetadata
 */

import type { Context } from 'hono';

import { config } from '@/config/index.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService, withExtra } from '@/utils/internal/requestContext.js';

/**
 * Hono route handler for the RFC 9728 Protected Resource Metadata endpoint.
 *
 * Returns 200 wherever it is mounted. Behavior varies by auth mode:
 * - `oauth`: full metadata including `authorization_servers`, signing algorithms
 * - `jwt`: minimal metadata with just the resource identifier
 *
 * The caller is responsible for not mounting this route in `none` mode; see
 * `httpTransport.ts`.
 *
 * Response is cacheable for 1 hour per RFC 9728 recommendations.
 */
export function protectedResourceMetadataHandler(c: Context): Response {
  const context = requestContextService.createRequestContext({
    operation: 'protectedResourceMetadataHandler',
  });

  const origin = (config.mcpPublicUrl ?? new URL(c.req.url).origin).replace(/\/$/, '');
  const resource = config.mcpServerResourceIdentifier ?? config.oauthAudience ?? `${origin}/mcp`;

  const metadata: Record<string, unknown> = {
    resource,
    bearer_methods_supported: ['header'],
  };

  if (config.mcpAuthMode === 'oauth' && config.oauthIssuerUrl) {
    metadata.authorization_servers = [config.oauthIssuerUrl];
    metadata.resource_signing_alg_values_supported = ['RS256', 'ES256', 'PS256'];
  }

  logger.debug(
    'Serving Protected Resource Metadata.',
    withExtra(context, { resource, authMode: config.mcpAuthMode }),
  );

  c.header('Cache-Control', 'public, max-age=3600');
  return c.json(metadata);
}

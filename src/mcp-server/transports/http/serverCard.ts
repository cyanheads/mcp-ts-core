/**
 * @fileoverview Builds the SEP-1649 MCP Server Card served at
 * `/.well-known/mcp.json`. Machine-readable discovery document so clients
 * can learn a server's capabilities, endpoints, and auth requirements
 * before initiating a full `initialize` handshake.
 *
 * Sibling of the `/mcp` status JSON (bespoke, back-compat) and `/` landing page
 * (human HTML) — all three are pure functions of the same `ServerManifest`.
 *
 * @see https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1649
 * @module src/mcp-server/transports/http/serverCard
 */

import type { Context } from 'hono';

import type { ServerManifest } from '@/core/serverManifest.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService, withExtra } from '@/utils/internal/requestContext.js';

/** Shape of the SEP-1649 Server Card document. */
export interface ServerCard {
  /** JSON Schema identifier — hint to validators. */
  $schema?: string;
  authentication: ServerCardAuth;
  capabilities: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
    logging: boolean;
  };
  /** Human-facing documentation URL (e.g. GitHub README or project homepage). */
  documentation?: string;
  endpoints: {
    /** Streamable HTTP endpoint URL. */
    streamable_http?: string;
  };
  /** SEP-2133 extensions advertised in server capabilities. */
  extensions?: Record<string, object>;
  /** Timestamp this card was built (ISO 8601). */
  generated_at: string;
  mcp_version: string;
  server_description?: string;
  server_name: string;
  server_version: string;
}

export type ServerCardAuth =
  | { required: false; type: 'none' }
  | { required: true; type: 'jwt'; resource_identifier?: string }
  | {
      required: true;
      type: 'oauth';
      authorization_servers?: string[];
      audience?: string;
      resource_identifier?: string;
      jwks_uri?: string;
    };

/**
 * Build the SEP-1649 Server Card from the manifest + request origin.
 * Pure — same inputs produce the same output.
 */
export function buildServerCard(manifest: ServerManifest, origin: string): ServerCard {
  const streamableEndpoint = `${origin.replace(/\/$/, '')}${manifest.transport.endpointPath}`;

  const card: ServerCard = {
    mcp_version: manifest.protocol.latestVersion,
    server_name: manifest.server.name,
    server_version: manifest.server.version,
    ...(manifest.server.description && { server_description: manifest.server.description }),
    endpoints: {
      ...(manifest.transport.type === 'http' && { streamable_http: streamableEndpoint }),
    },
    capabilities: {
      tools: manifest.capabilities.tools,
      resources: manifest.capabilities.resources,
      prompts: manifest.capabilities.prompts,
      logging: manifest.capabilities.logging,
    },
    authentication: buildAuthSection(manifest),
    ...(manifest.extensions && { extensions: manifest.extensions }),
    ...(manifest.server.homepage && { documentation: manifest.server.homepage }),
    generated_at: manifest.builtAt,
  };

  return card;
}

function buildAuthSection(manifest: ServerManifest): ServerCardAuth {
  switch (manifest.auth.mode) {
    case 'oauth':
      return {
        required: true,
        type: 'oauth',
        ...(manifest.auth.oauthIssuer && { authorization_servers: [manifest.auth.oauthIssuer] }),
        ...(manifest.auth.oauthAudience && { audience: manifest.auth.oauthAudience }),
        ...(manifest.auth.resourceIdentifier && {
          resource_identifier: manifest.auth.resourceIdentifier,
        }),
        ...(manifest.auth.jwksUri && { jwks_uri: manifest.auth.jwksUri }),
      };
    case 'jwt':
      return {
        required: true,
        type: 'jwt',
        ...(manifest.auth.resourceIdentifier && {
          resource_identifier: manifest.auth.resourceIdentifier,
        }),
      };
    default:
      return { required: false, type: 'none' };
  }
}

/**
 * Hono route handler for `GET /.well-known/mcp.json`.
 * Sets SEP-1649-recommended headers: `Content-Type`, `X-Content-Type-Options`,
 * `Cache-Control`, CORS.
 */
export function createServerCardHandler(manifest: ServerManifest) {
  return (c: Context): Response => {
    const context = requestContextService.createRequestContext({
      operation: 'serverCardHandler',
    });

    const origin = manifest.transport.publicUrl ?? new URL(c.req.url).origin;
    const card = buildServerCard(manifest, origin);

    logger.debug(
      'Serving SEP-1649 Server Card.',
      withExtra(context, { origin, authMode: manifest.auth.mode }),
    );

    c.header('Content-Type', 'application/json; charset=utf-8');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'public, max-age=3600');
    c.header('Access-Control-Allow-Origin', '*');
    return c.json(card);
  };
}

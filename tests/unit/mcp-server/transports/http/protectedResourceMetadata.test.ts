/**
 * @fileoverview Unit tests for OAuth protected resource metadata responses.
 * @module tests/mcp-server/transports/http/protectedResourceMetadata.test
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const defaultMockConfig = {
  mcpAuthMode: 'oauth',
  mcpServerResourceIdentifier: undefined as string | undefined,
  oauthAudience: undefined as string | undefined,
  oauthIssuerUrl: 'https://issuer.example.com',
  mcpPublicUrl: undefined as string | undefined,
};
const mockConfig = { ...defaultMockConfig };

const debugSpy = vi.fn();
const createRequestContextSpy = vi.fn(() => ({
  operation: 'protectedResourceMetadataHandler',
  requestId: 'req-metadata',
  timestamp: new Date().toISOString(),
}));

vi.mock('@/config/index.js', () => ({
  config: mockConfig,
}));

vi.mock('@/utils/internal/logger.js', () => ({
  logger: {
    debug: debugSpy,
  },
}));

vi.mock('@/utils/internal/requestContext.js', () => ({
  toCanonicalContext: (context: Record<string, unknown>) =>
    Object.fromEntries(
      [
        'auth',
        'extra',
        'operation',
        'requestId',
        'sessionId',
        'spanId',
        'tenantId',
        'timestamp',
        'traceId',
      ]
        .filter((k) => context[k] !== undefined)
        .map((k) => [k, context[k]]),
    ),
  withExtra: (ctx: { extra?: Record<string, unknown> }, fields: Record<string, unknown>) => ({
    ...ctx,
    extra: { ...ctx.extra, ...fields },
  }),
  requestContextService: {
    createRequestContext: createRequestContextSpy,
  },
}));

const { protectedResourceMetadataHandler } = await import(
  '@/mcp-server/transports/http/protectedResourceMetadata.js'
);

/** Reads a metadata response body, which is always a JSON object. */
async function readMetadata(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(`Expected a JSON object metadata body, received: ${JSON.stringify(body)}`);
  }
  return body as Record<string, unknown>;
}

describe('protectedResourceMetadataHandler', () => {
  beforeEach(() => {
    Object.assign(mockConfig, defaultMockConfig);
    debugSpy.mockClear();
    createRequestContextSpy.mockClear();
  });

  it('returns OAuth metadata with authorization server details and cache headers', async () => {
    const app = new Hono();
    app.get('/.well-known/oauth-protected-resource', protectedResourceMetadataHandler);

    const response = await app.request('http://localhost/.well-known/oauth-protected-resource');
    const data = await readMetadata(response);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(data).toEqual({
      authorization_servers: ['https://issuer.example.com'],
      bearer_methods_supported: ['header'],
      resource: 'http://localhost/mcp',
      resource_signing_alg_values_supported: ['RS256', 'ES256', 'PS256'],
    });
    expect(createRequestContextSpy).toHaveBeenCalledWith({
      operation: 'protectedResourceMetadataHandler',
    });
    expect(debugSpy).toHaveBeenCalledWith(
      'Serving Protected Resource Metadata.',
      expect.objectContaining({
        operation: 'protectedResourceMetadataHandler',
        extra: expect.objectContaining({
          authMode: 'oauth',
          resource: 'http://localhost/mcp',
        }),
      }),
    );
  });

  it('prefers explicit resource identifiers and omits OAuth metadata outside oauth mode', async () => {
    mockConfig.mcpAuthMode = 'jwt';
    mockConfig.mcpServerResourceIdentifier = 'urn:cyanheads:mcp-ts-core';
    mockConfig.oauthAudience = 'https://audience.example.com';

    const app = new Hono();
    app.get('/.well-known/oauth-protected-resource', protectedResourceMetadataHandler);

    const response = await app.request('http://localhost/.well-known/oauth-protected-resource');
    const data = await readMetadata(response);

    expect(data).toEqual({
      bearer_methods_supported: ['header'],
      resource: 'urn:cyanheads:mcp-ts-core',
    });
  });

  it('falls back to oauthAudience when resource identifier is absent', async () => {
    mockConfig.mcpAuthMode = 'none';
    mockConfig.mcpServerResourceIdentifier = undefined;
    mockConfig.oauthAudience = 'https://audience.example.com';

    const app = new Hono();
    app.get('/.well-known/oauth-protected-resource', protectedResourceMetadataHandler);

    const response = await app.request('http://localhost/.well-known/oauth-protected-resource');
    const data = await readMetadata(response);

    expect(data).toEqual({
      bearer_methods_supported: ['header'],
      resource: 'https://audience.example.com',
    });
  });

  it('uses MCP_PUBLIC_URL for resource fallback (proxied deployment)', async () => {
    mockConfig.mcpAuthMode = 'none';
    mockConfig.mcpServerResourceIdentifier = undefined;
    mockConfig.oauthAudience = undefined;
    mockConfig.mcpPublicUrl = 'https://mcp.example.com';

    const app = new Hono();
    app.get('/.well-known/oauth-protected-resource', protectedResourceMetadataHandler);

    // Inbound request arrives over http (simulating proxy → container hop)
    const response = await app.request(
      'http://internal.container/.well-known/oauth-protected-resource',
    );
    const data = await readMetadata(response);

    expect(data.resource).toBe('https://mcp.example.com/mcp');
  });

  it('strips trailing slash from MCP_PUBLIC_URL', async () => {
    mockConfig.mcpAuthMode = 'none';
    mockConfig.mcpServerResourceIdentifier = undefined;
    mockConfig.oauthAudience = undefined;
    mockConfig.mcpPublicUrl = 'https://mcp.example.com/';

    const app = new Hono();
    app.get('/.well-known/oauth-protected-resource', protectedResourceMetadataHandler);

    const response = await app.request(
      'http://internal.container/.well-known/oauth-protected-resource',
    );
    const data = await readMetadata(response);

    expect(data.resource).toBe('https://mcp.example.com/mcp');
  });
});

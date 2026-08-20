/**
 * @fileoverview Tests for the SEP-1649 Server Card builder + handler.
 * @module tests/mcp-server/transports/http/serverCard.test
 */

import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';

import type { ServerManifest } from '@/core/serverManifest.js';
import {
  buildServerCard,
  createServerCardHandler,
} from '@/mcp-server/transports/http/serverCard.js';
import { defaultServerManifest } from '../../../../helpers/fixtures.js';

vi.mock('@/utils/internal/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/utils/internal/requestContext.js', () => ({
  withExtra: (ctx: { extra?: Record<string, unknown> }, fields: Record<string, unknown>) => ({
    ...ctx,
    extra: { ...ctx.extra, ...fields },
  }),
  requestContextService: {
    createRequestContext: vi.fn((x) => ({ requestId: 'test', ...x })),
  },
}));

describe('buildServerCard', () => {
  test('produces the required SEP-1649 fields', () => {
    const card = buildServerCard(defaultServerManifest, 'https://example.com');
    expect(card).toMatchObject({
      mcp_version: defaultServerManifest.protocol.latestVersion,
      server_name: 'test-mcp-server',
      server_version: '1.0.0',
      server_description: 'Test MCP Server',
      endpoints: { streamable_http: 'https://example.com/mcp' },
      capabilities: { tools: true, resources: true, prompts: true, logging: true },
      authentication: { required: false, type: 'none' },
      generated_at: defaultServerManifest.builtAt,
    });
  });

  test('builds streamable_http URL from endpoint path + origin', () => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      transport: { ...defaultServerManifest.transport, endpointPath: '/api/mcp' },
    };
    const card = buildServerCard(manifest, 'https://pubmed.example.com');
    expect(card.endpoints.streamable_http).toBe('https://pubmed.example.com/api/mcp');
  });

  test('strips trailing slash from origin', () => {
    const card = buildServerCard(defaultServerManifest, 'https://example.com/');
    expect(card.endpoints.streamable_http).toBe('https://example.com/mcp');
  });

  test('omits streamable_http for stdio transport', () => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      transport: { ...defaultServerManifest.transport, type: 'stdio' },
    };
    const card = buildServerCard(manifest, 'https://example.com');
    expect(card.endpoints.streamable_http).toBeUndefined();
  });

  test('reflects oauth auth mode', () => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      auth: {
        mode: 'oauth',
        oauthIssuer: 'https://auth.example.com',
        oauthAudience: 'mcp-api',
        jwksUri: 'https://auth.example.com/.well-known/jwks.json',
      },
    };
    const card = buildServerCard(manifest, 'https://example.com');
    expect(card.authentication).toEqual({
      required: true,
      type: 'oauth',
      authorization_servers: ['https://auth.example.com'],
      audience: 'mcp-api',
      jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
    });
  });

  test('reflects jwt auth mode', () => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      auth: { mode: 'jwt', resourceIdentifier: 'https://api.example.com' },
    };
    const card = buildServerCard(manifest, 'https://example.com');
    expect(card.authentication).toEqual({
      required: true,
      type: 'jwt',
      resource_identifier: 'https://api.example.com',
    });
  });

  test('forwards extensions when present', () => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      extensions: { 'vendor/ext': { enabled: true } },
    };
    const card = buildServerCard(manifest, 'https://example.com');
    expect(card.extensions).toEqual({ 'vendor/ext': { enabled: true } });
  });

  test('forwards documentation from homepage', () => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      server: { ...defaultServerManifest.server, homepage: 'https://github.com/acme/x' },
    };
    const card = buildServerCard(manifest, 'https://example.com');
    expect(card.documentation).toBe('https://github.com/acme/x');
  });
});

describe('createServerCardHandler', () => {
  test('responds with correct headers + JSON body', async () => {
    const handler = createServerCardHandler(defaultServerManifest);
    const app = new Hono();
    app.get('/.well-known/mcp.json', handler);

    const response = await app.fetch(
      new Request('https://example.com/.well-known/mcp.json', { method: 'GET' }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toContain('public');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.server_name).toBe('test-mcp-server');
    expect(body.mcp_version).toBeDefined();
    expect(body.capabilities).toBeDefined();
  });

  test('uses manifest.transport.publicUrl when set (proxied deployment)', async () => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      transport: {
        ...defaultServerManifest.transport,
        publicUrl: 'https://mcp.example.com',
      },
    };
    const app = new Hono();
    app.get('/.well-known/mcp.json', createServerCardHandler(manifest));

    // Inbound request arrives over http (simulating proxy → container hop)
    const response = await app.fetch(new Request('http://internal.container/.well-known/mcp.json'));
    const body = (await response.json()) as { endpoints: { streamable_http: string } };
    expect(body.endpoints.streamable_http).toBe('https://mcp.example.com/mcp');
  });
});

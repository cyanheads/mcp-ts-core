/**
 * @fileoverview Tests for the /robots.txt route handler.
 * @module tests/mcp-server/transports/http/robotsTxt.test
 */
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';

import { buildRobotsTxt, createRobotsTxtHandler } from '@/mcp-server/transports/http/robotsTxt.js';
import { defaultServerManifest } from '../../../../helpers/fixtures.js';

vi.mock('@/utils/internal/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock('@/utils/internal/requestContext.js', () => ({
  requestContextService: {
    createRequestContext: vi.fn((x) => ({ requestId: 'test', ...x })),
  },
}));

describe('buildRobotsTxt', () => {
  test('allows / and disallows the MCP endpoint path', () => {
    const body = buildRobotsTxt(defaultServerManifest);
    expect(body).toContain('User-agent: *');
    expect(body).toContain('Allow: /');
    expect(body).toContain(`Disallow: ${defaultServerManifest.transport.endpointPath}`);
  });

  test('reflects a custom MCP endpoint path', () => {
    const body = buildRobotsTxt({
      ...defaultServerManifest,
      transport: { ...defaultServerManifest.transport, endpointPath: '/api/mcp' },
    });
    expect(body).toContain('Disallow: /api/mcp');
    expect(body).not.toContain('Disallow: /mcp\n');
  });

  test('terminates with a newline', () => {
    expect(buildRobotsTxt(defaultServerManifest).endsWith('\n')).toBe(true);
  });
});

describe('createRobotsTxtHandler', () => {
  test('serves text/plain with a public cache and nosniff', async () => {
    const app = new Hono();
    app.get('/robots.txt', createRobotsTxtHandler(defaultServerManifest));
    const response = await app.fetch(new Request('https://example.com/robots.txt'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400');

    const body = await response.text();
    expect(body).toContain('User-agent: *');
    expect(body).toContain('Disallow: /mcp');
  });
});

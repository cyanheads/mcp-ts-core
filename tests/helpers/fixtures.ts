/**
 * @fileoverview Shared test fixtures and factory functions.
 * Consolidates common test setup patterns used across the suite.
 * @module tests/fixtures
 */
import type { ServerManifest } from '@/core/serverManifest.js';
import { type RequestContext, requestContextService } from '@/utils/internal/requestContext.js';

/** Default server manifest for tests that need a {@link ServerManifest} value. */
export const defaultServerManifest: ServerManifest = {
  server: {
    name: 'test-mcp-server',
    version: '1.0.0',
    description: 'Test MCP Server',
    keywords: ['test', 'fixture'],
    environment: 'test',
  },
  transport: {
    type: 'http',
    endpointPath: '/mcp',
    sessionMode: 'stateless',
  },
  protocol: {
    supportedVersions: ['2025-06-18', '2025-03-26'],
    latestVersion: '2025-06-18',
  },
  definitionCounts: {
    prompts: 1,
    resources: 1,
    tools: 1,
  },
  capabilities: {
    logging: true,
    tools: true,
    resources: true,
    prompts: true,
  },
  framework: {
    name: '@cyanheads/mcp-ts-core',
    version: '0.0.0-test',
    homepage: 'https://github.com/cyanheads/mcp-ts-core',
  },
  auth: {
    mode: 'none',
  },
  definitions: {
    tools: [],
    resources: [],
    prompts: [],
  },
  landing: {
    enabled: true,
    links: [],
    envExample: [],
    connectSnippets: {},
    theme: { accent: '#6366f1' },
    requireAuth: false,
    attribution: true,
    preRelease: { isPreRelease: false },
  },
  builtAt: new Date(0).toISOString(),
};

/**
 * Create a test RequestContext with sensible defaults.
 * Wraps `requestContextService.createRequestContext` with common test values.
 */
export function createTestAppContext(
  overrides: Partial<RequestContext> & Record<string, unknown> = {},
): RequestContext {
  return requestContextService.createRequestContext({
    operation: 'test-operation',
    tenantId: 'test-tenant',
    ...overrides,
  });
}

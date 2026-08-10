#!/usr/bin/env node
/**
 * @fileoverview MCP Apps wire fixture using only the package's public API.
 * @module tests/fixtures/mcp-app-server
 */

import { appResource, appTool, createApp, z } from '@cyanheads/mcp-ts-core';

const resourceUri = 'ui://wire-app/app.html';

const wireAppTool = appTool('wire_app_search', {
  resourceUri,
  title: 'Wire App Search',
  description: 'Returns deterministic records for MCP Apps wire conformance.',
  input: z.object({ query: z.string().describe('Search query.') }),
  output: z.object({ items: z.array(z.string()).describe('Matched items.') }),
  annotations: { readOnlyHint: true },
  extraMeta: {
    ui: { visibility: ['model', 'app'] },
  },
  handler: ({ query }) => ({ items: [`${query}-one`, `${query}-two`] }),
});

const wireAppResource = appResource(resourceUri, {
  name: 'wire-app-ui',
  title: 'Wire App UI',
  description: 'HTML application resource for the wire app fixture.',
  params: z.object({}).describe('No parameters.'),
  _meta: {
    ui: {
      csp: { resourceDomains: ['https://cdn.example.test'] },
      permissions: { clipboardWrite: {} },
    },
  },
  handler: () => '<!doctype html><html><body>wire-app-sentinel</body></html>',
});

await createApp({
  name: 'mcp-app-wire-fixture',
  version: '0.0.0-test',
  tools: [wireAppTool],
  resources: [wireAppResource],
});

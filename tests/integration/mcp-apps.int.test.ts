/**
 * @fileoverview Integration tests for MCP Apps end-to-end pipeline.
 * Validates the full flow: appTool()/appResource() builders → linter validation →
 * registration passthrough → handler execution → format output.
 * @module tests/integration/mcp-apps.int.test
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { validateDefinitions } from '@/linter/validate.js';
import { APP_RESOURCE_MIME_TYPE, appResource, appTool } from '@/mcp-server/apps/appBuilders.js';
import { createMockContext } from '@/testing/index.js';

// ---------------------------------------------------------------------------
// Fixtures: a paired app tool + resource
// ---------------------------------------------------------------------------

const UI_URI = 'ui://test-app/app.html';

function createAppToolDef() {
  return appTool('test_app_tool', {
    resourceUri: UI_URI,
    title: 'Test App',
    description: 'Integration test app tool.',
    annotations: { readOnlyHint: true },
    input: z.object({
      query: z.string().describe('Search query'),
      limit: z.number().default(10).describe('Max results'),
    }),
    output: z.object({
      items: z.array(z.string()).describe('Result items'),
      total: z.number().describe('Total count'),
    }),
    auth: ['tool:test_app:read'],

    async handler(input, ctx) {
      ctx.log.info('App tool called', { query: input.query });
      const items = Array.from({ length: input.limit }, (_, i) => `${input.query}-${i}`);
      return { items, total: items.length };
    },

    format(result) {
      return [
        { type: 'text', text: JSON.stringify(result) },
        { type: 'text', text: `Found ${result.total} items` },
      ];
    },
  });
}

function createAppResourceDef() {
  return appResource(UI_URI, {
    name: 'test-app-ui',
    title: 'Test App UI',
    description: 'UI resource for test_app_tool.',
    params: z.object({}).describe('No parameters.'),
    auth: ['resource:test-app-ui:read'],
    _meta: {
      ui: {
        csp: { resourceDomains: ['https://cdn.example.com'] },
      },
    },

    handler(_params, ctx) {
      ctx.log.debug('Serving test app UI.');
      return '<html><body>Test App</body></html>';
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP Apps — end-to-end integration', () => {
  describe('builder output structure', () => {
    it('appTool produces correct _meta with ui and compat key', () => {
      const tool = createAppToolDef();
      expect(tool._meta).toMatchObject({
        ui: { resourceUri: UI_URI },
        'ui/resourceUri': UI_URI,
      });
    });

    it('appResource produces correct mimeType and audience', () => {
      const resource = createAppResourceDef();
      expect(resource.mimeType).toBe(APP_RESOURCE_MIME_TYPE);
      expect(resource.annotations?.audience).toEqual(['user']);
    });

    it('tool and resource URIs match', () => {
      const tool = createAppToolDef();
      const resource = createAppResourceDef();
      const toolUi = tool._meta?.ui as { resourceUri: string };
      expect(toolUi.resourceUri).toBe(resource.uriTemplate);
    });
  });

  describe('linter validation', () => {
    it('paired app tool + resource passes validation', () => {
      const report = validateDefinitions({
        tools: [createAppToolDef()],
        resources: [createAppResourceDef()],
      });

      expect(report.passed).toBe(true);
      expect(report.errors).toHaveLength(0);

      // No pairing warnings since tool and resource URI match
      const pairingWarnings = report.warnings.filter((w) => w.rule === 'app-tool-resource-pairing');
      expect(pairingWarnings).toHaveLength(0);

      // No _meta.ui warnings since URI uses ui:// scheme
      const schemeWarnings = report.warnings.filter(
        (w) => w.rule === 'meta-ui-resource-uri-scheme',
      );
      expect(schemeWarnings).toHaveLength(0);
    });

    it('app tool without matching resource triggers pairing warning', () => {
      const report = validateDefinitions({
        tools: [createAppToolDef()],
        resources: [], // no matching resource
      });

      expect(report.passed).toBe(true); // warnings don't fail
      expect(report.warnings).toContainEqual(
        expect.objectContaining({
          rule: 'app-tool-resource-pairing',
          definitionName: 'test_app_tool',
        }),
      );
    });

    it('validates alongside standard tools and resources', () => {
      const standardTool = {
        name: 'plain_tool',
        description: 'A regular tool',
        input: z.object({ x: z.string().describe('X') }),
        output: z.object({ ok: z.boolean().describe('OK') }),
        handler: () => ({ ok: true }),
      };
      const standardResource = {
        uriTemplate: 'data://{id}',
        name: 'data-resource',
        description: 'A regular resource',
        handler: () => ({}),
      };

      const report = validateDefinitions({
        tools: [createAppToolDef(), standardTool],
        resources: [createAppResourceDef(), standardResource],
      });

      expect(report.passed).toBe(true);
      expect(report.errors).toHaveLength(0);
    });
  });

  describe('handler execution', () => {
    it('app tool handler processes input and returns typed output', async () => {
      const tool = createAppToolDef();
      const ctx = createMockContext();
      const input = tool.input.parse({ query: 'test', limit: 3 });
      const result = await tool.handler(input, ctx);

      expect(result.items).toEqual(['test-0', 'test-1', 'test-2']);
      expect(result.total).toBe(3);

      // Output validates against schema
      const parsed = tool.output.parse(result);
      expect(parsed).toEqual(result);
    });

    it('app tool format produces dual blocks (JSON + text)', async () => {
      const tool = createAppToolDef();
      const ctx = createMockContext();
      const input = tool.input.parse({ query: 'search' });
      const result = await tool.handler(input, ctx);
      const blocks = tool.format!(result);

      expect(blocks).toHaveLength(2);

      // First block: JSON for UI consumption
      const json = JSON.parse((blocks[0] as { text: string }).text);
      expect(json.items).toEqual(result.items);
      expect(json.total).toBe(result.total);

      // Second block: human-readable fallback
      expect((blocks[1] as { text: string }).text).toContain('10 items');
    });

    it('app resource handler returns HTML', () => {
      const resource = createAppResourceDef();
      const ctx = createMockContext({
        uri: new URL('ui://test-app/app.html'),
      });
      const params = resource.params!.parse({});
      const result = resource.handler(params, ctx);

      expect(typeof result).toBe('string');
      expect(result).toContain('<html>');
    });

    it('app resource format preserves raw HTML and content-item CSP metadata', () => {
      const resource = createAppResourceDef();
      const html = '<html><body>Test App</body></html>';
      const contents = resource.format!(html, {
        uri: new URL(UI_URI),
        mimeType: APP_RESOURCE_MIME_TYPE,
      });

      expect(contents).toHaveLength(1);
      expect(contents[0]).toMatchObject({
        uri: UI_URI,
        text: html,
        mimeType: APP_RESOURCE_MIME_TYPE,
        _meta: {
          ui: {
            csp: { resourceDomains: ['https://cdn.example.com'] },
          },
        },
      });
    });

    it('static app resources do not require a manual list callback', () => {
      const resource = createAppResourceDef();
      expect(resource.list).toBeUndefined();
    });
  });

  describe('cross-definition consistency', () => {
    it('tool resourceUri matches resource uriTemplate', () => {
      const tool = createAppToolDef();
      const resource = createAppResourceDef();

      const toolUi = tool._meta?.ui as Record<string, unknown>;
      const toolResourceUri = toolUi.resourceUri as string;
      const compatUri = tool._meta?.['ui/resourceUri'] as string;

      expect(toolResourceUri).toBe(resource.uriTemplate);
      expect(compatUri).toBe(resource.uriTemplate);
    });

    it('resource uriTemplate stays stable without a manual list callback', () => {
      const resource = createAppResourceDef();
      expect(resource.uriTemplate).toBe(UI_URI);
    });
  });
});

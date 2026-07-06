/**
 * @fileoverview Tests for the MCP definition linter.
 * @module tests/unit/linter/validate.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { validateDefinitions } from '@/linter/validate.js';

// ---------------------------------------------------------------------------
// Helpers — minimal valid definitions
// ---------------------------------------------------------------------------

function validTool(overrides: Record<string, unknown> = {}) {
  return {
    name: 'test_tool',
    description: 'A test tool',
    input: z.object({ query: z.string().describe('Search query') }),
    output: z.object({ result: z.string().describe('Result') }),
    handler: async () => ({ result: 'ok' }),
    ...overrides,
  };
}

function validResource(overrides: Record<string, unknown> = {}) {
  return {
    uriTemplate: 'test://{id}/data',
    name: 'test_resource',
    description: 'A test resource',
    handler: async () => ({ data: 'ok' }),
    ...overrides,
  };
}

function validPrompt(overrides: Record<string, unknown> = {}) {
  return {
    name: 'test_prompt',
    description: 'A test prompt',
    generate: () => [{ role: 'user' as const, content: { type: 'text' as const, text: 'hi' } }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateDefinitions', () => {
  describe('valid definitions', () => {
    it('passes with valid tool, resource, and prompt', () => {
      const report = validateDefinitions({
        tools: [validTool()],
        resources: [validResource()],
        prompts: [validPrompt()],
      });

      expect(report.passed).toBe(true);
      expect(report.errors).toHaveLength(0);
    });

    it('passes with empty arrays', () => {
      const report = validateDefinitions({ tools: [], resources: [], prompts: [] });
      expect(report.passed).toBe(true);
    });

    it('passes with undefined arrays', () => {
      const report = validateDefinitions({});
      expect(report.passed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tool rules
  // -------------------------------------------------------------------------

  describe('tool rules', () => {
    it('errors on empty tool name', () => {
      const report = validateDefinitions({ tools: [validTool({ name: '' })] });
      expect(report.passed).toBe(false);
      expect(report.errors).toContainEqual(
        expect.objectContaining({ rule: 'name-required', definitionType: 'tool' }),
      );
    });

    it('errors on missing tool name', () => {
      const { name: _, ...noName } = validTool();
      const report = validateDefinitions({ tools: [noName] });
      expect(report.passed).toBe(false);
      expect(report.errors).toContainEqual(expect.objectContaining({ rule: 'name-required' }));
    });

    it('errors on invalid tool name format', () => {
      const report = validateDefinitions({ tools: [validTool({ name: 'my tool!' })] });
      expect(report.passed).toBe(false);
      expect(report.errors).toContainEqual(expect.objectContaining({ rule: 'name-format' }));
    });

    it('accepts valid tool name characters', () => {
      const report = validateDefinitions({
        tools: [validTool({ name: 'my_tool.v2-beta' })],
      });
      const nameErrors = report.errors.filter((e) => e.rule === 'name-format');
      expect(nameErrors).toHaveLength(0);
    });

    it('errors on duplicate tool names', () => {
      const report = validateDefinitions({
        tools: [validTool({ name: 'dup' }), validTool({ name: 'dup' })],
      });
      expect(report.errors).toContainEqual(
        expect.objectContaining({ rule: 'name-unique', definitionType: 'tool' }),
      );
    });

    it('warns on missing description', () => {
      const report = validateDefinitions({ tools: [validTool({ description: '' })] });
      expect(report.warnings).toContainEqual(
        expect.objectContaining({ rule: 'description-required', definitionType: 'tool' }),
      );
    });

    it('errors on missing handler', () => {
      const report = validateDefinitions({ tools: [validTool({ handler: undefined })] });
      expect(report.errors).toContainEqual(
        expect.objectContaining({ rule: 'handler-required', definitionType: 'tool' }),
      );
    });

    it('errors on non-ZodObject input', () => {
      const report = validateDefinitions({ tools: [validTool({ input: z.string() })] });
      expect(report.errors).toContainEqual(
        expect.objectContaining({
          rule: 'schema-is-object',
          message: expect.stringContaining('input'),
        }),
      );
    });

    it('errors on non-ZodObject output', () => {
      const report = validateDefinitions({ tools: [validTool({ output: z.array(z.string()) })] });
      expect(report.errors).toContainEqual(
        expect.objectContaining({
          rule: 'schema-is-object',
          message: expect.stringContaining('output'),
        }),
      );
    });

    it('warns on fields missing .describe()', () => {
      const report = validateDefinitions({
        tools: [
          validTool({
            input: z.object({ noDesc: z.string() }),
            output: z.object({ alsoNoDesc: z.number() }),
          }),
        ],
      });
      const descWarnings = report.warnings.filter((w) => w.rule === 'describe-on-fields');
      expect(descWarnings.length).toBeGreaterThanOrEqual(2);
      expect(descWarnings).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('input.noDesc') }),
      );
    });

    it('does not warn on fields with .describe()', () => {
      const report = validateDefinitions({
        tools: [
          validTool({
            input: z.object({ q: z.string().describe('query') }),
            output: z.object({ r: z.string().describe('result') }),
          }),
        ],
      });
      const descWarnings = report.warnings.filter((w) => w.rule === 'describe-on-fields');
      expect(descWarnings).toHaveLength(0);
    });

    it('does not warn on optional fields with .describe()', () => {
      const report = validateDefinitions({
        tools: [
          validTool({
            input: z.object({ q: z.string().optional().describe('query') }),
          }),
        ],
      });
      const descWarnings = report.warnings.filter((w) => w.rule === 'describe-on-fields');
      expect(descWarnings).toHaveLength(0);
    });

    it('warns on nested object fields missing .describe()', () => {
      const report = validateDefinitions({
        tools: [
          validTool({
            input: z.object({
              filter: z
                .object({
                  status: z.string().describe('Status filter'),
                  priority: z.string(),
                })
                .describe('Filter criteria'),
            }),
          }),
        ],
      });
      const descWarnings = report.warnings.filter((w) => w.rule === 'describe-on-fields');
      expect(descWarnings).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('input.filter.priority') }),
      );
      expect(descWarnings.find((w) => w.message.includes('input.filter.status'))).toBeUndefined();
    });

    it('warns on array element fields missing .describe()', () => {
      const report = validateDefinitions({
        tools: [
          validTool({
            output: z.object({
              items: z
                .array(
                  z.object({
                    id: z.string().describe('Item ID'),
                    name: z.string(),
                  }),
                )
                .describe('Matching items'),
            }),
          }),
        ],
      });
      const descWarnings = report.warnings.filter((w) => w.rule === 'describe-on-fields');
      expect(descWarnings).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('output.items[].name') }),
      );
      expect(descWarnings.find((w) => w.message.includes('output.items[].id'))).toBeUndefined();
    });

    it('does not recurse into primitive array elements', () => {
      const report = validateDefinitions({
        tools: [
          validTool({
            output: z.object({
              tags: z.array(z.string()).describe('Tags'),
            }),
          }),
        ],
      });
      const descWarnings = report.warnings.filter((w) => w.rule === 'describe-on-fields');
      expect(descWarnings).toHaveLength(0);
    });

    it('does not warn on z.literal variants inside a union (form-client sentinel)', () => {
      const report = validateDefinitions({
        tools: [
          validTool({
            input: z.object({
              variable: z
                .union([
                  z.literal(''),
                  z
                    .string()
                    .max(50)
                    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
                    .describe('Identifier matching [a-zA-Z_][a-zA-Z0-9_]*, max 50 chars'),
                ])
                .optional()
                .describe('Variable identifier. Blank values are treated as omitted.'),
            }),
          }),
        ],
      });
      const descWarnings = report.warnings.filter((w) => w.rule === 'describe-on-fields');
      expect(descWarnings.find((w) => w.message.includes('input.variable'))).toBeUndefined();
    });

    it('skips z.literal even when wrapped in optional/nullable', () => {
      const report = validateDefinitions({
        tools: [
          validTool({
            input: z.object({
              flag: z
                .union([z.literal('').optional(), z.string().describe('Non-empty value')])
                .describe('Flag'),
            }),
          }),
        ],
      });
      const descWarnings = report.warnings.filter((w) => w.rule === 'describe-on-fields');
      expect(descWarnings.find((w) => w.message.includes('input.flag|0'))).toBeUndefined();
    });

    it('still warns on non-literal union variants missing .describe()', () => {
      const report = validateDefinitions({
        tools: [
          validTool({
            input: z.object({
              value: z
                .union([z.string(), z.number().describe('Numeric form')])
                .describe('Value in either form'),
            }),
          }),
        ],
      });
      const descWarnings = report.warnings.filter((w) => w.rule === 'describe-on-fields');
      expect(descWarnings).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('input.value|0') }),
      );
      expect(descWarnings.find((w) => w.message.includes('input.value|1'))).toBeUndefined();
    });

    it('warns on discriminatedUnion variant fields missing .describe()', () => {
      const report = validateDefinitions({
        tools: [
          validTool({
            input: z.object({
              action: z
                .discriminatedUnion('kind', [
                  z.object({
                    kind: z.literal('a').describe('Discriminator A'),
                    aValue: z.string(),
                  }),
                  z.object({
                    kind: z.literal('b').describe('Discriminator B'),
                    bValue: z.string().describe('Value B'),
                  }),
                ])
                .describe('Action to perform'),
            }),
          }),
        ],
      });
      const descWarnings = report.warnings.filter((w) => w.rule === 'describe-on-fields');
      expect(descWarnings).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('input.action|0.aValue') }),
      );
      expect(descWarnings.find((w) => w.message.includes('input.action|1.bValue'))).toBeUndefined();
    });

    it('warns on resource output schema fields missing .describe()', () => {
      const report = validateDefinitions({
        resources: [
          validResource({
            output: z.object({
              id: z.string().describe('Resource ID'),
              content: z.string(),
            }),
          }),
        ],
      });
      const descWarnings = report.warnings.filter((w) => w.rule === 'describe-on-fields');
      expect(descWarnings).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('output.content') }),
      );
    });

    it('warns on non-boolean annotation hints', () => {
      const report = validateDefinitions({
        tools: [validTool({ annotations: { readOnlyHint: 'yes' } })],
      });
      expect(report.warnings).toContainEqual(expect.objectContaining({ rule: 'annotation-type' }));
    });

    it('warns on contradictory annotations (readOnly + destructive)', () => {
      const report = validateDefinitions({
        tools: [validTool({ annotations: { readOnlyHint: true, destructiveHint: true } })],
      });
      expect(report.warnings).toContainEqual(
        expect.objectContaining({
          rule: 'annotation-coherence',
          message: expect.stringContaining('destructiveHint'),
        }),
      );
    });

    it('does not warn on idempotentHint with readOnlyHint (explicit is correct)', () => {
      const report = validateDefinitions({
        tools: [validTool({ annotations: { readOnlyHint: true, idempotentHint: true } })],
      });
      const idempotentWarnings = report.warnings.filter(
        (w) => w.rule === 'annotation-coherence' && w.message.includes('idempotentHint'),
      );
      expect(idempotentWarnings).toHaveLength(0);
    });

    it('does not warn on annotations when readOnlyHint is false', () => {
      const report = validateDefinitions({
        tools: [
          validTool({
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
          }),
        ],
      });
      const coherenceWarnings = report.warnings.filter((w) => w.rule === 'annotation-coherence');
      expect(coherenceWarnings).toHaveLength(0);
    });

    it('errors on non-array auth', () => {
      const report = validateDefinitions({ tools: [validTool({ auth: 'scope:read' })] });
      expect(report.errors).toContainEqual(expect.objectContaining({ rule: 'auth-type' }));
    });

    it('errors on empty string in auth scopes', () => {
      const report = validateDefinitions({
        tools: [validTool({ auth: ['tool:read', ''] })],
      });
      expect(report.errors).toContainEqual(expect.objectContaining({ rule: 'auth-scope-format' }));
    });

    it('passes with valid auth scopes', () => {
      const report = validateDefinitions({
        tools: [validTool({ auth: ['tool:my_tool:read', 'admin'] })],
      });
      const authErrors = report.errors.filter(
        (e) => e.rule === 'auth-type' || e.rule === 'auth-scope-format',
      );
      expect(authErrors).toHaveLength(0);
    });

    it('errors on non-serializable input schema (z.custom)', () => {
      const report = validateDefinitions({
        tools: [
          validTool({
            input: z.object({ data: z.custom<unknown>().describe('Opaque data') }),
          }),
        ],
      });
      expect(report.passed).toBe(false);
      expect(report.errors).toContainEqual(
        expect.objectContaining({
          rule: 'schema-serializable',
          message: expect.stringContaining('input'),
        }),
      );
    });

    it('errors on non-serializable output schema (z.custom)', () => {
      const report = validateDefinitions({
        tools: [
          validTool({
            output: z.object({ result: z.custom<unknown>().describe('Opaque result') }),
          }),
        ],
      });
      expect(report.passed).toBe(false);
      expect(report.errors).toContainEqual(
        expect.objectContaining({
          rule: 'schema-serializable',
          message: expect.stringContaining('output'),
        }),
      );
    });

    it('errors on non-serializable schema (z.date)', () => {
      const report = validateDefinitions({
        tools: [
          validTool({
            input: z.object({ when: z.date().describe('Timestamp') }),
          }),
        ],
      });
      expect(report.passed).toBe(false);
      expect(report.errors).toContainEqual(
        expect.objectContaining({ rule: 'schema-serializable' }),
      );
    });

    it('passes with serializable schema types', () => {
      const report = validateDefinitions({
        tools: [
          validTool({
            input: z.object({
              name: z.string().describe('Name'),
              count: z.number().optional().describe('Count'),
              tags: z.array(z.string()).describe('Tags'),
              status: z.enum(['active', 'inactive']).describe('Status'),
            }),
            output: z.object({
              id: z.string().describe('ID'),
              ok: z.boolean().describe('Success'),
            }),
          }),
        ],
      });
      const serialErrors = report.errors.filter((e) => e.rule === 'schema-serializable');
      expect(serialErrors).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // _meta.ui rules (MCP Apps)
  // -------------------------------------------------------------------------

  describe('_meta.ui rules', () => {
    it('passes when _meta is absent', () => {
      const report = validateDefinitions({ tools: [validTool()] });
      const metaErrors = report.errors.filter((e) => e.rule.startsWith('meta-ui'));
      expect(metaErrors).toHaveLength(0);
    });

    it('passes when _meta exists but has no ui key', () => {
      const report = validateDefinitions({
        tools: [validTool({ _meta: { version: '1.0' } })],
      });
      const metaErrors = report.errors.filter((e) => e.rule.startsWith('meta-ui'));
      expect(metaErrors).toHaveLength(0);
    });

    it('errors when _meta.ui is not an object', () => {
      const report = validateDefinitions({
        tools: [validTool({ _meta: { ui: 'bad' } })],
      });
      expect(report.errors).toContainEqual(expect.objectContaining({ rule: 'meta-ui-type' }));
    });

    it('errors when _meta.ui is null', () => {
      const report = validateDefinitions({
        tools: [validTool({ _meta: { ui: null } })],
      });
      expect(report.errors).toContainEqual(expect.objectContaining({ rule: 'meta-ui-type' }));
    });

    it('errors when _meta.ui.resourceUri is missing', () => {
      const report = validateDefinitions({
        tools: [validTool({ _meta: { ui: {} } })],
      });
      expect(report.errors).toContainEqual(
        expect.objectContaining({ rule: 'meta-ui-resource-uri-required' }),
      );
    });

    it('errors when _meta.ui.resourceUri is empty string', () => {
      const report = validateDefinitions({
        tools: [validTool({ _meta: { ui: { resourceUri: '' } } })],
      });
      expect(report.errors).toContainEqual(
        expect.objectContaining({ rule: 'meta-ui-resource-uri-required' }),
      );
    });

    it('errors when _meta.ui.resourceUri is not a string', () => {
      const report = validateDefinitions({
        tools: [validTool({ _meta: { ui: { resourceUri: 42 } } })],
      });
      expect(report.errors).toContainEqual(
        expect.objectContaining({ rule: 'meta-ui-resource-uri-required' }),
      );
    });

    it('warns when resourceUri does not use ui:// scheme', () => {
      const report = validateDefinitions({
        tools: [validTool({ _meta: { ui: { resourceUri: 'https://example.com/app.html' } } })],
      });
      expect(report.warnings).toContainEqual(
        expect.objectContaining({ rule: 'meta-ui-resource-uri-scheme' }),
      );
    });

    it('passes with valid ui:// resourceUri', () => {
      const report = validateDefinitions({
        tools: [validTool({ _meta: { ui: { resourceUri: 'ui://my-app/app.html' } } })],
        resources: [validResource({ uriTemplate: 'ui://my-app/app.html' })],
      });
      const metaErrors = report.errors.filter((e) => e.rule.startsWith('meta-ui'));
      expect(metaErrors).toHaveLength(0);
      const metaWarnings = report.warnings.filter((e) => e.rule.startsWith('meta-ui'));
      expect(metaWarnings).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // App tool ↔ resource pairing
  // -------------------------------------------------------------------------

  describe('app tool ↔ resource pairing', () => {
    it('passes when tool resourceUri matches a registered resource', () => {
      const report = validateDefinitions({
        tools: [
          validTool({
            _meta: { ui: { resourceUri: 'ui://my-app/app.html' } },
          }),
        ],
        resources: [validResource({ uriTemplate: 'ui://my-app/app.html', name: 'my-app-ui' })],
      });
      const pairingWarnings = report.warnings.filter((w) => w.rule === 'app-tool-resource-pairing');
      expect(pairingWarnings).toHaveLength(0);
    });

    it('warns when tool resourceUri has no matching resource', () => {
      const report = validateDefinitions({
        tools: [
          validTool({
            _meta: { ui: { resourceUri: 'ui://my-app/app.html' } },
          }),
        ],
        resources: [validResource({ uriTemplate: 'other://resource', name: 'other' })],
      });
      expect(report.warnings).toContainEqual(
        expect.objectContaining({
          rule: 'app-tool-resource-pairing',
          message: expect.stringContaining('ui://my-app/app.html'),
        }),
      );
    });

    it('warns when tool resourceUri has no resources at all', () => {
      const report = validateDefinitions({
        tools: [
          validTool({
            _meta: { ui: { resourceUri: 'ui://my-app/app.html' } },
          }),
        ],
        resources: [],
      });
      expect(report.warnings).toContainEqual(
        expect.objectContaining({ rule: 'app-tool-resource-pairing' }),
      );
    });

    it('skips tools without _meta.ui', () => {
      const report = validateDefinitions({
        tools: [validTool()],
        resources: [],
      });
      const pairingWarnings = report.warnings.filter((w) => w.rule === 'app-tool-resource-pairing');
      expect(pairingWarnings).toHaveLength(0);
    });

    it('skips tools with _meta but no ui key', () => {
      const report = validateDefinitions({
        tools: [validTool({ _meta: { version: '1.0' } })],
        resources: [],
      });
      const pairingWarnings = report.warnings.filter((w) => w.rule === 'app-tool-resource-pairing');
      expect(pairingWarnings).toHaveLength(0);
    });

    it('skips tools with non-string resourceUri', () => {
      const report = validateDefinitions({
        tools: [validTool({ _meta: { ui: { resourceUri: 42 } } })],
        resources: [],
      });
      const pairingWarnings = report.warnings.filter((w) => w.rule === 'app-tool-resource-pairing');
      expect(pairingWarnings).toHaveLength(0);
    });

    it('handles multiple app tools with mixed match results', () => {
      const report = validateDefinitions({
        tools: [
          validTool({
            name: 'matched_tool',
            _meta: { ui: { resourceUri: 'ui://app-a/app.html' } },
          }),
          validTool({
            name: 'unmatched_tool',
            _meta: { ui: { resourceUri: 'ui://app-b/app.html' } },
          }),
        ],
        resources: [validResource({ uriTemplate: 'ui://app-a/app.html', name: 'app-a-ui' })],
      });

      const pairingWarnings = report.warnings.filter((w) => w.rule === 'app-tool-resource-pairing');
      expect(pairingWarnings).toHaveLength(1);
      expect(pairingWarnings[0]!.definitionName).toBe('unmatched_tool');
    });

    it('uses <unnamed> for tools without a name', () => {
      const toolNoName = validTool({
        _meta: { ui: { resourceUri: 'ui://app/app.html' } },
      });
      // Remove name to test fallback
      delete (toolNoName as Record<string, unknown>).name;

      const report = validateDefinitions({
        tools: [toolNoName],
        resources: [],
      });

      const pairingWarnings = report.warnings.filter((w) => w.rule === 'app-tool-resource-pairing');
      expect(pairingWarnings).toHaveLength(1);
      expect(pairingWarnings[0]!.definitionName).toBe('<unnamed>');
    });
  });

  // -------------------------------------------------------------------------
  // Resource rules
  // -------------------------------------------------------------------------

  describe('resource rules', () => {
    it('errors on missing uriTemplate', () => {
      const { uriTemplate: _, ...noUri } = validResource();
      const report = validateDefinitions({ resources: [noUri] });
      expect(report.errors).toContainEqual(
        expect.objectContaining({ rule: 'uri-template-required' }),
      );
    });

    it('errors on invalid URI template (unbalanced braces)', () => {
      const report = validateDefinitions({
        resources: [validResource({ uriTemplate: 'test://{id/data' })],
      });
      expect(report.errors).toContainEqual(expect.objectContaining({ rule: 'uri-template-valid' }));
    });

    it('errors on empty variable name in URI template', () => {
      const report = validateDefinitions({
        resources: [validResource({ uriTemplate: 'test://{}/data' })],
      });
      expect(report.errors).toContainEqual(expect.objectContaining({ rule: 'uri-template-valid' }));
    });

    it('warns when name defaults to URI template', () => {
      const report = validateDefinitions({
        resources: [validResource({ name: undefined })],
      });
      expect(report.warnings).toContainEqual(
        expect.objectContaining({ rule: 'resource-name-not-uri' }),
      );
    });

    it('errors on duplicate resource names', () => {
      const report = validateDefinitions({
        resources: [
          validResource({ name: 'dup', uriTemplate: 'a://{id}' }),
          validResource({ name: 'dup', uriTemplate: 'b://{id}' }),
        ],
      });
      expect(report.errors).toContainEqual(
        expect.objectContaining({ rule: 'name-unique', definitionType: 'resource' }),
      );
    });

    it('errors on missing handler', () => {
      const report = validateDefinitions({
        resources: [validResource({ handler: undefined })],
      });
      expect(report.errors).toContainEqual(
        expect.objectContaining({ rule: 'handler-required', definitionType: 'resource' }),
      );
    });

    it('errors on non-ZodObject params', () => {
      const report = validateDefinitions({
        resources: [validResource({ params: z.string() })],
      });
      expect(report.errors).toContainEqual(
        expect.objectContaining({
          rule: 'schema-is-object',
          message: expect.stringContaining('params'),
        }),
      );
    });

    it('errors when template variables do not match params schema keys', () => {
      const report = validateDefinitions({
        resources: [
          validResource({
            uriTemplate: 'test://{itemId}/data',
            params: z.object({ item_id: z.string().describe('Item ID') }),
          }),
        ],
      });
      expect(report.passed).toBe(false);
      expect(report.errors).toContainEqual(
        expect.objectContaining({
          rule: 'template-params-align',
          message: expect.stringContaining('itemId'),
        }),
      );
    });

    it('passes when template variables match params schema keys', () => {
      const report = validateDefinitions({
        resources: [
          validResource({
            uriTemplate: 'test://{itemId}/data',
            params: z.object({ itemId: z.string().describe('Item ID') }),
          }),
        ],
      });
      const alignErrors = report.errors.filter((e) => e.rule === 'template-params-align');
      expect(alignErrors).toHaveLength(0);
    });

    it('handles multiple template variables', () => {
      const report = validateDefinitions({
        resources: [
          validResource({
            uriTemplate: 'test://{orgId}/items/{itemId}',
            params: z.object({
              orgId: z.string().describe('Org ID'),
              itemId: z.string().describe('Item ID'),
            }),
          }),
        ],
      });
      const alignErrors = report.errors.filter((e) => e.rule === 'template-params-align');
      expect(alignErrors).toHaveLength(0);
    });

    it('errors on auth with empty scope strings', () => {
      const report = validateDefinitions({
        resources: [validResource({ auth: [''] })],
      });
      expect(report.errors).toContainEqual(expect.objectContaining({ rule: 'auth-scope-format' }));
    });
  });

  // -------------------------------------------------------------------------
  // Prompt rules
  // -------------------------------------------------------------------------

  describe('prompt rules', () => {
    it('errors on empty prompt name', () => {
      const report = validateDefinitions({ prompts: [validPrompt({ name: '' })] });
      expect(report.errors).toContainEqual(
        expect.objectContaining({ rule: 'name-required', definitionType: 'prompt' }),
      );
    });

    it('errors on duplicate prompt names', () => {
      const report = validateDefinitions({
        prompts: [validPrompt({ name: 'dup' }), validPrompt({ name: 'dup' })],
      });
      expect(report.errors).toContainEqual(
        expect.objectContaining({ rule: 'name-unique', definitionType: 'prompt' }),
      );
    });

    it('errors on missing generate function', () => {
      const report = validateDefinitions({
        prompts: [validPrompt({ generate: undefined })],
      });
      expect(report.errors).toContainEqual(expect.objectContaining({ rule: 'generate-required' }));
    });

    it('warns on missing description', () => {
      const report = validateDefinitions({
        prompts: [validPrompt({ description: '' })],
      });
      expect(report.warnings).toContainEqual(
        expect.objectContaining({ rule: 'description-required', definitionType: 'prompt' }),
      );
    });

    it('errors on non-ZodObject args', () => {
      const report = validateDefinitions({
        prompts: [validPrompt({ args: z.string() })],
      });
      expect(report.errors).toContainEqual(
        expect.objectContaining({
          rule: 'schema-is-object',
          message: expect.stringContaining('args'),
        }),
      );
    });

    it('warns on args fields missing .describe()', () => {
      const report = validateDefinitions({
        prompts: [
          validPrompt({
            args: z.object({ code: z.string() }),
          }),
        ],
      });
      expect(report.warnings).toContainEqual(
        expect.objectContaining({
          rule: 'describe-on-fields',
          message: expect.stringContaining('args.code'),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Report structure
  // -------------------------------------------------------------------------

  describe('report structure', () => {
    it('separates errors and warnings correctly', () => {
      const report = validateDefinitions({
        tools: [
          validTool({
            name: '',
            description: '',
            input: z.object({ x: z.string() }),
          }),
        ],
      });

      // name-required is an error, description-required is a warning
      expect(report.errors.every((d) => d.severity === 'error')).toBe(true);
      expect(report.warnings.every((d) => d.severity === 'warning')).toBe(true);
      expect(report.passed).toBe(false);
    });

    it('passes when only warnings exist', () => {
      const report = validateDefinitions({
        tools: [
          validTool({
            input: z.object({ noDesc: z.string() }),
          }),
        ],
      });

      expect(report.warnings.length).toBeGreaterThan(0);
      expect(report.errors).toHaveLength(0);
      expect(report.passed).toBe(true);
    });

    it('appends a rule-anchor breadcrumb to every diagnostic message', () => {
      const report = validateDefinitions({ tools: [validTool({ name: '' })] });
      const nameError = report.errors.find((e) => e.rule === 'name-required');
      expect(nameError?.message).toContain('See: skills/api-linter/SKILL.md#name-required');
    });
  });

  // -------------------------------------------------------------------------
  // server.json integration
  // -------------------------------------------------------------------------

  describe('server.json integration', () => {
    function validServerJson(overrides: Record<string, unknown> = {}) {
      return {
        name: 'io.github.cyanheads/test-server',
        description: 'A test server manifest.',
        version: '1.0.0',
        repository: {
          url: 'https://github.com/cyanheads/test-server',
          source: 'github',
        },
        packages: [
          {
            registryType: 'npm',
            identifier: 'test-server',
            version: '1.0.0',
            transport: { type: 'stdio' },
          },
        ],
        ...overrides,
      };
    }

    it('produces no errors for a valid server.json manifest', () => {
      const report = validateDefinitions({ serverJson: validServerJson() });
      expect(report.errors).toHaveLength(0);
    });

    it('does not run server.json rules when serverJson is omitted', () => {
      const report = validateDefinitions({ tools: [validTool()] });
      expect(report.errors.some((e) => e.rule.startsWith('server-json-'))).toBe(false);
      expect(report.warnings.some((w) => w.rule.startsWith('server-json-'))).toBe(false);
    });

    it('surfaces server.json errors anchored to the shared server-json-rules section', () => {
      const report = validateDefinitions({ serverJson: validServerJson({ name: '' }) });
      const nameError = report.errors.find((e) => e.rule === 'server-json-name-required');
      expect(nameError).toBeDefined();
      expect(nameError?.message).toContain('See: skills/api-linter/SKILL.md#server-json-rules');
    });

    it('warns on a version mismatch against packageJson.version', () => {
      const report = validateDefinitions({
        serverJson: validServerJson({ version: '1.0.0' }),
        packageJson: { version: '2.0.0' },
      });
      expect(report.warnings).toContainEqual(
        expect.objectContaining({ rule: 'server-json-version-sync' }),
      );
    });

    it('skips the version-sync cross-check when packageJson is not provided', () => {
      const report = validateDefinitions({ serverJson: validServerJson({ version: '1.0.0' }) });
      expect(report.warnings.filter((w) => w.rule === 'server-json-version-sync')).toHaveLength(0);
    });

    it('does not warn on version-sync when versions match', () => {
      const report = validateDefinitions({
        serverJson: validServerJson({ version: '3.2.1' }),
        packageJson: { version: '3.2.1' },
      });
      expect(report.warnings.filter((w) => w.rule === 'server-json-version-sync')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Landing config integration
  // -------------------------------------------------------------------------

  describe('landing config integration', () => {
    it('produces no diagnostics for a valid landing config', () => {
      const report = validateDefinitions({ landing: { tagline: 'Short and punchy' } });
      expect(report.errors.filter((e) => e.rule.startsWith('landing-'))).toHaveLength(0);
    });

    it('does not run landing rules when landing is omitted', () => {
      const report = validateDefinitions({ tools: [validTool()] });
      expect(report.errors.some((e) => e.rule.startsWith('landing-'))).toBe(false);
    });

    it('surfaces landing errors anchored to their own rule id (not the server-json section)', () => {
      const report = validateDefinitions({ landing: { tagline: 'x'.repeat(121) } });
      const taglineError = report.errors.find((e) => e.rule === 'landing-tagline-length');
      expect(taglineError).toBeDefined();
      expect(taglineError?.message).toContain(
        'See: skills/api-linter/SKILL.md#landing-tagline-length',
      );
    });
  });

  // -------------------------------------------------------------------------
  // canvas-consumer-missing option/env resolution
  // -------------------------------------------------------------------------

  describe('canvas-consumer-missing dispatch', () => {
    const ENV = 'MCP_LINT_CANVAS_CONSUMERS';

    function canvasTool(overrides: Record<string, unknown> = {}) {
      return validTool({
        name: 'produces_canvas',
        output: z.object({
          canvas_id: z.string().describe('Canvas token'),
          preview: z.array(z.string()).describe('Preview rows'),
        }),
        handler: async () => ({ canvas_id: 'tok', preview: [] }),
        ...overrides,
      });
    }

    beforeEach(() => {
      delete process.env[ENV];
    });
    afterEach(() => {
      delete process.env[ENV];
    });

    it('warns when a canvas-output tool has no consumer and no options are set', () => {
      const report = validateDefinitions({ tools: [canvasTool()] });
      expect(report.warnings).toContainEqual(
        expect.objectContaining({ rule: 'canvas-consumer-missing' }),
      );
    });

    it('passes when a *_dataframe_query consumer is registered (default predicate)', () => {
      const report = validateDefinitions({
        tools: [canvasTool(), validTool({ name: 'my_dataframe_query' })],
      });
      expect(report.warnings.filter((w) => w.rule === 'canvas-consumer-missing')).toHaveLength(0);
    });

    it('accepts an explicit canvasConsumers array naming a non-standard consumer', () => {
      const report = validateDefinitions({
        canvasConsumers: ['my_custom_sql'],
        tools: [canvasTool(), validTool({ name: 'my_custom_sql' })],
      });
      expect(report.warnings.filter((w) => w.rule === 'canvas-consumer-missing')).toHaveLength(0);
    });

    it('disables the rule entirely when canvasConsumers is false', () => {
      const report = validateDefinitions({ canvasConsumers: false, tools: [canvasTool()] });
      expect(report.warnings.filter((w) => w.rule === 'canvas-consumer-missing')).toHaveLength(0);
    });

    it('reads MCP_LINT_CANVAS_CONSUMERS as a CSV of consumer names', () => {
      process.env[ENV] = 'tool_a, my_custom_sql ,tool_b';
      const report = validateDefinitions({
        tools: [canvasTool(), validTool({ name: 'my_custom_sql' })],
      });
      expect(report.warnings.filter((w) => w.rule === 'canvas-consumer-missing')).toHaveLength(0);
    });

    it('treats MCP_LINT_CANVAS_CONSUMERS=false as disabling the rule via env', () => {
      process.env[ENV] = 'false';
      const report = validateDefinitions({ tools: [canvasTool()] });
      expect(report.warnings.filter((w) => w.rule === 'canvas-consumer-missing')).toHaveLength(0);
    });

    it('explicit canvasConsumers input takes precedence over the env var', () => {
      process.env[ENV] = 'some_other_tool';
      const report = validateDefinitions({ canvasConsumers: false, tools: [canvasTool()] });
      expect(report.warnings.filter((w) => w.rule === 'canvas-consumer-missing')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // capped-list-no-truncation option/env resolution
  // -------------------------------------------------------------------------

  describe('capped-list-no-truncation dispatch', () => {
    const ENV = 'MCP_LINT_TRUNCATION_ALLOWLIST';

    function cappedTool(overrides: Record<string, unknown> = {}) {
      return validTool({
        name: 'search_results',
        input: z.object({ limit: z.number().describe('Max results') }),
        output: z.object({ items: z.array(z.string()).describe('Items') }),
        handler: async () => ({ items: [] }),
        ...overrides,
      });
    }

    beforeEach(() => {
      delete process.env[ENV];
    });
    afterEach(() => {
      delete process.env[ENV];
    });

    it('warns on the silent-cap shape with no options set', () => {
      const report = validateDefinitions({ tools: [cappedTool()] });
      expect(report.warnings).toContainEqual(
        expect.objectContaining({ rule: 'capped-list-no-truncation' }),
      );
    });

    it('truncationAllowlist array suppresses by tool name', () => {
      const report = validateDefinitions({
        truncationAllowlist: ['search_results'],
        tools: [cappedTool()],
      });
      expect(report.warnings.filter((w) => w.rule === 'capped-list-no-truncation')).toHaveLength(0);
    });

    it('disables the rule entirely when truncationAllowlist is false', () => {
      const report = validateDefinitions({ truncationAllowlist: false, tools: [cappedTool()] });
      expect(report.warnings.filter((w) => w.rule === 'capped-list-no-truncation')).toHaveLength(0);
    });

    it('reads MCP_LINT_TRUNCATION_ALLOWLIST as a CSV allowlist', () => {
      process.env[ENV] = 'other_tool, search_results ,third_tool';
      const report = validateDefinitions({ tools: [cappedTool()] });
      expect(report.warnings.filter((w) => w.rule === 'capped-list-no-truncation')).toHaveLength(0);
    });

    it('treats MCP_LINT_TRUNCATION_ALLOWLIST=false as disabling the rule via env', () => {
      process.env[ENV] = 'false';
      const report = validateDefinitions({ tools: [cappedTool()] });
      expect(report.warnings.filter((w) => w.rule === 'capped-list-no-truncation')).toHaveLength(0);
    });

    it('explicit truncationAllowlist input takes precedence over the env var', () => {
      process.env[ENV] = 'unrelated_tool';
      const report = validateDefinitions({
        truncationAllowlist: ['search_results'],
        tools: [cappedTool()],
      });
      expect(report.warnings.filter((w) => w.rule === 'capped-list-no-truncation')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // formatAllowlist resolution
  // -------------------------------------------------------------------------

  describe('formatAllowlist resolution', () => {
    it('accepts a Set instance directly, not just an array', () => {
      const report = validateDefinitions({
        formatAllowlist: new Set(['uri', 'email']),
        tools: [validTool({ input: z.object({ link: z.url().describe('a link') }) })],
      });
      expect(report.errors.filter((e) => e.rule === 'schema-format-portability')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-definition name dedup edge cases
  // -------------------------------------------------------------------------

  describe('cross-definition name dedup edge cases', () => {
    it('does not flag name-unique when duplicate empty tool names are filtered before dedup', () => {
      const { name: _n1, ...noName1 } = validTool();
      const { name: _n2, ...noName2 } = validTool();
      const report = validateDefinitions({ tools: [noName1, noName2] });
      expect(report.errors.filter((e) => e.rule === 'name-required')).toHaveLength(2);
      expect(report.errors.filter((e) => e.rule === 'name-unique')).toHaveLength(0);
    });

    it('flags name-unique exactly once even with three duplicate tool names', () => {
      const report = validateDefinitions({
        tools: [validTool({ name: 'dup' }), validTool({ name: 'dup' }), validTool({ name: 'dup' })],
      });
      expect(report.errors.filter((e) => e.rule === 'name-unique')).toHaveLength(1);
    });

    it('tracks multiple independent duplicate groups without cross-contamination', () => {
      const report = validateDefinitions({
        tools: [
          validTool({ name: 'a' }),
          validTool({ name: 'a' }),
          validTool({ name: 'b' }),
          validTool({ name: 'b' }),
          validTool({ name: 'c' }),
        ],
      });
      const dupNames = report.errors
        .filter((e) => e.rule === 'name-unique')
        .map((e) => e.definitionName)
        .sort();
      expect(dupNames).toEqual(['a', 'b']);
    });

    it('falls back to uriTemplate for resource dedup when name is omitted on both', () => {
      const report = validateDefinitions({
        resources: [
          validResource({ name: undefined, uriTemplate: 'shared://{id}' }),
          validResource({ name: undefined, uriTemplate: 'shared://{id}' }),
        ],
      });
      expect(report.errors).toContainEqual(
        expect.objectContaining({
          rule: 'name-unique',
          definitionType: 'resource',
          definitionName: 'shared://{id}',
        }),
      );
    });

    it('does not flag resource dedup when both name and uriTemplate are absent', () => {
      const { uriTemplate: _u1, name: _n1, ...bare1 } = validResource();
      const { uriTemplate: _u2, name: _n2, ...bare2 } = validResource();
      const report = validateDefinitions({ resources: [bare1, bare2] });
      expect(report.errors.filter((e) => e.rule === 'uri-template-required')).toHaveLength(2);
      expect(report.errors.filter((e) => e.rule === 'name-unique')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Malformed definition entries (edge inputs)
  // -------------------------------------------------------------------------

  describe('malformed definition entries (edge inputs)', () => {
    it('handles an empty-object tool definition without throwing', () => {
      expect(() => validateDefinitions({ tools: [{}] })).not.toThrow();
      const report = validateDefinitions({ tools: [{}] });
      expect(report.errors).toContainEqual(expect.objectContaining({ rule: 'name-required' }));
      expect(report.errors).toContainEqual(expect.objectContaining({ rule: 'handler-required' }));
      expect(report.errors.filter((e) => e.rule === 'schema-is-object')).toHaveLength(2);
    });

    it('handles an empty-object resource definition without throwing', () => {
      expect(() => validateDefinitions({ resources: [{}] })).not.toThrow();
      const report = validateDefinitions({ resources: [{}] });
      expect(report.errors).toContainEqual(
        expect.objectContaining({ rule: 'uri-template-required' }),
      );
      expect(report.errors).toContainEqual(expect.objectContaining({ rule: 'handler-required' }));
    });

    it('handles an empty-object prompt definition without throwing', () => {
      expect(() => validateDefinitions({ prompts: [{}] })).not.toThrow();
      const report = validateDefinitions({ prompts: [{}] });
      expect(report.errors).toContainEqual(expect.objectContaining({ rule: 'name-required' }));
      expect(report.errors).toContainEqual(expect.objectContaining({ rule: 'generate-required' }));
    });

    it('surfaces a null tool entry as a diagnostic instead of throwing', () => {
      expect(() => validateDefinitions({ tools: [null] })).not.toThrow();
      const report = validateDefinitions({ tools: [null] });
      expect(report.passed).toBe(false);
      expect(report.errors).toContainEqual(
        expect.objectContaining({ rule: 'definition-invalid', definitionType: 'tool' }),
      );
    });

    it('surfaces a null resource entry as a diagnostic instead of throwing', () => {
      expect(() => validateDefinitions({ resources: [null] })).not.toThrow();
      const report = validateDefinitions({ resources: [null] });
      expect(report.errors).toContainEqual(
        expect.objectContaining({ rule: 'definition-invalid', definitionType: 'resource' }),
      );
    });

    it('surfaces a null prompt entry as a diagnostic instead of throwing', () => {
      expect(() => validateDefinitions({ prompts: [null] })).not.toThrow();
      const report = validateDefinitions({ prompts: [null] });
      expect(report.errors).toContainEqual(
        expect.objectContaining({ rule: 'definition-invalid', definitionType: 'prompt' }),
      );
    });

    it('surfaces an undefined entry as a diagnostic for every definition kind', () => {
      expect(() => validateDefinitions({ tools: [undefined] })).not.toThrow();
      expect(validateDefinitions({ tools: [undefined] }).errors).toContainEqual(
        expect.objectContaining({ rule: 'definition-invalid', definitionType: 'tool' }),
      );
      expect(() => validateDefinitions({ resources: [undefined] })).not.toThrow();
      expect(validateDefinitions({ resources: [undefined] }).errors).toContainEqual(
        expect.objectContaining({ rule: 'definition-invalid', definitionType: 'resource' }),
      );
      expect(() => validateDefinitions({ prompts: [undefined] })).not.toThrow();
      expect(validateDefinitions({ prompts: [undefined] }).errors).toContainEqual(
        expect.objectContaining({ rule: 'definition-invalid', definitionType: 'prompt' }),
      );
    });

    it('skips a null entry and still lints valid tools after it (masked truncation site)', () => {
      const cappedAfterNull = validTool({
        name: 'search_results',
        input: z.object({ limit: z.number().describe('Max results') }),
        output: z.object({ items: z.array(z.string()).describe('Items') }),
        handler: async () => ({ items: [] }),
      });
      expect(() => validateDefinitions({ tools: [null, cappedAfterNull] })).not.toThrow();
      const report = validateDefinitions({ tools: [null, cappedAfterNull] });
      // Null entry surfaced...
      expect(report.errors).toContainEqual(
        expect.objectContaining({ rule: 'definition-invalid', definitionType: 'tool' }),
      );
      // ...and the per-tool loop (including lintCappedListTruncation) still ran on the valid tool.
      expect(report.warnings).toContainEqual(
        expect.objectContaining({
          rule: 'capped-list-no-truncation',
          definitionName: 'search_results',
        }),
      );
    });
  });
});

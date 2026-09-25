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

    it('errors on invalid tool name format', () => {
      const report = validateDefinitions({ tools: [validTool({ name: 'my tool!' })] });
      expect(report.passed).toBe(false);
      expect(report.errors).toContainEqual(expect.objectContaining({ rule: 'name-format' }));
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
  });

  // -------------------------------------------------------------------------
  // App tool ↔ resource pairing
  // -------------------------------------------------------------------------

  describe('app tool ↔ resource pairing', () => {
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
  });

  // -------------------------------------------------------------------------
  // Resource rules
  // -------------------------------------------------------------------------

  describe('resource rules', () => {
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
  });

  // -------------------------------------------------------------------------
  // Prompt rules
  // -------------------------------------------------------------------------

  describe('prompt rules', () => {
    it('errors on duplicate prompt names', () => {
      const report = validateDefinitions({
        prompts: [validPrompt({ name: 'dup' }), validPrompt({ name: 'dup' })],
      });
      expect(report.errors).toContainEqual(
        expect.objectContaining({ rule: 'name-unique', definitionType: 'prompt' }),
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

      expect(report.errors).toContainEqual(
        expect.objectContaining({ rule: 'name-required', severity: 'error' }),
      );
      expect(report.warnings).toContainEqual(
        expect.objectContaining({ rule: 'description-required', severity: 'warning' }),
      );
      expect(report.warnings).toContainEqual(
        expect.objectContaining({ rule: 'describe-on-fields', severity: 'warning' }),
      );
      expect(report.errors.map((d) => d.rule)).not.toContain('description-required');
      expect(report.warnings.map((d) => d.rule)).not.toContain('name-required');
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
      expect(nameError?.message).toContain(
        'See: framework-skills/api-linter/SKILL.md#name-required',
      );
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

    it('surfaces server.json errors anchored to the shared server-json-rules section', () => {
      const report = validateDefinitions({ serverJson: validServerJson({ name: '' }) });
      const nameError = report.errors.find((e) => e.rule === 'server-json-name-required');
      expect(nameError).toBeDefined();
      expect(nameError?.message).toContain(
        'See: framework-skills/api-linter/SKILL.md#server-json-rules',
      );
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
    it('surfaces landing errors anchored to their own rule id (not the server-json section)', () => {
      const report = validateDefinitions({ landing: { tagline: 'x'.repeat(121) } });
      const taglineError = report.errors.find((e) => e.rule === 'landing-tagline-length');
      expect(taglineError).toBeDefined();
      expect(taglineError?.message).toContain(
        'See: framework-skills/api-linter/SKILL.md#landing-tagline-length',
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

  // -------------------------------------------------------------------------
  // False-negative removals, exercised end to end through validateDefinitions
  // -------------------------------------------------------------------------

  describe('silent-coverage gaps', () => {
    it('errors on an input field that no value can satisfy', () => {
      const def = validTool({
        name: 'unsatisfiable_tool',
        input: z.object({
          priority: z.enum([1, 2, 3, 4, 5] as unknown as [string, ...string[]]).describe('P'),
        }),
      });

      expect(validateDefinitions({ tools: [def] }).errors).toContainEqual(
        expect.objectContaining({
          rule: 'schema-unsatisfiable',
          definitionName: 'unsatisfiable_tool',
        }),
      );
    });
  });
});

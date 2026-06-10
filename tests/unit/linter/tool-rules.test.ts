/**
 * @fileoverview Tests for tool-specific lint rules, focused on _meta.ui
 * validation and the app tool ↔ resource pairing cross-check.
 * @module tests/unit/linter/tool-rules.test
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  lintAppToolResourcePairing,
  lintAuthScopes,
  lintCanvasConsumerPairing,
  lintToolDefinition,
} from '@/linter/rules/tool-rules.js';

// ---------------------------------------------------------------------------
// Helpers
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

// ---------------------------------------------------------------------------
// lintToolDefinition — _meta.ui validation
// ---------------------------------------------------------------------------

describe('lintToolDefinition — _meta.ui', () => {
  it('produces no diagnostics when _meta is absent', () => {
    const diagnostics = lintToolDefinition(validTool());
    const metaDiags = diagnostics.filter((d) => d.rule.startsWith('meta-ui'));
    expect(metaDiags).toHaveLength(0);
  });

  it('produces no diagnostics when _meta has no ui key', () => {
    const diagnostics = lintToolDefinition(validTool({ _meta: { custom: true } }));
    const metaDiags = diagnostics.filter((d) => d.rule.startsWith('meta-ui'));
    expect(metaDiags).toHaveLength(0);
  });

  it('errors when _meta.ui is a string', () => {
    const diagnostics = lintToolDefinition(validTool({ _meta: { ui: 'string-value' } }));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        rule: 'meta-ui-type',
        severity: 'error',
      }),
    );
  });

  it('errors when _meta.ui is a number', () => {
    const diagnostics = lintToolDefinition(validTool({ _meta: { ui: 42 } }));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: 'meta-ui-type', severity: 'error' }),
    );
  });

  it('errors when _meta.ui is null', () => {
    const diagnostics = lintToolDefinition(validTool({ _meta: { ui: null } }));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: 'meta-ui-type', severity: 'error' }),
    );
  });

  it('errors when _meta.ui is an array', () => {
    const diagnostics = lintToolDefinition(validTool({ _meta: { ui: ['bad'] } }));
    // Arrays are objects, so this should hit resourceUri-required instead
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: 'meta-ui-resource-uri-required', severity: 'error' }),
    );
  });

  it('errors when _meta.ui is present but resourceUri is missing', () => {
    const diagnostics = lintToolDefinition(validTool({ _meta: { ui: { other: true } } }));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        rule: 'meta-ui-resource-uri-required',
        severity: 'error',
        message: expect.stringContaining('missing a valid resourceUri'),
      }),
    );
  });

  it('errors when _meta.ui.resourceUri is empty string', () => {
    const diagnostics = lintToolDefinition(validTool({ _meta: { ui: { resourceUri: '' } } }));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: 'meta-ui-resource-uri-required' }),
    );
  });

  it('errors when _meta.ui.resourceUri is not a string', () => {
    const diagnostics = lintToolDefinition(validTool({ _meta: { ui: { resourceUri: 123 } } }));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: 'meta-ui-resource-uri-required' }),
    );
  });

  it('warns when resourceUri does not use ui:// scheme', () => {
    const diagnostics = lintToolDefinition(
      validTool({ _meta: { ui: { resourceUri: 'https://example.com/ui.html' } } }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        rule: 'meta-ui-resource-uri-scheme',
        severity: 'warning',
        message: expect.stringContaining('does not use the ui:// scheme'),
      }),
    );
  });

  it('warns when resourceUri uses http:// scheme', () => {
    const diagnostics = lintToolDefinition(
      validTool({ _meta: { ui: { resourceUri: 'http://localhost:3000/app.html' } } }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: 'meta-ui-resource-uri-scheme', severity: 'warning' }),
    );
  });

  it('passes with valid ui:// resourceUri', () => {
    const diagnostics = lintToolDefinition(
      validTool({ _meta: { ui: { resourceUri: 'ui://my-app/app.html' } } }),
    );
    const metaDiags = diagnostics.filter((d) => d.rule.startsWith('meta-ui'));
    expect(metaDiags).toHaveLength(0);
  });

  it('includes tool name in diagnostic messages', () => {
    const diagnostics = lintToolDefinition(validTool({ name: 'my_app_tool', _meta: { ui: {} } }));
    const metaDiag = diagnostics.find((d) => d.rule === 'meta-ui-resource-uri-required');
    expect(metaDiag?.message).toContain('my_app_tool');
    expect(metaDiag?.definitionName).toBe('my_app_tool');
  });

  it('uses <unnamed> for tools without a name', () => {
    const toolDef = validTool({ _meta: { ui: {} } });
    delete (toolDef as Record<string, unknown>).name;
    const diagnostics = lintToolDefinition(toolDef);
    const metaDiag = diagnostics.find((d) => d.rule === 'meta-ui-resource-uri-required');
    expect(metaDiag?.message).toContain('<unnamed>');
  });

  it('does not produce scheme warning when resourceUri is invalid type (error takes precedence)', () => {
    const diagnostics = lintToolDefinition(validTool({ _meta: { ui: { resourceUri: 42 } } }));
    // Should only get the required error, not the scheme warning
    const schemeWarnings = diagnostics.filter((d) => d.rule === 'meta-ui-resource-uri-scheme');
    expect(schemeWarnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// lintAppToolResourcePairing
// ---------------------------------------------------------------------------

describe('lintAppToolResourcePairing', () => {
  it('returns no diagnostics for empty arrays', () => {
    expect(lintAppToolResourcePairing([], [])).toHaveLength(0);
  });

  it('returns no diagnostics for tools without _meta.ui', () => {
    const diagnostics = lintAppToolResourcePairing(
      [validTool(), validTool({ name: 'another_tool' })],
      [],
    );
    expect(diagnostics).toHaveLength(0);
  });

  it('returns no diagnostics when all resourceUris match', () => {
    const tools = [
      validTool({
        name: 'app_a',
        _meta: { ui: { resourceUri: 'ui://app-a/app.html' } },
      }),
      validTool({
        name: 'app_b',
        _meta: { ui: { resourceUri: 'ui://app-b/app.html' } },
      }),
    ];
    const resources = [
      { uriTemplate: 'ui://app-a/app.html', name: 'app-a-ui' },
      { uriTemplate: 'ui://app-b/app.html', name: 'app-b-ui' },
    ];

    expect(lintAppToolResourcePairing(tools, resources)).toHaveLength(0);
  });

  it('warns for each unmatched resourceUri', () => {
    const tools = [
      validTool({
        name: 'app_a',
        _meta: { ui: { resourceUri: 'ui://app-a/app.html' } },
      }),
      validTool({
        name: 'app_b',
        _meta: { ui: { resourceUri: 'ui://app-b/app.html' } },
      }),
    ];
    const resources = [{ uriTemplate: 'ui://app-a/app.html', name: 'app-a-ui' }];

    const diagnostics = lintAppToolResourcePairing(tools, resources);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      rule: 'app-tool-resource-pairing',
      severity: 'warning',
      definitionName: 'app_b',
    });
  });

  it('warning message includes the resourceUri', () => {
    const diagnostics = lintAppToolResourcePairing(
      [validTool({ name: 'app_x', _meta: { ui: { resourceUri: 'ui://app-x/ui.html' } } })],
      [],
    );
    expect(diagnostics[0]!.message).toContain('ui://app-x/ui.html');
  });

  it('ignores tools with _meta but no ui', () => {
    const diagnostics = lintAppToolResourcePairing([validTool({ _meta: { custom: true } })], []);
    expect(diagnostics).toHaveLength(0);
  });

  it('ignores tools with _meta.ui but non-string resourceUri', () => {
    const diagnostics = lintAppToolResourcePairing(
      [validTool({ _meta: { ui: { resourceUri: 42 } } })],
      [],
    );
    expect(diagnostics).toHaveLength(0);
  });

  it('ignores resources without uriTemplate', () => {
    const diagnostics = lintAppToolResourcePairing(
      [validTool({ name: 'app', _meta: { ui: { resourceUri: 'ui://app/app.html' } } })],
      [{ name: 'no-uri' }],
    );
    expect(diagnostics).toHaveLength(1);
  });

  it('falls back to <unnamed> for tools without a name', () => {
    const t = validTool({ _meta: { ui: { resourceUri: 'ui://x/app.html' } } });
    delete (t as Record<string, unknown>).name;

    const diagnostics = lintAppToolResourcePairing([t], []);
    expect(diagnostics[0]!.definitionName).toBe('<unnamed>');
  });

  it('matches {+path} operator (reserved expansion with slashes)', () => {
    const tools = [
      validTool({
        name: 'app_dynamic',
        _meta: { ui: { resourceUri: 'ui://app/a/b/c' } },
      }),
    ];
    const resources = [{ uriTemplate: 'ui://app/{+path}', name: 'app-ui' }];

    expect(lintAppToolResourcePairing(tools, resources)).toHaveLength(0);
  });

  it('matches {/segments} operator (path segments with slashes)', () => {
    const tools = [
      validTool({
        name: 'app_segments',
        _meta: { ui: { resourceUri: 'ui://app/x/y' } },
      }),
    ];
    const resources = [{ uriTemplate: 'ui://app{/segments}', name: 'app-ui' }];

    expect(lintAppToolResourcePairing(tools, resources)).toHaveLength(0);
  });

  it('simple {var} does not match values with slashes', () => {
    const tools = [
      validTool({
        name: 'app_simple',
        _meta: { ui: { resourceUri: 'ui://app/a/b' } },
      }),
    ];
    const resources = [{ uriTemplate: 'ui://app/{page}', name: 'app-ui' }];

    // {page} only matches single segments — a/b should not match
    expect(lintAppToolResourcePairing(tools, resources)).toHaveLength(1);
  });

  it('handles mixed app and non-app tools', () => {
    const tools = [
      validTool({ name: 'regular_tool' }),
      validTool({
        name: 'app_tool',
        _meta: { ui: { resourceUri: 'ui://app/app.html' } },
      }),
    ];
    const resources = [{ uriTemplate: 'ui://app/app.html', name: 'app-ui' }];

    expect(lintAppToolResourcePairing(tools, resources)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// lintCanvasConsumerPairing
// ---------------------------------------------------------------------------

describe('lintCanvasConsumerPairing', () => {
  function canvasTool(
    name: string,
    outputField: 'canvas_id' | 'canvasId' | 'result' = 'canvas_id',
  ) {
    return {
      name,
      description: 'A canvas-producing tool',
      input: z.object({ query: z.string().describe('query') }),
      output: z.object({
        [outputField]: z.string().describe(outputField),
        data: z.array(z.string()).describe('preview rows'),
      }),
      handler: async () => ({ [outputField]: 'tok', data: [] }),
    };
  }

  function queryTool(name: string) {
    return {
      name,
      description: 'A dataframe query tool',
      input: z.object({ sql: z.string().describe('SQL') }),
      output: z.object({ rows: z.array(z.unknown()).describe('rows') }),
      handler: async () => ({ rows: [] }),
    };
  }

  it('returns no diagnostics when no tool has a canvas output', () => {
    const tools = [validTool({ name: 'search_data' }), validTool({ name: 'get_record' })];
    expect(lintCanvasConsumerPairing(tools)).toHaveLength(0);
  });

  it('warns when a tool outputs canvas_id with no consumer', () => {
    const tools = [canvasTool('my_query_data')];
    const diagnostics = lintCanvasConsumerPairing(tools);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      rule: 'canvas-consumer-missing',
      severity: 'warning',
      definitionName: 'my_query_data',
    });
    expect(diagnostics[0]!.message).toContain('canvas_id');
  });

  it('warns when a tool outputs canvasId with no consumer', () => {
    const tools = [canvasTool('my_query_data', 'canvasId')];
    const diagnostics = lintCanvasConsumerPairing(tools);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.rule).toBe('canvas-consumer-missing');
  });

  it('passes when a *_dataframe_query consumer is registered', () => {
    const tools = [canvasTool('my_search'), queryTool('my_dataframe_query')];
    expect(lintCanvasConsumerPairing(tools)).toHaveLength(0);
  });

  it('passes for any tool name ending in _dataframe_query', () => {
    const tools = [canvasTool('some_tool'), queryTool('some_prefix_dataframe_query')];
    expect(lintCanvasConsumerPairing(tools)).toHaveLength(0);
  });

  it('passes when canvasConsumers override lists the query tool', () => {
    const tools = [canvasTool('my_search'), queryTool('my_custom_sql_tool')];
    expect(
      lintCanvasConsumerPairing(tools, { canvasConsumers: ['my_custom_sql_tool'] }),
    ).toHaveLength(0);
  });

  it('false disables the rule entirely', () => {
    const tools = [canvasTool('my_search')];
    expect(lintCanvasConsumerPairing(tools, { canvasConsumers: false })).toHaveLength(0);
  });

  it('does not warn for tools without canvas output', () => {
    // A server with only ordinary tools and a query consumer should produce no warnings
    expect(lintCanvasConsumerPairing([validTool({ name: 'normal_tool' })])).toHaveLength(0);
  });

  it('warns once per emitter tool, not once per consumer', () => {
    // Two emitters, no consumer
    const tools = [canvasTool('tool_a'), canvasTool('tool_b')];
    const diagnostics = lintCanvasConsumerPairing(tools);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((d) => d.definitionName).sort()).toEqual(['tool_a', 'tool_b']);
  });

  it('passes when multiple emitters share one consumer', () => {
    const tools = [canvasTool('tool_a'), canvasTool('tool_b'), queryTool('shared_dataframe_query')];
    expect(lintCanvasConsumerPairing(tools)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// lintAuthScopes (verify existing export still works)
// ---------------------------------------------------------------------------

describe('lintAuthScopes', () => {
  it('passes with valid string array', () => {
    expect(lintAuthScopes(['scope:read', 'scope:write'], 'tool', 'test')).toHaveLength(0);
  });

  it('errors on non-array', () => {
    const diagnostics = lintAuthScopes('scope:read', 'tool', 'test');
    expect(diagnostics).toContainEqual(expect.objectContaining({ rule: 'auth-type' }));
  });

  it('errors on empty string in array', () => {
    const diagnostics = lintAuthScopes(['scope:read', ''], 'tool', 'test');
    expect(diagnostics).toContainEqual(expect.objectContaining({ rule: 'auth-scope-format' }));
  });
});

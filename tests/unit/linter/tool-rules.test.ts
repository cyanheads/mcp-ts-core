/**
 * @fileoverview Tests for tool-specific lint rules, focused on _meta.ui
 * validation and the app tool ↔ resource pairing cross-check.
 * @module tests/unit/linter/tool-rules.test
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  lintAppToolResourcePairing,
  lintCanvasConsumerPairing,
  lintToolDefinition,
} from '@/linter/rules/tool-rules.js';
import { validateDefinitions } from '@/linter/validate.js';
import { headerParam } from '@/mcp-server/tools/utils/headerParam.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';

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
// lintToolDefinition — declarative error contract wiring
// ---------------------------------------------------------------------------

describe('lintToolDefinition — error contract', () => {
  /** A contract whose one reason the handler below throws. */
  const errors = [
    {
      code: JsonRpcErrorCode.NotFound,
      reason: 'no_match',
      when: 'Nothing matched the query.',
      recovery: 'Broaden the query and call the tool again.',
    },
  ];

  it('reports a fail site that does not forward the declared recovery', () => {
    const diagnostics = lintToolDefinition(
      validTool({
        errors,
        handler: async (_input: unknown, ctx: { fail: (reason: string) => Error }) => {
          throw ctx.fail('no_match');
        },
      }),
    );

    expect(diagnostics.map((d) => d.rule)).toContain('error-contract-recovery-unforwarded');
  });

  it('stays silent once the site forwards it', () => {
    const diagnostics = lintToolDefinition(
      validTool({
        errors,
        handler: async (
          _input: unknown,
          ctx: {
            fail: (reason: string, message: string, data: unknown) => Error;
            recoveryFor: (reason: string) => object;
          },
        ) => {
          throw ctx.fail('no_match', 'Nothing matched', { ...ctx.recoveryFor('no_match') });
        },
      }),
    );

    expect(diagnostics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// lintToolDefinition — malformed entry (null/undefined)
// ---------------------------------------------------------------------------

describe('lintToolDefinition — malformed entry', () => {
  it('returns a definition-invalid diagnostic instead of throwing on null', () => {
    expect(() => lintToolDefinition(null)).not.toThrow();
    expect(lintToolDefinition(null)).toContainEqual(
      expect.objectContaining({
        rule: 'definition-invalid',
        definitionType: 'tool',
        severity: 'error',
      }),
    );
  });

  it('returns a definition-invalid diagnostic instead of throwing on undefined', () => {
    expect(() => lintToolDefinition(undefined)).not.toThrow();
    expect(lintToolDefinition(undefined)).toContainEqual(
      expect.objectContaining({ rule: 'definition-invalid', definitionType: 'tool' }),
    );
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
// header-param-designation wiring
// ---------------------------------------------------------------------------

describe('header-param-designation', () => {
  it('is not raised for a legal designation', () => {
    const diagnostics = lintToolDefinition(
      validTool({
        input: z.object({
          routing: z
            .object({ region: headerParam(z.string(), 'Region').describe('Region.') })
            .describe('Routing.'),
        }),
      }),
    );

    expect(diagnostics.map((d) => d.rule)).not.toContain('header-param-designation');
  });

  it('is raised as an error for an unreachable designation', () => {
    const diagnostics = lintToolDefinition(
      validTool({
        input: z.object({
          rows: z
            .array(z.object({ region: headerParam(z.string(), 'Region').describe('Region.') }))
            .describe('Rows.'),
        }),
      }),
    );

    const diagnostic = diagnostics.find((d) => d.rule === 'header-param-designation');
    expect(diagnostic).toMatchObject({ severity: 'error', definitionName: 'test_tool' });
    expect(diagnostic?.message).toContain('input.rows[].region');
  });
});

// ---------------------------------------------------------------------------
// uriTemplateToRegex — non-nesting expression split (#431)
// ---------------------------------------------------------------------------

/**
 * The template→regex compiler is module-private; whether a concrete
 * `resourceUri` pairs with a registered template is the observable pin on what
 * it compiled. Cases cover every RFC 6570 operator the resource rules document,
 * adjacent expressions, and an unclosed brace.
 */
describe('lintAppToolResourcePairing · template compilation (#431)', () => {
  const pairs = (uriTemplate: string, resourceUri: string) =>
    lintAppToolResourcePairing([validTool({ _meta: { ui: { resourceUri } } })], [{ uriTemplate }])
      .length === 0;

  it.each([
    ['ui://app/{page}', 'ui://app/dashboard', true],
    ['ui://app/{page}', 'ui://app/nested/page', false],
    ['ui://app/{+path}', 'ui://app/nested/page', true],
    ['ui://app{/segments}', 'ui://app/nested/page', true],
    ['ui://app/{#frag}', 'ui://app/x', true],
    ['ui://app/{.ext}', 'ui://app/x', true],
    ['ui://app/{;param}', 'ui://app/x', true],
    ['ui://app/{?query}', 'ui://app/x', true],
    ['ui://app/{&extra}', 'ui://app/x', true],
    ['ui://app/{a,b}', 'ui://app/x', true],
    ['ui://app/{a:3}', 'ui://app/x', true],
    ['ui://app/{a*}', 'ui://app/x', true],
    ['ui://app/{a}{b}', 'ui://app/xy', true],
    ['ui://app/{unclosed', 'ui://app/x', false],
    ['ui://app/{unclosed', 'ui://app/{unclosed', true],
  ])('%s vs %s pairs: %s', (uriTemplate, resourceUri, expected) => {
    expect(pairs(uriTemplate as string, resourceUri as string)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// lintToolDefinition — inputAliases (#452)
// ---------------------------------------------------------------------------

describe('lintToolDefinition — inputAliases', () => {
  /** The `input-alias-conflict` diagnostics a definition produces. */
  function conflicts(overrides: Record<string, unknown>): string[] {
    return lintToolDefinition(validTool(overrides))
      .filter((d) => d.rule === 'input-alias-conflict')
      .map((d) => d.message);
  }

  it('is silent when no aliases are declared', () => {
    expect(conflicts({})).toHaveLength(0);
  });

  it('is silent for aliases that resolve to exactly one declared key', () => {
    expect(conflicts({ inputAliases: { search_query: 'query', q: 'query' } })).toHaveLength(0);
  });

  it('is silent on a union root when the target exists on one variant', () => {
    const diagnostics = conflicts({
      input: z.discriminatedUnion('mode', [
        z.object({
          mode: z.literal('byId').describe('By ID.'),
          recordId: z.string().describe('Record ID.'),
        }),
        z.object({
          mode: z.literal('byName').describe('By name.'),
          fullName: z.string().describe('Name.'),
        }),
      ]),
      inputAliases: { id: 'recordId' },
    });

    expect(diagnostics).toHaveLength(0);
  });

  it('errors when an alias equals a declared key', () => {
    const [message] = conflicts({
      input: z.object({
        query: z.string().describe('Search query'),
        q: z.string().optional().describe('Short query'),
      }),
      inputAliases: { q: 'query' },
    });

    expect(message).toContain("declares 'q' as both an input key and an alias");
  });

  it('errors when an alias target does not exist', () => {
    const [message] = conflicts({ inputAliases: { q: 'searchQuery' } });

    expect(message).toContain("'searchQuery', which is not a declared input key");
    expect(message).toContain('declared: query');
  });

  it('errors when two declared keys case-fold to one name', () => {
    const messages = conflicts({
      input: z.object({
        maxResults: z.number().optional().describe('Maximum results'),
        max_results: z.number().optional().describe('Legacy maximum results'),
        query: z.string().describe('Search query'),
      }),
      inputAliases: { limit: 'query' },
    });

    expect(messages.some((m) => m.includes('differ only in case style'))).toBe(true);
  });

  it('errors when an alias case-folds to a declared key other than its target', () => {
    const messages = conflicts({
      input: z.object({
        query: z.string().describe('Search query'),
        maxResults: z.number().optional().describe('Maximum results'),
      }),
      inputAliases: { max_results: 'query' },
    });

    expect(messages.some((m) => m.includes('is a case-style variant of maxResults'))).toBe(true);
  });

  it('errors when two aliases case-fold to one name with different targets', () => {
    const messages = conflicts({
      input: z.object({
        query: z.string().describe('Search query'),
        maxResults: z.number().optional().describe('Maximum results'),
      }),
      inputAliases: { 'search-term': 'query', search_term: 'maxResults' },
    });

    expect(
      messages.some((m) => m.includes('differ only in case style but name different keys')),
    ).toBe(true);
  });

  it('errors when inputAliases is not an object of string targets', () => {
    expect(conflicts({ inputAliases: ['query'] })[0]).toContain('must be an object mapping');
    expect(conflicts({ inputAliases: { q: 7 } })[0]).toContain('must name a declared input key');
  });

  it('links every diagnostic to the rule reference', () => {
    const report = validateDefinitions({ tools: [validTool({ inputAliases: { q: 'nope' } })] });

    expect(report.passed).toBe(false);
    expect(
      report.errors.some((d) => d.message.includes('api-linter/SKILL.md#input-alias-conflict')),
    ).toBe(true);
  });

  describe('output that must not move', () => {
    const searchWithMax = z.object({
      query: z.string().describe('Search query'),
      maxResults: z.number().optional().describe('Maximum results'),
    });

    it.each([
      ['no aliases', {}, []],
      ['aliases resolving to one key', { inputAliases: { search_query: 'query', q: 'query' } }, []],
      [
        'an alias beside a header-designated key it does not target',
        {
          input: z.object({
            query: z.string().describe('Search query'),
            regionCode: headerParam(z.string(), 'Region').describe('Region.'),
          }),
          inputAliases: { q: 'query' },
        },
        [],
      ],
      [
        'an alias equal to a declared key',
        {
          input: z.object({
            query: z.string().describe('Search query'),
            q: z.string().optional().describe('Short query'),
          }),
          inputAliases: { q: 'query' },
        },
        [
          "Tool 'test_tool' declares 'q' as both an input key and an alias for 'query'. A " +
            'declared key is never rewritten, so the alias can never fire — remove it, or rename ' +
            'the input key.',
          "Tool 'test_tool' aliases 'q' to 'query', but 'q' is a case-style variant of q. Alias " +
            'it to the key it spells, or rename it so the two readings cannot disagree.',
        ],
      ],
      [
        'a missing target',
        { inputAliases: { q: 'searchQuery' } },
        [
          "Tool 'test_tool' aliases 'q' to 'searchQuery', which is not a declared input key " +
            '(declared: query). Point the alias at an existing key.',
        ],
      ],
      [
        'two declared keys folding to one name',
        {
          input: z.object({
            maxResults: z.number().optional().describe('Maximum results'),
            max_results: z.number().optional().describe('Legacy maximum results'),
            query: z.string().describe('Search query'),
          }),
          inputAliases: { limit: 'query' },
        },
        [
          "Tool 'test_tool' declares maxResults and max_results, which differ only in case style. " +
            'No alias can resolve between them — rename one, or drop the other and declare it as ' +
            'an alias of the one you keep.',
        ],
      ],
      [
        'an alias folding onto another declared key',
        { input: searchWithMax, inputAliases: { max_results: 'query' } },
        [
          "Tool 'test_tool' aliases 'max_results' to 'query', but 'max_results' is a case-style " +
            'variant of maxResults. Alias it to the key it spells, or rename it so the two ' +
            'readings cannot disagree.',
        ],
      ],
      [
        'two aliases folding to one name with different targets',
        {
          input: searchWithMax,
          inputAliases: { 'search-term': 'query', search_term: 'maxResults' },
        },
        [
          "Tool 'test_tool' aliases 'search-term' → 'query' and 'search_term' → 'maxResults', " +
            'which differ only in case style but name different keys. Pick one target, or spell ' +
            'the aliases so they are distinguishable.',
        ],
      ],
      [
        'a non-object inputAliases',
        { inputAliases: ['query'] },
        [
          "Tool 'test_tool' inputAliases must be an object mapping each alias to the declared " +
            "input key it stands for, e.g. { drug_name: 'drug' }.",
        ],
      ],
      [
        'a non-string target',
        { inputAliases: { q: 7 } },
        [
          "Tool 'test_tool' inputAliases['q'] must name a declared input key as a non-empty string.",
        ],
      ],
    ])('reports exactly this for %s', (_label, overrides, expected) => {
      expect(conflicts(overrides)).toEqual(expected);
    });
  });

  // #569 — the alias stage never rewrites onto a headerParam-designated field
  describe('an alias onto a headerParam-designated field (#569)', () => {
    it('rejects the definition, naming the alias, its target, and the designation', () => {
      const def = tool('header_alias_probe', {
        description: 'Probe.',
        input: z.object({
          query: z.string().describe('Query.'),
          regionCode: headerParam(z.string(), 'Region').describe('Region.'),
        }),
        inputAliases: { region: 'regionCode' },
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: () => ({ ok: true }),
      });

      const report = validateDefinitions({ tools: [def] });
      const aliasErrors = report.errors.filter((d) => d.rule === 'input-alias-conflict');

      expect(report.passed).toBe(false);
      expect(aliasErrors).toHaveLength(1);
      expect(aliasErrors[0]?.message).toContain(
        "Tool 'header_alias_probe' aliases 'region' to 'regionCode', which is designated " +
          "headerParam(…, 'Region') and mirrored in the Mcp-Param-Region request header.",
      );
      expect(aliasErrors[0]?.message).toContain('api-linter/SKILL.md#input-alias-conflict');
    });

    it('reports an alias onto a header field inside one discriminated-union variant', () => {
      const messages = conflicts({
        input: z.discriminatedUnion('mode', [
          z.object({
            mode: z.literal('byRegion').describe('By region.'),
            regionCode: headerParam(z.string(), 'Region').describe('Region.'),
          }),
          z.object({
            mode: z.literal('byName').describe('By name.'),
            fullName: z.string().describe('Name.'),
          }),
        ]),
        inputAliases: { region: 'regionCode', name: 'fullName' },
      });

      expect(messages).toEqual([
        "Tool 'test_tool' aliases 'region' to 'regionCode', which is designated " +
          "headerParam(…, 'Region') and mirrored in the Mcp-Param-Region request header. The " +
          'alias stage never rewrites onto a header-mirrored field — the SDK checks that header ' +
          'against the body the caller sent — so the alias never fires. Remove the alias, or ' +
          'drop the header designation.',
      ]);
    });

    it('leaves a header designation deeper than the root alone', () => {
      const messages = conflicts({
        input: z.object({
          region: z.string().describe('Region name.'),
          routing: z
            .object({ region: headerParam(z.string(), 'Region').describe('Routing region.') })
            .describe('Routing.'),
        }),
        inputAliases: { area: 'region' },
      });

      expect(messages).toEqual([]);
    });
  });
});

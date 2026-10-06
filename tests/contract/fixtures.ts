/**
 * @fileoverview The definitions the contract lane serves. `TEMPLATES` is what
 * `init` ships to a new server, loaded as written. `PURPOSE` covers each
 * schema feature a client can see, one place each, so a change to how any of
 * them is advertised or validated moves a pin. `CASES` is the fixed argument
 * matrix run against `PURPOSE`.
 * @module tests/contract/fixtures
 */
import { completable } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { appResource, appTool } from '@/mcp-server/apps/appBuilders.js';
import type { AnyPromptDefinition } from '@/mcp-server/prompts/utils/promptDefinition.js';
import { prompt } from '@/mcp-server/prompts/utils/promptDefinition.js';
import type { AnyResourceDefinition } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { disabledTool } from '@/mcp-server/tools/utils/disabled-tool.js';
import { headerParam } from '@/mcp-server/tools/utils/headerParam.js';
import { type AnyToolDefinition, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import type { FixtureSet } from './harness.js';

let handlerInput: unknown;

/** The arguments the last purpose-tool handler received, cleared on read. */
export function takeHandlerInput(): unknown {
  const input = handlerInput;
  handlerInput = undefined;
  return input;
}

const ok = z.object({ ok: z.boolean().describe('Always true.') });

const record = (input: unknown) => {
  handlerInput = input;
  return { ok: true };
};

/** Every argument shape the matrix sends, plus the definition-level fields a tool can advertise. */
const probe = tool('contract_probe', {
  title: 'Contract Probe',
  description: 'Searches an index with every kind of argument a client can send.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    query: z.string().min(1).describe('Search query.'),
    limit: z.number().int().min(1).max(50).default(10).describe('Maximum results.'),
    tags: z.array(z.string()).optional().describe('Tags to include.'),
    filter: z
      .object({
        field: z.string().describe('Field name.'),
        op: z.enum(['eq', 'ne']).describe('Comparison operator.'),
      })
      .optional()
      .describe('One field filter.'),
    weights: z.record(z.string(), z.number()).optional().describe('Per-field ranking weights.'),
    maxResults: z.number().int().optional().describe('Upstream result cap.'),
    code: z.string().optional().describe('Opaque upstream code.'),
    region: z
      .union([z.literal(''), z.enum(['us', 'eu'])])
      .optional()
      .describe('Region, or blank for any.'),
    note: z.string().optional().describe('Free-text note.'),
    shape: z
      .discriminatedUnion('kind', [
        z.object({
          kind: z.literal('circle').describe('A circle.'),
          radius: z.number().describe('Radius.'),
        }),
        z.object({
          kind: z.literal('square').describe('A square.'),
          side: z.number().describe('Side length.'),
        }),
      ])
      .optional()
      .describe('Search area.'),
    routing: z
      .object({ tenant: headerParam(z.string(), 'Tenant').describe('Tenant to route to.') })
      .optional()
      .describe('Routing hints.'),
  }),
  inputAliases: { q: 'query', _q: 'query' },
  output: ok,
  enrichment: { total: z.number().optional().describe('Total matches.') },
  errors: [
    {
      reason: 'index_missing',
      code: JsonRpcErrorCode.NotFound,
      when: 'The search index has not been built.',
      recovery: 'Build the index before searching again.',
    },
    {
      reason: 'queue_full',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The search queue is at capacity.',
      retryable: true,
      recovery: 'Wait thirty seconds before retrying the search.',
    },
  ],
  handler: (input) => record(input),
  format: (result) => [{ type: 'text', text: `ok: ${result.ok}` }],
});

const unionRoot = tool('contract_union_root', {
  description: 'Looks a record up by exactly one key.',
  input: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('byId').describe('Look up by ID.'),
      id: z.string().min(1).describe('Record ID.'),
    }),
    z.object({
      mode: z.literal('byName').describe('Search by name.'),
      name: z.string().describe('Name fragment.'),
      fuzzy: z.boolean().default(false).describe('Match loosely.'),
    }),
  ]),
  output: ok,
  handler: (input) => record(input),
});

/** An author-opened root and an over-typed-upstream output: both stay open. */
const openRoot = tool('contract_open_root', {
  description: 'Forwards arbitrary filters upstream.',
  input: z.object({ id: z.string().describe('Record ID.') }).passthrough(),
  output: z.object({}).passthrough(),
  handler: (input) => record(input),
});

/** Declared `.strict()` first, so the root description survives. */
const describedRoot = tool('contract_described_root', {
  description: 'Root description declared after `.strict()`.',
  input: z
    .object({ id: z.string().describe('Record ID.') })
    .strict()
    .describe('Kept root description.'),
  output: ok,
  handler: (input) => record(input),
});

/** Strictened by `tool()`, which discards a root description declared before it. */
const discardedRoot = tool('contract_discarded_root', {
  description: 'Root description declared without `.strict()`.',
  input: z
    .object({ id: z.string().describe('Record ID.') })
    .describe('Discarded root description.'),
  output: ok,
  handler: (input) => record(input),
});

const app = appTool('contract_app', {
  resourceUri: 'ui://contract/app.html',
  description: 'Shows a record in an interactive view.',
  extraMeta: { ui: { prefersBorder: true }, 'vendor/contract': { pinned: true } },
  input: z.object({}),
  output: ok,
  handler: (input) => record(input),
});

/** Registered but disabled: absent from `tools/list`. */
const disabled = disabledTool(
  tool('contract_disabled', {
    description: 'A tool switched off by configuration.',
    input: z.object({}),
    output: ok,
    handler: (input) => record(input),
  }),
  { reason: 'Disabled by the contract fixture.' },
);

const item = resource('contract://item/{id}', {
  name: 'contract_item',
  title: 'Contract Item',
  description: 'One item, addressed by ID.',
  cacheHint: { ttlMs: 60_000, cacheScope: 'public' },
  annotations: { audience: ['assistant'], priority: 0.5 },
  examples: [{ name: 'First item', uri: 'contract://item/1' }],
  params: z.object({ id: z.string().describe('Item ID.') }),
  output: z.object({ id: z.string().describe('Item ID.') }),
  complete: { id: () => ['1', '2'] },
  handler: (params) => ({ id: params.id }),
  list: () => ({ resources: [{ uri: 'contract://item/1', name: 'Item 1' }] }),
});

/** A scope-only hint: `ttlMs` falls back to the server's per-operation hint. */
const statusDoc = resource('contract://status', {
  name: 'contract_status',
  title: 'Contract Status',
  description: 'Service status.',
  mimeType: 'text/plain',
  size: 2,
  cacheHint: { cacheScope: 'public' },
  annotations: { audience: ['user', 'assistant'], lastModified: '2026-01-01T00:00:00Z' },
  _meta: { 'vendor/contract': { pinned: true } },
  handler: () => 'ok',
});

/** No title and no hint: falls back on both. */
const plainDoc = resource('contract://plain', {
  name: 'contract_plain',
  description: 'A document declaring nothing optional.',
  handler: () => ({ body: 'plain' }),
});

const appView = appResource('ui://contract/app.html', {
  name: 'contract_app_view',
  title: 'Contract App View',
  description: 'The view the app tool renders.',
  params: z.object({}).describe('No parameters.'),
  _meta: { ui: { csp: { resourceDomains: ['https://cdn.example.com'] } } },
  handler: () => '<!doctype html><title>contract</title>',
});

const promptWithArgs = prompt('contract_prompt', {
  title: 'Contract Prompt',
  description: 'Drafts a summary of a topic.',
  args: z.object({
    topic: completable(z.string().describe('Topic to summarize.'), () => ['alpha', 'beta']),
    style: z.string().default('brief').describe('Summary style.'),
    audience: z.string().optional().describe('Intended audience.'),
  }),
  generate: (args) => [
    { role: 'user', content: { type: 'text', text: `Summarize ${args.topic} (${args.style}).` } },
  ],
});

const barePrompt = prompt('contract_bare_prompt', {
  description: 'A prompt with no arguments.',
  generate: () => [{ role: 'user', content: { type: 'text', text: 'Hello.' } }],
});

/**
 * Loads one export of a shipped template definition. `templates/` is its own
 * package scope, where `@cyanheads/mcp-ts-core` resolves for Vitest through the
 * project alias but not for `tsc`, so the path is computed to keep the file out
 * of the root type program.
 */
async function fromTemplates<T>(file: string, name: string): Promise<T> {
  const url = new URL(`../../templates/src/mcp-server/${file}`, import.meta.url);
  const module: Record<string, unknown> = await import(url.pathname);
  if (!(name in module)) throw new Error(`${file} no longer exports ${name}`);
  return module[name] as T;
}

/** What `init` ships, registered the way the scaffolded `src/index.ts` registers it. */
export const TEMPLATES: FixtureSet = {
  tools: [
    await fromTemplates<AnyToolDefinition>('tools/definitions/echo.tool.ts', 'echoTool'),
    await fromTemplates<AnyToolDefinition>('tools/definitions/echo-app.app-tool.ts', 'echoAppTool'),
  ],
  resources: [
    await fromTemplates<AnyResourceDefinition>(
      'resources/definitions/echo.resource.ts',
      'echoResource',
    ),
    await fromTemplates<AnyResourceDefinition>(
      'resources/definitions/echo-app-ui.app-resource.ts',
      'echoAppUiResource',
    ),
  ],
  prompts: [
    await fromTemplates<AnyPromptDefinition>('prompts/definitions/echo.prompt.ts', 'echoPrompt'),
  ],
};

export const PURPOSE: FixtureSet = {
  tools: [
    probe,
    unionRoot,
    openRoot,
    describedRoot,
    discardedRoot,
    app,
    disabled,
  ] as AnyToolDefinition[],
  resources: [item, statusDoc, plainDoc, appView],
  prompts: [promptWithArgs, barePrompt],
  server: {
    title: 'Contract Fixture',
    description: 'Serves the contract lane.',
    websiteUrl: 'https://example.com/contract',
    icons: [{ src: 'https://example.com/icon.png', mimeType: 'image/png', sizes: ['48x48'] }],
    instructions: 'Search with contract_probe, then read contract://item/{id}.',
    extensions: { 'vendor/contract': { pinned: true } },
    cacheHints: { 'resources/read': { ttlMs: 30_000 } },
  },
};

/** One `tools/call`: the tool, a label naming what the arguments exercise, and the arguments. */
export type MatrixCase = readonly [tool: string, label: string, args: unknown];

/** `undefined` arguments are omitted from the request rather than sent. */
export const CASES: readonly MatrixCase[] = [
  ['contract_probe', 'valid, required only', { query: 'x' }],
  ['contract_probe', 'arguments omitted', undefined],
  ['contract_probe', 'missing required', {}],
  ['contract_probe', 'wrong type', { query: true }],
  ['contract_probe', 'out of range', { query: 'x', limit: 99 }],
  ['contract_probe', 'unknown root key', { query: 'x', limt: 5 }],
  [
    'contract_probe',
    'unknown nested key',
    { query: 'x', filter: { field: 'a', op: 'eq', extra: 1 } },
  ],
  [
    'contract_probe',
    'client-added keys',
    { query: 'x', _meta: { origin: 'client' }, toolCallId: 'c1', tool_call_description: 'd' },
  ],
  ['contract_probe', 'undeclared underscore key', { query: 'x', _trace: 1 }],
  ['contract_probe', 'underscore spelling of a declared key', { _query: 'x' }],
  ['contract_probe', 'case-style alias', { query: 'x', max_results: 3 }],
  ['contract_probe', 'declared alias', { q: 'x' }],
  ['contract_probe', 'declared underscore alias with a bad value', { _q: '' }],
  ['contract_probe', 'declared alias beside its target', { q: 'x', query: 'y' }],
  ['contract_probe', 'stringified array', { query: 'x', tags: '["a","b"]' }],
  ['contract_probe', 'stringified object', { query: 'x', filter: '{"field":"a","op":"eq"}' }],
  ['contract_probe', 'malformed stringified array', { query: 'x', tags: '["a",' }],
  ['contract_probe', 'integer for a string', { query: 'x', code: 8654467 }],
  ['contract_probe', 'empty string on an optional field', { query: 'x', note: '' }],
  ['contract_probe', 'empty-string sentinel', { query: 'x', region: '' }],
  ['contract_probe', 'value outside the sentinel union', { query: 'x', region: 'mars' }],
  ['contract_probe', 'record value of the wrong type', { query: 'x', weights: { a: 'high' } }],
  [
    'contract_probe',
    'nested union, unknown discriminator',
    { query: 'x', shape: { kind: 'hexagon', side: 1 } },
  ],
  ['contract_probe', 'arguments not an object', ['x']],
  ['contract_missing', 'unknown tool', { query: 'x' }],
  ['contract_union_root', 'union root, defaulted branch', { mode: 'byName', name: 'ada' }],
  ['contract_union_root', "union root, the other branch's field", { mode: 'byId', name: 'ada' }],
  ['contract_union_root', 'union root, unknown discriminator', { mode: 'byEmail' }],
  ['contract_open_root', 'open root, undeclared key', { id: 'r1', extra: true }],
  ['contract_disabled', 'disabled tool', {}],
];

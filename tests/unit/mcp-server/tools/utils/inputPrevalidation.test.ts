/**
 * @fileoverview The ordered pre-validation step tool arguments pass through:
 * dropping client-added root keys (#453), rewriting key aliases (#452), and
 * repairing a stringified array after a failed parse (#234).
 *
 * Every case drives the real `createToolHandler`, so what is asserted is the
 * envelope (or the handler input) a deployment produces — never a stubbed
 * `parseToolArguments`.
 * @module tests/mcp-server/tools/utils/inputPrevalidation.test
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { makeServerContext } from '../../../../helpers/server-context.js';

// ---------------------------------------------------------------------------
// Module mocks — the counters and the debug channel are the step's only
// observable side effects, so both are captured.
// ---------------------------------------------------------------------------

const { counterAdds, mockLogger } = vi.hoisted(() => ({
  counterAdds: [] as Array<{ attributes: Record<string, unknown>; metric: string; value: number }>,
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    crit: vi.fn(),
    emerg: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('@/utils/telemetry/metrics.js', () => {
  const instrument = (metric: string) => ({
    add: (value: number, attributes: Record<string, unknown> = {}) => {
      counterAdds.push({ attributes, metric, value });
    },
    record: () => {},
  });
  return {
    getMeter: () => ({}),
    createCounter: (name: string) => instrument(name),
    createUpDownCounter: (name: string) => instrument(name),
    createHistogram: (name: string) => instrument(name),
    createObservableGauge: () => ({}),
  };
});

vi.mock('@/utils/internal/logger.js', () => ({
  logger: mockLogger,
  Logger: { getInstance: () => mockLogger },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type { InputHandlingOptions } from '@/mcp-server/tools/utils/inputPrevalidation.js';
import type { AnyToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { headerParam, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import {
  createToolHandler,
  type HandlerServices,
  type NotifierSources,
} from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { runToolContract } from '@/testing/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const notifiers: NotifierSources = {};

/** The arguments the last handler invocation received. */
let seen: Record<string, unknown> | undefined;

/** Drives a definition through the production factory with raw arguments. */
async function call(
  definition: unknown,
  args: Record<string, unknown>,
  input?: InputHandlingOptions,
): Promise<CallToolResult> {
  const services = { ...(input && { input }) } as HandlerServices;
  const handler = createToolHandler(definition as AnyToolDefinition, services, notifiers);
  return (await handler(args, makeServerContext())) as CallToolResult;
}

/** The error envelope a failed call published. */
function envelope(result: CallToolResult): {
  code: number;
  data?: { issues?: unknown[]; reason?: string; recovery?: { hint?: string } };
  message: string;
} {
  return (result.structuredContent as { error: ReturnType<typeof envelope> }).error;
}

/** Counter increments recorded for one metric name. */
function adds(metric: string): Array<Record<string, unknown>> {
  return counterAdds.filter((entry) => entry.metric === metric).map((entry) => entry.attributes);
}

const ok = z.object({ ok: z.boolean().describe('OK.') });

/** Records what reached the handler and succeeds. */
function record(input: unknown): { ok: true } {
  seen = input as Record<string, unknown>;
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const search = tool('prevalidation_search', {
  description: 'Searches.',
  input: z.object({
    query: z.string().describe('Search query.'),
    maxResults: z.number().optional().describe('Maximum results.'),
  }),
  output: ok,
  handler: record,
});

const underscoreDeclaring = tool('prevalidation_underscore', {
  description: 'Declares an underscore-prefixed key of its own.',
  input: z.object({
    _cursor: z.string().optional().describe('Opaque cursor.'),
    query: z.string().describe('Search query.'),
  }),
  output: ok,
  handler: record,
});

const openRoot = tool('prevalidation_open', {
  description: 'Open root accepting unknown keys outright.',
  input: z.object({ query: z.string().describe('Search query.') }).passthrough(),
  output: ok,
  handler: record,
});

const catchallRoot = tool('prevalidation_catchall', {
  description: 'Open root validating unknown keys against a catchall.',
  input: z.object({ query: z.string().describe('Search query.') }).catchall(z.string()),
  output: ok,
  handler: record,
});

const unionRoot = tool('prevalidation_union', {
  description: 'Looks a record up by exactly one key.',
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
  output: ok,
  handler: record,
});

const aliased = tool('prevalidation_aliased', {
  description: 'Declares argument aliases.',
  input: z.object({ drug: z.string().describe('Drug name.') }),
  inputAliases: { drug_name: 'drug', substance: 'drug' },
  output: ok,
  handler: record,
});

const ambiguousFold = tool('prevalidation_ambiguous', {
  description: 'Two declared keys that case-fold to one name.',
  input: z.object({
    maxResults: z.number().optional().describe('Maximum results.'),
    max_results: z.number().optional().describe('Legacy maximum results.'),
    query: z.string().describe('Search query.'),
  }),
  output: ok,
  handler: record,
});

const headerRouted = tool('prevalidation_header', {
  description: 'Mirrors a routing argument into a request header.',
  input: z.object({
    query: z.string().describe('Search query.'),
    regionCode: headerParam(z.string(), 'Region').describe('Deployment region.'),
  }),
  output: ok,
  handler: record,
});

const listy = tool('prevalidation_list', {
  description: 'Takes a list of statuses.',
  input: z.object({
    statusFilter: z.array(z.string()).describe('Statuses to include.'),
    tags: z.array(z.string()).optional().describe('Tags to include.'),
    note: z.string().optional().describe('Free-text note.'),
  }),
  output: ok,
  handler: record,
});

const freeText = tool('prevalidation_freetext', {
  description: 'Takes a free-text field that may legitimately look like an array.',
  input: z.object({
    note: z.string().describe('Free-text note.'),
    count: z.number().describe('A count.'),
  }),
  output: ok,
  handler: record,
});

const nestedList = tool('prevalidation_nested_list', {
  description: 'Takes a nested list.',
  input: z.object({
    filter: z.object({ status: z.array(z.string()).describe('Statuses.') }).describe('Filter.'),
  }),
  output: ok,
  handler: record,
});

const mixedRepair = tool('prevalidation_mixed_repair', {
  description: 'A list beside a free-text field that may legitimately look like a list.',
  input: z.object({
    statusFilter: z.array(z.string()).describe('Statuses to include.'),
    note: z.string().describe('Free-text note.'),
  }),
  output: ok,
  handler: record,
});

const openRepair = tool('prevalidation_open_repair', {
  description: 'Open root taking a list, with an optional flag no caller sends.',
  input: z
    .object({
      statusFilter: z.array(z.string()).describe('Statuses to include.'),
      polluted: z.boolean().optional().describe('Never supplied by a caller.'),
    })
    .catchall(z.unknown()),
  output: ok,
  handler: record,
});

const unionList = tool('prevalidation_union_list', {
  description: 'A union root whose selected variant takes a list.',
  input: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('byIds').describe('By IDs.'),
      ids: z.array(z.string()).describe('Record IDs.'),
    }),
    z.object({
      mode: z.literal('byName').describe('By name.'),
      fullName: z.string().describe('Name.'),
    }),
  ]),
  output: ok,
  handler: record,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tool argument pre-validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    counterAdds.length = 0;
    seen = undefined;
  });

  // -----------------------------------------------------------------------
  // #453 — client-added keys
  // -----------------------------------------------------------------------

  describe('client-added keys (#453)', () => {
    it.each([['_as_extra'], ['tool_call_description'], ['toolCallId'], ['_meta']])(
      'succeeds with a valid call carrying %s, and the key never reaches the handler',
      async (key) => {
        const result = await call(search, { query: 'aspirin', [key]: {} });

        expect(result.isError).toBeUndefined();
        expect(seen).toEqual({ query: 'aspirin' });
      },
    );

    it('drops several client-added keys in one call', async () => {
      const result = await call(search, {
        query: 'aspirin',
        _meta: { a: 1 },
        toolCallId: 'call_1',
        _as_extra: {},
      });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'aspirin' });
    });

    it('never drops a declared key, including a declared underscore-prefixed one', async () => {
      const result = await call(underscoreDeclaring, { query: 'x', _cursor: 'abc' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x', _cursor: 'abc' });
    });

    it('still rejects an undeclared underscore key on a tool declaring one', async () => {
      const result = await call(underscoreDeclaring, { query: 'x', _curser: 'abc' });

      expect(envelope(result).message).toContain('Unrecognized key: "_curser"');
    });

    it('still applies the ignore list to a tool declaring an underscore key', async () => {
      const result = await call(underscoreDeclaring, { query: 'x', _meta: {} });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x' });
    });

    it('never drops a key declared on only one variant of a union root', async () => {
      const result = await call(unionRoot, { mode: 'byId', recordId: 'r1', fullName: 'oops' });

      expect(envelope(result).message).toContain('Unrecognized key: "fullName"');
    });

    it('drops a client-added key on a union root', async () => {
      const result = await call(unionRoot, { mode: 'byId', recordId: 'r1', _meta: {} });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ mode: 'byId', recordId: 'r1' });
    });

    it.each([
      ['passthrough', openRoot],
      ['catchall', catchallRoot],
    ])('passes every extra key through to the handler on a %s root', async (_label, def) => {
      const result = await call(def, { query: 'x', _meta: 'kept', toolCallId: 'kept' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x', _meta: 'kept', toolCallId: 'kept' });
    });

    it('drops a server-configured extra key', async () => {
      const result = await call(
        search,
        { query: 'x', some_client_field: 1 },
        { ignoreKeys: ['some_client_field'] },
      );

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x' });
    });

    it('keeps the built-in list when the server adds its own', async () => {
      const result = await call(search, { query: 'x', _meta: {} }, { ignoreKeys: ['other'] });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x' });
    });

    it('restores rejection for every key under ignoreKeys: false', async () => {
      const result = await call(search, { query: 'x', _meta: {} }, { ignoreKeys: false });

      expect(envelope(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(envelope(result).message).toContain('Unrecognized key: "_meta"');
    });

    it('emits one counter increment and one debug log per dropped key', async () => {
      await call(search, { query: 'x', _meta: {}, toolCallId: 'c1' });

      expect(adds('mcp.input.ignored_key')).toEqual([
        { 'mcp.tool.name': 'prevalidation_search', 'mcp.input.ignore_rule': '_meta' },
        { 'mcp.tool.name': 'prevalidation_search', 'mcp.input.ignore_rule': 'toolCallId' },
      ]);
      const drops = mockLogger.debug.mock.calls.filter(([message]) =>
        String(message).includes('dropped client-added argument key'),
      );
      expect(drops).toHaveLength(2);
    });

    it('labels an underscore-rule drop with the rule, never the caller-supplied key', async () => {
      await call(search, { query: 'x', _callId: 'a', _call_id: 'b', _callID: 'c' });

      // Three spellings one client invented; one bounded label, not three series.
      expect(adds('mcp.input.ignored_key')).toEqual([
        { 'mcp.tool.name': 'prevalidation_search', 'mcp.input.ignore_rule': 'underscore_prefix' },
        { 'mcp.tool.name': 'prevalidation_search', 'mcp.input.ignore_rule': 'underscore_prefix' },
        { 'mcp.tool.name': 'prevalidation_search', 'mcp.input.ignore_rule': 'underscore_prefix' },
      ]);
      expect(JSON.stringify(counterAdds)).not.toContain('_callId');
    });

    it('keeps the raw dropped key on the debug log', async () => {
      await call(search, { query: 'x', _callId: 'a' });

      const drop = mockLogger.debug.mock.calls.find(([message]) =>
        String(message).includes('dropped client-added argument key'),
      );
      expect(String(drop?.[0])).toContain('_callId');
      expect(drop?.[1]).toMatchObject({
        extra: { ignoredKey: '_callId', ignoreRule: 'underscore_prefix' },
      });
    });

    it('labels a server-configured ignore key by name, since the list is author-defined', async () => {
      await call(
        search,
        { query: 'x', some_client_field: 1 },
        { ignoreKeys: ['some_client_field'] },
      );

      expect(adds('mcp.input.ignored_key')).toEqual([
        { 'mcp.tool.name': 'prevalidation_search', 'mcp.input.ignore_rule': 'some_client_field' },
      ]);
    });

    it('says nothing about the drop in the response', async () => {
      const result = await call(search, { query: 'x', _meta: {} });

      expect(JSON.stringify(result)).not.toContain('_meta');
    });
  });

  // -----------------------------------------------------------------------
  // #452 — key aliases
  // -----------------------------------------------------------------------

  describe('key aliases (#452)', () => {
    it('reaches the handler under the canonical key via a declared alias', async () => {
      const result = await call(aliased, { drug_name: 'aspirin' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ drug: 'aspirin' });
    });

    it.each([['max_results'], ['Max-Results'], ['MAXRESULTS'], ['max-results']])(
      'rewrites the case-style variant %s to maxResults',
      async (alias) => {
        const result = await call(search, { query: 'x', [alias]: 5 });

        expect(result.isError).toBeUndefined();
        expect(seen).toEqual({ query: 'x', maxResults: 5 });
      },
    );

    it('leaves the arguments alone when alias and target are both present', async () => {
      const result = await call(aliased, { drug: 'aspirin', drug_name: 'tylenol' });

      expect(envelope(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(envelope(result).message).toContain('Unrecognized key: "drug_name"');
    });

    it('folds two keys to one target only once, leaving the second rejected', async () => {
      const result = await call(search, { query: 'x', max_results: 5, 'Max-Results': 6 });

      expect(envelope(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(envelope(result).message).toContain('Unrecognized key');
    });

    it('still rejects a key matching no alias and no declared key, with the #445 hint', async () => {
      const result = await call(search, { query: 'x', salt: true });

      expect(envelope(result).message).toBe(
        'Input validation error: Invalid arguments for tool prevalidation_search: ' +
          'Unrecognized key: "salt"',
      );
      expect(envelope(result).data?.recovery?.hint).toBe(
        'Unknown key salt. This tool accepts: query, maxResults.',
      );
    });

    it('rewrites nothing when a case-folded form matches two declared keys', async () => {
      const result = await call(ambiguousFold, { query: 'x', 'MAX-RESULTS': 5 });

      expect(envelope(result).message).toContain('Unrecognized key: "MAX-RESULTS"');
    });

    it.each([
      ['passthrough', openRoot],
      ['catchall', catchallRoot],
    ])('never rewrites on a %s root', async (_label, def) => {
      const result = await call(def, { query: 'x', Query_: 'y' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x', Query_: 'y' });
    });

    it("rewrites a case-style variant of the selected union variant's key", async () => {
      const result = await call(unionRoot, { mode: 'byId', record_id: 'r1' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ mode: 'byId', recordId: 'r1' });
    });

    it('rewrites nothing when the union discriminator is absent', async () => {
      const result = await call(unionRoot, { record_id: 'r1' });

      expect(envelope(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(JSON.stringify(envelope(result).data?.issues)).not.toContain('recordId');
    });

    it('rewrites nothing when the union discriminator is unrecognized', async () => {
      const result = await call(unionRoot, { mode: 'byEmail', record_id: 'r1' });

      expect(envelope(result).message).toContain('Invalid discriminator value');
    });

    it("never rewrites to another variant's key", async () => {
      const result = await call(unionRoot, { mode: 'byId', full_name: 'x' });

      expect(envelope(result).message).toContain('Unrecognized key: "full_name"');
    });

    it('never rewrites to a headerParam-designated target', async () => {
      const result = await call(headerRouted, { query: 'x', region_code: 'us-west' });

      expect(envelope(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(envelope(result).message).toContain('Unrecognized key: "region_code"');
    });

    it('leaves declared aliases working under caseStyleAliases: false', async () => {
      const result = await call(aliased, { drug_name: 'aspirin' }, { caseStyleAliases: false });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ drug: 'aspirin' });
    });

    it('restores rejection for an undeclared variant under caseStyleAliases: false', async () => {
      const result = await call(
        search,
        { query: 'x', max_results: 5 },
        { caseStyleAliases: false },
      );

      expect(envelope(result).message).toContain('Unrecognized key: "max_results"');
    });

    it('emits one counter increment and one debug log per rewrite', async () => {
      await call(aliased, { drug_name: 'aspirin' });

      expect(adds('mcp.input.aliased')).toEqual([
        {
          'mcp.tool.name': 'prevalidation_aliased',
          'mcp.input.target': 'drug',
          'mcp.input.alias_kind': 'declared',
        },
      ]);
      const rewrites = mockLogger.debug.mock.calls.filter(([message]) =>
        String(message).includes('rewrote argument key'),
      );
      expect(rewrites).toHaveLength(1);
    });

    it('labels the canonical target and the kind, never the caller-supplied alias', async () => {
      // Every permutation folds onto one declared key, so one bounded label
      // covers them all rather than minting a series per spelling.
      for (const alias of ['max_results', 'Max-Results', 'MAXRESULTS']) {
        await call(search, { query: 'x', [alias]: 5 });
      }

      expect(adds('mcp.input.aliased')).toEqual(
        Array.from({ length: 3 }, () => ({
          'mcp.tool.name': 'prevalidation_search',
          'mcp.input.target': 'maxResults',
          'mcp.input.alias_kind': 'case_style',
        })),
      );
      expect(JSON.stringify(counterAdds)).not.toContain('max_results');
    });

    it('keeps the raw alias on the debug log', async () => {
      await call(search, { query: 'x', 'Max-Results': 5 });

      const rewrite = mockLogger.debug.mock.calls.find(([message]) =>
        String(message).includes('rewrote argument key'),
      );
      expect(String(rewrite?.[0])).toContain('Max-Results');
      expect(rewrite?.[1]).toMatchObject({
        extra: { alias: 'Max-Results', target: 'maxResults', aliasKind: 'case_style' },
      });
    });

    it('says nothing about the rewrite in the response', async () => {
      const result = await call(aliased, { drug_name: 'aspirin' });

      expect(JSON.stringify(result)).not.toContain('drug_name');
    });

    it('drops client-added keys before rewriting aliases', async () => {
      const result = await call(search, { query: 'x', max_results: 5, _meta: {} });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x', maxResults: 5 });
    });
  });

  // -----------------------------------------------------------------------
  // #234 — validation-gated representation repair
  // -----------------------------------------------------------------------

  describe('representation repair (#234)', () => {
    it('reaches the handler as an array when a stringified array arrives', async () => {
      const result = await call(listy, { statusFilter: '["RECRUITING"]' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ statusFilter: ['RECRUITING'] });
    });

    it('bubbles the original rejection for a truncated string', async () => {
      const truncated = await call(listy, { statusFilter: '["RECRUITING"' });
      const plain = await call(listy, { statusFilter: '["RECRUITING"', note: 1 as never });

      expect(envelope(truncated).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(envelope(truncated).message).toBe(
        'Input validation error: Invalid arguments for tool prevalidation_list: ' +
          'statusFilter: Invalid input: expected array, received string',
      );
      expect(envelope(truncated).data?.recovery?.hint).toBe(
        'Send statusFilter as an array, not a string.',
      );
      // An unrelated invalid field rides along: every original issue is reported.
      expect(envelope(plain).data?.issues).toEqual([
        expect.objectContaining({ path: ['statusFilter'] }),
        expect.objectContaining({ path: ['note'] }),
      ]);
    });

    it('bubbles the original rejection when a parseable repair still fails the schema', async () => {
      const result = await call(listy, { statusFilter: '[1, 2, 3]' });

      // The original rejection names the string that arrived, not the repaired array.
      expect(envelope(result).message).toBe(
        'Input validation error: Invalid arguments for tool prevalidation_list: ' +
          'statusFilter: Invalid input: expected array, received string',
      );
    });

    it('never re-parses a valid call, so a string field keeps its bracketed text', async () => {
      const result = await call(freeText, { note: '[1,2,3]', count: 1 });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ note: '[1,2,3]', count: 1 });
    });

    it('never adds, drops, or renames a key', async () => {
      const result = await call(listy, { statusFilter: '["A"]', note: 'keep' });

      expect(result.isError).toBeUndefined();
      expect(Object.keys(seen ?? {}).sort()).toEqual(['note', 'statusFilter']);
    });

    it('repairs a nested value', async () => {
      const result = await call(nestedList, { filter: { status: '["A","B"]' } });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ filter: { status: ['A', 'B'] } });
    });

    it('repairs only the fields the rejection names, leaving a valid look-alike alone', async () => {
      // `note` is a valid string that happens to read as JSON, so it is not in
      // the issue list. Repairing it too would turn it into an array and lose a
      // repair that should have succeeded.
      const result = await call(mixedRepair, { statusFilter: '["A"]', note: '[1,2]' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ statusFilter: ['A'], note: '[1,2]' });
    });

    it('never lets an own __proto__ key re-prototype the repaired copy', async () => {
      // JSON.parse creates `__proto__` as an own data property. An open root
      // keeps it, so the repair's copy of the root is what has to preserve it —
      // a plain `copy[key] = value` would route through the prototype setter,
      // dropping the key and handing the re-parse a poisoned object. Zod reads
      // inherited properties, so `polluted` would then reach the handler.
      const args = JSON.parse('{"__proto__": {"polluted": true}, "statusFilter": "[\\"A\\"]"}');
      const result = await call(openRepair, args);

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ statusFilter: ['A'] });
      expect(seen).not.toHaveProperty('polluted');
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('repairs within the variant the discriminator selects', async () => {
      const result = await call(unionList, { mode: 'byIds', ids: '["a","b"]' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ mode: 'byIds', ids: ['a', 'b'] });
    });

    it('repairs nothing when the discriminator itself is what failed', async () => {
      const result = await call(unionList, { mode: 'byEmail', ids: '["a"]' });

      expect(envelope(result).message).toContain('Invalid discriminator value');
    });

    it('restores the single-parse behavior under coerce: false', async () => {
      const off = await call(listy, { statusFilter: '["RECRUITING"]' }, { coerce: false });

      expect(envelope(off).message).toBe(
        'Input validation error: Invalid arguments for tool prevalidation_list: ' +
          'statusFilter: Invalid input: expected array, received string',
      );

      // The same call repairs when coercion is left on.
      const on = await call(listy, { statusFilter: '["RECRUITING"]' });

      expect(on.isError).toBeUndefined();
      expect(seen).toEqual({ statusFilter: ['RECRUITING'] });
    });

    it('emits one counter increment and one debug log per repaired call, not per value', async () => {
      await call(listy, { statusFilter: '["A"]', tags: '["B"]' });

      expect(adds('mcp.input.coerced')).toEqual([
        {
          'mcp.tool.name': 'prevalidation_list',
          'mcp.input.coercion': 'stringified_array',
        },
      ]);
      const repairs = mockLogger.debug.mock.calls.filter(([message]) =>
        String(message).includes('repairing a stringified array'),
      );
      expect(repairs).toHaveLength(1);
    });

    it('says nothing about the repair in the response', async () => {
      const result = await call(listy, { statusFilter: '["A"]' });

      expect(JSON.stringify(result)).not.toContain('coerce');
      expect(result.isError).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Parity — runToolContract runs the same step (#416)
  // -----------------------------------------------------------------------

  describe('runToolContract parity (#416)', () => {
    it.each([
      ['a dropped client-added key', search, { query: 'x', _meta: {} }],
      ['a declared alias', aliased, { drug_name: 'aspirin' }],
      ['a case-style variant', search, { query: 'x', max_results: 5 }],
      ['a repaired stringified array', listy, { statusFilter: '["A"]' }],
    ])('succeeds through the helper for %s', async (_label, def, args) => {
      const production = await call(def, args as Record<string, unknown>);
      const viaProduction = seen;
      seen = undefined;
      const helper = await runToolContract(def as AnyToolDefinition, args as never);

      expect(helper.isError).toBeUndefined();
      expect(production.isError).toBeUndefined();
      expect(seen).toEqual(viaProduction);
    });

    it('publishes the production envelope when the step cannot rescue the call', async () => {
      const production = await call(search, { query: 'x', salt: true });
      const helper = await runToolContract(
        search as AnyToolDefinition,
        {
          query: 'x',
          salt: true,
        } as never,
      );

      expect(envelope(helper).message).toBe(envelope(production).message);
      expect(envelope(helper).data).toEqual(envelope(production).data);
      expect(helper.content).toEqual(production.content);
    });
  });

  // -----------------------------------------------------------------------
  // Both consumption surfaces
  // -----------------------------------------------------------------------

  describe('both client surfaces', () => {
    it('renders the rescued call on structuredContent and on content[]', async () => {
      const formatted = tool('prevalidation_formatted', {
        description: 'Formats its result.',
        input: z.object({ statusFilter: z.array(z.string()).describe('Statuses.') }),
        output: z.object({ count: z.number().describe('How many statuses arrived.') }),
        handler: (input) => ({ count: (input as { statusFilter: string[] }).statusFilter.length }),
        format: (result) => [
          { type: 'text', text: `**${(result as { count: number }).count} statuses**` },
        ],
      });

      const result = await call(formatted, { status_filter: '["A","B"]', _meta: {} });

      expect(result.structuredContent).toEqual({ count: 2 });
      expect(result.content).toEqual([{ type: 'text', text: '**2 statuses**' }]);
    });
  });
});

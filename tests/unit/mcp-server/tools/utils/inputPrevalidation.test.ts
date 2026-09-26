/**
 * @fileoverview The ordered pre-validation step tool arguments pass through:
 * dropping client-added root keys (#453), rewriting key aliases (#452, #563),
 * repairing a stringified array, a stringified object, or an integer sent for
 * a string after a failed parse (#234, #479, #487), and reporting what the
 * pre-parse stages changed on a rejection (#468).
 *
 * Every case drives the real `createToolHandler`, so what is asserted is the
 * envelope (or the handler input) a deployment produces — never a stubbed
 * `parseToolArguments`.
 * @module tests/mcp-server/tools/utils/inputPrevalidation.test
 */

import { Client } from '@modelcontextprotocol/client';
import { type CallToolResult, InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
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

import { ToolRegistry } from '@/mcp-server/tools/tool-registration.js';
import type { InputHandlingOptions } from '@/mcp-server/tools/utils/inputPrevalidation.js';
import type { AnyToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { headerParam, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import {
  createToolHandler,
  type HandlerServices,
  type NotifierSources,
  parseToolArguments,
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
  data?: {
    input?: unknown;
    issues?: unknown[];
    reason?: string;
    recovery?: { hint?: string };
  };
  message: string;
} {
  return (result.structuredContent as { error: ReturnType<typeof envelope> }).error;
}

/** The `content[]` text a format()-only client reads. */
function text(result: CallToolResult): string {
  return (result.content[0] as { text: string }).text;
}

/** Counter increments recorded for one metric name. */
function adds(metric: string): Array<Record<string, unknown>> {
  return counterAdds.filter((entry) => entry.metric === metric).map((entry) => entry.attributes);
}

/** Debug-log messages the step wrote that contain `fragment`. */
function debugLines(fragment: string): string[] {
  return mockLogger.debug.mock.calls
    .map(([message]) => String(message))
    .filter((message) => message.includes(fragment));
}

/**
 * Asserts a call the repair could not rescue gets exactly the rejection the
 * same call gets with repair switched off — `data.input` and the hint included,
 * on both client surfaces.
 */
async function expectOriginalRejection(
  definition: unknown,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const on = await call(definition, args);
  const off = await call(definition, args, { coerce: false });

  expect(on.isError).toBe(true);
  expect(envelope(on).code).toBe(JsonRpcErrorCode.InvalidParams);
  expect(on).toEqual(off);
  return on;
}

/** The `tools/list` result a real client receives for `definitions`, as JSON text. */
async function listed(definitions: unknown[], input?: InputHandlingOptions): Promise<string> {
  const server = new McpServer(
    { name: 'prevalidation-listing', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  await new ToolRegistry(
    definitions as AnyToolDefinition[],
    {
      ...(input && { input }),
    } as HandlerServices,
  ).registerAll(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'prevalidation-listing-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return JSON.stringify((await client.listTools()).tools);
  } finally {
    await client.close();
    await server.close();
  }
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

const underscoreAliased = tool('prevalidation_underscore_alias', {
  description: 'Declares an underscore-prefixed alias.',
  input: z.object({ query: z.string().describe('Search query.') }),
  inputAliases: { _q: 'query' },
  output: ok,
  handler: record,
});

const underscoreFloor = tool('prevalidation_underscore_floor', {
  description: 'Declares an underscore-prefixed alias onto a key with a length floor.',
  input: z.object({ query: z.string().min(3).describe('Search query.') }),
  inputAliases: { _q: 'query' },
  output: ok,
  handler: record,
});

const underscoreKeyed = tool('prevalidation_underscore_keyed', {
  description: 'Declares a key spelled like an underscore alias.',
  input: z.object({
    _q: z.string().describe('Opaque query token.'),
    query: z.string().optional().describe('Search query.'),
  }),
  output: ok,
  handler: record,
});

const ignoreListedAlias = tool('prevalidation_ignore_listed_alias', {
  description: 'Declares an alias for a key on the built-in ignore list.',
  input: z.object({
    query: z.string().describe('Search query.'),
    callId: z.string().optional().describe('Caller-supplied call ID.'),
  }),
  inputAliases: { toolCallId: 'callId' },
  output: ok,
  handler: record,
});

const requiredCallId = tool('prevalidation_required_call_id', {
  description: 'Requires the key an ignore-listed alias names.',
  input: z.object({ callId: z.string().describe('Caller-supplied call ID.') }),
  inputAliases: { toolCallId: 'callId' },
  output: ok,
  handler: record,
});

const metaField = tool('prevalidation_meta_field', {
  description: 'Declares the key the built-in `_meta` artifact case-folds onto.',
  input: z.object({
    query: z.string().describe('Search query.'),
    meta: z.string().optional().describe('Caller-supplied metadata.'),
  }),
  output: ok,
  handler: record,
});

const minTarget = tool('prevalidation_min_target', {
  description: 'An aliased key with a length floor beside a capped count.',
  input: z.object({
    targetQuery: z.string().min(3).describe('Target query.'),
    maxResults: z.number().int().max(100).optional().describe('Maximum results.'),
  }),
  inputAliases: { query: 'targetQuery' },
  output: ok,
  handler: record,
});

const NoteTarget = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('path').describe('Address the note by vault path.'),
    path: z.string().describe('Vault-relative path.'),
  }),
  z.object({
    type: z.literal('periodic').describe('Address a periodic note.'),
    period: z.enum(['daily', 'weekly']).describe('Period.'),
  }),
]);

const objecty = tool('prevalidation_objects', {
  description: 'Takes object-typed fields beside strings that may look like objects.',
  input: z.object({
    target: NoteTarget.describe('Which note.'),
    section: z
      .object({ heading: z.string().describe('Heading.') })
      .optional()
      .describe('Section.'),
    patchOptions: z
      .object({
        mode: z.enum(['append', 'prepend']).default('append').describe('Where to write.'),
        createIfMissing: z.boolean().default(false).describe('Create the note if absent.'),
      })
      .optional()
      .describe('Patch options.'),
    frame: z
      .object({ box: z.object({ width: z.number().describe('Width.') }).describe('Box.') })
      .optional()
      .describe('Frame.'),
    labels: z.record(z.string(), z.string()).optional().describe('Labels.'),
    items: z
      .array(z.object({ name: z.string().describe('Name.') }))
      .optional()
      .describe('Items.'),
    spec: z
      .union([z.string(), z.object({ k: z.string().describe('K.') })])
      .optional()
      .describe('A spec string or object.'),
    tags: z.array(z.string()).optional().describe('Tags.'),
    note: z.string().optional().describe('Free-text note.'),
  }),
  output: ok,
  handler: record,
});

/** `target` as a caller that serializes nested objects sends it. */
const STRINGIFIED_TARGET = '{"type":"path","path":"Notes/a.md"}';

const numericIds = tool('prevalidation_numeric_ids', {
  description: 'Takes identifiers that look numeric.',
  input: z.object({
    stationId: z.string().optional().describe('Station ID.'),
    pmids: z.array(z.string().regex(/^\d+$/).describe('PMID.')).optional().describe('PMIDs.'),
    filter: z
      .object({ id: z.string().describe('ID.') })
      .optional()
      .describe('Filter.'),
    items: z
      .array(z.object({ id: z.string().describe('ID.') }))
      .optional()
      .describe('Items.'),
    labels: z.record(z.string(), z.string()).optional().describe('Labels.'),
    oneOrMany: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe('One ID or several.'),
    days: z.enum(['1', '7', '30']).optional().describe('Window in days.'),
    zip: z
      .union([z.literal(''), z.string().regex(/^\d{5}$/)])
      .optional()
      .describe('ZIP code, or blank for any.'),
    date: z.iso.date().optional().describe('Date.'),
    recall: z
      .string()
      .regex(/^\d{5}([a-d])?$/)
      .optional()
      .describe('Recall number.'),
    either: z.union([z.string(), z.number()]).optional().describe('A string or a number.'),
    anything: z.unknown().optional().describe('Anything.'),
    positiveOrText: z
      .union([z.number().int().positive(), z.string()])
      .optional()
      .describe('A positive integer or text.'),
    fiveOrText: z
      .union([z.literal(5), z.string()])
      .optional()
      .describe('Five or text.'),
  }),
  output: ok,
  handler: record,
});

/**
 * The `inputSchema` each probe advertised in `tools/list` before the rewrite
 * and repair stages learned their new cases (#468, #479, #487, #563), byte for
 * byte. Every stage acts on arguments only, so none of these may move.
 */
const PINNED_INPUT_SCHEMAS: Record<string, string> = {
  prevalidation_min_target:
    '{"type":"object","properties":{"targetQuery":{"type":"string","minLength":3,"description":"Target query."},"maxResults":{"description":"Maximum results.","type":"integer","minimum":-9007199254740991,"maximum":100}},"required":["targetQuery"],"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false}',
  prevalidation_numeric_ids: String.raw`{"type":"object","properties":{"stationId":{"description":"Station ID.","type":"string"},"pmids":{"description":"PMIDs.","type":"array","items":{"type":"string","pattern":"^\\d+$","description":"PMID."}},"filter":{"description":"Filter.","type":"object","properties":{"id":{"type":"string","description":"ID."}},"required":["id"]},"items":{"description":"Items.","type":"array","items":{"type":"object","properties":{"id":{"type":"string","description":"ID."}},"required":["id"]}},"labels":{"description":"Labels.","type":"object","propertyNames":{"type":"string"},"additionalProperties":{"type":"string"}},"oneOrMany":{"description":"One ID or several.","anyOf":[{"type":"string"},{"type":"array","items":{"type":"string"}}]},"days":{"description":"Window in days.","type":"string","enum":["1","7","30"]},"zip":{"description":"ZIP code, or blank for any.","anyOf":[{"type":"string","const":""},{"type":"string","pattern":"^\\d{5}$"}]},"date":{"description":"Date.","type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"recall":{"description":"Recall number.","type":"string","pattern":"^\\d{5}([a-d])?$"},"either":{"description":"A string or a number.","type":["string","number"]},"anything":{"description":"Anything."},"positiveOrText":{"description":"A positive integer or text.","anyOf":[{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},{"type":"string"}]},"fiveOrText":{"description":"Five or text.","anyOf":[{"type":"number","const":5},{"type":"string"}]}},"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false}`,
  prevalidation_objects:
    '{"type":"object","properties":{"target":{"oneOf":[{"type":"object","properties":{"type":{"type":"string","const":"path","description":"Address the note by vault path."},"path":{"type":"string","description":"Vault-relative path."}},"required":["type","path"]},{"type":"object","properties":{"type":{"type":"string","const":"periodic","description":"Address a periodic note."},"period":{"type":"string","enum":["daily","weekly"],"description":"Period."}},"required":["type","period"]}],"description":"Which note."},"section":{"description":"Section.","type":"object","properties":{"heading":{"type":"string","description":"Heading."}},"required":["heading"]},"patchOptions":{"description":"Patch options.","type":"object","properties":{"mode":{"default":"append","description":"Where to write.","type":"string","enum":["append","prepend"]},"createIfMissing":{"default":false,"description":"Create the note if absent.","type":"boolean"}}},"frame":{"description":"Frame.","type":"object","properties":{"box":{"type":"object","properties":{"width":{"type":"number","description":"Width."}},"required":["width"],"description":"Box."}},"required":["box"]},"labels":{"description":"Labels.","type":"object","propertyNames":{"type":"string"},"additionalProperties":{"type":"string"}},"items":{"description":"Items.","type":"array","items":{"type":"object","properties":{"name":{"type":"string","description":"Name."}},"required":["name"]}},"spec":{"description":"A spec string or object.","anyOf":[{"type":"string"},{"type":"object","properties":{"k":{"type":"string","description":"K."}},"required":["k"]}]},"tags":{"description":"Tags.","type":"array","items":{"type":"string"}},"note":{"description":"Free-text note.","type":"string"}},"required":["target"],"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false}',
  prevalidation_underscore_alias:
    '{"type":"object","properties":{"query":{"type":"string","description":"Search query."}},"required":["query"],"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false}',
  prevalidation_union:
    '{"type":"object","$schema":"https://json-schema.org/draft/2020-12/schema","oneOf":[{"type":"object","properties":{"mode":{"type":"string","const":"byId","description":"By ID."},"recordId":{"type":"string","description":"Record ID."}},"required":["mode","recordId"],"additionalProperties":false},{"type":"object","properties":{"mode":{"type":"string","const":"byName","description":"By name."},"fullName":{"type":"string","description":"Name."}},"required":["mode","fullName"],"additionalProperties":false}]}',
};

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
  // #563 — a key the drop discarded reaches the alias stage on a retry
  // -----------------------------------------------------------------------

  describe('underscore keys the alias stage resolves (#563)', () => {
    it('fires a declared underscore-prefixed alias under the default config', async () => {
      const result = await call(underscoreAliased, { _q: 'x' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x' });
      expect(adds('mcp.input.aliased')).toEqual([
        {
          'mcp.tool.name': 'prevalidation_underscore_alias',
          'mcp.input.target': 'query',
          'mcp.input.alias_kind': 'declared',
        },
      ]);
      expect(adds('mcp.input.ignored_key')).toEqual([]);
    });

    it('resolves the declared underscore alias the same way with the drop stage off', async () => {
      const result = await call(underscoreAliased, { _q: 'x' }, { ignoreKeys: false });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x' });
    });

    it('rewrites an underscore-prefixed case-style variant of a declared key', async () => {
      const result = await call(search, { _query: 'x' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x' });
      expect(adds('mcp.input.aliased')).toEqual([
        {
          'mcp.tool.name': 'prevalidation_search',
          'mcp.input.target': 'query',
          'mcp.input.alias_kind': 'case_style',
        },
      ]);
      expect(adds('mcp.input.ignored_key')).toEqual([]);
    });

    it.each([
      ['a value the target accepts', 5],
      ['a value the target refuses', '12345'],
    ])(
      'keeps dropping an underscore spelling the call validates without, carrying %s',
      async (_label, value) => {
        // The call validates with the key dropped, so the alias-first retry
        // never runs — whatever the value would have done at the target
        // (#563, class i).
        const result = await call(search, { query: 'abc', _max_results: value });

        expect(result.isError).toBeUndefined();
        expect(seen).toEqual({ query: 'abc' });
        expect(adds('mcp.input.ignored_key')).toEqual([
          { 'mcp.tool.name': 'prevalidation_search', 'mcp.input.ignore_rule': 'underscore_prefix' },
        ]);
        expect(adds('mcp.input.aliased')).toEqual([]);
      },
    );

    it("rewrites against the selected union variant's keys", async () => {
      const result = await call(unionRoot, { mode: 'byId', _record_id: 'r1' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ mode: 'byId', recordId: 'r1' });
    });

    it("still drops an underscore key that folds onto another variant's key", async () => {
      const result = await call(unionRoot, { mode: 'byId', recordId: 'r1', _full_name: 'x' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ mode: 'byId', recordId: 'r1' });
      expect(adds('mcp.input.ignored_key')).toEqual([
        { 'mcp.tool.name': 'prevalidation_union', 'mcp.input.ignore_rule': 'underscore_prefix' },
      ]);
    });

    it('still drops an underscore key that folds onto no declared key', async () => {
      const result = await call(search, { query: 'x', _search: 'y' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x' });
      expect(adds('mcp.input.ignored_key')).toEqual([
        { 'mcp.tool.name': 'prevalidation_search', 'mcp.input.ignore_rule': 'underscore_prefix' },
      ]);
      expect(adds('mcp.input.aliased')).toEqual([]);
    });

    it('still drops an underscore key whose target is already present, as before', async () => {
      // The call validates with `_query` dropped, so no retry runs — and the
      // alias stage would decline a rewrite onto a key the caller also sent.
      const result = await call(search, { query: 'x', _query: 'y' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x' });
    });

    it('never case-folds an ignore-listed client artifact onto a declared key', async () => {
      const result = await call(metaField, { query: 'x', _meta: { progressToken: 1 } });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x' });
      expect(adds('mcp.input.ignored_key')).toEqual([
        { 'mcp.tool.name': 'prevalidation_meta_field', 'mcp.input.ignore_rule': '_meta' },
      ]);
      expect(adds('mcp.input.aliased')).toEqual([]);
    });

    it('never drops or rewrites a declared key spelled like an underscore alias', async () => {
      const result = await call(underscoreKeyed, { _q: 'x' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ _q: 'x' });
      expect(adds('mcp.input.aliased')).toEqual([]);
      expect(adds('mcp.input.ignored_key')).toEqual([]);
    });

    it.each([
      ['a string', 'c1'],
      ['an integer', 5],
    ])(
      'keeps dropping an ignore-listed key a declared alias names when the call validates without it (%s)',
      async (_label, value) => {
        // #563, class ii: the drop runs first, so the alias only fires on a
        // call that fails without it.
        const result = await call(ignoreListedAlias, { query: 'x', toolCallId: value });

        expect(result.isError).toBeUndefined();
        expect(seen).toEqual({ query: 'x' });
        expect(adds('mcp.input.ignored_key')).toEqual([
          {
            'mcp.tool.name': 'prevalidation_ignore_listed_alias',
            'mcp.input.ignore_rule': 'toolCallId',
          },
        ]);
        expect(adds('mcp.input.aliased')).toEqual([]);
      },
    );

    it('fires a declared alias for an ignore-listed key when the call fails without it', async () => {
      const result = await call(requiredCallId, { toolCallId: 'c1' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ callId: 'c1' });
      expect(adds('mcp.input.aliased')).toEqual([
        {
          'mcp.tool.name': 'prevalidation_required_call_id',
          'mcp.input.target': 'callId',
          'mcp.input.alias_kind': 'declared',
        },
      ]);
      expect(adds('mcp.input.ignored_key')).toEqual([]);
    });

    it('drops a declared underscore alias beside a case variant of its target, and folds the variant', async () => {
      // #563, class iii: the first order drops `_q` and folds `QUERY` onto
      // `query`, which validates — so the alias-first order never runs.
      const result = await call(underscoreAliased, { _q: 'x', QUERY: 'y' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'y' });
      expect(adds('mcp.input.ignored_key')).toEqual([
        {
          'mcp.tool.name': 'prevalidation_underscore_alias',
          'mcp.input.ignore_rule': 'underscore_prefix',
        },
      ]);
      expect(adds('mcp.input.aliased')).toEqual([
        {
          'mcp.tool.name': 'prevalidation_underscore_alias',
          'mcp.input.target': 'query',
          'mcp.input.alias_kind': 'case_style',
        },
      ]);
    });

    it('resolves both reproduction calls to { query: "x" }, counting the rewrite and no drop', () => {
      const declared = tool('declared_alias', {
        description: 'Probe.',
        input: z.object({ query: z.string().describe('Query.') }),
        inputAliases: { _q: 'query' },
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: () => ({ ok: true }),
      });

      expect(parseToolArguments(declared, { _q: 'x' })).toEqual({ query: 'x' });
      expect(parseToolArguments(declared, { _q: 'x' }, { input: { ignoreKeys: false } })).toEqual({
        query: 'x',
      });

      const rewrite = {
        'mcp.tool.name': 'declared_alias',
        'mcp.input.target': 'query',
        'mcp.input.alias_kind': 'declared',
      };
      expect(adds('mcp.input.aliased')).toEqual([rewrite, rewrite]);
      expect(adds('mcp.input.ignored_key')).toEqual([]);
      // The drop-first attempt the default config discarded leaves no log line.
      expect(debugLines('dropped client-added argument key')).toEqual([]);
      expect(debugLines("rewrote argument key '_q' to 'query'")).toHaveLength(2);
    });

    it('counts only the retry the handler receives, including the keys it still drops', async () => {
      const result = await call(search, { _query: 'x', _search: 'y', _meta: {} });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x' });
      expect(adds('mcp.input.aliased')).toEqual([
        {
          'mcp.tool.name': 'prevalidation_search',
          'mcp.input.target': 'query',
          'mcp.input.alias_kind': 'case_style',
        },
      ]);
      expect(adds('mcp.input.ignored_key')).toEqual([
        { 'mcp.tool.name': 'prevalidation_search', 'mcp.input.ignore_rule': 'underscore_prefix' },
        { 'mcp.tool.name': 'prevalidation_search', 'mcp.input.ignore_rule': '_meta' },
      ]);
      expect(debugLines('dropped client-added argument key').join('\n')).not.toContain("'_query'");
    });

    it('never case-folds an ignore-listed client artifact in the alias-first retry either', async () => {
      // The retry rewrites `_query`; folding `_meta` onto the declared string
      // `meta` there would fail the call the retry exists to rescue.
      const result = await call(metaField, { _meta: { progressToken: 1 }, _query: 'x' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x' });
      expect(adds('mcp.input.aliased')).toEqual([
        {
          'mcp.tool.name': 'prevalidation_meta_field',
          'mcp.input.target': 'query',
          'mcp.input.alias_kind': 'case_style',
        },
      ]);
      expect(adds('mcp.input.ignored_key')).toEqual([
        { 'mcp.tool.name': 'prevalidation_meta_field', 'mcp.input.ignore_rule': '_meta' },
      ]);
    });

    it('keeps the retry when the repair is what validates it', async () => {
      const result = await call(underscoreAliased, { _q: 5 });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: '5' });
      expect(adds('mcp.input.aliased')).toHaveLength(1);
      expect(adds('mcp.input.coerced')).toEqual([
        {
          'mcp.tool.name': 'prevalidation_underscore_alias',
          'mcp.input.coercion': 'integer_as_string',
        },
      ]);
      expect(adds('mcp.input.ignored_key')).toEqual([]);
    });

    it('rejects a call neither order validates as the alias-first retry saw it', async () => {
      const result = await expectOriginalRejection(underscoreAliased, { _q: true });

      expect(envelope(result).message).toBe(
        'Input validation error: Invalid arguments for tool prevalidation_underscore_alias: ' +
          'query: Invalid input: expected string, received boolean',
      );
      expect(envelope(result).data?.input).toEqual({
        aliased: [{ alias: '_q', target: 'query' }],
        ignored: [],
      });
      expect(envelope(result).data?.recovery?.hint).toBe(
        'Send query as a string, not a boolean. Validated _q as query.',
      );
      // Telemetry follows the attempt the rejection reports.
      expect(adds('mcp.input.ignored_key')).toEqual([]);
      expect(adds('mcp.input.aliased')).toHaveLength(2);
      expect(debugLines('dropped client-added argument key')).toEqual([]);
    });

    it('keeps the drop-first rejection when the alias-first order changes nothing', async () => {
      const result = await expectOriginalRejection(search, { _search: 'x' });

      expect(envelope(result).data?.input).toEqual({ aliased: [], ignored: ['_search'] });
      expect(envelope(result).data?.recovery?.hint).toBe(
        'Provide query. Dropped undeclared key _search.',
      );
    });

    it("reports a declared underscore alias as validated, with its value's own failure", async () => {
      const result = await expectOriginalRejection(underscoreFloor, { _q: 'ab' });

      expect(envelope(result).message).toBe(
        'Input validation error: Invalid arguments for tool prevalidation_underscore_floor: ' +
          'query: Too small: expected string to have >=3 characters',
      );
      expect(envelope(result).data?.issues).toEqual([
        expect.objectContaining({ code: 'too_small', path: ['query'] }),
      ]);
      expect(envelope(result).data?.input).toEqual({
        aliased: [{ alias: '_q', target: 'query' }],
        ignored: [],
      });
      expect(envelope(result).data?.recovery?.hint).toBe(
        'query: Too small: expected string to have >=3 characters. Validated _q as query.',
      );
      expect(text(result)).toBe(
        'Error: Input validation error: Invalid arguments for tool prevalidation_underscore_floor: ' +
          'query: Too small: expected string to have >=3 characters\n\n' +
          'Recovery: query: Too small: expected string to have >=3 characters. ' +
          'Validated _q as query.\n\n' +
          '(reason invalid_arguments)',
      );
      // Telemetry follows the attempt the rejection reports: the rewrite, no drop.
      expect(adds('mcp.input.ignored_key')).toEqual([]);
      expect(adds('mcp.input.aliased')).toEqual(
        Array.from({ length: 2 }, () => ({
          'mcp.tool.name': 'prevalidation_underscore_floor',
          'mcp.input.target': 'query',
          'mcp.input.alias_kind': 'declared',
        })),
      );
    });

    it('still reports an underscore key the alias-first retry cannot resolve beside one it did', async () => {
      const result = await expectOriginalRejection(underscoreFloor, { _q: 'ab', _page: 2 });

      expect(envelope(result).data?.input).toEqual({
        aliased: [{ alias: '_q', target: 'query' }],
        ignored: ['_page'],
      });
      expect(envelope(result).data?.recovery?.hint).toBe(
        'query: Too small: expected string to have >=3 characters. ' +
          'Validated _q as query. Dropped undeclared key _page.',
      );
    });

    it('reports an undeclared underscore case-style variant under its target when both orders fail', async () => {
      const result = await expectOriginalRejection(minTarget, { _target_query: 'ab' });

      expect(envelope(result).data?.input).toEqual({
        aliased: [{ alias: '_target_query', target: 'targetQuery' }],
        ignored: [],
      });
      expect(envelope(result).data?.recovery?.hint).toBe(
        'targetQuery: Too small: expected string to have >=3 characters. ' +
          'Validated _target_query as targetQuery.',
      );
    });

    it('parses a second time only when the alias-first order changes the arguments', async () => {
      const unchanged = vi.spyOn(search.input, 'safeParse');
      const changed = vi.spyOn(underscoreAliased.input, 'safeParse');
      try {
        // `_search` folds onto no declared key: both orders drop it.
        await call(search, { _search: 'x' });
        // `_q` is a declared alias: the second order rewrites it.
        await call(underscoreAliased, { _q: true });

        expect(unchanged).toHaveBeenCalledTimes(1);
        expect(changed).toHaveBeenCalledTimes(2);
      } finally {
        unchanged.mockRestore();
        changed.mockRestore();
      }
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
  // #479 — a stringified object
  // -----------------------------------------------------------------------

  describe('stringified-object repair (#479)', () => {
    describe('calls the first parse accepts — unchanged', () => {
      it('keeps a {-leading string at a string field', async () => {
        const result = await call(objecty, {
          target: { type: 'path', path: 'a.md' },
          note: '{"a":1}',
        });

        expect(result.isError).toBeUndefined();
        expect(seen).toEqual({ target: { type: 'path', path: 'a.md' }, note: '{"a":1}' });
      });

      it('keeps a {-leading string the string branch of a string | object field accepts', async () => {
        const result = await call(objecty, {
          target: { type: 'path', path: 'a.md' },
          spec: '{"k":"v"}',
        });

        expect(result.isError).toBeUndefined();
        expect(seen?.spec).toBe('{"k":"v"}');
      });

      it('keeps an object sent as an object', async () => {
        const result = await call(objecty, {
          target: { type: 'periodic', period: 'daily' },
          section: { heading: 'H' },
        });

        expect(result.isError).toBeUndefined();
        expect(seen).toEqual({
          target: { type: 'periodic', period: 'daily' },
          section: { heading: 'H' },
        });
      });
    });

    it('reaches the handler as the object, within the variant its discriminator selects', async () => {
      const path = await call(objecty, { target: STRINGIFIED_TARGET });

      expect(path.isError).toBeUndefined();
      expect(seen).toEqual({ target: { type: 'path', path: 'Notes/a.md' } });

      const periodic = await call(objecty, { target: ' {"type":"periodic","period":"weekly"} ' });

      expect(periodic.isError).toBeUndefined();
      expect(seen).toEqual({ target: { type: 'periodic', period: 'weekly' } });
    });

    it('repairs a record, an object array element, and an optional object with defaults', async () => {
      const result = await call(objecty, {
        target: STRINGIFIED_TARGET,
        labels: '{"a":"x"}',
        items: ['{"name":"first"}', { name: 'second' }],
        patchOptions: '{"mode":"prepend"}',
      });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({
        target: { type: 'path', path: 'Notes/a.md' },
        labels: { a: 'x' },
        items: [{ name: 'first' }, { name: 'second' }],
        patchOptions: { mode: 'prepend', createIfMissing: false },
      });
    });

    it('never touches a valid {-leading string beside a field it repairs', async () => {
      const result = await call(objecty, { target: STRINGIFIED_TARGET, note: '{"keep":"me"}' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({
        target: { type: 'path', path: 'Notes/a.md' },
        note: '{"keep":"me"}',
      });
    });

    it.each([
      ['a truncated string', { target: '{"type":"path","path":"a.md"' }],
      ['a Python dict repr', { target: "{'type': 'path', 'path': 'a.md'}" }],
      ['an object missing a variant field', { target: '{"type":"path"}' }],
      ['an unknown discriminator', { target: '{"type":"bogus","path":"a.md"}' }],
      [
        'a decoded object whose own field is stringified',
        { target: STRINGIFIED_TARGET, frame: '{"box":"{\\"width\\":1}"}' },
      ],
      [
        'a decoded object carrying an integer for a string field',
        { target: STRINGIFIED_TARGET, section: '{"heading":5}' },
      ],
      [
        'a stringified array of stringified objects',
        { target: STRINGIFIED_TARGET, items: '["{\\"name\\":\\"a\\"}"]' },
      ],
    ])('throws the coerce: false rejection for %s', async (_label, args) => {
      await expectOriginalRejection(objecty, args);
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    it('hands the handler a decoded object exactly as the same object sent unstringified', async () => {
      const json = '{"__proto__":{"polluted":true},"a":"x"}';
      const sectionJson = '{"__proto__":{"polluted":true},"heading":"H"}';

      const direct = await call(objecty, {
        target: JSON.parse(STRINGIFIED_TARGET),
        labels: JSON.parse(json),
        section: JSON.parse(sectionJson),
      });
      const viaDirect = seen as { labels: object; section: object };
      const decoded = await call(objecty, {
        target: STRINGIFIED_TARGET,
        labels: json,
        section: sectionJson,
      });
      const viaDecoded = seen as { labels: object; section: object };

      expect(direct.isError).toBe(decoded.isError);
      expect(viaDecoded).toEqual(viaDirect);
      for (const field of ['labels', 'section'] as const) {
        expect(Reflect.ownKeys(viaDecoded[field])).toEqual(Reflect.ownKeys(viaDirect[field]));
        expect(Object.getPrototypeOf(viaDecoded[field])).toBe(
          Object.getPrototypeOf(viaDirect[field]),
        );
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('counts the repair as stringified_object with one debug log', async () => {
      await call(objecty, { target: STRINGIFIED_TARGET });

      expect(adds('mcp.input.coerced')).toEqual([
        { 'mcp.tool.name': 'prevalidation_objects', 'mcp.input.coercion': 'stringified_object' },
      ]);
      expect(debugLines('arguments validated after repairing')).toEqual([
        "Tool 'prevalidation_objects': arguments validated after repairing a stringified object.",
      ]);
    });

    it('turns off under coerce: false', async () => {
      const result = await call(objecty, { target: STRINGIFIED_TARGET }, { coerce: false });

      expect(envelope(result).message).toBe(
        'Input validation error: Invalid arguments for tool prevalidation_objects: ' +
          'target: Invalid input: expected object, received string',
      );
      expect(adds('mcp.input.coerced')).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // #487 — an integer sent for a string
  // -----------------------------------------------------------------------

  describe('integer-for-string repair (#487)', () => {
    describe('calls the first parse accepts — unchanged', () => {
      it('keeps a number at a string | number field', async () => {
        const result = await call(numericIds, { either: 5 });

        expect(result.isError).toBeUndefined();
        expect(seen).toEqual({ either: 5 });
      });

      it('keeps -0 at a string | number field', async () => {
        const result = await call(numericIds, { either: -0 });

        expect(result.isError).toBeUndefined();
        expect(Object.is(seen?.either, -0)).toBe(true);
      });

      it('keeps a number at a z.unknown() field', async () => {
        const result = await call(numericIds, { anything: 8654467 });

        expect(result.isError).toBeUndefined();
        expect(seen).toEqual({ anything: 8654467 });
      });

      it('keeps a string sent as a string', async () => {
        const result = await call(numericIds, { stationId: '8654467', pmids: ['12345678'] });

        expect(result.isError).toBeUndefined();
        expect(seen).toEqual({ stationId: '8654467', pmids: ['12345678'] });
      });
    });

    it('sends a bare integer on as its decimal string', async () => {
      const result = await call(numericIds, { stationId: 8654467 });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ stationId: '8654467' });
    });

    it('repairs only the elements that arrived as integers', async () => {
      const result = await call(numericIds, { pmids: [12345678, '2345'] });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ pmids: ['12345678', '2345'] });
    });

    it('repairs at a nested field, a list element field, and a record value', async () => {
      const result = await call(numericIds, {
        filter: { id: 42 },
        items: [{ id: 'a' }, { id: 7 }],
        labels: { a: 'x', b: 9 },
      });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({
        filter: { id: '42' },
        items: [{ id: 'a' }, { id: '7' }],
        labels: { a: 'x', b: '9' },
      });
    });

    it("repairs a field of a discriminated-union root's selected variant", async () => {
      const result = await call(unionRoot, { mode: 'byId', recordId: 12345 });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ mode: 'byId', recordId: '12345' });
    });

    it.each([
      ['a one-or-many string | string[] field', { oneOrMany: 123 }, { oneOrMany: '123' }],
      ['a string enum', { days: 7 }, { days: '7' }],
      ['a blank-sentinel union', { zip: 98101 }, { zip: '98101' }],
      [
        'the maximum safe integer',
        { stationId: Number.MAX_SAFE_INTEGER },
        { stationId: '9007199254740991' },
      ],
      ['a negative integer', { stationId: -5 }, { stationId: '-5' }],
    ])('repairs a bare integer at %s', async (_label, args, expected) => {
      const result = await call(numericIds, args);

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual(expected);
    });

    it.each([
      ['a number that failed a positive-integer branch', { positiveOrText: -1 }],
      ['a number that failed a literal branch', { fiveOrText: 6 }],
      ['a fractional number', { stationId: 1.5 }],
      ['an integer past the safe range', { stationId: 2 ** 53 }],
      ['an exponent-sized number', { stationId: 1e21 }],
      ['negative zero', { stationId: -0 }],
      ['a repaired string an ISO date refuses', { date: 20260922 }],
      ['a repaired string a pattern refuses', { recall: 2001 }],
      ['an integer inside a value another repair produced', { pmids: '[12345678]' }],
      ['an integer beside an unrelated invalid field', { stationId: 5, days: 'never' }],
    ])('throws the coerce: false rejection for %s', async (_label, args) => {
      await expectOriginalRejection(numericIds, args);
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    it('repairs after the alias stage rewrites the key', async () => {
      const result = await call(numericIds, { 'station-id': 8654467 });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ stationId: '8654467' });
    });

    it('counts the repair as integer_as_string with one debug log', async () => {
      await call(numericIds, { stationId: 8654467, pmids: [1, 2] });

      expect(adds('mcp.input.coerced')).toEqual([
        { 'mcp.tool.name': 'prevalidation_numeric_ids', 'mcp.input.coercion': 'integer_as_string' },
      ]);
      expect(debugLines('arguments validated after repairing')).toEqual([
        "Tool 'prevalidation_numeric_ids': arguments validated after repairing an integer sent for a string.",
      ]);
    });

    it('turns off under coerce: false', async () => {
      const result = await call(numericIds, { stationId: 8654467 }, { coerce: false });

      expect(envelope(result).data?.recovery?.hint).toBe(
        'Send stationId as a string, not a number.',
      );
      expect(adds('mcp.input.coerced')).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // #479 + #487 — several repair kinds on one call
  // -----------------------------------------------------------------------

  describe('several repair kinds on one call (#479, #487)', () => {
    it('adds one increment per kind and writes one debug log naming every kind', async () => {
      const result = await call(objecty, {
        target: STRINGIFIED_TARGET,
        tags: '["a"]',
        items: [{ name: 5 }],
      });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({
        target: { type: 'path', path: 'Notes/a.md' },
        tags: ['a'],
        items: [{ name: '5' }],
      });
      expect(adds('mcp.input.coerced')).toEqual([
        { 'mcp.tool.name': 'prevalidation_objects', 'mcp.input.coercion': 'stringified_array' },
        { 'mcp.tool.name': 'prevalidation_objects', 'mcp.input.coercion': 'stringified_object' },
        { 'mcp.tool.name': 'prevalidation_objects', 'mcp.input.coercion': 'integer_as_string' },
      ]);
      expect(debugLines('arguments validated after repairing')).toEqual([
        "Tool 'prevalidation_objects': arguments validated after repairing a stringified array, " +
          'a stringified object and an integer sent for a string.',
      ]);
      const log = mockLogger.debug.mock.calls.find(([message]) =>
        String(message).includes('arguments validated after repairing'),
      );
      expect(log?.[1]).toMatchObject({
        extra: {
          toolName: 'prevalidation_objects',
          coercions: ['stringified_array', 'stringified_object', 'integer_as_string'],
        },
      });
    });

    it('counts a repeated kind once per call', async () => {
      await call(objecty, { target: STRINGIFIED_TARGET, section: '{"heading":"H"}' });

      expect(adds('mcp.input.coerced')).toEqual([
        { 'mcp.tool.name': 'prevalidation_objects', 'mcp.input.coercion': 'stringified_object' },
      ]);
    });

    it('turns every kind off under coerce: false', async () => {
      const result = await call(
        objecty,
        { target: STRINGIFIED_TARGET, tags: '["a"]', items: [{ name: 5 }] },
        { coerce: false },
      );

      expect(result.isError).toBe(true);
      expect(adds('mcp.input.coerced')).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // #468 — what the pre-parse stages changed, on a rejection
  // -----------------------------------------------------------------------

  describe('reported on an argument rejection (#468)', () => {
    it('names a declared alias the rejection validated under its target', async () => {
      const result = await call(minTarget, { query: 'ab' });

      expect(envelope(result).data?.input).toEqual({
        aliased: [{ alias: 'query', target: 'targetQuery' }],
        ignored: [],
      });
      expect(envelope(result).data?.recovery?.hint).toBe(
        'targetQuery: Too small: expected string to have >=3 characters. ' +
          'Validated query as targetQuery.',
      );
      // #493 drops a restatement-only Recovery line; this one carries a
      // framework sentence, so it reaches the text surface.
      expect(text(result)).toBe(
        'Error: Input validation error: Invalid arguments for tool prevalidation_min_target: ' +
          'targetQuery: Too small: expected string to have >=3 characters\n\n' +
          'Recovery: targetQuery: Too small: expected string to have >=3 characters. ' +
          'Validated query as targetQuery.\n\n' +
          '(reason invalid_arguments)',
      );
    });

    it('names a case-style rewrite', async () => {
      const result = await call(minTarget, { targetQuery: 'abc', max_results: 500 });

      expect(envelope(result).data?.input).toEqual({
        aliased: [{ alias: 'max_results', target: 'maxResults' }],
        ignored: [],
      });
      expect(envelope(result).data?.recovery?.hint).toBe(
        'maxResults: Too big: expected number to be <=100. Validated max_results as maxResults.',
      );
    });

    it('names an undeclared underscore key the drop stage discarded', async () => {
      const result = await call(search, { _search: 'x' });

      expect(envelope(result).data?.input).toEqual({ aliased: [], ignored: ['_search'] });
      expect(envelope(result).data?.recovery?.hint).toBe(
        'Provide query. Dropped undeclared key _search.',
      );
      expect(text(result)).toContain(
        '\n\nRecovery: Provide query. Dropped undeclared key _search.',
      );
    });

    it('lists every rewrite and every drop in argument order, keys only', async () => {
      const result = await call(minTarget, {
        _first: 'secret-1',
        max_results: 500,
        query: 'ab',
        _second: 'secret-2',
      });

      expect(envelope(result).data?.input).toEqual({
        aliased: [
          { alias: 'max_results', target: 'maxResults' },
          { alias: 'query', target: 'targetQuery' },
        ],
        ignored: ['_first', '_second'],
      });
      expect(envelope(result).data?.recovery?.hint).toBe(
        'targetQuery: Too small: expected string to have >=3 characters. ' +
          'maxResults: Too big: expected number to be <=100. ' +
          'Validated max_results as maxResults and query as targetQuery. ' +
          'Dropped undeclared keys _first and _second.',
      );
      expect(JSON.stringify(result)).not.toContain('secret-');
    });

    it.each([
      [
        'a built-in ignore-list key',
        { query: true, _meta: {}, toolCallId: 'c1', tool_call_description: 'd' },
        undefined,
      ],
      [
        'a server-configured ignore key',
        { query: true, some_client_field: 1 },
        { ignoreKeys: ['some_client_field'] },
      ],
    ])('reports nothing for %s', async (_label, args, input) => {
      const result = await call(search, args, input);

      expect(envelope(result).data).not.toHaveProperty('input');
      expect(envelope(result).data?.recovery?.hint).toBe('Send query as a string, not a boolean.');
    });

    it('adds no data.input and no sentence when the step changed nothing', async () => {
      const result = await call(search, { query: true });

      expect(Object.keys(envelope(result).data ?? {}).sort()).toEqual([
        'issues',
        'reason',
        'recovery',
      ]);
      expect(envelope(result).data?.recovery?.hint).toBe('Send query as a string, not a boolean.');
    });

    it('says nothing about the step on a call it rescues', async () => {
      const result = await call(minTarget, { query: 'abcd', _extra: 1, max_results: 5 });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ targetQuery: 'abcd', maxResults: 5 });
      expect(JSON.stringify(result)).not.toMatch(/_extra|max_results|Validated|Dropped/);
    });

    it('reports the same way when a repair was attempted and discarded', async () => {
      const result = await expectOriginalRejection(minTarget, {
        query: 'ab',
        _x: 1,
        maxResults: '[5]',
      });

      expect(envelope(result).data?.input).toEqual({
        aliased: [{ alias: 'query', target: 'targetQuery' }],
        ignored: ['_x'],
      });
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
      ['a declared underscore alias (#563)', underscoreAliased, { _q: 'x' }],
      ['an underscore case-style variant (#563)', search, { _query: 'x' }],
      ['a repaired stringified object (#479)', objecty, { target: STRINGIFIED_TARGET }],
      ['a repaired integer (#487)', numericIds, { stationId: 8654467, pmids: [1] }],
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

    it.each([
      ['a rewrite and a drop reported (#468)', minTarget, { query: 'ab', _max: 5 }],
      ['a discarded object repair (#479)', objecty, { target: '{"type":"path"}' }],
      ['a discarded integer repair (#487)', numericIds, { recall: 2001 }],
      ['a refused number branch (#487)', numericIds, { positiveOrText: -1 }],
      ['a declared underscore alias both orders reject (#563)', underscoreFloor, { _q: 'ab' }],
    ])('publishes the production envelope for %s', async (_label, def, args) => {
      const production = await call(def, args as Record<string, unknown>);
      const helper = await runToolContract(def as AnyToolDefinition, args as never);

      expect(production.isError).toBe(true);
      expect(helper).toEqual(production);
    });

    it('carries data.input and its sentences to both client surfaces through the helper', async () => {
      const helper = await runToolContract(
        minTarget as AnyToolDefinition,
        { query: 'ab', _max: 5 } as never,
      );

      expect(envelope(helper).data?.input).toEqual({
        aliased: [{ alias: 'query', target: 'targetQuery' }],
        ignored: ['_max'],
      });
      expect(text(helper)).toContain(
        'Validated query as targetQuery. Dropped undeclared key _max.\n\n',
      );
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

    it('renders a call rescued by the object and integer repairs on both surfaces', async () => {
      const formatted = tool('prevalidation_formatted_note', {
        description: 'Formats the note it resolved.',
        input: z.object({
          target: NoteTarget.describe('Which note.'),
          station: z.string().describe('Station ID.'),
        }),
        output: z.object({
          path: z.string().describe('Resolved note path.'),
          station: z.string().describe('Station ID.'),
        }),
        handler: (input) => {
          const { target, station } = input as {
            station: string;
            target: { path?: string; period?: string };
          };
          return { path: target.path ?? `periodic/${target.period}`, station };
        },
        format: (result) => [
          {
            type: 'text',
            text: `**${(result as { path: string }).path}** at ${(result as { station: string }).station}`,
          },
        ],
      });

      const result = await call(formatted, { target: STRINGIFIED_TARGET, _station: 8654467 });

      expect(result.structuredContent).toEqual({ path: 'Notes/a.md', station: '8654467' });
      expect(result.content).toEqual([{ type: 'text', text: '**Notes/a.md** at 8654467' }]);
    });

    it('reports a rewrite and a drop on structuredContent and in the content[] text', async () => {
      const result = await call(minTarget, { query: 'ab', _max: 5 });

      expect(envelope(result).data?.input).toEqual({
        aliased: [{ alias: 'query', target: 'targetQuery' }],
        ignored: ['_max'],
      });
      expect(text(result)).toContain('query');
      expect(text(result)).toContain('targetQuery');
      expect(text(result)).toContain('_max');
      expect(text(result)).toContain(
        '\n\nRecovery: targetQuery: Too small: expected string to have >=3 characters. ' +
          'Validated query as targetQuery. Dropped undeclared key _max.\n\n',
      );
    });
  });

  // -----------------------------------------------------------------------
  // Nothing advertised moves (#468, #479, #487, #563)
  // -----------------------------------------------------------------------

  describe('tools/list', () => {
    const probes = [underscoreAliased, minTarget, objecty, numericIds, unionRoot];

    it('publishes byte-identical input schemas', async () => {
      const tools = JSON.parse(await listed(probes)) as Array<{
        inputSchema: unknown;
        name: string;
      }>;

      expect(
        Object.fromEntries(tools.map((entry) => [entry.name, JSON.stringify(entry.inputSchema)])),
      ).toEqual(PINNED_INPUT_SCHEMAS);
    });

    it('publishes the same listing under every pre-validation switch', async () => {
      const reference = await listed(probes);

      for (const input of [
        { coerce: false },
        { ignoreKeys: false as const },
        { caseStyleAliases: false },
        { ignoreKeys: ['some_client_field'], caseStyleAliases: false, coerce: false },
      ]) {
        expect(await listed(probes, input)).toBe(reference);
      }
    });

    it('publishes the same listing with or without inputAliases', async () => {
      const unaliased = tool('prevalidation_underscore_alias', {
        description: 'Declares an underscore-prefixed alias.',
        input: z.object({ query: z.string().describe('Search query.') }),
        output: ok,
        handler: record,
      });

      expect(await listed([unaliased])).toBe(await listed([underscoreAliased]));
    });
  });
});

/**
 * @fileoverview The ordered pre-validation step tool arguments pass through:
 * dropping client-added root keys (#453), rewriting key aliases (#452, #563),
 * repairing a stringified array, a stringified object, an integer sent for a
 * string, a number or boolean sent as a string, or a lone string sent for an
 * array, and deleting `null` sent for an optional field, after a failed parse
 * (#234, #479, #487, #707, #602, #616) — inside a union field's surviving branch
 * (#570), inside what a `z.preprocess` made of a value (#599), and at a
 * discriminator or literal tag no variant accepts (#714) included — and
 * reporting what the pre-parse stages changed on a rejection (#468).
 *
 * Almost every case drives the real `createToolHandler`, so what is asserted
 * is the envelope (or the handler input) a deployment produces — never a
 * stubbed `parseToolArguments`. The repair-cost cases time `parseToolArguments`
 * itself, and one case reads the repair records `repairRepresentations` returns.
 * @module tests/mcp-server/tools/utils/inputPrevalidation.test
 */

import { Client } from '@modelcontextprotocol/client';
import { type CallToolResult, InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { makeServerContext } from '../../../../helpers/server-context.js';
import { withoutRequestId } from '../../../../helpers/tool-result.js';

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
import {
  heldRepairs,
  type InputHandlingOptions,
  type Repair,
  repairRepresentations,
} from '@/mcp-server/tools/utils/inputPrevalidation.js';
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
    requestId?: string;
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
  /** The result with its own request id masked: every call gets a fresh one (#584). */
  const sansRequestId = (result: CallToolResult): unknown => {
    const requestId = envelope(result).data?.requestId;
    expect(requestId).toBeTypeOf('string');
    return JSON.parse(JSON.stringify(result).replaceAll(requestId as string, '<request-id>'));
  };

  expect(on.isError).toBe(true);
  expect(envelope(on).code).toBe(JsonRpcErrorCode.InvalidParams);
  expect(sansRequestId(on)).toEqual(sansRequestId(off));
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

const declaresListed = tool('prevalidation_declares_listed', {
  description: 'Declares keys the built-in and a server-configured ignore list name.',
  input: z.object({
    query: z.string().describe('Search query.'),
    toolCallId: z.string().optional().describe('Caller-supplied call ID.'),
    sessionId: z.string().optional().describe('Caller-supplied session ID.'),
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

const mixedLiteral = tool('prevalidation_mixed_literal', {
  description: 'Takes a literal set holding both a string and a number.',
  input: z.object({ days: z.literal(['7', 30]).describe('Window in days.') }),
  output: ok,
  handler: record,
});

const scalars = tool('prevalidation_scalars', {
  description: 'Takes numbers and booleans.',
  input: z.object({
    maxResults: z.number().optional().describe('Maximum results.'),
    freeFullText: z.boolean().optional().describe('Free full text only.'),
    rank: z.number().int().min(1).optional().describe('Rank, from 1.'),
    whole: z.int().optional().describe('A whole number.'),
    days: z.literal([1, 7, 30]).optional().describe('Window in days.'),
    grade: z.enum({ A: 1, B: 2 }).optional().describe('Grade.'),
    numberOrFlag: z.union([z.number(), z.boolean()]).optional().describe('A number or a flag.'),
    countOrNull: z.union([z.number(), z.null()]).optional().describe('A count or null.'),
    limitOrAuto: z
      .union([z.number(), z.literal('auto')])
      .optional()
      .describe('A limit, or auto.'),
    slugOrCount: z
      .union([z.string().regex(/^[a-z]+$/), z.number()])
      .optional()
      .describe('A slug or a count.'),
    namesOrCount: z
      .union([z.array(z.string()), z.number()])
      .optional()
      .describe('Names or a count.'),
    counts: z.array(z.number()).optional().describe('Counts.'),
    filter: z
      .object({ minScore: z.number().describe('Lowest score.') })
      .optional()
      .describe('Filter.'),
    rows: z
      .array(z.object({ qty: z.number().describe('Quantity.') }))
      .optional()
      .describe('Rows.'),
    weights: z.record(z.string(), z.number()).optional().describe('Weights by name.'),
  }),
  output: ok,
  handler: record,
});

const lists = tool('prevalidation_lists', {
  description: 'Takes one-or-more lists.',
  input: z.object({
    parkCode: z.array(z.string()).optional().describe('Park codes.'),
    letters: z
      .array(z.enum(['a', 'b']))
      .optional()
      .describe('Letters.'),
    years: z.array(z.number()).optional().describe('Years.'),
    capped: z.array(z.string()).max(2).optional().describe('At most two names.'),
    pair: z.tuple([z.string()]).optional().describe('A one-name tuple.'),
    namesOrCount: z
      .union([z.array(z.string()), z.number()])
      .optional()
      .describe('Names or a count.'),
    filter: z
      .object({ codes: z.array(z.string()).describe('Codes.') })
      .optional()
      .describe('Filter.'),
    groups: z.record(z.string(), z.array(z.string())).optional().describe('Codes by group.'),
    rows: z
      .array(z.object({ tags: z.array(z.string()).describe('Tags.') }))
      .optional()
      .describe('Rows.'),
  }),
  output: ok,
  handler: record,
});

const STATIONS: Record<string, number> = { Downtown: 3 };
const TAG_SETS: Record<string, string[]> = { coastal: ['beach', 'harbor'] };
const MATCH_MODES: Record<string, boolean> = { strict: true, loose: false };

/**
 * Fields whose own transform reads the string a caller sends — a station name,
 * a saved tag set, a match mode — before a pipe types the result. An unknown
 * string leaves the transform as `undefined`, so the pipe's output schema
 * rejects a value the caller never sent.
 */
const resolving = tool('prevalidation_resolving', {
  description: 'Takes a station by ID or name, tags or a saved tag set, and a match mode.',
  input: z.object({
    station: z
      .union([z.string(), z.number()])
      .transform((value): number =>
        typeof value === 'string' ? (STATIONS[value] as number) : value,
      )
      .pipe(z.number().int())
      .describe('Station ID, or a station name such as "Downtown".'),
    tags: z
      .union([z.string(), z.array(z.string())])
      .transform((value): string[] =>
        typeof value === 'string' ? (TAG_SETS[value] as string[]) : value,
      )
      .pipe(z.array(z.string()))
      .optional()
      .describe('Tags, or the name of a saved tag set such as "coastal".'),
    exact: z
      .union([z.string(), z.boolean()])
      .transform((value): boolean =>
        typeof value === 'string' ? (MATCH_MODES[value] as boolean) : value,
      )
      .pipe(z.boolean())
      .optional()
      .describe('Exact match, or a match mode such as "strict".'),
    rounded: z.number().pipe(z.number().int()).optional().describe('A whole count.'),
    limit: z.number().optional().describe('Maximum results.'),
  }),
  output: ok,
  handler: record,
});

/** A search shaped like a call that fills every unset optional with `null`. */
const nullable = tool('prevalidation_nullable', {
  description: 'Takes optional fields a client may fill with null.',
  input: z.object({
    query: z.string().describe('Search query.'),
    maxResults: z.number().int().optional().describe('Maximum results.'),
    sort: z.enum(['relevance', 'pub_date']).optional().describe('Sort order.'),
    dateRange: z
      .object({
        minDate: z.string().describe('Earliest date.'),
        maxDate: z.string().describe('Latest date.'),
      })
      .optional()
      .describe('Date range.'),
    limit: z.number().int().default(10).describe('Page size.'),
    region: z
      .union([z.literal(''), z.string().regex(/^[a-z]{2}$/)])
      .optional()
      .describe('Region code, or blank for any.'),
    before: z.string().nullable().optional().describe('Cursor, or null for the start.'),
    exactNote: z.string().exactOptional().describe('A note, omitted when unset.'),
    filter: z
      .object({
        field: z.string().describe('Field name.'),
        note: z.string().optional().describe('Filter note.'),
        scope: z
          .object({ depth: z.number().optional().describe('Depth.') })
          .optional()
          .describe('Scope.'),
      })
      .optional()
      .describe('Filter.'),
    items: z
      .array(
        z.object({
          name: z.string().describe('Name.'),
          note: z.string().optional().describe('Note.'),
        }),
      )
      .optional()
      .describe('Items.'),
    labels: z.record(z.string(), z.string()).optional().describe('Labels.'),
    ids: z.array(z.string()).optional().describe('IDs.'),
  }),
  output: ok,
  handler: record,
});

const nullableUnion = tool('prevalidation_nullable_union', {
  description: 'Looks a record up by ID or by name.',
  input: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('byId').describe('By ID.'),
      recordId: z.string().describe('Record ID.'),
      note: z.string().optional().describe('Note.'),
    }),
    z.object({
      mode: z.literal('byName').describe('By name.'),
      fullName: z.string().describe('Name.'),
      fuzzy: z.boolean().optional().describe('Match loosely.'),
    }),
  ]),
  output: ok,
  handler: record,
});

/** PMIDs against a cap: integers the repair turns into strings beside a real failure (#706). */
const cappedPmids = tool('prevalidation_capped_pmids', {
  description: 'Takes at most ten PMIDs.',
  input: z.object({
    pmids: z.array(z.string().regex(/^\d+$/).describe('PMID.')).max(10).describe('PMIDs.'),
  }),
  inputAliases: { _p: 'pmids' },
  output: ok,
  handler: record,
});

/** Fourteen PMIDs sent as integers — four past the cap. */
const FOURTEEN_PMIDS = Array.from({ length: 14 }, (_, i) => 40_000_000 + i);

const UnionItem = z.object({ name: z.string().describe('Name.') });
const OneOrManyIds = z.union([z.string(), z.array(z.string())]);

/** Union fields whose selection leaves one branch, or more than one (#570). */
const unionBranches = tool('prevalidation_union_branches', {
  description: 'Takes one-or-many, tagged, and ambiguous union fields.',
  input: z.object({
    ids: OneOrManyIds.optional().describe('One ID or several.'),
    groups: z
      .array(z.object({ ids: OneOrManyIds.describe('One ID or several.') }))
      .optional()
      .describe('Groups.'),
    nested: z
      .union([z.array(OneOrManyIds), z.string()])
      .optional()
      .describe('ID groups, or one ID.'),
    target: z
      .union([
        z.object({ kind: z.literal('a').describe('Kind.'), id: z.string().describe('ID.') }),
        z.object({ kind: z.literal('b').describe('Kind.'), id: z.number().describe('ID.') }),
      ])
      .optional()
      .describe('A tagged target.'),
    guarded: z
      .union([
        z.object({
          kind: z.literal('a').describe('Kind.'),
          id: z.string().describe('ID.'),
          n: z.number().describe('Count.'),
        }),
        z.object({ kind: z.literal('b').describe('Kind.'), id: z.number().describe('ID.') }),
      ])
      .optional()
      .describe('A tagged target with a count.'),
    shape: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('a').describe('Kind.'), id: z.string().describe('ID.') }),
        z.object({ kind: z.literal('b').describe('Kind.'), n: z.number().describe('Count.') }),
      ])
      .optional()
      .describe('A discriminated shape.'),
    items: z
      .union([z.array(UnionItem).min(1), UnionItem])
      .optional()
      .describe('One item or several.'),
    matrix: z
      .union([z.array(z.array(z.string())), z.string()])
      .optional()
      .describe('Rows of IDs, or one ID.'),
    counts: z
      .union([z.array(z.number()), z.number()])
      .optional()
      .describe('Counts, or one.'),
    flags: z
      .union([z.array(z.boolean()), z.boolean()])
      .optional()
      .describe('Flags, or one.'),
    rows: z
      .union([z.array(z.object({ tags: z.array(z.string()).describe('Tags.') })), z.string()])
      .optional()
      .describe('Tagged rows, or one ID.'),
    entries: z
      .union([
        z.array(
          z.object({
            name: z.string().describe('Name.'),
            note: z.string().optional().describe('Note.'),
          }),
        ),
        z.string(),
      ])
      .optional()
      .describe('Entries, or one ID.'),
    twoLists: z
      .union([z.array(z.string()), z.array(z.boolean())])
      .optional()
      .describe('Strings or flags.'),
    idOrName: z
      .union([
        z.object({ id: z.string().describe('ID.') }),
        z.object({ name: z.string().describe('Name.') }),
      ])
      .optional()
      .describe('By ID or by name.'),
    idOrNameStrict: z
      .union([
        z.object({ id: z.string().describe('ID.') }).strict(),
        z.object({ name: z.string().describe('Name.') }).strict(),
      ])
      .optional()
      .describe('By ID or by name, strictly.'),
    enumOrList: z
      .union([z.enum(['a', 'b']), z.array(z.string())])
      .optional()
      .describe('A letter or IDs.'),
    cappedNumbers: z
      .union([z.array(z.string()), z.array(z.number().max(5))])
      .optional()
      .describe('IDs or small numbers.'),
    fiveOrText: z
      .union([
        z.object({ v: z.literal(5).describe('Five.') }),
        z.object({ v: z.string().describe('Text.') }),
      ])
      .optional()
      .describe('Five, or text.'),
    countOrAuto: z
      .union([
        z.object({ v: z.number().describe('Count.') }),
        z.object({ v: z.literal('auto').describe('Auto.') }),
      ])
      .optional()
      .describe('A count, or auto.'),
    listOrBlank: z
      .union([
        z.object({ v: z.array(z.string()).describe('Values.') }),
        z.object({ v: z.literal('').describe('Blank.') }),
      ])
      .optional()
      .describe('Values, or blank.'),
    fivesOrTexts: z
      .union([z.array(z.literal(5)), z.array(z.string())])
      .optional()
      .describe('Fives, or texts.'),
    numericTag: z
      .union([
        z.object({ kind: z.literal(1).describe('Kind.'), id: z.string().describe('ID.') }),
        z.object({
          kind: z.literal(2).describe('Kind.'),
          n: z.number().optional().describe('Count.'),
        }),
      ])
      .optional()
      .describe('A numerically tagged target.'),
  }),
  output: ok,
  handler: record,
});

/** Wraps a lone object as a one-element list, leaving anything else as sent. */
const wrapLone = (value: unknown): unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? [value] : value;

/** Splits a comma-joined string into its trimmed parts. */
const splitComma = (value: unknown): unknown =>
  typeof value === 'string' ? value.split(',').map((part) => part.trim()) : value;

const PreprocessedItem = z
  .object({
    name: z.string().describe('Name.'),
    year: z.string().optional().describe('Year.'),
    kind: z.enum(['a', 'b']).optional().describe('Kind.'),
    tags: z.array(z.string()).optional().describe('Tags.'),
  })
  .strict();

/** Fields a `z.preprocess` reshapes before the schema that reports on them (#599). */
const preprocessed = tool('prevalidation_preprocessed', {
  description: 'Takes values a preprocess reshapes.',
  input: z.object({
    items: z
      .preprocess(wrapLone, z.array(PreprocessedItem).min(1))
      .optional()
      .describe('One item or several.'),
    groups: z
      .preprocess(
        wrapLone,
        z.array(z.object({ ids: z.preprocess(splitComma, z.array(z.string())).describe('IDs.') })),
      )
      .optional()
      .describe('One group or several.'),
    reversed: z
      .preprocess(
        (value) => (Array.isArray(value) ? [...value].reverse() : [value]),
        z.array(PreprocessedItem),
      )
      .optional()
      .describe('Items, last first.'),
  }),
  output: ok,
  handler: record,
});

/** A target tagged by a number, as a discriminated union (#714). */
const NumericTagged = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal(1).describe('Kind.'), id: z.string().describe('ID.') }),
  z.object({ kind: z.literal(2).describe('Kind.'), n: z.number().describe('Count.') }),
]);

/** A discriminator no variant takes as sent, at a field, in a list, and at the input root (#714). */
const tagField = tool('prevalidation_tag_field', {
  description: 'Takes one numerically tagged target.',
  input: z.object({ s: NumericTagged.describe('Target.') }),
  output: ok,
  handler: record,
});

const tagList = tool('prevalidation_tag_list', {
  description: 'Takes a list of numerically tagged targets.',
  input: z.object({ items: z.array(NumericTagged).describe('Targets.') }),
  output: ok,
  handler: record,
});

const tagRoot = tool('prevalidation_tag_root', {
  description: 'Takes one numerically tagged target at the root.',
  input: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal(1).describe('Kind.'), id: z.string().describe('ID.') }),
    z.object({
      kind: z.literal(2).describe('Kind.'),
      maxResults: z.number().describe('Maximum results.'),
    }),
  ]),
  output: ok,
  handler: record,
});

/** The plain-union twin: literal-tagged objects, none of which takes the tag as sent (#714). */
const plainTag = tool('prevalidation_plain_tag', {
  description: 'Takes one of two numerically tagged targets.',
  input: z.object({
    target: z
      .union([
        z.object({ kind: z.literal(1).describe('Kind.'), id: z.string().describe('ID.') }),
        z.object({
          kind: z.literal(2).describe('Kind.'),
          n: z.number().optional().describe('Count.'),
        }),
      ])
      .describe('Target.'),
  }),
  output: ok,
  handler: record,
});

/**
 * The `inputSchema` each probe advertised in `tools/list` before the rewrite
 * and repair stages learned their new cases (#468, #479, #487, #563, #707,
 * #602, #616, #714), byte for byte. Every stage acts on arguments only, so none
 * of these may move.
 */
const PINNED_INPUT_SCHEMAS: Record<string, string> = {
  prevalidation_min_target:
    '{"type":"object","properties":{"targetQuery":{"type":"string","minLength":3,"description":"Target query."},"maxResults":{"description":"Maximum results.","type":"integer","minimum":-9007199254740991,"maximum":100}},"required":["targetQuery"],"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false}',
  prevalidation_numeric_ids: String.raw`{"type":"object","properties":{"stationId":{"description":"Station ID.","type":"string"},"pmids":{"description":"PMIDs.","type":"array","items":{"type":"string","pattern":"^\\d+$","description":"PMID."}},"filter":{"description":"Filter.","type":"object","properties":{"id":{"type":"string","description":"ID."}},"required":["id"]},"items":{"description":"Items.","type":"array","items":{"type":"object","properties":{"id":{"type":"string","description":"ID."}},"required":["id"]}},"labels":{"description":"Labels.","type":"object","propertyNames":{"type":"string"},"additionalProperties":{"type":"string"}},"oneOrMany":{"description":"One ID or several.","anyOf":[{"type":"string"},{"type":"array","items":{"type":"string"}}]},"days":{"description":"Window in days.","type":"string","enum":["1","7","30"]},"zip":{"description":"ZIP code, or blank for any.","anyOf":[{"type":"string","const":""},{"type":"string","pattern":"^\\d{5}$"}]},"date":{"description":"Date.","type":"string","format":"date","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"},"recall":{"description":"Recall number.","type":"string","pattern":"^\\d{5}([a-d])?$"},"either":{"description":"A string or a number.","type":["string","number"]},"anything":{"description":"Anything."},"positiveOrText":{"description":"A positive integer or text.","anyOf":[{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},{"type":"string"}]},"fiveOrText":{"description":"Five or text.","anyOf":[{"type":"number","const":5},{"type":"string"}]}},"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false}`,
  prevalidation_objects:
    '{"type":"object","properties":{"target":{"oneOf":[{"type":"object","properties":{"type":{"type":"string","const":"path","description":"Address the note by vault path."},"path":{"type":"string","description":"Vault-relative path."}},"required":["type","path"]},{"type":"object","properties":{"type":{"type":"string","const":"periodic","description":"Address a periodic note."},"period":{"type":"string","enum":["daily","weekly"],"description":"Period."}},"required":["type","period"]}],"description":"Which note."},"section":{"description":"Section.","type":"object","properties":{"heading":{"type":"string","description":"Heading."}},"required":["heading"]},"patchOptions":{"description":"Patch options.","type":"object","properties":{"mode":{"default":"append","description":"Where to write.","type":"string","enum":["append","prepend"]},"createIfMissing":{"default":false,"description":"Create the note if absent.","type":"boolean"}}},"frame":{"description":"Frame.","type":"object","properties":{"box":{"type":"object","properties":{"width":{"type":"number","description":"Width."}},"required":["width"],"description":"Box."}},"required":["box"]},"labels":{"description":"Labels.","type":"object","propertyNames":{"type":"string"},"additionalProperties":{"type":"string"}},"items":{"description":"Items.","type":"array","items":{"type":"object","properties":{"name":{"type":"string","description":"Name."}},"required":["name"]}},"spec":{"description":"A spec string or object.","anyOf":[{"type":"string"},{"type":"object","properties":{"k":{"type":"string","description":"K."}},"required":["k"]}]},"tags":{"description":"Tags.","type":"array","items":{"type":"string"}},"note":{"description":"Free-text note.","type":"string"}},"required":["target"],"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false}',
  prevalidation_nullable:
    '{"type":"object","properties":{"query":{"type":"string","description":"Search query."},"maxResults":{"description":"Maximum results.","type":"integer","minimum":-9007199254740991,"maximum":9007199254740991},"sort":{"description":"Sort order.","type":"string","enum":["relevance","pub_date"]},"dateRange":{"description":"Date range.","type":"object","properties":{"minDate":{"type":"string","description":"Earliest date."},"maxDate":{"type":"string","description":"Latest date."}},"required":["minDate","maxDate"]},"limit":{"default":10,"description":"Page size.","type":"integer","minimum":-9007199254740991,"maximum":9007199254740991},"region":{"description":"Region code, or blank for any.","anyOf":[{"type":"string","const":""},{"type":"string","pattern":"^[a-z]{2}$"}]},"before":{"description":"Cursor, or null for the start.","type":["string","null"]},"exactNote":{"description":"A note, omitted when unset.","type":"string"},"filter":{"description":"Filter.","type":"object","properties":{"field":{"type":"string","description":"Field name."},"note":{"description":"Filter note.","type":"string"},"scope":{"description":"Scope.","type":"object","properties":{"depth":{"description":"Depth.","type":"number"}}}},"required":["field"]},"items":{"description":"Items.","type":"array","items":{"type":"object","properties":{"name":{"type":"string","description":"Name."},"note":{"description":"Note.","type":"string"}},"required":["name"]}},"labels":{"description":"Labels.","type":"object","propertyNames":{"type":"string"},"additionalProperties":{"type":"string"}},"ids":{"description":"IDs.","type":"array","items":{"type":"string"}}},"required":["query"],"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false}',
  prevalidation_nullable_union:
    '{"type":"object","$schema":"https://json-schema.org/draft/2020-12/schema","oneOf":[{"type":"object","properties":{"mode":{"type":"string","const":"byId","description":"By ID."},"recordId":{"type":"string","description":"Record ID."},"note":{"description":"Note.","type":"string"}},"required":["mode","recordId"],"additionalProperties":false},{"type":"object","properties":{"mode":{"type":"string","const":"byName","description":"By name."},"fullName":{"type":"string","description":"Name."},"fuzzy":{"description":"Match loosely.","type":"boolean"}},"required":["mode","fullName"],"additionalProperties":false}]}',
  prevalidation_lists:
    '{"type":"object","properties":{"parkCode":{"description":"Park codes.","type":"array","items":{"type":"string"}},"letters":{"description":"Letters.","type":"array","items":{"type":"string","enum":["a","b"]}},"years":{"description":"Years.","type":"array","items":{"type":"number"}},"capped":{"description":"At most two names.","maxItems":2,"type":"array","items":{"type":"string"}},"pair":{"description":"A one-name tuple.","type":"array","prefixItems":[{"type":"string"}],"items":false,"minItems":1,"maxItems":1},"namesOrCount":{"description":"Names or a count.","anyOf":[{"type":"array","items":{"type":"string"}},{"type":"number"}]},"filter":{"description":"Filter.","type":"object","properties":{"codes":{"type":"array","items":{"type":"string"},"description":"Codes."}},"required":["codes"]},"groups":{"description":"Codes by group.","type":"object","propertyNames":{"type":"string"},"additionalProperties":{"type":"array","items":{"type":"string"}}},"rows":{"description":"Rows.","type":"array","items":{"type":"object","properties":{"tags":{"type":"array","items":{"type":"string"},"description":"Tags."}},"required":["tags"]}}},"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false}',
  prevalidation_scalars:
    '{"type":"object","properties":{"maxResults":{"description":"Maximum results.","type":"number"},"freeFullText":{"description":"Free full text only.","type":"boolean"},"rank":{"description":"Rank, from 1.","type":"integer","minimum":1,"maximum":9007199254740991},"whole":{"description":"A whole number.","type":"integer","minimum":-9007199254740991,"maximum":9007199254740991},"days":{"description":"Window in days.","type":"number","enum":[1,7,30]},"grade":{"description":"Grade.","type":"number","enum":[1,2]},"numberOrFlag":{"description":"A number or a flag.","type":["number","boolean"]},"countOrNull":{"description":"A count or null.","type":["number","null"]},"limitOrAuto":{"description":"A limit, or auto.","anyOf":[{"type":"number"},{"type":"string","const":"auto"}]},"slugOrCount":{"description":"A slug or a count.","anyOf":[{"type":"string","pattern":"^[a-z]+$"},{"type":"number"}]},"namesOrCount":{"description":"Names or a count.","anyOf":[{"type":"array","items":{"type":"string"}},{"type":"number"}]},"counts":{"description":"Counts.","type":"array","items":{"type":"number"}},"filter":{"description":"Filter.","type":"object","properties":{"minScore":{"type":"number","description":"Lowest score."}},"required":["minScore"]},"rows":{"description":"Rows.","type":"array","items":{"type":"object","properties":{"qty":{"type":"number","description":"Quantity."}},"required":["qty"]}},"weights":{"description":"Weights by name.","type":"object","propertyNames":{"type":"string"},"additionalProperties":{"type":"number"}}},"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false}',
  prevalidation_underscore_alias:
    '{"type":"object","properties":{"query":{"type":"string","description":"Search query."}},"required":["query"],"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false}',
  prevalidation_tag_field:
    '{"type":"object","properties":{"s":{"oneOf":[{"type":"object","properties":{"kind":{"type":"number","const":1,"description":"Kind."},"id":{"type":"string","description":"ID."}},"required":["kind","id"]},{"type":"object","properties":{"kind":{"type":"number","const":2,"description":"Kind."},"n":{"type":"number","description":"Count."}},"required":["kind","n"]}],"description":"Target."}},"required":["s"],"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false}',
  prevalidation_tag_list:
    '{"type":"object","properties":{"items":{"type":"array","items":{"oneOf":[{"type":"object","properties":{"kind":{"type":"number","const":1,"description":"Kind."},"id":{"type":"string","description":"ID."}},"required":["kind","id"]},{"type":"object","properties":{"kind":{"type":"number","const":2,"description":"Kind."},"n":{"type":"number","description":"Count."}},"required":["kind","n"]}]},"description":"Targets."}},"required":["items"],"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false}',
  prevalidation_tag_root:
    '{"type":"object","$schema":"https://json-schema.org/draft/2020-12/schema","oneOf":[{"type":"object","properties":{"kind":{"type":"number","const":1,"description":"Kind."},"id":{"type":"string","description":"ID."}},"required":["kind","id"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"number","const":2,"description":"Kind."},"maxResults":{"type":"number","description":"Maximum results."}},"required":["kind","maxResults"],"additionalProperties":false}]}',
  prevalidation_plain_tag:
    '{"type":"object","properties":{"target":{"anyOf":[{"type":"object","properties":{"kind":{"type":"number","const":1,"description":"Kind."},"id":{"type":"string","description":"ID."}},"required":["kind","id"]},{"type":"object","properties":{"kind":{"type":"number","const":2,"description":"Kind."},"n":{"description":"Count.","type":"number"}},"required":["kind"]}],"description":"Target."}},"required":["target"],"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false}',
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

    it('never drops a declared key the built-in or a server-configured ignore list names', async () => {
      const result = await call(
        declaresListed,
        { query: 'x', toolCallId: 'c1', sessionId: 's1' },
        { ignoreKeys: ['sessionId'] },
      );

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x', toolCallId: 'c1', sessionId: 's1' });
      expect(adds('mcp.input.ignored_key')).toEqual([]);
    });

    it.each([
      ['the drop stage', '{"__proto__": {"query": "smuggled"}}'],
      ['the alias-first retry', '{"__proto__": {"query": "smuggled"}, "_max_results": 5}'],
    ])('never lets an own __proto__ key re-prototype the copy %s makes', async (_label, raw) => {
      // JSON.parse creates `__proto__` as an own data property. A copy that
      // assigned it rather than defining it would hand the parse an object
      // inheriting `query`, which Zod reads — a value the caller never sent.
      const result = await call(search, JSON.parse(raw));

      expect(seen).toBeUndefined();
      expect(envelope(result).data?.recovery?.hint).toMatch(/^Provide query\. /);
      expect(envelope(result).data?.input).toMatchObject({ ignored: ['__proto__'] });
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
      // The hint names the collision, not an unknown key (#639); nothing was rewritten.
      expect(envelope(result).data?.recovery?.hint).toBe(
        'drug_name is an alias of drug; send one of them, not both.',
      );
      expect(envelope(result).data).not.toHaveProperty('input');
    });

    it('folds two keys to one target only once, leaving the second rejected', async () => {
      const result = await call(search, { query: 'x', max_results: 5, 'Max-Results': 6 });

      expect(envelope(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(envelope(result).message).toContain('Unrecognized key: "Max-Results"');
      expect(envelope(result).data?.recovery?.hint).toBe(
        'max_results and Max-Results are aliases of maxResults; send one of them, not both. ' +
          'Validated max_results as maxResults.',
      );
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
  // #631 — a debug record naming the caller's key stays bounded
  // -----------------------------------------------------------------------

  describe('bounded debug records (#631)', () => {
    /** The one debug record whose message contains `fragment`: its message and fields. */
    function debugRecord(fragment: string): { extra: Record<string, unknown>; message: string } {
      const found = mockLogger.debug.mock.calls.filter(([message]) =>
        String(message).includes(fragment),
      );
      expect(found).toHaveLength(1);
      const [message, context] = found[0]!;
      return {
        message: String(message),
        extra: (context as { extra: Record<string, unknown> }).extra,
      };
    }

    it('cuts a 200,001-character dropped key to its first 1,024 on an accepted call, with its length', async () => {
      const key = `_${'v'.repeat(200_000)}`;

      const result = await call(search, { query: 'x', [key]: 1 });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x' });
      const { message, extra } = debugRecord('dropped client-added argument key');
      expect(message).toBe(
        `Tool 'prevalidation_search': dropped client-added argument key '${key.slice(0, 1_024)}'.`,
      );
      expect(extra).toMatchObject({
        ignoredKey: key.slice(0, 1_024),
        ignoredKeyLength: 200_001,
        ignoreRule: 'underscore_prefix',
      });
    });

    it('cuts a 200,005-character case-style alias the same way', async () => {
      const alias = `Q${'_'.repeat(200_000)}uery`;

      const result = await call(search, { [alias]: 'x' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x' });
      const { message, extra } = debugRecord('rewrote argument key');
      expect(message).toBe(
        `Tool 'prevalidation_search': rewrote argument key '${alias.slice(0, 1_024)}' to 'query'.`,
      );
      expect(extra).toMatchObject({
        alias: alias.slice(0, 1_024),
        aliasLength: 200_005,
        target: 'query',
        aliasKind: 'case_style',
      });
    });

    it('cuts the key on a rejected call’s debug record too', async () => {
      const key = `_${'v'.repeat(5_000)}`;

      const result = await call(search, { query: true, [key]: 1 });

      expect(result.isError).toBe(true);
      const { extra } = debugRecord('dropped client-added argument key');
      expect(extra).toMatchObject({ ignoredKey: key.slice(0, 1_024), ignoredKeyLength: 5_001 });
    });

    it.each([
      [
        'a dropped key',
        { query: 'x', [`_${'v'.repeat(1_023)}`]: 1 },
        'ignoredKey',
        `_${'v'.repeat(1_023)}`,
      ],
      [
        'a case-style alias',
        { [`Q${'_'.repeat(1_019)}uery`]: 'x' },
        'alias',
        `Q${'_'.repeat(1_019)}uery`,
      ],
    ])(
      'logs %s of exactly 1,024 characters whole, with no length',
      async (_label, args, field, key) => {
        await call(search, args);

        const fragment =
          field === 'alias' ? 'rewrote argument key' : 'dropped client-added argument key';
        const { message, extra } = debugRecord(fragment);
        expect(key).toHaveLength(1_024);
        expect(message).toContain(`'${key}'`);
        expect(extra[field]).toBe(key);
        expect(extra).not.toHaveProperty(`${field}Length`);
      },
    );
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
          `(reason invalid_arguments · request ${envelope(result).data?.requestId})`,
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
  // #639 — an alias sent beside its target is named as one, not as unknown
  // -----------------------------------------------------------------------

  describe('an alias sent beside its target (#639)', () => {
    const pagedInput = z.object({
      query: z.string().describe('Search query.'),
      pageSize: z.number().int().optional().describe('Results per page.'),
    });

    /** The issue's reproduction tool. */
    const paged = tool('prevalidation_paged', {
      description: 'Searches, with a page size an alias names.',
      input: pagedInput,
      inputAliases: { maxResults: 'pageSize' },
      output: ok,
      handler: record,
    });

    /** The same input with no alias declared — the reference message and issues. */
    const pagedUnaliased = tool('prevalidation_paged', {
      description: 'Searches, with no alias declared.',
      input: pagedInput,
      output: ok,
      handler: record,
    });

    const pagedTwice = tool('prevalidation_paged_twice', {
      description: 'Searches, with two aliases of one key.',
      input: pagedInput,
      inputAliases: { maxResults: 'pageSize', limit: 'pageSize' },
      output: ok,
      handler: record,
    });

    const pagedUnderscore = tool('prevalidation_paged_underscore', {
      description: 'Searches, with an underscore-prefixed alias of the query.',
      input: pagedInput,
      inputAliases: { _q: 'query' },
      output: ok,
      handler: record,
    });

    it('names a declared alias beside its target on both surfaces, message and issues unchanged', async () => {
      const args = { query: 'ferroptosis', maxResults: 1, pageSize: 1 };
      const result = await call(paged, args);
      const reference = await call(pagedUnaliased, args);
      const hint = 'maxResults is an alias of pageSize; send one of them, not both.';

      expect(envelope(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(envelope(result).message).toBe(
        'Input validation error: Invalid arguments for tool prevalidation_paged: ' +
          'Unrecognized key: "maxResults"',
      );
      expect(envelope(result).message).toBe(envelope(reference).message);
      expect(envelope(result).data?.issues).toEqual(envelope(reference).data?.issues);
      expect(envelope(result).data).not.toHaveProperty('input');
      expect(envelope(result).data?.recovery?.hint).toBe(hint);
      expect(text(result)).toBe(
        `Error: ${envelope(result).message}\n\nRecovery: ${hint}\n\n` +
          `(reason invalid_arguments · request ${envelope(result).data?.requestId})`,
      );
      // A declined alias is no rewrite: nothing counted.
      expect(adds('mcp.input.aliased')).toEqual([]);
    });

    it('names a case-style variant beside its target, unless case-style aliases are off', async () => {
      const args = { query: 'x', page_size: 1, pageSize: 1 };
      const on = await call(paged, args);
      const off = await call(paged, args, { caseStyleAliases: false });

      expect(envelope(on).data?.recovery?.hint).toBe(
        'page_size is an alias of pageSize; send one of them, not both.',
      );
      expect(envelope(off).data?.recovery?.hint).toBe(
        'Unknown key page_size. This tool accepts: query, pageSize.',
      );
    });

    it('names a second alias the first one’s rewrite made redundant, data.input unchanged', async () => {
      const result = await call(pagedTwice, { query: 'x', maxResults: 1, limit: 2 });

      expect(envelope(result).message).toContain('Unrecognized key: "limit"');
      expect(envelope(result).data?.input).toEqual({
        aliased: [{ alias: 'maxResults', target: 'pageSize' }],
        ignored: [],
      });
      expect(envelope(result).data?.recovery?.hint).toBe(
        'maxResults and limit are aliases of pageSize; send one of them, not both. ' +
          'Validated maxResults as pageSize.',
      );
    });

    it('names the aliases in argument order, whichever one the declaration order rewrote', async () => {
      const result = await call(pagedTwice, { query: 'x', limit: 2, maxResults: 1 });

      expect(envelope(result).data?.recovery?.hint).toBe(
        'limit and maxResults are aliases of pageSize; send one of them, not both. ' +
          'Validated maxResults as pageSize.',
      );
    });

    it('names two case-style variants of one target', async () => {
      const result = await call(paged, { query: 'x', page_size: 1, 'Page-Size': 2 });

      expect(envelope(result).data?.recovery?.hint).toBe(
        'page_size and Page-Size are aliases of pageSize; send one of them, not both. ' +
          'Validated page_size as pageSize.',
      );
    });

    it('asks for only one of three or more keys sent for one target', async () => {
      const result = await call(pagedTwice, { query: 'x', maxResults: 1, limit: 2, pageSize: 3 });

      expect(envelope(result).data?.recovery?.hint).toBe(
        'maxResults and limit are aliases of pageSize; send only one of them.',
      );
    });

    it('keeps the unknown-key sentence for a key that is no alias, after the alias sentence', async () => {
      const result = await call(paged, { query: 'x', maxResults: 1, pageSize: 1, limt: 5 });

      expect(envelope(result).message).toBe(
        'Input validation error: Invalid arguments for tool prevalidation_paged: ' +
          'Unrecognized keys: "maxResults", "limt"',
      );
      expect(envelope(result).data?.recovery?.hint).toBe(
        'maxResults is an alias of pageSize; send one of them, not both. ' +
          'Unknown key limt. This tool accepts: query, pageSize.',
      );
    });

    it('names each target’s collision once, in argument order', async () => {
      const result = await call(paged, { Query: 'y', query: 'x', maxResults: 1, pageSize: 2 });

      expect(envelope(result).data?.recovery?.hint).toBe(
        'Query is an alias of query; send one of them, not both. ' +
          'maxResults is an alias of pageSize; send one of them, not both.',
      );
    });

    it('names a collision against the variant a union root’s discriminator selects', async () => {
      const result = await call(unionRoot, { mode: 'byId', recordId: 'r1', record_id: 'r2' });

      expect(envelope(result).data?.recovery?.hint).toBe(
        'record_id is an alias of recordId; send one of them, not both.',
      );
    });

    it('names a declared underscore alias beside its target as an alias, never as a dropped key', async () => {
      const result = await call(pagedUnderscore, { _q: 'x', query: 'y', pageSize: 'z' });
      const hint = envelope(result).data?.recovery?.hint;

      expect(hint).toBe(
        'Send pageSize as a number, not a string. ' +
          '_q is an alias of query; send one of them, not both.',
      );
      expect(hint).not.toContain('Dropped undeclared key _q.');
      // The drop still happened, and data.input still says so.
      expect(envelope(result).data?.input).toEqual({ aliased: [], ignored: ['_q'] });
    });

    it('names an underscore case-style variant beside its target the same way', async () => {
      const result = await call(paged, { _query: 'x', query: 'y', pageSize: 'z' });

      expect(envelope(result).data?.recovery?.hint).toBe(
        'Send pageSize as a number, not a string. ' +
          '_query is an alias of query; send one of them, not both.',
      );
    });

    it('keeps the unknown-key sentence for a key matching no alias', async () => {
      const result = await call(paged, { query: 'x', maxResult: 1 });

      expect(envelope(result).data?.recovery?.hint).toBe(
        'Unknown key maxResult. This tool accepts: query, pageSize.',
      );
    });

    it('still rewrites an alias sent alone', async () => {
      const result = await call(paged, { query: 'x', maxResults: 3 });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x', pageSize: 3 });
    });

    it("still validates a declared underscore alias beside its target with the target's value (#563)", async () => {
      const result = await call(pagedUnderscore, { _q: 'x', query: 'y' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'y' });
    });

    it('gives runToolContract the same hint createToolHandler publishes', async () => {
      const args = { query: 'ferroptosis', maxResults: 1, pageSize: 1 };
      const production = await call(paged, args);
      const helper = await runToolContract(paged, args as never);

      expect(envelope(helper).data?.recovery?.hint).toBe(
        'maxResults is an alias of pageSize; send one of them, not both.',
      );
      expect(envelope(helper).data?.recovery).toEqual(envelope(production).data?.recovery);
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

    it('repairs a stringified array the caller padded with whitespace', async () => {
      const result = await call(listy, { statusFilter: ' \n["RECRUITING"] ' });

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
      // The integer `note` the repair fixed is not reported beside it (#706).
      expect(envelope(plain).data?.issues).toEqual([
        expect.objectContaining({ path: ['statusFilter'] }),
      ]);
      expect(envelope(plain).message).toBe(envelope(truncated).message);
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

    it('never adds, drops, or renames a key while repairing a value', async () => {
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

    it('repairs a stringified array inside the list a z.preprocess made of a lone object (#599)', async () => {
      const result = await call(preprocessed, { items: { name: 'abc', tags: '["a","b"]' } });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ items: [{ name: 'abc', tags: ['a', 'b'] }] });
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
      ['a decoded object whose own field is stringified', { frame: '{"box":"{\\"width\\":1}"}' }],
      ['a decoded object carrying an integer for a string field', { section: '{"heading":5}' }],
      ['a stringified array of stringified objects', { items: '["{\\"name\\":\\"a\\"}"]' }],
    ])('throws the coerce: false rejection for %s', async (_label, args) => {
      await expectOriginalRejection(objecty, { target: { type: 'path', path: 'a.md' }, ...args });
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    it.each([
      ['a decoded object whose own field is stringified', 'frame', '{"box":"{\\"width\\":1}"}'],
      ['a decoded object carrying an integer for a string field', 'section', '{"heading":5}'],
      ['a stringified array of stringified objects', 'items', '["{\\"name\\":\\"a\\"}"]'],
    ])(
      'reports %s as sent beside a target whose repair held (#706)',
      async (_label, field, sent) => {
        const result = await call(objecty, { target: STRINGIFIED_TARGET, [field]: sent });

        expect(envelope(result).message).toBe(
          'Input validation error: Invalid arguments for tool prevalidation_objects: ' +
            `${field}: Invalid input: expected ${field === 'items' ? 'array' : 'object'}, received string`,
        );
        expect(envelope(result).data?.issues).toEqual([expect.objectContaining({ path: [field] })]);
        expect(adds('mcp.input.coerced')).toEqual([]);
      },
    );

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
    ])('throws the coerce: false rejection for %s', async (_label, args) => {
      await expectOriginalRejection(numericIds, args);
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    it('throws the coerce: false rejection for a number outside a literal set that also lists a number', async () => {
      // `"7"` is in the set, but so is a number: the field takes numbers, and
      // 7 is a wrong one rather than a string sent as an integer.
      await expectOriginalRejection(mixedLiteral, { days: 7 });
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

    it('repairs an integer inside the list a z.preprocess made of a lone object (#599)', async () => {
      const result = await call(preprocessed, { items: { name: 'abc', year: 2020 } });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ items: [{ name: 'abc', year: '2020' }] });
      expect(adds('mcp.input.coerced')).toEqual([
        {
          'mcp.tool.name': 'prevalidation_preprocessed',
          'mcp.input.coercion': 'integer_as_string',
        },
      ]);
    });

    it('names the integer inside a z.preprocess output under coerce: false (#599)', async () => {
      const result = await call(
        preprocessed,
        { items: { name: 'abc', year: 2020 } },
        { coerce: false },
      );

      expect(envelope(result).data?.recovery?.hint).toBe(
        'Send items.0.year as a string, not a number.',
      );
      expect(text(result)).toContain(
        'items.0.year: Invalid input: expected string, received number',
      );
      expect(adds('mcp.input.coerced')).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // #707 — a number or boolean literal sent as a string
  // -----------------------------------------------------------------------

  describe('number- and boolean-as-string repair (#707)', () => {
    describe('calls the first parse accepts — unchanged', () => {
      it('keeps a number and a boolean sent as themselves', async () => {
        const result = await call(scalars, { maxResults: 15, freeFullText: false });

        expect(result.isError).toBeUndefined();
        expect(seen).toEqual({ maxResults: 15, freeFullText: false });
      });

      it('keeps a string the string branch of a slug | count field accepts', async () => {
        const result = await call(scalars, { slugOrCount: 'abc', limitOrAuto: 'auto' });

        expect(result.isError).toBeUndefined();
        expect(seen).toEqual({ slugOrCount: 'abc', limitOrAuto: 'auto' });
      });
    });

    it('reaches the handler as a number and a boolean', async () => {
      const result = await call(scalars, { maxResults: '15', freeFullText: 'true' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ maxResults: 15, freeFullText: true });
    });

    it.each([
      ['a decimal', { maxResults: '2.5' }, { maxResults: 2.5 }],
      ['a negative integer', { maxResults: '-3' }, { maxResults: -3 }],
      ['a padded integer', { maxResults: ' 15 ' }, { maxResults: 15 }],
      ['a padded boolean', { freeFullText: ' true ' }, { freeFullText: true }],
      ['false', { freeFullText: 'false' }, { freeFullText: false }],
      ['an integer an .int().min(1) field accepts', { rank: '3' }, { rank: 3 }],
      ['a member of a numeric literal set', { days: '7' }, { days: 7 }],
      ['a member of a numeric enum', { grade: '1' }, { grade: 1 }],
      ['a flag at a number | boolean field', { numberOrFlag: 'true' }, { numberOrFlag: true }],
      ['a number at a number | boolean field', { numberOrFlag: '15' }, { numberOrFlag: 15 }],
      ['a number at a number | null field', { countOrNull: '15' }, { countOrNull: 15 }],
      ['an element at its own path', { counts: ['15', 2] }, { counts: [15, 2] }],
      ['a nested field', { filter: { minScore: '0.5' } }, { filter: { minScore: 0.5 } }],
      [
        'a field of an object list element',
        { rows: [{ qty: 1 }, { qty: '2' }] },
        { rows: [{ qty: 1 }, { qty: 2 }] },
      ],
      ['a record value', { weights: { a: '1', b: 2 } }, { weights: { a: 1, b: 2 } }],
    ])('repairs %s', async (_label, args, expected) => {
      const result = await call(scalars, args);

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual(expected);
    });

    it("repairs a field of a discriminated-union root's selected variant", async () => {
      const ranged = tool('prevalidation_ranged', {
        description: 'Looks records up by page or by ID.',
        input: z.discriminatedUnion('mode', [
          z.object({
            mode: z.literal('page').describe('By page.'),
            page: z.number().int().describe('Page number.'),
          }),
          z.object({
            mode: z.literal('byId').describe('By ID.'),
            recordId: z.string().describe('Record ID.'),
          }),
        ]),
        output: ok,
        handler: record,
      });

      const result = await call(ranged, { mode: 'page', page: '4' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ mode: 'page', page: 4 });
    });

    it.each([
      ['a leading zero', { maxResults: '01' }],
      ['exponent notation', { maxResults: '1e3' }],
      ['negative zero', { maxResults: '-0' }],
      ['a trailing zero', { maxResults: '1.50' }],
      ['a blank string', { maxResults: ' ' }],
      ['a number with a unit', { maxResults: '15 km' }],
      ['a hex literal', { maxResults: '0x10' }],
      ['Infinity', { maxResults: 'Infinity' }],
      ['a 20-digit integer', { maxResults: '12345678901234567890' }],
      ['a capitalized boolean', { freeFullText: 'True' }],
      ['a numeric boolean', { freeFullText: '1' }],
      ['a number an .int().min(1) field refuses', { rank: '0' }],
      ['a fraction a z.int() field refuses', { whole: '2.5' }],
      ['a number outside a numeric literal set', { days: '8' }],
      ['a number at a field that also takes a string literal', { limitOrAuto: '15' }],
      ['a number at a field whose string branch has a pattern', { slugOrCount: '15' }],
      ['a number at a field that also takes a list', { namesOrCount: '15' }],
      ['a number inside a value another repair produced', { counts: '["15"]' }],
      ['a number sent for a list of numbers', { counts: '15' }],
    ])('throws the coerce: false rejection for %s', async (_label, args) => {
      await expectOriginalRejection(scalars, args);
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    it('reports only an unrelated invalid field beside a number whose repair held (#706)', async () => {
      const result = await call(scalars, { maxResults: '15', freeFullText: 'yes' });

      expect(envelope(result).data?.issues).toEqual([
        expect.objectContaining({ path: ['freeFullText'] }),
      ]);
      expect(envelope(result).data?.recovery?.hint).toBe(
        'Send freeFullText as a boolean, not a string.',
      );
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    describe('a field the author routes through a transform or pipe', () => {
      it('keeps the rejection of a string its own transform could not read', async () => {
        const on = await expectOriginalRejection(resolving, { station: '15' });

        // "15" is a station name the lookup lacks, not station 15.
        expect(text(on)).toContain('station: Invalid input: expected number, received undefined');
        expect(seen).toBeUndefined();
        await expectOriginalRejection(resolving, { station: 3, exact: 'true' });
        await expectOriginalRejection(resolving, { station: 3, rounded: '15' });
        expect(adds('mcp.input.coerced')).toEqual([]);
      });

      it('still repairs a plain number field beside it', async () => {
        const result = await call(resolving, { station: 'Downtown', limit: '5', exact: 'loose' });

        expect(result.isError).toBeUndefined();
        expect(seen).toEqual({ station: 3, limit: 5, exact: false });
      });

      describe('wherever the schema leaves a second reading of the path', () => {
        /**
         * The same leaf in three places a path resolves under more than one
         * schema: a plain union whose other option also declares the key, one
         * whose other option catches it, and an intersection. Each union's
         * other option fails only on its optional tag, so the rejection lifts
         * the first (#570).
         */
        const shapes = (leaf: z.ZodType) =>
          z.object({
            declared: z
              .union([
                z.object({ kind: z.literal('id').optional(), station: leaf }),
                z.object({ kind: z.literal('name').optional(), station: z.string() }),
              ])
              .optional()
              .describe('A station under one of two tagged forms.'),
            caught: z
              .union([
                z.object({ kind: z.literal('id').optional(), station: leaf }),
                z.object({ kind: z.literal('name').optional() }).catchall(z.string()),
              ])
              .optional()
              .describe('A station, or names under any key.'),
            joined: z
              .intersection(z.object({ station: leaf }), z.object({ note: z.string().optional() }))
              .optional()
              .describe('A station with a note.'),
          });
        const lookedUp = tool('prevalidation_station_shapes', {
          description: 'Takes a station by ID or name in three shapes.',
          input: shapes(resolving.input.shape.station),
          output: ok,
          handler: record,
        });
        const counted = tool('prevalidation_count_shapes', {
          description: 'Takes a count in three shapes.',
          input: shapes(z.number()),
          output: ok,
          handler: record,
        });

        it.each([
          ['an option that also declares the key', { declared: { kind: 'id', station: '15' } }],
          ['an option that catches the key', { caught: { kind: 'id', station: '15' } }],
          ['an intersection', { joined: { station: '15' } }],
        ])(
          'keeps the rejection of a string its transform could not read beside %s',
          async (_label, args) => {
            // "15" is a station name the lookup lacks, not station 15.
            await expectOriginalRejection(lookedUp, args);
            expect(seen).toBeUndefined();
            expect(adds('mcp.input.coerced')).toEqual([]);
          },
        );

        it.each([
          [
            'an option that also declares the key',
            { declared: { kind: 'id', station: '15' } },
            { declared: { kind: 'id', station: 15 } },
          ],
          [
            'an option that catches the key',
            { caught: { kind: 'id', station: '15' } },
            { caught: { kind: 'id', station: 15 } },
          ],
          ['an intersection', { joined: { station: '15' } }, { joined: { station: 15 } }],
        ])('still repairs a plain number field beside %s', async (_label, args, expected) => {
          const result = await call(counted, args);

          expect(result.isError).toBeUndefined();
          expect(seen).toEqual(expected);
        });
      });
    });

    it('counts each kind with one debug log naming both', async () => {
      await call(scalars, { maxResults: '15', counts: ['1', '2'], freeFullText: 'true' });

      expect(adds('mcp.input.coerced')).toEqual([
        { 'mcp.tool.name': 'prevalidation_scalars', 'mcp.input.coercion': 'string_as_number' },
        { 'mcp.tool.name': 'prevalidation_scalars', 'mcp.input.coercion': 'string_as_boolean' },
      ]);
      expect(debugLines('arguments validated after repairing')).toEqual([
        "Tool 'prevalidation_scalars': arguments validated after repairing a string sent for " +
          'a number and a string sent for a boolean.',
      ]);
    });

    it('turns off under coerce: false', async () => {
      const result = await call(
        scalars,
        { maxResults: '15', freeFullText: 'true' },
        { coerce: false },
      );

      expect(envelope(result).data?.recovery?.hint).toBe(
        'Send maxResults as a number, not a string. Send freeFullText as a boolean, not a string.',
      );
      expect(adds('mcp.input.coerced')).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // #602 — a lone string sent for an array
  // -----------------------------------------------------------------------

  describe('lone-string-for-array repair (#602)', () => {
    describe('calls the first parse accepts — unchanged', () => {
      it('keeps a list sent as a list', async () => {
        const result = await call(lists, { parkCode: ['yell'] });

        expect(result.isError).toBeUndefined();
        expect(seen).toEqual({ parkCode: ['yell'] });
      });

      it('keeps a bare string at a string | string[] field', async () => {
        const result = await call(numericIds, { oneOrMany: 'yell' });

        expect(result.isError).toBeUndefined();
        expect(seen).toEqual({ oneOrMany: 'yell' });
      });
    });

    it('reaches the handler as a one-element list', async () => {
      const result = await call(lists, { parkCode: 'yell' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ parkCode: ['yell'] });
    });

    it.each([
      ['a padded string, as sent', { parkCode: ' yell ' }, { parkCode: [' yell '] }],
      ['a string holding a tab', { parkCode: 'a\tb' }, { parkCode: ['a\tb'] }],
      [
        'a string holding a no-break space (U+00A0)',
        { parkCode: `a${String.fromCodePoint(0xa0)}b` },
        { parkCode: [`a${String.fromCodePoint(0xa0)}b`] },
      ],
      [
        'a string holding an ideographic space (U+3000)',
        { parkCode: `a${String.fromCodePoint(0x3000)}b` },
        { parkCode: [`a${String.fromCodePoint(0x3000)}b`] },
      ],
      ['a member of an enum list', { letters: 'a' }, { letters: ['a'] }],
      [
        'a list whose length check also failed on the string',
        { capped: 'yell' },
        { capped: ['yell'] },
      ],
      ['a nested field', { filter: { codes: 'FIPS:53' } }, { filter: { codes: ['FIPS:53'] } }],
      ['a record value', { groups: { west: 'yell' } }, { groups: { west: ['yell'] } }],
      [
        'a field of an object list element',
        { rows: [{ tags: ['a'] }, { tags: 'b' }] },
        { rows: [{ tags: ['a'] }, { tags: ['b'] }] },
      ],
    ])('repairs %s', async (_label, args, expected) => {
      const result = await call(lists, args);

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual(expected);
    });

    it("repairs a field of a discriminated-union root's selected variant", async () => {
      const result = await call(unionList, { mode: 'byIds', ids: 'a' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ mode: 'byIds', ids: ['a'] });
    });

    it.each([
      ['a string outside an enum list', { letters: 'c' }],
      ['a comma-joined string', { parkCode: 'yell,grca' }],
      ['a string holding a line break', { parkCode: 'a\nb' }],
      ['a string holding a carriage return', { parkCode: 'a\rb' }],
      ['a string holding a vertical tab', { parkCode: 'a\vb' }],
      ['a string holding a form feed', { parkCode: 'a\fb' }],
      ['a string holding a next line (U+0085)', { parkCode: 'a\x85b' }],
      [
        'a string holding a line separator (U+2028)',
        { parkCode: `a${String.fromCodePoint(0x2028)}b` },
      ],
      [
        'a string holding a paragraph separator (U+2029)',
        { parkCode: `a${String.fromCodePoint(0x2029)}b` },
      ],
      ['an empty string', { parkCode: '' }],
      ['a blank string', { parkCode: '   ' }],
      ['a truncated stringified array', { parkCode: '["yell"' }],
      ['a stringified object', { parkCode: '{"a":1}' }],
      ['a number string for a list of numbers', { years: '2024' }],
      ['a string for a tuple', { pair: 'yell' }],
      ['a string at a list | number field', { namesOrCount: 'yell' }],
    ])('throws the coerce: false rejection for %s', async (_label, args) => {
      await expectOriginalRejection(lists, args);
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    it('reports only an unrelated invalid field beside a list wrap that held (#706)', async () => {
      const result = await call(lists, { parkCode: 'yell', years: ['x'] });

      expect(envelope(result).data?.issues).toEqual([
        expect.objectContaining({ path: ['years', 0] }),
      ]);
      expect(envelope(result).data?.recovery?.hint).toBe('Send years.0 as a number, not a string.');
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    it('keeps the rejection of a string a field’s own transform could not read', async () => {
      // "inland" names a saved tag set the lookup lacks, not the one tag "inland".
      await expectOriginalRejection(resolving, { station: 3, tags: 'inland' });
      expect(seen).toBeUndefined();
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    it('keeps the rejection when the schema throws on the wrapped list', async () => {
      const paired = tool('prevalidation_paired', {
        description: 'Takes a list whose check reads its second element.',
        input: z.object({
          ids: z
            .array(z.string())
            .refine((ids) => (ids[1] as string).length > 0, 'Needs a second ID.')
            .describe('IDs.'),
        }),
        output: ok,
        handler: record,
      });

      await expectOriginalRejection(paired, { ids: 'a' });
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    it('counts the repair as string_as_array with one debug log', async () => {
      await call(lists, { parkCode: 'yell', letters: 'b' });

      expect(adds('mcp.input.coerced')).toEqual([
        { 'mcp.tool.name': 'prevalidation_lists', 'mcp.input.coercion': 'string_as_array' },
      ]);
      expect(debugLines('arguments validated after repairing')).toEqual([
        "Tool 'prevalidation_lists': arguments validated after repairing a string sent for an array.",
      ]);
    });

    it('turns off under coerce: false', async () => {
      const result = await call(lists, { parkCode: 'yell' }, { coerce: false });

      expect(envelope(result).data?.recovery?.hint).toBe(
        'Send parkCode as an array, not a string.',
      );
      expect(adds('mcp.input.coerced')).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // #616 — null sent for an optional field
  // -----------------------------------------------------------------------

  describe('null-for-optional repair (#616)', () => {
    describe('calls the first parse accepts — unchanged', () => {
      it('hands a .nullable() field its null', async () => {
        const result = await call(nullable, { query: 'x', before: null });

        expect(result.isError).toBeUndefined();
        expect(seen).toEqual({ query: 'x', limit: 10, before: null });
      });
    });

    it('reaches the handler exactly as the same call with the null keys omitted', async () => {
      const omitted = await call(nullable, { query: 'lipid nanoparticle', maxResults: 3 });
      const viaOmitted = seen;
      const filled = await call(nullable, {
        query: 'lipid nanoparticle',
        maxResults: 3,
        dateRange: null,
        sort: null,
      });

      expect(omitted.isError).toBeUndefined();
      expect(filled.isError).toBeUndefined();
      expect(seen).toEqual(viaOmitted);
      expect(seen).toEqual({ query: 'lipid nanoparticle', maxResults: 3, limit: 10 });
    });

    it.each([
      [
        'a defaulted field, which takes its default',
        { query: 'x', limit: null },
        { query: 'x', limit: 10 },
      ],
      ['a blank-sentinel union field', { query: 'x', region: null }, { query: 'x', limit: 10 }],
      ['an optional object, whole', { query: 'x', dateRange: null }, { query: 'x', limit: 10 }],
      [
        'an optional key of a nested optional object',
        { query: 'x', filter: { field: 'a', note: null } },
        { query: 'x', limit: 10, filter: { field: 'a' } },
      ],
      [
        'an optional object two levels down',
        { query: 'x', filter: { field: 'a', scope: null } },
        { query: 'x', limit: 10, filter: { field: 'a' } },
      ],
      [
        'an optional key three levels down',
        { query: 'x', filter: { field: 'a', scope: { depth: null } } },
        { query: 'x', limit: 10, filter: { field: 'a', scope: {} } },
      ],
      [
        'an optional key of an object list element',
        { query: 'x', items: [{ name: 'a' }, { name: 'b', note: null }] },
        { query: 'x', limit: 10, items: [{ name: 'a' }, { name: 'b' }] },
      ],
      [
        'a key the case-style alias stage rewrote',
        { query: 'x', max_results: null },
        { query: 'x', limit: 10 },
      ],
    ])('deletes null at %s', async (_label, args, expected) => {
      const result = await call(nullable, args);

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual(expected);
    });

    it("deletes null at an optional field of a discriminated-union root's selected variant", async () => {
      const result = await call(nullableUnion, { mode: 'byName', fullName: 'Ada', fuzzy: null });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ mode: 'byName', fullName: 'Ada' });
    });

    it('drops no key but the null-valued ones it deletes, and adds or renames none', async () => {
      const result = await call(nullable, {
        sort: null,
        query: 'x',
        maxResults: 3,
        filter: { field: 'a', note: null },
      });

      expect(result.isError).toBeUndefined();
      // `limit` is the schema's default; every other key is one the caller sent.
      expect(Object.keys(seen ?? {}).sort()).toEqual(['filter', 'limit', 'maxResults', 'query']);
      expect(Object.keys((seen?.filter as object | undefined) ?? {})).toEqual(['field']);
    });

    it.each([
      ['a required field', nullable, { query: null }],
      ['a record value', nullable, { query: 'x', labels: { a: null } }],
      ['an array element', nullable, { query: 'x', ids: [null] }],
      ['an .exactOptional() field', nullable, { query: 'x', exactNote: null }],
      [
        'a required key of an object list element',
        nullable,
        { query: 'x', items: [{ name: null }] },
      ],
      ['a key under an author-opened catchall', catchallRoot, { query: 'x', extra: null }],
      ['a discriminator', nullableUnion, { mode: null, recordId: 'r1' }],
    ])('throws the coerce: false rejection for null at %s', async (_label, def, args) => {
      await expectOriginalRejection(def, args);
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    it.each([
      [
        'a required field',
        { query: null, sort: null },
        ['query'],
        'Send query as a string, not null.',
      ],
      [
        'an unrelated invalid one',
        { query: 'x', sort: null, maxResults: 'many' },
        ['maxResults'],
        'Send maxResults as a number, not a string.',
      ],
    ])(
      'reports only %s beside an optional null whose deletion held (#706)',
      async (_label, args, path, hint) => {
        const result = await call(nullable, args);

        expect(envelope(result).data?.issues).toEqual([expect.objectContaining({ path })]);
        expect(envelope(result).data?.recovery?.hint).toBe(hint);
        expect(adds('mcp.input.coerced')).toEqual([]);
      },
    );

    it('keeps the rejection when the field’s own check throws on an unset value', async () => {
      // The check reads `length` off `undefined`, so the call with `code` omitted
      // throws too; the `null` call keeps the rejection that tells the caller what to send.
      const guarded = tool('prevalidation_guarded', {
        description: 'Takes an optional code whose check reads its length.',
        input: z.object({
          code: z
            .string()
            .optional()
            .refine((code) => (code as string).length > 2, 'Too short.')
            .describe('Code.'),
        }),
        output: ok,
        handler: record,
      });

      const on = await expectOriginalRejection(guarded, { code: null });

      expect(envelope(on).data?.recovery?.hint).toBe('Send code as a string, not null.');
    });

    it('counts the repair as null_as_absent with one debug log', async () => {
      await call(nullable, { query: 'x', dateRange: null, sort: null });

      expect(adds('mcp.input.coerced')).toEqual([
        { 'mcp.tool.name': 'prevalidation_nullable', 'mcp.input.coercion': 'null_as_absent' },
      ]);
      expect(debugLines('arguments validated after repairing')).toEqual([
        "Tool 'prevalidation_nullable': arguments validated after repairing null sent for an optional field.",
      ]);
    });

    it('turns off under coerce: false', async () => {
      const result = await call(nullable, { query: 'x', sort: null }, { coerce: false });

      expect(envelope(result).data?.recovery?.hint).toBe(
        'sort: Invalid option: expected one of "relevance"|"pub_date"',
      );
      expect(adds('mcp.input.coerced')).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // #479, #487, #707, #602, #616 — several repair kinds on one call
  // -----------------------------------------------------------------------

  describe('several repair kinds on one call (#479, #487, #707, #602, #616)', () => {
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

    it('names every kind once, in kind order, whatever order the arguments arrive in', async () => {
      const everyKind = tool('prevalidation_every_kind', {
        description: 'Takes a field each repair kind applies to.',
        input: z.object({
          tags: z.array(z.string()).optional().describe('Tags.'),
          section: z
            .object({ heading: z.string().describe('Heading.') })
            .optional()
            .describe('Section.'),
          code: z.string().optional().describe('Code.'),
          limit: z.number().optional().describe('Limit.'),
          exact: z.boolean().optional().describe('Exact match only.'),
          ids: z.array(z.string()).optional().describe('IDs.'),
          note: z.string().optional().describe('Note.'),
        }),
        output: ok,
        handler: record,
      });

      const result = await call(everyKind, {
        note: null,
        ids: 'a',
        exact: 'true',
        limit: '5',
        code: 7,
        section: '{"heading":"H"}',
        tags: '["x"]',
      });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({
        ids: ['a'],
        exact: true,
        limit: 5,
        code: '7',
        section: { heading: 'H' },
        tags: ['x'],
      });
      expect(adds('mcp.input.coerced').map((entry) => entry['mcp.input.coercion'])).toEqual([
        'stringified_array',
        'stringified_object',
        'integer_as_string',
        'string_as_number',
        'string_as_boolean',
        'string_as_array',
        'null_as_absent',
      ]);
      expect(debugLines('arguments validated after repairing')).toEqual([
        "Tool 'prevalidation_every_kind': arguments validated after repairing a stringified " +
          'array, a stringified object, an integer sent for a string, a string sent for a ' +
          'number, a string sent for a boolean, a string sent for an array and null sent for ' +
          'an optional field.',
      ]);
    });

    it('returns one record per repaired path, naming what was sent and what replaces it', () => {
      const args = { query: 'x', items: [{ name: 'a', note: null }], sort: null, maxResults: '3' };
      const parsed = nullable.input.safeParse(args);
      if (parsed.success) throw new Error('Expected the arguments to fail as sent.');

      const located = parsed.error.issues.map((issue) => ({ issue, path: issue.path }));
      const repaired = repairRepresentations(args, located, nullable.input, new Map());

      expect(repaired.repairs).toEqual([
        { kind: 'string_as_number', path: ['maxResults'], sent: '3', value: 3 },
        { kind: 'null_as_absent', path: ['sort'], sent: null },
        { kind: 'null_as_absent', path: ['items', 0, 'note'], sent: null },
      ]);
      expect(repaired.kinds).toEqual(['string_as_number', 'null_as_absent']);
      expect(repaired.args).toEqual({ query: 'x', items: [{ name: 'a' }], maxResults: 3 });
      // The caller's own arguments are never written to.
      expect(args).toEqual({
        query: 'x',
        items: [{ name: 'a', note: null }],
        sort: null,
        maxResults: '3',
      });
    });

    it('repairs a value once when two issues name its path', async () => {
      // Zod reports `invalid_type` and the array's own `too_big` at one path for
      // a string sent to `z.array(z.string()).max(2)`: the string has five
      // characters. The decoded array is what the re-parse reads.
      const capped = tool('prevalidation_capped_list', {
        description: 'Takes at most two tags.',
        input: z.object({ tags: z.array(z.string()).max(2).describe('Tags.') }),
        output: ok,
        handler: record,
      });

      const result = await call(capped, { tags: '["a"]' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ tags: ['a'] });
      expect(adds('mcp.input.coerced')).toEqual([
        { 'mcp.tool.name': 'prevalidation_capped_list', 'mcp.input.coercion': 'stringified_array' },
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // #706 — a call that still fails after some repairs held
  // -----------------------------------------------------------------------

  describe('a rejection after repairs that held (#706)', () => {
    const distinctPmids = tool('prevalidation_distinct_pmids', {
      description: 'Takes PMIDs, each once.',
      input: z.object({
        pmids: z
          .array(z.string().describe('PMID.'))
          .refine((ids) => new Set(ids).size === ids.length, 'List each PMID once.')
          .describe('PMIDs.'),
      }),
      output: ok,
      handler: record,
    });
    const unheld = tool('prevalidation_unheld', {
      description: 'Takes fields whose repaired value the schema still refuses.',
      input: z.object({
        tags: z.array(z.string()).optional().describe('Tags.'),
        filter: z
          .object({ id: z.string().describe('ID.') })
          .optional()
          .describe('Filter.'),
        flag: z.boolean().optional().describe('Flag.'),
      }),
      output: ok,
      handler: record,
    });
    /**
     * A refinement that always runs and blames `note` until `code` is a
     * string: repairing `code` alone validates, while repairing `note` too
     * fails at `note`.
     */
    const coupled = tool('prevalidation_coupled', {
      description: 'Takes a code and a note checked against it.',
      input: z
        .object({
          code: z.string().describe('Code.'),
          note: z.string().describe('Note.'),
        })
        .refine((value) => typeof value.code === 'string', {
          message: 'Send code as a string first.',
          path: ['note'],
          when: () => true,
        }),
      output: ok,
      handler: record,
    });

    const TOO_BIG = 'pmids: Too big: expected array to have <=10 items';
    const preamble = (name: string) =>
      `Input validation error: Invalid arguments for tool ${name}: `;
    const issuePaths = (result: CallToolResult) => {
      const issues = envelope(result).data?.issues as Array<{ path: PropertyKey[] }> | undefined;
      return issues?.map((issue) => issue.path);
    };

    it('reports only the failure the repaired arguments still carry, on both surfaces', async () => {
      const result = await call(cappedPmids, { pmids: FOURTEEN_PMIDS });
      const { data, message } = envelope(result);

      expect(result.isError).toBe(true);
      expect(data?.issues).toEqual([
        expect.objectContaining({ code: 'too_big', maximum: 10, path: ['pmids'] }),
      ]);
      expect(message).toBe(preamble('prevalidation_capped_pmids') + TOO_BIG);
      expect(data?.recovery?.hint).toBe(TOO_BIG);
      // A restatement-only hint drops the Recovery line (#459).
      expect(text(result)).toBe(
        `Error: ${preamble('prevalidation_capped_pmids')}${TOO_BIG}\n\n` +
          `(reason invalid_arguments · request ${data?.requestId})`,
      );
    });

    it('says nothing about the repairs that held', async () => {
      const result = await call(cappedPmids, { pmids: FOURTEEN_PMIDS });

      expect(Object.keys(envelope(result).data ?? {}).sort()).toEqual([
        'issues',
        'reason',
        'recovery',
        'requestId',
      ]);
      expect(adds('mcp.input.coerced')).toEqual([]);
      expect(debugLines('arguments validated after repairing')).toEqual([]);
    });

    it.each([
      [
        'a held integer beside an unheld one and an unrelated failure',
        { stationId: 5, date: 20260922, days: 'never' },
        [['days'], ['date']],
        'days: Invalid option: expected one of "1"|"7"|"30". Send date as a string, not a number.',
      ],
      [
        'an integer beside an unrelated invalid field',
        { stationId: 5, days: 'never' },
        [['days']],
        'days: Invalid option: expected one of "1"|"7"|"30"',
      ],
      [
        'an outer one-or-many union repair beside an unrelated invalid field',
        { oneOrMany: 123, days: 'never' },
        [['days']],
        'days: Invalid option: expected one of "1"|"7"|"30"',
      ],
    ])('reports %s without the held repair', async (_label, args, paths, hint) => {
      const result = await call(numericIds, args);

      expect(issuePaths(result)).toEqual(paths);
      expect(envelope(result).data?.recovery?.hint).toBe(hint);
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    it.each([
      ['a repaired string an ISO date refuses', numericIds, { date: 20260922 }],
      ['an integer sent for a list', unheld, { tags: 5 }],
      ['a decoded array whose elements fail', unheld, { tags: '[1,2]' }],
      ['a decoded array sent for an object', unheld, { filter: '[1]' }],
      ['an integer sent for a boolean', unheld, { flag: 1 }],
    ])('reports %s as sent — the coerce: false rejection', async (_label, def, args) => {
      await expectOriginalRejection(def, args);
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    it('reports a refinement the first parse never reached once the held repairs reach it', async () => {
      const result = await call(distinctPmids, { pmids: [123, 123] });

      expect(envelope(result).data?.issues).toEqual([
        expect.objectContaining({ code: 'custom', path: ['pmids'] }),
      ]);
      expect(envelope(result).message).toBe(
        `${preamble('prevalidation_distinct_pmids')}pmids: List each PMID once.`,
      );
    });

    it.each([
      ['a case-style alias', { PMIDS: FOURTEEN_PMIDS }, 'PMIDS'],
      [
        'a declared underscore alias the alias-first retry resolves (#563)',
        { _p: FOURTEEN_PMIDS },
        '_p',
      ],
    ])('reports the held repairs the same way behind %s', async (_label, args, alias) => {
      const result = await call(cappedPmids, args);

      expect(issuePaths(result)).toEqual([['pmids']]);
      expect(envelope(result).data?.input).toEqual({
        aliased: [{ alias, target: 'pmids' }],
        ignored: [],
      });
      expect(envelope(result).data?.recovery?.hint).toBe(
        `${TOO_BIG}. Validated ${alias} as pmids.`,
      );
    });

    it('keeps every issue as sent under coerce: false', async () => {
      const result = await call(cappedPmids, { pmids: FOURTEEN_PMIDS }, { coerce: false });

      // 14 integers and the list's own `too_big`; a rejection carries the first 10 (#648).
      expect(issuePaths(result)).toEqual(
        FOURTEEN_PMIDS.slice(0, 10).map((_, index) => ['pmids', index]),
      );
      expect(envelope(result).data).toMatchObject({ issuesCount: 15 });
      expect(envelope(result).message.endsWith(' (+5 more)')).toBe(true);
    });

    it('never admits a call through the reporting parse', async () => {
      // `code` holds and `note` does not; `code` repaired alone validates.
      const result = await expectOriginalRejection(coupled, { code: 7, note: '[1]' });

      expect(issuePaths(result)).toEqual([['code'], ['note']]);
      expect(seen).toBeUndefined();
    });

    it('never admits a call a union would take with only the held repairs', async () => {
      const shared = tool('prevalidation_shared_tag', {
        description: 'Takes one of two targets sharing a tag.',
        input: z.object({
          u: z
            .union([
              z.object({
                kind: z.literal(1).describe('Kind.'),
                p: z.string().describe('P.'),
                r: z.string().describe('R.'),
              }),
              z.object({ kind: z.literal(1).describe('Kind.'), p: z.number().describe('P.') }),
            ])
            .describe('U.'),
        }),
        output: ok,
        handler: record,
      });

      // `kind` holds and `p` does not; the second branch takes `kind` repaired alone.
      const result = await expectOriginalRejection(shared, { u: { kind: '1', p: 5, r: true } });

      expect(envelope(result).message).toContain('u.kind: Invalid input: expected 1');
      expect(seen).toBeUndefined();
    });

    it('parses once more only when the repairs split between held and not', () => {
      const parses = (args: Record<string, unknown>): number => {
        const spy = vi.spyOn(numericIds.input, 'safeParse');
        try {
          parseToolArguments(numericIds, args);
        } catch {
          // Every case here is rejected.
        }
        const count = spy.mock.calls.length;
        spy.mockRestore();
        return count;
      };

      expect(parses({ stationId: 5, days: 'never' })).toBe(2);
      expect(parses({ date: 20260922 })).toBe(2);
      expect(parses({ stationId: 5, date: 20260922, days: 'never' })).toBe(3);
    });

    it('parses no further once every repair is dropped below a transform that reorders it', async () => {
      const reversedBeside = tool('prevalidation_reversed_beside', {
        description: 'Takes items a preprocess reverses, beside a name.',
        input: z.object({
          items: z
            .preprocess(
              (value) => (Array.isArray(value) ? [...value].reverse() : value),
              z.array(z.string()),
            )
            .describe('Items.'),
          b: z.string().describe('B.'),
        }),
        output: ok,
        handler: record,
      });
      const args = { items: [1, 2], b: true };
      const spy = vi.spyOn(reversedBeside.input, 'safeParse');
      try {
        parseToolArguments(reversedBeside, args);
      } catch {
        // Rejected: `b` is no string, and the substitution below the reversal is refused.
      }
      const parses = spy.mock.calls.length;
      spy.mockRestore();

      // The first parse, then the repair in place; the refused substitution leaves the arguments as sent.
      expect(parses).toBe(2);
      const result = await expectOriginalRejection(reversedBeside, args);
      expect(envelope(result).message).toBe(
        'Input validation error: Invalid arguments for tool prevalidation_reversed_beside: ' +
          'items.0: Invalid input: expected string, received number, ' +
          'items.1: Invalid input: expected string, received number, ' +
          'b: Invalid input: expected string, received boolean',
      );
    });

    it('parses a repair below a transform that keeps every position once, written in place and substituted alike', () => {
      const copiedInBranch = tool('prevalidation_copied_in_branch', {
        description: 'Takes a list a copying preprocess hands on, in one of two tagged targets.',
        input: z.object({
          target: z
            .union([
              z.object({
                kind: z.literal('list').describe('Kind.'),
                items: z
                  .preprocess(
                    (value) => (Array.isArray(value) ? [...value] : value),
                    z.array(z.string()),
                  )
                  .describe('Items.'),
              }),
              z.object({ kind: z.literal('one').describe('Kind.') }),
            ])
            .describe('Target.'),
        }),
        output: ok,
        handler: record,
      });
      const spy = vi.spyOn(copiedInBranch.input, 'safeParse');

      // `1` holds and `true` does not; the union, read whole, gives no original repair.
      expect(() =>
        parseToolArguments(copiedInBranch, { target: { kind: 'list', items: [1, true] } }),
      ).toThrow(/: target\.items\.1: Invalid input: expected string, received boolean$/);
      // The first parse, then the repair: both placements write the same arguments.
      expect(spy.mock.calls.length).toBe(2);
      spy.mockRestore();
    });

    it('reports nothing about a stringified list beside a branch that splits a string once it held', async () => {
      const capped = tool('prevalidation_capped_codes', {
        description: 'Takes currency codes, as a list or comma-joined, and a small count.',
        input: z.object({
          codes: z
            .union([
              z.array(z.enum(['USD', 'EUR'])),
              z
                .string()
                .transform((text): unknown => text.split(','))
                .pipe(z.array(z.enum(['USD', 'EUR']))),
            ])
            .describe('Currency codes.'),
          n: z.number().max(3).describe('Count.'),
        }),
        output: ok,
        handler: record,
      });

      const result = await call(capped, { codes: '["USD"]', n: 5 });

      expect(issuePaths(result)).toEqual([['n']]);
      expect(envelope(result).message).toBe(
        'Input validation error: Invalid arguments for tool prevalidation_capped_codes: ' +
          'n: Too big: expected number to be <=3',
      );
      expect(seen).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // #570 — a value inside the one union branch that survives selection
  // -----------------------------------------------------------------------

  describe('a value inside the one union branch that survives selection (#570)', () => {
    it('repairs an integer inside a one-or-many field, counted once', async () => {
      const result = await call(unionBranches, { ids: [123, 'a'] });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ ids: ['123', 'a'] });
      expect(adds('mcp.input.coerced')).toEqual([
        {
          'mcp.tool.name': 'prevalidation_union_branches',
          'mcp.input.coercion': 'integer_as_string',
        },
      ]);
    });

    it.each([
      [
        'a union inside a list element',
        { groups: [{ ids: 'a' }, { ids: [123, 'b'] }] },
        { groups: [{ ids: 'a' }, { ids: ['123', 'b'] }] },
      ],
      ['a union inside a union branch', { nested: [[123]] }, { nested: [['123']] }],
      [
        'the branch whose literal tag matches',
        { target: { kind: 'a', id: 7 } },
        { target: { kind: 'a', id: '7' } },
      ],
    ])('repairs at the full path of %s', async (_label, args, expected) => {
      const result = await call(unionBranches, args);

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual(expected);
    });

    it.each([
      ['stringified_object', { items: ['{"name":"a"}'] }, { items: [{ name: 'a' }] }],
      ['stringified_array', { matrix: ['["a"]'] }, { matrix: [['a']] }],
      ['string_as_number', { counts: ['15', 2] }, { counts: [15, 2] }],
      ['string_as_boolean', { flags: ['true', false] }, { flags: [true, false] }],
      ['string_as_array', { rows: [{ tags: 'a' }] }, { rows: [{ tags: ['a'] }] }],
      ['null_as_absent', { entries: [{ name: 'a', note: null }] }, { entries: [{ name: 'a' }] }],
    ])('applies the %s repair inside the surviving branch', async (kind, args, expected) => {
      const result = await call(unionBranches, args);

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual(expected);
      expect(adds('mcp.input.coerced')).toEqual([
        { 'mcp.tool.name': 'prevalidation_union_branches', 'mcp.input.coercion': kind },
      ]);
    });

    it.each([
      ['a number inside the surviving branch that the branch refuses', { counts: ['01'] }],
      ['a comma-joined string inside the surviving branch', { rows: [{ tags: 'a,b' }] }],
      ['a required null inside the surviving branch', { entries: [{ name: null }] }],
    ])('keeps each kind’s own gate inside the branch: %s', async (_label, args) => {
      await expectOriginalRejection(unionBranches, args);
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    it.each([
      ['two branches failing below their roots', { twoLists: [123] }],
      ['two object branches', { idOrName: { id: 123 } }],
      ['two strict object branches', { idOrNameStrict: { id: 123 } }],
      ['a multi-valued enum beside the list branch', { enumOrList: [123] }],
      ['a branch that takes numbers there, reported as its own check', { cappedNumbers: [123] }],
      ['an unknown discriminator', { shape: { kind: 'c', id: 7 } }],
    ])('repairs nothing for %s', async (_label, args) => {
      await expectOriginalRejection(unionBranches, args);
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    it.each([
      ['a number beside a branch holding one number there', { fiveOrText: { v: 6 } }],
      ['a numeric string beside a branch holding one string there', { countOrAuto: { v: '15' } }],
      ['a lone string beside a branch holding one string there', { listOrBlank: { v: 'a' } }],
      ['a number inside a list beside a list of one number', { fivesOrTexts: [6] }],
    ])('gates %s as a plain union field would', async (_label, args) => {
      // A rendering-dropped branch whose one literal sits at the repaired path
      // still takes that type there: `z.union([z.literal(5), z.string()])`
      // keeps `6` rejected, and so does the same choice inside a branch.
      await expectOriginalRejection(unionBranches, args);
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    it('still repairs a numeric tag every branch spells as a number', async () => {
      const result = await call(unionBranches, { numericTag: { kind: '1', id: 7 } });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ numericTag: { kind: 1, id: '7' } });
    });

    it.each([
      ['a bare integer at the outer path', { ids: 123 }, { ids: '123' }],
      [
        "a discriminated union's selected variant",
        { shape: { kind: 'a', id: 7 } },
        { shape: { kind: 'a', id: '7' } },
      ],
      [
        'the branch a tag selects, sent as that branch takes it',
        { target: { kind: 'b', id: 7 } },
        { target: { kind: 'b', id: 7 } },
      ],
    ])('keeps %s as before', async (_label, args, expected) => {
      const result = await call(unionBranches, args);

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual(expected);
    });

    it('keeps the too_big rejection of a branch that takes numbers there', async () => {
      const result = await call(unionBranches, { cappedNumbers: [123] });

      expect(envelope(result).data?.issues).toEqual([
        expect.objectContaining({ code: 'too_big', path: ['cappedNumbers', 0] }),
      ]);
    });

    it('reports a branch repair another branch refuses as sent, never as repaired (#706)', async () => {
      // Branch `a` takes `id: "7"` but still needs a number `n`; branch `b`
      // refuses the repaired `"7"` at the same path, so the repair did not hold.
      const result = await expectOriginalRejection(unionBranches, {
        guarded: { kind: 'a', id: 7, n: true },
      });

      expect(envelope(result).message).toBe(
        'Input validation error: Invalid arguments for tool prevalidation_union_branches: ' +
          'guarded.id: Invalid input: expected string, received number, ' +
          'guarded.n: Invalid input: expected number, received boolean',
      );
      expect(envelope(result).message).not.toContain('received string');
    });

    it('reports only what still fails once a branch repair held (#706)', async () => {
      const result = await call(unionBranches, { ids: [123, true] });

      expect(envelope(result).message).toBe(
        'Input validation error: Invalid arguments for tool prevalidation_union_branches: ' +
          'ids.1: Invalid input: expected string, received boolean',
      );
      expect(envelope(result).data?.recovery?.hint).toBe('Send ids.1 as a string, not a boolean.');
    });

    it('turns off under coerce: false, with the rejection the branch renders', async () => {
      const result = await call(unionBranches, { ids: [123, 'a'] }, { coerce: false });

      expect(envelope(result).data?.recovery?.hint).toBe('Send ids.0 as a string, not a number.');
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    describe('a rejection whose every branch fails on its tag alone', () => {
      const tagged = tool('prevalidation_tag_only', {
        description: 'Takes one of two tagged targets.',
        input: z.object({
          target: z
            .union([
              z.object({ kind: z.literal('a').describe('Kind.'), id: z.string().describe('ID.') }),
              z.object({
                kind: z.literal('b').describe('Kind.'),
                n: z.number().optional().describe('Count.'),
              }),
            ])
            .describe('Target.'),
        }),
        output: ok,
        handler: record,
      });
      const searchOrFetch = tool('prevalidation_search_or_fetch', {
        description: 'Searches, or fetches one record.',
        input: z.object({
          target: z
            .union([
              z.object({
                kind: z.literal('search').describe('Kind.'),
                query: z.string().describe('Query.'),
              }),
              z.object({
                kind: z.literal('fetch').describe('Kind.'),
                id: z.string().describe('ID.'),
              }),
            ])
            .describe('Search or fetch.'),
        }),
        output: ok,
        handler: record,
      });
      const AB = 'target.kind: Invalid option: expected one of "a"|"b"';

      it.each([
        // The `id` repair holds, so the re-parse fails on the tag alone in every branch.
        ['an unknown tag beside a repaired ID', tagged, { target: { kind: 'c', id: 7 } }, AB, AB],
        [
          'an unknown tag beside a well-typed ID',
          tagged,
          { target: { kind: 'c', id: 'x' } },
          AB,
          AB,
        ],
        [
          'a miscased tag beside a repaired ID',
          searchOrFetch,
          { target: { kind: 'Search', query: 'x', id: 5 } },
          'target.kind: Invalid option: expected one of "search"|"fetch"',
          'target.kind: Invalid option: expected one of "search"|"fetch"',
        ],
        [
          'an omitted tag',
          tagged,
          { target: { id: 'x' } },
          'target.kind: Missing required field. Expected one of "a"|"b"',
          'Provide target.kind.',
        ],
      ])(
        'names every accepted tag for %s, through both entry points',
        async (_label, definition, args, line, expectedHint) => {
          const production = await call(definition, args);
          const helper = await runToolContract(
            definition as AnyToolDefinition,
            structuredClone(args) as never,
          );

          for (const result of [production, helper]) {
            expect(result.isError).toBe(true);
            expect(envelope(result).message).toBe(
              `Input validation error: Invalid arguments for tool ${definition.name}: ${line}`,
            );
            expect(envelope(result).data?.recovery?.hint).toBe(expectedHint);
            expect(text(result)).toContain(line);
            expect(text(result)).not.toContain('target: Invalid input');
            // `data.issues` still ships Zod's one union issue.
            expect(envelope(result).data?.issues).toEqual([
              expect.objectContaining({ code: 'invalid_union', path: ['target'] }),
            ]);
          }
          expect(seen).toBeUndefined();
        },
      );

      it('repairs the tag itself when one repair places it on a branch (#714)', async () => {
        const digitTagged = tool('prevalidation_digit_tagged', {
          description: 'Takes one of two targets tagged by digit strings.',
          input: z.object({
            target: z
              .union([
                z.object({
                  kind: z.literal('1').describe('Kind.'),
                  id: z.string().describe('ID.'),
                }),
                z.object({ kind: z.literal('2').describe('Kind.') }),
              ])
              .describe('Target.'),
          }),
          output: ok,
          handler: record,
        });

        // The tag every branch refused is read as a field holding those literals: `1` → `"1"`.
        const result = await call(digitTagged, { target: { kind: 1, id: 'x' } });

        expect(result.isError).toBeUndefined();
        expect(seen).toEqual({ target: { kind: '1', id: 'x' } });
        expect(adds('mcp.input.coerced')).toEqual([
          {
            'mcp.tool.name': 'prevalidation_digit_tagged',
            'mcp.input.coercion': 'integer_as_string',
          },
        ]);
        const off = await call(digitTagged, { target: { kind: 1, id: 'x' } }, { coerce: false });
        expect(envelope(off).message).toContain(
          'target.kind: Invalid option: expected one of "1"|"2"',
        );
      });
    });

    it('publishes the production envelope through runToolContract', async () => {
      const production = await call(unionBranches, { ids: [123, 'a'] });
      const viaProduction = seen;
      seen = undefined;
      const helper = await runToolContract(
        unionBranches as AnyToolDefinition,
        { ids: [123, 'a'] } as never,
      );

      expect(production.isError).toBeUndefined();
      expect(helper.isError).toBeUndefined();
      expect(seen).toEqual(viaProduction);
    });

    it('deletes a null at an optional key of a literal-tagged plain union branch', async () => {
      const noted = tool('prevalidation_tagged_note', {
        description: 'Takes one of two tagged targets.',
        input: z.object({
          target: z
            .union([
              z.object({
                kind: z.literal('a').describe('Kind.'),
                id: z.string().describe('ID.'),
                note: z.string().optional().describe('Note.'),
              }),
              z.object({ kind: z.literal('b').describe('Kind.') }),
            ])
            .describe('Target.'),
        }),
        output: ok,
        handler: record,
      });

      const result = await call(noted, { target: { kind: 'a', id: 'x', note: null } });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ target: { kind: 'a', id: 'x' } });
      expect(adds('mcp.input.coerced')).toEqual([
        { 'mcp.tool.name': 'prevalidation_tagged_note', 'mcp.input.coercion': 'null_as_absent' },
      ]);
    });

    it('reads a one-value enum as a tag the same way', async () => {
      const noted = tool('prevalidation_enum_tagged_note', {
        description: 'Takes one of two targets, one tagged by a one-value enum.',
        input: z.object({
          target: z
            .union([
              z.object({
                kind: z.literal('a').describe('Kind.'),
                id: z.string().describe('ID.'),
                note: z.string().optional().describe('Note.'),
              }),
              z.object({ kind: z.enum(['b']).describe('Kind.') }),
            ])
            .describe('Target.'),
        }),
        output: ok,
        handler: record,
      });

      const result = await call(noted, { target: { kind: 'a', id: 'x', note: null } });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ target: { kind: 'a', id: 'x' } });
    });

    describe('a transformed field in a branch whose own tag the caller sent wrong', () => {
      /** An ID-or-name lookup: a known name becomes its number, anything else falls through. */
      const lookup = (value: unknown) => (value === 'answer' ? 42 : value);
      const counted = tool('prevalidation_tagged_lookup', {
        description: 'Takes one of two numerically tagged targets.',
        input: z.object({
          target: z
            .union([
              z.object({
                kind: z.literal(1).describe('Kind.'),
                n: z.preprocess(lookup, z.number()).describe('Count, or a known name.'),
              }),
              z.object({ kind: z.literal(2).describe('Kind.') }),
            ])
            .describe('Target.'),
        }),
        output: ok,
        handler: record,
      });
      const formatted = tool('prevalidation_formatted_lookup', {
        description: 'Takes a JSON query or a list of IDs.',
        input: z.object({
          target: z
            .union([
              z.object({
                format: z.enum(['json']).describe('Format.'),
                q: z.string().describe('Query.'),
                n: z.preprocess(lookup, z.number()).optional().describe('Count, or a known name.'),
                note: z.string().optional().describe('Note.'),
              }),
              z.array(z.string()),
            ])
            .describe('Target.'),
        }),
        output: ok,
        handler: record,
      });

      it('never reads a string as a number there, however the tag was sent (#707)', async () => {
        const tagRight = await call(counted, { target: { kind: 1, n: '15' } });
        const tagWrong = await call(counted, { target: { kind: '1', n: '15' } });

        for (const result of [tagRight, tagWrong]) {
          expect(result.isError).toBe(true);
          expect(envelope(result).code).toBe(JsonRpcErrorCode.InvalidParams);
          expect(envelope(result).message).toContain(
            'target.n: Invalid input: expected number, received string',
          );
        }
        expect(seen).toBeUndefined();
      });

      it('keeps the rejection that names a missing one-value enum field beside a string for the transformed field', async () => {
        const result = await expectOriginalRejection(formatted, { target: { q: 'x', n: '15' } });

        expect(envelope(result).data?.recovery?.hint).toMatch(/^Provide target\.format\. /);
      });

      it('deletes a null in the branch whose one-value enum field was left out, and names that field', async () => {
        const result = await call(formatted, { target: { q: 'x', note: null } });

        expect(envelope(result).message).toBe(
          'Input validation error: Invalid arguments for tool prevalidation_formatted_lookup: ' +
            'target.format: Missing required field. Expected "json"',
        );
        expect(envelope(result).data?.recovery?.hint).toBe('Provide target.format.');
        expect(seen).toBeUndefined();
      });

      it('reads a value a preprocess wraps through the branch the rejection names', async () => {
        const wrapped = tool('prevalidation_tagged_wrapped', {
          description: 'Takes one of two tagged targets, one holding items or a lone item.',
          input: z.object({
            target: z
              .union([
                z.object({
                  kind: z.literal('a').describe('Kind.'),
                  items: z
                    .preprocess(
                      (value) => (Array.isArray(value) ? value : [value]),
                      z.array(z.object({ year: z.string().describe('Year.') })),
                    )
                    .describe('Items, or one item.'),
                }),
                z.object({ kind: z.literal('b').describe('Kind.') }),
              ])
              .describe('Target.'),
          }),
          output: ok,
          handler: record,
        });

        // The caller sent the year; the rejection names its type, never asks for it.
        const unrepaired = await call(wrapped, { target: { kind: 'c', items: { year: true } } });
        expect(envelope(unrepaired).data?.recovery?.hint).toBe(
          'target.kind: Invalid input: expected "a". Send target.items.0.year as a string, not a boolean.',
        );

        // A year the repair fixes holds, so only the tag no branch takes is left.
        const repaired = await call(wrapped, { target: { kind: 'c', items: { year: 2020 } } });
        expect(envelope(repaired).message).toBe(
          'Input validation error: Invalid arguments for tool prevalidation_tagged_wrapped: ' +
            'target.kind: Invalid option: expected one of "a"|"b"',
        );
        expect(seen).toBeUndefined();
      });
    });
  });

  // -----------------------------------------------------------------------
  // #714 — a discriminator or literal tag no variant accepts
  // -----------------------------------------------------------------------

  describe('a tag no variant accepts (#714)', () => {
    /**
     * Two variants tagged `a` and `b` at `kind`, as a discriminated union and
     * as a plain union, so each case reads the same tag through both shapes.
     */
    const shapes = (a: z.ZodType, b: z.ZodType) => {
      const variants = () =>
        [
          z.object({ kind: a.describe('Kind.'), id: z.string().describe('ID.') }),
          z.object({
            kind: b.describe('Kind.'),
            id: z.string().describe('ID.'),
            n: z.number().optional().describe('Count.'),
          }),
        ] as const;
      return [
        tool('prevalidation_discriminated_tags', {
          description: 'Takes one discriminated target.',
          input: z.object({ s: z.discriminatedUnion('kind', variants()).describe('Target.') }),
          output: ok,
          handler: record,
        }),
        tool('prevalidation_plain_tags', {
          description: 'Takes one literal-tagged target.',
          input: z.object({ s: z.union(variants()).describe('Target.') }),
          output: ok,
          handler: record,
        }),
      ] as const;
    };

    /** A tool taking `input`, for the cases that each need their own schema. */
    const taking = (input: z.ZodObject<z.ZodRawShape>) =>
      tool('prevalidation_tag_paths', {
        description: 'Takes a tagged target.',
        input,
        output: ok,
        handler: record,
      });

    /**
     * Drives `args` through the production factory and then the helper, which
     * must both reach the handler with the same value. Returns that value and
     * the repairs the production call counted.
     */
    const resolve = async (definition: unknown, args: Record<string, unknown>) => {
      counterAdds.length = 0;
      seen = undefined;
      const production = await call(definition, args);
      const value = seen;
      const coerced = adds('mcp.input.coerced');
      seen = undefined;
      const helper = await runToolContract(
        definition as AnyToolDefinition,
        structuredClone(args) as never,
      );

      expect(production.isError).toBeUndefined();
      expect(helper.isError).toBeUndefined();
      expect(seen).toEqual(value);
      return { coerced, value };
    };

    /** The call under `coerce: false`: rejected before the handler runs, nothing counted. */
    const refusedWithoutRepair = async (definition: unknown, args: Record<string, unknown>) => {
      counterAdds.length = 0;
      seen = undefined;
      const off = await call(definition, args, { coerce: false });

      expect(off.isError).toBe(true);
      expect(envelope(off).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(seen).toBeUndefined();
      expect(adds('mcp.input.coerced')).toEqual([]);
      return off;
    };

    it.each([
      [
        'a field',
        tagField,
        { s: { kind: '1', id: 'x' } },
        { s: { kind: 1, id: 'x' } },
        "s.kind: Invalid discriminator value. Expected '1' | '2'",
      ],
      [
        'the input root',
        tagRoot,
        { kind: '1', id: 'x' },
        { kind: 1, id: 'x' },
        "kind: Invalid discriminator value. Expected '1' | '2'",
      ],
      [
        'a list element',
        tagList,
        {
          items: [
            { kind: 1, id: 'a' },
            { kind: '2', n: 3 },
          ],
        },
        {
          items: [
            { kind: 1, id: 'a' },
            { kind: 2, n: 3 },
          ],
        },
        "items.1.kind: Invalid discriminator value. Expected '1' | '2'",
      ],
      [
        'a plain union of literal-tagged objects',
        plainTag,
        { target: { kind: '1', id: '7' } },
        { target: { kind: 1, id: '7' } },
        'target.kind: Invalid option: expected one of 1|2',
      ],
    ])(
      'repairs a quoted numeric tag at %s, counted once',
      async (_label, definition, args, expected, refused) => {
        const resolved = await resolve(definition, args);

        expect(resolved.value).toEqual(expected);
        expect(resolved.coerced).toEqual([
          { 'mcp.tool.name': definition.name, 'mcp.input.coercion': 'string_as_number' },
        ]);
        const off = await refusedWithoutRepair(definition, args);
        expect(envelope(off).message).toBe(
          `Input validation error: Invalid arguments for tool ${definition.name}: ${refused}`,
        );
      },
    );

    it.each([
      [
        'a tag every variant takes, beside an integer for a string',
        tagField,
        { s: { kind: 1, id: 7 } },
        { s: { kind: 1, id: '7' } },
        ['integer_as_string'],
      ],
      [
        'a quoted tag beside an integer for a string, in a plain union',
        plainTag,
        { target: { kind: '1', id: 7 } },
        { target: { kind: 1, id: '7' } },
        ['integer_as_string', 'string_as_number'],
      ],
    ])('keeps repairing %s', async (_label, definition, args, expected, kinds) => {
      const resolved = await resolve(definition, args);

      expect(resolved.value).toEqual(expected);
      expect(resolved.coerced).toEqual(
        kinds.map((kind) => ({ 'mcp.tool.name': definition.name, 'mcp.input.coercion': kind })),
      );
    });

    it('repairs nothing else in a branch the repaired tag does not select, in both shapes', async () => {
      // In the plain union, branch 2 fails only on its tag, so the rejection reads
      // branch 1's other values; the repaired tag `2` selects branch 2, where `id: 7`
      // was valid as sent.
      const crossed = (union: 'discriminated' | 'plain') => {
        const variants = [
          z.object({ kind: z.literal(1).describe('Kind.'), id: z.string().describe('ID.') }),
          z.object({ kind: z.literal(2).describe('Kind.'), id: z.number().describe('ID.') }),
        ] as const;
        return taking(
          z.object({
            s: (union === 'plain'
              ? z.union(variants)
              : z.discriminatedUnion('kind', variants)
            ).describe('Target.'),
          }),
        );
      };

      for (const union of ['discriminated', 'plain'] as const) {
        const resolved = await resolve(crossed(union), { s: { kind: '2', id: 7 } });

        expect(resolved.value).toEqual({ s: { kind: 2, id: 7 } });
        expect(resolved.coerced).toEqual([
          { 'mcp.tool.name': 'prevalidation_tag_paths', 'mcp.input.coercion': 'string_as_number' },
        ]);
      }
    });

    it.each([
      ['a numeric string', z.literal(1), z.literal(2), '1', 1, 'string_as_number'],
      ['a padded numeric string', z.literal(1), z.literal(2), ' 1', 1, 'string_as_number'],
      ['"true"', z.literal(true), z.literal(false), 'true', true, 'string_as_boolean'],
      ['"false"', z.literal(true), z.literal(false), 'false', false, 'string_as_boolean'],
      ['a padded "true"', z.literal(true), z.literal(false), ' true ', true, 'string_as_boolean'],
      [
        'a string for a numeric enum tag',
        z.enum({ A: 1, B: 3 }),
        z.literal([2, 4]),
        '3',
        3,
        'string_as_number',
      ],
      [
        'a string for a multi-valued literal tag',
        z.literal([1, 3]),
        z.literal([2, 4]),
        '3',
        3,
        'string_as_number',
      ],
      ['an integer for a string tag', z.literal('1'), z.literal('2'), 1, '1', 'integer_as_string'],
    ] as const)(
      'repairs %s in both shapes, through both entry points',
      async (_label, a, b, sent, value, kind) => {
        for (const definition of shapes(a, b)) {
          const args = { s: { kind: sent, id: 'x' } };
          const resolved = await resolve(definition, args);

          expect(resolved.value).toEqual({ s: { kind: value, id: 'x' } });
          expect(resolved.coerced).toEqual([
            { 'mcp.tool.name': definition.name, 'mcp.input.coercion': kind },
          ]);
          await refusedWithoutRepair(definition, args);
        }
      },
    );

    it.each([
      ['"True" for a boolean tag', z.literal(true), z.literal(false), 'True'],
      ['"1" for a boolean tag', z.literal(true), z.literal(false), '1'],
      ['a leading zero', z.literal(1), z.literal(2), '01'],
      ['a trailing fraction', z.literal(1), z.literal(2), '1.0'],
      ['an exponent', z.literal(1), z.literal(2), '1e0'],
      ['a plus sign', z.literal(1), z.literal(2), '+1'],
      ['a blank', z.literal(1), z.literal(2), ''],
      ['a number no variant takes', z.literal(1), z.literal(2), '3'],
      ['a negative number no variant takes', z.literal(1), z.literal(2), '-1'],
      ['digits that round onto the tag', z.literal(2 ** 53), z.literal(2), '9007199254740993'],
      ['a numeric string beside a string tag', z.literal('a'), z.literal(1), '1'],
    ] as const)(
      'keeps exactly the coerce: false rejection of %s in both shapes',
      async (_label, a, b, sent) => {
        for (const definition of shapes(a, b)) {
          const args = { s: { kind: sent, id: 'x' } };
          const production = await expectOriginalRejection(definition, args);
          const helper = await runToolContract(
            definition as AnyToolDefinition,
            structuredClone(args) as never,
          );

          expect(helper).toEqual(withoutRequestId(production));
        }
        expect(adds('mcp.input.coerced')).toEqual([]);
        expect(seen).toBeUndefined();
      },
    );

    it('keeps the rejection of a quoted tag when a branch types its tag through a z.preprocess()', async () => {
      const preprocessedTag = taking(
        z.object({
          t: z
            .union([
              z.object({ kind: z.literal(1).describe('Kind.'), id: z.string().describe('ID.') }),
              z.object({
                kind: z
                  .preprocess((value) => (value === 'two' ? 2 : value), z.literal(2))
                  .describe('Kind, or its name.'),
                n: z.number().optional().describe('Count.'),
              }),
            ])
            .describe('Target.'),
        }),
      );
      const args = { t: { kind: '1', id: 'x' } };

      const production = await expectOriginalRejection(preprocessedTag, args);
      const helper = await runToolContract(
        preprocessedTag as AnyToolDefinition,
        structuredClone(args) as never,
      );

      expect(helper).toEqual(withoutRequestId(production));
      expect(adds('mcp.input.coerced')).toEqual([]);
      // The preprocess still takes the spelling it maps.
      expect((await resolve(preprocessedTag, { t: { kind: 'two' } })).value).toEqual({
        t: { kind: 2 },
      });
    });

    it('keeps the rejection of a quoted tag beside a branch tagged by a string', async () => {
      // `"1"` might be a misspelled `"x"`: the field takes strings there, as #707's
      // `z.union([z.number(), z.literal('auto')])` does.
      const besideString = taking(
        z.object({
          s: z
            .union([
              z.discriminatedUnion('kind', [
                z.object({ kind: z.literal(1).describe('Kind.'), id: z.string().describe('ID.') }),
                z.object({ kind: z.literal(2).describe('Kind.'), id: z.string().describe('ID.') }),
              ]),
              z.object({ kind: z.literal('x').describe('Kind.'), id: z.string().describe('ID.') }),
            ])
            .describe('Target.'),
        }),
      );

      await expectOriginalRejection(besideString, { s: { kind: '1', id: 'x' } });
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    it.each([
      [
        'any field every branch refuses as a value',
        z.object({
          t: z
            .union([
              z.object({
                days: z.enum(['1', '7']).describe('Window in days.'),
                a: z.string().describe('A.'),
              }),
              z.object({
                days: z.enum(['30']).describe('Window in days.'),
                b: z.string().describe('B.'),
              }),
            ])
            .describe('Window.'),
        }),
        { t: { days: 7, a: 'x' } },
        { t: { days: '7', a: 'x' } },
        ['integer_as_string'],
      ],
      [
        'two quoted tags in one value',
        z.object({
          t: z
            .union([
              z.object({
                kind: z.literal(1).describe('Kind.'),
                ver: z.literal(2).describe('Version.'),
                id: z.string().describe('ID.'),
              }),
              z.object({
                kind: z.literal(1).describe('Kind.'),
                ver: z.literal(3).describe('Version.'),
                n: z.number().optional().describe('Count.'),
              }),
            ])
            .describe('Target.'),
        }),
        { t: { kind: '1', ver: '2', id: 'x' } },
        { t: { kind: 1, ver: 2, id: 'x' } },
        ['string_as_number'],
      ],
      [
        'a tag two levels below the branch root',
        z.object({
          t: z
            .union([
              z.object({
                meta: z.object({ kind: z.literal(1).describe('Kind.') }).describe('Meta.'),
                id: z.string().describe('ID.'),
              }),
              z.object({
                meta: z.object({ kind: z.literal(2).describe('Kind.') }).describe('Meta.'),
                n: z.number().optional().describe('Count.'),
              }),
            ])
            .describe('Target.'),
        }),
        { t: { meta: { kind: '1' }, id: 'x' } },
        { t: { meta: { kind: 1 }, id: 'x' } },
        ['string_as_number'],
      ],
      [
        'a plain union inside the branch a tag selects',
        z.object({
          t: z
            .union([
              z.object({
                kind: z.literal(1).describe('Kind.'),
                sub: z
                  .union([
                    z.object({ k: z.literal(1).describe('Sub-kind.') }),
                    z.object({ k: z.literal(2).describe('Sub-kind.') }),
                  ])
                  .describe('Sub-target.'),
              }),
              z.object({ kind: z.literal(2).describe('Kind.') }),
            ])
            .describe('Target.'),
        }),
        { t: { kind: 1, sub: { k: '2' } } },
        { t: { kind: 1, sub: { k: 2 } } },
        ['string_as_number'],
      ],
      [
        'a discriminated union inside the variant its tag selects',
        z.object({
          s: z
            .discriminatedUnion('kind', [
              z.object({ kind: z.literal(1).describe('Kind.'), id: z.string().describe('ID.') }),
              z.object({ kind: z.literal(2).describe('Kind.'), inner: NumericTagged }),
            ])
            .describe('Target.'),
        }),
        { s: { kind: 2, inner: { kind: '1', id: 'x' } } },
        { s: { kind: 2, inner: { kind: 1, id: 'x' } } },
        ['string_as_number'],
      ],
      [
        'a discriminated union a z.preprocess wraps as a list',
        z.object({
          targets: z.preprocess(wrapLone, z.array(NumericTagged)).describe('Targets, or one.'),
        }),
        { targets: { kind: '1', id: 'x' } },
        { targets: [{ kind: 1, id: 'x' }] },
        ['string_as_number'],
      ],
      [
        'a discriminated union beside a branch tagged by another number',
        z.object({
          s: z
            .union([
              NumericTagged,
              z.object({ kind: z.literal(3).describe('Kind.'), id: z.string().describe('ID.') }),
            ])
            .describe('Target.'),
        }),
        { s: { kind: '1', id: 'x' } },
        { s: { kind: 1, id: 'x' } },
        ['string_as_number'],
      ],
      [
        'a union of two discriminated unions',
        z.object({
          s: z
            .union([
              NumericTagged,
              z.discriminatedUnion('kind', [
                z.object({ kind: z.literal(3).describe('Kind.'), id: z.string().describe('ID.') }),
                z.object({ kind: z.literal(4).describe('Kind.'), id: z.string().describe('ID.') }),
              ]),
            ])
            .describe('Target.'),
        }),
        { s: { kind: '3', id: 'x' } },
        { s: { kind: 3, id: 'x' } },
        ['string_as_number'],
      ],
      [
        'a discriminated union one of whose variants leaves its tag optional',
        z.object({
          s: z
            .discriminatedUnion('kind', [
              z.object({
                kind: z.literal(1).optional().describe('Kind.'),
                id: z.string().describe('ID.'),
              }),
              z.object({ kind: z.literal(2).describe('Kind.'), n: z.number().describe('Count.') }),
            ])
            .describe('Target.'),
        }),
        { s: { kind: '2', n: 5 } },
        { s: { kind: 2, n: 5 } },
        ['string_as_number'],
      ],
      [
        'a null tag the branch it lands on leaves optional, deleted as at a plain field (#616)',
        z.object({
          t: z
            .union([
              z.object({
                kind: z.literal(1).optional().describe('Kind.'),
                id: z.string().describe('ID.'),
              }),
              z.object({ kind: z.literal(2).describe('Kind.') }),
            ])
            .describe('Target.'),
        }),
        { t: { kind: null, id: 'x' } },
        { t: { id: 'x' } },
        ['null_as_absent'],
      ],
    ])('repairs %s', async (_label, input, args, expected, kinds) => {
      const definition = taking(input);
      const resolved = await resolve(definition, args);

      expect(resolved.value).toEqual(expected);
      expect(resolved.coerced).toEqual(
        kinds.map((kind) => ({ 'mcp.tool.name': definition.name, 'mcp.input.coercion': kind })),
      );
      await refusedWithoutRepair(definition, args);
    });

    it('reports a second slip in the variant a repaired tag selects, with the tag repair held (#706)', async () => {
      const args = { s: { kind: '1', id: 7 } };
      const line = 's.id: Invalid input: expected string, received number';

      const production = await call(tagField, args);
      const helper = await runToolContract(
        tagField as AnyToolDefinition,
        structuredClone(args) as never,
      );

      for (const result of [production, helper]) {
        expect(result.isError).toBe(true);
        expect(envelope(result).message).toBe(
          `Input validation error: Invalid arguments for tool prevalidation_tag_field: ${line}`,
        );
        expect(envelope(result).data?.recovery?.hint).toBe('Send s.id as a string, not a number.');
        expect(text(result)).toContain(line);
        expect(text(result)).toContain('Send s.id as a string, not a number.');
      }
      expect(helper).toEqual(withoutRequestId(production));
      expect(seen).toBeUndefined();
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    it('rejects a key alias in the variant a repaired root tag selects on the key, not on the tag', async () => {
      const args = { kind: '2', max_results: 5 };

      const production = await call(tagRoot, args);
      const helper = await runToolContract(
        tagRoot as AnyToolDefinition,
        structuredClone(args) as never,
      );

      // One pass: the alias stage ran before the tag was repaired, so it found no variant.
      for (const result of [production, helper]) {
        expect(result.isError).toBe(true);
        expect(envelope(result).message).toBe(
          'Input validation error: Invalid arguments for tool prevalidation_tag_root: ' +
            'maxResults: Invalid input: expected number, received undefined, ' +
            'Unrecognized key: "max_results"',
        );
        expect(envelope(result).data?.recovery?.hint).toBe(
          'Provide maxResults. Unknown key max_results.',
        );
      }
      expect(helper).toEqual(withoutRequestId(production));
      // Sent with its tag as declared, the alias reaches its target.
      expect((await resolve(tagRoot, { kind: 2, max_results: 5 })).value).toEqual({
        kind: 2,
        maxResults: 5,
      });
    });
  });

  // -----------------------------------------------------------------------
  // #599 — a value inside what a z.preprocess made of the argument
  // -----------------------------------------------------------------------

  describe('a value inside a z.preprocess output (#599)', () => {
    it.each([
      ['null_as_absent', { items: { name: 'abc', kind: null } }, { items: [{ name: 'abc' }] }],
      [
        'string_as_array',
        { items: { name: 'abc', tags: 'solo' } },
        { items: [{ name: 'abc', tags: ['solo'] }] },
      ],
      ['integer_as_string', { groups: { ids: [1, 'b'] } }, { groups: [{ ids: ['1', 'b'] }] }],
    ])(
      'applies the %s repair and substitutes the output at the preprocess',
      async (kind, args, expected) => {
        const result = await call(preprocessed, args);

        expect(result.isError).toBeUndefined();
        expect(seen).toEqual(expected);
        expect(adds('mcp.input.coerced')).toEqual([
          { 'mcp.tool.name': 'prevalidation_preprocessed', 'mcp.input.coercion': kind },
        ]);
      },
    );

    it('adds no key: the preprocess output takes the lone object’s place', async () => {
      const result = await call(preprocessed, { items: { name: 'abc', year: 2020 } });

      expect(result.isError).toBeUndefined();
      expect(Object.keys(seen ?? {})).toEqual(['items']);
      const [first] = (seen?.items ?? []) as Array<Record<string, unknown>>;
      expect(Object.keys(first ?? {})).toEqual(['name', 'year']);
    });

    it('keeps the rejection when the preprocess would not return the repaired output unchanged', async () => {
      // `reversed` reverses a list, so the repaired output would come back reordered.
      await expectOriginalRejection(preprocessed, {
        reversed: [{ name: 'abc', year: 2020 }, { name: 'def' }],
      });
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    it('reports only what still fails once a repair below the preprocess held (#706)', async () => {
      const result = await call(preprocessed, { items: { name: 'abc', year: 2020, kind: 'zzz' } });

      expect(envelope(result).message).toBe(
        'Input validation error: Invalid arguments for tool prevalidation_preprocessed: ' +
          'items.0.kind: Invalid option: expected one of "a"|"b"',
      );
      expect(envelope(result).data?.recovery?.hint).toBe(
        'items.0.kind: Invalid option: expected one of "a"|"b"',
      );
    });

    it('keeps a -32602 rejection when the preprocess throws on the repaired output', async () => {
      let calls = 0;
      /** Wraps on its first two calls — the parse and the walk — then throws. */
      const twice = (value: unknown) => {
        calls++;
        if (calls > 2) throw new Error('preprocess ran a third time');
        return wrapLone(value);
      };
      const fragile = tool('prevalidation_fragile', {
        description: 'Takes items a stateful preprocess wraps.',
        input: z.object({
          items: z.preprocess(twice, z.array(PreprocessedItem)).describe('Items.'),
        }),
        output: ok,
        handler: record,
      });

      const result = await call(fragile, { items: { name: 'abc', year: 2020 } });

      expect(result.isError).toBe(true);
      expect(envelope(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(envelope(result).data?.reason).toBe('invalid_arguments');
      expect(envelope(result).data?.recovery?.hint).toBe(
        'Send items.0.year as a string, not a number.',
      );
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    it.each([
      ['rejected', (i: number) => ({ name: `Bad${i}` })],
      ['repaired', (i: number) => ({ name: 'abc', year: i })],
    ])('runs the preprocess as often for one %s item as for 1,000', (_label, item) => {
      let calls = 0;
      const counted = tool('prevalidation_counted', {
        description: 'Takes items a counting preprocess wraps.',
        input: z.object({
          items: z
            .preprocess(
              (value) => {
                calls++;
                return wrapLone(value);
              },
              z.array(
                z.object({
                  name: z
                    .string()
                    .regex(/^[a-z]+$/)
                    .describe('Name.'),
                  year: z.string().optional().describe('Year.'),
                }),
              ),
            )
            .describe('Items.'),
        }),
        output: ok,
        handler: record,
      });
      const callsFor = (count: number): number => {
        calls = 0;
        try {
          parseToolArguments(counted, { items: Array.from({ length: count }, (_, i) => item(i)) });
        } catch {
          // A rejected call is counted through its whole rejection.
        }
        return calls;
      };

      expect(callsFor(1_000)).toBe(callsFor(1));
    });

    it('accepts a call the original repair validates on that repair’s parse, running no repair walk', async () => {
      let calls = 0;
      const counted = tool('prevalidation_counted_mode', {
        description: 'Takes names, or a mode a counting preprocess wraps.',
        input: z.object({
          spec: z
            .union([
              z.array(z.string()),
              z.preprocess(
                (value) => {
                  calls++;
                  return typeof value === 'string' ? { mode: value } : value;
                },
                z.object({ mode: z.enum(['fast', 'slow']).describe('Mode.') }),
              ),
            ])
            .describe('Names, or a mode.'),
        }),
        output: ok,
        handler: record,
      });

      const result = await call(counted, { spec: '["abc"]' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ spec: ['abc'] });
      // The first parse alone runs it: the decoded list takes the list branch.
      // A repair walk past the original repair re-applies it, three runs in all.
      expect(calls).toBe(1);
    });

    it('publishes the production outcome through runToolContract', async () => {
      const args = { items: { name: 'abc', year: 2020 } };
      await call(preprocessed, args);
      const viaProduction = seen;
      seen = undefined;
      const helper = await runToolContract(preprocessed as AnyToolDefinition, args as never);

      expect(helper.isError).toBeUndefined();
      expect(seen).toEqual(viaProduction);
    });

    describe('every call a repair written in place validated still validates, with the same value', () => {
      const isRecord = (value: unknown): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null && !Array.isArray(value);
      const Item = z.object({
        name: z.string().describe('Name.'),
        year: z.string().optional().describe('Year.'),
        kind: z.enum(['a', 'b']).optional().describe('Kind.'),
      });
      const StrictItem = Item.strict();
      /** `items` behind a preprocess. */
      const items = (pre: (value: unknown) => unknown, inner: z.ZodType) =>
        z.object({ items: z.preprocess(pre, inner).optional().describe('Items.') });
      /** A list behind `pre`, and each element of it through `each` — a lone value wrapped first. */
      const each = (map: (item: unknown) => unknown) => (value: unknown) =>
        (Array.isArray(value) ? value : [value]).map(map);
      /** A list mapped element by element; anything else as sent. */
      const perElement = (map: (item: unknown) => unknown) => (value: unknown) =>
        Array.isArray(value) ? value.map(map) : value;
      const wrap = (value: unknown) => (isRecord(value) ? [value] : value);
      const withKind = (value: unknown) => (isRecord(value) ? { kind: 'a', ...value } : value);
      const reverse = (value: unknown) => (Array.isArray(value) ? [...value].reverse() : value);
      const double = perElement((entry) => (typeof entry === 'number' ? entry * 2 : entry));
      const sparse = (value: unknown) => {
        if (!Array.isArray(value)) return value;
        const out: unknown[] = [];
        value.forEach((entry, i) => {
          out[i * 2 + 1] = entry;
        });
        return out;
      };

      const wrapped = items(wrap, z.array(StrictItem));
      const defaulted = items(
        (value) => (isRecord(value) ? [withKind(value)] : perElement(withKind)(value)),
        z.array(StrictItem),
      );
      const flagged = z.object({
        filter: z
          .preprocess(
            (value) =>
              isRecord(value) ? { ...value, explicit: Object.hasOwn(value, 'year') } : value,
            z.object({ year: z.string().optional(), explicit: z.boolean() }),
          )
          .describe('Filter.'),
      });
      const strings = z.array(z.string());
      const reversed = items(reverse, strings);
      const sorted = items((value) => (Array.isArray(value) ? [...value].sort() : value), strings);
      const deduped = items(
        (value) => (Array.isArray(value) ? [...new Set(value)] : value),
        strings,
      );
      const filled = items(
        perElement((entry) => (entry === null ? 'none' : entry)),
        strings,
      );
      const nullYear = items(
        perElement((entry) =>
          isRecord(entry)
            ? { ...entry, year: entry.year === undefined ? null : entry.year }
            : entry,
        ),
        z.array(Item.extend({ year: z.string().nullable().optional() })),
      );
      const doubled = items(double, strings);
      const banged = items(
        perElement((entry) => (typeof entry === 'string' ? `${entry}!` : entry)),
        strings,
      );
      const rebuilt = items(
        each((entry) =>
          isRecord(entry) ? { name: entry.name, year: entry.year, kind: entry.kind } : entry,
        ),
        z.array(Item),
      );
      const stamped = items(
        each((entry) => (isRecord(entry) ? { ...entry, at: new Date(0) } : entry)),
        z.array(Item.extend({ at: z.date() })),
      );
      const keptDate = items(
        each((entry) =>
          isRecord(entry)
            ? entry.at instanceof Date
              ? entry
              : { ...entry, at: new Date(0) }
            : entry,
        ),
        z.array(Item.extend({ at: z.date() })),
      );
      const scored = items(
        each((entry) => (isRecord(entry) ? { ...entry, score: Number.NaN } : entry)),
        z.array(Item.extend({ score: z.nan() })),
      );
      const offset = items(
        each((entry) => (isRecord(entry) ? { ...entry, off: entry.off ?? -0 } : entry)),
        z.array(Item.extend({ off: z.number() })),
      );
      const instances = items(
        each((entry) =>
          isRecord(entry) ? Object.assign(Object.create({ tag: 1 }), entry) : entry,
        ),
        z.array(Item),
      );
      const getters = items(
        each((entry) =>
          isRecord(entry)
            ? {
                ...entry,
                get kind() {
                  return 'a';
                },
              }
            : entry,
        ),
        z.array(Item),
      );
      const holed = items(sparse, z.array(z.string().optional()));
      const cyclic = items(
        each((entry) => {
          if (!isRecord(entry)) return entry;
          const copy: Record<string, unknown> = { ...entry };
          copy.self = copy;
          return copy;
        }),
        z.array(Item),
      );
      const split = z.object({
        tags: z
          .string()
          .transform((text): unknown => text.split(','))
          .pipe(z.array(z.number()))
          .optional()
          .describe('Tags.'),
      });
      const lowered = items(
        wrap,
        z.array(
          z.preprocess(
            (entry) =>
              isRecord(entry) && typeof entry.kind === 'string'
                ? { ...entry, kind: entry.kind.toLowerCase() }
                : entry,
            StrictItem,
          ),
        ),
      );
      /** `items` behind `pre`, in the one branch of `target` a call tagged `list` leaves failing. */
      const inBranch = (pre: (value: unknown) => unknown) =>
        z.object({
          target: z
            .union([
              z.object({ kind: z.literal('list'), items: z.preprocess(pre, strings) }),
              z.object({ kind: z.literal('one') }),
            ])
            .describe('Target.'),
        });
      const count = { count: z.number().optional().describe('Count.') };
      const Currency = z.enum(['USD', 'EUR']);
      const listOrSplit = z.object({
        codes: z
          .union([
            z.array(Currency),
            z
              .string()
              .transform((text): unknown => text.split(','))
              .pipe(z.array(Currency)),
          ])
          .describe('Currency codes, as a list or comma-joined.'),
      });
      const listOrWrapped = z.object({
        spec: z
          .union([
            z.array(z.string()),
            z.preprocess(
              (value) => (typeof value === 'string' ? { mode: value } : value),
              z.object({ mode: z.enum(['fast', 'slow']) }),
            ),
          ])
          .describe('Names, or a mode.'),
      });
      const listOrJson = z.object({
        ids: z
          .union([
            z.array(z.string()),
            z.preprocess((value) => {
              if (typeof value !== 'string') return value;
              try {
                return JSON.parse(value) as unknown;
              } catch {
                return value;
              }
            }, z.array(z.string())),
          ])
          .describe('IDs, as a list or as JSON text.'),
      });
      const idAsNumber = (index: number) =>
        `ids.${index}: Invalid input: expected string, received number`;

      type Outcome = { accepted: Record<string, unknown> } | { rejected: string };
      const yearAsNumber = 'items.0.year: Invalid input: expected string, received number';
      const elementAsNumber = (index: number) =>
        `items.${index}: Invalid input: expected string, received number`;
      const kindNull = 'items.0.kind: Invalid option: expected one of "a"|"b"';
      const countAsString = 'count: Invalid input: expected number, received string';
      const splitNumbers =
        'tags.0: Invalid input: expected number, received string, ' +
        'tags.1: Invalid input: expected number, received string';

      /**
       * Each call, the outcome a repair written only at Zod's own issue paths
       * in the arguments as sent gave it — 0.13.13's — and the outcome now when
       * that differs. A call that validated that way must validate the same
       * way now: only a rejection may become a success. A call that repair
       * left rejected and a repair in place now validates gets the value the
       * same placement gives the field on its own: `[5]` under a preprocess
       * that doubles numbers reaches the handler as `["5"]`, beside a string
       * sent for a number or inside a union branch alike.
       */
      const rows: Array<[string, z.ZodObject, Record<string, unknown>, Outcome, Outcome?]> = [
        [
          'a wrapped lone object’s integer',
          wrapped,
          { items: { name: 'abc', year: 2020 } },
          { rejected: yearAsNumber },
          { accepted: { items: [{ name: 'abc', year: '2020' }] } },
        ],
        [
          'a list element’s integer',
          wrapped,
          { items: [{ name: 'abc', year: 2020 }] },
          { accepted: { items: [{ name: 'abc', year: '2020' }] } },
        ],
        [
          'a wrapped lone object’s null',
          wrapped,
          { items: { name: 'abc', year: null } },
          { rejected: 'items.0.year: Invalid input: expected string, received null' },
          { accepted: { items: [{ name: 'abc' }] } },
        ],
        [
          'a list element’s null',
          wrapped,
          { items: [{ name: 'abc', kind: null }] },
          { rejected: kindNull },
          { accepted: { items: [{ name: 'abc' }] } },
        ],
        [
          'a stringified lone object',
          wrapped,
          { items: '{"name":"abc"}' },
          { accepted: { items: [{ name: 'abc' }] } },
        ],
        [
          'a list of stringified objects',
          wrapped,
          { items: ['{"name":"abc","year":2020}'] },
          { rejected: 'items.0: Invalid input: expected object, received string' },
        ],
        [
          'a lone object a preprocess adds a key to',
          defaulted,
          { items: { name: 'abc', year: 2020 } },
          { rejected: yearAsNumber },
          { accepted: { items: [{ name: 'abc', year: '2020', kind: 'a' }] } },
        ],
        [
          'a list a preprocess adds a key to',
          defaulted,
          { items: [{ name: 'abc', year: 2020 }] },
          { accepted: { items: [{ name: 'abc', year: '2020', kind: 'a' }] } },
        ],
        [
          'a null in a list a preprocess adds a key to',
          defaulted,
          { items: [{ name: 'abc', year: null }] },
          { rejected: 'items.0.year: Invalid input: expected string, received null' },
          { accepted: { items: [{ name: 'abc', kind: 'a' }] } },
        ],
        [
          'an integer an object preprocess reads beside',
          flagged,
          { filter: { year: 2020 } },
          { accepted: { filter: { year: '2020', explicit: true } } },
        ],
        [
          'a null an object preprocess reads beside',
          flagged,
          { filter: { year: null } },
          { rejected: 'filter.year: Invalid input: expected string, received null' },
        ],
        [
          'a string an object preprocess reads beside',
          flagged,
          { filter: { year: '2020' } },
          { accepted: { filter: { year: '2020', explicit: true } } },
        ],
        ['a reversed list', reversed, { items: [1, 2] }, { accepted: { items: ['2', '1'] } }],
        [
          'a reversed list holding a string',
          reversed,
          { items: [1, 'a'] },
          { rejected: elementAsNumber(1) },
        ],
        [
          'a reversed list led by a string',
          reversed,
          { items: ['a', 1] },
          { rejected: elementAsNumber(0) },
        ],
        ['a reversed one-element list', reversed, { items: [7] }, { accepted: { items: ['7'] } }],
        ['a sorted list', sorted, { items: [45, 123] }, { accepted: { items: ['123', '45'] } }],
        ['a list sorted again', sorted, { items: [10, 9] }, { accepted: { items: ['10', '9'] } }],
        [
          'a sorted list led by a string',
          sorted,
          { items: ['b', 1] },
          { rejected: elementAsNumber(0) },
          { accepted: { items: ['1', 'b'] } },
        ],
        ['a deduplicated list', deduped, { items: [123, '123'] }, { accepted: { items: ['123'] } }],
        [
          'a list deduplicated before the repair',
          deduped,
          { items: [1, 1, 2] },
          { rejected: `${elementAsNumber(0)}, ${elementAsNumber(1)}` },
          { accepted: { items: ['1', '2'] } },
        ],
        [
          'a deduplicated one-element list',
          deduped,
          { items: [5] },
          { accepted: { items: ['5'] } },
        ],
        [
          'a list whose nulls a preprocess fills',
          filled,
          { items: [null, 5] },
          { accepted: { items: ['none', '5'] } },
        ],
        ['a filled one-element list', filled, { items: [5] }, { accepted: { items: ['5'] } }],
        [
          'an integer beside a filled null',
          nullYear,
          { items: [{ name: 'abc', year: 2020 }] },
          { accepted: { items: [{ name: 'abc', year: '2020' }] } },
        ],
        [
          'a null beside a filled null',
          nullYear,
          { items: [{ name: 'abc', kind: null }] },
          { rejected: kindNull },
          { accepted: { items: [{ name: 'abc', year: null }] } },
        ],
        ['a list a preprocess doubles', doubled, { items: [5] }, { accepted: { items: ['5'] } }],
        [
          'a string list a preprocess doubles',
          doubled,
          { items: ['5'] },
          { accepted: { items: ['5'] } },
        ],
        [
          'a mixed list a preprocess doubles',
          doubled,
          { items: [5, 'a'] },
          { accepted: { items: ['5', 'a'] } },
        ],
        ['a list a preprocess marks', banged, { items: [1] }, { accepted: { items: ['1!'] } }],
        [
          'a mixed list a preprocess marks',
          banged,
          { items: ['a', 2] },
          { accepted: { items: ['a!', '2!'] } },
        ],
        [
          'a lone object rebuilt with explicit undefined keys',
          rebuilt,
          { items: { name: 'abc', year: 2020 } },
          { rejected: yearAsNumber },
          { accepted: { items: [{ name: 'abc', year: '2020', kind: undefined }] } },
        ],
        [
          'a null in a list rebuilt with explicit undefined keys',
          rebuilt,
          { items: [{ name: 'abc', kind: null }] },
          { rejected: kindNull },
        ],
        [
          'a list rebuilt with explicit undefined keys',
          rebuilt,
          { items: [{ name: 'abc', year: 2020 }] },
          { accepted: { items: [{ name: 'abc', year: '2020', kind: undefined }] } },
        ],
        [
          'a list a preprocess stamps a fresh Date on',
          stamped,
          { items: [{ name: 'abc', year: 2020 }] },
          { accepted: { items: [{ name: 'abc', year: '2020', at: new Date(0) }] } },
        ],
        [
          'a lone object a preprocess stamps a fresh Date on',
          stamped,
          { items: { name: 'abc', year: 2020 } },
          { rejected: yearAsNumber },
        ],
        [
          'a list a preprocess stamps a Date on once',
          keptDate,
          { items: [{ name: 'abc', year: 2020 }] },
          { accepted: { items: [{ name: 'abc', year: '2020', at: new Date(0) }] } },
        ],
        [
          'a list a preprocess gives a NaN',
          scored,
          { items: [{ name: 'abc', year: 2020 }] },
          { accepted: { items: [{ name: 'abc', year: '2020', score: Number.NaN }] } },
        ],
        [
          'a list a preprocess gives a -0',
          offset,
          { items: [{ name: 'abc', year: 2020 }] },
          { accepted: { items: [{ name: 'abc', year: '2020', off: -0 }] } },
        ],
        [
          'a list a preprocess turns into class instances',
          instances,
          { items: [{ name: 'abc', year: 2020 }] },
          { accepted: { items: [{ name: 'abc', year: '2020' }] } },
        ],
        [
          'a list a preprocess gives a getter',
          getters,
          { items: [{ name: 'abc', year: 2020 }] },
          { accepted: { items: [{ name: 'abc', year: '2020', kind: 'a' }] } },
        ],
        [
          'a list a preprocess spreads out',
          holed,
          { items: [5] },
          { rejected: elementAsNumber(1) },
        ],
        [
          'a list a preprocess turns into cyclic objects',
          cyclic,
          { items: [{ name: 'abc', year: 2020 }] },
          { accepted: { items: [{ name: 'abc', year: '2020' }] } },
        ],
        ['a split list of digits', split, { tags: '1,2' }, { rejected: splitNumbers }],
        ['a split list of words and digits', split, { tags: 'a,2' }, { rejected: splitNumbers }],
        [
          'a number for a split string',
          split,
          { tags: 5 },
          { rejected: 'tags: Invalid input: expected string, received number' },
        ],
        [
          'a lone object a nested preprocess lowercases',
          lowered,
          { items: { name: 'abc', kind: 'A', year: 2020 } },
          { rejected: yearAsNumber },
          { accepted: { items: [{ name: 'abc', year: '2020', kind: 'a' }] } },
        ],
        [
          'a list a nested preprocess lowercases',
          lowered,
          { items: [{ name: 'abc', kind: 'B', year: 2020 }] },
          { accepted: { items: [{ name: 'abc', year: '2020', kind: 'b' }] } },
        ],
        [
          'a reversed list in the one union branch that survives',
          inBranch(reverse),
          { target: { kind: 'list', items: [1, 2] } },
          { rejected: `target.${elementAsNumber(0)}, target.${elementAsNumber(1)}` },
          { accepted: { target: { kind: 'list', items: ['2', '1'] } } },
        ],
        [
          'a list a preprocess doubles in the one union branch that survives',
          inBranch(double),
          { target: { kind: 'list', items: [5] } },
          { rejected: `target.${elementAsNumber(0)}` },
          { accepted: { target: { kind: 'list', items: ['5'] } } },
        ],
        [
          'a reversed list beside a string sent for a number',
          reversed.extend(count),
          { count: '2', items: [1, 2] },
          { rejected: `${elementAsNumber(0)}, ${elementAsNumber(1)}, ${countAsString}` },
          { accepted: { items: ['2', '1'], count: 2 } },
        ],
        [
          'a list a preprocess doubles beside a string sent for a number',
          doubled.extend(count),
          { count: '1', items: [5] },
          { rejected: `${elementAsNumber(0)}, ${countAsString}` },
          { accepted: { items: ['5'], count: 1 } },
        ],
        [
          'a stringified list beside a branch that splits a string',
          listOrSplit,
          { codes: '["USD"]' },
          { accepted: { codes: ['USD'] } },
        ],
        [
          'a stringified empty list beside a branch that splits a string',
          listOrSplit,
          { codes: ' [] ' },
          { accepted: { codes: [] } },
        ],
        [
          'a stringified list beside a branch a preprocess wraps a string for',
          listOrWrapped,
          { spec: '["abc"]' },
          { accepted: { spec: ['abc'] } },
        ],
        [
          'a stringified list beside a branch that splits a string, beside a string sent for a number',
          listOrSplit.extend(count),
          { codes: '["USD"]', count: '3' },
          {
            rejected: `codes.0: Missing required field. Expected one of "USD"|"EUR", ${countAsString}`,
          },
          { accepted: { codes: ['USD'], count: 3 } },
        ],
        [
          'a stringified list beside a branch a preprocess wraps a string for, beside a string sent for a number',
          listOrWrapped.extend(count),
          { spec: '["abc"]', count: '3' },
          {
            rejected: `spec.mode: Missing required field. Expected one of "fast"|"slow", ${countAsString}`,
          },
          { accepted: { spec: ['abc'], count: 3 } },
        ],
        [
          'integers in a list sent as JSON text beside a branch that decodes it',
          listOrJson,
          { ids: '[1, 2]' },
          { rejected: `${idAsNumber(0)}, ${idAsNumber(1)}` },
          { accepted: { ids: ['1', '2'] } },
        ],
        [
          'integers in a list sent as JSON text beside a branch that decodes it, beside a string sent for a number',
          listOrJson.extend(count),
          { ids: '[1, "a"]', count: '3' },
          { rejected: `${idAsNumber(0)}, ${countAsString}` },
          { accepted: { ids: ['1', 'a'], count: 3 } },
        ],
      ];

      it.each(rows)('%s', async (label, input, args, before, now) => {
        // Loosening only: an outcome that was a success never changes.
        if ('accepted' in before) expect(now).toBeUndefined();
        const expected = now ?? before;
        const definition = tool('prevalidation_in_place', {
          description: 'Takes a value a transform reshapes.',
          input,
          output: ok,
          handler: record,
        });

        for (const run of [
          () => call(definition, structuredClone(args)),
          () => runToolContract(definition as AnyToolDefinition, structuredClone(args) as never),
        ]) {
          seen = undefined;
          const result = await run();
          if ('accepted' in expected) {
            expect(result.isError, label).toBeUndefined();
            expect(seen).toEqual(expected.accepted);
          } else {
            expect(result.isError, label).toBe(true);
            expect(envelope(result).message).toBe(
              `Input validation error: Invalid arguments for tool prevalidation_in_place: ${expected.rejected}`,
            );
            expect(seen).toBeUndefined();
          }
        }
      });

      it('keeps the rejection under coerce: false', async () => {
        const definition = tool('prevalidation_in_place', {
          description: 'Takes a value a transform reshapes.',
          input: wrapped,
          output: ok,
          handler: record,
        });

        const result = await call(
          definition,
          { items: { name: 'abc', year: 2020 } },
          { coerce: false },
        );

        expect(envelope(result).message).toContain(yearAsNumber);
      });

      it('counts only the repairs written when the original reading of a union value displaces the lifted branch’s', async () => {
        const definition = tool('prevalidation_in_place', {
          description: 'Takes a value a transform reshapes.',
          input: z.object({
            ids: z
              .union([z.array(z.number()), listOrJson.shape.ids.options[1]])
              .describe('IDs, as numbers or as JSON text of strings.'),
            ...count,
          }),
          output: ok,
          handler: record,
        });

        const result = await call(definition, { ids: '[1, 2]', count: '3' });

        // The decoded list takes the number branch, so the integer repairs the
        // lifted string branch asked for below it are never written.
        expect(result.isError).toBeUndefined();
        expect(seen).toEqual({ ids: [1, 2], count: 3 });
        expect(adds('mcp.input.coerced')).toEqual(
          ['stringified_array', 'string_as_number'].map((kind) => ({
            'mcp.tool.name': 'prevalidation_in_place',
            'mcp.input.coercion': kind,
          })),
        );
      });
    });
  });

  // -----------------------------------------------------------------------
  // A value an author's `.catchall()` governs — read through that schema
  // -----------------------------------------------------------------------

  describe('a value an author-declared .catchall() governs', () => {
    /** Every undeclared key is a station, by ID or by a name its transform looks up. */
    const catchallStations = tool('prevalidation_catchall_stations', {
      description: 'Takes a query and stations under any key.',
      input: z.object({ query: z.string().describe('Search query.') }).catchall(
        z
          .union([z.string(), z.number()])
          .transform((value): number =>
            typeof value === 'string' ? (STATIONS[value] as number) : value,
          )
          .pipe(z.number().int()),
      ),
      output: ok,
      handler: record,
    });

    const catchallCounts = tool('prevalidation_catchall_counts', {
      description: 'Takes a query and a count under any key.',
      input: z.object({ query: z.string().describe('Search query.') }).catchall(z.number()),
      output: ok,
      handler: record,
    });

    const catchallItems = tool('prevalidation_catchall_items', {
      description: 'Takes a query and items, or one item, under any key.',
      input: z
        .object({ query: z.string().describe('Search query.') })
        .catchall(z.preprocess(wrapLone, z.array(PreprocessedItem))),
      output: ok,
      handler: record,
    });

    const catchallRecords = tool('prevalidation_catchall_records', {
      description: 'Takes a query and a strict record under any key.',
      input: z.object({ query: z.string().describe('Search query.') }).catchall(
        z
          .object({
            name: z.string().describe('Name.'),
            note: z.string().optional().describe('Note.'),
          })
          .strict(),
      ),
      output: ok,
      handler: record,
    });

    it('keeps the rejection of a string a catchall value’s own transform could not read', async () => {
      // "15" is a station name the lookup lacks, not station 15.
      await expectOriginalRejection(catchallStations, { query: 'x', north: '15' });
      expect(seen).toBeUndefined();
      expect(adds('mcp.input.coerced')).toEqual([]);
    });

    it('still repairs a string sent for a plain catchall number', async () => {
      const result = await call(catchallCounts, { query: 'x', apples: '15' });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x', apples: 15 });
      expect(adds('mcp.input.coerced')).toEqual([
        {
          'mcp.tool.name': 'prevalidation_catchall_counts',
          'mcp.input.coercion': 'string_as_number',
        },
      ]);
    });

    it('repairs an integer inside the list a catchall value’s preprocess made of a lone object', async () => {
      const result = await call(catchallItems, { query: 'x', extra: { name: 'abc', year: 2020 } });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x', extra: [{ name: 'abc', year: '2020' }] });
    });

    it('names the type a catchall preprocess output received, never a missing field', async () => {
      const result = await call(catchallItems, { query: 'x', extra: { name: 'abc', year: true } });

      expect(envelope(result).data?.recovery?.hint).toBe(
        'Send extra.0.year as a string, not a boolean.',
      );
    });

    it('names the keys a strict catchall object accepts beside one it does not', async () => {
      const result = await call(catchallRecords, { query: 'x', extra: { name: 'a', nmae: 'b' } });

      expect(envelope(result).data?.recovery?.hint).toBe(
        'Unknown key extra.nmae. extra accepts: name, note.',
      );
    });

    it('deletes null at an optional key of a catchall object', async () => {
      const result = await call(catchallRecords, { query: 'x', extra: { name: 'a', note: null } });

      expect(result.isError).toBeUndefined();
      expect(seen).toEqual({ query: 'x', extra: { name: 'a' } });
    });
  });

  // -----------------------------------------------------------------------
  // A value a transform made undefined — asked for only when the caller sent none
  // -----------------------------------------------------------------------

  describe('a value a transform made undefined', () => {
    /** A station by ID, or by a name the lookup knows; any other name becomes `undefined`. */
    const station = () =>
      z
        .union([z.string(), z.number()])
        .transform((value): number =>
          typeof value === 'string' ? (STATIONS[value] as number) : value,
        )
        .pipe(z.number().int());
    const unsettable = tool('prevalidation_unsettable', {
      description: 'Takes values a transform can leave unset.',
      input: z.object({
        year: z
          .preprocess(
            (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
            z.string().regex(/^\d{4}$/),
          )
          .optional()
          .describe('Year.'),
        color: z
          .preprocess((value) => (value === 'r' ? 'red' : undefined), z.enum(['red', 'blue']))
          .optional()
          .describe('Color, or "r" for red.'),
        stations: z
          .preprocess(
            (value) =>
              Array.isArray(value) ? value.map((name) => STATIONS[name as string]) : value,
            z.array(z.number().int()),
          )
          .optional()
          .describe('Station names.'),
        byLabel: z.record(z.string(), station()).optional().describe('Stations by label.'),
        items: z
          .preprocess(
            wrapLone,
            z.array(
              z.object({ name: z.string().describe('Name.'), year: z.string().describe('Year.') }),
            ),
          )
          .optional()
          .describe('Items, or one item.'),
      }),
      output: ok,
      handler: record,
    });
    /** A required field whose preprocess reads `null` as unset: no repair deletes it first. */
    const nullUnset = tool('prevalidation_null_unset', {
      description: 'Takes a code a preprocess reads null as unset.',
      input: z.object({
        code: z
          .preprocess((value) => (value === null ? undefined : value), z.string())
          .describe('Code.'),
      }),
      output: ok,
      handler: record,
    });
    const anyKey = tool('prevalidation_unsettable_catchall', {
      description: 'Takes a query and stations under any key.',
      input: z.object({ query: z.string().describe('Search query.') }).catchall(station()),
      output: ok,
      handler: record,
    });
    /** The factory and the `runToolContract` helper, each on its own copy of `args`. */
    const bothPaths = (definition: AnyToolDefinition, args: Record<string, unknown>) => [
      () => call(definition, structuredClone(args)),
      () => runToolContract(definition, structuredClone(args) as never),
    ];

    it.each([
      [
        'a station name the lookup lacks',
        resolving,
        { station: '15' },
        'station: Invalid input: expected number, received undefined',
      ],
      [
        'a name a typed catchall’s lookup lacks',
        anyKey,
        { query: 'x', north: '15' },
        'north: Invalid input: expected number, received undefined',
      ],
      [
        'a name a record value’s lookup lacks',
        unsettable,
        { byLabel: { north: '15' } },
        'byLabel.north: Invalid input: expected number, received undefined',
      ],
      [
        'a name the lookup in front of an enum lacks',
        unsettable,
        { color: 'x' },
        'color: Invalid option: expected one of "red"|"blue"',
      ],
      [
        'a name a preprocess maps to undefined inside the list it returns',
        unsettable,
        { stations: ['Nowhere'] },
        'stations.0: Invalid input: expected number, received undefined',
      ],
    ])('restates %s instead of asking for it', async (_label, definition, args, line) => {
      for (const run of bothPaths(definition as AnyToolDefinition, args)) {
        const result = await run();

        expect(envelope(result).message).toBe(
          `Input validation error: Invalid arguments for tool ${definition.name}: ${line}`,
        );
        expect(envelope(result).data?.recovery?.hint).toBe(line);
        // The hint only restates the message, so content[] carries no Recovery: line (#459).
        expect(text(result)).not.toContain('Recovery:');
      }
    });

    it.each([
      ['an empty station name', resolving, { station: '' }, 'Provide station.'],
      ['a whitespace-only station name', resolving, { station: ' \t' }, 'Provide station.'],
      ['an omitted station', resolving, {}, 'Provide station.'],
      ['a blank a preprocess maps to unset', unsettable, { year: '' }, 'Provide year.'],
      ['a null a preprocess maps to unset', nullUnset, { code: null }, 'Provide code.'],
      ['an empty name under a typed catchall', anyKey, { query: 'x', north: '' }, 'Provide north.'],
      [
        'a field the lone object a preprocess wraps leaves out',
        unsettable,
        { items: { name: 'abc' } },
        'Provide items.0.year.',
      ],
    ])('asks for %s', async (_label, definition, args, expected) => {
      for (const run of bothPaths(definition as AnyToolDefinition, args)) {
        const result = await run();

        expect(envelope(result).data?.recovery?.hint).toBe(expected);
        expect(text(result)).toContain(`Recovery: ${expected}`);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Repair cost — linear in the values the rejection names
  // -----------------------------------------------------------------------

  describe('repair cost', () => {
    const strings = tool('prevalidation_string_ids', {
      description: 'Takes a list of string IDs.',
      input: z.object({ ids: z.array(z.string()).describe('IDs.') }),
      output: ok,
      handler: record,
    });
    const numbers = tool('prevalidation_number_ids', {
      description: 'Takes a list of numeric IDs.',
      input: z.object({ ids: z.array(z.number()).describe('IDs.') }),
      output: ok,
      handler: record,
    });
    const groups = tool('prevalidation_id_groups', {
      description: 'Takes a list of ID groups.',
      input: z.object({ ids: z.array(z.array(z.string())).describe('ID groups.') }),
      output: ok,
      handler: record,
    });
    /** String IDs beside a count, so one call can need the original repair and a newer one. */
    const counted = tool('prevalidation_counted_ids', {
      description: 'Takes a list of string IDs and a count.',
      input: z.object({
        ids: z.array(z.string()).describe('IDs.'),
        count: z.number().describe('Count.'),
      }),
      output: ok,
      handler: record,
    });
    const rows = tool('prevalidation_noted_rows', {
      description: 'Takes rows with an optional note.',
      input: z.object({
        ids: z
          .array(
            z.object({
              id: z.number().describe('ID.'),
              note: z.string().optional().describe('Note.'),
            }),
          )
          .describe('Rows.'),
      }),
      output: ok,
      handler: record,
    });
    const digits = tool('prevalidation_digit_ids', {
      description: 'Takes a list of all-digit IDs.',
      input: z.object({ ids: z.array(z.string().regex(/^\d+$/).describe('ID.')).describe('IDs.') }),
      output: ok,
      handler: record,
    });
    const oneOrMany = tool('prevalidation_one_or_many_ids', {
      description: 'Takes one ID or a list of IDs.',
      input: z.object({ ids: OneOrManyIds.describe('One ID or several.') }),
      output: ok,
      handler: record,
    });
    const taggedIds = tool('prevalidation_tagged_ids', {
      description: 'Takes IDs under a tag.',
      input: z.object({
        target: z
          .union([
            z.object({
              kind: z.literal('a').describe('Kind.'),
              ids: z.array(z.string()).describe('IDs.'),
            }),
            z.object({
              kind: z.literal('b').describe('Kind.'),
              ids: z.array(z.number()).describe('IDs.'),
            }),
          ])
          .describe('Tagged IDs.'),
      }),
      output: ok,
      handler: record,
    });
    const taggedList = tool('prevalidation_tagged_list', {
      description: 'Takes a list of tagged targets.',
      input: z.object({
        targets: z
          .array(
            z.union([
              z.object({ kind: z.literal('a').describe('Kind.'), id: z.string().describe('ID.') }),
              z.object({ kind: z.literal('b').describe('Kind.') }),
            ]),
          )
          .describe('Targets.'),
      }),
      output: ok,
      handler: record,
    });
    const plainTagList = tool('prevalidation_plain_tag_list', {
      description: 'Takes a list of literal-tagged targets.',
      input: z.object({
        targets: z
          .array(
            z.union([
              z.object({ kind: z.literal(1).describe('Kind.'), id: z.string().describe('ID.') }),
              z.object({ kind: z.literal(2).describe('Kind.') }),
            ]),
          )
          .describe('Targets.'),
      }),
      output: ok,
      handler: record,
    });
    /** Two branches that each fail on their tag and on every element of a list only they declare. */
    const wideTags = tool('prevalidation_wide_tags', {
      description: 'Takes one of two tagged targets, each with its own list of zeros.',
      input: z.object({
        target: z
          .union([
            z.object({
              kind: z.literal(1).describe('Kind.'),
              v: z.array(z.literal(0)).optional().describe('Zeros.'),
            }),
            z.object({
              kind: z.literal(2).describe('Kind.'),
              w: z.array(z.literal(0)).optional().describe('Zeros.'),
            }),
          ])
          .describe('Target.'),
      }),
      output: ok,
      handler: record,
    });
    /** A tree node: a child of its own kind, and leaves with an optional note. */
    const TreeNode: z.ZodType = z.lazy(() =>
      z.object({
        child: TreeNode.optional().describe('Child node.'),
        leaves: z
          .array(
            z.object({
              id: z.number().describe('ID.'),
              note: z.string().optional().describe('Note.'),
            }),
          )
          .optional()
          .describe('Leaves.'),
      }),
    );
    const tree = tool('prevalidation_tree', {
      description: 'Takes a tree of noted leaves.',
      input: z.object({ root: TreeNode.describe('Root node.') }),
      output: ok,
      handler: record,
    });
    /** A list behind a preprocess that copies it, so each re-run of it costs the list's length. */
    const copied = tool('prevalidation_copied_rows', {
      description: 'Takes rows, or one row, behind a copying preprocess.',
      input: z.object({
        ids: z
          .preprocess(
            (value) => (Array.isArray(value) ? [...value] : [value]),
            z.array(z.object({ id: z.string().describe('ID.') })),
          )
          .describe('Rows.'),
      }),
      output: ok,
      handler: record,
    });
    /** Queries, each a JSON object with a one-value format or a list of terms. */
    const formatted = tool('prevalidation_formatted_queries', {
      description: 'Takes queries, each an object or a list of terms.',
      input: z.object({
        queries: z
          .array(
            z.union([
              z.object({
                format: z.enum(['json']).describe('Format.'),
                q: z.string().describe('Q.'),
              }),
              z.array(z.string()),
            ]),
          )
          .describe('Queries.'),
      }),
      output: ok,
      handler: record,
    });
    /** A list behind a preprocess that reverses it, so a repair holds only written in place. */
    const reversed = tool('prevalidation_reversed_ids', {
      description: 'Takes IDs behind a reversing preprocess.',
      input: z.object({
        ids: z
          .preprocess(
            (value) => (Array.isArray(value) ? [...value].reverse() : value),
            z.array(z.string().describe('ID.')),
          )
          .describe('IDs.'),
      }),
      output: ok,
      handler: record,
    });
    /**
     * Lists of currency codes, each a list or comma-joined text, beside a count:
     * a stringified list needs the original repair beside the count's.
     */
    const splitLists = tool('prevalidation_split_lists', {
      description: 'Takes code lists, each a list or comma-joined, and a count.',
      input: z.object({
        lists: z
          .array(
            z.union([
              z.array(z.enum(['USD', 'EUR'])),
              z
                .string()
                .transform((text): unknown => text.split(','))
                .pipe(z.array(z.enum(['USD', 'EUR']))),
            ]),
          )
          .describe('Code lists.'),
        count: z.number().describe('Count.'),
      }),
      output: ok,
      handler: record,
    });
    /**
     * IDs as a list or as JSON text a preprocess decodes, beside a count:
     * integers in the text need the decoded branch's repairs, not the original one.
     */
    const jsonIds = tool('prevalidation_json_ids', {
      description: 'Takes IDs, as a list or as JSON text, and a count.',
      input: z.object({
        ids: z
          .union([
            z.array(z.string()),
            z.preprocess((value) => {
              if (typeof value !== 'string') return value;
              try {
                return JSON.parse(value) as unknown;
              } catch {
                return value;
              }
            }, z.array(z.string())),
          ])
          .describe('IDs, as a list or as JSON text.'),
        count: z.number().describe('Count.'),
      }),
      output: ok,
      handler: record,
    });
    /**
     * `n` distinct keys of one length that all case-fold to `query`: `query`
     * followed by `i` in binary, spelled in `-` and `_`. `prefix` leads each one.
     */
    const queryVariants = (n: number, prefix: string): Record<string, unknown> =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `${prefix}query${i.toString(2).padStart(17, '0').replaceAll('0', '-').replaceAll('1', '_')}`,
          'y',
        ]),
      );
    /** `leaves` under a chain of 20 `child` nodes. */
    const deepLeaves = (leaves: unknown[]): unknown => {
      let node: Record<string, unknown> = { leaves };
      for (let level = 0; level < 20; level++) node = { child: node };
      return { root: node };
    };

    /** The fastest thread-CPU milliseconds of three runs of `run`. */
    const cost = (run: () => void): number => {
      let best = Number.POSITIVE_INFINITY;
      for (let sample = 0; sample < 3; sample++) {
        const start = process.threadCpuUsage();
        run();
        const { user, system } = process.threadCpuUsage(start);
        best = Math.min(best, (user + system) / 1000);
      }
      return Math.max(best, 0.001);
    };

    /** `parseToolArguments` over `args(n)`, swallowing the rejection a rejected call throws. */
    const parseCost = (definition: AnyToolDefinition, args: (n: number) => unknown, n: number) => {
      const built = args(n);
      return cost(() => {
        try {
          parseToolArguments(definition, built);
        } catch {
          // A rejected call is timed through its whole rejection.
        }
      });
    };

    it.each([
      [
        'integers sent for strings',
        strings,
        (n: number) => ({ ids: Array.from({ length: n }, (_, i) => i) }),
        'accepted',
      ],
      [
        'integers sent for strings beside a string sent for a number, past the original repair',
        counted,
        (n: number) => ({ ids: Array.from({ length: n }, (_, i) => i), count: '5' }),
        'accepted',
      ],
      [
        'integers sent for strings beside a count no repair reads, the original repair parsed once',
        counted,
        (n: number) => ({ ids: Array.from({ length: n }, (_, i) => i), count: 'many' }),
        'rejected',
      ],
      [
        'numbers sent as strings (#707)',
        numbers,
        (n: number) => ({ ids: Array.from({ length: n }, (_, i) => String(i)) }),
        'accepted',
      ],
      [
        'lone strings sent for lists (#602)',
        groups,
        (n: number) => ({ ids: Array.from({ length: n }, (_, i) => `id${i}`) }),
        'accepted',
      ],
      [
        'nulls sent for optional fields (#616)',
        rows,
        (n: number) => ({ ids: Array.from({ length: n }, (_, i) => ({ id: i, note: null })) }),
        'accepted',
      ],
      [
        'nulls sent for optional fields 20 levels into a recursive schema (#616)',
        tree,
        (n: number) => deepLeaves(Array.from({ length: n }, (_, i) => ({ id: i, note: null }))),
        'accepted',
      ],
      [
        'booleans the rejection reports',
        strings,
        (n: number) => ({ ids: Array.from({ length: n }, () => true) }),
        'rejected',
      ],
      [
        'repairs that split between held and not (#706)',
        digits,
        // Every odd integer's digits hold; every negative one's `-` fails the pattern.
        (n: number) => ({ ids: Array.from({ length: n }, (_, i) => (i % 2 ? i : -i - 1)) }),
        'rejected',
      ],
      [
        'integers inside the one union branch that survives (#570)',
        oneOrMany,
        (n: number) => ({ ids: Array.from({ length: n }, (_, i) => i) }),
        'accepted',
      ],
      [
        'booleans inside the one union branch that survives (#570)',
        oneOrMany,
        (n: number) => ({ ids: Array.from({ length: n }, () => true) }),
        'rejected',
      ],
      [
        'integers inside a tagged branch beside a branch dropped on its tag (#570)',
        taggedIds,
        (n: number) => ({ target: { kind: 'a', ids: Array.from({ length: n }, (_, i) => i) } }),
        'accepted',
      ],
      [
        'unknown tags across a list of tagged targets, each named with every tag',
        taggedList,
        (n: number) => ({ targets: Array.from({ length: n }, () => ({ kind: 'c', id: 'x' })) }),
        'rejected',
      ],
      [
        'quoted tags across a list of discriminated-union targets (#714)',
        tagList,
        (n: number) => ({ items: Array.from({ length: n }, () => ({ kind: '1', id: 'x' })) }),
        'accepted',
      ],
      [
        'quoted tags across a list of literal-tagged union targets (#714)',
        plainTagList,
        (n: number) => ({ targets: Array.from({ length: n }, () => ({ kind: '1', id: 'x' })) }),
        'accepted',
      ],
      [
        'an unknown tag beside n literal issues in each branch at paths the other lacks (#714)',
        wideTags,
        (n: number) => ({
          target: {
            kind: '3',
            v: Array.from({ length: n }, () => 1),
            w: Array.from({ length: n }, () => 1),
          },
        }),
        'rejected',
      ],
      [
        'a one-value field left out of every object in a list of object-or-list unions',
        formatted,
        (n: number) => ({ queries: Array.from({ length: n }, (_, i) => ({ q: `q${i}` })) }),
        'rejected',
      ],
      [
        'integers inside one z.preprocess output (#599)',
        copied,
        (n: number) => ({ ids: Array.from({ length: n }, (_, i) => ({ id: i })) }),
        'accepted',
      ],
      [
        'booleans inside one z.preprocess output (#599)',
        copied,
        (n: number) => ({ ids: Array.from({ length: n }, () => ({ id: true })) }),
        'rejected',
      ],
      [
        'integers in a list a preprocess reverses, repaired in place (#599)',
        reversed,
        (n: number) => ({ ids: Array.from({ length: n }, (_, i) => i) }),
        'accepted',
      ],
      [
        'objects beside integers in a list a preprocess reverses, both placements tried (#599)',
        reversed,
        (n: number) => ({ ids: Array.from({ length: n }, (_, i) => (i % 2 ? i : {})) }),
        'rejected',
      ],
      [
        'stringified lists beside a branch that splits a string, beside a string sent for a number',
        splitLists,
        (n: number) => ({ lists: Array.from({ length: n }, () => '["USD"]'), count: '3' }),
        'accepted',
      ],
      [
        'integers in a list sent as JSON text beside a branch that decodes it, beside a string sent for a number',
        jsonIds,
        (n: number) => ({
          ids: JSON.stringify(Array.from({ length: n }, (_, i) => i)),
          count: '3',
        }),
        'accepted',
      ],
      [
        'booleans beside integers in a list sent as JSON text beside a branch that decodes it',
        jsonIds,
        (n: number) => ({
          ids: JSON.stringify(Array.from({ length: n }, (_, i) => (i % 2 ? i : true))),
          count: '3',
        }),
        'rejected',
      ],
      [
        'case-style variants of a key sent beside it (#639)',
        search,
        (n: number) => ({ query: 'x', ...queryVariants(n, '') }),
        'rejected',
      ],
      [
        'underscore variants of a key the drop discarded beside it (#639)',
        search,
        (n: number) => ({ query: 'x', maxResults: 'z', ...queryVariants(n, '_') }),
        'rejected',
      ],
    ] as const)(
      'handles %s in time linear in their count',
      (_label, definition, args, outcome) => {
        // The timed runs swallow a rejection, so the outcome is pinned once first.
        const parse = () => parseToolArguments(definition, args(5_000));
        if (outcome === 'accepted') expect(parse).not.toThrow();
        else expect(parse).toThrow(/Invalid arguments/);

        parseCost(definition, args, 5_000);
        const at5k = parseCost(definition, args, 5_000);
        const at20k = parseCost(definition, args, 20_000);
        const at80k = parseCost(definition, args, 80_000);

        // 16× the values: linear is ~16×, a copy of the arguments per value ~256×.
        expect(at80k / at5k).toBeLessThan(64);
        expect(at20k / at5k).toBeLessThan(12);
        // Under 1.6 s on Bun and Node, coverage included, the 20-level tree the
        // slowest (80,000 nulls 20 levels deep); one copy per value took 8 s.
        expect(at80k).toBeLessThan(4_000);
      },
      120_000,
    );

    it('never case-folds the keys the drop discarded from a call the first parse validates (#639)', () => {
      // Folding a key costs its length; 200 keys of 20,000 characters make that visible.
      const args = Object.fromEntries([
        ['query', 'x'],
        ...Array.from({ length: 200 }, (_, i) => [`_${i}${'A-b_'.repeat(5_000)}`, i]),
      ]);
      const parse = (input?: InputHandlingOptions) =>
        cost(() => parseToolArguments(search, args, input ? { input } : {}));
      expect(parseToolArguments(search, args)).toEqual({ query: 'x' });

      parse();
      // With case-style aliases off nothing is folded: the two cost about the same,
      // where folding every discarded key cost ~90× more.
      expect(parse() / parse({ caseStyleAliases: false })).toBeLessThan(8);
    });

    it('hands the handler every repaired value', () => {
      const ids = Array.from({ length: 80_000 }, (_, i) => i);

      expect(parseToolArguments(strings, { ids })).toEqual({ ids: ids.map(String) });
    });

    it('rejects with every value whose repair did not hold, and none whose repair did', () => {
      const ids = Array.from({ length: 80_000 }, (_, i) => (i % 2 ? i : -i - 1));
      const rejection = (() => {
        try {
          parseToolArguments(digits, { ids });
        } catch (error) {
          return error as {
            data: { issues: Array<{ path: PropertyKey[] }>; issuesCount: number };
          };
        }
        throw new Error('Expected a rejection.');
      })();
      const paths = rejection.data.issues.map((issue) => issue.path);

      // The 40,000 values whose repair did not hold, of which a rejection carries the first 10 (#648).
      expect(rejection.data.issuesCount).toBe(40_000);
      expect(paths).toEqual(Array.from({ length: 10 }, (_, i) => ['ids', 2 * i]));
    });

    it('rejects a value 500 levels into a recursive union at about the cost of the parse', () => {
      /** A filter tree whose every level is a discriminated union. */
      const Filter: z.ZodType = z.lazy(() =>
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('leaf'), value: z.string().describe('Value.') }),
          z.object({ type: z.literal('not'), filter: Filter }),
        ]),
      );
      const filtered = tool('prevalidation_filter_tree', {
        description: 'Takes a filter tree.',
        input: z.object({ where: Filter.describe('Filter.') }),
        output: ok,
        handler: record,
      });
      /**
       * Zod's own parse of this tree exhausts a default stack between 1,000 and
       * 1,500 levels on Node and Bun alike, before any framework code runs, so
       * the depth stays well under that. `argumentAt`'s own walk is pinned
       * linear at 2,000 levels in `schemaShape.test.ts`.
       */
      let where: Record<string, unknown> = { type: 'leaf', value: 2.5 };
      for (let level = 0; level < 500; level++) where = { type: 'not', filter: where };
      const args = { where };

      // The issue line is cut at its first 1,024 characters (#648), mid-path.
      expect(() => parseToolArguments(filtered, args)).toThrow(/: where(\.filter){145}\.fil…$/);
      const parse = cost(() => filtered.input.safeParse(args));
      const rejection = parseCost(filtered, () => args, 0);

      // Reading the leaf's path for the repair, the message, and the hint once
      // each cost ~70× the parse at 2,000 levels, a ratio that grows with the
      // depth, when every union re-walked the rest of the path.
      expect(rejection / parse).toBeLessThan(10);
    });

    it('rejects a value 800 levels into a plain recursive union, each level lifted past a tag, at about the cost of the parse', () => {
      /** Every level keeps its `not` branch and drops the `eq` branch, which failed on its tag alone. */
      const Not: z.ZodType = z.lazy(() =>
        z.union([
          z.object({ op: z.literal('not'), filter: Not }),
          z.object({ op: z.literal('eq'), value: z.string().optional() }),
        ]),
      );
      const negated = tool('prevalidation_negated_filter', {
        description: 'Takes a chain of negated filters.',
        input: z.object({ where: Not.describe('Filter.') }),
        output: ok,
        handler: record,
      });
      let where: Record<string, unknown> = { op: 'eq', value: 2.5 };
      for (let level = 0; level < 800; level++) where = { op: 'not', filter: where };
      const args = { where };

      expect(() => parseToolArguments(negated, args)).toThrow(/: where(\.filter){145}\.fil…$/);
      const parse = cost(() => negated.input.safeParse(args));
      const rejection = parseCost(negated, () => args, 0);

      // ~29× the parse when each lifted level re-read the full path of every entry below it.
      expect(rejection / parse).toBeLessThan(16);
    });

    describe('a recursive union whose branches share one clause list (#648)', () => {
      /**
       * Its `and` and `or` branches both parse the same clause list, and Zod
       * parses each clause once and lists the clause's issues under both, so a
       * bad leaf's issue tree is 2^depth issues wide while its distinct issues
       * grow with the depth.
       */
      const Filter: z.ZodType = z.lazy(() =>
        z.union([
          z.object({ op: z.literal('and'), filters: z.array(Filter) }),
          z.object({ op: z.literal('or'), filters: z.array(Filter) }),
          z.object({ op: z.literal('eq'), field: z.string(), value: z.string() }),
        ]),
      );
      const filtered = tool('prevalidation_shared_filter', {
        description: 'Takes a filter of nested clauses.',
        input: z.object({ where: Filter.describe('Filter.') }),
        output: ok,
        handler: record,
      });

      /** One bad leaf, `value: 5`, under `depth` levels alternating `or` and `and`. */
      const nested = (depth: number): Record<string, unknown> => {
        let node: unknown = { op: 'eq', field: 'name', value: 5 };
        for (let level = 0; level < depth; level++) {
          node = { op: level % 2 ? 'and' : 'or', filters: [node] };
        }
        return { where: node };
      };

      /** The full path of `key` in {@link nested}'s leaf. */
      const leaf = (depth: number, key: string): PropertyKey[] => [
        'where',
        ...Array.from({ length: depth }, () => ['filters', 0]).flat(),
        key,
      ];

      /** {@link heldRepairs} of one repair at `path`, against the issues of {@link nested}. */
      const held = (depth: number, path: PropertyKey[]) => {
        const issues = filtered.input.safeParse(nested(depth)).error?.issues ?? [];
        const repair: Repair = { kind: 'integer_as_string', path, sent: 5, value: '5' };
        return heldRepairs([repair], issues);
      };

      it('finds a repair at the leaf broken and one beside it held, through every level', () => {
        expect(held(12, leaf(12, 'value'))).toEqual([]);
        expect(held(12, leaf(12, 'field'))).toHaveLength(1);
      });

      it('checks a repair at the leaf in time linear in the depth', () => {
        const costs: number[] = [];
        for (const depth of [8, 12, 16, 20, 24]) {
          const issues = filtered.input.safeParse(nested(depth)).error?.issues ?? [];
          const repairs: Repair[] = [
            { kind: 'integer_as_string', path: leaf(depth, 'field'), sent: 5, value: '5' },
          ];
          // 200 checks a sample, so the shallowest depth's cost sits well above the timer's noise.
          const spent = cost(() => {
            for (let check = 0; check < 200; check++) heldRepairs(repairs, issues);
          });
          // Checked per depth, so a walk that doubles per level fails at 20 rather than running on.
          expect(spent, `depth ${depth}`).toBeLessThan(25);
          costs.push(spent);
        }

        // 3× the depth: linear is ~3×, quadratic 9×, a walk of every path 65,536×.
        expect(costs[4]! / costs[0]!).toBeLessThan(6);
      });

      it('rejects one bad leaf at about the cost of the parse at every depth to 24', () => {
        for (const depth of [8, 12, 16, 20, 24]) {
          const args = nested(depth);
          const parse = cost(() => filtered.input.safeParse(args));
          const rejection = parseCost(filtered, () => args, 0);
          // Checked per depth, so a rejection that doubles per level fails at 16 rather than running on.
          expect(rejection, `depth ${depth}`).toBeLessThan(100);
          expect(rejection / parse, `depth ${depth}`).toBeLessThan(40);
        }
      });
    });

    describe('a recursive union whose options both hold the clause list', () => {
      /**
       * No tag tells the options apart, so every level's path can be walked
       * through either. Zod hands back a check failure (`too_small`) or an
       * unknown key, which never aborts a branch, directly through every level
       * as one issue at the leaf's full path, where the rejection's every read
       * of the path walks the unions itself.
       */
      const Clause: z.ZodType = z.lazy(() =>
        z.union([
          z
            .object({
              all: z.array(Clause).optional(),
              v: z.string().min(3).optional(),
            })
            .strict(),
          z.object({ all: z.array(Clause), w: z.number() }),
        ]),
      );
      const clauses = tool('prevalidation_clause_tree', {
        description: 'Takes a tree of clauses.',
        input: z.object({ where: Clause.describe('Clauses.') }),
        output: ok,
        handler: record,
      });
      /** `leaf` under `depth` levels of `all`. */
      const nested = (depth: number, leaf: Record<string, unknown>): Record<string, unknown> => {
        let node = leaf;
        for (let level = 0; level < depth; level++) node = { all: [node] };
        return { where: node };
      };

      it.each([
        ['a check failure', { v: 'ab' }, /\.v: Too small: expected string to have >=3 characters$/],
        ['an unknown key', { x: 1 }, /: Unrecognized key: "x"$/],
      ])(
        'rejects %s at the leaf at about the cost of the parse at every depth to 24',
        (_label, leaf, line) => {
          for (const depth of [8, 12, 16, 20, 24]) {
            const args = nested(depth, leaf);
            const parse = cost(() => clauses.input.safeParse(args));
            const rejection = parseCost(clauses, () => args, 0);
            // Checked per depth, so a walk that doubles per level fails by 16 rather than running on.
            expect(rejection, `depth ${depth}`).toBeLessThan(100);
            expect(rejection / parse, `depth ${depth}`).toBeLessThan(40);
          }
          expect(() => parseToolArguments(clauses, nested(24, leaf))).toThrow(line);
        },
      );
    });
  });

  describe('cost of a call valid as sent', () => {
    const paged = tool('prevalidation_paged_search', {
      description: 'Searches one page.',
      input: z.object({
        query: z.string().describe('Search query.'),
        pageSize: z.number().int().optional().describe('Page size.'),
        sort: z.string().optional().describe('Sort order.'),
      }),
      inputAliases: { maxResults: 'pageSize', q: 'query' },
      output: ok,
      handler: record,
    });

    /**
     * The fastest thread-CPU milliseconds of each of `runs`, over five rounds
     * that alternate which one goes first.
     */
    const fastest = (...runs: Array<() => void>): number[] => {
      const best = runs.map(() => Number.POSITIVE_INFINITY);
      for (let round = 0; round < 5; round++) {
        const order = round % 2 ? [...runs.keys()].reverse() : [...runs.keys()];
        for (const index of order) {
          const start = process.threadCpuUsage();
          runs[index]?.();
          const { user, system } = process.threadCpuUsage(start);
          best[index] = Math.min(best[index] ?? Number.POSITIVE_INFINITY, (user + system) / 1000);
        }
      }
      return best.map((ms) => Math.max(ms, 0.001));
    };

    it('adds little to the parse when every key is one the tool declares', () => {
      const args = { query: 'x', pageSize: 5, sort: 'a' };
      const calls = 20_000;
      expect(parseToolArguments(paged, args)).toEqual(args);

      const [parse = 0, through = 0] = fastest(
        () => {
          for (let i = 0; i < calls; i++) paged.input.safeParse(args);
        },
        () => {
          for (let i = 0; i < calls; i++) parseToolArguments(paged, args);
        },
      );

      // ~1.8× the parse on Bun and Node, ~2.6× under coverage; ~6× when such a
      // call still ran both key stages and built the repair's transform cache.
      expect(through / parse).toBeLessThan(4);
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
          `(reason invalid_arguments · request ${envelope(result).data?.requestId})`,
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
        'requestId',
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
      ['a repaired number and boolean (#707)', scalars, { maxResults: '15', freeFullText: 'true' }],
      ['a lone string for a list (#602)', lists, { parkCode: 'yell' }],
      ['null for optional fields (#616)', nullable, { query: 'x', sort: null, limit: null }],
      ['a quoted discriminator (#714)', tagField, { s: { kind: '1', id: 'x' } }],
      ['a quoted literal tag (#714)', plainTag, { target: { kind: '1', id: '7' } }],
    ])('succeeds through the helper for %s', async (_label, def, args) => {
      const production = await call(def, args as Record<string, unknown>);
      const viaProduction = seen;
      seen = undefined;
      const helper = await runToolContract(def as AnyToolDefinition, args as never);

      expect(helper.isError).toBeUndefined();
      expect(production.isError).toBeUndefined();
      expect(seen).toEqual(viaProduction);
    });

    // The helper adds no request id (#576); the production side drops its own
    // before each comparison.
    it('publishes the production envelope when the step cannot rescue the call', async () => {
      const production = withoutRequestId(await call(search, { query: 'x', salt: true }));
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
      ['a discarded number repair (#707)', scalars, { rank: '0' }],
      ['a refused string branch (#707)', scalars, { limitOrAuto: '15' }],
      ['a comma-joined string for a list (#602)', lists, { parkCode: 'yell,grca' }],
      ['a discarded list wrap (#602)', lists, { letters: 'c' }],
      ['null for a required field (#616)', nullable, { query: null, sort: null }],
      ['a declared underscore alias both orders reject (#563)', underscoreFloor, { _q: 'ab' }],
      ['repairs that held beside a real failure (#706)', cappedPmids, { pmids: FOURTEEN_PMIDS }],
      [
        'a held repair beside one that did not hold (#706)',
        numericIds,
        { stationId: 5, date: 20260922, days: 'never' },
      ],
      ['a quoted tag no variant takes (#714)', tagField, { s: { kind: '3', id: 'x' } }],
      ['a held tag repair beside a second slip (#714)', tagField, { s: { kind: '1', id: 7 } }],
    ])('publishes the production envelope for %s', async (_label, def, args) => {
      const production = withoutRequestId(await call(def, args as Record<string, unknown>));
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

    it('renders a call rescued by the number and boolean repairs on both surfaces', async () => {
      const formatted = tool('prevalidation_formatted_page', {
        description: 'Formats the page it was asked for.',
        input: z.object({
          maxResults: z.number().int().describe('Page size.'),
          freeFullText: z.boolean().describe('Free full text only.'),
        }),
        output: z.object({
          pageSize: z.number().describe('Page size.'),
          freeOnly: z.boolean().describe('Free full text only.'),
        }),
        handler: (input) => {
          const { maxResults, freeFullText } = input as {
            freeFullText: boolean;
            maxResults: number;
          };
          return { pageSize: maxResults * 2, freeOnly: !freeFullText };
        },
        format: (result) => {
          const { pageSize, freeOnly } = result as { freeOnly: boolean; pageSize: number };
          return [{ type: 'text', text: `**${pageSize} per page**, free only: ${freeOnly}` }];
        },
      });

      // Arithmetic and negation prove the handler received a number and a boolean.
      const result = await call(formatted, { maxResults: '15', freeFullText: 'false' });

      expect(result.structuredContent).toEqual({ pageSize: 30, freeOnly: true });
      expect(result.content).toEqual([{ type: 'text', text: '**30 per page**, free only: true' }]);
    });

    it('renders a call rescued by the list wrap on both surfaces', async () => {
      const formatted = tool('prevalidation_formatted_parks', {
        description: 'Formats the parks it was asked for.',
        input: z.object({ parkCode: z.array(z.string()).describe('Park codes.') }),
        output: z.object({
          count: z.number().describe('How many park codes arrived.'),
          first: z.string().describe('The first park code.'),
        }),
        handler: (input) => {
          const { parkCode } = input as { parkCode: string[] };
          return { count: parkCode.length, first: parkCode[0] ?? '' };
        },
        format: (result) => {
          const { count, first } = result as { count: number; first: string };
          return [{ type: 'text', text: `**${count} park**, first: ${first}` }];
        },
      });

      const result = await call(formatted, { parkCode: 'yell' });

      expect(result.structuredContent).toEqual({ count: 1, first: 'yell' });
      expect(result.content).toEqual([{ type: 'text', text: '**1 park**, first: yell' }]);
    });

    it('renders a call rescued by deleting null on both surfaces', async () => {
      const formatted = tool('prevalidation_formatted_sort', {
        description: 'Formats the sort and page size it resolved.',
        input: z.object({
          sort: z.enum(['relevance', 'date']).default('relevance').describe('Sort order.'),
          limit: z.number().int().default(10).describe('Page size.'),
        }),
        output: z.object({
          sort: z.string().describe('Resolved sort order.'),
          limit: z.number().describe('Resolved page size.'),
        }),
        handler: (input) => input as { limit: number; sort: string },
        format: (result) => {
          const { sort, limit } = result as { limit: number; sort: string };
          return [{ type: 'text', text: `**${limit}** by ${sort}` }];
        },
      });

      const result = await call(formatted, { sort: null, limit: null });

      expect(result.structuredContent).toEqual({ sort: 'relevance', limit: 10 });
      expect(result.content).toEqual([{ type: 'text', text: '**10** by relevance' }]);
    });

    it('renders a call rescued by a tag repair on both surfaces (#714)', async () => {
      const formatted = tool('prevalidation_formatted_tag', {
        description: 'Formats the target kind it resolved.',
        input: z.object({ s: NumericTagged.describe('Target.') }),
        output: z.object({
          kind: z.number().describe('Resolved kind.'),
          next: z.number().describe('The kind after it.'),
        }),
        handler: (input) => {
          const { kind } = (input as { s: { kind: number } }).s;
          return { kind, next: kind + 1 };
        },
        format: (result) => {
          const { kind, next } = result as { kind: number; next: number };
          return [{ type: 'text', text: `**kind ${kind}**, next ${next}` }];
        },
      });

      // Arithmetic proves the handler received a number: `"1" + 1` would be `"11"`.
      const result = await call(formatted, { s: { kind: '1', id: 'x' } });

      expect(result.structuredContent).toEqual({ kind: 1, next: 2 });
      expect(result.content).toEqual([{ type: 'text', text: '**kind 1**, next 2' }]);
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
  // Nothing advertised moves (#468, #479, #487, #563, #707, #602, #616, #714)
  // -----------------------------------------------------------------------

  describe('tools/list', () => {
    const probes = [
      underscoreAliased,
      minTarget,
      objecty,
      numericIds,
      unionRoot,
      scalars,
      lists,
      nullable,
      nullableUnion,
      tagField,
      tagList,
      tagRoot,
      plainTag,
    ];

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

/**
 * @fileoverview What a `ZodError` a server raises itself reads like on the wire
 * (#620). The production tool, resource, and prompt registries sit behind a
 * real `McpServer` and an in-memory client, and every surface that funnels a
 * `ZodError` through `formatZodErrorMessage` — a resource `params` rejection, a
 * tool handler's own parse, `ctx.state.get(key, schema)`, a prompt's
 * `generate()`, and `runToolContract` — leads with the dotted path:
 * `recid: A recid is digits, such as 6004.`. The code stays `ValidationError`
 * and `data.issues` is Zod's own list while it is within the caps; past them it
 * keeps the first 10 issues with `issuesCount` beside them, on every one of
 * those surfaces and in no log record whole (#710). The error record carries the
 * one-line summary in its stack header and cause chain, never the issue list
 * (#736). The tool argument rejection renders through its own path and is
 * pinned unchanged beside them.
 * @module tests/unit/utils/internal/error-handler/formatZodErrorMessage.wire
 */

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { type CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { PromptRegistry } from '@/mcp-server/prompts/prompt-registration.js';
import { prompt } from '@/mcp-server/prompts/utils/promptDefinition.js';
import { ResourceRegistry } from '@/mcp-server/resources/resource-registration.js';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { ToolRegistry } from '@/mcp-server/tools/tool-registration.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { runToolContract } from '@/testing/index.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';

const RECID_RULE = 'A recid is digits, such as 6004.';
const RECID_FAILURE = `recid: ${RECID_RULE}`;

const Recid = z.object({
  recid: z
    .string()
    .regex(/^\d+$/, RECID_RULE)
    .describe('INSPIRE record ID, digits only, such as 6004'),
});

/** The issues Zod itself reports for `recid: 'abc'` — what `data.issues` must equal. */
const RECID_ISSUES = Recid.safeParse({ recid: 'abc' }).error?.issues;

const SavedFilter = z.object({
  filter: z.object({
    range: z.object({ from: z.string().min(4).describe('Range start, a four-digit year') }),
  }),
});

const record = resource('cern://record/{recid}', {
  description: 'One record.',
  mimeType: 'application/json',
  params: Recid,
  handler: ({ recid }) => ({ recid }),
});

/** Validates its own data, as a handler checking an upstream record does. */
const parseRecord = tool('parse_record', {
  description: 'Validates a record ID inside the handler.',
  input: z.object({ raw: z.string().describe('Unvalidated record ID') }),
  output: z.object({ recid: z.string().describe('Validated record ID') }),
  handler: ({ raw }) => Recid.parse({ recid: raw }),
});

/** The same rule on the input schema, so the argument rejection answers instead. */
const getRecord = tool('get_record', {
  description: 'Fetches one record.',
  input: Recid,
  output: z.object({ recid: z.string().describe('Record ID') }),
  handler: ({ recid }) => ({ recid }),
});

/** Reads back a stored value that no longer satisfies its schema. */
const readSavedFilter = tool('read_saved_filter', {
  description: 'Reads the saved filter.',
  input: z.object({}),
  output: z.object({ from: z.string().describe('Range start') }),
  async handler(_input, ctx) {
    await ctx.state.set('filters/saved', { filter: { range: { from: 'ab' } } });
    const saved = await ctx.state.get('filters/saved', SavedFilter);
    return { from: saved?.filter.range.from ?? '' };
  },
});

const describeRecord = prompt('describe_record', {
  description: 'Describes one record.',
  args: z.object({ raw: z.string().describe('Unvalidated record ID') }),
  generate: ({ raw }) => {
    const { recid } = Recid.parse({ recid: raw });
    return [{ role: 'user' as const, content: { type: 'text' as const, text: `Record ${recid}` } }];
  },
});

const Ids = z.object({
  ids: z.array(z.string().regex(/^\d+$/).describe('Record ID, digits only')).describe('Record IDs'),
});

/** 10,000 ids that are not digits: one Zod issue each. */
const BAD_IDS = Array.from({ length: 10_000 }, (_, i) => `x${i}`);

/** The message every surface renders for {@link BAD_IDS}. */
const IDS_FAILURE = 'ids.0: Invalid string: must match pattern /^\\d+$/ (+9999 more)';

/** `data` past the caps: Zod's first 10 issues unchanged, and the uncut count beside them. */
const BOUNDED_IDS_DATA = {
  issues: Ids.safeParse({ ids: BAD_IDS }).error?.issues.slice(0, 10),
  issuesCount: 10_000,
};

/** Fails its `params` with one issue per id. */
const items = resource('probe://items/{ids*}', {
  description: 'Records by ID.',
  mimeType: 'application/json',
  params: Ids,
  handler: ({ ids }) => ({ count: ids.length }),
});

/** Validates the ids itself, so the handler throws the ZodError. */
const parsedItems = resource('probe://parsed/{raw}', {
  description: 'Records by a dot-separated ID list.',
  mimeType: 'application/json',
  params: z.object({ raw: z.string().describe('Dot-separated record IDs') }),
  handler: ({ raw }) => Ids.parse({ ids: raw.split('.') }),
});

const parseIds = tool('parse_ids', {
  description: 'Validates record IDs inside the handler.',
  input: z.object({ raw: z.string().describe('Comma-separated record IDs') }),
  output: z.object({ count: z.number().describe('Valid record IDs') }),
  handler: ({ raw }) => ({ count: Ids.parse({ ids: raw.split(',') }).ids.length }),
});

/** `count` non-digit ids, so the issue count scales while the input stays one number. */
const badIds = (count: number) => Array.from({ length: count }, (_, i) => `x${i}`);

/** Throws the ZodError `Ids.parse` raises for `count` bad ids, from inside the handler. */
const countIds = tool('count_ids', {
  description: 'Validates generated record IDs inside the handler.',
  input: z.object({ count: z.number().int().describe('How many invalid record IDs to validate') }),
  output: z.object({ count: z.number().describe('Valid record IDs') }),
  handler: ({ count }) => ({ count: Ids.parse({ ids: badIds(count) }).ids.length }),
});

/** Throws an error whose cause's cause is that ZodError. */
const wrappedIds = tool('wrapped_ids', {
  description: 'Validates generated record IDs and wraps the failure twice.',
  input: z.object({ count: z.number().int().describe('How many invalid record IDs to validate') }),
  output: z.object({ count: z.number().describe('Valid record IDs') }),
  handler: ({ count }) => {
    const parsed = Ids.safeParse({ ids: badIds(count) });
    if (parsed.success) return { count: parsed.data.ids.length };
    throw new Error('lookup failed', {
      cause: new Error('record rejected', { cause: parsed.error }),
    });
  },
});

const storedIds = tool('stored_ids', {
  description: 'Stores record IDs, then reads them back against their schema.',
  input: z.object({ raw: z.string().describe('Comma-separated record IDs') }),
  output: z.object({ count: z.number().describe('Valid record IDs') }),
  async handler({ raw }, ctx) {
    await ctx.state.set('ids/saved', { ids: raw.split(',') });
    const saved = await ctx.state.get('ids/saved', Ids);
    return { count: saved?.ids.length ?? 0 };
  },
});

/** A `length`-character record key the caller sizes, and a second bad key after it. */
const longKey = tool('long_key', {
  description: 'Validates a caller-sized record key inside the handler.',
  input: z.object({ length: z.number().int().describe('Length of the record key') }),
  output: z.object({ count: z.number().describe('Valid entries') }),
  handler: ({ length }) => ({
    count: Object.keys(
      z.record(z.string(), z.number()).parse({ ['k'.repeat(length)]: 'x', other: 'y' }),
    ).length,
  }),
});

/** A refinement whose message echoes the caller's `raw`. */
const echoed = resource('probe://echoed/{raw}', {
  description: 'One record, its ID refined with a message that repeats it.',
  mimeType: 'application/json',
  params: z.object({
    raw: z
      .string()
      .superRefine((raw, ctx) => {
        ctx.addIssue({ code: 'custom', message: `${raw} is not a record ID.` });
      })
      .describe('Record ID'),
  }),
  handler: ({ raw }) => ({ raw }),
});

/** Validates a record keyed by the caller's `raw`, so the first issue's path is that key. */
const keyed = resource('probe://keyed/{raw}', {
  description: 'One record, keyed by its ID.',
  mimeType: 'application/json',
  params: z.object({ raw: z.string().describe('Record key') }),
  handler: ({ raw }) => z.record(z.string(), z.number()).parse({ [raw]: 'x' }),
});

/** 250 valid codes: Zod's miss message lists every one, past 1,024 characters. */
const CODES = Array.from({ length: 250 }, (_, i) => `C${String(i).padStart(3, '0')}`) as [
  string,
  ...string[],
];

const coded = resource('probe://coded/{code}', {
  description: 'One code from a fixed list.',
  mimeType: 'application/json',
  params: z.object({ code: z.enum(CODES).describe('Code') }),
  handler: ({ code }) => ({ code }),
});

/** Throws a ZodError one of whose issue fields throws on read. */
const unreadableIssue = tool('unreadable_issue', {
  description: 'Throws a ZodError whose issue cannot be read whole.',
  input: z.object({}),
  output: z.object({ count: z.number().describe('Valid record IDs') }),
  handler: () => {
    const issue = {
      code: 'custom',
      message: 'Rejected.',
      path: ['ids'],
      get params(): never {
        throw new Error('params getter threw');
      },
    };
    throw new z.ZodError([issue as never]);
  },
});

describe('a ZodError on the wire leads with its path (#620)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  /** Every JSON-RPC message the server sent, serialized as the transport writes it. */
  const sent: string[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    sent.length = 0;
  });

  /** Every definition served by the production registries over an in-memory pair. */
  async function connect(): Promise<Client> {
    const services = { logger, storage: new StorageService(new InMemoryProvider()) };
    const server = new McpServer(
      { name: 'zod-message-wire-test', version: '0.0.0' },
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );
    await new ToolRegistry(
      [
        parseRecord,
        getRecord,
        readSavedFilter,
        parseIds,
        storedIds,
        countIds,
        wrappedIds,
        unreadableIssue,
        longKey,
      ],
      services,
    ).registerAll(server);
    await new ResourceRegistry(
      [record, items, parsedItems, echoed, keyed, coded],
      services,
    ).registerAll(server);
    await new PromptRegistry([describeRecord], logger).registerAll(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const send = serverTransport.send.bind(serverTransport);
    serverTransport.send = (message, options) => {
      sent.push(JSON.stringify(message));
      return send(message, options);
    };
    const client = new Client({ name: 'zod-message-wire-client', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }

  /** `structuredContent.error` of a failed tool result. */
  function envelopeOf(result: CallToolResult) {
    expect(result.isError).toBe(true);
    return (
      result.structuredContent as {
        error: { code: number; data?: Record<string, unknown>; message: string };
      }
    ).error;
  }

  /** The `content[]` text of a failed tool result. */
  function textOf(result: CallToolResult): string {
    return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  }

  it('rejects resources/read of cern://record/abc with -32007 and the path-first message', async () => {
    const client = await connect();

    const error = (await client
      .readResource({ uri: 'cern://record/abc' })
      .then(() => expect.unreachable('expected resources/read to reject'))
      .catch((err: unknown) => err)) as { code?: number; data?: Record<string, unknown> } & Error;

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe(RECID_FAILURE);
    expect(error.data).toEqual({ issues: RECID_ISSUES, requestId: expect.any(String) });
  });

  it('returns the path-first message on both surfaces when a tool handler throws the ZodError', async () => {
    const client = await connect();

    const result = (await client.callTool({
      name: 'parse_record',
      arguments: { raw: 'abc' },
    })) as CallToolResult;

    const error = envelopeOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe(RECID_FAILURE);
    expect(error.data).toEqual({ issues: RECID_ISSUES, requestId: expect.any(String) });
    expect(textOf(result)).toBe(`Error: ${RECID_FAILURE}\n\n(request ${error.data?.requestId})`);
  });

  it('returns the same message through runToolContract', async () => {
    const result = await runToolContract(parseRecord, { raw: 'abc' });

    const error = envelopeOf(result);
    expect(error).toEqual({
      code: JsonRpcErrorCode.ValidationError,
      message: RECID_FAILURE,
      data: { issues: RECID_ISSUES },
    });
    expect(textOf(result)).toBe(`Error: ${RECID_FAILURE}`);
  });

  it('names the full nested path when ctx.state.get(key, schema) rejects a stored value', async () => {
    const client = await connect();

    const result = (await client.callTool({
      name: 'read_saved_filter',
      arguments: {},
    })) as CallToolResult;

    const error = envelopeOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe(
      'filter.range.from: Too small: expected string to have >=4 characters',
    );
  });

  it('rejects prompts/get with -32007 and the path-first message when generate() throws the ZodError', async () => {
    const client = await connect();

    const error = (await client
      .getPrompt({ name: 'describe_record', arguments: { raw: 'abc' } })
      .then(() => expect.unreachable('expected prompts/get to reject'))
      .catch((err: unknown) => err)) as { code?: number; data?: Record<string, unknown> } & Error;

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe(RECID_FAILURE);
  });

  it('leaves the tool argument rejection text as it was (regression)', async () => {
    const client = await connect();

    const result = (await client.callTool({
      name: 'get_record',
      arguments: { recid: 'abc' },
    })) as CallToolResult;

    const error = envelopeOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.message).toBe(
      `Input validation error: Invalid arguments for tool get_record: ${RECID_FAILURE}`,
    );
    expect(error.data).toMatchObject({ issues: RECID_ISSUES, reason: 'invalid_arguments' });
    expect(textOf(result).startsWith(`Error: ${error.message}\n\n`)).toBe(true);
  });

  describe('data.issues past the caps is bounded on every surface (#710)', () => {
    /** Every record the framework logs during a call, as written: message and context. */
    const records: string[] = [];
    const levels = ['debug', 'info', 'notice', 'warning', 'error', 'crit'] as const;

    afterEach(() => {
      vi.restoreAllMocks();
      records.length = 0;
    });

    /** Captures the framework's log records instead of writing them. */
    function captureLogs(): void {
      for (const level of levels) {
        vi.spyOn(logger, level).mockImplementation((message: string, context?: unknown) => {
          records.push(JSON.stringify({ message, context }));
        });
      }
    }

    /** Whether any `issues` array anywhere in a record keeps more than 10 entries. */
    function carriesUncutIssues(record: string): boolean {
      let uncut = false;
      JSON.parse(record, (key, value: unknown) => {
        if (key === 'issues' && Array.isArray(value) && value.length > 10) uncut = true;
        return value;
      });
      return uncut;
    }

    /** The serialized size of the last response the server sent: a message answering a request, never a notification. */
    function responseBytes(): number {
      const response = sent.findLast((message) => {
        const parsed = JSON.parse(message) as Record<string, unknown>;
        return 'id' in parsed && ('result' in parsed || 'error' in parsed);
      });
      return response?.length ?? 0;
    }

    /** Asserts no record the call logged carried an issue list past 10 entries. */
    function expectBoundedRecords(): void {
      for (const record of records) expect(carriesUncutIssues(record)).toBe(false);
    }

    it.each([
      ['a resource params rejection', `probe://items/${BAD_IDS.join(',')}`],
      ['a ZodError a resource handler throws', `probe://parsed/${BAD_IDS.join('.')}`],
    ])(
      'rejects %s with -32007, the first 10 issues, and issuesCount, under 4 KiB',
      async (_label, uri) => {
        const client = await connect();
        captureLogs();

        const error = (await client
          .readResource({ uri })
          .then(() => expect.unreachable('expected resources/read to reject'))
          .catch((err: unknown) => err)) as {
          code?: number;
          data?: Record<string, unknown>;
        } & Error;

        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.message).toBe(IDS_FAILURE);
        expect(error.data).toEqual({ ...BOUNDED_IDS_DATA, requestId: expect.any(String) });
        expect(responseBytes()).toBeGreaterThan(0);
        expect(responseBytes()).toBeLessThan(4096);
        expectBoundedRecords();
      },
    );

    it.each([
      ['a ZodError a tool handler throws', 'parse_ids'],
      ['ctx.state.get(key, schema) rejecting a stored value', 'stored_ids'],
    ])(
      'returns %s with the first 10 issues and issuesCount on both surfaces, under 4 KiB',
      async (_label, name) => {
        const client = await connect();
        captureLogs();

        const result = (await client.callTool({
          name,
          arguments: { raw: BAD_IDS.join(',') },
        })) as CallToolResult;

        const error = envelopeOf(result);
        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.message).toBe(IDS_FAILURE);
        expect(error.data).toEqual({ ...BOUNDED_IDS_DATA, requestId: expect.any(String) });
        expect(textOf(result)).toBe(`Error: ${IDS_FAILURE}\n\n(request ${error.data?.requestId})`);
        expect(responseBytes()).toBeGreaterThan(0);
        expect(responseBytes()).toBeLessThan(4096);
        expectBoundedRecords();
      },
    );

    it('returns the same bounded envelope through runToolContract', async () => {
      const result = await runToolContract(parseIds, { raw: BAD_IDS.join(',') });

      expect(envelopeOf(result)).toEqual({
        code: JsonRpcErrorCode.ValidationError,
        message: IDS_FAILURE,
        data: BOUNDED_IDS_DATA,
      });
      expect(textOf(result)).toBe(`Error: ${IDS_FAILURE}`);
      expect(JSON.stringify(result).length).toBeLessThan(4096);
    });

    it('returns a ZodError whose issue cannot be read whole as its envelope, the field [Unreadable]', async () => {
      const client = await connect();
      const issues = [
        { code: 'custom', message: 'Rejected.', path: ['ids'], params: '[Unreadable]' },
      ];

      const result = (await client.callTool({
        name: 'unreadable_issue',
        arguments: {},
      })) as CallToolResult;
      const contract = await runToolContract(unreadableIssue, {});

      expect(envelopeOf(result)).toEqual({
        code: JsonRpcErrorCode.ValidationError,
        message: 'ids: Rejected.',
        data: { issues, requestId: expect.any(String) },
      });
      expect(envelopeOf(contract)).toEqual({
        code: JsonRpcErrorCode.ValidationError,
        message: 'ids: Rejected.',
        data: { issues },
      });
    });

    describe('the error record carries the summary, never the issue list (#736)', () => {
      type ErrorRecord = {
        message: string;
        context: {
          extra?: {
            stack?: string;
            errorData?: {
              rootCause?: { name: string; message: string };
              causeChain?: Array<{ name: string; message: string; depth: number }>;
            };
          };
        };
      };
      const IS_BUN = typeof process.versions.bun === 'string';
      const summary = (count: number) =>
        `ids.0: Invalid string: must match pattern /^\\d+$/ (+${count - 1} more)`;
      /**
       * Whether a thrown ZodError's stack here starts `ZodError: <its JSON
       * message>`: always on V8; on Bun only under a stack formatter such as
       * the test runner's, since Bun's own carries no message.
       */
      const stackCarriesMessage = (() => {
        try {
          Ids.parse({ ids: badIds(2) });
        } catch (error) {
          const { stack, message } = error as z.ZodError;
          return stack?.startsWith(`ZodError: ${message}`) === true;
        }
        return false;
      })();

      it.runIf(!IS_BUN)(
        'V8 starts a thrown ZodError’s stack with its JSON message (the precondition)',
        () => {
          expect(stackCarriesMessage).toBe(true);
        },
      );

      /** The one `Error in tool:<name>` record the call wrote, as the logger received it. */
      function errorRecord(name: string): { record: ErrorRecord; bytes: number } {
        const found = records.filter((record) =>
          (JSON.parse(record) as ErrorRecord).message.startsWith(`Error in tool:${name}`),
        );
        expect(found).toHaveLength(1);
        const [line] = found as [string];
        // Each issue's `code`, which the summary and the rest of the record never carry.
        expect(line).not.toContain('invalid_format');
        return { record: JSON.parse(line) as ErrorRecord, bytes: line.length };
      }

      it('writes a handler-thrown ZodError’s stack header as the summary, frames kept, flat from 100 to 10,000 issues', async () => {
        const client = await connect();
        captureLogs();
        const sizes: number[] = [];

        for (const count of [100, 10_000]) {
          records.length = 0;
          const result = (await client.callTool({
            name: 'count_ids',
            arguments: { count },
          })) as CallToolResult;
          expect(envelopeOf(result).message).toBe(summary(count));

          const { record, bytes } = errorRecord('count_ids');
          expect(record.message).toBe(`Error in tool:count_ids: ${summary(count)}`);
          if (stackCarriesMessage) {
            const [header, ...frames] = String(record.context.extra?.stack).split('\n');
            expect(header).toBe(`ZodError: ${summary(count)}`);
            if (!IS_BUN) expect(frames.length).toBeGreaterThan(0);
            expect(frames.every((frame) => frame.startsWith('    at '))).toBe(true);
          }
          sizes.push(bytes);
        }
        // The summary's count and the input's digits: a few characters, nothing per issue.
        expect(sizes[1]! - sizes[0]!).toBeLessThan(64);
      });

      it('writes a ZodError two causes deep as its summary in the cause chain, flat from 100 to 10,000 issues', async () => {
        const client = await connect();
        captureLogs();
        const sizes: number[] = [];

        for (const count of [100, 10_000]) {
          records.length = 0;
          const result = (await client.callTool({
            name: 'wrapped_ids',
            arguments: { count },
          })) as CallToolResult;
          expect(envelopeOf(result).message).toBe('lookup failed');

          const { record, bytes } = errorRecord('wrapped_ids');
          const errorData = record.context.extra?.errorData;
          expect(errorData?.rootCause).toEqual({ name: 'ZodError', message: summary(count) });
          expect(
            errorData?.causeChain?.map(({ name, message, depth }) => [name, message, depth]),
          ).toEqual([
            ['Error', 'lookup failed', 0],
            ['Error', 'record rejected', 1],
            ['ZodError', summary(count), 2],
          ]);
          sizes.push(bytes);
        }
        expect(sizes[1]! - sizes[0]!).toBeLessThan(64);
      });

      describe('the summary’s path is cut to its first 1,024 characters, the message and count kept (#710)', () => {
        /** The summary `long_key` raises for a `length`-character key. */
        const keySummary = (length: number) =>
          `${length <= 1_024 ? 'k'.repeat(length) : `${'k'.repeat(1_024)}…`}: Invalid input: expected number, received string (+1 more)`;

        it('returns a tool handler’s summary cut on both surfaces, in its log line and stack header, flat from 10,000 to 100,000 characters', async () => {
          const client = await connect();
          captureLogs();
          const sizes: number[] = [];

          for (const length of [10_000, 100_000]) {
            records.length = 0;
            sent.length = 0;
            const result = (await client.callTool({
              name: 'long_key',
              arguments: { length },
            })) as CallToolResult;

            const error = envelopeOf(result);
            expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
            expect(error.message).toBe(keySummary(length));
            expect(textOf(result)).toBe(
              `Error: ${keySummary(length)}\n\n(request ${error.data?.requestId})`,
            );
            expect(responseBytes()).toBeLessThan(8192);

            const { record, bytes } = errorRecord('long_key');
            expect(record.message).toBe(`Error in tool:long_key: ${keySummary(length)}`);
            if (stackCarriesMessage) {
              const [header] = String(record.context.extra?.stack).split('\n');
              expect(header).toBe(`ZodError: ${keySummary(length)}`);
            }
            sizes.push(bytes);
          }
          expect(sizes[1]! - sizes[0]!).toBeLessThan(64);
        });

        it('leaves a summary within the cap whole', async () => {
          const client = await connect();

          const result = (await client.callTool({
            name: 'long_key',
            arguments: { length: 100 },
          })) as CallToolResult;

          expect(envelopeOf(result).message).toBe(keySummary(100));
        });

        /** The rejection `resources/read` of `uri` answers with. */
        async function readRejection(client: Client, uri: string) {
          return (await client
            .readResource({ uri })
            .then(() => expect.unreachable('expected resources/read to reject'))
            .catch((err: unknown) => err)) as { code?: number } & Error;
        }

        it('rejects a resource whose handler fails on a long record key with the key cut', async () => {
          const client = await connect();

          const error = await readRejection(client, `probe://keyed/${'r'.repeat(5_000)}`);

          expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
          expect(error.message).toBe(
            `${'r'.repeat(1_024)}…: Invalid input: expected number, received string`,
          );
          expect(responseBytes()).toBeLessThan(8192);
        });

        it('carries a resource params refinement’s long message whole', async () => {
          const client = await connect();
          const raw = 'r'.repeat(5_000);

          const error = await readRejection(client, `probe://echoed/${raw}`);

          expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
          expect(error.message).toBe(`raw: ${raw} is not a record ID.`);
        });

        it('carries a 250-option enum miss whole, every valid option listed', async () => {
          const client = await connect();
          const message = z.enum(CODES).safeParse('nope').error?.issues[0]?.message ?? '';
          expect(message.length).toBeGreaterThan(1_024);

          const error = await readRejection(client, 'probe://coded/nope');

          expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
          expect(error.message).toBe(`code: ${message}`);
          expect(error.message).toContain('"C249"');
        });
      });
    });
  });
});

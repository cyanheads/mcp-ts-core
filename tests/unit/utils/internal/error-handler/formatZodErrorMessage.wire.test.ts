/**
 * @fileoverview What a `ZodError` a server raises itself reads like on the wire
 * (#620). The production tool, resource, and prompt registries sit behind a
 * real `McpServer` and an in-memory client, and every surface that funnels a
 * `ZodError` through `formatZodErrorMessage` — a resource `params` rejection, a
 * tool handler's own parse, `ctx.state.get(key, schema)`, a prompt's
 * `generate()`, and `runToolContract` — leads with the dotted path:
 * `recid: A recid is digits, such as 6004.`. The code stays `ValidationError`
 * and `data.issues` stays Zod's own list. The tool argument rejection renders
 * through its own path and is pinned unchanged beside them.
 * @module tests/unit/utils/internal/error-handler/formatZodErrorMessage.wire
 */

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { type CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('a ZodError on the wire leads with its path (#620)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  /** Every definition served by the production registries over an in-memory pair. */
  async function connect(): Promise<Client> {
    const services = { logger, storage: new StorageService(new InMemoryProvider()) };
    const server = new McpServer(
      { name: 'zod-message-wire-test', version: '0.0.0' },
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );
    await new ToolRegistry([parseRecord, getRecord, readSavedFilter], services).registerAll(server);
    await new ResourceRegistry([record], services).registerAll(server);
    await new PromptRegistry([describeRecord], logger).registerAll(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
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
});

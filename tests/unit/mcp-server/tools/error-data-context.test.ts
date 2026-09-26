/**
 * @fileoverview A handler passes its `ctx` to framework services, parsers, and
 * formatters as their context argument. After an elicitation round that `ctx`
 * carries what the user typed (`ctx.inputs.responses`), so no framework error
 * built from it may carry the context as `McpError.data` — that payload is
 * returned verbatim as `structuredContent.error.data` (#548). Runs the real
 * handler factory, storage service, parsers, and formatters: a stubbed service
 * would never build the error this covers.
 * @module tests/unit/mcp-server/tools/error-data-context.test
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CallToolResult } from '@modelcontextprotocol/server';
import { inputRequired } from '@modelcontextprotocol/server';
import { context as otelContext, trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { Context } from '@/core/context.js';
import { type AnyToolDefinition, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { createToolHandler } from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { FileSystemProvider } from '@/storage/providers/fileSystem/fileSystemProvider.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { diffFormatter } from '@/utils/formatting/diffFormatter.js';
import { tableFormatter } from '@/utils/formatting/tableFormatter.js';
import { treeFormatter } from '@/utils/formatting/treeFormatter.js';
import { logger } from '@/utils/internal/logger.js';
import { fetchWithTimeout } from '@/utils/network/fetchWithTimeout.js';
import { csvParser } from '@/utils/parsing/csvParser.js';
import { htmlExtractor } from '@/utils/parsing/htmlExtractor.js';
import { Allow, jsonParser } from '@/utils/parsing/jsonParser.js';
import { xmlParser } from '@/utils/parsing/xmlParser.js';
import { yamlParser } from '@/utils/parsing/yamlParser.js';
import { makeServerContext } from '../../../helpers/server-context.js';

const provider = new NodeTracerProvider();
const storage = new StorageService(new InMemoryProvider());
const services = { logger: logger as never, storage, exposeStatelessSessionId: true };

const SESSION_ID = 'a'.repeat(64);
const PASSPHRASE = 'hunter2';

/** Context keys that must never reach `structuredContent.error.data`. */
const CONTEXT_KEYS = [
  'auth',
  'extra',
  'inputs',
  'log',
  'operation',
  'requestId',
  'sessionId',
  'signal',
  'spanId',
  'state',
  'tenantId',
  'timestamp',
  'toolName',
  'traceId',
];

const Pass = z.object({ passphrase: z.string().describe('Passphrase') });

/**
 * A tool that elicits a passphrase, then on the answered round hands its `ctx`
 * to `call` — the shape of the reported leak.
 */
function elicitingTool(call: (ctx: Context) => Promise<unknown>) {
  return tool('note', {
    description: 'Repro.',
    input: z.object({}),
    output: z.object({ ok: z.boolean().describe('Always true') }),
    async handler(_input, ctx) {
      if (!ctx.inputs.accepted('pass', Pass)) {
        return ctx.requestInput({
          inputRequests: {
            pass: inputRequired.elicit({ message: 'Passphrase?', requestedSchema: Pass }),
          },
        });
      }
      await call(ctx);
      return { ok: true };
    },
  });
}

/** Runs the answered round and returns the failed result plus the handler's ctx. */
async function answeredRound(call: (ctx: Context) => Promise<unknown>) {
  let seen: Context | undefined;
  const def = elicitingTool((ctx) => {
    seen = ctx;
    return call(ctx);
  });
  const handler = createToolHandler(def as AnyToolDefinition, services as never, {});
  const result = (await handler(
    {},
    makeServerContext({
      sessionId: SESSION_ID,
      inputResponses: { pass: { action: 'accept', content: { passphrase: PASSPHRASE } } },
    }),
  )) as CallToolResult;
  return { result, ctx: seen as Context };
}

function errorData(result: CallToolResult): Record<string, unknown> | undefined {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: { data?: Record<string, unknown> } }).error.data;
}

describe('framework error data built from a handler ctx (#548)', () => {
  beforeAll(() => {
    // A live tracer so the handler ctx carries a real traceId/spanId to leak.
    provider.register();
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    otelContext.disable();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each<[string, (ctx: Context) => Promise<unknown>]>([
    ['StorageService.get with an invalid key', (ctx) => storage.get('note:42', ctx)],
    ['StorageService.list with a zero limit', (ctx) => storage.list('', ctx, { limit: 0 })],
    ['jsonParser.parse on blank input', (ctx) => jsonParser.parse('  ', Allow.ALL, ctx)],
    ['csvParser.parse on blank input', (ctx) => csvParser.parse('  ', undefined, ctx)],
    ['csvParser.parse on malformed input', (ctx) => csvParser.parse('a,b\n"1,2', {}, ctx)],
    ['xmlParser.parse on blank input', (ctx) => xmlParser.parse('  ', ctx)],
    ['yamlParser.parse on blank input', (ctx) => yamlParser.parse('  ', ctx)],
    ['htmlExtractor.extract on blank input', (ctx) => htmlExtractor.extract('  ', undefined, ctx)],
    [
      'tableFormatter.format with non-array data',
      async (ctx) => tableFormatter.format('rows' as never, undefined, ctx),
    ],
    [
      'tableFormatter.formatRaw with a ragged row',
      async (ctx) => tableFormatter.formatRaw(['a', 'b'], [['1']], undefined, ctx),
    ],
    [
      'treeFormatter.format with a nameless root',
      async (ctx) => treeFormatter.format({} as never, undefined, ctx),
    ],
    [
      'diffFormatter.diff with non-string input',
      (ctx) => diffFormatter.diff(1 as never, 'b', undefined, ctx),
    ],
  ])('%s returns no context in structuredContent.error.data', async (_label, call) => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});

    const { result, ctx } = await answeredRound(call);

    // The ctx really did carry what the fix must keep out.
    expect(ctx.inputs.accepted('pass', Pass)).toEqual({ passphrase: PASSPHRASE });
    expect(ctx.sessionId).toBe(SESSION_ID);
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);

    const data = errorData(result);
    expect(JSON.stringify(data ?? {})).not.toContain(PASSPHRASE);
    for (const key of CONTEXT_KEYS) expect(data ?? {}).not.toHaveProperty(key);
  });

  it('a ctx.state validation failure returns only the offending field', async () => {
    const cases: [(ctx: Context) => Promise<unknown>, Record<string, unknown>][] = [
      [(ctx) => ctx.state.get('note:42'), { key: 'note:42' }],
      [(ctx) => ctx.state.set('a..b', 1), { key: 'a..b' }],
      [(ctx) => ctx.state.list('bad prefix'), { prefix: 'bad prefix' }],
      [(ctx) => ctx.state.list('ok/', { limit: 0 }), { limit: 0 }],
    ];
    for (const [call, expected] of cases) {
      const { result } = await answeredRound(call);
      expect(errorData(result)).toEqual(expected);
    }
  });

  // The ErrorHandler.tryCatch path: the provider wraps its read, and the
  // returned error used to carry the canonical context and flattened `extra`.
  describe('through a storage provider tryCatch', () => {
    let root: string;

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'error-data-context-'));
      mkdirSync(join(root, 'default', 'note'), { recursive: true });
      writeFileSync(join(root, 'default', 'note', '42'), 'not json{');
    });

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('a corrupt stored value returns no context in structuredContent.error.data', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const fsStorage = new StorageService(new FileSystemProvider(root));

      const { result, ctx } = await answeredRound((c) => fsStorage.get('note/42', c));

      const data = errorData(result);
      expect(data).toMatchObject({ originalErrorName: 'McpError' });
      expect(JSON.stringify(data ?? {})).not.toContain(PASSPHRASE);
      for (const key of CONTEXT_KEYS) expect(data ?? {}).not.toHaveProperty(key);
      // The provider's tryCatch log record still carries the correlation.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error in FileSystemProvider.get'),
        expect.objectContaining({ requestId: ctx.requestId, sessionId: SESSION_ID }),
      );
    });
  });

  describe('through fetchWithTimeout', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it.each<[string, () => Promise<Response>]>([
      ['an HTTP error status', async () => new Response('upstream said no', { status: 503 })],
      [
        'a network failure',
        async () => {
          throw new TypeError('fetch failed');
        },
      ],
    ])('%s returns no request metadata in structuredContent.error.data', async (_label, fake) => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      vi.stubGlobal('fetch', vi.fn(fake));

      const { result, ctx } = await answeredRound((c) =>
        fetchWithTimeout('https://api.example.com/items', 1_000, c),
      );

      const data = errorData(result);
      expect(data).toHaveProperty('errorSource');
      for (const key of CONTEXT_KEYS) expect(data ?? {}).not.toHaveProperty(key);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Fetch failed|Network error/),
        expect.objectContaining({ requestId: ctx.requestId }),
      );
    });
  });

  it('keeps the diagnostic context in the server log', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    const { result, ctx } = await answeredRound((c) => storage.get('note:42', c));

    expect(errorData(result)).toEqual({ key: 'note:42' });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Key contains invalid characters'),
      expect.objectContaining({
        requestId: ctx.requestId,
        sessionId: SESSION_ID,
        extra: expect.objectContaining({
          errorData: expect.objectContaining({ key: 'note:42' }),
        }),
      }),
    );
  });
});

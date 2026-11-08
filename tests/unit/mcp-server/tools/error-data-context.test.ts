/**
 * @fileoverview A handler passes its `ctx` to framework services, parsers, and
 * formatters as their context argument. After an elicitation round that `ctx`
 * carries what the user typed (`ctx.inputs.responses`), so no framework error
 * built from it may carry the context as `McpError.data` — that payload is
 * returned verbatim as `structuredContent.error.data` (#548); nor may that
 * payload carry an upstream error body the HTTP helpers captured, unless the
 * call opts in (#590). Runs the real handler factory, storage service, parsers,
 * and formatters: a stubbed service would never build the error this covers.
 * @module tests/unit/mcp-server/tools/error-data-context.test
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CallToolResult } from '@modelcontextprotocol/server';
import { inputRequired } from '@modelcontextprotocol/server';
import { context as otelContext, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { Context } from '@/core/context.js';
import { type AnyToolDefinition, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { createToolHandler } from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { FileSystemProvider } from '@/storage/providers/fileSystem/fileSystemProvider.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { diffFormatter } from '@/utils/formatting/diffFormatter.js';
import { tableFormatter } from '@/utils/formatting/tableFormatter.js';
import { treeFormatter } from '@/utils/formatting/treeFormatter.js';
import { logger } from '@/utils/internal/logger.js';
import { toLogValue } from '@/utils/internal/logValue.js';
import { fetchWithTimeout } from '@/utils/network/fetchWithTimeout.js';
import { httpErrorFromResponse } from '@/utils/network/httpError.js';
import { csvParser } from '@/utils/parsing/csvParser.js';
import { htmlExtractor } from '@/utils/parsing/htmlExtractor.js';
import { Allow, jsonParser } from '@/utils/parsing/jsonParser.js';
import { xmlParser } from '@/utils/parsing/xmlParser.js';
import { yamlParser } from '@/utils/parsing/yamlParser.js';
import { legacyCapabilityView, makeServerContext } from '../../../helpers/server-context.js';

const provider = new TracerProvider();
const storage = new StorageService(new InMemoryProvider());
const services = { logger: logger as never, storage, exposeStatelessSessionId: true };

const SESSION_ID = 'a'.repeat(64);
const PASSPHRASE = 'hunter2';

/**
 * Context keys that must never reach `structuredContent.error.data`. `requestId`
 * is the one exception: the handler factory adds the call's own id to every
 * envelope it builds (#576), which {@link expectOnlyRequestId} pins.
 */
const CONTEXT_KEYS = [
  'auth',
  'clientCapabilities',
  'extra',
  'inputs',
  'log',
  'operation',
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
  // A client that declared elicitation, so the answer reaches `ctx.inputs`.
  const handler = createToolHandler(
    def as AnyToolDefinition,
    services as never,
    {},
    legacyCapabilityView({ elicitation: {} }),
  );
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

/** The envelope carries the call's own request id and no other context key (#576). */
function expectOnlyRequestId(data: Record<string, unknown> | undefined, ctx: Context): void {
  expect(data?.requestId).toBe(ctx.requestId);
  for (const key of CONTEXT_KEYS) expect(data ?? {}).not.toHaveProperty(key);
}

describe('framework error data built from a handler ctx (#548)', () => {
  beforeAll(() => {
    // A live tracer so the handler ctx carries a real traceId/spanId to leak.
    trace.setGlobalTracerProvider(provider);
    otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
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
    expectOnlyRequestId(data, ctx);
  });

  it('a ctx.state validation failure returns only the offending field and the request id', async () => {
    const cases: [(ctx: Context) => Promise<unknown>, Record<string, unknown>][] = [
      [(ctx) => ctx.state.get('note:42'), { key: 'note:42' }],
      [(ctx) => ctx.state.set('a..b', 1), { key: 'a..b' }],
      [(ctx) => ctx.state.list('bad prefix'), { prefix: 'bad prefix' }],
      [(ctx) => ctx.state.list('ok/', { limit: 0 }), { limit: 0 }],
    ];
    for (const [call, expected] of cases) {
      const { result, ctx } = await answeredRound(call);
      expect(errorData(result)).toEqual({ ...expected, requestId: ctx.requestId });
    }
  });

  // The ErrorHandler.tryCatch path: the provider wraps its read, and the
  // returned error used to carry the canonical context and flattened `extra`.
  describe('through a storage provider tryCatch', () => {
    let root: string;

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'error-data-context-'));
      // Key `note/42` of tenant `default`, at the provider's own layout.
      mkdirSync(join(root, '_v2', 'default', 'note'), { recursive: true });
      writeFileSync(join(root, '_v2', 'default', 'note', '42.json'), 'not json{');
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
      expectOnlyRequestId(data, ctx);
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
      expectOnlyRequestId(data, ctx);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Fetch failed|Network error/),
        expect.objectContaining({ requestId: ctx.requestId }),
      );
    });
  });

  /**
   * An upstream's error body is captured for server code and the failure
   * record, and left off `structuredContent.error.data` unless the call opts in
   * (#590). Through the real handler factory, so every copy of `data` the
   * framework makes on the way — the declared-recovery fill, the handler
   * record — runs.
   */
  describe('a captured upstream error body (#590)', () => {
    const BODY = '{"error":"param dte is not a valid date"}';
    const badRequest = () => new Response(BODY, { status: 400, statusText: 'Bad Request' });
    const WIRE_400 = {
      status: 400,
      statusText: 'Bad Request',
      statusCode: 400,
      requestId: expect.any(String),
    };

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** Runs a tool whose handler runs `fail`, through the real handler factory. */
    async function failedCall(fail: (ctx: Context) => Promise<unknown>): Promise<CallToolResult> {
      const def = tool('lookup', {
        description: 'Repro.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('Always true') }),
        errors: [
          {
            reason: 'upstream_rejected',
            code: JsonRpcErrorCode.InvalidParams,
            when: 'The upstream rejected the query',
            recovery: 'Check the date parameters, then retry the call.',
            thrownBy: 'service',
          },
        ],
        async handler(_input, ctx) {
          await fail(ctx);
          return { ok: true };
        },
      });
      const handler = createToolHandler(
        def as AnyToolDefinition,
        services as never,
        {},
        legacyCapabilityView({}),
      );
      return (await handler({}, makeServerContext({}))) as CallToolResult;
    }

    /** The `content[]` text, the call's own request id written as `<id>`. */
    function contentText(result: CallToolResult): string {
      const [block] = result.content as { text: string }[];
      return String(block?.text).replace(String(errorData(result)?.requestId), '<id>');
    }

    it('leaves httpErrorFromResponse’s body off structuredContent.error.data', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});

      const result = await failedCall(async () => {
        throw await httpErrorFromResponse(badRequest(), { service: 'Upstream' });
      });

      expect(errorData(result)).toEqual(WIRE_400);
      expect(contentText(result)).not.toContain('dte');
    });

    it('leaves fetchWithTimeout’s body off structuredContent.error.data', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(BODY, { status: 503, statusText: 'Service Unavailable' })),
      );

      const result = await failedCall((ctx) =>
        fetchWithTimeout('https://api.example.com/items', 1_000, ctx),
      );

      expect(errorData(result)).toEqual({
        status: 503,
        statusText: 'Service Unavailable',
        statusCode: 503,
        errorSource: 'FetchHttpError',
        requestId: expect.any(String),
      });
    });

    it('keeps the body off an McpError rebuilt from a spread of the helper’s data', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});

      const result = await failedCall(async () => {
        const upstream = await httpErrorFromResponse(badRequest(), { service: 'Upstream' });
        throw new McpError(
          upstream.code,
          'Lookup failed.',
          { ...upstream.data, lookup: 'dte' },
          { cause: upstream },
        );
      });

      expect(errorData(result)).toEqual({ ...WIRE_400, lookup: 'dte' });
    });

    it('keeps the body off a failure the declared recovery fills', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});

      const result = await failedCall(async () => {
        throw await httpErrorFromResponse(badRequest(), {
          service: 'Upstream',
          data: { reason: 'upstream_rejected' },
        });
      });

      expect(errorData(result)).toEqual({
        ...WIRE_400,
        reason: 'upstream_rejected',
        recovery: { hint: 'Check the date parameters, then retry the call.' },
      });
    });

    it('sends today’s structuredContent.error.data under exposeBody: true, content[] unchanged', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      const fail = (exposeBody: boolean) => async () => {
        throw await httpErrorFromResponse(badRequest(), { service: 'Upstream', exposeBody });
      };

      const exposed = await failedCall(fail(true));
      const kept = await failedCall(fail(false));

      expect(errorData(exposed)).toEqual({ ...WIRE_400, body: BODY, responseBody: BODY });
      expect(contentText(exposed)).toBe(contentText(kept));
    });

    it('writes the body on the handler’s failure record, and never the marker', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

      await failedCall(async () => {
        throw await httpErrorFromResponse(badRequest(), { service: 'Upstream' });
      });

      const call = errorSpy.mock.calls.find(([message]) =>
        String(message).startsWith('Error in tool:lookup'),
      );
      const written = toLogValue(call?.[1]) as { extra: { errorData: Record<string, unknown> } };
      expect(written.extra.errorData).toMatchObject({ body: BODY, responseBody: BODY });
      expect(Object.getOwnPropertySymbols(written.extra.errorData)).toEqual([]);
    });
  });

  it('keeps the diagnostic context in the server log', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    const { result, ctx } = await answeredRound((c) => storage.get('note:42', c));

    expect(errorData(result)).toEqual({ key: 'note:42', requestId: ctx.requestId });
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

/**
 * @fileoverview Opt-in failed-call payload logging (#291), driven through the
 * real handler factory, error handler, sanitizer, and `Logger`. Only pino is
 * replaced, by a recording double, so every record the logger hands its sink
 * is observable in-process; an OTel Logs API sink is attached alongside to
 * observe the export path. The real pino transports — stderr and
 * `combined.log` — are covered black-box by
 * `tests/integration/tool-failure-payload.int.test.ts`.
 * @module tests/unit/mcp-server/tools/utils/toolHandlerFactory.failurePayload.test
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { CallToolResult, ClientCapabilities } from '@modelcontextprotocol/server';
import { inputRequired } from '@modelcontextprotocol/server';
import {
  type ContextManager,
  type Context as OtelContext,
  context as otContext,
  ROOT_CONTEXT,
  trace,
} from '@opentelemetry/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { makeServerContext } from '../../../../helpers/server-context.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const { mockConfig, writes } = vi.hoisted(() => ({
  mockConfig: {
    environment: 'testing',
    logRateLimitThreshold: 0,
    logRateLimitWindowMs: 60_000,
    logsPath: undefined as string | undefined,
    logToolFailurePayloadMaxBytes: 16_384,
    logToolFailurePayloads: false,
    mcpAuthDisableScopeChecks: false,
    mcpAuthMode: 'none' as 'jwt' | 'none',
    mcpServerVersion: '1.0.0-test',
    mcpSessionMode: 'auto',
    mcpTransportType: 'stdio',
    openTelemetry: { serviceName: 'test', serviceVersion: '0.0.0' },
  },
  /** Every record the `Logger` handed pino, in emission order. */
  writes: [] as Array<{ fields: Record<string, unknown>; level: string; msg: string }>,
}));

vi.mock('@/config/index.js', () => ({ config: mockConfig }));

vi.mock('pino', () => {
  const record = (level: string) => (fields: Record<string, unknown>, msg: string) => {
    writes.push({ fields, level, msg });
  };
  const instance = {
    debug: record('debug'),
    error: record('error'),
    fatal: record('fatal'),
    flush: (cb: (err?: Error) => void) => cb(),
    info: record('info'),
    level: 'debug',
    warn: record('warn'),
  };
  return { default: () => instance };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createInputRequiredGate } from '@/mcp-server/inputRequired.js';
import { type AnyToolDefinition, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import {
  createToolHandler,
  type HandlerServices,
} from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { logger, type OtelLogRecord, setOtelLogSink } from '@/utils/internal/logger.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const exported: OtelLogRecord[] = [];

const services = { logger, storage: {} } as unknown as HandlerServices;

/** A minimal ALS-backed context manager, so an active span propagates into the call. */
class AlsContextManager implements ContextManager {
  private readonly als = new AsyncLocalStorage<OtelContext>();
  active(): OtelContext {
    return this.als.getStore() ?? ROOT_CONTEXT;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: OtelContext,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.als.run(ctx, () => fn.call(thisArg as ThisParameterType<F>, ...args));
  }
  bind<T>(_ctx: OtelContext, target: T): T {
    return target;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    this.als.disable();
    return this;
  }
}

const TRACE_ID = 'a'.repeat(32);
const SPAN_ID = 'b'.repeat(16);

/** A value that marks the caller's arguments wherever a record might carry them. */
const SENTINEL = 'sentinel-arg-value-291';

const PAYLOAD_PREFIX = 'Tool failure payload: ';

beforeAll(async () => {
  otContext.setGlobalContextManager(new AlsContextManager());
  await logger.initialize('debug');
  setOtelLogSink({ emit: (record) => exported.push(record) });
});

afterAll(async () => {
  setOtelLogSink(undefined);
  await logger.close();
  otContext.disable();
});

beforeEach(() => {
  writes.length = 0;
  exported.length = 0;
  mockConfig.logToolFailurePayloads = false;
  mockConfig.logToolFailurePayloadMaxBytes = 16_384;
  mockConfig.mcpAuthMode = 'none';
});

/** Drives one `tools/call` through the factory inside a live trace. */
async function call(
  def: unknown,
  args: Record<string, unknown>,
  options: { gate?: ClientCapabilities; signal?: AbortSignal } = {},
): Promise<CallToolResult> {
  const handler = createToolHandler(
    def as AnyToolDefinition,
    services,
    {},
    options.gate ? createInputRequiredGate(() => options.gate) : undefined,
  );
  const parent = trace.setSpanContext(ROOT_CONTEXT, {
    spanId: SPAN_ID,
    traceFlags: 1,
    traceId: TRACE_ID,
  });
  return (await otContext.with(parent, () =>
    handler(args, makeServerContext(options.signal ? { signal: options.signal } : {})),
  )) as CallToolResult;
}

/** The payload records pino received. */
const payloadWrites = () => writes.filter((w) => w.msg.startsWith(PAYLOAD_PREFIX));

/** The one payload record pino received, failing when there is not exactly one. */
function onlyPayload(): { fields: Record<string, unknown>; level: string; msg: string } {
  const found = payloadWrites();
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** The call's own `Error in tool:` record. */
function errorRecord(): { fields: Record<string, unknown>; level: string; msg: string } {
  const found = writes.filter((w) => w.msg.startsWith('Error in tool:'));
  expect(found).toHaveLength(1);
  return found[0]!;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const probeInput = z.object({
  query: z.string().describe('Search query.'),
  limit: z.number().optional().describe('Maximum results.'),
  auth: z
    .object({ apiKey: z.string().describe('API key.') })
    .optional()
    .describe('Upstream credentials.'),
});

const ok = z.object({ ok: z.boolean().describe('Whether it worked.') });

const handlerThrows = tool('payload_throws', {
  description: 'Fails inside the handler.',
  input: probeInput,
  output: ok,
  handler: () => {
    throw new Error('probe failed');
  },
});

const breaksOutput = tool('payload_bad_output', {
  description: 'Returns a value its own output schema rejects.',
  input: probeInput,
  output: ok,
  handler: () => ({ ok: 'not a boolean' }) as never,
});

const scoped = tool('payload_scoped', {
  description: 'Requires a scope the caller does not hold.',
  input: probeInput,
  output: ok,
  auth: ['tool:payload_scoped:read'],
  handler: () => ({ ok: true }),
});

const succeeds = tool('payload_ok', {
  description: 'Succeeds.',
  input: probeInput,
  output: ok,
  handler: () => ({ ok: true }),
});

const softMiss = tool('payload_soft_miss', {
  description: 'Fails with a declared, milder severity.',
  input: probeInput,
  output: ok,
  errors: [
    {
      reason: 'soft_miss',
      code: JsonRpcErrorCode.NotFound,
      when: 'Nothing matched the query.',
      severity: 'warning',
      recovery: 'Broaden the query and call the tool again with fewer filters.',
    },
  ],
  handler: (_input, ctx) => {
    throw ctx.fail('soft_miss', 'Nothing matched.');
  },
});

const echoesSecret = tool('payload_echoes_secret', {
  description: 'Fails with a sensitive key in its error data.',
  input: probeInput,
  output: ok,
  handler: () => {
    throw new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Upstream refused.', {
      upstream: { session: { token: 'tok-in-error-data' } },
    });
  },
});

const cancelled = (controller: AbortController) =>
  tool('payload_cancelled', {
    description: 'Fails after the caller went away.',
    input: probeInput,
    output: ok,
    handler: () => {
      controller.abort();
      throw new Error('gone');
    },
  });

const asksForInput = tool('payload_asks', {
  description: 'Asks the caller for input.',
  input: probeInput,
  output: ok,
  handler: (_input, ctx) =>
    ctx.requestInput({
      inputRequests: {
        confirm: inputRequired.elicit({
          message: 'Proceed?',
          requestedSchema: z.object({ yes: z.boolean().describe('Proceed.') }),
        }),
      },
    }),
});

/** The four failure kinds the payload record covers, as `[label, definition, args, setup?]`. */
const FAILURES = [
  ['a handler throw', handlerThrows, { query: SENTINEL }, undefined],
  ['an output-schema failure', breaksOutput, { query: SENTINEL }, undefined],
  ['an argument rejection', handlerThrows, { query: SENTINEL, limit: 'ten' }, undefined],
  [
    'an auth refusal',
    scoped,
    { query: SENTINEL },
    () => {
      mockConfig.mcpAuthMode = 'jwt';
    },
  ],
] as const;

// ---------------------------------------------------------------------------
// Flag unset — today's behavior, pinned
// ---------------------------------------------------------------------------

describe('LOG_TOOL_FAILURE_PAYLOADS unset', () => {
  it.each(FAILURES)(
    'logs %s without a payload record or any argument value',
    async (_label, def, args, setup) => {
      setup?.();

      const result = await call(def, args);

      expect(result.isError).toBe(true);
      expect(errorRecord().level).toBe('error');
      expect(payloadWrites()).toEqual([]);
      expect(exported.filter((r) => r.body.startsWith(PAYLOAD_PREFIX))).toEqual([]);
      for (const w of writes) expect(JSON.stringify(w.fields)).not.toContain(SENTINEL);
      for (const r of exported) expect(JSON.stringify(r.attributes)).not.toContain(SENTINEL);
    },
  );

  it('writes exactly the records it always wrote for a handler throw', async () => {
    await call(handlerThrows, { query: SENTINEL });

    expect(writes.filter((w) => w.level !== 'debug').map((w) => [w.level, w.msg])).toEqual([
      ['info', 'Tool execution finished.'],
      ['error', 'Error in tool:payload_throws: probe failed'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Flag set
// ---------------------------------------------------------------------------

describe('LOG_TOOL_FAILURE_PAYLOADS=true', () => {
  beforeEach(() => {
    mockConfig.logToolFailurePayloads = true;
  });

  it.each(FAILURES)(
    'writes exactly one payload record for %s',
    async (_label, def, args, setup) => {
      setup?.();

      const result = await call(def, args);

      const payload = onlyPayload();
      expect(payload.msg).toBe(`${PAYLOAD_PREFIX}${(def as AnyToolDefinition).name}`);
      expect(JSON.parse(payload.fields.toolInput as string)).toEqual(args);
      expect(JSON.parse(payload.fields.toolResult as string)).toEqual(result);
      expect(payload.fields).toMatchObject({
        toolInputTruncated: false,
        toolName: (def as AnyToolDefinition).name,
        toolResultTruncated: false,
      });
    },
  );

  it.each(FAILURES)(
    'correlates the payload for %s with the call error record',
    async (_label, def, args, setup) => {
      setup?.();

      await call(def, args);

      const payload = onlyPayload();
      const error = errorRecord();
      expect(payload.fields.traceId).toBe(TRACE_ID);
      expect(payload.fields.requestId).toBe(error.fields.requestId);
      expect(payload.fields.traceId).toBe(error.fields.traceId);
    },
  );

  it('writes the payload after the error record, at the same default error level', async () => {
    await call(handlerThrows, { query: SENTINEL });

    const failures = writes.filter((w) => w.level === 'error').map((w) => w.msg);
    expect(failures).toEqual([
      'Error in tool:payload_throws: probe failed',
      `${PAYLOAD_PREFIX}payload_throws`,
    ]);
  });

  it('follows a declared severity to the error record level', async () => {
    await call(softMiss, { query: SENTINEL });

    expect(errorRecord().level).toBe('warn');
    expect(onlyPayload().level).toBe('warn');
    const exportedPayload = exported.filter((r) => r.body.startsWith(PAYLOAD_PREFIX));
    expect(exportedPayload.map((r) => [r.severityText, r.severityNumber])).toEqual([
      ['warning', 13],
    ]);
  });

  it.each([
    ['a success', () => call(succeeds, { query: SENTINEL })],
    [
      'a cancellation',
      () => {
        const controller = new AbortController();
        return call(cancelled(controller), { query: SENTINEL }, { signal: controller.signal });
      },
    ],
    [
      'an input_required return',
      () => call(asksForInput, { query: SENTINEL }, { gate: { elicitation: { form: {} } } }),
    ],
  ])('writes no payload record for %s, while a failed call beside it does', async (_label, run) => {
    await run();

    expect(payloadWrites()).toEqual([]);
    expect(exported.filter((r) => r.body.startsWith(PAYLOAD_PREFIX))).toEqual([]);
    for (const w of writes) expect(JSON.stringify(w.fields)).not.toContain(SENTINEL);

    await call(handlerThrows, { query: SENTINEL });
    expect(onlyPayload().msg).toBe(`${PAYLOAD_PREFIX}payload_throws`);
  });

  it('logs the arguments as sent, before pre-validation drops or renames keys', async () => {
    const args = { query: SENTINEL, _meta: { client: 'x' }, Limit: 'ten' };

    await call(handlerThrows, args);

    expect(JSON.parse(onlyPayload().fields.toolInput as string)).toEqual(args);
  });

  it('redacts a sensitive key at any depth of the arguments', async () => {
    const args = {
      query: SENTINEL,
      auth: { apiKey: 'sk-live-291' },
      extras: { level1: { level2: { level3: { password: 'hunter2', kept: 'visible' } } } },
    };

    await call(handlerThrows, args);

    const toolInput = onlyPayload().fields.toolInput as string;
    expect(JSON.parse(toolInput)).toEqual({
      query: SENTINEL,
      auth: { apiKey: '[REDACTED]' },
      extras: { level1: { level2: { level3: { password: '[REDACTED]', kept: 'visible' } } } },
    });
    expect(toolInput).not.toContain('sk-live-291');
    expect(toolInput).not.toContain('hunter2');
  });

  it('redacts the result on its own, leaving the client-visible result untouched', async () => {
    const result = await call(echoesSecret, { query: SENTINEL });

    expect(JSON.stringify(result)).toContain('tok-in-error-data');
    const toolResult = onlyPayload().fields.toolResult as string;
    expect(toolResult).not.toContain('tok-in-error-data');
    const expected = structuredClone(result) as {
      structuredContent: { error: { data: { upstream: { session: { token: string } } } } };
    };
    expected.structuredContent.error.data.upstream.session.token = '[REDACTED]';
    expect(JSON.parse(toolResult)).toEqual(expected);
  });

  it('truncates an oversized input and leaves the result whole', async () => {
    mockConfig.logToolFailurePayloadMaxBytes = 256;
    const args = { query: `${SENTINEL}-${'é'.repeat(400)}` };

    const result = await call(handlerThrows, args);

    const { fields } = onlyPayload();
    const toolInput = fields.toolInput as string;
    expect(fields.toolInputTruncated).toBe(true);
    expect(Buffer.byteLength(toolInput, 'utf8')).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(toolInput, 'utf8')).toBeGreaterThan(250);
    expect(toolInput.isWellFormed()).toBe(true);
    expect(JSON.stringify(args).startsWith(toolInput)).toBe(true);
    expect(fields.toolResultTruncated).toBe(false);
    expect(JSON.parse(fields.toolResult as string)).toEqual(result);
  });

  it('truncates an oversized result and leaves the input whole', async () => {
    mockConfig.logToolFailurePayloadMaxBytes = 256;
    const failsLoudly = tool('payload_loud', {
      description: 'Fails with a long message.',
      input: probeInput,
      output: ok,
      handler: () => {
        throw new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          `Upstream said: ${'🚫'.repeat(200)}`,
        );
      },
    });

    await call(failsLoudly, { query: SENTINEL });

    const { fields } = onlyPayload();
    const toolResult = fields.toolResult as string;
    expect(fields.toolResultTruncated).toBe(true);
    expect(Buffer.byteLength(toolResult, 'utf8')).toBeLessThanOrEqual(256);
    expect(toolResult.isWellFormed()).toBe(true);
    expect(fields.toolInputTruncated).toBe(false);
    expect(JSON.parse(fields.toolInput as string)).toEqual({ query: SENTINEL });
  });

  it('exports the payload fields as intact, redacted strings on the OTel path', async () => {
    const args = { query: SENTINEL, auth: { apiKey: 'sk-live-291' } };

    await call(handlerThrows, args);

    const exportedPayload = exported.filter((r) => r.body.startsWith(PAYLOAD_PREFIX));
    expect(exportedPayload).toHaveLength(1);
    const attributes = exportedPayload[0]!.attributes;
    expect(attributes).toMatchObject({
      requestId: onlyPayload().fields.requestId,
      toolInput: onlyPayload().fields.toolInput,
      toolInputTruncated: false,
      toolName: 'payload_throws',
      toolResult: onlyPayload().fields.toolResult,
      toolResultTruncated: false,
      traceId: TRACE_ID,
    });
    expect(JSON.parse(attributes.toolInput as string)).toEqual({
      query: SENTINEL,
      auth: { apiKey: '[REDACTED]' },
    });
    expect(exportedPayload[0]!.severityText).toBe('error');
  });

  it('leaves the client-visible result identical to the flag-unset call', async () => {
    const withFlag = await call(handlerThrows, { query: SENTINEL, limit: 'ten' });
    expect(onlyPayload().fields.toolResult).toBe(JSON.stringify(withFlag));
    mockConfig.logToolFailurePayloads = false;
    const withoutFlag = await call(handlerThrows, { query: SENTINEL, limit: 'ten' });

    expect(withFlag).toEqual(withoutFlag);
    expect(payloadWrites()).toHaveLength(1);
  });
});

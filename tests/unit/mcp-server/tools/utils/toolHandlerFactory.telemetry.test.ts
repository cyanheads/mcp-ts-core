/**
 * @fileoverview End-to-end telemetry coverage for the tool handler factory
 * running the real `measureToolExecution`. The sibling
 * `toolHandlerFactory.test.ts` stubs the measurement out to isolate factory
 * behavior, so the span, metric, and completion-log signals a call actually
 * emits are asserted here instead.
 * @module tests/mcp-server/tools/utils/toolHandlerFactory.telemetry.test
 */

import type { CallToolResult, ClientCapabilities } from '@modelcontextprotocol/server';
import { inputRequired } from '@modelcontextprotocol/server';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { z } from 'zod';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { makeServerContext } from '../../../../helpers/server-context.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const {
  counterAddFor,
  mockClassifiedCounterAdd,
  mockConfig,
  mockCounterAdd,
  mockErrorCounterAdd,
  mockHistogramRecord,
  mockLogger,
  mockRejectionCounterAdd,
  mockUpDownCounterAdd,
} = vi.hoisted(() => {
  const classified = vi.fn();
  const toolErrors = vi.fn();
  const rejections = vi.fn();
  const other = vi.fn();
  const byName: Record<string, typeof other> = {
    'mcp.errors.classified': classified,
    'mcp.tool.errors': toolErrors,
    'mcp.tool.rejections': rejections,
  };
  return {
    counterAddFor: (name: string) => byName[name] ?? other,
    mockClassifiedCounterAdd: classified,
    mockCounterAdd: other,
    mockErrorCounterAdd: toolErrors,
    mockRejectionCounterAdd: rejections,
    mockConfig: {
      environment: 'testing',
      mcpServerVersion: '1.0.0-test',
      mcpAuthMode: 'none' as string,
      mcpSessionMode: 'auto' as const,
      openTelemetry: { serviceName: 'test', serviceVersion: '0.0.0' },
    },
    mockHistogramRecord: vi.fn(),
    mockLogger: {
      debug: vi.fn(),
      info: vi.fn(),
      notice: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      crit: vi.fn(),
      emerg: vi.fn(),
      child: vi.fn(),
    },
    mockUpDownCounterAdd: vi.fn(),
  };
});

vi.mock('@/config/index.js', () => ({ config: mockConfig }));

vi.mock('@/utils/internal/logger.js', () => ({
  logger: mockLogger,
  Logger: { getInstance: () => mockLogger },
}));

vi.mock('@/utils/telemetry/metrics.js', () => ({
  createCounter: vi.fn((name: string) => ({ add: counterAddFor(name) })),
  createHistogram: vi.fn(() => ({ record: mockHistogramRecord })),
  createUpDownCounter: vi.fn(() => ({ add: mockUpDownCounterAdd })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createInputRequiredGate } from '@/mcp-server/inputRequired.js';
import type { AnyToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import {
  createToolHandler,
  type HandlerServices,
  type NotifierSources,
} from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { authContext } from '@/mcp-server/transports/auth/lib/authContext.js';
import { partialResult, partialResultSchema } from '@/utils/formatting/partialResult.js';
import { TELEMETRY_LOG_MESSAGES } from '@/utils/internal/telemetryMessages.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const services: HandlerServices = {
  logger: mockLogger as never,
  storage: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => ({ keys: [] })),
    getMany: vi.fn(async () => new Map()),
  } as never,
};

const notifiers: NotifierSources = {};

const span = {
  setAttributes: vi.fn(),
  setAttribute: vi.fn(),
  setStatus: vi.fn(),
  recordException: vi.fn(),
  end: vi.fn(),
};

const tracer = {
  startActiveSpan: vi.fn(async (_name: string, callback: (s: unknown) => unknown) =>
    callback(span),
  ),
};

/** The `metrics` payload of the completion log the call emitted. */
function completionMetrics(): Record<string, unknown> {
  const call = mockLogger.info.mock.calls.findLast(
    ([message]) => message === TELEMETRY_LOG_MESSAGES.toolExecutionFinished,
  );
  if (!call) throw new Error('No tool completion log was emitted');
  return (call[1] as { extra: { metrics: Record<string, unknown> } }).extra.metrics;
}

/**
 * Histogram records carrying the tool name alone — `mcp.tool.input_bytes` then
 * `mcp.tool.output_bytes`. `mcp.tool.duration` also carries the success
 * attribute, so it never matches.
 */
function byteRecords(toolName: string): [number, Record<string, unknown>][] {
  return mockHistogramRecord.mock.calls.filter(([, attrs]) => {
    const map = attrs as Record<string, unknown>;
    return map['mcp.tool.name'] === toolName && Object.keys(map).length === 1;
  }) as [number, Record<string, unknown>][];
}

async function callTool(def: unknown, input: Record<string, unknown> = {}) {
  const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
  return (await handler(input, makeServerContext())) as CallToolResult;
}

/** The same call behind the 2025-era capability gate over `declared` (#379). */
async function callGatedTool(def: unknown, declared: ClientCapabilities) {
  const handler = createToolHandler(
    def as AnyToolDefinition,
    services,
    notifiers,
    createInputRequiredGate(() => declared),
  );
  return (await handler({}, makeServerContext())) as CallToolResult;
}

// ---------------------------------------------------------------------------
// Definitions — one per failure surface named in #346
// ---------------------------------------------------------------------------

const brokenOutput = tool('broken_output', {
  description: 'Returns a value that fails the output contract.',
  input: z.object({}),
  output: z.object({ value: z.number().describe('A number the handler never returns.') }),
  handler: () => ({}) as { value: number },
});

const brokenFormat = tool('broken_format', {
  description: 'Returns a valid value whose formatter throws.',
  input: z.object({}),
  output: z.object({ value: z.number().describe('A number.') }),
  handler: () => ({ value: 1 }),
  format: () => {
    throw new Error('formatter blew up');
  },
});

const brokenEnrichment = tool('broken_enrichment', {
  description: 'Declares a required enrichment field the handler never populates.',
  input: z.object({}),
  output: z.object({ value: z.number().describe('A number.') }),
  enrichment: { total: z.number().describe('Required enrichment field.') },
  handler: (_input, ctx) => {
    ctx.enrich({ other: 'populates a different key' } as never);
    return { value: 1 };
  },
});

const brokenTrailer = tool('broken_trailer', {
  description: 'Declares a trailer renderer that throws.',
  input: z.object({}),
  output: z.object({ value: z.number().describe('A number.') }),
  enrichment: { total: z.number().describe('Populated enrichment field.') },
  enrichmentTrailer: {
    total: {
      render: () => {
        throw new Error('trailer render blew up');
      },
    },
  },
  handler: (_input, ctx) => {
    ctx.enrich({ total: 1 });
    return { value: 1 };
  },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tool telemetry records the terminal outcome (#346)', () => {
  let tracerSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue(tracer as never);
  });

  afterEach(() => {
    tracerSpy.mockRestore();
  });

  describe.each([
    ['output-schema validation', brokenOutput, 'broken_output'],
    ['format()', brokenFormat, 'broken_format'],
    ['the enrichment merge', brokenEnrichment, 'broken_enrichment'],
    ['a trailer render()', brokenTrailer, 'broken_trailer'],
  ])('a failure in %s', (_surface, def, toolName) => {
    it('marks the span ERROR and counts the call as a failure', async () => {
      const result = await callTool(def);

      expect(result.isError).toBe(true);
      expect(span.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ code: SpanStatusCode.ERROR }),
      );
      expect(span.setAttributes).toHaveBeenLastCalledWith(
        expect.objectContaining({ 'mcp.tool.success': false }),
      );
      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        'mcp.tool.name': toolName,
        'mcp.tool.success': false,
        'mcp.tool.outcome': 'error',
      });
      expect(mockErrorCounterAdd).toHaveBeenCalledWith(1, {
        'mcp.tool.name': toolName,
        'mcp.tool.error_category': 'server',
        'mcp.tool.outcome': 'error',
      });
    });

    it('logs the completion as a failure and records no output bytes', async () => {
      await callTool(def);

      expect(completionMetrics()).toMatchObject({ isSuccess: false });
      // Only `mcp.tool.input_bytes`.
      expect(byteRecords(toolName)).toHaveLength(1);
      expect(span.setAttribute).not.toHaveBeenCalledWith(
        'mcp.tool.output_bytes',
        expect.anything(),
      );
    });
  });

  describe('a successful call', () => {
    const searchTool = tool('telemetry_search', {
      description: 'Returns matches with an enrichment total.',
      input: z.object({ q: z.string().describe('query') }),
      output: z.object({ items: z.array(z.string()).describe('matches') }),
      enrichment: { totalCount: z.number().describe('total before limit') },
      handler: (_input, ctx) => {
        ctx.enrich.total(2);
        return { items: ['a', 'b'] };
      },
      format: (result) => [{ type: 'text', text: result.items.join(', ') }],
    });

    it('keeps its span attributes, metrics, content, and structured output', async () => {
      const result = await callTool(searchTool, { q: 'x' });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ items: ['a', 'b'], totalCount: 2 });
      expect(result.content).toEqual([
        { type: 'text', text: 'a, b' },
        { type: 'text', text: '\n\n**2 total**' },
      ]);

      expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
      expect(span.setAttributes).toHaveBeenLastCalledWith(
        expect.objectContaining({ 'mcp.tool.success': true }),
      );
      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        'mcp.tool.name': 'telemetry_search',
        'mcp.tool.success': true,
        'mcp.tool.outcome': 'ok',
      });
      expect(mockErrorCounterAdd).not.toHaveBeenCalled();
      expect(completionMetrics()).toMatchObject({ isSuccess: true });
    });

    it('measures output bytes against the handler payload, not the assembled result', async () => {
      await callTool(searchTool, { q: 'x' });

      const domainBytes = Buffer.byteLength(JSON.stringify({ items: ['a', 'b'] }), 'utf8');
      const records = byteRecords('telemetry_search');
      expect(records).toHaveLength(2);
      expect(records[1]?.[0]).toBe(domainBytes);
      expect(completionMetrics().outputBytes).toBe(domainBytes);
      expect(span.setAttribute).toHaveBeenCalledWith('mcp.tool.output_bytes', domainBytes);
    });

    it('reports partial success from the handler batch envelope', async () => {
      const batchTool = tool('telemetry_batch', {
        description: 'Returns a partial batch result.',
        input: z.object({}),
        output: z.object({
          succeeded: z.array(z.string()).describe('ids that resolved'),
          failed: z.array(z.string()).describe('ids that did not'),
        }),
        handler: () => ({ succeeded: ['1'], failed: ['2'] }),
      });

      await callTool(batchTool);

      expect(span.setAttribute).toHaveBeenCalledWith('mcp.tool.partial_success', true);
      expect(completionMetrics()).toMatchObject({ partialSuccess: true });
    });
  });

  // Issue #524 — a partialResultSchema output reports under the author's keys.
  describe('a partialResultSchema batch', () => {
    const Item = z.object({ pmid: z.string().describe('PMID') });
    const Reason = z.enum(['not_found']).describe('Why it failed');
    const schemaFor = (succeededKey: string, failedKey: string) =>
      partialResultSchema({
        succeededKey,
        succeededSchema: Item,
        failedKey,
        idKey: 'pmid',
        reason: Reason,
      });
    const Out = schemaFor('articles', 'unavailable');
    const batch = {
      articles: [{ pmid: '1' }, { pmid: '3' }],
      unavailable: [{ pmid: '2', reason: 'not_found' }],
    };

    /** A tool over `output` whose handler returns `result`. */
    const batchTool = (output: unknown, result: unknown) =>
      tool('telemetry_partial', {
        description: 'Returns a partial batch result.',
        input: z.object({}),
        output: output as typeof Out,
        handler: () => result as z.infer<typeof Out>,
      });

    function expectPartial(batchSucceeded: number, batchFailed: number): void {
      expect(span.setAttribute).toHaveBeenCalledWith('mcp.tool.partial_success', true);
      expect(span.setAttribute).toHaveBeenCalledWith('mcp.tool.batch.failed_count', batchFailed);
      expect(span.setAttribute).toHaveBeenCalledWith(
        'mcp.tool.batch.succeeded_count',
        batchSucceeded,
      );
      expect(completionMetrics()).toMatchObject({
        partialSuccess: true,
        batchFailed,
        batchSucceeded,
      });
    }

    function expectNoPartial(): void {
      expect(span.setAttribute).not.toHaveBeenCalledWith(
        'mcp.tool.partial_success',
        expect.anything(),
      );
      expect(completionMetrics().partialSuccess).toBeUndefined();
    }

    it.each([
      ['as built', Out, { ...batch, totalSucceeded: 2 }],
      [
        'after .extend()',
        Out.extend({ note: z.string().describe('Note') }),
        { ...batch, totalSucceeded: 2, note: 'x' },
      ],
      ['after .pick()', Out.pick({ articles: true, unavailable: true }), batch],
      ['after .omit()', Out.omit({ totalSucceeded: true }), batch],
      ['after a .shape spread', z.object({ ...Out.shape }), { ...batch, totalSucceeded: 2 }],
    ])('reports articles/unavailable %s', async (_label, output, result) => {
      const call = await callTool(batchTool(output, result));

      expect(call.isError).toBeUndefined();
      expectPartial(2, 1);
    });

    it('reports batchSucceeded when only the succeeded key is custom', async () => {
      const result = partialResult({
        succeededKey: 'articles',
        succeeded: batch.articles,
        failedKey: 'failed',
        failed: batch.unavailable,
      });

      await callTool(batchTool(schemaFor('articles', 'failed'), result));

      expectPartial(2, 1);
    });

    it('reports nothing when the failed array is absent', async () => {
      const result = partialResult({
        succeededKey: 'articles',
        succeeded: batch.articles,
        failedKey: 'unavailable',
        failed: [],
      });

      await callTool(batchTool(Out, result));

      expectNoPartial();
    });

    it('reports nothing for hand-written arrays under other names', async () => {
      const output = z.object({
        articles: z.array(Item).describe('Found'),
        unavailable: z.array(Item).describe('Missing'),
      });

      await callTool(
        batchTool(output, { articles: [{ pmid: '1' }], unavailable: [{ pmid: '2' }] }),
      );

      expectNoPartial();
    });
  });

  describe('an input-required round', () => {
    const confirmSchema = z.object({ confirm: z.boolean().describe('confirm') });

    const confirmingTool = tool('telemetry_confirm', {
      description: 'Requests confirmation before acting.',
      input: z.object({}),
      output: z.object({ confirmed: z.boolean().describe('confirmed') }),
      handler: (_input, ctx) =>
        ctx.requestInput({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: 'Proceed?',
              requestedSchema: confirmSchema,
            }),
          },
        }),
    });

    it('stays a success with no error metric', async () => {
      const result = (await callTool(confirmingTool)) as unknown as { resultType: string };

      expect(result.resultType).toBe('input_required');
      expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
      expect(span.setAttribute).toHaveBeenCalledWith('mcp.tool.input_required', true);
      expect(mockErrorCounterAdd).not.toHaveBeenCalled();
      expect(completionMetrics()).toMatchObject({ isSuccess: true, inputRequired: true });
      // No output payload was produced, so nothing is recorded for it.
      expect(byteRecords('telemetry_confirm')).toHaveLength(1);
    });

    it('stays a success when the connection declares the capability', async () => {
      // The regression pin for the gate: a fulfillable round is measured
      // exactly as it is without one.
      const result = (await callGatedTool(confirmingTool, {
        elicitation: { form: {} },
      })) as unknown as { resultType: string };

      expect(result.resultType).toBe('input_required');
      expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
      expect(span.setAttribute).toHaveBeenCalledWith('mcp.tool.input_required', true);
      expect(mockErrorCounterAdd).not.toHaveBeenCalled();
      expect(completionMetrics()).toMatchObject({ isSuccess: true, inputRequired: true });
    });

    it('records a capability-refused round as a failed call (#379)', async () => {
      // The client receives `isError: true`; the span, the metrics, and the
      // completion log have to say the same thing. A refusal resolved after
      // the measured region closes is recorded as a successful input-required
      // round, and telemetry then contradicts the wire.
      const result = (await callGatedTool(confirmingTool, {})) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(span.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ code: SpanStatusCode.ERROR }),
      );
      expect(span.setAttributes).toHaveBeenLastCalledWith(
        expect.objectContaining({ 'mcp.tool.success': false }),
      );
      expect(span.setAttribute).toHaveBeenCalledWith(
        'mcp.tool.error_code',
        String(JsonRpcErrorCode.InvalidRequest),
      );
      expect(span.setAttribute).not.toHaveBeenCalledWith('mcp.tool.input_required', true);
      expect(mockErrorCounterAdd).toHaveBeenCalledWith(1, {
        'mcp.tool.name': 'telemetry_confirm',
        'mcp.tool.error_category': 'client',
        'mcp.tool.outcome': 'error',
      });
      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        'mcp.tool.name': 'telemetry_confirm',
        'mcp.tool.success': false,
        'mcp.tool.outcome': 'error',
      });
      expect(completionMetrics()).toMatchObject({
        isSuccess: false,
        errorCode: String(JsonRpcErrorCode.InvalidRequest),
      });
    });
  });

  // Issue #380 — a declared severity is a logging decision. Every counter, the
  // span status, and the completion log record the call exactly as they did.
  describe('a failure whose reason declares a severity (#380)', () => {
    const consentContract = [
      {
        reason: 'consent_declined',
        code: JsonRpcErrorCode.InvalidRequest,
        when: 'The caller declined the confirmation prompt.',
        severity: 'notice',
        recovery: 'Re-run the tool and confirm the prompt to proceed with the change.',
      },
    ] as const;

    /** A tool that fails with `reason`, under a contract that declares one severity. */
    function decliner(name: string, reason: string) {
      return tool(name, {
        description: 'Fails with a declared reason.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('ok') }),
        errors: consentContract as never,
        handler: () => {
          throw new McpError(JsonRpcErrorCode.InvalidRequest, 'Declined.', { reason });
        },
      });
    }

    /** Attributes of the last `mcp.errors.classified` increment. */
    function classifiedAttributes(): Record<string, unknown> {
      const call = mockClassifiedCounterAdd.mock.calls.at(-1);
      if (!call) throw new Error('mcp.errors.classified was never incremented');
      return call[1] as Record<string, unknown>;
    }

    it('records mcp.error.severity on the classified counter', async () => {
      await callTool(decliner('severity_counted', 'consent_declined'));

      expect(classifiedAttributes()).toEqual({
        'mcp.error.classified_code': String(JsonRpcErrorCode.InvalidRequest),
        'mcp.error.category': 'client',
        'mcp.error.severity': 'notice',
        operation: 'tool:severity_counted',
      });
    });

    it.each([
      ['a reason the contract never declared', 'undeclared_below_handler'],
      ['a reason declared without a severity', 'consent_declined'],
    ])('adds no attribute for %s', async (_label, reason) => {
      const def =
        reason === 'consent_declined'
          ? tool('severity_uncounted', {
              description: 'Fails under a contract that declares no severity.',
              input: z.object({}),
              output: z.object({ ok: z.boolean().describe('ok') }),
              errors: [{ ...consentContract[0], severity: undefined }] as never,
              handler: () => {
                throw new McpError(JsonRpcErrorCode.InvalidRequest, 'Declined.', { reason });
              },
            })
          : decliner('severity_uncounted', reason);

      await callTool(def);

      expect(classifiedAttributes()).toEqual({
        'mcp.error.classified_code': String(JsonRpcErrorCode.InvalidRequest),
        'mcp.error.category': 'client',
        operation: 'tool:severity_uncounted',
      });
    });

    it('never puts the reason string on a metric', async () => {
      await callTool(decliner('severity_cardinality', 'consent_declined'));

      for (const [, attributes] of [
        ...mockClassifiedCounterAdd.mock.calls,
        ...mockErrorCounterAdd.mock.calls,
        ...mockCounterAdd.mock.calls,
        ...mockHistogramRecord.mock.calls,
      ]) {
        expect(Object.values((attributes ?? {}) as Record<string, unknown>)).not.toContain(
          'consent_declined',
        );
      }
    });

    it('still marks the span ERROR and counts the call as a failure', async () => {
      const result = await callTool(decliner('severity_still_failed', 'consent_declined'));

      expect(result.isError).toBe(true);
      expect(span.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ code: SpanStatusCode.ERROR }),
      );
      expect(span.setAttributes).toHaveBeenLastCalledWith(
        expect.objectContaining({ 'mcp.tool.success': false }),
      );
      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        'mcp.tool.name': 'severity_still_failed',
        'mcp.tool.success': false,
        'mcp.tool.outcome': 'error',
      });
      expect(mockHistogramRecord).toHaveBeenCalledWith(expect.any(Number), {
        'mcp.tool.name': 'severity_still_failed',
        'mcp.tool.success': false,
      });
      expect(mockErrorCounterAdd).toHaveBeenCalledWith(1, {
        'mcp.tool.name': 'severity_still_failed',
        'mcp.tool.error_category': 'client',
        'mcp.tool.outcome': 'error',
      });
      expect(completionMetrics()).toMatchObject({
        isSuccess: false,
        errorCode: String(JsonRpcErrorCode.InvalidRequest),
      });
    });
  });

  describe('a handler failure', () => {
    it('still reports the failure it did in 0.12.2', async () => {
      const def = tool('telemetry_throws', {
        description: 'Throws from the handler.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: () => {
          throw new Error('handler blew up');
        },
      });

      const result = await callTool(def);

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: { code: JsonRpcErrorCode.InternalError, message: 'handler blew up' },
      });
      expect(completionMetrics()).toMatchObject({ isSuccess: false });
      expect(mockErrorCounterAdd).toHaveBeenCalledWith(1, {
        'mcp.tool.name': 'telemetry_throws',
        'mcp.tool.error_category': 'server',
        'mcp.tool.outcome': 'error',
      });
    });
  });

  // Issues #480, #481, #482 — one origin per failure: the wire code, the
  // category on `mcp.tool.errors`, and the category on `mcp.errors.classified`
  // all describe the same code.
  describe('the wire code and both error counters agree', () => {
    /** The single `mcp.errors.classified` increment this call made. */
    function classifiedAttributes(): Record<string, unknown> {
      expect(mockClassifiedCounterAdd).toHaveBeenCalledTimes(1);
      return mockClassifiedCounterAdd.mock.calls[0]?.[1] as Record<string, unknown>;
    }

    /** The single `mcp.tool.errors` increment this call made. */
    function toolErrorAttributes(): Record<string, unknown> {
      expect(mockErrorCounterAdd).toHaveBeenCalledTimes(1);
      return mockErrorCounterAdd.mock.calls[0]?.[1] as Record<string, unknown>;
    }

    /** A tool whose handler runs `run`. */
    const throwing = (name: string, run: () => unknown) =>
      tool(name, {
        description: 'Fails from the handler.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: () => run() as { ok: boolean },
      });

    it.each([
      ['Error("boom")', () => new Error('boom'), JsonRpcErrorCode.InternalError, 'server'],
      [
        'Error("Request timed out")',
        () => new Error('Request timed out'),
        JsonRpcErrorCode.Timeout,
        'upstream',
      ],
      [
        'Error("status code 503")',
        () => new Error('status code 503'),
        JsonRpcErrorCode.ServiceUnavailable,
        'upstream',
      ],
      [
        'a handler-thrown ZodError',
        () => z.number().safeParse('x').error,
        JsonRpcErrorCode.ValidationError,
        'client',
      ],
    ])('for %s', async (_label, makeError, code, category) => {
      const result = await callTool(
        throwing('agree_tool', () => {
          throw makeError();
        }),
      );

      expect((result.structuredContent as { error: { code: number } }).error.code).toBe(code);
      expect(toolErrorAttributes()).toEqual({
        'mcp.tool.name': 'agree_tool',
        'mcp.tool.error_category': category,
        'mcp.tool.outcome': 'error',
      });
      expect(classifiedAttributes()).toEqual({
        'mcp.error.classified_code': String(code),
        'mcp.error.category': category,
        operation: 'tool:agree_tool',
      });
    });

    it('returns -32603 for a handler that recurses without bound (#482)', async () => {
      const recurse = (): number => recurse() + 1;
      const result = await callTool(throwing('overflow_tool', () => ({ ok: recurse() > 0 })));

      expect(result.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.InternalError,
          message: expect.stringMatching(/^Maximum call stack size exceeded\.?$/),
        },
      });
      expect(toolErrorAttributes()['mcp.tool.error_category']).toBe('server');
      expect(classifiedAttributes()).toEqual({
        'mcp.error.classified_code': String(JsonRpcErrorCode.InternalError),
        'mcp.error.category': 'server',
        operation: 'tool:overflow_tool',
      });
    });

    it.each([
      [
        'an output-schema violation',
        brokenOutput,
        'broken_output',
        /^Tool broken_output returned output that does not match its output schema: value: /,
      ],
      [
        'an unpopulated required enrichment field',
        brokenEnrichment,
        'broken_enrichment',
        /^Tool broken_enrichment returned enrichment that does not match its enrichment schema: total: /,
      ],
    ])(
      'files %s as an InternalError naming the contract (#480)',
      async (_label, def, name, message) => {
        const result = await callTool(def);

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual({
          error: { code: JsonRpcErrorCode.InternalError, message: expect.stringMatching(message) },
        });
        expect(result.content).toEqual([
          {
            type: 'text',
            text: expect.stringMatching(new RegExp(`^Error: ${message.source.slice(1)}`)),
          },
        ]);
        expect(toolErrorAttributes()['mcp.tool.error_category']).toBe('server');
        expect(classifiedAttributes()).toEqual({
          'mcp.error.classified_code': String(JsonRpcErrorCode.InternalError),
          'mcp.error.category': 'server',
          operation: `tool:${name}`,
        });
      },
    );

    it.each([
      [
        'the canvas tenant-cap refusal',
        { reason: 'canvas_capacity_exhausted' },
        JsonRpcErrorCode.RateLimited,
        'server',
      ],
      [
        'any other RateLimited',
        { reason: 'upstream_throttled' },
        JsonRpcErrorCode.RateLimited,
        'upstream',
      ],
    ])('keeps %s on its McpError category', async (_label, data, code, category) => {
      await callTool(
        throwing('mcp_error_tool', () => {
          throw new McpError(code, 'refused', data);
        }),
      );

      expect(toolErrorAttributes()['mcp.tool.error_category']).toBe(category);
      expect(classifiedAttributes()['mcp.error.category']).toBe(category);
    });
  });

  // Issue #546 — calls rejected before the measured region, and cancellations.
  describe('pre-handler rejections and cancellation (#546)', () => {
    const guarded = tool('guarded_tool', {
      description: 'Requires a scope and a name.',
      input: z.object({ name: z.string().describe('A name') }),
      output: z.object({ name: z.string().describe('The name') }),
      auth: ['tool:guarded_tool:read'],
      handler: ({ name }) => ({ name }),
    });

    afterEach(() => {
      mockConfig.mcpAuthMode = 'none';
    });

    /** Asserts the call counted only as a rejection with `code`. */
    function expectRejectionOnly(code: number, category: string): void {
      expect(mockRejectionCounterAdd).toHaveBeenCalledTimes(1);
      expect(mockRejectionCounterAdd).toHaveBeenCalledWith(1, {
        'mcp.tool.name': 'guarded_tool',
        'mcp.tool.error_code': String(code),
        'mcp.tool.error_category': category,
      });
      expect(mockCounterAdd).not.toHaveBeenCalledWith(
        1,
        expect.objectContaining({ 'mcp.tool.name': 'guarded_tool' }),
      );
      expect(mockHistogramRecord).not.toHaveBeenCalled();
      expect(mockErrorCounterAdd).not.toHaveBeenCalled();
      expect(mockClassifiedCounterAdd).toHaveBeenCalledTimes(1);
    }

    it('counts an argument rejection once, outside the call metrics', async () => {
      // A boolean: an integer for `name` is repaired and the call succeeds (#487).
      const result = await callTool(guarded, { name: true });

      expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
        JsonRpcErrorCode.InvalidParams,
      );
      expectRejectionOnly(JsonRpcErrorCode.InvalidParams, 'client');
    });

    it('counts a missing scope as a rejection', async () => {
      mockConfig.mcpAuthMode = 'jwt';
      const authInfo = { token: 't', clientId: 'c', scopes: [] };

      const result = await authContext.run({ authInfo } as never, () =>
        callTool(guarded, { name: 'x' }),
      );

      expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
        JsonRpcErrorCode.Forbidden,
      );
      expectRejectionOnly(JsonRpcErrorCode.Forbidden, 'client');
    });

    it('counts a missing auth context as a rejection', async () => {
      mockConfig.mcpAuthMode = 'jwt';

      const result = await callTool(guarded, { name: 'x' });

      expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
        JsonRpcErrorCode.Unauthorized,
      );
      expectRejectionOnly(JsonRpcErrorCode.Unauthorized, 'client');
    });

    it('records a cancelled call as cancelled on calls and errors', async () => {
      const controller = new AbortController();
      const waiting = tool('cancelled_tool', {
        description: 'Waits for the caller to hang up.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: (_input, ctx) =>
          new Promise<{ ok: boolean }>((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error('upstream gave up')), {
              once: true,
            });
            controller.abort('client disconnected');
          }),
      });

      const handler = createToolHandler(waiting as AnyToolDefinition, services, notifiers);
      const result = (await handler(
        {},
        makeServerContext({ signal: controller.signal }),
      )) as CallToolResult;

      expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
        JsonRpcErrorCode.RequestCancelled,
      );
      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        'mcp.tool.name': 'cancelled_tool',
        'mcp.tool.success': false,
        'mcp.tool.outcome': 'cancelled',
      });
      expect(mockErrorCounterAdd).toHaveBeenCalledWith(1, {
        'mcp.tool.name': 'cancelled_tool',
        'mcp.tool.error_category': 'client',
        'mcp.tool.outcome': 'cancelled',
      });
      expect(mockHistogramRecord).toHaveBeenCalledWith(expect.any(Number), {
        'mcp.tool.name': 'cancelled_tool',
        'mcp.tool.success': false,
      });
      expect(mockRejectionCounterAdd).not.toHaveBeenCalled();
      expect(mockClassifiedCounterAdd.mock.calls[0]?.[1]).toEqual({
        'mcp.error.classified_code': String(JsonRpcErrorCode.RequestCancelled),
        'mcp.error.category': 'client',
        operation: 'tool:cancelled_tool',
      });
    });

    it('records an input_required round as ok', async () => {
      const confirming = tool('ok_input_tool', {
        description: 'Requests confirmation.',
        input: z.object({}),
        output: z.object({ confirmed: z.boolean().describe('confirmed') }),
        handler: (_input, ctx) =>
          ctx.requestInput({
            inputRequests: {
              confirm: inputRequired.elicit({
                message: 'Proceed?',
                requestedSchema: z.object({ confirm: z.boolean().describe('confirm') }),
              }),
            },
          }),
      });

      await callTool(confirming);

      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        'mcp.tool.name': 'ok_input_tool',
        'mcp.tool.success': true,
        'mcp.tool.outcome': 'ok',
      });
      expect(mockRejectionCounterAdd).not.toHaveBeenCalled();
    });
  });
});

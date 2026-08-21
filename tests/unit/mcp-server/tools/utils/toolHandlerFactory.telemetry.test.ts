/**
 * @fileoverview End-to-end telemetry coverage for the tool handler factory
 * running the real `measureToolExecution`. The sibling
 * `toolHandlerFactory.test.ts` stubs the measurement out to isolate factory
 * behavior, so the span, metric, and completion-log signals a call actually
 * emits are asserted here instead.
 * @module tests/mcp-server/tools/utils/toolHandlerFactory.telemetry.test
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import { inputRequired } from '@modelcontextprotocol/server';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { z } from 'zod';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { makeServerContext } from '../../../../helpers/server-context.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const {
  mockConfig,
  mockCounterAdd,
  mockErrorCounterAdd,
  mockHistogramRecord,
  mockLogger,
  mockUpDownCounterAdd,
} = vi.hoisted(() => ({
  mockConfig: {
    environment: 'testing',
    mcpServerVersion: '1.0.0-test',
    mcpAuthMode: 'none',
    mcpSessionMode: 'auto' as const,
    openTelemetry: { serviceName: 'test', serviceVersion: '0.0.0' },
  },
  mockCounterAdd: vi.fn(),
  mockErrorCounterAdd: vi.fn(),
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
}));

vi.mock('@/config/index.js', () => ({ config: mockConfig }));

vi.mock('@/utils/internal/logger.js', () => ({
  logger: mockLogger,
  Logger: { getInstance: () => mockLogger },
}));

vi.mock('@/utils/telemetry/metrics.js', () => ({
  createCounter: vi.fn((name: string) => ({
    add: name === 'mcp.tool.errors' ? mockErrorCounterAdd : mockCounterAdd,
  })),
  createHistogram: vi.fn(() => ({ record: mockHistogramRecord })),
  createUpDownCounter: vi.fn(() => ({ add: mockUpDownCounterAdd })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type { AnyToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import {
  createToolHandler,
  type HandlerFactoryServices,
  type HandlerNotifiers,
} from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { TELEMETRY_LOG_MESSAGES } from '@/utils/internal/telemetryMessages.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const services: HandlerFactoryServices = {
  logger: mockLogger as never,
  storage: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => ({ keys: [] })),
    getMany: vi.fn(async () => new Map()),
  } as never,
};

const notifiers: HandlerNotifiers = {};

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
      });
      expect(mockErrorCounterAdd).toHaveBeenCalledWith(1, {
        'mcp.tool.name': toolName,
        'mcp.tool.error_category': 'server',
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
      });
    });
  });
});

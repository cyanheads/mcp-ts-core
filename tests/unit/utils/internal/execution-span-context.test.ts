/**
 * @fileoverview Verifies that a handler's `ctx.traceId` / `ctx.spanId` name the
 * execution span the handler runs in, on every transport (#296). Runs against a
 * real OpenTelemetry tracer provider and the unmocked handler factories — the
 * defect this covers is an ordering between two real subsystems, so a mocked
 * tracer or a mocked `measure*Execution` would assert the fix rather than the
 * behavior.
 * @module tests/unit/utils/internal/execution-span-context.test
 */

import { context as otelContext, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Context } from '@/core/context.js';
import {
  type AnyResourceDefinition,
  resource,
} from '@/mcp-server/resources/utils/resourceDefinition.js';
import { createResourceHandler } from '@/mcp-server/resources/utils/resourceHandlerFactory.js';
import { type AnyToolDefinition, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { createToolHandler } from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { logger } from '@/utils/internal/logger.js';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

const noopStorage = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => ({ keys: [] }),
  getMany: async () => new Map(),
} as never;

const services = { logger: logger as never, storage: noopStorage };

/** The single exported span whose name starts with `prefix`. */
function exportedSpan(prefix: string) {
  const spans = exporter.getFinishedSpans().filter((s) => s.name.startsWith(prefix));
  expect(spans).toHaveLength(1);
  return spans[0]!;
}

describe('handler context binds to its execution span (#296)', () => {
  beforeAll(() => {
    // `register()` installs the global tracer provider *and* the platform
    // context manager, which is what makes the active span propagate across
    // the awaits between the factory and the handler.
    provider.register();
  });

  afterAll(async () => {
    exporter.reset();
    await provider.shutdown();
    trace.disable();
    otelContext.disable();
  });

  beforeEach(() => {
    exporter.reset();
  });

  describe('tools', () => {
    let captured: Context | undefined;

    const def = tool('span_probe', {
      description: 'Captures the context it is handed.',
      input: z.object({ n: z.number().describe('A number.') }),
      output: z.object({ n: z.number().describe('The same number.') }),
      handler: (input, ctx) => {
        captured = ctx;
        return { n: input.n };
      },
    });

    beforeEach(() => {
      captured = undefined;
    });

    it('supplies both IDs with no enclosing transport span (stdio)', async () => {
      const handler = createToolHandler(def as AnyToolDefinition, services, {});
      await handler({ n: 1 }, {} as never);

      const execution = exportedSpan('tool_execution:');
      expect(captured?.traceId).toBe(execution.spanContext().traceId);
      expect(captured?.spanId).toBe(execution.spanContext().spanId);
    });

    it('keeps the request trace ID and exposes the child execution span ID (HTTP)', async () => {
      const handler = createToolHandler(def as AnyToolDefinition, services, {});
      const requestSpan = provider.getTracer('test').startSpan('request');
      await otelContext.with(trace.setSpan(otelContext.active(), requestSpan), () =>
        handler({ n: 2 }, {} as never),
      );
      requestSpan.end();

      const execution = exportedSpan('tool_execution:');
      const request = requestSpan.spanContext();

      expect(captured?.traceId).toBe(request.traceId);
      expect(captured?.spanId).toBe(execution.spanContext().spanId);
      expect(captured?.spanId).not.toBe(request.spanId);
    });

    it('binds the handler-scoped logger to the execution span, not the request span', async () => {
      const handler = createToolHandler(def as AnyToolDefinition, services, {});
      const requestSpan = provider.getTracer('test').startSpan('request');
      await otelContext.with(trace.setSpan(otelContext.active(), requestSpan), () =>
        handler({ n: 3 }, {} as never),
      );
      requestSpan.end();

      const execution = exportedSpan('tool_execution:');
      // `ctx.log` closes over the context it was built from, so a context that
      // was correct only on `ctx` would still emit the request span's ID.
      const emitted: Record<string, unknown>[] = [];
      const original = logger.info.bind(logger);
      try {
        (logger as { info: typeof logger.info }).info = ((
          _msg: string,
          c?: Record<string, unknown>,
        ) => {
          emitted.push({ ...c });
        }) as typeof logger.info;
        captured?.log.info('probe');
      } finally {
        (logger as { info: typeof logger.info }).info = original;
      }

      expect(emitted[0]?.spanId).toBe(execution.spanContext().spanId);
    });
  });

  describe('resources', () => {
    let captured: Context | undefined;

    const def = resource('probe://span/{id}', {
      name: 'span_probe_resource',
      description: 'Captures the context it is handed.',
      mimeType: 'application/json',
      handler: (_params, ctx) => {
        captured = ctx;
        return { ok: true };
      },
    });

    beforeEach(() => {
      captured = undefined;
    });

    it('supplies both IDs with no enclosing transport span (stdio)', async () => {
      const handler = createResourceHandler(def as AnyResourceDefinition, services, {});
      await handler(new URL('probe://span/1'), { id: '1' }, {} as never);

      const execution = exportedSpan('resource_read:');
      expect(captured?.traceId).toBe(execution.spanContext().traceId);
      expect(captured?.spanId).toBe(execution.spanContext().spanId);
    });

    it('keeps the request trace ID and exposes the child execution span ID (HTTP)', async () => {
      const handler = createResourceHandler(def as AnyResourceDefinition, services, {});
      const requestSpan = provider.getTracer('test').startSpan('request');
      await otelContext.with(trace.setSpan(otelContext.active(), requestSpan), () =>
        handler(new URL('probe://span/2'), { id: '2' }, {} as never),
      );
      requestSpan.end();

      const execution = exportedSpan('resource_read:');
      const request = requestSpan.spanContext();

      expect(captured?.traceId).toBe(request.traceId);
      expect(captured?.spanId).toBe(execution.spanContext().spanId);
      expect(captured?.spanId).not.toBe(request.spanId);
    });
  });
});

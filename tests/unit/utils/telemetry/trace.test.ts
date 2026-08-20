/**
 * @fileoverview Test suite for OpenTelemetry tracing
 * @module tests/utils/telemetry/trace.test
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type ContextManager,
  type Context as OtelContext,
  context as otContext,
  propagation,
  ROOT_CONTEXT,
  type Span,
  type SpanContext,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from 'vitest';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import * as traceUtils from '@/utils/telemetry/trace.js';

describe('OpenTelemetry Tracing', () => {
  describe('buildTraceparent', () => {
    let getActiveSpanSpy: MockInstance;

    beforeEach(() => {
      getActiveSpanSpy = vi.spyOn(trace, 'getActiveSpan');
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    test('should build traceparent from RequestContext', () => {
      const ctx: RequestContext = {
        requestId: 'test-req',
        timestamp: Date.now() as any,
        operation: 'test',
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
      };

      const result = traceUtils.buildTraceparent(ctx);

      expect(result).toBe(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
    });

    test('should build traceparent from active span when context missing', () => {
      const mockSpanContext: SpanContext = {
        traceId: '1'.repeat(32),
        spanId: '2'.repeat(16),
        traceFlags: 1,
      };

      const mockSpan = {
        spanContext: () => mockSpanContext,
      } as Span;

      getActiveSpanSpy.mockReturnValue(mockSpan);

      const result = traceUtils.buildTraceparent();

      expect(result).toBe(`00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`);
    });

    test('should return undefined when no context or active span', () => {
      getActiveSpanSpy.mockReturnValue(undefined as unknown as Span);

      const result = traceUtils.buildTraceparent();

      expect(result).toBeUndefined();
    });

    test('should return undefined when context has incomplete trace data', () => {
      const ctx: RequestContext = {
        requestId: 'test-req',
        timestamp: Date.now() as any,
        operation: 'test',
        traceId: 'a'.repeat(32),
        // Missing spanId
      };

      getActiveSpanSpy.mockReturnValue(undefined as unknown as Span);

      const result = traceUtils.buildTraceparent(ctx);

      expect(result).toBeUndefined();
    });

    test('should prefer context traceId/spanId over active span', () => {
      const ctx: RequestContext = {
        requestId: 'test-req',
        timestamp: Date.now() as any,
        operation: 'test',
        traceId: 'c'.repeat(32),
        spanId: 'd'.repeat(16),
      };

      const mockSpanContext: SpanContext = {
        traceId: '1'.repeat(32),
        spanId: '2'.repeat(16),
        traceFlags: 1,
      };

      const mockSpan = {
        spanContext: () => mockSpanContext,
      } as Span;

      getActiveSpanSpy.mockReturnValue(mockSpan);

      const result = traceUtils.buildTraceparent(ctx);

      // Should use context values, not span values
      expect(result).toBe(`00-${'c'.repeat(32)}-${'d'.repeat(16)}-01`);
    });

    test('should always use sampled flag "01"', () => {
      const ctx: RequestContext = {
        requestId: 'test-req',
        timestamp: Date.now() as any,
        operation: 'test',
        traceId: 'e'.repeat(32),
        spanId: 'f'.repeat(16),
      };

      const result = traceUtils.buildTraceparent(ctx);

      expect(result).toMatch(/-01$/);
    });
  });

  describe('extractTraceparent', () => {
    test('should extract valid traceparent from Web Headers', () => {
      const headers = new Headers();
      const traceId = 'a'.repeat(32);
      const spanId = 'b'.repeat(16);
      headers.set('traceparent', `00-${traceId}-${spanId}-01`);

      const result = traceUtils.extractTraceparent(headers);

      expect(result).toEqual({
        traceId,
        spanId,
        sampled: true,
      });
    });

    test('should extract valid traceparent from plain object', () => {
      const traceId = 'c'.repeat(32);
      const spanId = 'd'.repeat(16);
      const headers = {
        traceparent: `00-${traceId}-${spanId}-00`,
      };

      const result = traceUtils.extractTraceparent(headers);

      expect(result).toEqual({
        traceId,
        spanId,
        sampled: false,
      });
    });

    test('should return undefined when traceparent header missing', () => {
      const headers = new Headers();

      const result = traceUtils.extractTraceparent(headers);

      expect(result).toBeUndefined();
    });

    test('should return undefined for malformed traceparent', () => {
      const headers = { traceparent: 'invalid-format' };

      const result = traceUtils.extractTraceparent(headers);

      expect(result).toBeUndefined();
    });

    test('should return undefined for wrong version', () => {
      const headers = {
        traceparent: `01-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
      };

      const result = traceUtils.extractTraceparent(headers);

      expect(result).toBeUndefined();
    });

    test('should return undefined for short traceId', () => {
      const headers = {
        traceparent: `00-${'a'.repeat(31)}-${'b'.repeat(16)}-01`,
      };

      const result = traceUtils.extractTraceparent(headers);

      expect(result).toBeUndefined();
    });

    test('should return undefined for short spanId', () => {
      const headers = {
        traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(15)}-01`,
      };

      const result = traceUtils.extractTraceparent(headers);

      expect(result).toBeUndefined();
    });

    test('should parse sampled flag correctly', () => {
      const traceId = 'e'.repeat(32);
      const spanId = 'f'.repeat(16);

      const sampledHeaders = {
        traceparent: `00-${traceId}-${spanId}-01`,
      };
      const unsampledHeaders = {
        traceparent: `00-${traceId}-${spanId}-00`,
      };

      expect(traceUtils.extractTraceparent(sampledHeaders)?.sampled).toBe(true);
      expect(traceUtils.extractTraceparent(unsampledHeaders)?.sampled).toBe(false);
    });
  });

  describe('createContextWithParentTrace', () => {
    test('should create context with parent trace from headers', () => {
      const traceId = 'a'.repeat(32);
      const spanId = 'b'.repeat(16);
      const headers = {
        traceparent: `00-${traceId}-${spanId}-01`,
      };

      const result = traceUtils.createContextWithParentTrace(headers, 'test-operation');

      expect(result.operation).toBe('test-operation');
      expect(result.traceId).toBe(traceId);
      expect(result.extra?.parentSpanId).toBe(spanId);
    });

    test('should work with Web Headers', () => {
      const traceId = 'c'.repeat(32);
      const spanId = 'd'.repeat(16);
      const headers = new Headers();
      headers.set('traceparent', `00-${traceId}-${spanId}-01`);

      const result = traceUtils.createContextWithParentTrace(headers, 'web-request');

      expect(result.operation).toBe('web-request');
      expect(result.traceId).toBe(traceId);
      expect(result.extra?.parentSpanId).toBe(spanId);
    });
  });

  describe('injectCurrentContextInto', () => {
    let injectSpy: MockInstance;

    beforeEach(() => {
      injectSpy = vi.spyOn(propagation, 'inject');
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    test('should inject current context into carrier', () => {
      const carrier = { 'Content-Type': 'application/json' };

      const result = traceUtils.injectCurrentContextInto(carrier);

      expect(injectSpy).toHaveBeenCalledWith(otContext.active(), carrier);
      expect(result).toBe(carrier);
    });

    test('should return same carrier object', () => {
      const carrier = { key: 'value' };

      const result = traceUtils.injectCurrentContextInto(carrier);

      expect(result).toBe(carrier);
    });

    test('should work with empty carrier', () => {
      const carrier = {};

      traceUtils.injectCurrentContextInto(carrier);

      expect(injectSpy).toHaveBeenCalled();
    });
  });

  describe('withSpan', () => {
    let mockTracer: any;
    // getTracerSpy kept for potential future verification
    // let getTracerSpy: MockInstance;
    let mockSpan: any;

    beforeEach(() => {
      mockSpan = {
        setAttributes: vi.fn(),
        setStatus: vi.fn(),
        recordException: vi.fn(),
        end: vi.fn(),
        spanContext: () => ({
          traceId: 'a'.repeat(32),
          spanId: 'b'.repeat(16),
          traceFlags: 1,
        }),
      };

      mockTracer = {
        startActiveSpan: vi.fn((_name, fn) => fn(mockSpan)),
      };

      vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    test('should create span and execute function successfully', async () => {
      const testFn = vi.fn(async () => 'result');

      const result = await traceUtils.withSpan('test-operation', testFn);

      expect(result).toBe('result');
      expect(mockTracer.startActiveSpan).toHaveBeenCalledWith(
        'test-operation',
        expect.any(Function),
      );
      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.OK,
      });
      expect(mockSpan.end).toHaveBeenCalled();
    });

    test('should set attributes on span', async () => {
      const attributes = {
        'db.table': 'users',
        'db.operation': 'select',
        count: 42,
        enabled: true,
      };

      await traceUtils.withSpan('db-query', async () => {}, attributes);

      expect(mockSpan.setAttributes).toHaveBeenCalledWith(attributes);
    });

    test('should handle errors and mark span as error', async () => {
      const error = new Error('Test error');
      const testFn = async () => {
        throw error;
      };

      await expect(traceUtils.withSpan('failing-op', testFn)).rejects.toThrow('Test error');

      expect(mockSpan.recordException).toHaveBeenCalledWith(error);
      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: 'Test error',
      });
      expect(mockSpan.end).toHaveBeenCalled();
    });

    test('should handle non-Error exceptions', async () => {
      const testFn = async () => {
        throw 'string error';
      };

      await expect(traceUtils.withSpan('failing-op', testFn)).rejects.toThrow();

      expect(mockSpan.recordException).toHaveBeenCalledWith(new Error('string error'));
      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: 'string error',
      });
    });

    test('should end span even on error', async () => {
      const testFn = async () => {
        throw new Error('fail');
      };

      await expect(traceUtils.withSpan('error-op', testFn)).rejects.toThrow();

      expect(mockSpan.end).toHaveBeenCalled();
    });

    test('should pass span to function', async () => {
      const testFn = vi.fn(async (span: Span) => {
        expect(span).toBe(mockSpan);
      });

      await traceUtils.withSpan('test-op', testFn);

      expect(testFn).toHaveBeenCalledWith(mockSpan);
    });
  });

  describe('runInContext', () => {
    test('should run function directly when no context provided', () => {
      const fn = vi.fn(() => 'result');

      const result = traceUtils.runInContext(undefined, fn);

      expect(result).toBe('result');
      expect(fn).toHaveBeenCalled();
    });

    test('should run function directly when context missing traceId', () => {
      const ctx: RequestContext = {
        requestId: 'test',
        timestamp: Date.now() as any,
        operation: 'test',
        // No traceId
      };
      const fn = vi.fn(() => 'result');

      const result = traceUtils.runInContext(ctx, fn);

      expect(result).toBe('result');
      expect(fn).toHaveBeenCalled();
    });

    test('should run function directly when context missing spanId', () => {
      const ctx: RequestContext = {
        requestId: 'test',
        timestamp: Date.now() as any,
        operation: 'test',
        traceId: 'a'.repeat(32),
        // No spanId
      };
      const fn = vi.fn(() => 'result');

      const result = traceUtils.runInContext(ctx, fn);

      expect(result).toBe('result');
      expect(fn).toHaveBeenCalled();
    });

    test('should execute function with context when trace data present', () => {
      const ctx: RequestContext = {
        requestId: 'test',
        timestamp: Date.now() as any,
        operation: 'test',
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
      };
      const fn = vi.fn(() => 'result');

      const result = traceUtils.runInContext(ctx, fn);

      expect(result).toBe('result');
      expect(fn).toHaveBeenCalled();
    });

    test('should preserve function return value', () => {
      const ctx: RequestContext = {
        requestId: 'test',
        timestamp: Date.now() as any,
        operation: 'test',
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
      };

      const result = traceUtils.runInContext(ctx, () => 42);

      expect(result).toBe(42);
    });

    test('should propagate exceptions', () => {
      const ctx: RequestContext = {
        requestId: 'test',
        timestamp: Date.now() as any,
        operation: 'test',
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
      };

      expect(() =>
        traceUtils.runInContext(ctx, () => {
          throw new Error('test error');
        }),
      ).toThrow('test error');
    });
  });

  describe('Integration tests', () => {
    test('should build and extract traceparent in round-trip', () => {
      const originalTraceId = 'a'.repeat(32);
      const originalSpanId = 'b'.repeat(16);

      const ctx: RequestContext = {
        requestId: 'test',
        timestamp: Date.now() as any,
        operation: 'test',
        traceId: originalTraceId,
        spanId: originalSpanId,
      };

      const traceparent = traceUtils.buildTraceparent(ctx);
      expect(traceparent).toBeDefined();

      const headers = { traceparent: traceparent! };
      const extracted = traceUtils.extractTraceparent(headers);

      expect(extracted?.traceId).toBe(originalTraceId);
      expect(extracted?.spanId).toBe(originalSpanId);
      expect(extracted?.sampled).toBe(true);
    });

    test('should create child context from parent traceparent', () => {
      const parentTraceId = 'c'.repeat(32);
      const parentSpanId = 'd'.repeat(16);

      const headers = {
        traceparent: `00-${parentTraceId}-${parentSpanId}-01`,
      };

      const childContext = traceUtils.createContextWithParentTrace(headers, 'child-operation');

      expect(childContext.traceId).toBe(parentTraceId);
      expect(childContext.extra?.parentSpanId).toBe(parentSpanId);
      expect(childContext.operation).toBe('child-operation');
    });
  });

  describe('runDetached', () => {
    /**
     * Minimal AsyncLocalStorage-backed context manager. The API default is a
     * no-op that never propagates, which would make these assertions vacuous —
     * and ALS propagation is exactly the mechanism under test (#294).
     */
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

    const fakeSpanContext: SpanContext = {
      traceId: 'f'.repeat(32),
      spanId: 'e'.repeat(16),
      traceFlags: 1,
    };

    beforeEach(() => {
      otContext.setGlobalContextManager(new AlsContextManager());
    });

    afterEach(() => {
      otContext.disable();
      vi.restoreAllMocks();
    });

    test('should run the callback with no active span and restore the caller context', () => {
      const parent = trace.setSpanContext(ROOT_CONTEXT, fakeSpanContext);

      otContext.with(parent, () => {
        expect(trace.getActiveSpan()?.spanContext().traceId).toBe(fakeSpanContext.traceId);

        traceUtils.runDetached(() => {
          expect(trace.getActiveSpan()).toBeUndefined();
        });

        expect(trace.getActiveSpan()?.spanContext().traceId).toBe(fakeSpanContext.traceId);
      });
    });

    test('should return the callback result', () => {
      expect(traceUtils.runDetached(() => 'bound')).toBe('bound');
    });

    /**
     * The regression case. Async work started inside an active span inherits it
     * through ALS — that is how binding a server inside the startup span pinned
     * every later request to one traceId. `runDetached` severs the inheritance.
     */
    test('should sever ALS inheritance for async work started inside a span', async () => {
      const parent = trace.setSpanContext(ROOT_CONTEXT, fakeSpanContext);
      let inherited: string | undefined;
      let detached: string | undefined;

      const deferred = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

      await otContext.with(parent, async () => {
        await deferred();
        inherited = trace.getActiveSpan()?.spanContext().traceId;

        await traceUtils.runDetached(async () => {
          await deferred();
          detached = trace.getActiveSpan()?.spanContext().traceId;
        });
      });

      // Guards the test itself: without real propagation the next assertion
      // would pass for the wrong reason.
      expect(inherited).toBe(fakeSpanContext.traceId);
      expect(detached).toBeUndefined();
    });
  });
});

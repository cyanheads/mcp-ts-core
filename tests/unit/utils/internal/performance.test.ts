/**
 * @fileoverview Unit tests for the performance measurement helper.
 * @module tests/utils/internal/performance.test
 */

import { SpanStatusCode, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { InputRequiredSignal } from '../../../../src/mcp-server/inputRequired.js';
import { JsonRpcErrorCode, McpError } from '../../../../src/types-global/errors.js';
import { logger } from '../../../../src/utils/internal/logger.js';
import {
  measurePromptGeneration,
  measureResourceExecution,
  measureToolExecution,
} from '../../../../src/utils/internal/performance.js';

// Shared OTel metric mocks (hoisted for vi.mock factory)
const { mockCounterAdd, mockErrorCounterAdd, mockHistogramRecord, mockUpDownCounterAdd } =
  vi.hoisted(() => ({
    mockCounterAdd: vi.fn(),
    mockErrorCounterAdd: vi.fn(),
    mockHistogramRecord: vi.fn(),
    mockUpDownCounterAdd: vi.fn(),
  }));

vi.mock('../../../../src/utils/telemetry/metrics.js', () => ({
  createCounter: vi.fn((name: string) => ({
    add: name.endsWith('.errors') ? mockErrorCounterAdd : mockCounterAdd,
  })),
  createHistogram: vi.fn(() => ({ record: mockHistogramRecord })),
  createUpDownCounter: vi.fn(() => ({ add: mockUpDownCounterAdd })),
}));

describe('measureToolExecution', () => {
  const span = {
    setAttributes: vi.fn(),
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    end: vi.fn(),
  };
  const tracer = {
    startActiveSpan: vi.fn(async (_name, callback) => callback(span as never)),
  };
  let tracerSpy: MockInstance;
  let infoSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue(tracer as never);
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    tracerSpy.mockRestore();
    infoSpy.mockRestore();
  });

  /**
   * Histogram records carrying the tool name alone — `mcp.tool.input_bytes`
   * then `mcp.tool.output_bytes`, in emission order. `mcp.tool.duration` also
   * carries the success attribute, so it never matches.
   */
  const byteRecords = (toolName: string): [number, Record<string, unknown>][] =>
    mockHistogramRecord.mock.calls.filter(([, attrs]) => {
      const map = attrs as Record<string, unknown>;
      return map['mcp.tool.name'] === toolName && Object.keys(map).length === 1;
    }) as [number, Record<string, unknown>][];

  it('records success metrics and returns the tool result', async () => {
    const byteLengthSpy = vi.spyOn(Buffer, 'byteLength');

    const result = await measureToolExecution(
      async () => ({ message: 'ok' }),
      {
        toolName: 'test-tool',
        requestId: 'req-1',
        timestamp: new Date().toISOString(),
      },
      { input: 'value' },
    );

    expect(result).toEqual({ message: 'ok' });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const call = infoSpy.mock.calls[0];
    if (!call) throw new Error('infoSpy was not called');
    const [, logMeta] = call;
    expect((logMeta as any).extra.metrics.isSuccess).toBe(true);
    expect((logMeta as any).extra.metrics.errorCode).toBeUndefined();
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(span.setAttributes).toHaveBeenLastCalledWith(
      expect.objectContaining({
        'mcp.tool.duration_ms': expect.any(Number),
        'mcp.tool.success': true,
      }),
    );
    expect(span.end).toHaveBeenCalled();
    expect(byteLengthSpy).toHaveBeenCalled();
    byteLengthSpy.mockRestore();
  });

  it('records OTel metric counter and histogram on success', async () => {
    await measureToolExecution(
      async () => ({ message: 'ok' }),
      { toolName: 'metric-tool', requestId: 'req-m1', timestamp: new Date().toISOString() },
      { input: 'v' },
    );

    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.tool.name': 'metric-tool',
      'mcp.tool.success': true,
    });
    expect(mockHistogramRecord).toHaveBeenCalledWith(expect.any(Number), {
      'mcp.tool.name': 'metric-tool',
      'mcp.tool.success': true,
    });
    expect(mockErrorCounterAdd).not.toHaveBeenCalled();
  });

  it('records OTel error counter on failure', async () => {
    await expect(
      measureToolExecution(
        async () => {
          throw new McpError(JsonRpcErrorCode.InternalError, 'fail');
        },
        { toolName: 'err-tool', requestId: 'req-m2', timestamp: new Date().toISOString() },
        {},
      ),
    ).rejects.toThrow();

    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.tool.name': 'err-tool',
      'mcp.tool.success': false,
    });
    expect(mockHistogramRecord).toHaveBeenCalledWith(expect.any(Number), {
      'mcp.tool.name': 'err-tool',
      'mcp.tool.success': false,
    });
    expect(mockErrorCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.tool.name': 'err-tool',
      'mcp.tool.error_category': 'server',
    });
  });

  it('captures error metadata and rethrows the original McpError', async () => {
    const failure = new McpError(JsonRpcErrorCode.InternalError, 'boom');

    await expect(
      measureToolExecution(
        async () => {
          throw failure;
        },
        {
          toolName: 'failing-tool',
          requestId: 'req-2',
          timestamp: new Date().toISOString(),
        },
        { payload: 'data' },
      ),
    ).rejects.toBe(failure);

    expect(span.recordException).toHaveBeenCalledWith(failure);
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'boom',
    });
    expect(span.setAttribute).toHaveBeenCalledWith(
      'mcp.tool.error_code',
      String(JsonRpcErrorCode.InternalError),
    );
    const call = infoSpy.mock.calls[0];
    if (!call) throw new Error('infoSpy was not called');
    const [, logMeta] = call;
    expect((logMeta as any).extra.metrics.isSuccess).toBe(false);
    expect((logMeta as any).extra.metrics.errorCode).toBe(String(JsonRpcErrorCode.InternalError));
  });

  it('handles generic errors and uses JSON length fallback when Buffer is unavailable', async () => {
    const mutableGlobal = globalThis as {
      Buffer?: typeof Buffer;
      TextEncoder?: typeof TextEncoder;
    };
    const originalBuffer = mutableGlobal.Buffer;
    const originalTextEncoder = mutableGlobal.TextEncoder;
    // Simulate an environment without Buffer/TextEncoder support.
    delete mutableGlobal.Buffer;
    delete mutableGlobal.TextEncoder;

    const failure = new Error('unexpected');
    const payload = { key: 'value' };
    const expectedBytes = JSON.stringify(payload).length;

    try {
      await expect(
        measureToolExecution(
          async () => {
            throw failure;
          },
          {
            toolName: 'generic-failure',
            requestId: 'req-3',
            timestamp: new Date().toISOString(),
          },
          payload,
        ),
      ).rejects.toBe(failure);
    } finally {
      // Restore globals for other tests.
      if (originalBuffer) mutableGlobal.Buffer = originalBuffer;
      else delete mutableGlobal.Buffer;

      if (originalTextEncoder) mutableGlobal.TextEncoder = originalTextEncoder;
      else delete mutableGlobal.TextEncoder;
    }

    expect(span.setAttribute).toHaveBeenCalledWith('mcp.tool.error_code', 'UNHANDLED_ERROR');
    const call = infoSpy.mock.calls[0];
    if (!call) throw new Error('infoSpy was not called');
    const [, logMeta] = call;
    expect((logMeta as any).extra.metrics.inputBytes).toBe(expectedBytes);
    expect((logMeta as any).extra.metrics.outputBytes).toBe(0);
  });

  it('measures the callback return value when no output payload is designated', async () => {
    const returned = { message: 'ok', items: [1, 2, 3] };

    await measureToolExecution(
      async () => returned,
      { toolName: 'default-payload', requestId: 'req-d1', timestamp: new Date().toISOString() },
      { input: 'value' },
    );

    const records = byteRecords('default-payload');
    expect(records).toHaveLength(2);
    expect(records[1]?.[0]).toBe(Buffer.byteLength(JSON.stringify(returned), 'utf8'));
  });

  it('measures the designated output payload rather than the callback return value', async () => {
    const domain = { items: ['a', 'b'] };

    await measureToolExecution(
      async (_spanContext, recordOutput) => {
        recordOutput(domain);
        // What the callback returns is the assembled client result, which
        // re-renders the domain payload into content[] — measuring it would
        // double-count.
        return { structuredContent: domain, content: [{ type: 'text', text: 'a, b' }] };
      },
      { toolName: 'designated-payload', requestId: 'req-d2', timestamp: new Date().toISOString() },
      {},
    );

    const records = byteRecords('designated-payload');
    expect(records).toHaveLength(2);
    expect(records[1]?.[0]).toBe(Buffer.byteLength(JSON.stringify(domain), 'utf8'));
  });

  it('detects partial success from the designated payload', async () => {
    await measureToolExecution(
      async (_spanContext, recordOutput) => {
        recordOutput({ succeeded: [{ id: '1' }], failed: [{ id: '2', error: 'nope' }] });
        return { structuredContent: { ok: true }, content: [] };
      },
      { toolName: 'designated-batch', requestId: 'req-d3', timestamp: new Date().toISOString() },
      {},
    );

    expect(span.setAttribute).toHaveBeenCalledWith('mcp.tool.partial_success', true);
    expect(span.setAttribute).toHaveBeenCalledWith('mcp.tool.batch.failed_count', 1);
    expect(span.setAttribute).toHaveBeenCalledWith('mcp.tool.batch.succeeded_count', 1);
  });

  it('records a failure and no output bytes when the callback throws after designating output', async () => {
    await expect(
      measureToolExecution(
        async (_spanContext, recordOutput) => {
          recordOutput({ value: 1 });
          throw new Error('post-handler failure');
        },
        { toolName: 'post-handler', requestId: 'req-d4', timestamp: new Date().toISOString() },
        {},
      ),
    ).rejects.toThrow('post-handler failure');

    // Only `mcp.tool.input_bytes` — the output histogram stays untouched.
    expect(byteRecords('post-handler')).toHaveLength(1);
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'post-handler failure',
    });
    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.tool.name': 'post-handler',
      'mcp.tool.success': false,
    });
    expect(mockErrorCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.tool.name': 'post-handler',
      'mcp.tool.error_category': 'server',
    });

    const call = infoSpy.mock.calls[0];
    if (!call) throw new Error('infoSpy was not called');
    expect((call[1] as any).extra.metrics.isSuccess).toBe(false);
  });

  it('detects partial success when result contains a non-empty failed array', async () => {
    const result = await measureToolExecution(
      async () => ({
        succeeded: [{ id: '1' }, { id: '2' }],
        failed: [{ id: '3', error: 'not found' }],
      }),
      { toolName: 'batch-tool', requestId: 'req-ps1', timestamp: new Date().toISOString() },
      { ids: ['1', '2', '3'] },
    );

    expect(result.succeeded).toHaveLength(2);
    expect(result.failed).toHaveLength(1);

    // Span attributes
    expect(span.setAttribute).toHaveBeenCalledWith('mcp.tool.partial_success', true);
    expect(span.setAttribute).toHaveBeenCalledWith('mcp.tool.batch.failed_count', 1);
    expect(span.setAttribute).toHaveBeenCalledWith('mcp.tool.batch.succeeded_count', 2);

    // Still treated as success at the call level
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ 'mcp.tool.success': true }),
    );

    // Structured log includes partial success fields
    const call = infoSpy.mock.calls[0];
    if (!call) throw new Error('infoSpy was not called');
    const [, logMeta] = call;
    expect((logMeta as any).extra.metrics.partialSuccess).toBe(true);
    expect((logMeta as any).extra.metrics.batchSucceeded).toBe(2);
    expect((logMeta as any).extra.metrics.batchFailed).toBe(1);
  });

  it('does not set partial success when failed array is empty', async () => {
    await measureToolExecution(
      async () => ({ succeeded: [{ id: '1' }], failed: [] }),
      { toolName: 'batch-ok', requestId: 'req-ps2', timestamp: new Date().toISOString() },
      { ids: ['1'] },
    );

    expect(span.setAttribute).not.toHaveBeenCalledWith(
      'mcp.tool.partial_success',
      expect.anything(),
    );
    const call = infoSpy.mock.calls[0];
    if (!call) throw new Error('infoSpy was not called');
    const [, logMeta] = call;
    expect((logMeta as any).extra.metrics.partialSuccess).toBeUndefined();
  });

  it('handles partial success without a succeeded array', async () => {
    await measureToolExecution(
      async () => ({ failed: [{ id: '1', error: 'bad' }] }),
      { toolName: 'no-succeeded', requestId: 'req-ps3', timestamp: new Date().toISOString() },
      { ids: ['1'] },
    );

    expect(span.setAttribute).toHaveBeenCalledWith('mcp.tool.partial_success', true);
    expect(span.setAttribute).toHaveBeenCalledWith('mcp.tool.batch.failed_count', 1);
    expect(span.setAttribute).not.toHaveBeenCalledWith(
      'mcp.tool.batch.succeeded_count',
      expect.anything(),
    );
  });

  it('does not detect partial success on non-object results', async () => {
    await measureToolExecution(
      async () => 'plain string',
      { toolName: 'string-tool', requestId: 'req-ps4', timestamp: new Date().toISOString() },
      {},
    );

    expect(span.setAttribute).not.toHaveBeenCalledWith(
      'mcp.tool.partial_success',
      expect.anything(),
    );
  });

  it('uses TextEncoder fallback when Buffer is unavailable but TextEncoder exists', async () => {
    const mutableGlobal = globalThis as {
      Buffer?: typeof Buffer;
      TextEncoder?: typeof TextEncoder;
    };
    const originalBuffer = mutableGlobal.Buffer;
    const originalTextEncoder = mutableGlobal.TextEncoder;

    delete mutableGlobal.Buffer;

    const encodeSpy = vi.fn((input: string) => {
      const arr = new Uint8Array(input.length);
      for (let i = 0; i < input.length; i += 1) {
        arr[i] = input.charCodeAt(i);
      }
      return arr;
    });

    class FakeTextEncoder {
      encode(value: string): Uint8Array {
        return encodeSpy(value);
      }
    }

    mutableGlobal.TextEncoder = FakeTextEncoder as unknown as typeof TextEncoder;

    infoSpy.mockRestore();
    const localInfoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

    try {
      const result = await measureToolExecution(
        async () => ({ ok: true }),
        {
          toolName: 'text-encoder-fallback',
          requestId: 'req-4',
          timestamp: new Date().toISOString(),
        },
        { input: 'value' },
      );

      expect(result).toEqual({ ok: true });
      expect(encodeSpy).toHaveBeenCalled();
      const call = localInfoSpy.mock.calls[0];
      if (!call) throw new Error('info logger was not called');
      const [, logMeta] = call;
      expect((logMeta as any).extra.metrics.isSuccess).toBe(true);
      expect((logMeta as any).extra.metrics.errorCode).toBeUndefined();
    } finally {
      if (originalBuffer) mutableGlobal.Buffer = originalBuffer;
      else delete mutableGlobal.Buffer;

      if (originalTextEncoder) mutableGlobal.TextEncoder = originalTextEncoder;
      else delete mutableGlobal.TextEncoder;

      localInfoSpy.mockRestore();
      infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    }
  });

  it('estimates every JSON value shape when BigInt makes serialization fail', async () => {
    const payload = {
      nil: null,
      missing: undefined,
      string: 'é',
      number: 12,
      bigint: 1n,
      yes: true,
      no: false,
      array: [1, 2],
      object: { first: 'x', second: 2 },
      ignored: () => 'not serialized',
    };

    await measureToolExecution(
      async () => ({ output: 2n }),
      { toolName: 'bigint-payload', requestId: 'req-5', timestamp: new Date().toISOString() },
      payload,
    );

    const call = infoSpy.mock.calls[0];
    if (!call) throw new Error('infoSpy was not called');
    const [, logMeta] = call;
    expect((logMeta as any).extra.metrics.inputBytes).toBeGreaterThan(0);
    expect((logMeta as any).extra.metrics.outputBytes).toBeGreaterThan(0);
  });

  it('returns zero bytes when both serialization and structural estimation fail', async () => {
    const hostileOutput = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('keys unavailable');
        },
      },
    );

    await measureToolExecution(
      async () => hostileOutput,
      { toolName: 'hostile-output', requestId: 'req-6', timestamp: new Date().toISOString() },
      null,
    );

    const call = infoSpy.mock.calls[0];
    if (!call) throw new Error('infoSpy was not called');
    const [, logMeta] = call;
    expect((logMeta as any).extra.metrics.inputBytes).toBe(0);
    expect((logMeta as any).extra.metrics.outputBytes).toBe(0);
  });

  it('adds caller-provided success attributes and ignores array results for batch detection', async () => {
    await measureToolExecution(
      async () => [{ failed: ['not-a-batch-envelope'] }],
      { toolName: 'annotated-tool', requestId: 'req-7', timestamp: new Date().toISOString() },
      'primitive input',
      () => ({ 'mcp.tool.cached': true, 'mcp.tool.result_count': 1 }),
    );

    expect(span.setAttribute).toHaveBeenCalledWith('mcp.tool.cached', true);
    expect(span.setAttribute).toHaveBeenCalledWith('mcp.tool.result_count', 1);
    expect(span.setAttribute).not.toHaveBeenCalledWith(
      'mcp.tool.partial_success',
      expect.anything(),
    );
  });

  it('classifies non-Error throws without recording an exception', async () => {
    await expect(
      measureToolExecution(
        async () => {
          throw 'string failure';
        },
        { toolName: 'string-failure', requestId: 'req-8', timestamp: new Date().toISOString() },
        undefined,
      ),
    ).rejects.toBe('string failure');

    expect(span.recordException).not.toHaveBeenCalled();
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'string failure',
    });
    expect(span.setAttribute).toHaveBeenCalledWith('mcp.tool.error_code', 'UNKNOWN_ERROR');
    expect(mockErrorCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.tool.name': 'string-failure',
      'mcp.tool.error_category': 'server',
    });
  });
});

describe('measureResourceExecution', () => {
  const span = {
    setAttributes: vi.fn(),
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    end: vi.fn(),
  };
  const tracer = {
    startActiveSpan: vi.fn(async (_name, callback) => callback(span as never)),
  };
  let tracerSpy: MockInstance;
  let infoSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue(tracer as never);
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    tracerSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('records success metrics and returns the resource result', async () => {
    const result = await measureResourceExecution(
      async () => ({ data: 'hello' }),
      { resourceName: 'test-resource', requestId: 'req-r1', timestamp: new Date().toISOString() },
      { uri: 'test://items/1', mimeType: 'application/json' },
    );

    expect(result).toEqual({ data: 'hello' });
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(span.setAttributes).toHaveBeenLastCalledWith(
      expect.objectContaining({
        'mcp.resource.duration_ms': expect.any(Number),
        'mcp.resource.success': true,
      }),
    );
    expect(span.end).toHaveBeenCalled();
  });

  it('records OTel counter and histogram on success', async () => {
    await measureResourceExecution(
      async () => ({ ok: true }),
      { resourceName: 'metric-resource', requestId: 'req-r2', timestamp: new Date().toISOString() },
      { uri: 'test://items/2', mimeType: 'application/json' },
    );

    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.resource.name': 'metric-resource',
      'mcp.resource.success': true,
    });
    expect(mockHistogramRecord).toHaveBeenCalledWith(expect.any(Number), {
      'mcp.resource.name': 'metric-resource',
      'mcp.resource.success': true,
    });
    expect(mockErrorCounterAdd).not.toHaveBeenCalled();
  });

  it('records output bytes histogram on success', async () => {
    await measureResourceExecution(
      async () => ({ items: [1, 2, 3] }),
      { resourceName: 'bytes-resource', requestId: 'req-r3', timestamp: new Date().toISOString() },
      { uri: 'test://items/3', mimeType: 'application/json' },
    );

    // Output bytes histogram should be recorded (at least one call with resource name attr)
    expect(mockHistogramRecord).toHaveBeenCalledWith(expect.any(Number), {
      'mcp.resource.name': 'bytes-resource',
    });
  });

  /** Histogram records carrying the resource name alone — `mcp.resource.output_bytes`. */
  const sizeRecords = (resourceName: string): [number, Record<string, unknown>][] =>
    mockHistogramRecord.mock.calls.filter(([, attrs]) => {
      const map = attrs as Record<string, unknown>;
      return map['mcp.resource.name'] === resourceName && Object.keys(map).length === 1;
    }) as [number, Record<string, unknown>][];

  it('measures the callback return value when no output payload is designated', async () => {
    const returned = { items: [1, 2, 3] };

    await measureResourceExecution(
      async () => returned,
      {
        resourceName: 'default-payload-resource',
        requestId: 'req-rd1',
        timestamp: new Date().toISOString(),
      },
      { uri: 'test://items/d1', mimeType: 'application/json' },
    );

    const records = sizeRecords('default-payload-resource');
    expect(records).toHaveLength(1);
    expect(records[0]?.[0]).toBe(Buffer.byteLength(JSON.stringify(returned), 'utf8'));
  });

  it('measures the designated output payload rather than the callback return value', async () => {
    const domain = { id: 'item-1', status: 'active' };

    await measureResourceExecution(
      async (_spanContext, recordOutput) => {
        recordOutput(domain);
        return { contents: [{ uri: 'test://items/d2', text: JSON.stringify(domain, null, 2) }] };
      },
      {
        resourceName: 'designated-resource',
        requestId: 'req-rd2',
        timestamp: new Date().toISOString(),
      },
      { uri: 'test://items/d2', mimeType: 'application/json' },
    );

    const records = sizeRecords('designated-resource');
    expect(records).toHaveLength(1);
    expect(records[0]?.[0]).toBe(Buffer.byteLength(JSON.stringify(domain), 'utf8'));
  });

  it('records a failure and no output bytes when the callback throws after designating output', async () => {
    await expect(
      measureResourceExecution(
        async (_spanContext, recordOutput) => {
          recordOutput({ value: 1 });
          throw new Error('post-handler resource failure');
        },
        {
          resourceName: 'post-handler-resource',
          requestId: 'req-rd3',
          timestamp: new Date().toISOString(),
        },
        { uri: 'test://items/d3', mimeType: 'application/json' },
      ),
    ).rejects.toThrow('post-handler resource failure');

    expect(sizeRecords('post-handler-resource')).toHaveLength(0);
    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.resource.name': 'post-handler-resource',
      'mcp.resource.success': false,
    });
    expect(mockErrorCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.resource.name': 'post-handler-resource',
    });

    const call = infoSpy.mock.calls[0];
    if (!call) throw new Error('infoSpy was not called');
    expect((call[1] as any).extra.metrics.isSuccess).toBe(false);
  });

  it('records OTel error counter on failure', async () => {
    await expect(
      measureResourceExecution(
        async () => {
          throw new McpError(JsonRpcErrorCode.NotFound, 'not found');
        },
        { resourceName: 'err-resource', requestId: 'req-r4', timestamp: new Date().toISOString() },
        { uri: 'test://items/404', mimeType: 'application/json' },
      ),
    ).rejects.toThrow();

    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.resource.name': 'err-resource',
      'mcp.resource.success': false,
    });
    expect(mockHistogramRecord).toHaveBeenCalledWith(expect.any(Number), {
      'mcp.resource.name': 'err-resource',
      'mcp.resource.success': false,
    });
    expect(mockErrorCounterAdd).toHaveBeenCalledWith(1, { 'mcp.resource.name': 'err-resource' });
  });

  it('increments and decrements active requests gauge', async () => {
    await measureResourceExecution(
      async () => 'ok',
      { resourceName: 'gauge-resource', requestId: 'req-r5', timestamp: new Date().toISOString() },
      { uri: 'test://items/5', mimeType: 'text/plain' },
    );

    expect(mockUpDownCounterAdd).toHaveBeenCalledWith(1);
    expect(mockUpDownCounterAdd).toHaveBeenCalledWith(-1);
  });

  it('sets span attributes for URI and MIME type', async () => {
    await measureResourceExecution(
      async () => null,
      { resourceName: 'attr-resource', requestId: 'req-r6', timestamp: new Date().toISOString() },
      { uri: 'myscheme://items/6', mimeType: 'text/html' },
    );

    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'mcp.resource.uri': 'myscheme://items/6',
        'mcp.resource.mime_type': 'text/html',
      }),
    );
  });

  it('captures McpError code on failure', async () => {
    const failure = new McpError(JsonRpcErrorCode.NotFound, 'gone');

    await expect(
      measureResourceExecution(
        async () => {
          throw failure;
        },
        { resourceName: 'code-resource', requestId: 'req-r7', timestamp: new Date().toISOString() },
        { uri: 'test://items/7', mimeType: 'application/json' },
      ),
    ).rejects.toBe(failure);

    expect(span.setAttribute).toHaveBeenCalledWith(
      'mcp.resource.error_code',
      String(JsonRpcErrorCode.NotFound),
    );
  });

  it.each([
    [new Error('resource exploded'), 'UNHANDLED_ERROR', 'resource exploded', true],
    ['resource rejected', 'UNKNOWN_ERROR', 'resource rejected', false],
  ])(
    'classifies a resource failure %#',
    async (failure, expectedCode, expectedMessage, recordsException) => {
      await expect(
        measureResourceExecution(
          async () => {
            throw failure;
          },
          {
            resourceName: 'classified-resource',
            requestId: 'req-r8',
            timestamp: new Date().toISOString(),
          },
          { uri: 'test://items/8', mimeType: 'text/plain' },
        ),
      ).rejects.toBe(failure);

      expect(span.setAttribute).toHaveBeenCalledWith('mcp.resource.error_code', expectedCode);
      expect(span.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: expectedMessage,
      });
      if (recordsException) expect(span.recordException).toHaveBeenCalledWith(failure);
      else expect(span.recordException).not.toHaveBeenCalled();
    },
  );
});

describe('measurePromptGeneration', () => {
  const span = {
    setAttributes: vi.fn(),
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    end: vi.fn(),
  };
  const tracer = {
    startActiveSpan: vi.fn(async (_name, callback) => callback(span as never)),
  };
  let tracerSpy: MockInstance;
  let infoSpy: MockInstance;
  let errorSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue(tracer as never);
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    tracerSpy.mockRestore();
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  const messages = [
    { role: 'user', content: { type: 'text', text: 'hello' } },
    { role: 'assistant', content: { type: 'text', text: 'world' } },
  ];

  it('records success metrics and returns the generated messages', async () => {
    const result = await measurePromptGeneration(
      async () => messages,
      { promptName: 'test-prompt', requestId: 'req-p1', timestamp: new Date().toISOString() },
      { topic: 'greetings' },
    );

    expect(result).toEqual(messages);
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(span.setAttributes).toHaveBeenLastCalledWith(
      expect.objectContaining({
        'mcp.prompt.duration_ms': expect.any(Number),
        'mcp.prompt.success': true,
      }),
    );
    expect(span.setAttribute).toHaveBeenCalledWith('mcp.prompt.message_count', 2);
    expect(span.end).toHaveBeenCalled();

    const call = infoSpy.mock.calls[0];
    if (!call) throw new Error('infoSpy was not called');
    const [, logMeta] = call;
    expect((logMeta as any).extra.metrics.isSuccess).toBe(true);
    expect((logMeta as any).extra.metrics.messageCount).toBe(2);
    expect((logMeta as any).extra.metrics.errorCode).toBeUndefined();
  });

  it('records OTel counter and histogram on success', async () => {
    await measurePromptGeneration(
      async () => messages,
      { promptName: 'metric-prompt', requestId: 'req-p2', timestamp: new Date().toISOString() },
      { topic: 'x' },
    );

    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.prompt.name': 'metric-prompt',
      'mcp.prompt.success': true,
    });
    expect(mockHistogramRecord).toHaveBeenCalledWith(expect.any(Number), {
      'mcp.prompt.name': 'metric-prompt',
      'mcp.prompt.success': true,
    });
    expect(mockErrorCounterAdd).not.toHaveBeenCalled();
  });

  it('records input/output bytes and message count histograms on success', async () => {
    await measurePromptGeneration(
      async () => messages,
      { promptName: 'bytes-prompt', requestId: 'req-p3', timestamp: new Date().toISOString() },
      { topic: 'x' },
    );

    expect(mockHistogramRecord).toHaveBeenCalledWith(expect.any(Number), {
      'mcp.prompt.name': 'bytes-prompt',
    });
  });

  it('records OTel error counter and logs via logger.error on failure', async () => {
    await expect(
      measurePromptGeneration(
        async () => {
          throw new McpError(JsonRpcErrorCode.InvalidParams, 'bad');
        },
        { promptName: 'err-prompt', requestId: 'req-p4', timestamp: new Date().toISOString() },
        { topic: 'x' },
      ),
    ).rejects.toThrow();

    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.prompt.name': 'err-prompt',
      'mcp.prompt.success': false,
    });
    expect(mockHistogramRecord).toHaveBeenCalledWith(expect.any(Number), {
      'mcp.prompt.name': 'err-prompt',
      'mcp.prompt.success': false,
    });
    expect(mockErrorCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.prompt.name': 'err-prompt',
      'mcp.prompt.error_category': 'client',
    });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('captures McpError code on failure', async () => {
    const failure = new McpError(JsonRpcErrorCode.NotFound, 'gone');

    await expect(
      measurePromptGeneration(
        async () => {
          throw failure;
        },
        { promptName: 'code-prompt', requestId: 'req-p5', timestamp: new Date().toISOString() },
        {},
      ),
    ).rejects.toBe(failure);

    expect(span.recordException).toHaveBeenCalledWith(failure);
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'gone',
    });
    expect(span.setAttribute).toHaveBeenCalledWith(
      'mcp.prompt.error_code',
      String(JsonRpcErrorCode.NotFound),
    );
  });

  it('handles generic (non-McpError) errors', async () => {
    const failure = new Error('boom');

    await expect(
      measurePromptGeneration(
        async () => {
          throw failure;
        },
        { promptName: 'generic-prompt', requestId: 'req-p6', timestamp: new Date().toISOString() },
        {},
      ),
    ).rejects.toBe(failure);

    expect(span.setAttribute).toHaveBeenCalledWith('mcp.prompt.error_code', 'UNHANDLED_ERROR');
    expect(mockErrorCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.prompt.name': 'generic-prompt',
      'mcp.prompt.error_category': 'server',
    });
  });

  it('increments and decrements active requests gauge', async () => {
    await measurePromptGeneration(
      async () => messages,
      { promptName: 'gauge-prompt', requestId: 'req-p7', timestamp: new Date().toISOString() },
      {},
    );

    expect(mockUpDownCounterAdd).toHaveBeenCalledWith(1);
    expect(mockUpDownCounterAdd).toHaveBeenCalledWith(-1);
  });

  it('sets code namespace and function name span attributes', async () => {
    await measurePromptGeneration(
      async () => messages,
      { promptName: 'attr-prompt', requestId: 'req-p8', timestamp: new Date().toISOString() },
      {},
    );

    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'code.function.name': 'attr-prompt',
        'code.namespace': 'mcp-prompts',
      }),
    );
  });

  it('reports zero message count when generate returns a non-array', async () => {
    await measurePromptGeneration(
      async () => ({ not: 'an array' }) as unknown as typeof messages,
      { promptName: 'non-array', requestId: 'req-p9', timestamp: new Date().toISOString() },
      {},
    );

    expect(span.setAttribute).toHaveBeenCalledWith('mcp.prompt.message_count', 0);
  });

  it('classifies non-Error prompt failures without recording an exception', async () => {
    await expect(
      measurePromptGeneration(
        async () => {
          throw 503;
        },
        {
          promptName: 'numeric-failure',
          requestId: 'req-p10',
          timestamp: new Date().toISOString(),
        },
        null,
      ),
    ).rejects.toBe(503);

    expect(span.recordException).not.toHaveBeenCalled();
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: '503' });
    expect(span.setAttribute).toHaveBeenCalledWith('mcp.prompt.error_code', 'UNKNOWN_ERROR');
    expect(mockErrorCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.prompt.name': 'numeric-failure',
      'mcp.prompt.error_category': 'server',
    });
  });
});

describe('input-required rounds are not failures', () => {
  const span = {
    setAttributes: vi.fn(),
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    end: vi.fn(),
  };
  const tracer = {
    startActiveSpan: vi.fn(async (_name, callback) => callback(span as never)),
  };
  let tracerSpy: MockInstance;
  let infoSpy: MockInstance;
  let errorSpy: MockInstance;

  const signal = new InputRequiredSignal({
    type: 'input_required',
    requests: [],
  } as never);

  beforeEach(() => {
    vi.clearAllMocks();
    tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue(tracer as never);
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    tracerSpy.mockRestore();
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  const throwSignal = async (): Promise<never> => {
    throw signal;
  };

  const lastMetrics = (spy: MockInstance): Record<string, unknown> => {
    const call = spy.mock.calls.at(-1);
    if (!call) throw new Error('logger was not called');
    return (call[1] as { extra: { metrics: Record<string, unknown> } }).extra.metrics;
  };

  it('leaves tool failure telemetry untouched', async () => {
    await expect(
      measureToolExecution(
        throwSignal,
        { toolName: 'mrt-tool', requestId: 'req-i1', timestamp: new Date().toISOString() },
        { query: 'x' },
      ),
    ).rejects.toBe(signal);

    expect(span.recordException).not.toHaveBeenCalled();
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(span.setAttribute).toHaveBeenCalledWith('mcp.tool.input_required', true);
    expect(span.setAttribute).not.toHaveBeenCalledWith('mcp.tool.error_code', expect.anything());
    expect(mockErrorCounterAdd).not.toHaveBeenCalled();

    const metrics = lastMetrics(infoSpy);
    expect(metrics.isSuccess).toBe(true);
    expect(metrics.inputRequired).toBe(true);
    expect(metrics.errorCode).toBeUndefined();
  });

  it('leaves resource failure telemetry untouched', async () => {
    await expect(
      measureResourceExecution(
        throwSignal,
        { resourceName: 'mrt-res', requestId: 'req-i2', timestamp: new Date().toISOString() },
        { uri: 'test://doc/1', mimeType: 'application/json' },
      ),
    ).rejects.toBe(signal);

    expect(span.recordException).not.toHaveBeenCalled();
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(span.setAttribute).toHaveBeenCalledWith('mcp.resource.input_required', true);
    expect(mockErrorCounterAdd).not.toHaveBeenCalled();
    expect(lastMetrics(infoSpy).inputRequired).toBe(true);
  });

  it('leaves prompt failure telemetry untouched, and logs at info', async () => {
    await expect(
      measurePromptGeneration(
        throwSignal,
        { promptName: 'mrt-prompt', requestId: 'req-i3', timestamp: new Date().toISOString() },
        { name: 'x' },
      ),
    ).rejects.toBe(signal);

    expect(span.recordException).not.toHaveBeenCalled();
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(span.setAttribute).toHaveBeenCalledWith('mcp.prompt.input_required', true);
    expect(mockErrorCounterAdd).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(lastMetrics(infoSpy).inputRequired).toBe(true);
  });
});

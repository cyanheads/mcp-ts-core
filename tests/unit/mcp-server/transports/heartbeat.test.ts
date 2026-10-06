/**
 * @fileoverview Unit tests for the transport heartbeat monitor.
 * @module tests/unit/mcp-server/transports/heartbeat.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCounterAdd, mockCreateCounter, mockLogger, mockRequestContextService } = vi.hoisted(
  () => ({
    mockCounterAdd: vi.fn(),
    mockCreateCounter: vi.fn(() => ({ add: mockCounterAdd })),
    mockLogger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      notice: vi.fn(),
      warning: vi.fn(),
    },
    mockRequestContextService: {
      createRequestContext: vi.fn(
        (params?: {
          additionalContext?: Record<string, unknown>;
          operation?: string;
          parentContext?: Record<string, unknown>;
          tenantId?: string;
        }) => ({
          requestId: 'heartbeat-test-request',
          timestamp: '2026-03-30T00:00:00.000Z',
          ...params?.parentContext,
          ...(params?.operation && { operation: params.operation }),
          ...(params?.tenantId && { tenantId: params.tenantId }),
          ...(params?.additionalContext && { extra: { ...params.additionalContext } }),
        }),
      ),
    },
  }),
);

vi.mock('@/utils/internal/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('@/utils/internal/requestContext.js', () => ({
  toCanonicalContext: (context: Record<string, unknown>) =>
    Object.fromEntries(
      [
        'auth',
        'extra',
        'operation',
        'requestId',
        'sessionId',
        'spanId',
        'tenantId',
        'timestamp',
        'traceId',
      ]
        .filter((k) => context[k] !== undefined)
        .map((k) => [k, context[k]]),
    ),
  withExtra: (ctx: { extra?: Record<string, unknown> }, fields: Record<string, unknown>) => ({
    ...ctx,
    extra: { ...ctx.extra, ...fields },
  }),
  requestContextService: mockRequestContextService,
}));

vi.mock('@/utils/telemetry/metrics.js', () => ({
  createCounter: mockCreateCounter,
}));

describe('HeartbeatMonitor', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('eagerly initializes the heartbeat failure metric once', async () => {
    const { initHeartbeatMetrics } = await import('@/mcp-server/transports/heartbeat.js');

    initHeartbeatMetrics();
    initHeartbeatMetrics();

    expect(mockCreateCounter).toHaveBeenCalledTimes(1);
    expect(mockCreateCounter).toHaveBeenCalledWith(
      'mcp.heartbeat.failures',
      'Heartbeat ping failures',
      '{failures}',
    );
  });

  it('does not start when heartbeat is disabled', async () => {
    const { HeartbeatMonitor } = await import('@/mcp-server/transports/heartbeat.js');
    const sendPing = vi.fn().mockResolvedValue(undefined);
    const onDead = vi.fn();

    const monitor = new HeartbeatMonitor({
      intervalMs: 0,
      missThreshold: 2,
      onDead,
      sendPing,
      transport: 'stdio',
    });

    monitor.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(sendPing).not.toHaveBeenCalled();
    expect(onDead).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('sends no ping once stopped, however stop() and start() interleave', async () => {
    const { HeartbeatMonitor } = await import('@/mcp-server/transports/heartbeat.js');
    const sendPing = vi.fn().mockResolvedValue(undefined);

    const monitor = new HeartbeatMonitor({
      intervalMs: 25,
      missThreshold: 2,
      onDead: vi.fn(),
      sendPing,
      transport: 'http',
    });

    // Stopping before start has no timer to clear; start then re-arms it.
    monitor.stop();
    monitor.start();
    monitor.stop();
    monitor.stop();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(50);

    expect(sendPing).not.toHaveBeenCalled();
  });

  it('arms no further ping after one that was in flight when the monitor stopped', async () => {
    const { HeartbeatMonitor } = await import('@/mcp-server/transports/heartbeat.js');
    const inFlight = Promise.withResolvers<void>();
    const sendPing = vi.fn(() => inFlight.promise);

    const monitor = new HeartbeatMonitor({
      intervalMs: 10,
      missThreshold: 2,
      onDead: vi.fn(),
      sendPing,
      transport: 'stdio',
    });

    monitor.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(sendPing).toHaveBeenCalledTimes(1);

    // The ping settles after stop(): the cycle must end there, not re-arm.
    monitor.stop();
    inFlight.resolve();
    await vi.advanceTimersByTimeAsync(5);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(sendPing).toHaveBeenCalledTimes(1);
  });

  it('counts only consecutive failures toward the threshold: a successful ping resets the run', async () => {
    const { HeartbeatMonitor } = await import('@/mcp-server/transports/heartbeat.js');
    const onDead = vi.fn();
    const sendPing = vi
      .fn()
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('blip'))
      .mockRejectedValueOnce(new Error('down'));

    const monitor = new HeartbeatMonitor({
      intervalMs: 10,
      missThreshold: 2,
      onDead,
      sendPing,
      transport: 'stdio',
    });

    monitor.start();
    // Failure, success, failure: two misses in total, but never two in a row.
    for (let tick = 0; tick < 3; tick++) await vi.advanceTimersByTimeAsync(10);
    expect(sendPing).toHaveBeenCalledTimes(3);
    expect(onDead).not.toHaveBeenCalled();

    // The next miss is the second consecutive one.
    await vi.advanceTimersByTimeAsync(10);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it('records a failure, then logs the recovery', async () => {
    const { HeartbeatMonitor } = await import('@/mcp-server/transports/heartbeat.js');
    const sendPing = vi
      .fn()
      .mockRejectedValueOnce('first failure')
      .mockResolvedValueOnce(undefined);

    const monitor = new HeartbeatMonitor({
      intervalMs: 10,
      missThreshold: 3,
      onDead: vi.fn(),
      sendPing,
      transport: 'stdio',
    });

    monitor.start();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.connection.transport': 'stdio',
    });
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Heartbeat ping failed (1/3)',
      expect.objectContaining({
        extra: expect.objectContaining({ error: 'first failure' }),
      }),
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Heartbeat recovered after 1 failure(s)',
      expect.any(Object),
    );
  });

  it('declares the connection dead after reaching the miss threshold', async () => {
    const { HeartbeatMonitor } = await import('@/mcp-server/transports/heartbeat.js');
    const onDead = vi.fn();
    const sendPing = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('network down'));

    const monitor = new HeartbeatMonitor({
      intervalMs: 15,
      missThreshold: 2,
      onDead,
      sendPing,
      transport: 'http',
    });

    monitor.start();
    await vi.advanceTimersByTimeAsync(15);
    await vi.advanceTimersByTimeAsync(15);
    await vi.advanceTimersByTimeAsync(100);

    expect(onDead).toHaveBeenCalledTimes(1);
    expect(sendPing).toHaveBeenCalledTimes(2);
    expect(mockCounterAdd).toHaveBeenCalledTimes(2);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Heartbeat: connection declared dead — initiating shutdown.',
      expect.any(Error),
      expect.any(Object),
    );
  });
});

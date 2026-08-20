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

  it('stops scheduled work and no-ops internal scheduling when already stopped', async () => {
    const { HeartbeatMonitor } = await import('@/mcp-server/transports/heartbeat.js');
    const sendPing = vi.fn().mockResolvedValue(undefined);

    const monitor = new HeartbeatMonitor({
      intervalMs: 25,
      missThreshold: 2,
      onDead: vi.fn(),
      sendPing,
      transport: 'http',
    });

    monitor.start();
    monitor.stop();
    monitor.stop();

    await vi.advanceTimersByTimeAsync(50);
    await (monitor as any).scheduleNext();
    await (monitor as any).tick();

    expect(sendPing).not.toHaveBeenCalled();
  });

  it('records failures, then logs recovery and resets the consecutive failure count', async () => {
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

  it('returns early from tick when already stopped before execution begins', async () => {
    const { HeartbeatMonitor } = await import('@/mcp-server/transports/heartbeat.js');
    const sendPing = vi.fn().mockResolvedValue(undefined);

    const monitor = new HeartbeatMonitor({
      intervalMs: 5,
      missThreshold: 1,
      onDead: vi.fn(),
      sendPing,
      transport: 'stdio',
    });

    monitor.stop();
    await (monitor as any).tick();

    expect(sendPing).not.toHaveBeenCalled();
  });
});

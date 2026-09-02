/**
 * @fileoverview Unit tests for records logged before the logger has sinks.
 * Service composition — and a consumer's `setup()` hook with it — runs ahead of
 * `logger.initialize`, so these records are held and replayed rather than
 * dropped. Each case resets the module registry to get a never-initialized
 * singleton, which is the only state where the buffer is live.
 * @module tests/unit/utils/internal/logger.preInit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger as LoggerClass } from '@/utils/internal/logger.js';

type PinoSpy = {
  debug: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  fatal: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
};

vi.mock('pino', () => {
  const instance = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    flush: vi.fn((cb: (err?: Error) => void) => cb()),
    info: vi.fn(),
    level: 'debug',
    warn: vi.fn(),
  };
  const pino = vi.fn(() => instance) as unknown as {
    (): typeof instance;
    stdSerializers: { err: (err: Error) => unknown };
  };
  pino.stdSerializers = { err: (err: Error) => ({ message: err.message }) };
  return { default: pino };
});

vi.mock('@/config/index.js', () => ({
  config: {
    environment: 'testing',
    logRateLimitThreshold: 0, // Rate limiting off: the replay asserts on every record.
    logRateLimitWindowMs: 60_000,
    logsPath: undefined,
    mcpServerVersion: '1.0.0-test',
  },
}));

/**
 * A never-initialized logger plus the pino instance it will write into. The
 * mock factory keeps one instance across module resets, so its call record is
 * cleared here rather than shared between cases.
 */
async function freshLogger(): Promise<{ logger: LoggerClass; pino: PinoSpy }> {
  vi.resetModules();
  const pinoFactory = (await import('pino')).default as unknown as () => PinoSpy;
  const pino = pinoFactory();
  for (const level of ['debug', 'error', 'fatal', 'info', 'warn'] as const) {
    pino[level].mockClear();
  }
  const { Logger } = await import('@/utils/internal/logger.js');
  return { logger: Logger.getInstance(), pino };
}

/** Messages the mock pino received at `level`, in order. */
function messagesAt(pino: PinoSpy, level: keyof PinoSpy): string[] {
  return pino[level].mock.calls.map((call) => String(call[1]));
}

let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderr.mockRestore();
  vi.resetModules();
});

describe('records logged before initialize', () => {
  it('reach the sink once it exists', async () => {
    const { logger, pino } = await freshLogger();

    logger.info('Scheduling refresh');
    logger.warning('Could not schedule refresh; serving with fallback');
    expect(pino.info).not.toHaveBeenCalled();

    await logger.initialize('info');

    expect(messagesAt(pino, 'info')).toEqual([
      'Logger initialized. MCP level: info.',
      'Scheduling refresh',
    ]);
    expect(messagesAt(pino, 'warn')).toEqual(['Could not schedule refresh; serving with fallback']);
  });

  it('carry their context and error through the replay', async () => {
    const { logger, pino } = await freshLogger();
    const failure = new Error('mirror unreachable');

    logger.error('Mirror refresh failed', failure, {
      operation: 'MirrorRefresh',
      requestId: 'req-1',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    await logger.initialize('info');

    expect(pino.error).toHaveBeenCalledTimes(1);
    const [payload, message] = pino.error.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toBe('Mirror refresh failed');
    expect(payload.operation).toBe('MirrorRefresh');
    expect(payload.requestId).toBe('req-1');
    expect(payload.err).toBe(failure);
  });

  it('are filtered against the level the logger is initialized with', async () => {
    const { logger, pino } = await freshLogger();

    logger.debug('Verbose boot detail');
    await logger.initialize('info');

    expect(messagesAt(pino, 'debug')).toEqual([]);
  });

  it('are emitted when the initialized level admits them', async () => {
    const { logger, pino } = await freshLogger();

    logger.debug('Verbose boot detail');
    await logger.initialize('debug');

    expect(messagesAt(pino, 'debug')).toEqual(['Verbose boot detail']);
  });

  it('report how many were lost once the buffer is full', async () => {
    const { logger, pino } = await freshLogger();

    // 253 records against a 250-record buffer: the last three have nowhere to go.
    for (let index = 0; index < 253; index++) logger.info(`Boot step ${index}`);

    await logger.initialize('info');

    const infos = messagesAt(pino, 'info');
    expect(infos).toContain('Boot step 249');
    expect(infos).not.toContain('Boot step 250');
    expect(messagesAt(pino, 'warn')).toEqual([
      'Dropped 3 record(s) logged before initialization — the pre-init buffer holds 250.',
    ]);
  });

  it('go to stderr when the process ends before the logger starts', async () => {
    const { logger, pino } = await freshLogger();

    logger.warning('Could not schedule refresh; serving with fallback');
    logger.error('Boot aborted', new Error('config invalid'));
    logger.drainPendingToStderr();

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toBe(
      '[pre-init warning] Could not schedule refresh; serving with fallback\n' +
        '[pre-init error] Boot aborted — config invalid\n',
    );

    // Drained records are gone: initializing later must not replay them twice.
    await logger.initialize('info');
    expect(messagesAt(pino, 'warn')).toEqual([]);
    expect(messagesAt(pino, 'info')).toEqual(['Logger initialized. MCP level: info.']);
  });

  it('drain nothing when no record was held', async () => {
    const { logger } = await freshLogger();

    logger.drainPendingToStderr();

    expect(stderr).not.toHaveBeenCalled();
  });

  it('are dropped rather than buffered after the logger has been closed', async () => {
    const { logger, pino } = await freshLogger();

    await logger.initialize('info');
    await logger.close();
    logger.info('Logged after shutdown');
    pino.info.mockClear();

    await logger.initialize('info');

    expect(messagesAt(pino, 'info')).toEqual(['Logger initialized. MCP level: info.']);
  });
});

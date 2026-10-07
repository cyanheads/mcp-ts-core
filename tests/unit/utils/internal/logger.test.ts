/**
 * @fileoverview Unit tests for the Logger class.
 * Tests rate-limiting, RFC5424 level mapping, singleton behavior,
 * and state management without requiring file I/O.
 * @module tests/utils/internal/logger
 */
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import {
  Logger,
  type McpLogLevel,
  sanitizeLogBindings,
  setOtelLogSink,
} from '@/utils/internal/logger.js';
import { toLogValue, toMirrorValue } from '@/utils/internal/logValue.js';
import { TELEMETRY_LOG_MESSAGES } from '@/utils/internal/telemetryMessages.js';

// Mock pino to avoid file I/O in unit tests
vi.mock('pino', () => {
  const mockPinoLogger = {
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    level: 'info',
    flush: vi.fn((cb: (err?: Error) => void) => cb()),
  };

  const pino = vi.fn(() => mockPinoLogger) as any;
  pino.stdSerializers = {
    err: vi.fn((err: Error) => ({
      type: err.constructor.name,
      message: err.message,
      stack: err.stack,
    })),
  };

  return { default: pino };
});

// Mock config
vi.mock('@/config/index.js', () => ({
  config: {
    environment: 'testing',
    mcpServerVersion: '1.0.0-test',
    logsPath: undefined,
    logRateLimitThreshold: 10,
    logRateLimitWindowMs: 60000,
  },
}));

// Mock requestContextService
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
  requestContextService: {
    createRequestContext: vi.fn((overrides = {}) => ({
      requestId: 'mock-req-id',
      timestamp: new Date().toISOString(),
      ...overrides,
    })),
  },
  withExtra: (context: any, fields: any) => ({
    ...context,
    extra: { ...context?.extra, ...fields },
  }),
}));

/** The single mock pino instance every `pino()` call in this file returns. */
async function getMockPinoLogger(): Promise<{ flush: ReturnType<typeof vi.fn> }> {
  const pino = (await import('pino')).default as unknown as () => {
    flush: ReturnType<typeof vi.fn>;
  };
  return pino();
}

/**
 * The string-keyed fields of each record a mock pino method received, with its
 * message. The logger also hands pino the record's context under a symbol only
 * it holds, for the walk to read; that symbol is never written.
 */
function pinoRecords(method: ReturnType<typeof vi.fn>): [Record<string, unknown>, unknown][] {
  return method.mock.calls.map(([record, msg]) => [
    Object.fromEntries(Object.entries(record as object)),
    msg,
  ]);
}

describe('Logger', () => {
  let logger: Logger;

  beforeEach(async () => {
    vi.clearAllMocks();
    logger = Logger.getInstance();

    // Force close + reset to get a clean state
    if (logger.isInitialized()) {
      await logger.close();
    }
  });

  afterEach(async () => {
    if (logger.isInitialized()) {
      await logger.close();
    }
    // The serverless cases stub IS_SERVERLESS, and `isServerless()` is read at
    // call time — a leaked stub silently changes behaviour in later tests.
    vi.unstubAllEnvs();
  });

  describe('singleton', () => {
    it('should return the same instance', () => {
      const a = Logger.getInstance();
      const b = Logger.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('initialize', () => {
    it('should set initialized to true after init', async () => {
      expect(logger.isInitialized()).toBe(false);
      await logger.initialize('info');
      expect(logger.isInitialized()).toBe(true);
    });

    it('should not re-initialize if already initialized', async () => {
      await logger.initialize('info');
      const spy = vi.spyOn(logger, 'warning');

      await logger.initialize('debug');

      expect(spy).toHaveBeenCalledWith('Logger already initialized.', expect.any(Object));
      spy.mockRestore();
    });
  });

  describe('level mapping (RFC5424 → Pino)', () => {
    it.each([
      ['debug', 'debug'],
      ['info', 'info'],
      ['notice', 'info'],
      ['warning', 'warn'],
      ['error', 'error'],
      ['crit', 'error'],
      ['alert', 'fatal'],
      ['emerg', 'fatal'],
    ] as const satisfies ReadonlyArray<readonly [McpLogLevel, string]>)(
      'creates the pino logger at %s → %s',
      async (level, pinoLevel) => {
        const pino = (await import('pino')).default;

        await logger.initialize(level);

        expect(pino).toHaveBeenCalledWith(expect.objectContaining({ level: pinoLevel }));
      },
    );
  });

  describe('setLevel', () => {
    it('should change log level after initialization', async () => {
      await logger.initialize('info');
      const pino = (await import('pino')).default;
      const mockLogger = pino() as any;

      logger.debug('filtered before level change');
      logger.setLevel('debug');
      logger.debug('test debug after level change');

      expect(mockLogger.debug).toHaveBeenCalledTimes(1);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.any(Object),
        'test debug after level change',
      );
    });

    it('should not throw when not initialized', () => {
      // Just logs to console.error if TTY, but should not throw
      expect(() => logger.setLevel('debug')).not.toThrow();
    });
  });

  describe('close', () => {
    it('should set initialized to false after close', async () => {
      await logger.initialize('info');
      expect(logger.isInitialized()).toBe(true);

      await logger.close();
      expect(logger.isInitialized()).toBe(false);
    });

    it('should be safe to call close when not initialized', async () => {
      await expect(logger.close()).resolves.toBeUndefined();
    });

    it('resolves only after a completing flush callback fires', async () => {
      await logger.initialize('info');
      const mockPino = await getMockPinoLogger();

      let flushCallback: ((err?: Error) => void) | undefined;
      mockPino.flush.mockImplementationOnce((cb: (err?: Error) => void) => {
        flushCallback = cb;
      });

      let closed = false;
      const closing = logger.close().then(() => {
        closed = true;
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(closed).toBe(false);

      flushCallback?.();
      await closing;
      expect(closed).toBe(true);
    });

    it('resolves once the drain bound elapses when the flush callback never fires', async () => {
      await logger.initialize('info');
      const mockPino = await getMockPinoLogger();
      mockPino.flush.mockImplementationOnce(() => {
        // A runtime whose pino instance never calls back (workerd — #342).
      });

      vi.useFakeTimers();
      try {
        const closing = logger.close();
        await vi.advanceTimersByTimeAsync(30_000);
        await expect(closing).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
      expect(logger.isInitialized()).toBe(false);
    });
  });

  describe('rate limiting', () => {
    it('should suppress messages over the threshold', async () => {
      await logger.initialize('info');

      const pino = (await import('pino')).default;
      const mockLogger = pino() as any;
      const initialCallCount = mockLogger.info.mock.calls.length;

      // Fire 15 identical messages — last 5 should be suppressed
      for (let i = 0; i < 15; i++) {
        logger.info('rate-limited-msg');
      }

      const callsAfter = mockLogger.info.mock.calls.length - initialCallCount;
      // Should have logged 10 (threshold), not 15
      expect(callsAfter).toBe(10);
    });

    it('should not rate-limit different messages independently', async () => {
      await logger.initialize('info');

      // 10 of message A + 10 of message B = both under threshold
      for (let i = 0; i < 10; i++) {
        logger.info('message-A');
        logger.info('message-B');
      }

      // Neither should be suppressed since each is at the threshold, not over
      const pino = (await import('pino')).default;
      const mockLogger = pino() as any;
      // All 20 messages should have been logged (plus init messages)
      expect(mockLogger.info.mock.calls.length).toBeGreaterThanOrEqual(20);
    });

    it('should evict expired messageCounts entries even when nothing was suppressed', async () => {
      // messageCounts must not grow unbounded with one-shot dynamic-content
      // messages that never repeat enough to trigger suppression.
      await logger.initialize('info');

      // Emit 5 unique messages — none repeats enough to trigger suppression.
      for (let i = 0; i < 5; i++) {
        logger.info(`unique-message-${i}`);
      }

      const counts = (logger as any).messageCounts as Map<string, { firstSeen: number }>;
      expect(counts.size).toBeGreaterThanOrEqual(5);

      // Hold the premise: earlier cases in this file share the singleton's
      // counters, and a suppression carried in from one of them would make the
      // sweep emit its "suppressed N occurrences" notice — a real entry, but
      // not the case under test.
      ((logger as any).suppressedMessages as Map<string, number>).clear();

      // Backdate the entries and the last sweep past the rate-limit window.
      const window = (logger as any).rateLimitWindow as number;
      const stale = Date.now() - window - 1000;
      for (const entry of counts.values()) entry.firstSeen = stale;
      (logger as any).lastSweep = stale;

      // The next log call drives the sweep — no timer involved.
      logger.info('drives-the-sweep');
      expect([...counts.keys()]).toEqual(['info:drives-the-sweep']);
    });

    it('should retain in-window messageCounts entries across sweeps', async () => {
      await logger.initialize('info');

      logger.info('fresh-message-A');
      logger.info('fresh-message-B');

      const counts = (logger as any).messageCounts as Map<string, unknown>;
      const before = counts.size;
      expect(before).toBeGreaterThanOrEqual(2);

      // Force a sweep while every entry is still inside its window — the
      // per-window counts must survive or the threshold stops being enforced.
      (logger as any).maybeSweep(Date.now());
      expect(counts.size).toBe(before);
    });

    // The eviction interval was armed only under Node, so on Workers nothing
    // ever bounded these maps and the suppression record was never emitted. (#277)
    it('should bound messageCounts on a serverless runtime, where no timer is armed', async () => {
      vi.stubEnv('IS_SERVERLESS', 'true');
      await logger.initialize('info');

      const counts = (logger as any).messageCounts as Map<string, { firstSeen: number }>;
      const cap = 1000;

      // A high-cardinality burst inside a single window: every message is
      // distinct, so the window-expiry pass alone would evict nothing.
      for (let i = 0; i < cap + 500; i++) logger.info(`dynamic-key-${i}`);

      expect(counts.size).toBeLessThanOrEqual(cap);
    });

    it('should emit the suppression record on a serverless runtime once a window elapses', async () => {
      vi.stubEnv('IS_SERVERLESS', 'true');
      await logger.initialize('info');

      const pino = (await import('pino')).default;
      const mockLogger = pino() as any;

      // Push one message past the threshold so suppression accrues.
      for (let i = 0; i < 15; i++) logger.info('storm');
      expect((logger as any).suppressedMessages.size).toBe(1);

      // Age the window, then log again — the record flushes on traffic.
      const window = (logger as any).rateLimitWindow as number;
      (logger as any).lastSweep = Date.now() - window - 1000;
      const warnBefore = mockLogger.warn.mock.calls.length;
      logger.info('after-the-window');

      expect(mockLogger.warn.mock.calls.length).toBeGreaterThan(warnBefore);
      expect(String(mockLogger.warn.mock.calls.at(-1)?.[1])).toContain('Suppressed');
      expect((logger as any).suppressedMessages.size).toBe(0);
    });

    // The limiter used to key on the message alone, so an error storm and
    // ordinary info throughput sharing a string also shared a budget. (#295)
    it('should budget the same message separately per level', async () => {
      await logger.initialize('debug');

      const pino = (await import('pino')).default;
      const mockLogger = pino() as any;
      const infoBefore = mockLogger.info.mock.calls.length;
      const errorBefore = mockLogger.error.mock.calls.length;

      for (let i = 0; i < 10; i++) logger.info('shared string');
      for (let i = 0; i < 10; i++) logger.error('shared string', new Error('boom'));

      expect(mockLogger.info.mock.calls.length - infoBefore).toBe(10);
      expect(mockLogger.error.mock.calls.length - errorBefore).toBe(10);
    });

    // Per-call telemetry lines carry a constant message by design, so the
    // limiter would cap log-derived call volume at the threshold. (#295)
    it('should not rate-limit the framework per-call telemetry lines', async () => {
      await logger.initialize('info');

      const pino = (await import('pino')).default;
      const mockLogger = pino() as any;
      const before = mockLogger.info.mock.calls.length;

      for (let i = 0; i < 30; i++) {
        logger.info(TELEMETRY_LOG_MESSAGES.toolExecutionFinished);
      }

      expect(mockLogger.info.mock.calls.length - before).toBe(30);
      expect((logger as any).suppressedMessages.size).toBe(0);
    });

    it('should disable rate limiting entirely when the threshold is 0', async () => {
      await logger.initialize('info');

      // Logger is a singleton — restore the threshold so it does not leak.
      const saved = (logger as any).rateLimitThreshold;
      (logger as any).rateLimitThreshold = 0;
      try {
        const pino = (await import('pino')).default;
        const mockLogger = pino() as any;
        const before = mockLogger.info.mock.calls.length;

        for (let i = 0; i < 25; i++) logger.info('unthrottled');

        expect(mockLogger.info.mock.calls.length - before).toBe(25);
      } finally {
        (logger as any).rateLimitThreshold = saved;
      }
    });

    // Suppression happens at info and above; a debug-level notice is filtered
    // out at exactly those levels, so truncation read as silence. (#295)
    it('should report suppression at warning level with the counts', async () => {
      await logger.initialize('info');

      const pino = (await import('pino')).default;
      const mockLogger = pino() as any;

      for (let i = 0; i < 15; i++) logger.info('noisy');

      const warnBefore = mockLogger.warn.mock.calls.length;
      (logger as any).flushSuppressedMessages();

      // The notice must land on warn — it previously went to debug, which is
      // filtered out at the levels where suppression actually happens.
      const emitted = mockLogger.warn.mock.calls.slice(warnBefore);
      expect(emitted).toHaveLength(1);
      expect(mockLogger.debug).not.toHaveBeenCalled();

      const message = emitted[0][1];
      expect(message).toContain('Suppressed 5 occurrences');
      expect(message).toContain('info:noisy');
      expect(message).toContain('rate limit is 10');
    });

    it('should clear suppressed counts before emitting so a flush cannot double-report', async () => {
      await logger.initialize('info');

      for (let i = 0; i < 15; i++) logger.info('noisy-once');

      (logger as any).flushSuppressedMessages();
      expect((logger as any).suppressedMessages.size).toBe(0);

      const pino = (await import('pino')).default;
      const mockLogger = pino() as any;
      const warnBefore = mockLogger.warn.mock.calls.length;

      (logger as any).flushSuppressedMessages();
      expect(mockLogger.warn.mock.calls.length).toBe(warnBefore);
    });
  });

  describe('error-level methods', () => {
    it.each([
      ['error', 'error'],
      ['crit', 'error'],
      ['alert', 'fatal'],
      ['emerg', 'fatal'],
    ] as const)('%s() emits at pino %s with (Error, ctx) and (ctx)', async (method, pinoLevel) => {
      await logger.initialize('info');
      const pino = (await import('pino')).default;
      const mockLogger = pino() as any;
      const err = new Error(`${method} boom`);
      const ctx = { requestId: `r-${method}`, timestamp: '2026-01-01T00:00:00.000Z' };
      const msg = `${method} condition`;

      logger[method](msg, err, ctx);
      logger[method](msg, ctx);

      expect(pinoRecords(mockLogger[pinoLevel])).toEqual([
        [{ ...ctx, err }, msg],
        [ctx, msg],
      ]);
    });

    it('error() with only an Error attaches it without context', async () => {
      await logger.initialize('info');
      const pino = (await import('pino')).default;
      const mockLogger = pino() as any;
      const err = new Error('test error');

      logger.error('Something failed', err);

      expect(pinoRecords(mockLogger.error)).toEqual([[{ err }, 'Something failed']]);
    });

    it('fatal() should delegate to emerg()', async () => {
      await logger.initialize('info');
      const spy = vi.spyOn(logger, 'emerg');

      const ctx = {
        requestId: 'r3',
        timestamp: new Date().toISOString(),
      } as any;
      logger.fatal('fatal condition', ctx);

      // fatal(msg, errorOrContext, context?) forwards all args to emerg()
      expect(spy).toHaveBeenCalledWith('fatal condition', ctx, undefined);
      spy.mockRestore();
    });
  });

  describe('canonical record fields', () => {
    /** The framework-owned fields a record carries from its request context. */
    const canonical = {
      operation: 'canonicalOp',
      requestId: 'req-canonical',
      sessionId: 'session-canonical',
      spanId: 'b'.repeat(16),
      tenantId: 'tenant-canonical',
      timestamp: '2026-09-26T00:00:00.000Z',
      traceId: 'a'.repeat(32),
    };
    /** A caller's `extra` bag reusing every canonical name, plus one field of its own. */
    const colliding = {
      operation: 'callerOp',
      requestId: 'req-caller',
      sessionId: 'session-caller',
      spanId: 'caller-span',
      tenantId: 'tenant-caller',
      timestamp: 'caller-timestamp',
      traceId: 'caller-trace',
      itemId: 'item-1',
    };
    const sink = { emit: vi.fn() };

    afterEach(() => {
      setOtelLogSink(undefined);
    });

    it('keeps every canonical value in the pino record when extra reuses the name', async () => {
      await logger.initialize('info');
      const mockLogger = (await import('pino')).default() as any;

      logger.info('canonical: collision', { ...canonical, extra: colliding } as any);

      expect(pinoRecords(mockLogger.info).at(-1)).toEqual([
        { ...canonical, itemId: 'item-1' },
        'canonical: collision',
      ]);
    });

    it('keeps every canonical value alongside an Error on the error path', async () => {
      await logger.initialize('info');
      const mockLogger = (await import('pino')).default() as any;
      const err = new Error('boom');

      logger.error('canonical: failure', err, { ...canonical, extra: colliding } as any);

      expect(pinoRecords(mockLogger.error).at(-1)).toEqual([
        { ...canonical, itemId: 'item-1', err },
        'canonical: failure',
      ]);
    });

    it('keeps every canonical value in the exported OTel record', async () => {
      await logger.initialize('info');
      setOtelLogSink(sink);

      logger.info('canonical: exported', { ...canonical, extra: colliding } as any);

      const record = sink.emit.mock.calls
        .map(([emitted]) => emitted)
        .find((emitted) => emitted.body === 'canonical: exported');
      expect(record?.attributes).toEqual({ ...canonical, itemId: 'item-1' });
    });

    it('keeps a caller value for a canonical name the context leaves unset', async () => {
      await logger.initialize('info');
      const mockLogger = (await import('pino')).default() as any;
      const bare = { requestId: 'req-bare', timestamp: '2026-09-26T00:00:00.000Z' };

      logger.info('canonical: unset', {
        ...bare,
        extra: { traceId: 'upstream-trace', requestId: 'req-caller' },
      } as any);

      // `requestId` is always set, so the context's wins; `traceId` was never
      // set, so the caller's value replaces nothing and stays.
      expect(pinoRecords(mockLogger.info).at(-1)).toEqual([
        { ...bare, traceId: 'upstream-trace' },
        'canonical: unset',
      ]);
    });
  });

  describe('logInteraction', () => {
    it('should warn when interaction logger is not available', async () => {
      await logger.initialize('info');

      // Force interactionLogger to undefined (no logsPath in test config)
      const spy = vi.spyOn(logger, 'warning');

      logger.logInteraction('test', {
        context: { requestId: 'int-1', timestamp: new Date().toISOString() },
      });

      // In testing env without logsPath, interactionLogger is undefined
      // so it should warn
      expect(spy).toHaveBeenCalledWith(
        'Interaction logger not available.',
        expect.objectContaining({ requestId: 'int-1' }),
      );
      spy.mockRestore();
    });

    it('warns without throwing when the interaction data cannot be read', async () => {
      await logger.initialize('info');
      const spy = vi.spyOn(logger, 'warning');
      const { proxy: revoked, revoke } = Proxy.revocable({}, {});
      revoke();

      expect(() => logger.logInteraction('test', revoked as any)).not.toThrow();

      expect(spy).toHaveBeenCalledWith('Interaction logger not available.', undefined);
      spy.mockRestore();
    });
  });

  describe('log level filtering', () => {
    /** The eight levels, most severe first: RFC 5424 order. */
    const RFC5424_ORDER = [
      'emerg',
      'alert',
      'crit',
      'error',
      'warning',
      'notice',
      'info',
      'debug',
    ] as const satisfies readonly McpLogLevel[];

    /** The pino method each level is emitted through. */
    const PINO_METHOD = {
      emerg: 'fatal',
      alert: 'fatal',
      crit: 'error',
      error: 'error',
      warning: 'warn',
      notice: 'info',
      info: 'info',
      debug: 'debug',
    } as const satisfies Record<McpLogLevel, string>;

    /** The levels at `floor` or more severe — what a `floor` start level admits. */
    const admittedAt = (floor: McpLogLevel): McpLogLevel[] =>
      RFC5424_ORDER.slice(0, RFC5424_ORDER.indexOf(floor) + 1);

    it.each(RFC5424_ORDER)(
      'at a %s floor, writes exactly the records at that level or more severe',
      async (floor) => {
        await logger.initialize(floor);
        const mockLogger = (await import('pino')).default() as any;
        const ctx = { requestId: `floor-${floor}`, timestamp: '2026-10-03T00:00:00.000Z' };

        for (const level of RFC5424_ORDER) logger[level](`floor ${floor}: ${level}`, ctx);

        const written = RFC5424_ORDER.filter((level) =>
          mockLogger[PINO_METHOD[level]].mock.calls.some(
            ([, msg]: [unknown, string]) => msg === `floor ${floor}: ${level}`,
          ),
        );
        expect(written).toEqual(admittedAt(floor));
      },
    );

    it.each(RFC5424_ORDER)(
      'isLevelEnabled at a %s floor admits that level and every more severe one',
      async (floor) => {
        await logger.initialize(floor);

        const enabled = RFC5424_ORDER.filter((level) => logger.isLevelEnabled(level));

        expect(enabled).toEqual(admittedAt(floor));
      },
    );

    it('keeps notice and info apart although pino emits both at info', async () => {
      await logger.initialize('notice');
      const mockLogger = (await import('pino')).default() as any;
      mockLogger.info.mockClear();

      logger.info('notice floor: info record');
      logger.notice('notice floor: notice record');

      expect(mockLogger.info.mock.calls.map(([, msg]: [unknown, string]) => msg)).toEqual([
        'notice floor: notice record',
      ]);
      expect(logger.isLevelEnabled('info')).toBe(false);
      expect(logger.isLevelEnabled('notice')).toBe(true);
    });

    it('follows setLevel() in both directions', async () => {
      await logger.initialize('info');
      expect(logger.isLevelEnabled('debug')).toBe(false);

      logger.setLevel('debug');
      expect(logger.isLevelEnabled('debug')).toBe(true);

      logger.setLevel('warning');
      expect(logger.isLevelEnabled('info')).toBe(false);
      expect(logger.isLevelEnabled('warning')).toBe(true);
    });
  });

  describe('OTel log sink', () => {
    const sink = { emit: vi.fn() };
    const context = (extra?: Record<string, unknown>) =>
      ({
        requestId: 'otel-req',
        timestamp: '2026-09-25T00:00:00.000Z',
        ...(extra && { extra }),
      }) as any;
    /** Records emitted after `initialize`'s own startup line. */
    const emitted = () =>
      sink.emit.mock.calls
        .map(([record]) => record)
        .filter((record) => !String(record.body).startsWith('Logger initialized'));

    afterEach(() => {
      setOtelLogSink(undefined);
    });

    it('emits the message, MCP severity, and bindings of each written record', async () => {
      await logger.initialize('info');
      setOtelLogSink(sink);

      logger.info('otel: plain record', context({ itemId: 'a-1', count: 3 }));

      expect(emitted()).toEqual([
        {
          attributes: {
            count: 3,
            itemId: 'a-1',
            requestId: 'otel-req',
            timestamp: '2026-09-25T00:00:00.000Z',
          },
          body: 'otel: plain record',
          severityNumber: 9,
          severityText: 'info',
        },
      ]);
    });

    it.each([
      ['debug', 5],
      ['info', 9],
      ['notice', 10],
      ['warning', 13],
      ['error', 17],
      ['crit', 18],
      ['alert', 21],
      ['emerg', 22],
    ] as const)('maps %s to OTel severity number %i', async (level, severityNumber) => {
      await logger.initialize('debug');
      setOtelLogSink(sink);

      logger[level](`otel: ${level}`, context());

      expect(emitted()).toEqual([
        expect.objectContaining({ body: `otel: ${level}`, severityNumber, severityText: level }),
      ]);
    });

    it('redacts sensitive fields at every depth it keeps, as the process log does', async () => {
      await logger.initialize('info');
      setOtelLogSink(sink);

      logger.info(
        'otel: secrets',
        context({
          token: 'top-secret',
          nested: {
            apiKey: 'sk-1',
            deeper: { password: 'hunter2', kept: 'visible', deepest: { auth: { secret: 's-5' } } },
          },
          list: [{ secret: 's' }],
        }),
      );

      expect(emitted()[0]?.attributes).toMatchObject({
        token: '[REDACTED]',
        nested: {
          apiKey: '[REDACTED]',
          deeper: {
            password: '[REDACTED]',
            kept: 'visible',
            deepest: { auth: { secret: '[REDACTED]' } },
          },
        },
        list: [{ secret: '[REDACTED]' }],
      });
    });

    it('carries an Error as exception.* attributes rather than an err binding', async () => {
      await logger.initialize('info');
      setOtelLogSink(sink);
      const failure = new TypeError('boom');

      logger.error('otel: failure', failure, context());

      const [record] = emitted();
      expect(record?.attributes).toMatchObject({
        'exception.message': 'boom',
        'exception.stacktrace': expect.stringContaining('TypeError: boom'),
        'exception.type': 'TypeError',
      });
      expect(record?.attributes).not.toHaveProperty('err');
    });

    it('does not emit records the active level filters out', async () => {
      await logger.initialize('warning');
      setOtelLogSink(sink);

      logger.info('otel: below the level', context());
      logger.debug('otel: far below the level', context());
      logger.warning('otel: at the level', context());

      expect(emitted().map((record) => record.body)).toEqual(['otel: at the level']);
    });

    it('does not emit records the rate limiter suppresses', async () => {
      await logger.initialize('info');
      setOtelLogSink(sink);

      for (let i = 0; i < 15; i++) logger.info('otel: storm', context());

      // Threshold is 10 in this suite's config.
      expect(emitted().filter((record) => record.body === 'otel: storm')).toHaveLength(10);
    });

    it('stops emitting once the sink is detached', async () => {
      await logger.initialize('info');
      setOtelLogSink(sink);
      setOtelLogSink(undefined);

      logger.info('otel: after detach', context());

      expect(emitted()).toEqual([]);
    });

    it('keeps the sink hook off the published Logger surface', () => {
      expect('setOtelLogSink' in logger).toBe(false);
    });
  });
});

describe('sanitizeLogBindings', () => {
  it('preserves primitives and plain nested objects', () => {
    const out = sanitizeLogBindings({
      requestId: 'req-1',
      count: 42,
      active: true,
      missing: null,
      auth: { sub: 'user-1', scopes: ['a', 'b'] },
      tags: ['x', 'y'],
    });

    expect(out).toEqual({
      requestId: 'req-1',
      count: 42,
      active: true,
      missing: null,
      auth: { sub: 'user-1', scopes: ['a', 'b'] },
      tags: ['x', 'y'],
    });
  });

  it('strips AbortSignal without reading anything off it', () => {
    // Trip-wire on every trap that reads a property or lists keys — the `aborted` getter, a
    // `toJSON` lookup, a copy of its fields. The prototype check the walk does make is not one.
    const reads: PropertyKey[] = [];
    const trackedSignal = new Proxy(new AbortController().signal, {
      get(target, prop) {
        reads.push(prop);
        return Reflect.get(target, prop);
      },
      getOwnPropertyDescriptor(target, prop) {
        reads.push(prop);
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
      has(target, prop) {
        reads.push(prop);
        return Reflect.has(target, prop);
      },
      ownKeys(target) {
        reads.push('[[OwnPropertyKeys]]');
        return Reflect.ownKeys(target);
      },
    });

    const out = sanitizeLogBindings({
      requestId: 'req-1',
      signal: trackedSignal,
    });

    expect(out).toEqual({ requestId: 'req-1' });
    expect(reads).toEqual([]);
  });

  it('strips functions and method handles from framework Context', () => {
    const out = sanitizeLogBindings({
      requestId: 'req-1',
      timestamp: '2026-04-19T00:00:00.000Z',
      log: { info: () => {}, error: () => {} },
      state: { get: async () => null, set: async () => {} },
      elicit: async () => ({}),
      sample: async () => ({}),
      notifyResourceListChanged: () => {},
      notifyResourceUpdated: () => {},
      progress: { increment: async () => {}, setTotal: async () => {}, update: async () => {} },
    });

    // Plain objects survive but their function-valued properties are stripped.
    expect(out).toEqual({
      requestId: 'req-1',
      timestamp: '2026-04-19T00:00:00.000Z',
      log: {},
      state: {},
      progress: {},
    });
  });

  it('converts Date to ISO string and URL to string', () => {
    const date = new Date('2026-04-19T12:34:56.000Z');
    const url = new URL('https://api.example.com/data?x=1');

    const out = sanitizeLogBindings({ at: date, target: url });

    expect(out).toEqual({
      at: '2026-04-19T12:34:56.000Z',
      target: 'https://api.example.com/data?x=1',
    });
  });

  it('recursively strips nested non-plain objects', () => {
    const controller = new AbortController();
    const out = sanitizeLogBindings({
      requestId: 'req-1',
      extra: { nested: { signal: controller.signal, value: 7 } },
    });

    expect(out).toEqual({
      requestId: 'req-1',
      extra: { nested: { value: 7 } },
    });
  });

  it('drops Map and Set instances', () => {
    const out = sanitizeLogBindings({
      requestId: 'req-1',
      cache: new Map([['a', 1]]),
      tags: new Set(['x']),
    });

    expect(out).toEqual({ requestId: 'req-1' });
  });

  it('writes an Error as its type, message, and stack, never the instance', () => {
    const err = Object.assign(new TypeError('boom'), { path: 'https://api.example.test/x' });
    const out = sanitizeLogBindings({ requestId: 'req-1', err, nested: { cause: err } });

    const written = { type: 'TypeError', message: 'boom', stack: err.stack };
    expect(out).toEqual({ requestId: 'req-1', err: written, nested: { cause: written } });
  });

  it('writes every Error without its stack under includeStack: false, at any depth', () => {
    const upstream = new Error('upstream down', { cause: new TypeError('socket hang up') });
    const failure = new McpError(JsonRpcErrorCode.RequestCancelled, 'cancelled', { upstream });
    const bindings = { errorData: { causeChain: [{ data: { failure } }] }, err: failure };

    const stackFree = toLogValue(bindings, { includeStack: false });

    expect(JSON.stringify(stackFree)).not.toContain('"stack"');
    expect(stackFree).toEqual({
      errorData: {
        causeChain: [
          {
            data: {
              failure: {
                type: 'McpError',
                message: 'cancelled',
                code: JsonRpcErrorCode.RequestCancelled,
                data: {
                  upstream: {
                    type: 'Error',
                    message: 'upstream down',
                    cause: { type: 'TypeError', message: 'socket hang up' },
                  },
                },
              },
            },
          },
        ],
      },
      err: expect.objectContaining({ type: 'McpError', message: 'cancelled' }),
    });
    // The default walk, the one every record goes through, keeps them.
    expect(toLogValue(bindings)).toEqual(sanitizeLogBindings(bindings));
    expect(JSON.stringify(sanitizeLogBindings(bindings)).match(/"stack"/g)).toHaveLength(6);
  });

  it('writes an own __proto__ key as a field, never as the copy’s prototype', () => {
    const parsed = JSON.parse('{"__proto__":{"leaked":"yes","token":"t"},"a":2}') as object;

    const written = toLogValue(parsed) as Record<string, unknown>;

    expect(Object.getPrototypeOf(written)).toBe(Object.prototype);
    expect(Object.hasOwn(written, '__proto__')).toBe(true);
    expect(JSON.stringify(written)).toBe(
      '{"__proto__":{"leaked":"yes","token":"[REDACTED]"},"a":2}',
    );
  });

  it('writes an invalid Date as null instead of throwing out of the walk', () => {
    expect(
      sanitizeLogBindings({ at: new Date('not a date'), nested: { at: new Date(Number.NaN) } }),
    ).toEqual({ at: null, nested: { at: null } });
  });

  it('writes a reference back to an enclosing object as [Circular]', () => {
    const node: Record<string, unknown> = { requestId: 'req-1', value: 42 };
    node.self = node;
    node.nested = { parent: node };

    expect(sanitizeLogBindings(node)).toEqual({
      requestId: 'req-1',
      value: 42,
      self: '[Circular]',
      nested: { parent: '[Circular]' },
    });
  });

  it('writes a reference back to the mirror’s data root as [Circular], directly and through toJSON', () => {
    const data: Record<string, unknown> = { value: 42 };
    data.self = data;
    data.nested = { parent: data, viaJson: { toJSON: () => data } };

    expect(toMirrorValue(data)).toEqual({
      value: 42,
      self: '[Circular]',
      nested: { parent: '[Circular]', viaJson: '[Circular]' },
    });
  });

  it('fuzz: never throws and produces JSON-serializable output for arbitrary bindings', () => {
    // Arbitrary that mixes safe and unsafe values at varying depths.
    const unsafe = fc.oneof(
      fc.constant(new AbortController().signal),
      fc.constant(new Map([['k', 'v']])),
      fc.constant(new Set([1, 2])),
      fc.constant(() => {}),
      fc.constant(Promise.resolve(1)),
      fc.constant(new Date('2026-04-19T00:00:00Z')),
      fc.constant(new URL('https://example.com/path?q=1')),
      fc.constant(new Error('boom')),
    );
    const primitive = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
    );
    const leaf = fc.oneof(primitive, unsafe);
    const tree: fc.Arbitrary<unknown> = fc.letrec((rec) => ({
      node: fc.oneof(
        { depthSize: 'small', withCrossShrink: true },
        leaf,
        fc.array(rec('node'), { maxLength: 4 }),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), rec('node'), { maxKeys: 4 }),
      ),
    })).node;

    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), tree, { maxKeys: 8 }),
        (bindings) => {
          const out = sanitizeLogBindings(bindings);
          // Serialization must succeed — pino will JSON-stringify this.
          const json = JSON.stringify(out);
          expect(typeof json).toBe('string');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('keeps data through depth 15 and writes a value past the bound as [MaxDepth]', () => {
    /** `levels` nested `child` objects around a leaf, the outermost being the bindings. */
    const nest = (levels: number): Record<string, unknown> => {
      let node: Record<string, unknown> = { v: 'leaf' };
      for (let i = 0; i < levels; i++) node = { child: node };
      return node;
    };
    /** The `child` objects walked before reaching a non-object, and that value. */
    const descend = (value: unknown): [number, unknown] => {
      let cursor = value;
      let levels = 0;
      while (cursor !== null && typeof cursor === 'object' && 'child' in cursor) {
        cursor = (cursor as { child: unknown }).child;
        levels++;
      }
      return [levels, cursor];
    };

    // The bindings sit at depth 0, so the leaf object of `nest(15)` sits at 15.
    expect(descend(sanitizeLogBindings(nest(15)))).toEqual([15, { v: 'leaf' }]);
    expect(descend(sanitizeLogBindings(nest(16)))).toEqual([16, '[MaxDepth]']);
    expect(descend((sanitizeLogBindings({ list: [[[nest(13)]]] }) as any).list[0][0][0])).toEqual([
      12,
      '[MaxDepth]',
    ]);
  });

  it('never lists the keys of an object past the depth bound', () => {
    let listed = 0;
    /** An object whose key listing throws, counting each attempt. */
    const unlistable = new Proxy(
      {},
      {
        ownKeys() {
          listed++;
          throw new Error('ownKeys trap');
        },
      },
    );
    let data: Record<string, unknown> = { child: unlistable };
    for (let level = 1; level < 16; level++) data = { child: data };

    const written = sanitizeLogBindings(data);

    // The Proxy sits at depth 16: written as [MaxDepth], not [Unreadable], and never asked for its keys.
    let cursor: unknown = written;
    for (let level = 0; level < 16; level++) cursor = (cursor as { child: unknown }).child;
    expect(cursor).toBe('[MaxDepth]');
    expect(listed).toBe(0);
    // One level up, the same object is listed, and its throwing trap is [Unreadable].
    expect(sanitizeLogBindings({ child: unlistable })).toEqual({ child: '[Unreadable]' });
    expect(listed).toBe(1);
  });

  describe('the walk’s bounds', () => {
    /** `shared` five levels below the bindings, in an array holding it `copies` times. */
    const repeated = (shared: unknown, copies: number) => ({
      a: { b: { c: { d: { rows: Array.from({ length: copies }, () => shared) } } } },
      after: 'kept',
    });
    /** `fn`'s result and the thread CPU milliseconds it took. */
    const timed = <T>(fn: () => T): [T, number] => {
      const start = process.threadCpuUsage();
      const result = fn();
      const { user, system } = process.threadCpuUsage(start);
      return [result, (user + system) / 1000];
    };
    /** How many times `marker` is written as a value in `json`. */
    const count = (json: string, marker: string) => json.split(`"${marker}"`).length - 1;
    /** A plain object whose three getters each build a fresh object of the same kind on every read. */
    const builtByGetters = (): object => {
      const node = {};
      for (const key of ['a', 'b', 'c']) {
        Object.defineProperty(node, key, { enumerable: true, get: builtByGetters });
      }
      return node;
    };
    /** A Proxy whose every field read builds a fresh Proxy of the same kind. */
    const builtByProxy = (): object =>
      new Proxy(
        {},
        {
          ownKeys: () => ['a', 'b', 'c'],
          getOwnPropertyDescriptor: () => ({
            configurable: true,
            enumerable: true,
            value: undefined,
            writable: true,
          }),
          get: (_target, key) =>
            ['a', 'b', 'c'].includes(key as string) ? builtByProxy() : undefined,
        },
      );
    /** A value whose `toJSON` builds three fresh instances of itself on every call. */
    class BuiltByToJSON {
      toJSON() {
        return { a: new BuiltByToJSON(), b: new BuiltByToJSON(), c: new BuiltByToJSON() };
      }
    }

    it('writes 100,000 distinct objects in full', () => {
      const items = Array.from({ length: 100_000 }, (_, i) => ({ i }));

      const out = sanitizeLogBindings({ items, after: 'kept' }) as { items: unknown[] };

      expect(out.items).toHaveLength(100_000);
      expect(out.items.at(-1)).toEqual({ i: 99_999 });
      expect(JSON.stringify(out)).not.toContain('[Truncated]');
    });

    it('writes a large distinct string whole', () => {
      const text = 'x'.repeat(4_000_000);

      expect((sanitizeLogBindings({ nested: { text } }) as any).nested.text).toBe(text);
    });

    it('writes small values that 20,000 rows share in full on every row', () => {
      const tags: string[] = [];
      const meta = { currency: 'USD', unit: 'm' };
      const rows = Array.from({ length: 20_000 }, (_, id) => ({ id, tags, meta }));

      const json = JSON.stringify(sanitizeLogBindings({ rows }));

      expect(count(json, '[Truncated]')).toBe(0);
      expect(JSON.parse(json).rows.at(-1)).toEqual({ id: 19_999, tags: [], meta });
    });

    it('charges each repeat about the characters it writes, up to a million, then writes [Truncated]', () => {
      // A repeat writes {"k":"x…x"}: two braces, the name with its quotes, colon, and comma,
      // and the string with its quotes — 109 characters.
      const shared = { k: 'x'.repeat(100) };

      const out = sanitizeLogBindings({
        items: Array.from({ length: 12_000 }, () => shared),
        after: 'kept',
      }) as { after: string; items: unknown[] };

      // The first write is the object's own; 9,174 repeats of 109 characters fit in 1,000,000.
      const whole = out.items.filter((item) => JSON.stringify(item) === JSON.stringify(shared));
      expect(whole).toHaveLength(9_175);
      expect(out.items[9_175]).toEqual({ k: '[Truncated]' });
      expect(out.items.at(-1)).toBe('[Truncated]');
      expect(out.after).toBe('kept');
    });

    it('writes a later small repeat that fits after a large one was cut', () => {
      const big = { s: 'x'.repeat(600_000) };
      const meta = { a: 1 };

      const out = sanitizeLogBindings({ big: [big, big, big], later: { x: meta, y: meta } }) as any;

      expect(out.big).toEqual([big, big, { s: '[Truncated]' }]);
      expect(out.later).toEqual({ x: meta, y: meta });
    });

    it.each([
      ['the process log', (data: Record<string, unknown>) => sanitizeLogBindings(data)],
      ['the mirror', (data: Record<string, unknown>) => toMirrorValue(data)],
    ])('bounds a long string repeated across distinct objects, on %s', (_sink, walk) => {
      const text = 'x'.repeat(100_000);
      const rows = Array.from({ length: 2_000 }, () => ({ s: text }));

      const out = walk({ a: { b: { c: { d: { rows } } } }, after: 'kept' }) as any;

      // One whole copy, then about a million characters of repeats; unbounded, 200 MB.
      expect(JSON.stringify(out).length).toBeLessThan(1_500_000);
      const written = out.a.b.c.d.rows as unknown[];
      expect(written).toHaveLength(2_000);
      expect(written[0]).toEqual({ s: text });
      expect(written.at(-1)).toEqual({ s: '[Truncated]' });
      expect(out.after).toBe('kept');
    });

    /**
     * `count` distinct texts of `length` characters: one long run with a six-digit tag at `at`,
     * each built by concatenation as a fresh, unflattened string, as data usually reaches a log.
     */
    const distinctLongTexts = (count: number, at: number, length = 20_000) => {
      const run = 'a'.repeat(length - 6);
      return Array.from(
        { length: count },
        (_, i) => run.slice(0, at) + String(i).padStart(6, '0') + run.slice(at),
      );
    };

    it.each([
      ['in their last characters', 16_394],
      // Outside every window the walk samples a long text by: its head, middle, and tail.
      ['3,000 characters in', 3_000],
    ])(
      'remembers distinct same-length long texts differing %s in time linear in their number',
      (_where, at) => {
        /** The fastest of three walks over `count` fresh texts, in thread CPU milliseconds. */
        const fastest = (count: number) => {
          let best = Number.POSITIVE_INFINITY;
          for (let run = 0; run < 3; run++) {
            // 16,400 characters, just past the length V8 hashes a string by alone; 1,000 of them
            // stay within the ceiling on characters written.
            const list = distinctLongTexts(count, at, 16_400);
            const [out, ms] = timed(() => sanitizeLogBindings({ list }) as any);
            // Compared after timing: comparing flattens each string, which hides the quadratic case.
            expect(out.list).toEqual(list);
            best = Math.min(best, ms);
          }
          return best;
        };

        const small = fastest(250);
        const large = fastest(1_000);

        // Four times the texts: about four times the work when linear, sixteen when quadratic. A set
        // of strings, which V8 hashes by length alone past 16,383 characters, took 275 ms at 1,000 on
        // Node, sixteen times its 250; comparing texts sharing one sample one by one took 16 times too.
        expect(large / Math.max(small, 1)).toBeLessThan(8);
        expect(large).toBeLessThan(1_000);
      },
    );

    it('remembers text by value from 1,024 characters, writing shorter text on every row', () => {
      const short = 'y'.repeat(300);
      const long = 'y'.repeat(2_048);

      const shortJson = JSON.stringify(
        sanitizeLogBindings({
          rows: Array.from({ length: 5_000 }, (_, id) => ({ id, text: short })),
        }),
      );
      const longOut = sanitizeLogBindings({
        rows: Array.from({ length: 2_000 }, (_, id) => ({ id, text: long })),
      }) as any;

      // 1.6 MB of a 300-character string, past the million repeated characters a long one may take.
      expect(shortJson.length).toBeGreaterThan(1_500_000);
      expect(count(shortJson, '[Truncated]')).toBe(0);
      // The 2,048-character one is repeated content from its second row: about a million characters
      // of repeats, where writing it on every row is 4 MB.
      const longJson = JSON.stringify(longOut);
      expect(longJson.length).toBeLessThan(1_500_000);
      expect(longOut.rows[0]).toEqual({ id: 0, text: long });
      expect(longOut.rows.at(-1)).toEqual({ id: 1_999, text: '[Truncated]' });
    });

    it('never takes a distinct long text for one written before, however much of it matches', () => {
      // The repeats spend the bound on repeated content, so any text taken for a repeat is cut.
      const spent = { s: 'x'.repeat(600_000) };
      const texts = distinctLongTexts(40, 3_000);

      const out = sanitizeLogBindings({ spent: [spent, spent, spent], texts }) as any;

      expect(out.spent.at(-1)).toEqual({ s: '[Truncated]' });
      expect(out.texts).toEqual(texts);
    });

    it('bounds a long field name repeated across distinct objects, matching it once per write', () => {
      const name = 'k'.repeat(100_000);
      const rows = Array.from({ length: 2_000 }, () => ({ [name]: 1 }));

      const [out, ms] = timed(() => sanitizeLogBindings({ rows, after: 'kept' }) as any);

      expect(JSON.stringify(out).length).toBeLessThan(1_500_000);
      expect(out.rows[0]).toEqual({ [name]: 1 });
      expect(out.rows.at(-1)).toBe('[Truncated]');
      expect(out.after).toBe('kept');
      // Unbounded, the key matcher's 2,000 scans of the name took 300–550 ms.
      expect(ms).toBeLessThan(250);
    });

    it('bounds a mirror whose toJSON returns one shared object from distinct objects', () => {
      // Short fields only, so neither a shared child object nor a long string marks the repeat.
      const shared = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i]));
      const rows = Array.from({ length: 2_000 }, () => ({ toJSON: () => shared }));

      const json = JSON.stringify(toMirrorValue({ rows, after: 'kept' }));

      // About a million characters of repeats; unbounded, 6.2 MB.
      expect(json.length).toBeLessThan(1_500_000);
      expect(json).toContain('"[Truncated]"');
      expect(JSON.parse(json).after).toBe('kept');
    });

    it.each([
      ['getters, on the process log', () => sanitizeLogBindings({ value: builtByGetters() })],
      ['getters, on the mirror', () => toMirrorValue({ value: builtByGetters() })],
      ['a Proxy, on the process log', () => sanitizeLogBindings({ value: builtByProxy() })],
      ['a Proxy, on the mirror', () => toMirrorValue({ value: builtByProxy() })],
      ['toJSON, on the mirror', () => toMirrorValue({ value: new BuiltByToJSON() })],
    ])('bounds data built on every read by %s, then stops', (_kind, walk) => {
      const [json, ms] = timed(() => JSON.stringify(walk()));

      // 7–36 ms on Bun and Node; unbounded, 3–35 s and a 308 MB line.
      expect(ms).toBeLessThan(250);
      expect(json.length).toBeLessThan(2_000_000);
      expect(count(json, '[Truncated]')).toBe(1);
    });

    it.each([
      ['numbers', (i: number) => i],
      ['sensitive values, each written as [REDACTED] without a read', (i: number) => `secret-${i}`],
    ])(
      'counts every field of data built on every read, so fields holding %s stay within 400,000 reads',
      (kind, leaf) => {
        const prefix = kind === 'numbers' ? 'n' : 'password';
        /** A plain object whose three getters each build a fresh one on every read, beside 50 data fields. */
        const wide = (): object => {
          const node: Record<string, unknown> = {};
          for (const key of ['a', 'b', 'c']) {
            Object.defineProperty(node, key, { enumerable: true, get: wide });
          }
          for (let i = 0; i < 50; i++) node[`${prefix}${i}`] = leaf(i);
          return node;
        };

        const json = JSON.stringify(sanitizeLogBindings({ value: wide() }));

        // Every field written costs at least one read: 298,534 fields, 2.6 MB of numbers or 7.5 MB
        // of [REDACTED]. Counting only objects, the walk wrote 504,480 fields: 4.5 MB and 12.7 MB.
        expect(json.split('":').length - 1).toBeLessThanOrEqual(400_000);
        expect(json.length).toBeLessThan(kind === 'numbers' ? 3_000_000 : 8_000_000);
        expect(count(json, '[Truncated]')).toBe(1);
      },
    );

    describe('the ceiling on characters written', () => {
      /** 16 MiB: what one walk may write, in characters of strings, field names, and primitives. */
      const CEILING = 16 * 1024 * 1024;
      const LONG = 'x'.repeat(1_000);
      /** A plain object whose three getters each build another like it, beside 50 fields of one 1,000-character string. */
      const wideByGetters = (): object => {
        const node: Record<string, unknown> = {};
        for (const key of ['a', 'b', 'c']) {
          Object.defineProperty(node, key, { enumerable: true, get: wideByGetters });
        }
        for (let i = 0; i < 50; i++) node[`f${i}`] = LONG;
        return node;
      };
      const wideKeys = ['a', 'b', 'c', ...Array.from({ length: 50 }, (_, i) => `f${i}`)];
      /** The same as a Proxy: each child read builds a fresh Proxy, each other field reads the long string. */
      const wideByProxy = (): object =>
        new Proxy(
          {},
          {
            ownKeys: () => wideKeys,
            getOwnPropertyDescriptor: () => ({
              configurable: true,
              enumerable: true,
              value: undefined,
              writable: true,
            }),
            get: (_target, key) =>
              key === 'a' || key === 'b' || key === 'c' ? wideByProxy() : LONG,
          },
        );

      it.each([
        ['getters, on the process log', () => sanitizeLogBindings({ value: wideByGetters() })],
        ['getters, on the mirror', () => toMirrorValue({ value: wideByGetters() })],
        ['a Proxy, on the process log', () => sanitizeLogBindings({ value: wideByProxy() })],
        ['a Proxy, on the mirror', () => toMirrorValue({ value: wideByProxy() })],
      ])(
        'stops data built on every read with long string fields at 16 MiB, built by %s',
        (_kind, walk) => {
          const [json, ms] = timed(() => JSON.stringify(walk()));

          // Bounded by reads alone, the walk wrote 284 MB.
          expect(json.length).toBeGreaterThan(CEILING - 2_000);
          expect(json.length).toBeLessThan(CEILING + 20_000);
          expect(count(json, '[Truncated]')).toBe(1);
          expect(ms).toBeLessThan(1_000);
        },
      );

      it.each([
        ['the process log', (data: Record<string, unknown>) => sanitizeLogBindings(data)],
        ['the mirror', (data: Record<string, unknown>) => toMirrorValue(data)],
      ])(
        'writes a 10 MB string whole and cuts a 20 MB one, stopping the walk there, on %s',
        (_sink, walk) => {
          const ten = 'x'.repeat(10_000_000);
          const twenty = 'y'.repeat(20_000_000);

          expect(walk({ nested: { text: ten }, after: 'kept' })).toEqual({
            nested: { text: ten },
            after: 'kept',
          });
          expect(walk({ nested: { text: twenty }, after: 'not reached' })).toEqual({
            nested: { text: '[Truncated]' },
          });
        },
      );

      it('writes a string that fills the ceiling exactly, and cuts one a character longer', () => {
        // The name `text` with its quotes, colon, and comma, then the string with its quotes.
        const fits = 'x'.repeat(CEILING - 8 - 2);
        const over = `${fits}x`;

        expect(toLogValue({ text: fits })).toEqual({ text: fits });
        expect(toLogValue({ text: over })).toEqual({ text: '[Truncated]' });
      });

      it.each([
        ['the process log', (data: Record<string, unknown>) => sanitizeLogBindings(data)],
        ['the mirror', (data: Record<string, unknown>) => toMirrorValue(data)],
      ])(
        'writes a field name past the ceiling as [Truncated], with its value, on %s',
        (_sink, walk) => {
          const name = 'k'.repeat(20_000_000);

          expect(walk({ before: 'kept', nested: { [name]: 1 }, after: 'not reached' })).toEqual({
            before: 'kept',
            nested: { '[Truncated]': '[Truncated]' },
          });
        },
      );

      it('counts field names toward the ceiling', () => {
        // 20,000 distinct names of 1,000 characters: 20 MB of names, none of them repeated.
        const wide = Object.fromEntries(
          Array.from({ length: 20_000 }, (_, i) => [String(i).padStart(1_000, 'k'), i]),
        );

        const out = sanitizeLogBindings({ wide, after: 'not reached' }) as any;
        const json = JSON.stringify(out);

        expect(json.length).toBeLessThan(CEILING + 20_000);
        expect(json).toContain('"[Truncated]"');
        expect(Object.keys(out.wide).slice(0, 10_000)).toEqual(Object.keys(wide).slice(0, 10_000));
        expect(out).not.toHaveProperty('after');
      });

      it('counts primitives toward the ceiling', () => {
        const numbers = Array.from({ length: 5_000 }, () => 123_456_789);

        const out = sanitizeLogBindings({
          text: 'x'.repeat(CEILING - 10_000),
          numbers,
          after: 'not reached',
        }) as any;

        // About 10,000 characters were left: some 1,100 nine-digit numbers.
        expect(out.numbers.length).toBeGreaterThan(1_000);
        expect(out.numbers.length).toBeLessThan(1_200);
        expect(out.numbers.at(-1)).toBe('[Truncated]');
        expect(out).not.toHaveProperty('after');
      });

      it('counts repeated content toward the ceiling as well as toward the bound on repeats', () => {
        // 9,000 repeats of 109 characters fit in the million characters of repeats, not in what
        // the 16,000,000-character string leaves of the ceiling.
        const shared = { k: 'x'.repeat(100) };

        const out = sanitizeLogBindings({
          text: 'x'.repeat(16_000_000),
          rows: Array.from({ length: 9_000 }, () => shared),
          after: 'not reached',
        }) as any;

        expect(out.rows.length).toBeLessThan(9_000);
        expect(out.rows.at(-1)).toEqual(expect.objectContaining({ k: '[Truncated]' }));
        expect(out).not.toHaveProperty('after');
      });
    });

    it('stops after 400,000 reads — one per object, per field, and per array element that is not an object — at [Truncated]', () => {
      const list = Array.from({ length: 450_000 }, (_, i) => i);
      const rows = Array.from({ length: 250_000 }, (_, i) => ({ i }));

      const out = sanitizeLogBindings({ list, after: 'not reached' }) as any;
      const outRows = sanitizeLogBindings({ rows, after: 'not reached' }) as any;

      // The bindings and the array take two reads, then 399,998 elements.
      expect(out.list).toHaveLength(399_999);
      expect(out.list[399_997]).toBe(399_997);
      expect(out.list[399_998]).toBe('[Truncated]');
      expect(out).not.toHaveProperty('after');
      // Each row takes two: the object and its field.
      expect(outRows.rows).toHaveLength(200_000);
      expect(outRows.rows[199_998]).toEqual({ i: 199_998 });
      expect(outRows.rows[199_999]).toBe('[Truncated]');
      expect(outRows).not.toHaveProperty('after');
    });

    it('counts an object past the depth bound as ten reads', () => {
      // 50,000 objects at depth 16, each written as [MaxDepth], in one array at depth 15.
      let data: unknown = Array.from({ length: 50_000 }, () => ({}));
      for (let level = 0; level < 15; level++) data = { n: data };

      const json = JSON.stringify(sanitizeLogBindings(data as Record<string, unknown>));

      // Sixteen reads reach the array; 39,998 objects of ten fit in the rest.
      expect(count(json, '[MaxDepth]')).toBe(39_998);
      expect(count(json, '[Truncated]')).toBe(1);
    });

    it('bounds an array whose length a Proxy reports', () => {
      const list = new Proxy([], {
        get: (target, key) =>
          key === 'length'
            ? 5_000_000
            : typeof key === 'string' && /^\d+$/.test(key)
              ? 1
              : Reflect.get(target, key),
      });

      const [out, ms] = timed(() => sanitizeLogBindings({ list }) as any);

      expect(out.list).toHaveLength(399_999);
      expect(out.list.at(-1)).toBe('[Truncated]');
      expect(ms).toBeLessThan(250);
    });

    it.each([
      ['a string', { text: 'x'.repeat(100_000) }],
      ['a field name', { ['k'.repeat(100_000)]: 1 }],
      ['an array of numbers', Array.from({ length: 10_000 }, (_, i) => i * 1.5)],
    ])('bounds the characters a shared reference to %s writes again', (_kind, shared) => {
      const written = sanitizeLogBindings(repeated(shared, 200)) as any;
      const json = JSON.stringify(written);

      // One whole copy, then about a million characters of repeats, then markers.
      expect(json.length).toBeLessThan(1_500_000);
      expect(written.a.b.c.d.rows[0]).toEqual(shared);
      // The last copy is cut: whole, or at its first field when its braces and name still fit.
      expect(JSON.stringify(written.a.b.c.d.rows.at(-1))).toContain('"[Truncated]"');
      expect(written.after).toBe('kept');
    });

    it('stops a repeated array at its first value past the bound, with one marker', () => {
      const numbers = Array.from({ length: 10_000 }, (_, i) => i * 1.5);

      const rows = (sanitizeLogBindings(repeated(numbers, 200)) as any).a.b.c.d.rows as unknown[];

      const cut = rows.find(
        (row) => Array.isArray(row) && row.at(-1) === '[Truncated]',
      ) as unknown[];
      expect(cut.length).toBeLessThan(numbers.length);
      expect(cut.indexOf('[Truncated]')).toBe(cut.length - 1);
    });

    it('bounds a mirror whose toJSON builds a fresh object on every call', () => {
      class Node {
        constructor(private readonly next: unknown) {}
        toJSON() {
          return { a: this.next, b: this.next, c: this.next };
        }
      }
      let graph: unknown = { leaf: true };
      for (let i = 0; i < 16; i++) graph = new Node(graph);

      const json = JSON.stringify(toMirrorValue({ graph }));

      expect(json).toContain('"[Truncated]"');
      expect(json.length).toBeLessThan(2_000_000);
    });

    it('writes a shared reference in full on every path while the budget lasts', () => {
      const shared = { id: 's', tags: ['a'] };

      expect(sanitizeLogBindings({ a: shared, b: { c: shared }, list: [shared, shared] })).toEqual({
        a: shared,
        b: { c: shared },
        list: [shared, shared],
      });
    });

    it('bounds a graph whose objects share references to about a million characters, at every walk', () => {
      let graph: Record<string, unknown> = { leaf: true };
      for (let i = 0; i < 16; i++) graph = { a: graph, b: graph, c: graph };

      const first = JSON.stringify(sanitizeLogBindings({ graph }));
      const second = JSON.stringify(sanitizeLogBindings({ graph }));

      // Unbounded, the 3^16 paths through these 17 objects write 380 MB.
      expect(first.length).toBeLessThan(1_500_000);
      expect(first).toContain('"[Truncated]"');
      expect(second).toBe(first);
      // A fresh walk starts with a full budget.
      expect(sanitizeLogBindings({ small: { a: 1 } })).toEqual({ small: { a: 1 } });
    });
  });

  it('writes a value whose read throws as [Unreadable], never throwing out of the walk', () => {
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    const failing = Object.defineProperty(new Error('accessor'), 'code', {
      get() {
        throw new Error('code getter threw');
      },
    });
    const level = {
      getter: {
        get boom(): never {
          throw new Error('getter threw');
        },
      },
      revoked,
      failing,
    };

    const out = sanitizeLogBindings({ top: level, deep: { a: { b: { c: { d: level } } } } }) as any;

    const expected = {
      getter: { boom: '[Unreadable]' },
      revoked: '[Unreadable]',
      failing: { type: 'Error', message: 'accessor', stack: failing.stack },
    };
    expect(out.top).toEqual(expected);
    expect(out.deep.a.b.c.d).toEqual(expected);
  });

  it('redacts with the shared key matcher at every depth, word and adjacent-word matches included', () => {
    const secrets = {
      accessToken: 'a',
      'x-api-key': 'b',
      upstream_private_key: 'c',
      max_tokens: 5,
    };
    const masked = {
      accessToken: '[REDACTED]',
      'x-api-key': '[REDACTED]',
      upstream_private_key: '[REDACTED]',
      max_tokens: 5,
    };

    expect(
      sanitizeLogBindings({ ...secrets, l1: { l2: { l3: { l4: { l5: { ...secrets } } } } } }),
    ).toEqual({ ...masked, l1: { l2: { l3: { l4: { l5: masked } } } } });
  });
});

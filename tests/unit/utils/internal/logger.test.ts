/**
 * @fileoverview Unit tests for the Logger class.
 * Tests rate-limiting, RFC5424 level mapping, singleton behavior,
 * and state management without requiring file I/O.
 * @module tests/utils/internal/logger
 */
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Logger, type McpLogLevel, sanitizeLogBindings } from '@/utils/internal/logger.js';
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
  requestContextService: {
    createRequestContext: vi.fn((overrides = {}) => ({
      requestId: 'mock-req-id',
      timestamp: new Date().toISOString(),
      ...overrides,
    })),
  },
}));

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
    it('should not throw for any MCP log level', async () => {
      const levels: McpLogLevel[] = [
        'debug',
        'info',
        'notice',
        'warning',
        'error',
        'crit',
        'alert',
        'emerg',
      ];

      for (const level of levels) {
        // Reset
        if (logger.isInitialized()) await logger.close();
        await logger.initialize(level);
        expect(logger.isInitialized()).toBe(true);
        await logger.close();
      }
    });
  });

  describe('setLevel', () => {
    it('should change log level after initialization', async () => {
      await logger.initialize('info');
      logger.setLevel('debug');

      // Should not throw
      logger.debug('test debug after level change');
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
  });

  describe('rate limiting', () => {
    it('should allow messages under the threshold', async () => {
      await logger.initialize('info');

      // Rate limit threshold is 10 within 60s window.
      // First 10 calls should not be rate-limited.
      for (let i = 0; i < 10; i++) {
        logger.info('repeated message');
      }

      // Access the internal pino logger to check call count
      const pino = (await import('pino')).default;
      const mockLogger = pino() as any;
      // The info method should have been called (includes init messages + our 10)
      expect(mockLogger.info.mock.calls.length).toBeGreaterThanOrEqual(10);
    });

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
      expect(callsAfter).toBeLessThanOrEqual(10);
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
    it('error() should accept Error object as second arg', async () => {
      await logger.initialize('info');
      const err = new Error('test error');

      expect(() => logger.error('Something failed', err)).not.toThrow();
    });

    it('error() should accept context as second arg', async () => {
      await logger.initialize('info');
      const ctx = { requestId: 'r1', timestamp: new Date().toISOString() };

      expect(() => logger.error('Something failed', ctx as any)).not.toThrow();
    });

    it('crit() should accept Error + context', async () => {
      await logger.initialize('info');
      const err = new Error('critical');
      const ctx = { requestId: 'r2', timestamp: new Date().toISOString() };

      expect(() => logger.crit('Critical failure', err, ctx as any)).not.toThrow();
    });

    it('alert() should accept Error + context', async () => {
      await logger.initialize('info');
      const err = new Error('alert-level');
      const ctx = { requestId: 'r-alert', timestamp: new Date().toISOString() };

      expect(() => logger.alert('Alert condition', err, ctx as any)).not.toThrow();
    });

    it('alert() should accept context as second arg', async () => {
      await logger.initialize('info');
      const ctx = { requestId: 'r-alert-ctx', timestamp: new Date().toISOString() };

      expect(() => logger.alert('Alert condition', ctx as any)).not.toThrow();
    });

    it('emerg() should accept Error + context', async () => {
      await logger.initialize('info');
      const err = new Error('emergency');
      const ctx = { requestId: 'r-emerg', timestamp: new Date().toISOString() };

      expect(() => logger.emerg('Emergency', err, ctx as any)).not.toThrow();
    });

    it('emerg() should accept context as second arg', async () => {
      await logger.initialize('info');
      const ctx = { requestId: 'r-emerg-ctx', timestamp: new Date().toISOString() };

      expect(() => logger.emerg('Emergency', ctx as any)).not.toThrow();
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
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('log level filtering', () => {
    it('should not log debug messages when level is set to warning', async () => {
      await logger.initialize('warning');

      const pino = (await import('pino')).default;
      const mockLogger = pino() as any;
      const initialDebugCalls = mockLogger.debug.mock.calls.length;

      logger.debug('this should be filtered');

      expect(mockLogger.debug.mock.calls.length).toBe(initialDebugCalls);
    });

    it('should log error messages when level is set to warning', async () => {
      await logger.initialize('warning');

      const pino = (await import('pino')).default;
      const mockLogger = pino() as any;
      const initialErrorCalls = mockLogger.error.mock.calls.length;

      logger.error('this should pass', {
        requestId: 'r4',
        timestamp: new Date().toISOString(),
      } as any);

      expect(mockLogger.error.mock.calls.length).toBeGreaterThan(initialErrorCalls);
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

  it('strips AbortSignal without invoking its aborted getter', () => {
    const controller = new AbortController();
    const signal = controller.signal;

    // Trip-wire: replace the aborted getter on a tracking proxy-like wrapper
    // to prove the sanitizer never touches it.
    let accessed = false;
    const trackedSignal = new Proxy(signal, {
      get(target, prop, receiver) {
        if (prop === 'aborted') accessed = true;
        return Reflect.get(target, prop, receiver);
      },
    });

    const out = sanitizeLogBindings({
      requestId: 'req-1',
      signal: trackedSignal,
    });

    expect(out).toEqual({ requestId: 'req-1' });
    expect(accessed).toBe(false);
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

  it('preserves Error instances for pino stdSerializers', () => {
    const err = new Error('boom');
    const out = sanitizeLogBindings({ requestId: 'req-1', err });

    expect(out.requestId).toBe('req-1');
    expect(out.err).toBe(err);
  });

  it('survives circular references without stack overflow', () => {
    const node: Record<string, unknown> = { requestId: 'req-1', value: 42 };
    node.self = node;
    node.nested = { parent: node };

    const out = sanitizeLogBindings(node);
    expect(out.requestId).toBe('req-1');
    expect(out.value).toBe(42);
    // self/nested get truncated at the depth cap but must not hang or throw.
    expect(JSON.stringify(out)).toBeDefined();
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

  it('stops recursion at the depth cap', () => {
    // Build an object 6 levels deep; cap (4) drops values beyond the limit.
    let node: Record<string, unknown> = { v: 'leaf' };
    for (let i = 0; i < 5; i++) {
      node = { child: node };
    }
    // top-level walks at depth=1, so we get `child` nested up to the cap
    // then drops the deepest `v`.
    const result = sanitizeLogBindings(node) as Record<string, any>;
    // Walk down until we find an undefined/missing leaf — confirms truncation.
    let cursor: any = result;
    let depth = 0;
    while (cursor && typeof cursor === 'object' && 'child' in cursor) {
      cursor = cursor.child;
      depth++;
    }
    expect(depth).toBeGreaterThan(0);
    // The leaf `{ v: 'leaf' }` is at depth 6, past the cap — so we never reach it.
    expect(cursor?.v).toBeUndefined();
  });
});

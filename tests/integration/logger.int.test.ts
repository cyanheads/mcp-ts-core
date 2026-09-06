/**
 * @fileoverview Integration tests for the Logger utility.
 * These tests validate file creation, log level handling, and rate limiting with Pino.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { Logger } from '../../src/utils/internal/logger.js';
import { fetchWithTimeout } from '../../src/utils/network/fetchWithTimeout.js';
import { withRetry } from '../../src/utils/network/retry.js';

const LOGS_DIR = path.join(process.cwd(), 'logs', 'logger-test');
const COMBINED_LOG_PATH = path.join(LOGS_DIR, 'combined.log');
const ERROR_LOG_PATH = path.join(LOGS_DIR, 'error.log');
const INTERACTIONS_LOG_PATH = path.join(LOGS_DIR, 'interactions.log');

const mockConfig = vi.hoisted(() => ({
  logsPath: '',
  logLevel: 'debug',
  environment: 'testing',
  mcpTransportType: 'stdio',
  mcpServerName: 'test-server',
  mcpServerVersion: '0.0.1',
  openTelemetry: {
    enabled: false,
    serviceName: 'test-server',
    serviceVersion: '0.0.1',
  },
}));

vi.mock('../../src/config/index.js', () => ({ config: mockConfig }));

// Override config to use a dedicated test directory
mockConfig.logsPath = LOGS_DIR;

function readJsonLog(filePath: string): any[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const content = readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

describe('Logger Integration (Pino)', () => {
  let logger: Logger;

  beforeAll(async () => {
    // Enable test logs for logger integration tests
    process.env.ENABLE_TEST_LOGS = 'true';

    // Use real timers for this test suite to avoid conflicts with setTimeout
    vi.useRealTimers();

    // Clean up old logs if they exist
    if (existsSync(LOGS_DIR)) {
      rmSync(LOGS_DIR, { recursive: true, force: true });
    }
    // We get a singleton instance, so we will reuse it. Tests should not interfere.
    logger = Logger.getInstance();
    if (!logger.isInitialized()) {
      await logger.initialize('debug');
    }
  });

  afterAll(async () => {
    await logger.close();
    // Clean up the test log directory
    if (existsSync(LOGS_DIR)) {
      rmSync(LOGS_DIR, { recursive: true, force: true });
    }
    // Cleanup environment variable
    delete process.env.ENABLE_TEST_LOGS;
  });

  it('creates all file sinks after initialization', async () => {
    // Pino opens file sinks asynchronously; observe readiness instead of assuming a startup duration.
    await expect
      .poll(() => [COMBINED_LOG_PATH, ERROR_LOG_PATH, INTERACTIONS_LOG_PATH].every(existsSync), {
        timeout: 2000,
      })
      .toBe(true);
  });

  it('writes info to the combined log and filters it from the error log', async () => {
    logger.info('This is a pino info message', {
      extra: { testId: 'pino-info-test' },
      requestId: 'test-pino-1',
      timestamp: new Date().toISOString(),
    });
    // This later record reaches both sinks, so the negative assertion follows a completed write.
    logger.error('Info filtering barrier', {
      extra: { testId: 'pino-info-barrier' },
      requestId: 'test-pino-info-barrier',
      timestamp: new Date().toISOString(),
    });
    await expect
      .poll(
        () => readJsonLog(ERROR_LOG_PATH).find((entry) => entry.testId === 'pino-info-barrier'),
        { timeout: 2000 },
      )
      .toMatchObject({ level: 50 });
    await expect
      .poll(
        () => readJsonLog(COMBINED_LOG_PATH).find((entry) => entry.testId === 'pino-info-test'),
        { timeout: 2000 },
      )
      .toMatchObject({ msg: 'This is a pino info message', level: 30 });
    expect(
      readJsonLog(ERROR_LOG_PATH).find((entry) => entry.testId === 'pino-info-test'),
    ).toBeUndefined();
  });

  it('writes an error and its serialized cause to both file sinks', async () => {
    logger.error('This is a pino error message', new Error('test error'), {
      extra: { testId: 'pino-error-test' },
      requestId: 'test-pino-2',
      timestamp: new Date().toISOString(),
    });
    for (const filePath of [COMBINED_LOG_PATH, ERROR_LOG_PATH]) {
      await expect
        .poll(() => readJsonLog(filePath).find((entry) => entry.testId === 'pino-error-test'), {
          timeout: 2000,
        })
        .toMatchObject({
          msg: 'This is a pino error message',
          level: 50,
          err: { message: 'test error' },
        });
    }
  });

  it('filters debug messages at info level while still writing info', async () => {
    logger.setLevel('info');
    try {
      logger.debug('This pino debug message should not be logged', {
        extra: { testId: 'pino-debug-test' },
        requestId: 'test-pino-3',
        timestamp: new Date().toISOString(),
      });
      logger.info('Debug filtering barrier', {
        extra: { testId: 'pino-debug-barrier' },
        requestId: 'test-pino-debug-barrier',
        timestamp: new Date().toISOString(),
      });
      await expect
        .poll(
          () =>
            readJsonLog(COMBINED_LOG_PATH).find((entry) => entry.testId === 'pino-debug-barrier'),
          { timeout: 2000 },
        )
        .toMatchObject({ level: 30 });
      expect(
        readJsonLog(COMBINED_LOG_PATH).find((entry) => entry.testId === 'pino-debug-test'),
      ).toBeUndefined();
    } finally {
      logger.setLevel('debug');
    }
  });

  it.each([
    ['emerg', 60],
    ['crit', 50],
    ['alert', 60],
    ['notice', 30],
    ['fatal', 60],
  ] as const)('maps %s to Pino level %i', async (method, level) => {
    const testId = `pino-${method}-test`;
    logger[method](`Severity mapping: ${method}`, {
      extra: { testId },
      requestId: testId,
      timestamp: new Date().toISOString(),
    });
    await expect
      .poll(() => readJsonLog(COMBINED_LOG_PATH).find((entry) => entry.testId === testId), {
        timeout: 2000,
      })
      .toMatchObject({ msg: `Severity mapping: ${method}`, level });
  });

  it('does not crash when logging a framework Context-like object (issue #32)', async () => {
    const controller = new AbortController();

    // Mirrors the shape handlers receive: requestId/timestamp plus the
    // non-serializable handles (signal, log, state) that made @pinojs/redact
    // throw on Node 25+ before the formatters.log sanitizer was added.
    const ctxLike = {
      requestId: 'ctx-like-1',
      timestamp: new Date().toISOString(),
      tenantId: 'default',
      extra: { testId: 'context-like-test' },
      signal: controller.signal,
      log: { info: () => {}, error: () => {} },
      state: { get: async () => null, set: async () => {} },
      elicit: async () => ({}),
      sample: async () => ({}),
    };

    expect(() =>
      logger.info('Context-like bindings should not crash', ctxLike as any),
    ).not.toThrow();

    await vi.waitFor(
      () => {
        const combinedLog = readJsonLog(COMBINED_LOG_PATH);
        const entry = combinedLog.find((log) => log.testId === 'context-like-test');
        expect(entry).toBeDefined();
        expect(entry.requestId).toBe('ctx-like-1');
        expect(entry.signal).toBeUndefined();
        expect(entry.elicit).toBeUndefined();
      },
      { timeout: 2000, interval: 50 },
    );
  });

  describe('network utilities + Context-like bindings (issue #32)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('fetchWithTimeout logs without crashing when context has AbortSignal', async () => {
      const controller = new AbortController();
      const ctxLike = {
        requestId: 'ftx-1',
        timestamp: new Date().toISOString(),
        tenantId: 'default',
        operation: 'fetch-regression',
        extra: { testId: 'fetch-ctx-like' },
        signal: controller.signal,
        log: { info: () => {}, error: () => {} },
        state: { get: async () => null },
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }) as Response,
      );

      const res = await fetchWithTimeout('https://example.test/data', 1000, ctxLike as any);
      expect(res.status).toBe(200);

      await vi.waitFor(
        () => {
          const entries = readJsonLog(COMBINED_LOG_PATH);
          const hit = entries.find((e) => e.testId === 'fetch-ctx-like');
          expect(hit).toBeDefined();
          expect(hit.signal).toBeUndefined();
          // Dropped outright now, not emptied: the logger projects a context
          // down to the declared RequestContext fields before writing.
          expect(hit.log).toBeUndefined();
          expect(hit.state).toBeUndefined();
          expect(hit.requestId).toBe('ftx-1');
        },
        { timeout: 2000, interval: 50 },
      );
    });

    it('withRetry logs retry attempts without crashing when context has AbortSignal', async () => {
      const controller = new AbortController();
      const ctxLike = {
        requestId: 'retry-1',
        timestamp: new Date().toISOString(),
        tenantId: 'default',
        operation: 'retry-regression',
        extra: { testId: 'retry-ctx-like' },
        signal: controller.signal,
        log: { info: () => {} },
      };

      let attempts = 0;
      const result = await withRetry(
        async () => {
          attempts++;
          if (attempts < 2) throw new Error('transient');
          return 'ok';
        },
        {
          context: ctxLike as any,
          operation: 'retry-regression',
          baseDelayMs: 1,
          maxDelayMs: 5,
          jitter: 0,
          maxRetries: 2,
        },
      );

      expect(result).toBe('ok');
      expect(attempts).toBe(2);

      await vi.waitFor(
        () => {
          const entries = readJsonLog(COMBINED_LOG_PATH);
          const hit = entries.find((e) => e.testId === 'retry-ctx-like');
          expect(hit).toBeDefined();
          expect(hit.signal).toBeUndefined();
          expect(hit.log).toBeUndefined();
          expect(hit.operation).toBe('retry-regression');
        },
        { timeout: 2000, interval: 50 },
      );
    });
  });

  describe('sanitizer + pino cross-cutting behavior', () => {
    it('still redacts sensitive fields after sanitization runs', async () => {
      logger.info('Redaction with Context-like bindings', {
        requestId: 'redact-1',
        timestamp: new Date().toISOString(),
        extra: {
          testId: 'redact-with-sanitize',
          token: 'super-secret-token',
          nested: { apiKey: 'sk-abc123' },
        },
        signal: new AbortController().signal,
        droppedTopLevelKey: 'not a RequestContext field',
      } as any);

      await vi.waitFor(
        () => {
          const entries = readJsonLog(COMBINED_LOG_PATH);
          const hit = entries.find((e) => e.testId === 'redact-with-sanitize');
          expect(hit).toBeDefined();
          expect(hit.signal).toBeUndefined();
          // Emitted through `extra`, so redaction still runs over it.
          expect(hit.token).toBe('[REDACTED]');
          expect(hit.nested.apiKey).toBe('[REDACTED]');
          // Not a declared RequestContext field — the projection drops it.
          expect(hit.droppedTopLevelKey).toBeUndefined();
        },
        { timeout: 2000, interval: 50 },
      );
    });

    it('serializes Error with cause chain via pino err serializer after sanitization', async () => {
      const root = new Error('root cause');
      const wrapped = new Error('outer failure', { cause: root });

      logger.error('Error with cause chain', wrapped, {
        requestId: 'err-cause-1',
        timestamp: new Date().toISOString(),
        extra: { testId: 'err-cause-chain' },
      });

      await vi.waitFor(
        () => {
          const entries = readJsonLog(COMBINED_LOG_PATH);
          const hit = entries.find((e) => e.testId === 'err-cause-chain');
          expect(hit).toBeDefined();
          expect(hit.err).toBeDefined();
          expect(hit.err.message).toContain('outer failure');
          // pino's err serializer threads cause messages into the message/stack.
          expect(hit.err.message + hit.err.stack).toContain('root cause');
        },
        { timeout: 2000, interval: 50 },
      );
    });
  });

  it('writes interaction events when an interaction logger is available', async () => {
    logger.logInteraction('test-interaction', {
      context: {
        extra: { testId: 'interaction-test' },
        requestId: 'interaction-1',
        timestamp: new Date().toISOString(),
      },
      payloadSize: 42,
    });

    // Use vi.waitFor with retry logic for eventual consistency
    await vi.waitFor(
      () => {
        const interactions = readJsonLog(INTERACTIONS_LOG_PATH);
        const entry = interactions.find((log) => log.interactionName === 'test-interaction');
        expect(entry).toBeDefined();
        expect(entry?.payloadSize).toBe(42);
      },
      {
        timeout: 2000, // 2 second max wait
        interval: 50, // Check every 50ms
      },
    );
  });

  it('warns when interaction logging is requested but unavailable', () => {
    const loggerWithInternals = logger as unknown as {
      interactionLogger?: unknown;
    };
    const originalInteractionLogger = loggerWithInternals.interactionLogger;
    loggerWithInternals.interactionLogger = undefined;

    const warningSpy = vi.spyOn(logger, 'warning');

    logger.logInteraction('missing-interaction', {
      context: {
        requestId: 'missing-interaction',
        timestamp: new Date().toISOString(),
      },
    });

    expect(warningSpy).toHaveBeenCalledWith(
      'Interaction logger not available.',
      expect.objectContaining({ requestId: 'missing-interaction' }),
    );

    warningSpy.mockRestore();
    loggerWithInternals.interactionLogger = originalInteractionLogger;
  });
});

describe('Logger Transport Mode Handling', () => {
  afterAll(async () => {
    // Clean up any test loggers
    const testLogger = Logger.getInstance();
    if (testLogger.isInitialized()) {
      await testLogger.close();
    }
  });

  it('writes plain JSON files when initialized with stdio transport', async () => {
    const originalEnableTestLogs = process.env.ENABLE_TEST_LOGS;
    const originalLogsPath = mockConfig.logsPath;
    const stdioLogger = Logger.getInstance();
    const stdioTestLogDir = path.join(process.cwd(), 'logs', 'stdio-test');
    const stdioTestLogPath = path.join(stdioTestLogDir, 'combined.log');
    try {
      process.env.ENABLE_TEST_LOGS = 'true';
      if (stdioLogger.isInitialized()) await stdioLogger.close();
      mockConfig.logsPath = stdioTestLogDir;
      rmSync(stdioTestLogDir, { recursive: true, force: true });
      await stdioLogger.initialize('info', 'stdio');
      stdioLogger.info('STDIO transport test message', {
        extra: { testId: 'stdio-ansi-test' },
        requestId: 'test-stdio-1',
        timestamp: new Date().toISOString(),
      });
      await expect
        .poll(
          () => readJsonLog(stdioTestLogPath).find((entry) => entry.testId === 'stdio-ansi-test'),
          { timeout: 2000 },
        )
        .toMatchObject({ msg: 'STDIO transport test message', level: 30 });
      const logContent = readFileSync(stdioTestLogPath, 'utf8');
      expect(logContent).not.toMatch(/\x1b\[\d+m/);
      expect(stdioLogger.isInitialized()).toBe(true);
    } finally {
      await stdioLogger.close();
      rmSync(stdioTestLogDir, { recursive: true, force: true });
      mockConfig.logsPath = originalLogsPath;
      if (originalEnableTestLogs === undefined) delete process.env.ENABLE_TEST_LOGS;
      else process.env.ENABLE_TEST_LOGS = originalEnableTestLogs;
    }
  });

  it('initializes with http transport', async () => {
    const httpLogger = Logger.getInstance();

    // Close any existing logger state
    if (httpLogger.isInitialized()) {
      await httpLogger.close();
    }

    // Initialize with HTTP transport mode (should allow colors in dev)
    await httpLogger.initialize('info', 'http');

    // Verify logger is initialized successfully
    expect(httpLogger.isInitialized()).toBe(true);

    // Cleanup
    await httpLogger.close();
  });
});

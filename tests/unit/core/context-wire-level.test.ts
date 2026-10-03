/**
 * @fileoverview `ctx.log`'s two sinks against the real logger's level check:
 * for every start level and every `ctx.log` method, a record reaches the wire
 * mirror exactly when it reaches the process log. Pino is mocked so the
 * process-log side is observable without transports.
 * @module tests/unit/core/context-wire-level.test
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createContext } from '@/core/context.js';
import { createContextInputs, createRequestInput } from '@/mcp-server/inputRequired.js';
import type { StorageService } from '@/storage/core/StorageService.js';
import { logger, type McpLogLevel } from '@/utils/internal/logger.js';

/** The one pino instance every `pino()` call returns. */
const pinoInstance = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  flush: vi.fn((cb: (err?: Error) => void) => cb()),
  info: vi.fn(),
  level: 'debug',
  warn: vi.fn(),
}));

vi.mock('pino', () => ({
  default: Object.assign(
    vi.fn(() => pinoInstance),
    { stdSerializers: { err: (err: Error) => ({ message: err.message }) } },
  ),
}));

vi.mock('@/config/index.js', () => ({
  config: {
    environment: 'testing',
    logRateLimitThreshold: 0,
    logRateLimitWindowMs: 60_000,
    logsPath: undefined,
    mcpServerVersion: '1.0.0-test',
  },
}));

type PinoMethod = 'debug' | 'error' | 'fatal' | 'info' | 'warn';

/** The `ctx.log` methods and the pino method the process log writes each through. */
const METHODS = [
  ['debug', 'debug'],
  ['info', 'info'],
  ['notice', 'info'],
  ['warning', 'warn'],
  ['error', 'error'],
] as const satisfies ReadonlyArray<readonly [McpLogLevel, PinoMethod]>;

const FLOORS = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'crit',
  'alert',
  'emerg',
] as const satisfies readonly McpLogLevel[];

/** A context on the real logger whose wire mirror records each record it is handed. */
function buildWireCtx() {
  const wireLog = vi.fn(async (_level: string, _data: unknown) => {});
  const ctx = createContext({
    appContext: { requestId: 'req-floor', timestamp: '2026-10-03T00:00:00.000Z' },
    defaultTenantId: 'default',
    inputs: createContextInputs(undefined, undefined),
    logger,
    requestInput: createRequestInput(),
    signal: new AbortController().signal,
    storage: {} as StorageService,
    wireLog,
  });
  return { ctx, wireLog };
}

describe('ctx.log wire mirror follows the process log level check', () => {
  afterEach(async () => {
    if (logger.isInitialized()) await logger.close();
  });

  it.each(FLOORS)(
    'at a %s start level, mirrors exactly what the process log writes',
    async (floor) => {
      await logger.initialize(floor);
      for (const [, pinoMethod] of METHODS) pinoInstance[pinoMethod].mockClear();
      const { ctx, wireLog } = buildWireCtx();

      for (const [method] of METHODS) ctx.log[method](`${floor} floor: ${method}`);

      const processLogged = METHODS.filter(([method, pinoMethod]) =>
        pinoInstance[pinoMethod].mock.calls.some(([, msg]) => msg === `${floor} floor: ${method}`),
      ).map(([method]) => method);
      const mirrored = wireLog.mock.calls.map(([level]) => level);

      expect(mirrored).toEqual(processLogged);
      expect(mirrored).toEqual(
        METHODS.map(([method]) => method).filter(logger.isLevelEnabled, logger),
      );
    },
  );

  it('mirrors a level again once setLevel() lowers the floor at runtime', async () => {
    await logger.initialize('info');
    const { ctx, wireLog } = buildWireCtx();

    ctx.log.debug('before setLevel');
    logger.setLevel('debug');
    ctx.log.debug('after setLevel');

    expect(wireLog.mock.calls).toEqual([['debug', { message: 'after setLevel' }]]);
  });

  it('mirrors every level, payload unchanged, at the default debug level', async () => {
    await logger.initialize('debug');
    const { ctx, wireLog } = buildWireCtx();

    ctx.log.debug('d', { step: 1 });
    ctx.log.info('i', { step: 2 });
    ctx.log.notice('n', { step: 3 });
    ctx.log.warning('w', { step: 4 });
    ctx.log.error('e', new Error('boom'), { step: 5 });

    expect(wireLog.mock.calls).toEqual([
      ['debug', { message: 'd', step: 1 }],
      ['info', { message: 'i', step: 2 }],
      ['notice', { message: 'n', step: 3 }],
      ['warning', { message: 'w', step: 4 }],
      ['error', { message: 'e', step: 5, error: 'boom' }],
    ]);
  });
});

/**
 * @fileoverview Unit tests for the output targets the logger builds per
 * environment and transport. In stdio mode stdout carries the JSON-RPC stream,
 * so no environment may point a log target at it; colored pretty output is for
 * an HTTP server in development only. Each case reads the `transport.targets`
 * the logger hands to pino.
 * @module tests/unit/utils/internal/logger.transports
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConfig, pinoFactory } = vi.hoisted(() => {
  const instance = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    flush: vi.fn((cb: (err?: Error) => void) => cb()),
    info: vi.fn(),
    level: 'info',
    warn: vi.fn(),
  };
  return {
    mockConfig: {
      environment: 'development',
      logRateLimitThreshold: 0,
      logRateLimitWindowMs: 60_000,
      logsPath: undefined as string | undefined,
      mcpServerVersion: '1.0.0-test',
    },
    pinoFactory: vi.fn((_options: unknown) => instance),
  };
});

vi.mock('pino', () => {
  const pino = Object.assign(pinoFactory, {
    stdSerializers: { err: (err: Error) => ({ message: err.message }) },
  });
  return { default: pino };
});

vi.mock('@/config/index.js', () => ({ config: mockConfig }));

interface Target {
  level: string;
  options: Record<string, unknown>;
  target: string;
}

/** The stderr target every non-pretty, non-test configuration writes to. */
const STDERR_TARGET: Target = { level: 'debug', target: 'pino/file', options: { destination: 2 } };

/** Initializes a fresh logger and returns the transport targets it gave pino. */
async function targetsFor(environment: string, transportType: 'stdio' | 'http'): Promise<Target[]> {
  mockConfig.environment = environment;
  vi.resetModules();
  const { Logger } = await import('@/utils/internal/logger.js');
  const logger = Logger.getInstance();
  await logger.initialize('info', transportType);
  await logger.close();

  const options = pinoFactory.mock.calls[0]?.[0] as { transport: { targets: Target[] } };
  return options.transport.targets;
}

beforeEach(() => {
  pinoFactory.mockClear();
  vi.stubEnv('IS_SERVERLESS', '');
  vi.stubEnv('NO_COLOR', '');
  vi.stubEnv('FORCE_COLOR', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('logger output targets', () => {
  it('writes stdio-mode records to stderr alone in development', async () => {
    expect(await targetsFor('development', 'stdio')).toEqual([STDERR_TARGET]);
  });

  it('writes colored pretty output for an HTTP server in development', async () => {
    const targets = await targetsFor('development', 'http');

    expect(targets).toHaveLength(1);
    expect(targets[0]?.target).toContain('pino-pretty');
    expect(targets[0]?.options).toMatchObject({ colorize: true });
  });

  it.each([
    ['NO_COLOR', '1'],
    ['FORCE_COLOR', '0'],
  ])('writes plain stderr for an HTTP server in development when %s=%s', async (name, value) => {
    vi.stubEnv(name, value);

    expect(await targetsFor('development', 'http')).toEqual([STDERR_TARGET]);
  });

  it.each(['stdio', 'http'] as const)(
    'writes %s-mode records to stderr in production',
    async (transport) => {
      expect(await targetsFor('production', transport)).toEqual([STDERR_TARGET]);
    },
  );
});

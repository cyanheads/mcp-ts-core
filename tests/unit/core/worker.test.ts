/**
 * @fileoverview Cloudflare Worker entry: the core env bindings measured against
 * what the config parser reads, and the initialization-failure path, which
 * fails in the `instructions` callback before any Workers API runs. Real runtime
 * behavior lives in `tests/worker/`; the factory's export shape and the closed
 * `CloudflareBindings` interface are typechecked in
 * `tests/types/worker-handler.test-d.ts`.
 * @module tests/unit/core/worker.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '@/config/index.js';
import { createWorkerHandler } from '@/core/worker.js';
import { CORE_ENV_BINDINGS, EXCLUDED_ENV_NAMES } from '@/core/workerEnvBindings.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

/** While `names` is set, every variable `parseConfig` reads from its normalized env is recorded. */
const envReads = vi.hoisted(() => ({ names: undefined as Set<string> | undefined }));

vi.mock('@/config/envValue.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/envValue.js')>();
  return {
    ...actual,
    normalizeEnv: (env: Record<string, string | undefined>) => {
      const normalized = actual.normalizeEnv(env);
      const names = envReads.names;
      if (!names) return normalized;
      return new Proxy(normalized, {
        get(target, name, receiver) {
          if (typeof name === 'string') names.add(name);
          return Reflect.get(target, name, receiver);
        },
      });
    },
  };
});

describe('the Worker core env bindings (#837)', () => {
  /** Every variable `parseConfig` reads, with the conditional Supabase and speech reads switched on. */
  function variablesTheParserReads(): Set<string> {
    const names = new Set<string>();
    envReads.names = names;
    try {
      parseConfig({
        SUPABASE_URL: 'https://project.supabase.co',
        SPEECH_TTS_ENABLED: 'true',
        SPEECH_STT_ENABLED: 'true',
        // Unset, so the OTLP base endpoint is read too.
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: undefined,
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: undefined,
      });
    } finally {
      envReads.names = undefined;
    }
    return names;
  }

  it('injects or excludes, with a reason, every variable the parser reads, and names nothing it does not read', () => {
    const read = variablesTheParserReads();
    const injected = new Set(CORE_ENV_BINDINGS.map(([, processEnvKey]) => processEnvKey));
    const excluded = new Set(Object.keys(EXCLUDED_ENV_NAMES));

    expect(read).toContain('MCP_JWT_EXPECTED_AUDIENCE');
    expect(read).toContain('SPEECH_STT_TIMEOUT');
    expect(read).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    expect([...read].filter((name) => !injected.has(name) && !excluded.has(name))).toEqual([]);
    expect([...injected].filter((name) => excluded.has(name))).toEqual([]);
    expect([...injected].filter((name) => !read.has(name))).toEqual([]);
    expect([...excluded].filter((name) => !read.has(name))).toEqual([]);
    for (const [name, reason] of Object.entries(EXCLUDED_ENV_NAMES)) {
      expect(reason, name).toMatch(/\S/);
    }
  });

  it('keeps the ENVIRONMENT and LOG_LEVEL renames and leaves the transport to the Worker', () => {
    expect(CORE_ENV_BINDINGS).toContainEqual(['ENVIRONMENT', 'NODE_ENV']);
    expect(CORE_ENV_BINDINGS).toContainEqual(['LOG_LEVEL', 'MCP_LOG_LEVEL']);
    const targets = CORE_ENV_BINDINGS.map(([, processEnvKey]) => processEnvKey);
    expect(targets.filter((name) => name === 'NODE_ENV' || name === 'MCP_LOG_LEVEL')).toHaveLength(
      2,
    );
    expect(targets).not.toContain('MCP_TRANSPORT_TYPE');
  });

  it('feeds OTEL_SERVICE_NAME and OTEL_SERVICE_VERSION, which name the tracer and meter scope of every framework span', () => {
    for (const name of ['OTEL_SERVICE_NAME', 'OTEL_SERVICE_VERSION']) {
      expect(CORE_ENV_BINDINGS).toContainEqual([name, name]);
      expect(EXCLUDED_ENV_NAMES).not.toHaveProperty(name);
    }
  });
});

describe('a failed initialization (#697)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** `error` with an own `key` whose read throws. */
  function unreadable<E extends Error>(error: E, key: string): E {
    return Object.defineProperty(error, key, {
      configurable: true,
      get() {
        throw new Error(`${key} getter`);
      },
    });
  }

  /** A revoked Proxy: every operation on it, `instanceof` included, throws. */
  function revoked(): object {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return proxy;
  }

  it.each([
    ['a readable Error', () => new Error('boom'), true, 'boom', expect.stringContaining('boom')],
    [
      'an Error whose stack getter throws',
      () => unreadable(new Error('boom'), 'stack'),
      true,
      'boom',
      '[Unreadable]',
    ],
    [
      'an Error whose message getter throws',
      () => unreadable(new Error('boom'), 'message'),
      true,
      '[Unreadable]',
      expect.any(String),
    ],
    [
      'a null-prototype object',
      () => Object.create(null) as object,
      false,
      '[Unreadable]',
      undefined,
    ],
    ['a revoked Proxy', revoked, false, '[Unreadable]', undefined],
  ])(
    'logs %s at crit, answers 500, and initializes again on the next request',
    async (_label, make, isError, message, stack) => {
      // Initialization writes both; restored by `unstubAllEnvs`.
      vi.stubEnv('IS_SERVERLESS', undefined);
      vi.stubEnv('MCP_TRANSPORT_TYPE', undefined);
      const crit = vi.spyOn(logger, 'crit').mockImplementation(() => {});
      const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const thrown: unknown[] = [];
      const handler = createWorkerHandler({
        instructions: () => {
          const value = make();
          thrown.push(value);
          throw value;
        },
      });
      const fetchHealth = () =>
        handler.fetch(new Request('https://example.com/healthz'), {}, {} as never);

      const statuses = [(await fetchHealth()).status, (await fetchHealth()).status];

      expect(statuses).toEqual([500, 500]);
      // A second request runs initialization again rather than replaying the first failure.
      expect(thrown).toHaveLength(2);
      expect(crit).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledTimes(2);
      for (const [i, [critCall, errorCall]] of [
        [crit.mock.calls[0], error.mock.calls[0]],
        [crit.mock.calls[1], error.mock.calls[1]],
      ].entries()) {
        const [critMessage, critError, critContext] = critCall as unknown as [
          string,
          Error,
          RequestContext,
        ];
        expect(critMessage).toBe('Failed to initialize Cloudflare Worker.');
        expect(critContext.extra).toEqual(
          expect.objectContaining({ error: message, stack, isServerless: true }),
        );
        const [errorMessage, fetchError] = errorCall as unknown as [string, Error];
        expect(errorMessage).toBe('Worker fetch handler error.');
        if (isError) {
          // `Object.is`, not `toBe`: printing an unreadable Error on a mismatch throws.
          expect(Object.is(critError, thrown[i])).toBe(true);
          expect(Object.is(fetchError, thrown[i])).toBe(true);
        } else {
          expect(critError).toEqual(new Error('[Unreadable]'));
          expect(fetchError).toEqual(new Error('[Unreadable]'));
        }
      }
    },
  );
});

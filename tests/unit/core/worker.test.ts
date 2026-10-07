/**
 * @fileoverview Cloudflare Worker entry: the initialization-failure path, which
 * fails in the `instructions` callback before any Workers API runs. Real runtime
 * behavior lives in `tests/worker/`; the factory's export shape and the closed
 * `CloudflareBindings` interface are typechecked in
 * `tests/types/worker-handler.test-d.ts`.
 * @module tests/unit/core/worker.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkerHandler } from '@/core/worker.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

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

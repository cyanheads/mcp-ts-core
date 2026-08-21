/**
 * @fileoverview Worker-runtime coverage for `Logger.close()` (#342).
 *
 * Under workerd the pino instance the logger builds never calls its `flush`
 * callback, so an unbounded await on it hangs every shutdown path that reaches
 * it. These tests pin the guarantee the framework makes instead: `close()`
 * settles within a bounded drain window on every supported runtime, and stays
 * safe when called again.
 * @module tests/worker/logger-shutdown.worker.test
 */

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { logger } from '@/utils/internal/logger.js';
import worker from '../fixtures/worker-runtime.fixture.js';

/**
 * Well clear of the framework's own drain bound, so a pass means the logger
 * bounded itself rather than the test being generous.
 */
const CLOSE_BOUND_MS = 8_000;

/** Races `work` against a timer so a hang reports as a failed assertion. */
async function outcomeWithin(work: Promise<unknown>, ms: number): Promise<'settled' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  const outcome = await Promise.race([work.then((): 'settled' => 'settled'), timeout]);
  clearTimeout(timer);
  return outcome;
}

/** Drives one request through the worker, which initializes the logger. */
async function initializeLoggerThroughAFetch(): Promise<void> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('http://example.com/healthz'), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(200);
}

describe('Logger.close() in the Workers runtime', () => {
  it('settles within a bounded window once the logger is initialized', async () => {
    await initializeLoggerThroughAFetch();
    expect(logger.isInitialized()).toBe(true);

    await expect(outcomeWithin(logger.close(), CLOSE_BOUND_MS)).resolves.toBe('settled');
    expect(logger.isInitialized()).toBe(false);
  });

  it('stays safe when called again after the bounded close', async () => {
    await initializeLoggerThroughAFetch();

    await expect(outcomeWithin(logger.close(), CLOSE_BOUND_MS)).resolves.toBe('settled');
    await expect(outcomeWithin(logger.close(), CLOSE_BOUND_MS)).resolves.toBe('settled');
    expect(logger.isInitialized()).toBe(false);
  });
});

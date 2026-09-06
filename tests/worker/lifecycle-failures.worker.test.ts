/**
 * @fileoverview Worker initialization defaults, scheduled failure recovery, and request correlation.
 * @module tests/worker/lifecycle-failures.worker.test
 */
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { resetConfig } from '@/config/index.js';
import { createWorkerHandler } from '@/core/worker.js';
import { logger } from '@/utils/internal/logger.js';
import { createWorkerLifecycleTestHandler } from '../fixtures/worker-runtime.fixture.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetConfig();
});

it('serves the default handler with no optional bindings or definitions', async () => {
  vi.stubEnv('STORAGE_PROVIDER_TYPE', undefined);
  resetConfig();
  const worker = createWorkerHandler();
  const info = vi.spyOn(logger, 'info');
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('https://example.com/healthz'), {}, ctx);
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ status: 'ok' });
  expect(info).toHaveBeenCalledWith(
    'Cloudflare Worker initializing...',
    expect.objectContaining({
      extra: expect.objectContaining({ environment: 'production', storageProvider: 'in-memory' }),
    }),
  );
});

it('retries initialization after a scheduled event fails before the callback', async () => {
  const control = { setupCalls: 0, setupFailures: ['setup failed'], scheduledCalls: 0 };
  const worker = createWorkerLifecycleTestHandler(control);
  const controller = createScheduledController({ cron: '* * * * *' });
  const first = createExecutionContext();
  await expect(worker.scheduled(controller, env, first)).rejects.toBe('setup failed');
  await waitOnExecutionContext(first);
  expect(control.scheduledCalls).toBe(0);
  const retry = createExecutionContext();
  await worker.scheduled(controller, env, retry);
  await waitOnExecutionContext(retry);
  expect(control.setupCalls).toBe(2);
  expect(control.scheduledCalls).toBe(1);
});

it('preserves cf-ray and geographic context on success and cf-ray on failure', async () => {
  const debug = vi.spyOn(logger, 'debug');
  const error = vi.spyOn(logger, 'error');
  const request = new Request('https://example.com/healthz', {
    headers: { 'cf-ray': 'test-ray' },
    cf: { colo: 'SEA', country: 'US', city: 'Seattle' },
  });
  const worker = createWorkerLifecycleTestHandler({ setupCalls: 0 });
  const ctx = createExecutionContext();
  expect((await worker.fetch(request, env, ctx)).status).toBe(200);
  await waitOnExecutionContext(ctx);
  expect(debug).toHaveBeenCalledWith(
    'Processing Worker fetch request.',
    expect.objectContaining({
      requestId: 'test-ray',
      extra: expect.objectContaining({ colo: 'SEA', country: 'US', city: 'Seattle' }),
    }),
  );
  const failed = createWorkerLifecycleTestHandler({
    setupCalls: 0,
    setupFailures: [new Error('private failure')],
  });
  const failedCtx = createExecutionContext();
  expect((await failed.fetch(request, env, failedCtx)).status).toBe(500);
  await waitOnExecutionContext(failedCtx);
  expect(error).toHaveBeenCalledWith(
    'Worker fetch handler error.',
    expect.any(Error),
    expect.objectContaining({ requestId: 'test-ray' }),
  );
});

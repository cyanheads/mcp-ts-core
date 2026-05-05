/**
 * @fileoverview Worker-runtime tests for createWorkerHandler.
 * @module tests/worker/create-worker-handler.worker.test
 */

import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../fixtures/worker-runtime.fixture.js';

declare global {
  namespace Cloudflare {
    interface Env {
      CUSTOM_API_KEY: string;
      CUSTOM_KV: KVNamespace;
      ENVIRONMENT: string;
      KV_NAMESPACE: KVNamespace;
      LOG_LEVEL: string;
      MCP_ALLOWED_ORIGINS: string;
      STORAGE_PROVIDER_TYPE: string;
    }
  }
}

const runtimeGlobal = globalThis as typeof globalThis & {
  CUSTOM_KV_GLOBAL?: KVNamespace;
  __WORKER_RUNTIME_PROBE__?: {
    customApiKey: string | undefined;
    hasCustomKv: boolean;
    storageProvider: string | undefined;
  };
  __WORKER_SCHEDULED_PROBE__?: {
    cron: string;
    customApiKey: string | undefined;
    hasCustomKv: boolean;
    scheduledTime: number;
  };
};

describe('createWorkerHandler in the Workers runtime', () => {
  it('serves HTTP requests and injects string/object bindings', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('http://example.com/healthz'), env, ctx);
    await waitOnExecutionContext(ctx);

    await expect(response.json()).resolves.toEqual({ status: 'ok' });
    expect(runtimeGlobal.__WORKER_RUNTIME_PROBE__).toEqual({
      customApiKey: 'worker-secret',
      hasCustomKv: true,
      storageProvider: 'cloudflare-kv',
    });
    expect(runtimeGlobal.CUSTOM_KV_GLOBAL).toBe(env.CUSTOM_KV);
  });

  it('enforces the Worker HTTP origin guard', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request('http://example.com/mcp', {
        headers: { Origin: 'https://evil.example' },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid origin. DNS rebinding protection.',
    });
  });

  it('runs scheduled handlers after Worker initialization', async () => {
    const ctx = createExecutionContext();
    const controller = createScheduledController({
      cron: '*/5 * * * *',
      scheduledTime: 1_798_800_000_000,
    });

    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(runtimeGlobal.__WORKER_SCHEDULED_PROBE__).toEqual({
      cron: '*/5 * * * *',
      customApiKey: 'worker-secret',
      hasCustomKv: true,
      scheduledTime: 1_798_800_000_000,
    });
  });
});

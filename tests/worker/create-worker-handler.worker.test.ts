/**
 * @fileoverview Worker-runtime tests for createWorkerHandler.
 * Covers binding injection, origin guard, scheduled handler, end-to-end MCP
 * JSON-RPC (initialize → tools/list → tools/call), and runtime detection
 * (`runtimeCaps.isWorkerLike === true` under `nodejs_compat`).
 * @module tests/worker/create-worker-handler.worker.test
 */

import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/utils/internal/logger.js';
import worker, {
  createWorkerLifecycleTestHandler,
  getWorkerLifecycleObjectBinding,
  getWorkerLoggerLevel,
  resetWorkerLogger,
  type WorkerLifecycleTestBindings,
  type WorkerLifecycleTestControl,
} from '../fixtures/worker-runtime.fixture.js';

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
    isNode: boolean;
    isWorkerLike: boolean;
    storageProvider: string | undefined;
  };
  __WORKER_SCHEDULED_PROBE__?: {
    cron: string;
    customApiKey: string | undefined;
    hasCustomKv: boolean;
    scheduledTime: number;
  };
};

const MCP_HEADERS = {
  Accept: 'application/json, text/event-stream',
  'Content-Type': 'application/json',
  Origin: 'http://example.com',
} as const;

function jsonrpc(id: number, method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

function initializeBody(id = 1): string {
  return jsonrpc(id, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'worker-runtime-test', version: '0.0.0' },
  });
}

function lifecycleEnv(
  overrides: Partial<WorkerLifecycleTestBindings> = {},
): WorkerLifecycleTestBindings {
  return { ...env, ...overrides };
}

function requestWithLoggedUrl(loggedUrl: string): Request {
  const request = new Request('https://example.com/healthz');
  Object.defineProperty(request, 'url', { configurable: true, value: loggedUrl });
  return request;
}

/** Parses SSE event frames into their JSON `data:` payloads. */
function parseSseDataFrames(body: string): unknown[] {
  return body
    .split('\n\n')
    .filter(Boolean)
    .flatMap((block) => {
      const dataLines = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      if (dataLines.length === 0) return [];
      return [JSON.parse(dataLines.join('\n'))];
    });
}

describe('createWorkerHandler in the Workers runtime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TEST_BLANK_TARGET;
  });

  describe('lifecycle', () => {
    it('falls back to info for an invalid log-level binding', async () => {
      await resetWorkerLogger();
      const control: WorkerLifecycleTestControl = { setupCalls: 0 };
      const lifecycleWorker = createWorkerLifecycleTestHandler(control);
      const ctx = createExecutionContext();

      const response = await lifecycleWorker.fetch(
        new Request('http://example.com/healthz'),
        lifecycleEnv({ LOG_LEVEL: 'definitely-not-a-level' }),
        ctx,
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(getWorkerLoggerLevel()).toBe('info');
      expect(control.setupCalls).toBe(1);
    });

    it('shares one initialization promise across concurrent first requests', async () => {
      let releaseInitialization!: () => void;
      const initializationGate = new Promise<void>((resolve) => {
        releaseInitialization = resolve;
      });
      const control: WorkerLifecycleTestControl = { initializationGate, setupCalls: 0 };
      const lifecycleWorker = createWorkerLifecycleTestHandler(control);
      const firstCtx = createExecutionContext();
      const secondCtx = createExecutionContext();

      const first = lifecycleWorker.fetch(
        new Request('http://example.com/healthz'),
        lifecycleEnv(),
        firstCtx,
      );
      const second = lifecycleWorker.fetch(
        new Request('http://example.com/healthz'),
        lifecycleEnv(),
        secondCtx,
      );
      await vi.waitFor(() => expect(control.setupCalls).toBe(1));
      releaseInitialization();

      const responses = await Promise.all([first, second]);
      await Promise.all([waitOnExecutionContext(firstCtx), waitOnExecutionContext(secondCtx)]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(control.setupCalls).toBe(1);
    });

    it('returns a sanitized 500 for first-init failure and retries initialization', async () => {
      const control: WorkerLifecycleTestControl = {
        setupCalls: 0,
        setupFailures: [new Error('private initialization detail')],
      };
      const lifecycleWorker = createWorkerLifecycleTestHandler(control);

      const firstResponse = await lifecycleWorker.fetch(
        new Request('http://example.com/healthz'),
        lifecycleEnv(),
        createExecutionContext(),
      );
      const firstBody = await firstResponse.text();
      expect(firstResponse.status).toBe(500);
      expect(JSON.parse(firstBody)).toEqual({
        error: 'Internal Server Error',
        message: 'An internal error occurred.',
      });
      expect(firstBody).not.toContain('private initialization detail');
      expect(control.setupCalls).toBe(1);

      const retryResponse = await lifecycleWorker.fetch(
        new Request('http://example.com/healthz'),
        lifecycleEnv(),
        createExecutionContext(),
      );
      expect(retryResponse.status).toBe(200);
      expect(control.setupCalls).toBe(2);
    });

    it('sanitizes non-Error initialization failures', async () => {
      const control: WorkerLifecycleTestControl = {
        setupCalls: 0,
        setupFailures: ['non-error private initialization detail'],
      };
      const lifecycleWorker = createWorkerLifecycleTestHandler(control);

      const response = await lifecycleWorker.fetch(
        new Request('http://example.com/healthz'),
        lifecycleEnv(),
        createExecutionContext(),
      );
      const body = await response.text();

      expect(response.status).toBe(500);
      expect(JSON.parse(body)).toEqual({
        error: 'Internal Server Error',
        message: 'An internal error occurred.',
      });
      expect(body).not.toContain('non-error private initialization detail');
    });

    it('ignores blank string bindings and refreshes object bindings on every invocation', async () => {
      process.env.TEST_BLANK_TARGET = 'preserved-value';
      const control: WorkerLifecycleTestControl = { setupCalls: 0 };
      const lifecycleWorker = createWorkerLifecycleTestHandler(control);
      const firstObject = { invocation: 1 };
      const secondObject = { invocation: 2 };

      const firstResponse = await lifecycleWorker.fetch(
        new Request('http://example.com/healthz'),
        lifecycleEnv({ TEST_BLANK_BINDING: '   ', TEST_OBJECT_BINDING: firstObject }),
        createExecutionContext(),
      );
      expect(firstResponse.status).toBe(200);
      expect(control.blankBindingAtSetup).toBe('preserved-value');
      expect(getWorkerLifecycleObjectBinding()).toBe(firstObject);

      const secondResponse = await lifecycleWorker.fetch(
        new Request('http://example.com/healthz'),
        lifecycleEnv({ TEST_BLANK_BINDING: '', TEST_OBJECT_BINDING: secondObject }),
        createExecutionContext(),
      );
      expect(secondResponse.status).toBe(200);
      expect(getWorkerLifecycleObjectBinding()).toBe(secondObject);
      expect(control.setupCalls).toBe(1);
    });

    it('propagates scheduled callback rejection to the runtime', async () => {
      const scheduledFailure = new Error('scheduled callback failed');
      const control: WorkerLifecycleTestControl = { scheduledFailure, setupCalls: 0 };
      const lifecycleWorker = createWorkerLifecycleTestHandler(control);
      const controller = createScheduledController({ cron: '0 * * * *' });

      await expect(
        lifecycleWorker.scheduled(controller, lifecycleEnv(), createExecutionContext()),
      ).rejects.toBe(scheduledFailure);
      expect(control.scheduledCalls).toBe(1);
    });

    it('completes scheduled events when no callback is configured', async () => {
      const control: WorkerLifecycleTestControl = {
        installScheduledCallback: false,
        setupCalls: 0,
      };
      const lifecycleWorker = createWorkerLifecycleTestHandler(control);
      const controller = createScheduledController({ cron: '0 0 * * *' });

      await expect(
        lifecycleWorker.scheduled(controller, lifecycleEnv(), createExecutionContext()),
      ).resolves.toBeUndefined();
      expect(control.setupCalls).toBe(1);
      expect(control.scheduledCalls).toBeUndefined();
    });
  });

  describe('request URL log boundary', () => {
    const loggedUrl =
      'https://userinfo-secret:password-secret@example.com/healthz?token=query-secret#fragment-secret';

    it('redacts success-log URL credentials, query, and fragment', async () => {
      const debugSpy = vi.spyOn(logger, 'debug');
      const lifecycleWorker = createWorkerLifecycleTestHandler({ setupCalls: 0 });

      const response = await lifecycleWorker.fetch(
        requestWithLoggedUrl(loggedUrl),
        lifecycleEnv(),
        createExecutionContext(),
      );

      expect(response.status).toBe(200);
      const context = debugSpy.mock.calls.find(
        ([message]) => message === 'Processing Worker fetch request.',
      )?.[1];
      expect(context).toMatchObject({
        url: 'https://example.com/healthz',
        queryPresent: true,
      });
      expect(JSON.stringify(context)).not.toMatch(
        /userinfo-secret|password-secret|query-secret|fragment-secret/,
      );
    });

    it('redacts error-log URL credentials, query, and fragment', async () => {
      const errorSpy = vi.spyOn(logger, 'error');
      const lifecycleWorker = createWorkerLifecycleTestHandler({
        setupCalls: 0,
        setupFailures: [new Error('initialize failed')],
      });

      const response = await lifecycleWorker.fetch(
        requestWithLoggedUrl(loggedUrl),
        lifecycleEnv(),
        createExecutionContext(),
      );

      expect(response.status).toBe(500);
      const context = errorSpy.mock.calls.find(
        ([message]) => message === 'Worker fetch handler error.',
      )?.[2];
      expect(context).toMatchObject({
        url: 'https://example.com/healthz',
        queryPresent: true,
      });
      expect(JSON.stringify(context)).not.toMatch(
        /userinfo-secret|password-secret|query-secret|fragment-secret/,
      );
    });
  });

  it('serves HTTP requests and injects string/object bindings', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('http://example.com/healthz'), env, ctx);
    await waitOnExecutionContext(ctx);

    await expect(response.json()).resolves.toEqual({ status: 'ok' });
    expect(runtimeGlobal.__WORKER_RUNTIME_PROBE__).toMatchObject({
      customApiKey: 'worker-secret',
      hasCustomKv: true,
      storageProvider: 'cloudflare-kv',
    });
    expect(runtimeGlobal.CUSTOM_KV_GLOBAL).toBe(env.CUSTOM_KV);
  });

  it('detects the Worker runtime even under nodejs_compat', async () => {
    const ctx = createExecutionContext();
    await worker.fetch(new Request('http://example.com/healthz'), env, ctx);
    await waitOnExecutionContext(ctx);

    // The bug fixed in 0.9.0: under `nodejs_compat`, `process.versions.node` is
    // a string, so the old `isWorkerLike = !isNode && hasWorkerGlobalScope()`
    // always evaluated false. Detection now uses navigator.userAgent.
    const probe = runtimeGlobal.__WORKER_RUNTIME_PROBE__;
    expect(probe?.isWorkerLike).toBe(true);
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

  describe('MCP JSON-RPC', () => {
    it('handles initialize → tools/list → tools/call end-to-end', async () => {
      const ctx = createExecutionContext();

      // 1. Initialize
      const initResponse = await worker.fetch(
        new Request('http://example.com/mcp', {
          method: 'POST',
          headers: MCP_HEADERS,
          body: initializeBody(1),
        }),
        env,
        ctx,
      );
      expect(initResponse.status).toBe(200);
      const sessionId = initResponse.headers.get('Mcp-Session-Id');
      expect(sessionId).toBeTruthy();

      const initText = await initResponse.text();
      const initFrames = parseSseDataFrames(initText);
      expect(initFrames).toHaveLength(1);
      expect(initFrames[0]).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: expect.any(String),
          serverInfo: expect.objectContaining({ name: 'worker-runtime-fixture' }),
          // Verifies #91: `instructions: (env) => string` resolver fires at
          // request time and the resolved string is included on the response.
          instructions: expect.stringContaining('worker-runtime-fixture orientation'),
        },
      });

      // 2. notifications/initialized (no response body for notifications)
      await worker.fetch(
        new Request('http://example.com/mcp', {
          method: 'POST',
          headers: { ...MCP_HEADERS, 'Mcp-Session-Id': sessionId! },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        }),
        env,
        ctx,
      );

      // 3. tools/list
      const listResponse = await worker.fetch(
        new Request('http://example.com/mcp', {
          method: 'POST',
          headers: { ...MCP_HEADERS, 'Mcp-Session-Id': sessionId! },
          body: jsonrpc(2, 'tools/list', {}),
        }),
        env,
        ctx,
      );
      expect(listResponse.status).toBe(200);
      const listFrames = parseSseDataFrames(await listResponse.text());
      const listResult = listFrames[0] as { result: { tools: Array<{ name: string }> } };
      expect(listResult.result.tools.map((t) => t.name)).toContain('echo');

      // 4. tools/call
      const callResponse = await worker.fetch(
        new Request('http://example.com/mcp', {
          method: 'POST',
          headers: { ...MCP_HEADERS, 'Mcp-Session-Id': sessionId! },
          body: jsonrpc(3, 'tools/call', {
            name: 'echo',
            arguments: { message: 'hello from worker' },
          }),
        }),
        env,
        ctx,
      );
      expect(callResponse.status).toBe(200);
      const callFrames = parseSseDataFrames(await callResponse.text());
      const callResult = callFrames[0] as {
        result: {
          content: Array<{ type: string; text: string }>;
          structuredContent: { echoed: string };
        };
      };
      expect(callResult.result.structuredContent).toEqual({ echoed: 'hello from worker' });
      expect(callResult.result.content[0]).toEqual({
        type: 'text',
        text: 'hello from worker',
      });

      await waitOnExecutionContext(ctx);
    });
  });
});

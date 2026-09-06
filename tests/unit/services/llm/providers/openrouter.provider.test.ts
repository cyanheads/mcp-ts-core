/**
 * @fileoverview OpenRouter contracts exercised through the real OpenAI SDK and a strict fetch fake.
 * @module tests/unit/services/llm/providers/openrouter.provider.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '@/config/index.js';
import { OpenRouterProvider } from '@/services/llm/providers/openrouter.provider.js';
import { createFetchMock, type FetchMockHarness } from '@/testing/index.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { RateLimiter } from '@/utils/security/rateLimiter.js';

const settings = {
  ...config,
  openrouterApiKey: 'test-api-key',
  openrouterAppUrl: 'https://example.test',
  openrouterAppName: 'Contract test',
  llmDefaultModel: 'test/default',
  llmDefaultTemperature: 0.8,
  llmDefaultTopP: 0.95,
  llmDefaultMaxTokens: 2000,
  llmDefaultTopK: 10,
  llmDefaultMinP: 0.1,
  logLlmInteractions: false,
};
const context = {
  requestId: 'llm-contract',
  timestamp: '2026-09-04T00:00:00Z',
  tenantId: 'tenant-a',
};
const params = { model: 'test/model', messages: [{ role: 'user' as const, content: 'hello' }] };
const completion = {
  id: 'completion-1',
  object: 'chat.completion',
  created: 1,
  model: 'test/model',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'response', refusal: null },
      finish_reason: 'stop',
      logprobs: null,
    },
  ],
};
const endpoint = 'https://openrouter.ai/api/v1/chat/completions';

let fetchMock: FetchMockHarness;
let limiter: RateLimiter;
let provider: OpenRouterProvider;
beforeEach(() => {
  fetchMock = createFetchMock();
  fetchMock.install();
  limiter = new RateLimiter(settings, logger);
  provider = new OpenRouterProvider(limiter, settings, logger);
});
afterEach(async () => {
  await Promise.all(
    fetchMock.calls.map(({ request }) => (request.bodyUsed ? undefined : request.arrayBuffer())),
  );
  fetchMock.restore();
  limiter.dispose();
  vi.restoreAllMocks();
});

describe('OpenRouter request boundary', () => {
  it('rejects a missing API key without making a request', () => {
    expect(
      () => new OpenRouterProvider(limiter, { ...settings, openrouterApiKey: '' }, logger),
    ).toThrow('API key is not configured');
    expect(fetchMock.calls).toEqual([]);
  });

  it('sends the configured endpoint, identity headers, and generation defaults', async () => {
    fetchMock.route({ match: endpoint, respond: Response.json(completion) });
    // @ts-expect-error JavaScript callers may omit model; the provider supplies its configured default.
    await expect(provider.chatCompletion({ messages: params.messages }, context)).resolves.toEqual(
      completion,
    );
    expect(fetchMock.calls).toHaveLength(1);
    const request = fetchMock.calls[0]!.request;
    expect(request.method).toBe('POST');
    expect(request.headers.get('authorization')).toBe('Bearer test-api-key');
    expect(request.headers.get('http-referer')).toBe('https://example.test');
    expect(request.headers.get('x-title')).toBe('Contract test');
    await expect(request.json()).resolves.toEqual({
      messages: params.messages,
      model: 'test/default',
      temperature: 0.8,
      top_p: 0.95,
      max_tokens: 2000,
      top_k: 10,
      min_p: 0.1,
    });
  });

  it('preserves overrides and removes explicitly cleared defaults from the actual JSON request', async () => {
    fetchMock.route({ match: endpoint, respond: Response.json(completion) });
    const overrides = {
      ...params,
      temperature: null,
      top_p: 0,
      max_tokens: null,
      top_k: 3,
      min_p: 0,
      stream: false as const,
    };
    await provider.chatCompletion(overrides, context);
    await expect(fetchMock.calls[0]!.request.json()).resolves.toEqual({
      ...params,
      top_p: 0,
      top_k: 3,
      min_p: 0,
      stream: false,
    });
  });

  it('handles concurrent first calls without dropping or duplicating requests', async () => {
    fetchMock.route({ match: endpoint, respond: Response.json(completion) });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => provider.chatCompletion(params, context)),
    );
    expect(results).toEqual(Array.from({ length: 4 }, () => completion));
    expect(fetchMock.calls).toHaveLength(4);
  });

  it('stops at the tenant rate limit before an additional upstream request', async () => {
    fetchMock.route({ match: endpoint, respond: Response.json(completion) });
    limiter.configure({ maxRequests: 1, windowMs: 60_000 });
    await provider.chatCompletion(params, context);
    await expect(provider.chatCompletion(params, context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
    });
    expect(fetchMock.calls).toHaveLength(1);
    await provider.chatCompletion(params, { ...context, tenantId: 'tenant-b' });
    expect(fetchMock.calls).toHaveLength(2);
  });

  it('classifies an upstream validation failure and remains usable', async () => {
    fetchMock.route(
      {
        match: endpoint,
        once: true,
        respond: Response.json({ error: { message: 'context_length_exceeded' } }, { status: 400 }),
      },
      { match: endpoint, respond: Response.json(completion) },
    );
    await expect(provider.chatCompletion(params, context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
    });
    await expect(provider.chatCompletion(params, context)).resolves.toEqual(completion);
    expect(fetchMock.calls).toHaveLength(2);
  });

  it('forwards an already-aborted signal without dispatching HTTP', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(provider.chatCompletion(params, context, controller.signal)).rejects.toMatchObject(
      { code: JsonRpcErrorCode.Timeout },
    );
    expect(fetchMock.calls).toEqual([]);
  });
});

describe('OpenRouter stream cleanup', () => {
  it('preserves every chunk and completes on the upstream done sentinel', async () => {
    const chunks = ['first', 'second'].map((content, index) => ({
      id: `chunk-${index}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test/model',
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    }));
    fetchMock.route({
      match: endpoint,
      respond: () =>
        new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    });
    const stream = await provider.chatCompletionStream(params, context);
    const received = [];
    for await (const chunk of stream) received.push(chunk);
    expect(received).toEqual(chunks);
  });

  it('closes the upstream body on early iterator return and logs only consumed metadata', async () => {
    const cancelled = vi.fn();
    const chunk = {
      id: 'chunk-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test/model',
      choices: [{ index: 0, delta: { content: 'private-output' }, finish_reason: null }],
    };
    const log = vi.spyOn(logger, 'logInteraction').mockImplementation(() => {});
    fetchMock.route({
      match: endpoint,
      respond: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
            },
            cancel: cancelled,
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    });
    const stream = await provider.chatCompletionStream(params, context);
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: chunk, done: false });
    await iterator.return?.();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      'OpenRouterResponse',
      expect.objectContaining({ streaming: true, chunkCount: 1, model: 'test/model' }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-output');
    await expect(fetchMock.calls[0]!.request.json()).resolves.toMatchObject({ stream: true });
  });

  it('yields every chunk in order and propagates mid-stream failures', async () => {
    const chunk = {
      id: 'chunk-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test/model',
      choices: [],
    };
    fetchMock.route({
      match: endpoint,
      respond: () =>
        new Response(
          `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ error: { message: 'stream interrupted' } })}\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    });
    const stream = await provider.chatCompletionStream(params, context);
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: chunk, done: false });
    await expect(iterator.next()).rejects.toThrow('stream interrupted');
  });
});

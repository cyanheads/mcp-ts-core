/**
 * @fileoverview WhisperProvider at its HTTP boundary: the real `fetchWithTimeout` against a
 * strict fetch fake. The request-shape cases that run against a mocked `fetchWithTimeout` live
 * in `whisper.provider.test.ts`.
 * @module tests/services/speech/providers/whisper.provider.http.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WhisperProvider } from '@/services/speech/providers/whisper.provider.js';
import { createFetchMock, type FetchMockHarness } from '@/testing/index.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';

const BASE_URL = 'https://api.openai.test/v1';
const TRANSCRIPTIONS_URL = `${BASE_URL}/audio/transcriptions`;
const MODELS_URL = `${BASE_URL}/models`;

describe('WhisperProvider HTTP boundary', () => {
  let fetchMock: FetchMockHarness;
  let provider: WhisperProvider;

  beforeEach(() => {
    fetchMock = createFetchMock();
    fetchMock.install();
    provider = new WhisperProvider({
      provider: 'openai-whisper',
      apiKey: 'test-api-key',
      baseUrl: BASE_URL,
      defaultModelId: 'whisper-1',
      timeout: 10000,
    });
  });

  afterEach(async () => {
    await Promise.all(
      fetchMock.calls.map(({ request }) => (request.bodyUsed ? undefined : request.arrayBuffer())),
    );
    fetchMock.restore();
  });

  it('uploads the audio bytes as multipart form data authenticated with the API key', async () => {
    fetchMock.route({
      match: TRANSCRIPTIONS_URL,
      method: 'POST',
      respond: Response.json({
        text: 'Hello world',
        language: 'en',
        duration: 1.5,
        task: 'transcribe',
        words: [{ word: 'Hello', start: 0, end: 0.5 }],
      }),
    });

    const result = await provider.speechToText({
      audio: new Uint8Array([1, 2, 3]),
      format: 'ogg',
      timestamps: true,
    });

    expect(result).toEqual({
      text: 'Hello world',
      language: 'en',
      duration: 1.5,
      words: [{ word: 'Hello', start: 0, end: 0.5 }],
      metadata: { modelId: 'whisper-1', provider: 'openai-whisper', task: 'transcribe' },
    });
    expect(fetchMock.calls).toHaveLength(1);
    const { request } = fetchMock.calls[0]!;
    expect(request.headers.get('authorization')).toBe('Bearer test-api-key');
    // The multipart boundary is the runtime's to set; a fixed Content-Type would drop it.
    expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
    const form = await request.formData();
    const file = form.get('file') as File;
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(file.name).toBe('audio.ogg');
    expect(file.type).toBe('audio/ogg');
    expect(form.get('model')).toBe('whisper-1');
  });

  it('passes an upstream HTTP failure through with its status-mapped code', async () => {
    fetchMock.route({
      match: TRANSCRIPTIONS_URL,
      respond: Response.json({ error: { message: 'slow down' } }, { status: 429 }),
    });

    await expect(provider.speechToText({ audio: new Uint8Array([1, 2, 3]) })).rejects.toMatchObject(
      { code: JsonRpcErrorCode.RateLimited, data: { status: 429 } },
    );
  });

  it('reports an unparseable transcription body as ServiceUnavailable', async () => {
    fetchMock.route({ match: TRANSCRIPTIONS_URL, respond: new Response('not json') });

    await expect(provider.speechToText({ audio: new Uint8Array([1, 2, 3]) })).rejects.toMatchObject(
      {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringContaining('Failed to transcribe audio'),
      },
    );
  });

  it('checks health against the models endpoint with the API key', async () => {
    fetchMock.route(
      { match: MODELS_URL, method: 'GET', once: true, respond: Response.json({ data: [] }) },
      { match: MODELS_URL, method: 'GET', respond: new Response('no', { status: 401 }) },
    );

    await expect(provider.healthCheck()).resolves.toBe(true);
    await expect(provider.healthCheck()).resolves.toBe(false);
    expect(fetchMock.calls.map(({ request }) => request.headers.get('authorization'))).toEqual([
      'Bearer test-api-key',
      'Bearer test-api-key',
    ]);
  });
});

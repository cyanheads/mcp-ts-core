/**
 * @fileoverview Test suite for ElevenLabs speech provider, driven through the real
 * `fetchWithTimeout` against a strict fetch fake.
 * @module tests/services/speech/providers/elevenlabs.provider.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElevenLabsProvider } from '@/services/speech/providers/elevenlabs.provider.js';
import { createFetchMock, createMockContext, type FetchMockHarness } from '@/testing/index.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

const BASE_URL = 'https://api.elevenlabs.test/v1';
const TTS_URL = `${BASE_URL}/text-to-speech/voice-123`;
const VOICES_URL = `${BASE_URL}/voices`;

/** An upstream audio response carrying `bytes`. */
const audioResponse = (bytes: number[]) =>
  new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'audio/mpeg' } });

/** A 200 response whose body stream fails partway, as a reset connection does. */
const brokenBodyResponse = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error('connection reset'));
      },
    }),
  );

describe('ElevenLabsProvider', () => {
  let fetchMock: FetchMockHarness;
  let provider: ElevenLabsProvider;

  /** The JSON body of the Nth upstream request. */
  const sentBody = (call = 0) =>
    fetchMock.calls[call]?.request.json() as Promise<Record<string, unknown>>;

  beforeEach(() => {
    fetchMock = createFetchMock();
    fetchMock.install();
    provider = new ElevenLabsProvider({
      provider: 'elevenlabs',
      apiKey: 'test-api-key',
      baseUrl: BASE_URL,
      defaultVoiceId: 'voice-123',
      defaultModelId: 'model-1',
      timeout: 5000,
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      fetchMock.calls.map(({ request }) => (request.bodyUsed ? undefined : request.arrayBuffer())),
    );
    fetchMock.restore();
  });

  describe('constructor', () => {
    it('should throw when API key is missing', () => {
      expect(() => new ElevenLabsProvider({ provider: 'elevenlabs' })).toThrow(McpError);
      expect(() => new ElevenLabsProvider({ provider: 'elevenlabs' })).toThrow(
        'ElevenLabs API key is required',
      );
    });

    it('should use default values when not specified', async () => {
      const p = new ElevenLabsProvider({
        provider: 'elevenlabs',
        apiKey: 'key',
      });

      expect(p.name).toBe('elevenlabs');
      expect(p.supportsTTS).toBe(true);
      expect(p.supportsSTT).toBe(false);

      fetchMock.route({
        match: 'https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL',
        method: 'POST',
        respond: audioResponse([1]),
      });
      await p.textToSpeech({ text: 'Hi' });

      await expect(sentBody()).resolves.toEqual({
        text: 'Hi',
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0,
          use_speaker_boost: true,
        },
      });
    });

    it('should abort a synthesis that outlives the 30-second default timeout', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const p = new ElevenLabsProvider({ provider: 'elevenlabs', apiKey: 'key' });
      fetchMock.route({
        match: /\/text-to-speech\//,
        respond: (request) =>
          new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason));
          }),
      });

      let outcome: unknown = 'pending';
      void p.textToSpeech({ text: 'Hi' }).then(
        (result) => {
          outcome = result;
        },
        (error: unknown) => {
          outcome = error;
        },
      );

      await vi.advanceTimersByTimeAsync(29_999);
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    });
  });

  describe('textToSpeech', () => {
    it('should return the synthesized audio and authenticate with the API key', async () => {
      fetchMock.route({ match: TTS_URL, method: 'POST', respond: audioResponse([1, 2, 3, 4]) });

      const result = await provider.textToSpeech({ text: 'Hello world' });

      expect(result).toEqual({
        audio: new Uint8Array([1, 2, 3, 4]),
        format: 'mp3',
        characterCount: 11,
        metadata: { voiceId: 'voice-123', modelId: 'model-1', provider: 'elevenlabs' },
      });
      expect(fetchMock.calls).toHaveLength(1);
      const { headers } = fetchMock.calls[0]!.request;
      expect(headers.get('xi-api-key')).toBe('test-api-key');
      expect(headers.get('content-type')).toBe('application/json');
    });

    it('should throw when text is empty', async () => {
      await expect(provider.textToSpeech({ text: '' })).rejects.toThrow(McpError);
      await expect(provider.textToSpeech({ text: '   ' })).rejects.toThrow('Text cannot be empty');
      expect(fetchMock.calls).toEqual([]);
    });

    // #548 — a caller's context (a handler ctx after an elicitation round) must
    // not come back as error data: it reaches structuredContent.error.data.
    it.each([
      ['empty text', () => undefined, { text: ' ' }],
      ['text over the limit', () => undefined, { text: 'a'.repeat(5001) }],
      [
        'an upstream failure',
        () =>
          fetchMock.route({
            match: TTS_URL,
            respond: () => Promise.reject(new Error('socket hang up')),
          }),
        { text: 'Hello' },
      ],
    ])('keeps the caller context out of the error data on %s', async (_label, arrange, options) => {
      arrange();
      const ctx = createMockContext({
        inputResponses: { pass: { action: 'accept', content: { passphrase: 'hunter2' } } },
      });

      // The option's narrow type rejects a handler ctx only under
      // exactOptionalPropertyTypes; at runtime the whole object is accepted.
      const error = await provider
        .textToSpeech({ ...options, context: ctx as never })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(McpError);
      const data = (error as McpError).data ?? {};
      expect(JSON.stringify(data)).not.toContain('hunter2');
      for (const key of ['inputs', 'requestId', 'timestamp', 'operation', 'tenantId', 'state']) {
        expect(data).not.toHaveProperty(key);
      }
    });

    it('should throw when text exceeds 5000 characters', async () => {
      const longText = 'a'.repeat(5001);

      await expect(provider.textToSpeech({ text: longText })).rejects.toThrow(
        'Text exceeds maximum length of 5000 characters',
      );
    });

    it('should use custom voice settings', async () => {
      fetchMock.route({
        match: `${BASE_URL}/text-to-speech/custom-voice`,
        method: 'POST',
        respond: audioResponse([1, 2, 3]),
      });

      await provider.textToSpeech({
        text: 'Test',
        voice: {
          voiceId: 'custom-voice',
          stability: 0.8,
          similarityBoost: 0.9,
          style: 0.5,
        },
        modelId: 'custom-model',
      });

      await expect(sentBody()).resolves.toEqual({
        text: 'Test',
        model_id: 'custom-model',
        voice_settings: {
          stability: 0.8,
          similarity_boost: 0.9,
          style: 0.5,
          use_speaker_boost: true,
        },
      });
    });

    it('forwards voice.speed to voice_settings and omits it when unset', async () => {
      fetchMock.route({ match: TTS_URL, respond: audioResponse([1]) });

      await provider.textToSpeech({ text: 'Hi', voice: { speed: 1.1 } });
      await provider.textToSpeech({ text: 'Hi' });

      const [withSpeed, withoutSpeed] = await Promise.all([sentBody(0), sentBody(1)]);
      expect(withSpeed.voice_settings).toMatchObject({ speed: 1.1 });
      expect(withoutSpeed.voice_settings).not.toHaveProperty('speed');
    });

    it('should pass an upstream HTTP failure through with its status-mapped code', async () => {
      fetchMock.route({
        match: TTS_URL,
        respond: Response.json({ detail: 'invalid api key' }, { status: 401 }),
      });

      await expect(provider.textToSpeech({ text: 'Hello' })).rejects.toMatchObject({
        code: JsonRpcErrorCode.Unauthorized,
        data: { status: 401 },
      });
    });

    it('should report an unreadable audio body as ServiceUnavailable', async () => {
      fetchMock.route({ match: TTS_URL, respond: brokenBodyResponse });

      await expect(provider.textToSpeech({ text: 'Hello' })).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringContaining('Failed to convert text to speech'),
      });
    });
  });

  describe('speechToText', () => {
    it('should throw not supported error', () => {
      expect(() => provider.speechToText({ audio: Buffer.from('test') })).toThrow(
        'Speech-to-text is not supported by ElevenLabs provider',
      );
    });
  });

  describe('getVoices', () => {
    it('should return mapped voice list', async () => {
      fetchMock.route({
        match: VOICES_URL,
        method: 'GET',
        respond: Response.json({
          voices: [
            {
              voice_id: 'v1',
              name: 'Bella',
              description: 'Warm voice',
              category: 'premade',
              preview_url: 'https://preview.test/v1',
              labels: { gender: 'female' },
            },
            {
              voice_id: 'v2',
              name: 'Adam',
              labels: { gender: 'male' },
            },
          ],
        }),
      });

      const voices = await provider.getVoices();

      expect(voices).toHaveLength(2);
      expect(voices[0]).toEqual(
        expect.objectContaining({
          id: 'v1',
          name: 'Bella',
          description: 'Warm voice',
          category: 'premade',
          previewUrl: 'https://preview.test/v1',
          gender: 'female',
        }),
      );
      expect(voices[1]?.id).toBe('v2');
      expect(voices[1]?.name).toBe('Adam');
      expect(voices[1]?.gender).toBe('male');
      expect(fetchMock.calls[0]!.request.headers.get('xi-api-key')).toBe('test-api-key');
    });

    it('should pass an upstream HTTP failure through with its status-mapped code', async () => {
      fetchMock.route({ match: VOICES_URL, respond: new Response('down', { status: 500 }) });

      await expect(provider.getVoices()).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { status: 500 },
      });
    });

    it('should report an unparseable voice list as ServiceUnavailable', async () => {
      fetchMock.route({ match: VOICES_URL, respond: new Response('not json') });

      await expect(provider.getVoices()).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringContaining('Failed to fetch voices'),
      });
    });
  });

  describe('healthCheck', () => {
    it('should return true when getVoices succeeds', async () => {
      fetchMock.route({ match: VOICES_URL, respond: Response.json({ voices: [] }) });

      const result = await provider.healthCheck();
      expect(result).toBe(true);
    });

    it('should return false when getVoices fails', async () => {
      fetchMock.route({
        match: VOICES_URL,
        respond: () => Promise.reject(new Error('Connection refused')),
      });

      const result = await provider.healthCheck();
      expect(result).toBe(false);
    });
  });
});

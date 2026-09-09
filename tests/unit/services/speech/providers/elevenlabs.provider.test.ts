/**
 * @fileoverview Test suite for ElevenLabs speech provider.
 * @module tests/services/speech/providers/elevenlabs.provider.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElevenLabsProvider } from '@/services/speech/providers/elevenlabs.provider.js';
import { McpError } from '@/types-global/errors.js';

// Mock fetchWithTimeout
vi.mock('@/utils/network/fetchWithTimeout.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithTimeout: vi.fn(),
  };
});

import { fetchWithTimeout } from '@/utils/network/fetchWithTimeout.js';

const mockFetch = vi.mocked(fetchWithTimeout);

describe('ElevenLabsProvider', () => {
  let provider: ElevenLabsProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ElevenLabsProvider({
      provider: 'elevenlabs',
      apiKey: 'test-api-key',
      baseUrl: 'https://api.elevenlabs.test/v1',
      defaultVoiceId: 'voice-123',
      defaultModelId: 'model-1',
      timeout: 5000,
    });
  });

  describe('constructor', () => {
    it('should throw when API key is missing', () => {
      expect(() => new ElevenLabsProvider({ provider: 'elevenlabs' })).toThrow(McpError);
      expect(() => new ElevenLabsProvider({ provider: 'elevenlabs' })).toThrow(
        'ElevenLabs API key is required',
      );
    });

    it('should use default values when not specified', () => {
      const p = new ElevenLabsProvider({
        provider: 'elevenlabs',
        apiKey: 'key',
      });

      expect(p.name).toBe('elevenlabs');
      expect(p.supportsTTS).toBe(true);
      expect(p.supportsSTT).toBe(false);
    });
  });

  describe('textToSpeech', () => {
    it('should convert text to speech successfully', async () => {
      const audioData = new Uint8Array([1, 2, 3, 4]);
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(audioData.buffer),
      } as unknown as Response);

      const result = await provider.textToSpeech({ text: 'Hello world' });

      expect(result.format).toBe('mp3');
      expect(result.characterCount).toBe(11);
      expect(result.metadata?.provider).toBe('elevenlabs');
      expect(result.metadata?.voiceId).toBe('voice-123');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should throw when text is empty', async () => {
      await expect(provider.textToSpeech({ text: '' })).rejects.toThrow(McpError);
      await expect(provider.textToSpeech({ text: '   ' })).rejects.toThrow('Text cannot be empty');
    });

    it('should throw when text exceeds 5000 characters', async () => {
      const longText = 'a'.repeat(5001);

      await expect(provider.textToSpeech({ text: longText })).rejects.toThrow(
        'Text exceeds maximum length of 5000 characters',
      );
    });

    it('should use custom voice settings', async () => {
      const audioData = new Uint8Array([1, 2, 3]);
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(audioData.buffer),
      } as unknown as Response);

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

      const callArgs = mockFetch.mock.calls[0];
      const url = callArgs?.[0] as string;
      expect(url).toContain('custom-voice');

      const body = JSON.parse((callArgs?.[3] as RequestInit)?.body as string) as Record<
        string,
        unknown
      >;
      expect(body.model_id).toBe('custom-model');
      expect((body.voice_settings as Record<string, unknown>).stability).toBe(0.8);
    });

    it('forwards voice.speed to voice_settings and omits it when unset', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
      } as unknown as Response);
      const sentVoiceSettings = (call: number): Record<string, unknown> =>
        (
          JSON.parse((mockFetch.mock.calls[call]?.[3] as RequestInit)?.body as string) as {
            voice_settings: Record<string, unknown>;
          }
        ).voice_settings;

      await provider.textToSpeech({ text: 'Hi', voice: { speed: 1.1 } });
      expect(sentVoiceSettings(0).speed).toBe(1.1);

      await provider.textToSpeech({ text: 'Hi' });
      expect(sentVoiceSettings(1)).not.toHaveProperty('speed');
    });

    it('should throw on API error response', async () => {
      // fetchWithTimeout throws McpError on non-ok responses
      mockFetch.mockRejectedValue(
        new McpError(
          -32003,
          'Fetch failed for https://api.elevenlabs.test/v1/text-to-speech/voice-123. Status: 401',
        ),
      );

      await expect(provider.textToSpeech({ text: 'Hello' })).rejects.toThrow('Fetch failed');
    });

    it('should wrap network errors in McpError', async () => {
      mockFetch.mockRejectedValue(new Error('Network timeout'));

      await expect(provider.textToSpeech({ text: 'Hello' })).rejects.toThrow(McpError);
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
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
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
      } as unknown as Response);

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
    });

    it('should throw on API error', async () => {
      // fetchWithTimeout throws McpError on non-ok responses
      mockFetch.mockRejectedValue(
        new McpError(-32003, 'Fetch failed for https://api.elevenlabs.test/v1/voices. Status: 500'),
      );

      await expect(provider.getVoices()).rejects.toThrow(McpError);
    });
  });

  describe('healthCheck', () => {
    it('should return true when getVoices succeeds', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ voices: [] }),
      } as unknown as Response);

      const result = await provider.healthCheck();
      expect(result).toBe(true);
    });

    it('should return false when getVoices fails', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const result = await provider.healthCheck();
      expect(result).toBe(false);
    });
  });
});

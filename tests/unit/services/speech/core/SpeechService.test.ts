/**
 * @fileoverview Test suite for SpeechService orchestrator.
 * @module tests/services/speech/core/SpeechService.test
 */

import { describe, expect, it, vi } from 'vitest';
import { createSpeechProvider, SpeechService } from '@/services/speech/core/SpeechService.js';
import type { SpeechProviderConfig } from '@/services/speech/types.js';
import { McpError } from '@/types-global/errors.js';

// Mock the provider constructors to avoid real API calls
vi.mock('@/services/speech/providers/elevenlabs.provider.js', () => {
  class MockElevenLabs {
    name = 'elevenlabs';
    supportsTTS = true;
    supportsSTT = false;
    textToSpeech = vi.fn();
    speechToText = vi.fn();
    getVoices = vi.fn();
    healthCheck = vi.fn().mockResolvedValue(true);
  }
  return { ElevenLabsProvider: MockElevenLabs };
});

vi.mock('@/services/speech/providers/whisper.provider.js', () => {
  class MockWhisper {
    name = 'openai-whisper';
    supportsTTS = false;
    supportsSTT = true;
    textToSpeech = vi.fn();
    speechToText = vi.fn();
    getVoices = vi.fn();
    healthCheck = vi.fn().mockResolvedValue(true);
  }
  return { WhisperProvider: MockWhisper };
});

describe('createSpeechProvider', () => {
  it('should create an ElevenLabs provider', () => {
    const provider = createSpeechProvider({
      provider: 'elevenlabs',
      apiKey: 'test-key',
    });

    expect(provider.name).toBe('elevenlabs');
    expect(provider.supportsTTS).toBe(true);
  });

  it('should create a Whisper provider', () => {
    const provider = createSpeechProvider({
      provider: 'openai-whisper',
      apiKey: 'test-key',
    });

    expect(provider.name).toBe('openai-whisper');
    expect(provider.supportsSTT).toBe(true);
  });

  it('should throw for unknown provider', () => {
    expect(() =>
      createSpeechProvider({
        provider: 'unknown' as SpeechProviderConfig['provider'],
      }),
    ).toThrow(McpError);
  });
});

describe('SpeechService', () => {
  describe('constructor', () => {
    it('should initialize with no providers', () => {
      const service = new SpeechService();

      expect(service.hasTTS()).toBe(false);
      expect(service.hasSTT()).toBe(false);
    });

    it('should initialize with TTS provider only', () => {
      const service = new SpeechService({
        provider: 'elevenlabs',
        apiKey: 'test-key',
      });

      expect(service.hasTTS()).toBe(true);
      expect(service.hasSTT()).toBe(false);
    });

    it('should initialize with STT provider only', () => {
      const service = new SpeechService(undefined, {
        provider: 'openai-whisper',
        apiKey: 'test-key',
      });

      expect(service.hasTTS()).toBe(false);
      expect(service.hasSTT()).toBe(true);
    });

    it('should initialize with both TTS and STT providers', () => {
      const service = new SpeechService(
        { provider: 'elevenlabs', apiKey: 'tts-key' },
        { provider: 'openai-whisper', apiKey: 'stt-key' },
      );

      expect(service.hasTTS()).toBe(true);
      expect(service.hasSTT()).toBe(true);
    });
  });

  describe('getTTSProvider', () => {
    it('should return the TTS provider when configured', () => {
      const service = new SpeechService({
        provider: 'elevenlabs',
        apiKey: 'test-key',
      });

      const provider = service.getTTSProvider();
      expect(provider.name).toBe('elevenlabs');
    });

    it('should throw when no TTS provider is configured', () => {
      const service = new SpeechService();

      expect(() => service.getTTSProvider()).toThrow(McpError);
      expect(() => service.getTTSProvider()).toThrow('No TTS provider configured');
    });
  });

  describe('getSTTProvider', () => {
    it('should return the STT provider when configured', () => {
      const service = new SpeechService(undefined, {
        provider: 'openai-whisper',
        apiKey: 'test-key',
      });

      const provider = service.getSTTProvider();
      expect(provider.name).toBe('openai-whisper');
    });

    it('should throw when no STT provider is configured', () => {
      const service = new SpeechService();

      expect(() => service.getSTTProvider()).toThrow(McpError);
      expect(() => service.getSTTProvider()).toThrow('No STT provider configured');
    });
  });

  describe('healthCheck', () => {
    it('should report health of both providers', async () => {
      const service = new SpeechService(
        { provider: 'elevenlabs', apiKey: 'tts-key' },
        { provider: 'openai-whisper', apiKey: 'stt-key' },
      );

      const health = await service.healthCheck();

      expect(health.tts).toBe(true);
      expect(health.stt).toBe(true);
    });

    it('should report false for unconfigured providers', async () => {
      const service = new SpeechService();

      const health = await service.healthCheck();

      expect(health.tts).toBe(false);
      expect(health.stt).toBe(false);
    });

    it('should report partial health when only TTS is configured', async () => {
      const service = new SpeechService({
        provider: 'elevenlabs',
        apiKey: 'tts-key',
      });

      const health = await service.healthCheck();

      expect(health.tts).toBe(true);
      expect(health.stt).toBe(false);
    });
  });
});

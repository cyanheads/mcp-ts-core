/**
 * @fileoverview Speech service orchestrator.
 * Manages independent TTS and STT provider instances, allowing different providers
 * to be used for each capability (e.g., ElevenLabs for TTS and Whisper for STT).
 * @module src/services/speech/core/SpeechService
 */

import { invalidParams, invalidRequest } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';

import { ElevenLabsProvider } from '../providers/elevenlabs.provider.js';
import { WhisperProvider } from '../providers/whisper.provider.js';
import type { SpeechProviderConfig } from '../types.js';
import type { ISpeechProvider } from './ISpeechProvider.js';

/**
 * Factory function that instantiates a concrete {@link ISpeechProvider} from a config object.
 * Performs an exhaustive switch over `config.provider` so TypeScript enforces handling
 * of every declared variant at compile time.
 *
 * @param config - Provider configuration including the `provider` discriminant, API key,
 *   base URL, default voice/model IDs, and timeout.
 * @returns A fully constructed provider instance ready for use.
 * @throws {McpError} With `InvalidParams` for the `'mock'` provider (not yet implemented)
 *   or for any unrecognized provider string.
 *
 * @example
 * const tts = createSpeechProvider({ provider: 'elevenlabs', apiKey: process.env.ELEVEN_KEY });
 */
export function createSpeechProvider(config: SpeechProviderConfig): ISpeechProvider {
  logger.debug(`Creating speech provider: ${config.provider}`);

  switch (config.provider) {
    case 'elevenlabs':
      return new ElevenLabsProvider(config);

    case 'openai-whisper':
      return new WhisperProvider(config);

    default: {
      const _exhaustive: never = config.provider;
      throw invalidParams(`Unknown speech provider: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Orchestrates TTS and STT operations across independently configured providers.
 * Each capability (TTS, STT) can be backed by a different provider; either or both
 * may be absent if only one capability is needed.
 *
 * @example
 * const speech = new SpeechService(
 *   { provider: 'elevenlabs', apiKey: process.env.ELEVEN_KEY },
 *   { provider: 'openai-whisper', apiKey: process.env.OPENAI_KEY },
 * );
 * const { tts, stt } = await speech.healthCheck();
 */
export class SpeechService {
  private ttsProvider?: ISpeechProvider;
  private sttProvider?: ISpeechProvider;

  /**
   * Construct a SpeechService with optional TTS and STT providers.
   * Providers are instantiated via {@link createSpeechProvider}. If a provider's declared
   * capability does not match its config slot (e.g., a TTS-only provider passed as
   * `sttConfig`), a warning is logged but no error is thrown.
   *
   * @param ttsConfig - Config for the text-to-speech provider. Omit if TTS is not needed.
   * @param sttConfig - Config for the speech-to-text provider. Omit if STT is not needed.
   */
  constructor(ttsConfig?: SpeechProviderConfig, sttConfig?: SpeechProviderConfig) {
    if (ttsConfig) {
      this.ttsProvider = createSpeechProvider(ttsConfig);
      if (!this.ttsProvider.supportsTTS) {
        logger.warning(`TTS provider ${ttsConfig.provider} does not support text-to-speech`);
      }
    }

    if (sttConfig) {
      this.sttProvider = createSpeechProvider(sttConfig);
      if (!this.sttProvider.supportsSTT) {
        logger.warning(`STT provider ${sttConfig.provider} does not support speech-to-text`);
      }
    }

    logger.info(
      `Speech service initialized: TTS=${this.ttsProvider?.name ?? 'none'}, STT=${this.sttProvider?.name ?? 'none'}`,
    );
  }

  /**
   * Return the configured TTS provider.
   *
   * @returns The active {@link ISpeechProvider} for text-to-speech.
   * @throws {McpError} With `InvalidRequest` if no TTS provider was configured.
   */
  getTTSProvider(): ISpeechProvider {
    if (!this.ttsProvider) {
      throw invalidRequest('No TTS provider configured');
    }
    return this.ttsProvider;
  }

  /**
   * Return the configured STT provider.
   *
   * @returns The active {@link ISpeechProvider} for speech-to-text.
   * @throws {McpError} With `InvalidRequest` if no STT provider was configured.
   */
  getSTTProvider(): ISpeechProvider {
    if (!this.sttProvider) {
      throw invalidRequest('No STT provider configured');
    }
    return this.sttProvider;
  }

  /**
   * Returns `true` if a TTS provider is configured and declares `supportsTTS`.
   *
   * @returns `true` when TTS synthesis is available, `false` otherwise.
   */
  hasTTS(): boolean {
    return this.ttsProvider?.supportsTTS ?? false;
  }

  /**
   * Returns `true` if an STT provider is configured and declares `supportsSTT`.
   *
   * @returns `true` when speech transcription is available, `false` otherwise.
   */
  hasSTT(): boolean {
    return this.sttProvider?.supportsSTT ?? false;
  }

  /**
   * Run health checks against all configured providers in parallel.
   * Providers that are not configured report `false` without making any network call.
   *
   * @returns Object with `tts` and `stt` boolean fields indicating provider health.
   *   Never rejects — individual provider errors are caught internally.
   */
  async healthCheck(): Promise<{
    tts: boolean;
    stt: boolean;
  }> {
    const [tts, stt] = await Promise.all([
      this.ttsProvider?.healthCheck() ?? false,
      this.sttProvider?.healthCheck() ?? false,
    ]);
    return { tts, stt };
  }
}

/**
 * @fileoverview ElevenLabs text-to-speech provider implementation.
 * Wraps the ElevenLabs v1 REST API to provide TTS synthesis and voice listing.
 * STT is not supported by ElevenLabs and will throw `MethodNotFound`.
 * @module src/services/speech/providers/elevenlabs.provider
 */

import {
  invalidParams,
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
} from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { nowMs } from '@/utils/internal/performance.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { fetchWithTimeout } from '@/utils/network/fetchWithTimeout.js';
import {
  ATTR_MCP_SPEECH_INPUT_BYTES,
  ATTR_MCP_SPEECH_OPERATION,
  ATTR_MCP_SPEECH_OUTPUT_BYTES,
  ATTR_MCP_SPEECH_PROVIDER,
} from '@/utils/telemetry/attributes.js';
import { withSpan } from '@/utils/telemetry/trace.js';

import type { ISpeechProvider } from '../core/ISpeechProvider.js';
import { recordSpeechOp } from '../core/speechMetrics.js';
import type {
  SpeechProviderConfig,
  SpeechToTextOptions,
  SpeechToTextResult,
  TextToSpeechOptions,
  TextToSpeechResult,
  Voice,
} from '../types.js';

/**
 * Shape of a single voice entry returned by the ElevenLabs `GET /voices` endpoint.
 */
interface ElevenLabsVoice {
  category?: string;
  description?: string;
  /** Key/value labels; the `gender` key maps to {@link Voice.gender} when present */
  labels?: Record<string, string>;
  name: string;
  preview_url?: string;
  voice_id: string;
}

/**
 * Top-level response from the ElevenLabs `GET /voices` endpoint.
 */
interface ElevenLabsVoicesResponse {
  voices: ElevenLabsVoice[];
}

/**
 * ElevenLabs TTS provider.
 * Implements {@link ISpeechProvider} for text-to-speech only (`supportsTTS = true`,
 * `supportsSTT = false`). Calls the ElevenLabs v1 REST API using `fetchWithTimeout`.
 *
 * Default voice: `EXAVITQu4vr4xnSDxMaL` (Bella)
 * Default model: `eleven_monolingual_v1`
 * Default timeout: 30 000 ms
 */
export class ElevenLabsProvider implements ISpeechProvider {
  public readonly name = 'elevenlabs';
  public readonly supportsTTS = true;
  public readonly supportsSTT = false;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultVoiceId: string;
  private readonly defaultModelId: string;
  private readonly timeout: number;

  /**
   * Construct an ElevenLabsProvider.
   *
   * @param config - Provider configuration. `config.apiKey` is required; all other
   *   fields fall back to ElevenLabs defaults.
   * @throws {McpError} With `InvalidParams` if `config.apiKey` is absent.
   */
  constructor(config: SpeechProviderConfig) {
    if (!config.apiKey) {
      throw invalidParams('ElevenLabs API key is required');
    }

    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.elevenlabs.io/v1';
    this.defaultVoiceId = config.defaultVoiceId ?? 'EXAVITQu4vr4xnSDxMaL'; // Default: Bella
    this.defaultModelId = config.defaultModelId ?? 'eleven_monolingual_v1';
    this.timeout = config.timeout ?? 30000;

    logger.info(
      `ElevenLabs TTS provider initialized: ${this.baseUrl}, voice=${this.defaultVoiceId}`,
    );
  }

  /**
   * Synthesize speech from text using the ElevenLabs text-to-speech API.
   * Posts to `POST /text-to-speech/{voiceId}` and returns the raw MP3 audio as a Uint8Array.
   * Voice settings (stability, similarity_boost, style) are merged from `options.voice`
   * with provider defaults. Text is validated for non-empty and ≤ 5 000 characters.
   *
   * @param options - TTS options. `options.text` is required. `options.voice.voiceId`
   *   overrides the provider default voice; `options.modelId` overrides the default model.
   * @returns Resolved {@link TextToSpeechResult} with `audio` as a `Uint8Array`, `format` of
   *   `'mp3'`, `characterCount` equal to `options.text.length`, and `metadata` containing
   *   `voiceId`, `modelId`, and `provider`.
   * @throws {McpError} With `InvalidParams` for empty text or text > 5 000 chars.
   * @throws {McpError} With `InternalError` if the ElevenLabs API call fails.
   */
  async textToSpeech(options: TextToSpeechOptions): Promise<TextToSpeechResult> {
    const context = requestContextService.createRequestContext({
      operation: 'elevenlabs-tts',
      ...(options.context ?? {}),
    });
    const voiceId = options.voice?.voiceId ?? this.defaultVoiceId;
    const modelId = options.modelId ?? this.defaultModelId;

    logger.debug('Converting text to speech with ElevenLabs', context);

    if (!options.text || options.text.trim().length === 0) {
      throw invalidParams('Text cannot be empty', context);
    }

    if (options.text.length > 5000) {
      throw invalidParams('Text exceeds maximum length of 5000 characters', context);
    }

    const inputBytes = new TextEncoder().encode(options.text).length;

    return await withSpan(
      'speech:tts',
      async (span) => {
        const t0 = nowMs();
        let ok = false;

        const url = `${this.baseUrl}/text-to-speech/${voiceId}`;

        // Build voice settings
        const voiceSettings = {
          stability: options.voice?.stability ?? 0.5,
          similarity_boost: options.voice?.similarityBoost ?? 0.75,
          style: options.voice?.style ?? 0.0,
          use_speaker_boost: true,
        };

        const requestBody = {
          text: options.text,
          model_id: modelId,
          voice_settings: voiceSettings,
        };

        try {
          const response = await fetchWithTimeout(url, this.timeout, context, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'xi-api-key': this.apiKey,
            },
            body: JSON.stringify(requestBody),
          });

          // fetchWithTimeout already throws McpError on non-ok responses
          const audioBuffer = new Uint8Array(await response.arrayBuffer());
          ok = true;

          span.setAttribute(ATTR_MCP_SPEECH_OUTPUT_BYTES, audioBuffer.length);

          logger.info(
            `Text-to-speech conversion successful (voice=${voiceId}, ${audioBuffer.length} bytes)`,
            context,
          );

          return {
            audio: audioBuffer,
            format: 'mp3' as const,
            characterCount: options.text.length,
            metadata: {
              voiceId,
              modelId,
              provider: this.name,
            },
          };
        } catch (error: unknown) {
          if (error instanceof McpError) {
            throw error;
          }

          logger.error(
            'Failed to convert text to speech',
            error instanceof Error ? error : new Error(String(error)),
            context,
          );

          throw serviceUnavailable(
            `Failed to convert text to speech: ${error instanceof Error ? error.message : 'Unknown error'}`,
            context,
            { cause: error },
          );
        } finally {
          recordSpeechOp(span, t0, ok, 'tts', 'elevenlabs');
        }
      },
      {
        [ATTR_MCP_SPEECH_PROVIDER]: 'elevenlabs',
        [ATTR_MCP_SPEECH_OPERATION]: 'tts',
        [ATTR_MCP_SPEECH_INPUT_BYTES]: inputBytes,
      },
    );
  }

  /**
   * Not supported — ElevenLabs is a TTS-only provider.
   *
   * @param _options - Unused.
   * @throws {McpError} Always, with `MethodNotFound`.
   */
  speechToText(_options: SpeechToTextOptions): Promise<SpeechToTextResult> {
    throw new McpError(
      JsonRpcErrorCode.MethodNotFound,
      'Speech-to-text is not supported by ElevenLabs provider',
    );
  }

  /**
   * Fetch all voices available in the authenticated ElevenLabs account.
   * Calls `GET /voices` and maps the API response to the canonical {@link Voice} shape,
   * extracting gender from the `labels.gender` field when present.
   *
   * @returns Resolved array of {@link Voice} objects. The array may be empty if the
   *   account has no voices configured.
   * @throws {McpError} With `InternalError` if the ElevenLabs API call fails.
   */
  async getVoices(): Promise<Voice[]> {
    const context = requestContextService.createRequestContext({
      operation: 'elevenlabs-getVoices',
    });
    logger.debug('Fetching available voices from ElevenLabs', context);

    const url = `${this.baseUrl}/voices`;

    try {
      const response = await fetchWithTimeout(url, this.timeout, context, {
        method: 'GET',
        headers: {
          'xi-api-key': this.apiKey,
        },
      });

      // fetchWithTimeout already throws McpError on non-ok responses
      const data = (await response.json()) as ElevenLabsVoicesResponse;

      const voices: Voice[] = data.voices.map((v) => ({
        id: v.voice_id,
        name: v.name,
        ...(v.description !== undefined && { description: v.description }),
        ...(v.category !== undefined && { category: v.category }),
        ...(v.preview_url !== undefined && { previewUrl: v.preview_url }),
        ...(v.labels?.gender !== undefined && {
          gender: v.labels.gender as 'male' | 'female' | 'neutral',
        }),
        metadata: {
          labels: v.labels,
        },
      }));

      logger.info(`Successfully fetched ${voices.length} voices`, context);

      return voices;
    } catch (error: unknown) {
      if (error instanceof McpError) {
        throw error;
      }

      logger.error(
        'Failed to fetch voices',
        error instanceof Error ? error : new Error(String(error)),
        context,
      );

      throw serviceUnavailable(
        `Failed to fetch voices: ${error instanceof Error ? error.message : 'Unknown error'}`,
        undefined,
        { cause: error },
      );
    }
  }

  /**
   * Verify ElevenLabs API connectivity by attempting to fetch the voice list.
   * A successful `getVoices()` call indicates the API key is valid and the service
   * is reachable.
   *
   * @returns `true` if `getVoices()` resolves without error, `false` otherwise.
   *   Never rejects.
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Simple health check: try to fetch voices
      await this.getVoices();
      return true;
    } catch (error: unknown) {
      const context = requestContextService.createRequestContext({
        operation: 'elevenlabs-healthCheck',
      });
      logger.error(
        'ElevenLabs health check failed',
        error instanceof Error ? error : new Error(String(error)),
        context,
      );
      return false;
    }
  }
}

/**
 * @fileoverview OpenAI Whisper speech-to-text provider implementation.
 * Wraps the OpenAI audio transcriptions API (`POST /audio/transcriptions`) to provide
 * STT transcription in multiple languages. TTS is not supported and will throw `MethodNotFound`.
 * Audio is submitted as multipart `FormData`; the 25 MB Whisper file-size limit is enforced
 * before the network call.
 * @module src/services/speech/providers/whisper.provider
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
  WordTimestamp,
} from '../types.js';

/**
 * Shape of the JSON body returned by `POST /audio/transcriptions`.
 * In `verbose_json` mode (when timestamps are requested) the `language`, `duration`,
 * `task`, and `words` fields are populated.
 */
interface WhisperTranscriptionResponse {
  duration?: number;
  language?: string;
  task?: string;
  text: string;
  words?: Array<{
    word: string;
    start: number;
    end: number;
  }>;
}

/**
 * OpenAI Whisper STT provider.
 * Implements {@link ISpeechProvider} for speech-to-text only (`supportsSTT = true`,
 * `supportsTTS = false`). Submits audio to the OpenAI transcriptions endpoint via
 * multipart form upload using `fetchWithTimeout`.
 *
 * Default model: `whisper-1`
 * Default timeout: 60 000 ms (audio processing is slower than typical API calls)
 * Maximum audio size: 25 MB (enforced locally before the network call)
 */
export class WhisperProvider implements ISpeechProvider {
  public readonly name = 'openai-whisper';
  public readonly supportsTTS = false;
  public readonly supportsSTT = true;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModelId: string;
  private readonly timeout: number;

  /**
   * Construct a WhisperProvider.
   *
   * @param config - Provider configuration. `config.apiKey` is required; other fields
   *   fall back to OpenAI API defaults.
   * @throws {McpError} With `InvalidParams` if `config.apiKey` is absent.
   */
  constructor(config: SpeechProviderConfig) {
    if (!config.apiKey) {
      throw invalidParams('OpenAI API key is required');
    }

    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    this.defaultModelId = config.defaultModelId ?? 'whisper-1';
    this.timeout = config.timeout ?? 60000; // Longer timeout for audio processing

    logger.info(
      `OpenAI Whisper STT provider initialized: ${this.baseUrl}, model=${this.defaultModelId}`,
    );
  }

  /**
   * Not supported — Whisper is an STT-only provider.
   *
   * @param _options - Unused.
   * @throws {McpError} Always, with `MethodNotFound`.
   */
  textToSpeech(_options: TextToSpeechOptions): Promise<TextToSpeechResult> {
    throw new McpError(
      JsonRpcErrorCode.MethodNotFound,
      'Text-to-speech is not supported by Whisper provider',
    );
  }

  /**
   * Transcribe audio to text using the OpenAI Whisper API.
   * Audio may be provided as a raw `Uint8Array` or a base64-encoded string. The data is
   * submitted to `POST /audio/transcriptions` as multipart `FormData`. When
   * `options.timestamps` is `true`, the request uses `verbose_json` format and requests
   * word-level granularity, populating `result.words`.
   *
   * @param options - Transcription options. `options.audio` is required. Optional fields:
   *   `format` (determines MIME type/filename), `language` (ISO-639-1 hint),
   *   `modelId` (overrides provider default), `prompt` (style guide), `temperature`,
   *   and `timestamps` (enables word-level output).
   * @returns Resolved {@link SpeechToTextResult} with `text`, optional `language`,
   *   `duration`, `words` (if timestamps were requested), and `metadata` containing
   *   `modelId`, `provider`, and `task`.
   * @throws {McpError} With `InvalidParams` for missing audio, invalid base64, or audio > 25 MB.
   * @throws {McpError} With `InternalError` if the Whisper API call fails.
   */
  async speechToText(options: SpeechToTextOptions): Promise<SpeechToTextResult> {
    const context = requestContextService.createRequestContext({
      operation: 'whisper-stt',
      ...(options.context ?? {}),
    });
    const modelId = options.modelId ?? this.defaultModelId;

    logger.debug('Converting speech to text with Whisper', context);

    // Validate audio input
    if (!options.audio) {
      throw invalidParams('Audio data is required', context);
    }

    // Convert audio to Uint8Array if it's a base64 string
    let audioBuffer: Uint8Array;
    if (typeof options.audio === 'string') {
      try {
        audioBuffer = Uint8Array.fromBase64(options.audio);
      } catch (_error) {
        throw invalidParams('Invalid base64 audio data', context);
      }
    } else {
      audioBuffer = options.audio;
    }

    // Check file size (Whisper has a 25MB limit)
    const maxSize = 25 * 1024 * 1024; // 25MB
    if (audioBuffer.length > maxSize) {
      throw invalidParams(
        `Audio file exceeds maximum size of 25MB (got ${Math.round(audioBuffer.length / 1024 / 1024)}MB)`,
        context,
      );
    }

    return await withSpan(
      'speech:stt',
      async (span) => {
        const t0 = nowMs();
        let ok = false;

        const url = `${this.baseUrl}/audio/transcriptions`;

        // Build form data
        const formData = new FormData();

        // Determine filename with appropriate extension
        const extension = this.getFileExtension(options.format);
        const blob = new Blob([audioBuffer], {
          type: this.getMimeType(options.format),
        });
        formData.append('file', blob, `audio.${extension}`);
        formData.append('model', modelId);

        if (options.language) {
          formData.append('language', options.language);
        }

        if (options.temperature !== undefined) {
          formData.append('temperature', options.temperature.toString());
        }

        if (options.prompt) {
          formData.append('prompt', options.prompt);
        }

        // Request verbose JSON format to get timestamps and metadata
        formData.append('response_format', options.timestamps ? 'verbose_json' : 'json');

        if (options.timestamps) {
          formData.append('timestamp_granularities[]', 'word');
        }

        try {
          const response = await fetchWithTimeout(url, this.timeout, context, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              // Don't set Content-Type - let fetch set it with boundary for FormData
            },
            body: formData,
          });

          // fetchWithTimeout already throws McpError on non-ok responses
          const data = (await response.json()) as WhisperTranscriptionResponse;

          // Convert word timestamps if present
          const words: WordTimestamp[] | undefined = data.words?.map((w) => ({
            word: w.word,
            start: w.start,
            end: w.end,
          }));

          ok = true;
          const outputBytes = new TextEncoder().encode(data.text).length;
          span.setAttribute(ATTR_MCP_SPEECH_OUTPUT_BYTES, outputBytes);

          logger.info(
            `Speech-to-text transcription successful (${data.text.length} chars)`,
            context,
          );

          return {
            text: data.text,
            ...(data.language !== undefined && { language: data.language }),
            ...(data.duration !== undefined && { duration: data.duration }),
            ...(words !== undefined && { words }),
            metadata: {
              modelId,
              provider: this.name,
              ...(data.task !== undefined && { task: data.task }),
            },
          };
        } catch (error: unknown) {
          if (error instanceof McpError) {
            throw error;
          }

          logger.error(
            'Failed to transcribe audio',
            error instanceof Error ? error : new Error(String(error)),
            context,
          );

          throw serviceUnavailable(
            `Failed to transcribe audio: ${error instanceof Error ? error.message : 'Unknown error'}`,
            context,
            { cause: error },
          );
        } finally {
          recordSpeechOp(span, t0, ok, 'stt', 'openai-whisper');
        }
      },
      {
        [ATTR_MCP_SPEECH_PROVIDER]: 'openai-whisper',
        [ATTR_MCP_SPEECH_OPERATION]: 'stt',
        [ATTR_MCP_SPEECH_INPUT_BYTES]: audioBuffer.length,
      },
    );
  }

  /**
   * Not applicable — Whisper is an STT-only provider with no voice concept.
   *
   * @throws {McpError} Always, with `MethodNotFound`.
   */
  getVoices(): Promise<Voice[]> {
    throw new McpError(
      JsonRpcErrorCode.MethodNotFound,
      'Voice listing is not supported by Whisper provider (STT only)',
    );
  }

  /**
   * Verify OpenAI API connectivity by fetching the models list (`GET /models`).
   * Uses a 5-second timeout regardless of the provider's configured `timeout`,
   * to keep health checks lightweight.
   *
   * @returns `true` if the models endpoint responds with HTTP 200, `false` otherwise.
   *   Never rejects.
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Simple health check: verify API key by making a models list request
      const context = requestContextService.createRequestContext({
        operation: 'whisper-healthCheck',
      });
      const response = await fetchWithTimeout(`${this.baseUrl}/models`, 5000, context, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      return response.ok;
    } catch (error: unknown) {
      const context = requestContextService.createRequestContext({
        operation: 'whisper-healthCheck',
      });
      logger.error(
        'Whisper health check failed',
        error instanceof Error ? error : new Error(String(error)),
        context,
      );
      return false;
    }
  }

  /**
   * Map an {@link AudioFormat} string to a file extension for the multipart upload filename.
   * Defaults to `'mp3'` for unrecognized or absent formats.
   *
   * @param format - Audio format string (e.g., `'wav'`, `'ogg'`).
   * @returns File extension without leading dot (e.g., `'wav'`).
   */
  private getFileExtension(format?: string): string {
    const formatMap: Record<string, string> = {
      mp3: 'mp3',
      wav: 'wav',
      ogg: 'ogg',
      flac: 'flac',
      webm: 'webm',
      m4a: 'm4a',
    };

    return format && formatMap[format] ? formatMap[format] : 'mp3';
  }

  /**
   * Map an {@link AudioFormat} string to the corresponding MIME type for the `Blob`
   * used in the multipart upload. Defaults to `'audio/mpeg'` for unrecognized formats.
   *
   * @param format - Audio format string (e.g., `'wav'`, `'ogg'`).
   * @returns MIME type string (e.g., `'audio/wav'`).
   */
  private getMimeType(format?: string): string {
    const mimeMap: Record<string, string> = {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      flac: 'audio/flac',
      webm: 'audio/webm',
      m4a: 'audio/mp4',
    };

    return format && mimeMap[format] ? mimeMap[format] : 'audio/mpeg';
  }
}

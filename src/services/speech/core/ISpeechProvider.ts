/**
 * @fileoverview Core interface definition for speech service providers.
 * Provides the contract for Text-to-Speech (TTS) and Speech-to-Text (STT) operations.
 * @module src/services/speech/core/ISpeechProvider
 */

import type {
  SpeechToTextOptions,
  SpeechToTextResult,
  TextToSpeechOptions,
  TextToSpeechResult,
  Voice,
} from '../types.js';

/**
 * Main interface for speech service providers.
 * Providers may implement TTS, STT, or both. Check `supportsTTS` / `supportsSTT`
 * before calling the corresponding method.
 */
export interface ISpeechProvider {
  /**
   * Retrieve the list of voices available from this provider.
   * Only meaningful for TTS providers; STT-only providers should throw.
   *
   * @returns Resolved array of available {@link Voice} objects.
   * @throws {McpError} With `MethodNotFound` if the provider does not support TTS,
   *   or with `InternalError` / `ServiceUnavailable` if the API call fails.
   */
  getVoices(): Promise<Voice[]>;

  /**
   * Verify that the provider is reachable and properly configured.
   * Implementations should perform a lightweight API call (e.g., listing models
   * or voices) rather than a full synthesis/transcription round-trip.
   *
   * @returns `true` if the provider responded successfully, `false` otherwise.
   *   Never rejects — errors are caught and logged internally.
   */
  healthCheck(): Promise<boolean>;

  /**
   * Unique identifier for this provider implementation (e.g. `'elevenlabs'`, `'openai-whisper'`).
   */
  readonly name: string;

  /**
   * Transcribe audio data to text using this provider.
   *
   * @param options - Transcription options including audio data, format, language hint,
   *   model, temperature, and optional timestamp request.
   * @returns Resolved {@link SpeechToTextResult} containing the transcript, detected language,
   *   duration, and optional word-level timestamps.
   * @throws {McpError} With `MethodNotFound` if the provider does not support STT,
   *   `InvalidParams` for invalid or oversized audio, or `InternalError` on API failure.
   */
  speechToText(options: SpeechToTextOptions): Promise<SpeechToTextResult>;

  /**
   * `true` if this provider supports speech-to-text transcription.
   * Check before calling {@link speechToText}.
   */
  readonly supportsSTT: boolean;

  /**
   * `true` if this provider supports text-to-speech synthesis.
   * Check before calling {@link textToSpeech}.
   */
  readonly supportsTTS: boolean;

  /**
   * Synthesize speech audio from text using this provider.
   *
   * @param options - Synthesis options including the text, voice settings, output format,
   *   language, and model ID.
   * @returns Resolved {@link TextToSpeechResult} containing audio data as a Buffer,
   *   character count, format, and provider metadata.
   * @throws {McpError} With `MethodNotFound` if the provider does not support TTS,
   *   `InvalidParams` for empty or oversized text, or `InternalError` on API failure.
   */
  textToSpeech(options: TextToSpeechOptions): Promise<TextToSpeechResult>;
}

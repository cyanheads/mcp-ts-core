/**
 * @fileoverview Type definitions for the Speech service.
 * Provides shared interfaces and types for Text-to-Speech (TTS) and Speech-to-Text (STT)
 * operations across all speech provider implementations.
 * @module src/services/speech/types
 */

/**
 * Supported audio formats for speech operations.
 * - `mp3` — MPEG Audio Layer III, widely compatible
 * - `wav` — Waveform Audio, uncompressed PCM
 * - `ogg` — Ogg Vorbis container
 * - `flac` — Free Lossless Audio Codec
 * - `pcm` — Raw pulse-code modulation samples
 * - `webm` — WebM container (typically Opus codec)
 */
export type AudioFormat = 'mp3' | 'wav' | 'ogg' | 'flac' | 'pcm' | 'webm';

/**
 * Voice settings for text-to-speech synthesis.
 */
export interface VoiceSettings {
  /** Voice pitch (-20.0 to 20.0, where 0 is normal) */
  pitch?: number;
  /** Similarity boost (0.0 to 1.0, provider-specific) */
  similarityBoost?: number;
  /** Speech rate/speed (0.5 to 2.0, where 1.0 is normal) */
  speed?: number;
  /** Stability setting (0.0 to 1.0, provider-specific) */
  stability?: number;
  /** Style exaggeration (0.0 to 1.0, provider-specific) */
  style?: number;
  /** Voice ID or name (provider-specific) */
  voiceId?: string;
  /** Volume level (0.0 to 1.0) */
  volume?: number;
}

/**
 * Options for text-to-speech synthesis.
 */
export interface TextToSpeechOptions {
  /** Optional context for request tracing */
  context?: {
    requestId?: string;
    traceId?: string;
    tenantId?: string;
  };
  /** Output audio format */
  format?: AudioFormat;
  /** Language code (e.g., 'en-US', 'es-ES') */
  language?: string;
  /** Model ID (provider-specific) */
  modelId?: string;
  /** Text to convert to speech */
  text: string;
  /** Voice settings */
  voice?: VoiceSettings;
}

/**
 * Result from text-to-speech synthesis.
 */
export interface TextToSpeechResult {
  /** Audio data as Uint8Array or base64 string */
  audio: Uint8Array | string;
  /** Character count of input text */
  characterCount: number;
  /** Duration in seconds (if available) */
  duration?: number;
  /** Audio format */
  format: AudioFormat;
  /** Provider-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Options for speech-to-text transcription.
 */
export interface SpeechToTextOptions {
  /** Audio data as Uint8Array or base64 string */
  audio: Uint8Array | string;
  /** Optional context for request tracing */
  context?: {
    requestId?: string;
    traceId?: string;
    tenantId?: string;
  };
  /** Audio format */
  format?: AudioFormat;
  /** Language code hint (e.g., 'en', 'es') */
  language?: string;
  /** Model ID (provider-specific) */
  modelId?: string;
  /** Prompt to guide transcription style */
  prompt?: string;
  /** Temperature for sampling (0.0 to 1.0) */
  temperature?: number;
  /** Enable word-level timestamps */
  timestamps?: boolean;
}

/**
 * Word-level timestamp information.
 */
export interface WordTimestamp {
  /** Confidence score (0.0 to 1.0) */
  confidence?: number;
  /** End time in seconds */
  end: number;
  /** Start time in seconds */
  start: number;
  /** The word or token */
  word: string;
}

/**
 * Result from speech-to-text transcription.
 */
export interface SpeechToTextResult {
  /** Overall confidence score (0.0 to 1.0) */
  confidence?: number;
  /** Duration in seconds */
  duration?: number;
  /** Detected language code */
  language?: string;
  /** Provider-specific metadata */
  metadata?: Record<string, unknown>;
  /** Transcribed text */
  text: string;
  /** Word-level timestamps (if requested) */
  words?: WordTimestamp[];
}

/**
 * Available voices from a provider.
 */
export interface Voice {
  /** Voice category (e.g., 'premade', 'cloned', 'professional') */
  category?: string;
  /** Voice description */
  description?: string;
  /** Gender (if applicable) */
  gender?: 'male' | 'female' | 'neutral';
  /** Voice ID */
  id: string;
  /** Language codes supported */
  languages?: string[];
  /** Provider-specific metadata */
  metadata?: Record<string, unknown>;
  /** Voice name */
  name: string;
  /** Preview URL (if available) */
  previewUrl?: string;
}

/**
 * Configuration for speech service providers.
 * Passed to `createSpeechProvider` to instantiate the appropriate provider.
 */
export interface SpeechProviderConfig {
  /** API key for authenticating with the provider's API */
  apiKey?: string;
  /** Base URL override; defaults to the provider's public API endpoint */
  baseUrl?: string;
  /** Default model ID to use when none is specified per-request */
  defaultModelId?: string;
  /** Default voice ID for TTS when none is specified per-request */
  defaultVoiceId?: string;
  /** Additional provider-specific options passed through as-is */
  options?: Record<string, unknown>;
  /**
   * Provider implementation to use.
   * - `'elevenlabs'` — ElevenLabs TTS (no STT)
   * - `'openai-whisper'` — OpenAI Whisper STT (no TTS)
   * - `'mock'` — Not yet implemented; throws on instantiation
   */
  provider: 'elevenlabs' | 'openai-whisper' | 'mock';
  /** Request timeout in milliseconds (provider defaults vary) */
  timeout?: number;
}

/**
 * @fileoverview Unified barrel export for all service modules.
 * @module services
 */

// Graph
export { GraphService } from './graph/core/GraphService.js';
export type { IGraphProvider } from './graph/core/IGraphProvider.js';
export type {
  Edge,
  GraphPath,
  GraphStats,
  PathOptions,
  RelateOptions,
  TraversalDirection,
  TraversalOptions,
  TraversalResult,
  Vertex,
} from './graph/types.js';
// LLM
export type { ILlmProvider, OpenRouterChatParams } from './llm/core/ILlmProvider.js';
export {
  type OpenRouterClientOptions,
  OpenRouterProvider,
} from './llm/providers/openrouter.provider.js';
// Speech
export type { ISpeechProvider } from './speech/core/ISpeechProvider.js';
export { createSpeechProvider, SpeechService } from './speech/core/SpeechService.js';
export { ElevenLabsProvider } from './speech/providers/elevenlabs.provider.js';
export { WhisperProvider } from './speech/providers/whisper.provider.js';
export type {
  AudioFormat,
  SpeechProviderConfig,
  SpeechToTextOptions,
  SpeechToTextResult,
  TextToSpeechOptions,
  TextToSpeechResult,
  Voice,
  VoiceSettings,
  WordTimestamp,
} from './speech/types.js';

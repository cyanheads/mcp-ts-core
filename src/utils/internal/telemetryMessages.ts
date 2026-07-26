/**
 * @fileoverview Message strings for the framework's per-call telemetry logs.
 * Shared by the emitter (`performance.ts`) and the rate limiter (`logger.ts`)
 * so the two cannot drift apart. A leaf module with no imports — depending on
 * either side would create a cycle.
 * @module src/utils/internal/telemetryMessages
 */

/**
 * The framework's per-call telemetry lines, emitted exactly once per tool call,
 * resource read, or prompt generation.
 *
 * Their message strings are constant by design — the variable data rides the
 * context object — so under rate limiting they look identical to a log storm
 * and get truncated at the threshold, capping log-derived call volume on any
 * server busier than that. Their repetition is request throughput, never a
 * runaway loop, so the logger exempts them from rate limiting.
 *
 * Emitters must use these constants rather than repeating the literal, so a
 * reworded message cannot silently fall back under the limiter.
 */
export const TELEMETRY_LOG_MESSAGES = {
  promptGenerationFailed: 'Prompt generation failed.',
  promptGenerationFinished: 'Prompt generation finished.',
  resourceReadFinished: 'Resource read finished.',
  toolExecutionFinished: 'Tool execution finished.',
} as const;

/** Lookup set used by the logger to bypass rate limiting. */
export const UNTHROTTLED_MESSAGES: ReadonlySet<string> = new Set(
  Object.values(TELEMETRY_LOG_MESSAGES),
);

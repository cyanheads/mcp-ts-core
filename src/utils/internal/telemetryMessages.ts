/**
 * @fileoverview Message strings for the framework's one-per-call log records.
 * Shared by the emitters (`performance.ts`, `toolHandlerFactory.ts`) and the
 * rate limiter (`logger.ts`) so the two sides cannot drift apart. A leaf module
 * with no imports — depending on either side would create a cycle.
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
  promptGenerationFinished: 'Prompt generation finished.',
  resourceReadFinished: 'Resource read finished.',
  toolExecutionFinished: 'Tool execution finished.',
} as const;

/** Lookup set used by the logger to bypass rate limiting. */
export const UNTHROTTLED_MESSAGES: ReadonlySet<string> = new Set(
  Object.values(TELEMETRY_LOG_MESSAGES),
);

/**
 * Message prefix of the opt-in failed-call payload record
 * (`LOG_TOOL_FAILURE_PAYLOADS`): `Tool failure payload: <tool>`.
 *
 * The record is written once per failed tool call, and its message is constant
 * per tool, so under rate limiting a tool failing past the threshold in one
 * window would keep only its first payloads, though each belongs to a different
 * call. The logger exempts every message starting with this prefix, as it does
 * the telemetry lines above. The call's `Error in tool:` record keeps its limit:
 * a repeated error message is the storm the limiter exists for.
 *
 * The emitter builds its message from this constant, so a reworded message
 * cannot silently fall back under the limiter.
 */
export const TOOL_FAILURE_PAYLOAD_MESSAGE_PREFIX = 'Tool failure payload: ';

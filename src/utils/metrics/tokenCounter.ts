/**
 * @fileoverview Lightweight, dependency-free token counters with model-configurable heuristics.
 * This avoids native/WASM dependencies (e.g., tiktoken) while providing a stable extension point
 * to adjust per-model tokenization and overhead later.
 * @module src/utils/metrics/tokenCounter
 */
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

/**
 * Minimal chat message shape used for token counting, intentionally provider-agnostic.
 * Covers the common subset of OpenAI-style chat message fields without depending on
 * any specific SDK types.
 */
export type ChatMessage = {
  /** The message author role (e.g. `'user'`, `'assistant'`, `'tool'`, `'system'`). */
  role: string;
  /**
   * Message body. Either a plain string, a multi-part content array (e.g. for vision
   * or tool-result messages), or `null` when the assistant emits tool calls with no
   * accompanying text.
   */
  content: string | Array<{ type: string; text?: string; [k: string]: unknown }> | null;
  /** Optional display name; when present, adds `tokensPerName` overhead per model heuristics. */
  name?: string;
  /**
   * Tool calls emitted by an `assistant` message. Only `function`-type calls are counted;
   * the function name and serialized arguments each contribute to the token total.
   */
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }> | null;
  /** Tool result correlation ID present on `tool` role messages. Counted as plain text. */
  tool_call_id?: string | null;
};

/**
 * Heuristic parameters that control how tokens are estimated for a specific model.
 * Add entries to the internal `HEURISTICS` map to calibrate per-model behavior.
 */
export interface ModelHeuristics {
  /** Average number of characters per token. ~4 for English prose on most GPT-family models. */
  charsPerToken: number;
  /**
   * Fixed token overhead added once per call to {@link countChatTokens} to account for the
   * assistant reply primer (`<|im_start|>assistant`).
   */
  replyPrimer: number;
  /** Fixed token overhead added per message (e.g. role delimiters). Typically 3 for gpt-4o. */
  tokensPerMessage: number;
  /** Extra tokens added when a message includes a `name` field. Typically 1 for gpt-4o. */
  tokensPerName: number;
}

const DEFAULT_MODEL = 'gpt-4o';

// Known heuristics; tweak as you calibrate
const HEURISTICS: Record<string, ModelHeuristics> = {
  'gpt-4o': {
    charsPerToken: 4,
    tokensPerMessage: 3,
    tokensPerName: 1,
    replyPrimer: 3,
  },
  'gpt-4o-mini': {
    charsPerToken: 4,
    tokensPerMessage: 3,
    tokensPerName: 1,
    replyPrimer: 3,
  },
  default: {
    charsPerToken: 4,
    tokensPerMessage: 3,
    tokensPerName: 1,
    replyPrimer: 3,
  },
};

function getModelHeuristics(model?: string): ModelHeuristics {
  const key = (model ?? DEFAULT_MODEL).toLowerCase();
  const found = HEURISTICS[key];
  return (found ?? HEURISTICS.default) as ModelHeuristics;
}

function nonEmptyString(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0;
}

function approxTokenCount(text: string, charsPerToken: number): number {
  if (!text) return 0;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return 0;
  return Math.ceil(normalized.length / Math.max(1, charsPerToken));
}

/**
 * Estimates the number of tokens in a plain-text string using model-specific character-per-token
 * heuristics. Whitespace is normalized before counting. No external dependencies are required.
 *
 * @param text - The input string to estimate. Empty or whitespace-only strings return `0`.
 * @param context - Optional request context forwarded to the error handler for correlated logging.
 * @param model - Model identifier used to look up heuristics (e.g. `'gpt-4o'`). Falls back to
 *   `'gpt-4o'` when omitted or unrecognized.
 * @returns Estimated token count, rounded up to the nearest integer.
 * @throws {McpError} With `InternalError` code if the heuristic calculation fails unexpectedly.
 * @example
 * const tokens = await countTokens('Hello, world!');
 * // Returns approximately 4 (13 chars / 4 charsPerToken, rounded up)
 */
export async function countTokens(
  text: string,
  context?: RequestContext,
  model?: string,
): Promise<number> {
  return await ErrorHandler.tryCatch(
    () => {
      const h: ModelHeuristics = getModelHeuristics(model);
      return approxTokenCount(text ?? '', h.charsPerToken);
    },
    {
      operation: 'countTokens',
      ...(context && { context }),
      input: {
        textSample: nonEmptyString(text)
          ? text.length > 53
            ? `${text.slice(0, 50)}...`
            : text
          : '',
      },
      errorCode: JsonRpcErrorCode.InternalError,
    },
  );
}

/**
 * Estimates the total number of tokens for an array of chat messages using the same
 * heuristics as OpenAI's token-counting cookbook for gpt-4o-family models.
 *
 * Per-message overhead (`tokensPerMessage`) and an assistant reply primer (`replyPrimer`)
 * are added on top of the raw content estimates. Counting logic:
 * - String `content`: normalized character count divided by `charsPerToken`.
 * - Array `content`: only `type: 'text'` parts are counted; other part types emit a warning
 *   and are skipped.
 * - `name` field: adds `tokensPerName` plus the name's character-count estimate.
 * - `tool_calls` (assistant role): function name and serialized arguments are counted.
 * - `tool_call_id` (tool role): counted as plain text.
 *
 * @param messages - Ordered array of chat messages to estimate. May be empty (returns
 *   `replyPrimer` tokens).
 * @param context - Optional request context forwarded to the error handler for correlated logging.
 * @param model - Model identifier used to look up heuristics (e.g. `'gpt-4o-mini'`). Falls back
 *   to `'gpt-4o'` when omitted or unrecognized.
 * @returns Estimated total token count across all messages, including per-message overhead and
 *   the reply primer.
 * @throws {McpError} With `InternalError` code if the heuristic calculation fails unexpectedly.
 * @example
 * const tokens = await countChatTokens([
 *   { role: 'user', content: 'What is 2 + 2?' },
 *   { role: 'assistant', content: 'It is 4.' },
 * ]);
 */
export async function countChatTokens(
  messages: ReadonlyArray<ChatMessage>,
  context?: RequestContext,
  model?: string,
): Promise<number> {
  return await ErrorHandler.tryCatch(
    () => {
      const h: ModelHeuristics = getModelHeuristics(model);
      let tokens = 0;

      for (const message of messages) {
        tokens += h.tokensPerMessage;

        // role contribution (very small; approximate as 1)
        tokens += 1;

        // content
        if (typeof message.content === 'string') {
          tokens += approxTokenCount(message.content, h.charsPerToken);
        } else if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (part && part.type === 'text' && nonEmptyString(part.text)) {
              tokens += approxTokenCount(part.text, h.charsPerToken);
            } else if (part) {
              logger.warning(
                `Non-text content part found (type: ${String(part.type)}), token count contribution ignored.`,
                context,
              );
            }
          }
        }

        // optional name
        if (message.name) {
          tokens += h.tokensPerName;
          tokens += approxTokenCount(message.name, h.charsPerToken);
        }

        // assistant tool calls
        if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
          for (const toolCall of message.tool_calls) {
            if (toolCall?.type === 'function') {
              if (toolCall.function?.name) {
                tokens += approxTokenCount(toolCall.function.name, h.charsPerToken);
              }
              if (toolCall.function?.arguments) {
                tokens += approxTokenCount(toolCall.function.arguments, h.charsPerToken);
              }
            }
          }
        }

        // tool message id
        if (message.role === 'tool' && message.tool_call_id) {
          tokens += approxTokenCount(message.tool_call_id, h.charsPerToken);
        }
      }

      tokens += h.replyPrimer;
      return tokens;
    },
    {
      operation: 'countChatTokens',
      ...(context && { context }),
      input: { messageCount: messages.length },
      errorCode: JsonRpcErrorCode.InternalError,
    },
  );
}
// Intentionally no generic helpers; the return above asserts to satisfy
// TypeScript with noUncheckedIndexedAccess while remaining safe at runtime.

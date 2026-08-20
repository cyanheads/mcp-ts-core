/**
 * @fileoverview Implements `OpenRouterProvider`, an `ILlmProvider` that delegates to
 * the OpenRouter API using the OpenAI-compatible SDK. The `openai` package is loaded
 * lazily via a dynamic `import()` on first use so that it remains an optional peer
 * dependency — servers that do not use LLM features avoid the startup cost and the
 * hard dependency.
 *
 * Dependencies are supplied via constructor injection (`RateLimiter`, `config`,
 * `logger`). The underlying `OpenAI` client is initialized on the first call and
 * reused across subsequent requests (singleton per provider instance).
 * @module src/services/llm/providers/openrouter.provider
 */
import type OpenAI from 'openai';
import type { ChatCompletion, ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { Stream } from 'openai/streaming';

import type { config as ConfigType } from '@/config/index.js';
import type { ILlmProvider, OpenRouterChatParams } from '@/services/llm/core/ILlmProvider.js';
import { configurationError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { lazyImport } from '@/utils/internal/lazyImport.js';
import type { logger as LoggerType } from '@/utils/internal/logger.js';
import { nowMs } from '@/utils/internal/performance.js';
import {
  type RequestContext,
  requestContextService,
  withExtra,
} from '@/utils/internal/requestContext.js';
import type { RateLimiter } from '@/utils/security/rateLimiter.js';
import { sanitization } from '@/utils/security/sanitization.js';
import {
  ATTR_GEN_AI_REQUEST_MAX_TOKENS,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_REQUEST_STREAMING,
  ATTR_GEN_AI_REQUEST_TEMPERATURE,
  ATTR_GEN_AI_REQUEST_TOP_P,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_TOKEN_TYPE,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_TOTAL_TOKENS,
} from '@/utils/telemetry/attributes.js';
import { createCounter, createHistogram } from '@/utils/telemetry/metrics.js';
import { withSpan } from '@/utils/telemetry/trace.js';

const importOpenAI = lazyImport(
  () => import('openai'),
  'Install "openai" to use the OpenRouter LLM provider: bun add openai',
);

/**
 * Lazily imports and returns the `OpenAI` default export from the `openai` package.
 * The import is deferred so that `openai` remains an optional peer dependency —
 * servers that never call an LLM method pay no startup cost.
 *
 * @returns The `OpenAI` constructor (default export of the `openai` package).
 * @throws {McpError} `ConfigurationError` if the `openai` package is not installed.
 */
async function getOpenAI() {
  const mod = await importOpenAI();
  return mod.default;
}

/**
 * Lazily-initialized OTel metrics for LLM API calls. Created on first use to
 * avoid meter overhead when the provider is never invoked.
 */
let llmRequestCounter: ReturnType<typeof createCounter> | undefined;
let llmRequestDuration: ReturnType<typeof createHistogram> | undefined;
let llmRequestErrors: ReturnType<typeof createCounter> | undefined;
let llmTokenCounter: ReturnType<typeof createCounter> | undefined;

function getLlmMetrics() {
  llmRequestCounter ??= createCounter('mcp.llm.requests', 'Total LLM API requests', '{requests}');
  llmRequestDuration ??= createHistogram('mcp.llm.duration', 'LLM API request duration', 'ms');
  llmRequestErrors ??= createCounter('mcp.llm.errors', 'Total LLM API errors', '{errors}');
  llmTokenCounter ??= createCounter('mcp.llm.tokens', 'Total LLM tokens consumed', '{tokens}');
  return { llmRequestCounter, llmRequestDuration, llmRequestErrors, llmTokenCounter };
}

/**
 * Construction options for the underlying `OpenAI` client pointed at OpenRouter.
 * Passed internally by `initClient()` — not exposed as a public constructor parameter,
 * but exported so callers can reference the shape if needed.
 */
export interface OpenRouterClientOptions {
  /** OpenRouter API key (value of `OPENROUTER_API_KEY`). */
  apiKey: string;
  /**
   * Base URL for the OpenRouter API. Defaults to `https://openrouter.ai/api/v1`
   * when not provided.
   */
  baseURL?: string;
  /**
   * Human-readable name of the calling application, sent as the `X-Title` request
   * header for OpenRouter analytics and attribution.
   */
  siteName?: string;
  /**
   * URL of the calling application, sent as the `HTTP-Referer` request header for
   * OpenRouter analytics and attribution.
   */
  siteUrl?: string;
}

/**
 * LLM provider implementation backed by the OpenRouter API.
 *
 * Implements `ILlmProvider` so it can be used anywhere the framework expects a
 * generic LLM provider. The `openai` SDK is loaded lazily on first use; the
 * resulting `OpenAI` client is cached for the lifetime of the instance.
 *
 * Default generation parameters (`model`, `temperature`, `top_p`, `max_tokens`,
 * `top_k`, `min_p`) are read from the application config at construction time and
 * applied to every request unless the caller explicitly overrides them. Passing
 * `null` for an OpenAI-typed field (e.g. `temperature: null`) clears that default.
 *
 * @example
 * ```ts
 * const provider = new OpenRouterProvider(rateLimiter, config, logger);
 * const completion = await provider.chatCompletion(
 *   { model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
 *   ctx,
 * );
 * ```
 */
export class OpenRouterProvider implements ILlmProvider {
  /** Cached `OpenAI` client instance. Undefined until the first request. */
  private client: OpenAI | undefined;
  /**
   * In-flight initialization promise. Guards against concurrent calls racing to
   * create the client simultaneously. Reset to `undefined` if `initClient` throws,
   * so the next call can retry.
   */
  private clientInitPromise: Promise<OpenAI> | undefined;
  /** Default generation parameters sourced from app config at construction time. */
  private readonly defaultParams: {
    model: string;
    temperature: number | undefined;
    topP: number | undefined;
    maxTokens: number | undefined;
    topK: number | undefined;
    minP: number | undefined;
  };

  /**
   * Creates a new `OpenRouterProvider` instance.
   *
   * @param rateLimiter - Rate limiter used to throttle outbound API calls per
   *   client/tenant key.
   * @param config - Application config object; must have `openrouterApiKey` set,
   *   and may have `llmDefault*` fields for generation defaults.
   * @param logger - Application logger for lifecycle and interaction logging.
   * @throws {McpError} `ConfigurationError` if `openrouterApiKey` is absent in config.
   */
  constructor(
    private rateLimiter: RateLimiter,
    private config: typeof ConfigType,
    private logger: typeof LoggerType,
  ) {
    const context = requestContextService.createRequestContext({
      operation: 'OpenRouterProvider.constructor',
    });

    if (!this.config.openrouterApiKey) {
      this.logger.fatal(
        'OpenRouter API key is not configured. Please set OPENROUTER_API_KEY.',
        context,
      );
      throw configurationError('OpenRouter API key is not configured.', context);
    }

    this.defaultParams = {
      model: this.config.llmDefaultModel,
      temperature: this.config.llmDefaultTemperature,
      topP: this.config.llmDefaultTopP,
      maxTokens: this.config.llmDefaultMaxTokens,
      topK: this.config.llmDefaultTopK,
      minP: this.config.llmDefaultMinP,
    };

    this.logger.info('OpenRouter provider instance created and ready.', context);
  }

  /**
   * Returns the initialized `OpenAI` client, initializing it on first call.
   * Concurrent callers share a single initialization promise to avoid duplicate
   * client construction.
   *
   * @returns The ready-to-use `OpenAI` client.
   * @throws {McpError} `ConfigurationError` if client initialization fails.
   */
  private async ensureClient(): Promise<OpenAI> {
    if (this.client) return this.client;
    this.clientInitPromise ??= this.initClient();
    return await this.clientInitPromise;
  }

  /**
   * Performs the one-time initialization of the `OpenAI` client configured for
   * the OpenRouter base URL. Lazily imports the `openai` package, constructs the
   * client with API key and optional site metadata headers, and stores the result
   * in `this.client`.
   *
   * If initialization fails, `clientInitPromise` is reset so the next call to
   * `ensureClient()` can attempt again.
   *
   * @returns The newly constructed `OpenAI` client.
   * @throws {McpError} `ConfigurationError` if the `openai` package is missing or
   *   client construction throws.
   */
  private async initClient(): Promise<OpenAI> {
    const context = requestContextService.createRequestContext({
      operation: 'OpenRouterProvider.initClient',
    });
    try {
      const OpenAIClass = await getOpenAI();
      const options: OpenRouterClientOptions = {
        apiKey: this.config.openrouterApiKey as string,
        siteUrl: this.config.openrouterAppUrl,
        siteName: this.config.openrouterAppName,
      };
      this.client = new OpenAIClass({
        baseURL: options.baseURL ?? 'https://openrouter.ai/api/v1',
        apiKey: options.apiKey,
        defaultHeaders: {
          'HTTP-Referer': options.siteUrl,
          'X-Title': options.siteName,
        },
        maxRetries: 2,
      });
      return this.client;
    } catch (e: unknown) {
      this.clientInitPromise = undefined;
      const error = e instanceof Error ? e : new Error(String(e));
      this.logger.error(
        'Failed to construct OpenRouter client',
        withExtra(context, { error: error.message }),
      );
      throw configurationError(
        'Failed to construct OpenRouter client. Please check the configuration.',
        undefined,
        { cause: error },
      );
    }
  }

  // --- PRIVATE METHODS ---

  /**
   * Merges caller-supplied parameters with instance-level defaults. OpenAI-typed
   * fields (`model`, `temperature`, `top_p`, `max_tokens`) fall back to the
   * corresponding `defaultParams` value when omitted. Passing `null` explicitly
   * clears the default (mapped to `undefined` in the result object so the field is
   * omitted from the API request).
   *
   * OpenRouter-specific fields not present in the OpenAI type definitions
   * (`top_k`, `min_p`) are applied from defaults only when not already present in
   * the incoming params.
   *
   * @param params - Raw parameters from the caller before defaults are applied.
   * @returns A new parameter object with defaults merged in, ready to send to the
   *   OpenRouter API.
   */
  private _prepareApiParameters(params: OpenRouterChatParams) {
    const { model, temperature, top_p: topP, max_tokens: maxTokens, stream, ...rest } = params;

    const result = {
      ...rest,
      model: model ?? this.defaultParams.model,
      temperature:
        temperature === null ? undefined : (temperature ?? this.defaultParams.temperature),
      top_p: topP === null ? undefined : (topP ?? this.defaultParams.topP),
      max_tokens: maxTokens === null ? undefined : (maxTokens ?? this.defaultParams.maxTokens),
      ...(typeof stream === 'boolean' && { stream }),
    };

    // OpenRouter-specific params not in OpenAI types — apply defaults
    const extra = rest as Record<string, unknown>;
    if (extra.top_k === undefined && this.defaultParams.topK !== undefined) {
      (result as Record<string, unknown>).top_k = this.defaultParams.topK;
    }
    if (extra.min_p === undefined && this.defaultParams.minP !== undefined) {
      (result as Record<string, unknown>).min_p = this.defaultParams.minP;
    }

    return result;
  }

  /**
   * Dispatches a single chat completion call to the OpenRouter API via the
   * provided `OpenAI` client. Emits an interaction log entry for the outbound
   * request and inbound response. For streaming calls, returns the `Stream`
   * immediately; the caller consumes and logs the stream (see
   * `chatCompletionStream`).
   *
   * Payload shape depends on `config.logLlmInteractions`:
   *
   * - `false` (default) — metadata only: model, message count, streaming flag,
   *   generation params, token usage.
   * - `true` — full request body and response body. Only enable when transcript
   *   persistence is an explicit audit requirement; LLM messages and completions
   *   can include user PII, secrets, or confidential prompts.
   *
   * @param client - Initialized `OpenAI` client to use for the request.
   * @param params - Fully-prepared API parameters (defaults already merged).
   * @param context - Request context for correlated log entries.
   * @returns `ChatCompletion` for non-streaming; `Stream<ChatCompletionChunk>` for streaming.
   * @throws Propagates any error thrown by the OpenAI SDK.
   */
  private async _openRouterChatCompletionLogic(
    client: OpenAI,
    params: OpenRouterChatParams,
    context: RequestContext,
    signal?: AbortSignal,
  ): Promise<ChatCompletion | Stream<ChatCompletionChunk>> {
    this.logger.logInteraction('OpenRouterRequest', {
      context,
      ...(this.config.logLlmInteractions
        ? { request: params }
        : {
            model: params.model,
            messageCount: params.messages?.length ?? 0,
            streaming: Boolean(params.stream),
            maxTokens: params.max_tokens,
            temperature: params.temperature,
            topP: params.top_p,
          }),
    });
    const requestOpts = signal ? { signal } : undefined;
    if (params.stream) {
      return client.chat.completions.create(params, requestOpts);
    } else {
      const response = await client.chat.completions.create(params, requestOpts);

      this.logger.logInteraction('OpenRouterResponse', {
        context,
        ...(this.config.logLlmInteractions
          ? { response }
          : {
              model: response.model,
              finishReasons: response.choices?.map((c) => c.finish_reason),
              usage: response.usage,
            }),
      });
      return response;
    }
  }

  // --- PUBLIC METHODS (from ILlmProvider interface) ---

  /**
   * Sends a chat completion request to OpenRouter. Enforces rate limiting keyed
   * on `context.auth?.clientId`, `context.tenantId`, or the global fallback key
   * `'openrouter_global'`. Applies generation defaults via `_prepareApiParameters`
   * before dispatching.
   *
   * Wraps execution in `ErrorHandler.tryCatch` for consistent error formatting and
   * structured logging. Input params are sanitized before logging.
   *
   * @param params - Chat completion parameters (streaming or non-streaming).
   * @param context - Request context for rate-limit keying, logging, and tracing.
   * @returns `ChatCompletion` when `params.stream` is falsy; `Stream<ChatCompletionChunk>`
   *   when `params.stream` is `true`.
   * @throws {McpError} `RateLimited` if the rate limit is exceeded.
   * @throws {McpError} `ConfigurationError` if the OpenAI client cannot be initialized.
   * @throws {McpError} `ServiceUnavailable` if the OpenRouter API call fails.
   *
   * @example
   * ```ts
   * const result = await provider.chatCompletion(
   *   { model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
   *   ctx,
   * ) as ChatCompletion;
   * console.log(result.choices[0].message.content);
   * ```
   */
  public async chatCompletion(
    params: OpenRouterChatParams,
    context: RequestContext,
    signal?: AbortSignal,
  ): Promise<ChatCompletion | Stream<ChatCompletionChunk>> {
    const operation = 'OpenRouterProvider.chatCompletion';
    const sanitizedParams = sanitization.sanitizeForLogging(params);

    // Resolve client outside tryCatch — ConfigurationError from a missing peer
    // dep is a static condition and must not inflate mcp.errors.classified.
    const client = await this.ensureClient();

    return await ErrorHandler.tryCatch(
      async () => {
        const rateLimitKey = context.auth?.clientId ?? context.tenantId ?? 'openrouter_global';
        this.rateLimiter.check(rateLimitKey, context);
        const finalApiParams = this._prepareApiParameters(params) as OpenRouterChatParams;

        return await withSpan(
          'gen_ai.chat_completion',
          async (span) => {
            const t0 = nowMs();
            let ok = false;
            try {
              const response = await this._openRouterChatCompletionLogic(
                client,
                finalApiParams,
                context,
                signal,
              );
              ok = true;

              // Record token usage and response model from non-streaming responses
              if (!params.stream && response && 'usage' in response) {
                const completion = response as ChatCompletion;
                const usage = completion.usage;
                if (usage) {
                  span.setAttribute(ATTR_GEN_AI_USAGE_INPUT_TOKENS, usage.prompt_tokens ?? 0);
                  span.setAttribute(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, usage.completion_tokens ?? 0);
                  span.setAttribute(ATTR_GEN_AI_USAGE_TOTAL_TOKENS, usage.total_tokens ?? 0);

                  const m = getLlmMetrics();
                  const tokenAttrs = { [ATTR_GEN_AI_REQUEST_MODEL]: finalApiParams.model };
                  if (usage.prompt_tokens)
                    m.llmTokenCounter.add(usage.prompt_tokens, {
                      ...tokenAttrs,
                      [ATTR_GEN_AI_TOKEN_TYPE]: 'input',
                    });
                  if (usage.completion_tokens)
                    m.llmTokenCounter.add(usage.completion_tokens, {
                      ...tokenAttrs,
                      [ATTR_GEN_AI_TOKEN_TYPE]: 'output',
                    });
                }
                span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, completion.model);
              }

              return response;
            } finally {
              const durationMs = Math.round((nowMs() - t0) * 100) / 100;
              const m = getLlmMetrics();
              const metricAttrs = {
                [ATTR_GEN_AI_REQUEST_MODEL]: finalApiParams.model,
                [ATTR_GEN_AI_SYSTEM]: 'openrouter',
              };
              m.llmRequestCounter.add(1, metricAttrs);
              m.llmRequestDuration.record(durationMs, metricAttrs);
              if (!ok) m.llmRequestErrors.add(1, metricAttrs);
            }
          },
          {
            [ATTR_GEN_AI_SYSTEM]: 'openrouter',
            [ATTR_GEN_AI_REQUEST_MODEL]: finalApiParams.model,
            ...(finalApiParams.max_tokens != null && {
              [ATTR_GEN_AI_REQUEST_MAX_TOKENS]: finalApiParams.max_tokens,
            }),
            ...(finalApiParams.temperature != null && {
              [ATTR_GEN_AI_REQUEST_TEMPERATURE]: finalApiParams.temperature,
            }),
            ...(finalApiParams.top_p != null && {
              [ATTR_GEN_AI_REQUEST_TOP_P]: finalApiParams.top_p,
            }),
            [ATTR_GEN_AI_REQUEST_STREAMING]: Boolean(params.stream),
          },
        );
      },
      { operation, context, input: sanitizedParams },
    );
  }

  /**
   * Sends a streaming chat completion request to OpenRouter and returns an async
   * generator that yields `ChatCompletionChunk` objects as they arrive.
   *
   * Internally delegates to `chatCompletion` with `stream: true` forced, then
   * wraps the resulting `Stream` in a generator that collects all chunks and logs
   * the full response (via `logInteraction`) in the generator's `finally` block
   * once the stream is exhausted or the consumer breaks out early.
   *
   * @param params - Chat completion parameters. `stream` is overridden to `true`.
   * @param context - Request context for rate-limit keying, logging, and tracing.
   * @returns An async iterable that yields `ChatCompletionChunk` objects.
   * @throws {McpError} `RateLimited` if the rate limit is exceeded.
   * @throws {McpError} `ConfigurationError` if the OpenAI client cannot be initialized.
   * @throws {McpError} `ServiceUnavailable` if the OpenRouter API call fails.
   *
   * @example
   * ```ts
   * const stream = await provider.chatCompletionStream(
   *   { model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
   *   ctx,
   * );
   * for await (const chunk of stream) {
   *   process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
   * }
   * ```
   */
  public async chatCompletionStream(
    params: OpenRouterChatParams,
    context: RequestContext,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<ChatCompletionChunk>> {
    const streamParams = { ...params, stream: true };
    const responseStream = (await this.chatCompletion(
      streamParams,
      context,
      signal,
    )) as Stream<ChatCompletionChunk>;

    const loggingStream = async function* (
      this: OpenRouterProvider,
    ): AsyncGenerator<ChatCompletionChunk> {
      const chunks: ChatCompletionChunk[] = [];
      try {
        for await (const chunk of responseStream) {
          chunks.push(chunk);
          yield chunk;
        }
      } finally {
        this.logger.logInteraction('OpenRouterResponse', {
          context,
          streaming: true,
          ...(this.config.logLlmInteractions
            ? { response: chunks }
            : {
                chunkCount: chunks.length,
                model: chunks[0]?.model,
                // Usage chunk is emitted last when `stream_options.include_usage=true`.
                usage: chunks.findLast((c) => c.usage != null)?.usage,
              }),
        });
      }
    }.bind(this)();

    return loggingStream;
  }
}

/**
 * @fileoverview Performance measurement for tool, resource, and prompt execution.
 * Wraps handler logic with OpenTelemetry spans, metric counters/histograms,
 * payload size capture, and structured logs. All three handler types get
 * symmetric instrumentation so dashboards and traces cover the full MCP surface.
 * @module src/utils/internal/performance
 */

import { SpanStatusCode, trace } from '@opentelemetry/api';

import { config } from '@/config/index.js';
import { McpError } from '@/types-global/errors.js';
import { type ErrorCategory, getErrorCategory } from '@/utils/internal/error-handler/mappings.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import {
  ATTR_CODE_FUNCTION_NAME,
  ATTR_CODE_NAMESPACE,
  ATTR_MCP_PROMPT_DURATION_MS,
  ATTR_MCP_PROMPT_ERROR_CATEGORY,
  ATTR_MCP_PROMPT_ERROR_CODE,
  ATTR_MCP_PROMPT_INPUT_BYTES,
  ATTR_MCP_PROMPT_MESSAGE_COUNT,
  ATTR_MCP_PROMPT_NAME,
  ATTR_MCP_PROMPT_OUTPUT_BYTES,
  ATTR_MCP_PROMPT_SUCCESS,
  ATTR_MCP_RESOURCE_DURATION_MS,
  ATTR_MCP_RESOURCE_ERROR_CODE,
  ATTR_MCP_RESOURCE_MIME_TYPE,
  ATTR_MCP_RESOURCE_NAME,
  ATTR_MCP_RESOURCE_SIZE_BYTES,
  ATTR_MCP_RESOURCE_SUCCESS,
  ATTR_MCP_RESOURCE_URI,
  ATTR_MCP_TOOL_BATCH_FAILED,
  ATTR_MCP_TOOL_BATCH_SUCCEEDED,
  ATTR_MCP_TOOL_DURATION_MS,
  ATTR_MCP_TOOL_ERROR_CATEGORY,
  ATTR_MCP_TOOL_ERROR_CODE,
  ATTR_MCP_TOOL_INPUT_BYTES,
  ATTR_MCP_TOOL_NAME,
  ATTR_MCP_TOOL_OUTPUT_BYTES,
  ATTR_MCP_TOOL_PARTIAL_SUCCESS,
  ATTR_MCP_TOOL_SUCCESS,
} from '@/utils/telemetry/attributes.js';
import { createCounter, createHistogram, createUpDownCounter } from '@/utils/telemetry/metrics.js';

// OTel metric instruments for tool execution (lazy-initialized on first use)
let toolCallCounter: ReturnType<typeof createCounter> | undefined;
let toolCallDuration: ReturnType<typeof createHistogram> | undefined;
let toolCallErrors: ReturnType<typeof createCounter> | undefined;
let toolInputBytes: ReturnType<typeof createHistogram> | undefined;
let toolOutputBytes: ReturnType<typeof createHistogram> | undefined;
let toolParamUsage: ReturnType<typeof createCounter> | undefined;
let activeRequests: ReturnType<typeof createUpDownCounter> | undefined;

function getToolMetrics() {
  toolCallCounter ??= createCounter('mcp.tool.calls', 'Total MCP tool invocations', '{calls}');
  toolCallDuration ??= createHistogram('mcp.tool.duration', 'MCP tool execution duration', 'ms');
  toolCallErrors ??= createCounter('mcp.tool.errors', 'Total MCP tool errors', '{errors}');
  toolInputBytes ??= createHistogram('mcp.tool.input_bytes', 'Tool input payload size', 'bytes');
  toolOutputBytes ??= createHistogram('mcp.tool.output_bytes', 'Tool output payload size', 'bytes');
  toolParamUsage ??= createCounter(
    'mcp.tool.param.usage',
    'Per-parameter usage count for tool calls',
    '{uses}',
  );
  return {
    toolCallCounter,
    toolCallDuration,
    toolCallErrors,
    toolInputBytes,
    toolOutputBytes,
    toolParamUsage,
  };
}

/** Eagerly creates tool, resource, and prompt metric instruments so series exist from startup. */
export function initHandlerMetrics(): void {
  getToolMetrics();
  getResourceMetrics();
  getPromptMetrics();
  getActiveRequestsGauge();
}

function getActiveRequestsGauge() {
  activeRequests ??= createUpDownCounter(
    'mcp.requests.active',
    'Number of in-flight tool, resource, and prompt handler executions',
    '{requests}',
  );
  return activeRequests;
}

/**
 * @deprecated No longer needed. `globalThis.performance.now` is universally
 * available on Node ≥24 and Bun ≥1.3. Kept as a no-op export to avoid a
 * breaking change for consumers that call it during startup.
 */
export function loadPerfHooks(): Promise<{
  performance: { now: () => number };
}> {
  // performance is an ambient global declared by @types/node (perf_hooks.d.ts)
  // and available in all supported environments (Node ≥24, Bun ≥1.3, workerd).
  return Promise.resolve({ performance });
}

/**
 * @deprecated No longer needed. `nowMs` now delegates directly to
 * `globalThis.performance.now()`, which is universally available on Node ≥24
 * and Bun ≥1.3. This function is a no-op and will be removed in a future
 * major release.
 *
 * @returns A promise that resolves immediately.
 */
export function initHighResTimer(_perfLoader?: typeof loadPerfHooks): Promise<void> {
  // No-op: globalThis.performance.now is guaranteed on all supported floors.
  return Promise.resolve();
}

/**
 * Returns the current time in milliseconds using `globalThis.performance.now()`.
 *
 * Sub-millisecond resolution is guaranteed on all supported engine floors
 * (Node ≥24, Bun ≥1.3, Cloudflare Workers). The returned value is suitable for
 * computing durations but its epoch origin is implementation-defined — do not
 * treat it as a wall-clock timestamp.
 *
 * @returns Current time in milliseconds.
 */
// performance is an ambient global declared by @types/node (perf_hooks.d.ts)
// and available in all supported environments (Node ≥24, Bun ≥1.3, workerd).
export const nowMs = (): number => performance.now();

// Module-level TextEncoder singleton (stateless, safe to reuse)
let cachedEncoder: TextEncoder | undefined;
function getEncoder(): TextEncoder {
  cachedEncoder ??= new TextEncoder();
  return cachedEncoder;
}

/**
 * Recursively estimates the JSON-serialized byte size of a value without
 * allocating the serialized string. Counts structural overhead (braces,
 * brackets, colons, commas, quotes) and delegates to `String.length` for
 * primitives — which is close to UTF-8 byte length for ASCII-dominant data
 * and a slight undercount for multi-byte characters (acceptable for metrics).
 */
function estimateJsonSize(value: unknown): number {
  if (value === null || value === undefined) return 4; // "null"

  switch (typeof value) {
    case 'string':
      return value.length + 2; // +2 for surrounding quotes
    case 'number':
    case 'bigint':
      return String(value).length;
    case 'boolean':
      return value ? 4 : 5;
    default:
      break;
  }

  if (Array.isArray(value)) {
    let bytes = 2; // []
    for (let i = 0; i < value.length; i++) {
      if (i > 0) bytes += 1; // comma
      bytes += estimateJsonSize(value[i]);
    }
    return bytes;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    let bytes = 2; // {}
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i] as string;
      if (i > 0) bytes += 1; // comma
      bytes += key.length + 3; // "key":
      bytes += estimateJsonSize(obj[key]);
    }
    return bytes;
  }

  return 0;
}

/**
 * Computes the byte size of a payload as it would appear in JSON. Uses
 * `JSON.stringify` for exact measurement. Falls back to a walk-based
 * estimator when stringify throws (circular references, BigInt).
 */
const toBytes = (payload: unknown): number => {
  if (payload == null) return 0;
  try {
    const json = JSON.stringify(payload);
    // If stringify succeeded, measure the actual string — this is the common
    // and most accurate path. The threshold guards against pathological cases
    // where stringify produces a huge string; for those we still have the
    // result so we measure it (the allocation already happened).
    if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
      return Buffer.byteLength(json, 'utf8');
    }
    if (typeof TextEncoder !== 'undefined') {
      return getEncoder().encode(json).length;
    }
    return json.length;
  } catch {
    // JSON.stringify can throw on circular references or BigInt — fall back
    // to the walk-based estimator which skips non-serializable values.
    try {
      return estimateJsonSize(payload);
    } catch {
      return 0;
    }
  }
};

/**
 * Wraps a tool's logic function with observability: an OpenTelemetry span,
 * OTel metric counters/histogram, payload size capture, and structured log.
 *
 * The caller supplies the raw tool logic as `toolLogicFn`; this function handles
 * all instrumentation so tool handlers stay free of telemetry boilerplate.
 *
 * On success the resolved value is passed through transparently.
 * On failure the error is re-thrown after being recorded on the span and metrics;
 * `McpError` instances surface their numeric `code` as the error code attribute.
 *
 * @template T - The resolved type of the tool's return value.
 * @param toolLogicFn - Zero-argument async function containing the tool's business logic.
 * @param context - Request context extended with `toolName`; used for span/log correlation.
 * @param inputPayload - The raw input object passed to the tool, serialized to compute byte size.
 * @param successAttributes - Optional thunk evaluated after a successful run; its
 *   returned key/value map is set on the span as extra attributes. Lets callers
 *   attach post-hoc signals (e.g. `mcp.tool.enriched`) without coupling this
 *   function to their domain. Not called on the error path.
 * @returns A promise that resolves with the tool's return value or rejects with the original error.
 */
export async function measureToolExecution<T>(
  toolLogicFn: () => Promise<T>,
  context: RequestContext & { toolName: string },
  inputPayload: unknown,
  successAttributes?: () => Record<string, boolean | number | string>,
): Promise<T> {
  const tracer = trace.getTracer(
    config.openTelemetry.serviceName,
    config.openTelemetry.serviceVersion,
  );

  const { toolName } = context;

  return await tracer.startActiveSpan(`tool_execution:${toolName}` as const, async (span) => {
    const activeGauge = getActiveRequestsGauge();
    activeGauge.add(1);

    const t0 = nowMs();
    const inputBytes = toBytes(inputPayload);
    span.setAttributes({
      [ATTR_CODE_FUNCTION_NAME]: toolName,
      [ATTR_CODE_NAMESPACE]: 'mcp-tools',
      [ATTR_MCP_TOOL_INPUT_BYTES]: inputBytes,
    });

    let ok = false;
    let errorCode: string | undefined;
    let errorCategory: ErrorCategory | undefined;
    let outputBytes = 0;
    let partialSuccess = false;
    let batchSucceeded: number | undefined;
    let batchFailed: number | undefined;

    try {
      const result = await toolLogicFn();
      ok = true;
      outputBytes = toBytes(result);

      // Detect partial success: handler returned but result contains a non-empty `failed` array.
      // Convention-based — matches the batch response pattern recommended by the design skill.
      if (result != null && typeof result === 'object' && !Array.isArray(result)) {
        const obj = result as Record<string, unknown>;
        if (Array.isArray(obj.failed) && obj.failed.length > 0) {
          partialSuccess = true;
          batchFailed = obj.failed.length;
          if (Array.isArray(obj.succeeded)) batchSucceeded = obj.succeeded.length;
        }
      }

      span.setStatus({ code: SpanStatusCode.OK });
      span.setAttribute(ATTR_MCP_TOOL_OUTPUT_BYTES, outputBytes);
      if (partialSuccess) {
        span.setAttribute(ATTR_MCP_TOOL_PARTIAL_SUCCESS, true);
        if (batchFailed !== undefined) span.setAttribute(ATTR_MCP_TOOL_BATCH_FAILED, batchFailed);
        if (batchSucceeded !== undefined)
          span.setAttribute(ATTR_MCP_TOOL_BATCH_SUCCEEDED, batchSucceeded);
      }
      if (successAttributes) {
        for (const [key, value] of Object.entries(successAttributes())) {
          span.setAttribute(key, value);
        }
      }
      return result;
    } catch (err) {
      if (err instanceof McpError) {
        errorCode = String(err.code);
        errorCategory = getErrorCategory(err.code);
      } else {
        errorCode = err instanceof Error ? 'UNHANDLED_ERROR' : 'UNKNOWN_ERROR';
        errorCategory = 'server';
      }

      if (err instanceof Error) span.recordException(err);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      activeGauge.add(-1);
      const t1 = nowMs();
      const durationMs = Math.round((t1 - t0) * 100) / 100;

      span.setAttributes({
        [ATTR_MCP_TOOL_DURATION_MS]: durationMs,
        [ATTR_MCP_TOOL_SUCCESS]: ok,
      });
      if (errorCode) span.setAttribute(ATTR_MCP_TOOL_ERROR_CODE, errorCode);
      span.end();

      // Record to OTel metric instruments (durable across restarts)
      const m = getToolMetrics();
      const metricAttrs = { [ATTR_MCP_TOOL_NAME]: toolName, [ATTR_MCP_TOOL_SUCCESS]: ok };
      const toolAttrs = { [ATTR_MCP_TOOL_NAME]: toolName };
      m.toolCallCounter.add(1, metricAttrs);
      m.toolCallDuration.record(durationMs, metricAttrs);
      m.toolInputBytes.record(inputBytes, toolAttrs);
      if (ok) m.toolOutputBytes.record(outputBytes, toolAttrs);
      if (!ok) {
        m.toolCallErrors.add(1, {
          ...toolAttrs,
          ...(errorCategory && { [ATTR_MCP_TOOL_ERROR_CATEGORY]: errorCategory }),
        });
      }

      // Record which parameters were supplied (top-level keys only)
      if (inputPayload && typeof inputPayload === 'object') {
        for (const param of Object.keys(inputPayload as Record<string, unknown>)) {
          m.toolParamUsage.add(1, { [ATTR_MCP_TOOL_NAME]: toolName, 'mcp.tool.param': param });
        }
      }

      logger.info('Tool execution finished.', {
        ...context,
        metrics: {
          durationMs,
          isSuccess: ok,
          errorCode,
          inputBytes,
          outputBytes,
          ...(partialSuccess && { partialSuccess, batchSucceeded, batchFailed }),
        },
      });
    }
  });
}

// ==========================================================================
// Resource execution measurement
// ==========================================================================

let resourceReadCounter: ReturnType<typeof createCounter> | undefined;
let resourceReadDuration: ReturnType<typeof createHistogram> | undefined;
let resourceReadErrors: ReturnType<typeof createCounter> | undefined;

let resourceOutputBytes: ReturnType<typeof createHistogram> | undefined;

function getResourceMetrics() {
  resourceReadCounter ??= createCounter(
    'mcp.resource.reads',
    'Total MCP resource read invocations',
    '{reads}',
  );
  resourceReadDuration ??= createHistogram(
    'mcp.resource.duration',
    'MCP resource read execution duration',
    'ms',
  );
  resourceReadErrors ??= createCounter(
    'mcp.resource.errors',
    'Total MCP resource read errors',
    '{errors}',
  );
  resourceOutputBytes ??= createHistogram(
    'mcp.resource.output_bytes',
    'Resource output payload size',
    'bytes',
  );
  return { resourceReadCounter, resourceReadDuration, resourceReadErrors, resourceOutputBytes };
}

/**
 * Wraps a resource handler with observability: OTel span, metric counters/histogram,
 * and a structured log. Mirrors {@link measureToolExecution} but tuned for resource reads.
 *
 * @template T - The resolved type of the resource handler's return value.
 * @param resourceLogicFn - Zero-argument async function containing the resource handler.
 * @param context - Request context extended with `resourceName`; used for span/log correlation.
 * @param meta - Resource metadata: URI and MIME type for span attributes.
 * @returns A promise that resolves with the handler's return value or rejects with the original error.
 */
export async function measureResourceExecution<T>(
  resourceLogicFn: () => Promise<T>,
  context: RequestContext & { resourceName: string },
  meta: { uri: string; mimeType: string },
): Promise<T> {
  const tracer = trace.getTracer(
    config.openTelemetry.serviceName,
    config.openTelemetry.serviceVersion,
  );

  const { resourceName } = context;

  return await tracer.startActiveSpan(`resource_read:${resourceName}` as const, async (span) => {
    const activeGauge = getActiveRequestsGauge();
    activeGauge.add(1);
    const t0 = nowMs();

    span.setAttributes({
      [ATTR_CODE_FUNCTION_NAME]: resourceName,
      [ATTR_CODE_NAMESPACE]: 'mcp-resources',
      [ATTR_MCP_RESOURCE_URI]: meta.uri,
      [ATTR_MCP_RESOURCE_MIME_TYPE]: meta.mimeType,
    });

    let ok = false;
    let errorCode: string | undefined;
    let outputBytes = 0;

    try {
      const result = await resourceLogicFn();
      ok = true;
      outputBytes = toBytes(result);
      span.setStatus({ code: SpanStatusCode.OK });
      span.setAttribute(ATTR_MCP_RESOURCE_SIZE_BYTES, outputBytes);
      return result;
    } catch (err) {
      if (err instanceof McpError) errorCode = String(err.code);
      else if (err instanceof Error) errorCode = 'UNHANDLED_ERROR';
      else errorCode = 'UNKNOWN_ERROR';

      if (err instanceof Error) span.recordException(err);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      activeGauge.add(-1);
      const t1 = nowMs();
      const durationMs = Math.round((t1 - t0) * 100) / 100;

      span.setAttributes({
        [ATTR_MCP_RESOURCE_DURATION_MS]: durationMs,
        [ATTR_MCP_RESOURCE_SUCCESS]: ok,
      });
      if (errorCode) span.setAttribute(ATTR_MCP_RESOURCE_ERROR_CODE, errorCode);
      span.end();

      const m = getResourceMetrics();
      const metricAttrs = {
        [ATTR_MCP_RESOURCE_NAME]: resourceName,
        [ATTR_MCP_RESOURCE_SUCCESS]: ok,
      };
      const resourceAttrs = { [ATTR_MCP_RESOURCE_NAME]: resourceName };
      m.resourceReadCounter.add(1, metricAttrs);
      m.resourceReadDuration.record(durationMs, metricAttrs);
      if (ok) m.resourceOutputBytes.record(outputBytes, resourceAttrs);
      if (!ok) m.resourceReadErrors.add(1, resourceAttrs);

      logger.info('Resource read finished.', {
        ...context,
        metrics: {
          durationMs,
          isSuccess: ok,
          errorCode,
          outputBytes,
          uri: meta.uri,
          mimeType: meta.mimeType,
        },
      });
    }
  });
}

// ==========================================================================
// Prompt generation measurement
// ==========================================================================

let promptGenCounter: ReturnType<typeof createCounter> | undefined;
let promptGenDuration: ReturnType<typeof createHistogram> | undefined;
let promptGenErrors: ReturnType<typeof createCounter> | undefined;
let promptInputBytes: ReturnType<typeof createHistogram> | undefined;
let promptOutputBytes: ReturnType<typeof createHistogram> | undefined;
let promptMessageCount: ReturnType<typeof createHistogram> | undefined;

function getPromptMetrics() {
  promptGenCounter ??= createCounter(
    'mcp.prompt.generations',
    'Total MCP prompt generations',
    '{generations}',
  );
  promptGenDuration ??= createHistogram(
    'mcp.prompt.duration',
    'MCP prompt generation duration',
    'ms',
  );
  promptGenErrors ??= createCounter('mcp.prompt.errors', 'Total MCP prompt errors', '{errors}');
  promptInputBytes ??= createHistogram(
    'mcp.prompt.input_bytes',
    'Prompt argument payload size',
    'bytes',
  );
  promptOutputBytes ??= createHistogram(
    'mcp.prompt.output_bytes',
    'Prompt generated messages payload size',
    'bytes',
  );
  promptMessageCount ??= createHistogram(
    'mcp.prompt.message_count',
    'Number of messages returned by a prompt generate call',
    '{messages}',
  );
  return {
    promptGenCounter,
    promptGenDuration,
    promptGenErrors,
    promptInputBytes,
    promptOutputBytes,
    promptMessageCount,
  };
}

/**
 * Wraps a prompt generate function with observability: an OpenTelemetry span,
 * OTel metric counters/histograms, payload size capture, and structured log.
 *
 * Prompts can now perform meaningful work (conditional logic, async data fetches,
 * multi-message assembly), so they get the same instrumentation depth as tools
 * and resources. Kept symmetric to {@link measureToolExecution} and
 * {@link measureResourceExecution}.
 *
 * @template T - The resolved type of the prompt generate function's return value.
 * @param promptLogicFn - Zero-argument async function containing the prompt's generate logic.
 * @param context - Request context extended with `promptName`; used for span/log correlation.
 * @param inputPayload - The validated args object passed to the prompt, serialized to compute byte size.
 * @returns A promise that resolves with the generate result or rejects with the original error.
 */
export async function measurePromptGeneration<T>(
  promptLogicFn: () => Promise<T>,
  context: RequestContext & { promptName: string },
  inputPayload: unknown,
): Promise<T> {
  const tracer = trace.getTracer(
    config.openTelemetry.serviceName,
    config.openTelemetry.serviceVersion,
  );

  const { promptName } = context;

  return await tracer.startActiveSpan(`prompt_generation:${promptName}` as const, async (span) => {
    const activeGauge = getActiveRequestsGauge();
    activeGauge.add(1);

    const t0 = nowMs();
    const inputBytes = toBytes(inputPayload);
    span.setAttributes({
      [ATTR_CODE_FUNCTION_NAME]: promptName,
      [ATTR_CODE_NAMESPACE]: 'mcp-prompts',
      [ATTR_MCP_PROMPT_INPUT_BYTES]: inputBytes,
    });

    let ok = false;
    let errorCode: string | undefined;
    let errorCategory: ErrorCategory | undefined;
    let outputBytes = 0;
    let messageCount = 0;

    try {
      const result = await promptLogicFn();
      ok = true;
      outputBytes = toBytes(result);
      if (Array.isArray(result)) messageCount = result.length;

      span.setStatus({ code: SpanStatusCode.OK });
      span.setAttribute(ATTR_MCP_PROMPT_OUTPUT_BYTES, outputBytes);
      span.setAttribute(ATTR_MCP_PROMPT_MESSAGE_COUNT, messageCount);
      return result;
    } catch (err) {
      if (err instanceof McpError) {
        errorCode = String(err.code);
        errorCategory = getErrorCategory(err.code);
      } else {
        errorCode = err instanceof Error ? 'UNHANDLED_ERROR' : 'UNKNOWN_ERROR';
        errorCategory = 'server';
      }

      if (err instanceof Error) span.recordException(err);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      activeGauge.add(-1);
      const t1 = nowMs();
      const durationMs = Math.round((t1 - t0) * 100) / 100;

      span.setAttributes({
        [ATTR_MCP_PROMPT_DURATION_MS]: durationMs,
        [ATTR_MCP_PROMPT_SUCCESS]: ok,
      });
      if (errorCode) span.setAttribute(ATTR_MCP_PROMPT_ERROR_CODE, errorCode);
      span.end();

      const m = getPromptMetrics();
      const metricAttrs = { [ATTR_MCP_PROMPT_NAME]: promptName, [ATTR_MCP_PROMPT_SUCCESS]: ok };
      const promptAttrs = { [ATTR_MCP_PROMPT_NAME]: promptName };
      m.promptGenCounter.add(1, metricAttrs);
      m.promptGenDuration.record(durationMs, metricAttrs);
      m.promptInputBytes.record(inputBytes, promptAttrs);
      if (ok) {
        m.promptOutputBytes.record(outputBytes, promptAttrs);
        m.promptMessageCount.record(messageCount, promptAttrs);
      }
      if (!ok) {
        m.promptGenErrors.add(1, {
          ...promptAttrs,
          ...(errorCategory && { [ATTR_MCP_PROMPT_ERROR_CATEGORY]: errorCategory }),
        });
      }

      const logFn = ok ? logger.info : logger.error;
      logFn.call(logger, `Prompt generation ${ok ? 'finished' : 'failed'}.`, {
        ...context,
        metrics: {
          durationMs,
          isSuccess: ok,
          errorCode,
          inputBytes,
          outputBytes,
          messageCount,
        },
      });
    }
  });
}

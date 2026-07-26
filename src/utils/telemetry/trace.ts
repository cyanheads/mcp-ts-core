/**
 * @fileoverview Helpers for working with trace context across boundaries.
 * Provides utilities for W3C traceparent headers, distributed tracing,
 * custom span creation, and context propagation across async boundaries.
 * @module src/utils/telemetry/trace
 */
import {
  context as otContext,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';

import { config } from '@/config/index.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

/**
 * Parsed fields from a W3C `traceparent` header (`00-<traceId>-<spanId>-<flags>`).
 * Used to propagate distributed trace context across service boundaries.
 * @see https://www.w3.org/TR/trace-context/
 */
export interface TraceparentInfo {
  /** Whether the trace is sampled (flags byte `01` = sampled, `00` = not sampled). */
  sampled: boolean;
  /** W3C parent span ID — 16 lowercase hex characters identifying the caller's span. */
  spanId: string;
  /** W3C trace ID — 32 lowercase hex characters shared across the entire distributed trace. */
  traceId: string;
}

/**
 * Builds a W3C `traceparent` header value from a `RequestContext` or the currently active span.
 * Uses `ctx.traceId`/`ctx.spanId` when provided; falls back to the active OTel span context.
 * The version field is always `00` and the flags byte is hardcoded to `01` (sampled).
 * Returns `undefined` when neither source yields a trace ID and span ID.
 *
 * @param ctx - Optional RequestContext containing `traceId` and `spanId`
 * @returns Formatted `traceparent` string (e.g., `00-<traceId>-<spanId>-01`), or `undefined`
 *
 * @example
 * ```typescript
 * const traceparent = buildTraceparent(requestContext);
 * if (traceparent) {
 *   fetch(url, { headers: { traceparent } });
 * }
 * ```
 */
export function buildTraceparent(ctx?: RequestContext): string | undefined {
  const traceId =
    (ctx?.traceId as string | undefined) ?? trace.getActiveSpan()?.spanContext().traceId;
  const spanId = (ctx?.spanId as string | undefined) ?? trace.getActiveSpan()?.spanContext().spanId;
  if (!traceId || !spanId) return;
  // We do not currently read flags reliably from context; assume sampled
  return `00-${traceId}-${spanId}-01`;
}

/**
 * Extracts W3C traceparent from headers and returns parsed trace/span IDs.
 * Returns undefined if header is missing or malformed.
 *
 * @param headers - Headers object (Web API Headers or plain object)
 * @returns Parsed traceparent info or undefined
 *
 * @example
 * ```typescript
 * // Extract trace context from incoming request
 * const trace = extractTraceparent(request.headers);
 * if (trace) {
 *   logger.info('Processing with parent trace', {
 *     traceId: trace.traceId,
 *     sampled: trace.sampled
 *   });
 * }
 * ```
 */
export function extractTraceparent(
  headers: Headers | Record<string, string | undefined>,
): TraceparentInfo | undefined {
  const headerValue = headers instanceof Headers ? headers.get('traceparent') : headers.traceparent;

  if (!headerValue) return;

  // W3C traceparent format: 00-{traceId}-{spanId}-{flags}
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(headerValue);
  if (!match?.[1] || !match[2] || !match[3]) return;

  return {
    traceId: match[1],
    spanId: match[2],
    sampled: match[3] === '01',
  };
}

/**
 * Creates a child RequestContext with parent trace context extracted from headers.
 * Useful for propagating trace context from incoming HTTP requests.
 *
 * @param parentHeaders - Headers containing traceparent
 * @param operation - Operation name for the new context
 * @returns New RequestContext with inherited trace context
 *
 * @example
 * ```typescript
 * // In HTTP handler
 * const context = createContextWithParentTrace(
 *   request.headers,
 *   'handleApiRequest'
 * );
 * logger.info('Processing request', context);
 * ```
 */
export function createContextWithParentTrace(
  parentHeaders: Headers | Record<string, string | undefined>,
  operation: string,
): RequestContext {
  const traceInfo = extractTraceparent(parentHeaders);
  return requestContextService.createRequestContext({
    operation,
    ...(traceInfo && {
      traceId: traceInfo.traceId,
      parentSpanId: traceInfo.spanId,
    }),
  });
}

/**
 * Injects the current active context into a carrier, returning it.
 * Useful for HTTP headers: pass an object and use resulting key/values.
 *
 * @param carrier - Object to inject context into (typically headers)
 * @returns Same carrier with injected trace context
 *
 * @example
 * ```typescript
 * const headers = injectCurrentContextInto({
 *   'Content-Type': 'application/json'
 * });
 * // headers now contains traceparent, tracestate, etc.
 * ```
 */
export function injectCurrentContextInto<T extends Record<string, unknown>>(carrier: T): T {
  propagation.inject(otContext.active(), carrier);
  return carrier;
}

/**
 * Creates a new span for manual instrumentation with automatic error handling.
 * The span is automatically marked as OK on success or ERROR on exception.
 * Errors are recorded as exceptions and automatically propagated.
 *
 * @param operationName - Name of the span (e.g., 'database.query', 'external.api')
 * @param fn - Async function to execute within the span
 * @param attributes - Optional attributes to attach to the span
 * @returns Promise resolving to the function's return value
 *
 * @example
 * ```typescript
 * // Instrument a database query
 * const users = await withSpan(
 *   'database.query.users',
 *   async () => db.users.findMany(),
 *   { 'db.table': 'users', 'db.operation': 'select' }
 * );
 * ```
 */
export async function withSpan<T>(
  operationName: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  const tracer = trace.getTracer(
    config.openTelemetry.serviceName,
    config.openTelemetry.serviceVersion,
  );

  return await tracer.startActiveSpan(operationName, async (span) => {
    if (attributes) {
      span.setAttributes(attributes);
    }

    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error: unknown) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Runs a function within the currently active OpenTelemetry context.
 * Useful for carrying the active context across async boundaries (e.g., `setTimeout`, `queueMicrotask`).
 *
 * **Limitation:** When `ctx` contains trace IDs, this function executes within the
 * current active context rather than restoring `ctx`'s specific span context.
 * Full span restoration would require span recreation, which this utility intentionally avoids.
 * If `ctx` has no trace IDs, `fn` is called directly without any context wrapping.
 *
 * @param ctx - RequestContext containing trace IDs; if missing or lacking IDs, `fn` runs directly
 * @param fn - Function to execute within the active OTel context
 * @returns Result of `fn`
 *
 * @example
 * ```typescript
 * // Carry the active OTel context into a setTimeout callback
 * const context = requestContextService.createRequestContext({ operation: 'delayed' });
 * setTimeout(() => {
 *   runInContext(context, () => {
 *     logger.info('Still in trace context', context);
 *   });
 * }, 1000);
 * ```
 */
export function runInContext<T>(ctx: RequestContext | undefined, fn: () => T): T {
  // If no trace context, run directly
  if (!ctx?.traceId || !ctx?.spanId) {
    return fn();
  }

  // Execute within the active context
  // Note: Full context restoration would require span recreation
  // This simplified version maintains execution but doesn't create new spans
  return otContext.with(otContext.active(), fn);
}

/**
 * Runs a function with no active span, detached from whatever context is
 * current at the call site.
 *
 * Long-lived listeners must be registered this way. The OTel context manager is
 * AsyncLocalStorage-backed, and an ALS store captured when a server socket or
 * stream listener is created propagates to every async resource that listener
 * later spawns. Registering inside an active span therefore pins every
 * subsequent request to that span's trace — the span itself has long since
 * ended, but an ended span still carries a valid `SpanContext`, so later
 * children inherit its `traceId` and parent `spanId` for the process lifetime.
 *
 * Detaching the registration lets each request start its own trace (or join the
 * caller's, when a `traceparent` header is present).
 *
 * @param fn - Function to execute with no active span
 * @returns Result of `fn`
 *
 * @example
 * ```typescript
 * // Bind an HTTP server without pinning every request to the startup trace
 * await runDetached(() => transportManager.start());
 * ```
 */
export function runDetached<T>(fn: () => T): T {
  return otContext.with(ROOT_CONTEXT, fn);
}

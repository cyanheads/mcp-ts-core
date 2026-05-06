/**
 * @fileoverview Handler factory for tool definitions.
 * Constructs Context, checks inline auth, measures execution, formats response.
 * @module src/mcp-server/tools/utils/toolHandlerFactory
 */

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ContentBlock,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';

import { ZodError, type ZodObject, type ZodRawShape } from 'zod';

import { config } from '@/config/index.js';
import type { Context, SamplingOpts } from '@/core/context.js';
import { attachTypedFail, createContext } from '@/core/context.js';
import { withRequiredScopes } from '@/mcp-server/transports/auth/lib/authUtils.js';
import type { StorageService } from '@/storage/core/StorageService.js';
import { type JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import type { Logger } from '@/utils/internal/logger.js';
import { measureToolExecution } from '@/utils/internal/performance.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import type { AnyToolDefinition } from './toolDefinition.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SdkExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

interface SdkRuntimeCapabilities {
  createMessage?: (params: Record<string, unknown>) => Promise<unknown>;
  elicitInput?: (params: { message: string; requestedSchema: unknown }) => Promise<unknown>;
}

/** Services required by the handler factory to construct Context. */
export interface HandlerFactoryServices {
  /**
   * When true, surface `ctx.sessionId` even in stateless HTTP mode (per-request
   * generated token). Wired from `createApp({ context: { exposeStatelessSessionId } })`.
   * Default false — `ctx.sessionId` is only set when the session has
   * request-spanning lifetime (HTTP `stateful` / `auto` mode).
   */
  exposeStatelessSessionId?: boolean;
  logger: Logger;
  storage: StorageService;
}

/**
 * Per-server notifier closures bound at registration time.
 * Split from {@link HandlerFactoryServices} so each per-request McpServer gets
 * its own notifier closures — preventing a concurrent registerAll() from
 * overwriting an in-flight handler's notifier target (and potentially
 * notifying the wrong server).
 */
export interface HandlerNotifiers {
  notifyResourceListChanged?: () => void;
  notifyResourceUpdated?: (uri: string) => void;
}

// ---------------------------------------------------------------------------
// Default formatter
// ---------------------------------------------------------------------------

const defaultResponseFormatter = (result: unknown): ContentBlock[] => [
  { type: 'text', text: JSON.stringify(result, null, 2) },
];

// ---------------------------------------------------------------------------
// Error response shaping
// ---------------------------------------------------------------------------

/**
 * Pulls `data.recovery.hint` from an error data payload when present and
 * non-empty. Returns `undefined` otherwise. Used to mirror the hint into
 * `content[]` text so format()-only clients see the same recovery guidance
 * structuredContent-only clients receive via `error.data.recovery.hint`.
 */
function extractRecoveryHint(data: Record<string, unknown> | undefined): string | undefined {
  const hint = (data?.recovery as { hint?: unknown } | undefined)?.hint;
  return typeof hint === 'string' && hint.length > 0 ? hint : undefined;
}

/**
 * Shapes a `CallToolResult` for a tool error response with parity across both
 * surfaces clients forward to the agent:
 * - `content[]` — read by clients like Claude Desktop (markdown)
 * - `structuredContent.error` — read by clients like Claude Code (JSON)
 *
 * Both surfaces carry the same payload. When `data.recovery.hint` is present,
 * it is also mirrored into the `content[]` text so format()-only clients see
 * the recovery guidance.
 *
 * Note: `_meta.error` is intentionally NOT emitted — the error code, message,
 * and data live on `structuredContent.error` instead, mirroring the success
 * path's `structuredContent` surface.
 */
export function buildToolErrorResult(
  code: JsonRpcErrorCode,
  message: string,
  data: Record<string, unknown> | undefined,
): CallToolResult {
  const hint = extractRecoveryHint(data);
  const text = hint ? `Error: ${message}\n\nRecovery: ${hint}` : `Error: ${message}`;
  return {
    isError: true,
    content: [{ type: 'text', text }],
    structuredContent: {
      error: {
        code,
        message,
        ...(data !== undefined && { data }),
      },
    },
  };
}

/**
 * Builds an error `CallToolResult` from a raw thrown value. Classifies via
 * {@link ErrorHandler.classifyOnly} when the value isn't already an
 * `McpError`. Only propagates data from `McpError` (its declared `data`) or
 * `ZodError` (its `issues`) — other thrown values get a `structuredContent.error`
 * with `code` and `message` only, so internal classification context never
 * leaks to clients.
 *
 * Use after invoking {@link ErrorHandler.handleError} for OTel/logging side
 * effects — this helper does not log.
 */
export function classifyAndBuildToolErrorResult(error: unknown): CallToolResult {
  if (error instanceof McpError) {
    return buildToolErrorResult(error.code, error.message, error.data);
  }
  const { code, message } = ErrorHandler.classifyOnly(error);
  const data = error instanceof ZodError ? { issues: error.issues } : undefined;
  return buildToolErrorResult(code, message, data);
}

// ---------------------------------------------------------------------------
// Capability detection helpers
// ---------------------------------------------------------------------------

function wrapElicit(sdkContext: SdkRuntimeCapabilities): Context['elicit'] {
  if (typeof sdkContext.elicitInput !== 'function') return;
  const fn = sdkContext.elicitInput;
  return (msg: string, schema: ZodObject<ZodRawShape>) =>
    fn({ message: msg, requestedSchema: schema }) as ReturnType<NonNullable<Context['elicit']>>;
}

function wrapSample(sdkContext: SdkRuntimeCapabilities): Context['sample'] {
  if (typeof sdkContext.createMessage !== 'function') return;
  const fn = sdkContext.createMessage;
  return (msgs: Parameters<NonNullable<Context['sample']>>[0], opts?: SamplingOpts) =>
    fn({ messages: msgs, ...opts }) as ReturnType<NonNullable<Context['sample']>>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an MCP tool handler from a tool definition.
 * The returned function is compatible with the MCP SDK's ToolCallback type.
 *
 * Responsibilities:
 * - Creates RequestContext from SDK context (for tracing)
 * - Creates unified Context (for the handler)
 * - Checks inline `auth` scopes if defined
 * - Validates input via Zod schema
 * - Measures execution time
 * - Formats response via `format` or JSON default
 * - Catches errors and returns `isError: true`
 */
export function createToolHandler(
  def: AnyToolDefinition,
  services: HandlerFactoryServices,
  notifiers: HandlerNotifiers,
): (input: Record<string, unknown>, extra: SdkExtra) => Promise<CallToolResult> {
  const formatter = def.format ?? defaultResponseFormatter;

  return async (input, callContext): Promise<CallToolResult> => {
    // The SDK types `extra` as Record<string, unknown> at the boundary
    const sdkContext = callContext as unknown as SdkExtra;
    const sdkCaps = callContext as unknown as SdkRuntimeCapabilities;

    const sdkSessionId =
      typeof sdkContext?.sessionId === 'string' ? sdkContext.sessionId : undefined;

    // Surface sessionId on `Context` only when it has request-spanning
    // lifetime — stateful HTTP (or `auto`, which resolves to stateful for
    // HTTP). In stateless mode the SDK still hands us a per-request token;
    // pass it through only when the consumer opted in via
    // `createApp({ context: { exposeStatelessSessionId: true } })`. Stdio
    // gives no sessionId at the SDK layer, so the gate is moot there.
    const isStatefulMode = config.mcpSessionMode === 'stateful' || config.mcpSessionMode === 'auto';
    const handlerSessionId =
      sdkSessionId && (isStatefulMode || services.exposeStatelessSessionId === true)
        ? sdkSessionId
        : undefined;

    // Create internal RequestContext for tracing. Raw `input` is intentionally
    // excluded — it flows into the completion log via context spread and can
    // contain caller PII or secrets. Input size and top-level parameter names
    // are captured as OTel metric attributes in measureToolExecution instead.
    // Log correlation always uses the raw SDK sessionId — useful even in
    // stateless mode for tracing the SDK's per-request token through events.
    const appContext = requestContextService.createRequestContext({
      parentContext: {
        ...(typeof sdkContext?.requestId === 'string' ? { requestId: sdkContext.requestId } : {}),
        ...(sdkSessionId ? { sessionId: sdkSessionId } : {}),
      },
      operation: 'HandleToolRequest',
      additionalContext: { toolName: def.name, sessionId: sdkSessionId },
    });

    try {
      // Check inline auth scopes
      if (def.auth && def.auth.length > 0) {
        withRequiredScopes(def.auth, appContext);
      }

      // Validate input
      const validatedInput = def.input.parse(input);

      // Construct Context with detected capabilities. When the definition
      // declares an error contract, `attachTypedFail` adds `ctx.fail` so
      // handlers can `throw ctx.fail('reason', ...)`; otherwise ctx is unchanged.
      const ctx = attachTypedFail(
        createContext({
          appContext,
          logger: services.logger,
          storage: services.storage,
          signal: sdkContext.signal,
          sessionId: handlerSessionId,
          elicit: wrapElicit(sdkCaps),
          sample: wrapSample(sdkCaps),
          notifyResourceListChanged: notifiers.notifyResourceListChanged,
          notifyResourceUpdated: notifiers.notifyResourceUpdated,
        }),
        def.errors,
      );

      // Execute handler with performance measurement.
      // Wrap with Promise.resolve — handler may return sync or async.
      const result = await measureToolExecution(
        () => Promise.resolve(def.handler(validatedInput, ctx)),
        { ...appContext, toolName: def.name },
        validatedInput,
      );

      const validatedResult = def.output.parse(result);

      // Isolate formatter errors from handler errors so they get classified correctly
      let content: ContentBlock[];
      try {
        content = formatter(validatedResult);
      } catch (formatError) {
        throw new Error(
          `Output formatting failed: ${formatError instanceof Error ? formatError.message : String(formatError)}`,
        );
      }

      return {
        structuredContent: validatedResult,
        content,
      };
    } catch (error: unknown) {
      ErrorHandler.handleError(error, {
        operation: `tool:${def.name}`,
        context: appContext,
      });
      return classifyAndBuildToolErrorResult(error);
    }
  };
}

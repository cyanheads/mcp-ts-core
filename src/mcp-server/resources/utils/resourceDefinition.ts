/**
 * @fileoverview Resource definition type, annotations, and `resource()` builder function.
 * Handler receives `(params, ctx)` — URI is available on `ctx.uri`.
 *
 * MCP Resources Specification:
 * @see {@link https://modelcontextprotocol.io/specification/2025-06-18/basic/resources | MCP Resources}
 * @module src/mcp-server/resources/utils/resourceDefinition
 */

import type { CompleteResourceTemplateCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  ListResourcesResult,
  ReadResourceResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { ZodObject, ZodRawShape, z } from 'zod';

import type { HandlerContext, ReasonOf } from '@/core/context.js';
import type { ErrorContract } from '@/types-global/errors.js';

/**
 * Optional annotations providing clients additional context about a resource.
 * Mirrors the MCP SDK's Annotations type.
 */
export interface ResourceAnnotations {
  /** Describes who the intended customer of this object or data is. */
  audience?: ('user' | 'assistant')[];
  /** The timestamp of the last modification, as an ISO 8601 string. */
  lastModified?: string;
  /** Describes how important this data is (0 = least, 1 = most). */
  priority?: number;
}

/** Extra context provided to list() handlers. */
export type ListExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Represents a complete, self-contained definition of an MCP resource.
 * Handler receives `(params, ctx)` — URI is available on `ctx.uri`.
 */
export interface ResourceDefinition<
  TParams extends ZodObject<ZodRawShape> = ZodObject<ZodRawShape>,
  TOutput extends ZodObject<ZodRawShape> | undefined = undefined,
  TErrors extends readonly ErrorContract[] | undefined = undefined,
> {
  /**
   * Protocol-level metadata for the resource registration itself.
   * For plain `resource()` MCP Apps UI resources, host-consumed UI metadata that
   * must travel with `resources/read` content (for example `_meta.ui.csp` or
   * permissions) should be attached to the returned content item from `format()`:
   * ```ts
   * format: (html, meta) => [{
   *   uri: meta.uri.href,
   *   text: html as string,
   *   mimeType: meta.mimeType,
   *   _meta: {
   *     ui: {
   *       csp: { resourceDomains: ['https://cdn.example.com'] },
   *       permissions: { microphone: {} },
   *     },
   *   },
   * }]
   * ```
   */
  _meta?: Record<string, unknown>;
  /** Display/behavior hints. */
  annotations?: ResourceAnnotations;
  /** Required auth scopes. */
  auth?: string[];
  /**
   * Per-variable completion callbacks for URI template variables. Forwarded to
   * the SDK's `ResourceTemplate` constructor so the SDK auto-installs
   * `completion/complete` handling and advertises the `completions` capability.
   * Keys must match variable names in `uriTemplate` (e.g., `{ itemId: async (v) => [...] }`).
   * Only applies to templated resources (URI templates with `{variable}` syntax).
   */
  complete?: Record<string, CompleteResourceTemplateCallback>;
  /** LLM-facing description. */
  description: string;
  /**
   * Declarative contract describing the failure modes this resource can surface.
   * See `ToolDefinition.errors` for full semantics. When declared,
   * `ctx.fail(reason, …)` is typed against the reason union — see the example
   * on `tool()`.
   */
  errors?: TErrors;
  /** Optional examples for discoverability. */
  examples?: { name: string; uri: string }[];
  /**
   * Optional formatter mapping output to ReadResourceResult contents.
   * If omitted, a default formatter is used: string results pass through for
   * non-JSON MIME types, and JSON MIME types stringify all values.
   */
  format?: (
    result: unknown,
    meta: { uri: URL; mimeType: string },
  ) => ReadResourceResult['contents'];
  /**
   * The core handler function. Receives validated params and unified Context.
   * URI is available on `ctx.uri`. Throw on failure.
   */
  handler(
    params: z.infer<TParams>,
    ctx: HandlerContext<ReasonOf<TErrors>>,
  ): TOutput extends ZodObject<ZodRawShape>
    ? z.infer<TOutput> | Promise<z.infer<TOutput>>
    : unknown | Promise<unknown>;
  /**
   * Optional provider for resource discovery/listing.
   */
  list?: (extra: ListExtra) => ListResourcesResult | Promise<ListResourcesResult>;
  /** Default MIME type for response content. */
  mimeType?: string;
  /** Programmatic unique name. Defaults to slugified URI template if omitted. */
  name?: string;
  /** Zod schema for output validation. */
  output?: TOutput;
  /** Zod schema for route/template params. All fields need `.describe()`. */
  params?: TParams;
  /** Size of the raw resource content in bytes (before encoding), if known. */
  size?: number;
  /**
   * View-source URL override for the landing page. Bypasses the
   * `landing.repoRoot`-based auto-derivation, which assumes the file lives at
   * `<repoRoot>/blob/main/src/mcp-server/resources/definitions/<kebab-name>.resource.ts`.
   * Set this when the file path diverges from that convention (e.g.,
   * domain-namespaced subdirectories or a filename that doesn't mirror `name`).
   */
  sourceUrl?: string;
  /** Human-readable title for UI display. */
  title?: string;
  /** URI template for resource registration (e.g., 'myscheme://{itemId}/data'). */
  uriTemplate: string;
}

/** Type-erased union for mixed arrays. */
export type AnyResourceDefinition = ResourceDefinition<
  ZodObject<ZodRawShape>,
  ZodObject<ZodRawShape> | undefined,
  readonly ErrorContract[] | undefined
>;

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Creates a resource definition with the URI template as first argument.
 *
 * @example
 * ```ts
 * const myResource = resource('myscheme://{itemId}/data', {
 *   description: 'Retrieve item data by ID.',
 *   mimeType: 'application/json',
 *   params: z.object({ itemId: z.string().describe('Item identifier') }),
 *   async handler(params, ctx) {
 *     ctx.log.debug('Fetching item', { itemId: params.itemId });
 *     return { id: params.itemId, status: 'active' };
 *   },
 * });
 * ```
 */
export function resource<
  TParams extends ZodObject<ZodRawShape>,
  TOutput extends ZodObject<ZodRawShape> | undefined = undefined,
  const TErrors extends readonly ErrorContract[] | undefined = undefined,
>(
  uriTemplate: string,
  options: Omit<ResourceDefinition<TParams, TOutput, TErrors>, 'uriTemplate'>,
): ResourceDefinition<TParams, TOutput, TErrors> {
  return { uriTemplate, ...options };
}

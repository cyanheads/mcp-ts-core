/**
 * @fileoverview Convenience builders for MCP Apps — `appTool()` and `appResource()`.
 * Wraps the standard `tool()` and `resource()` builders with MCP Apps-specific
 * defaults: auto-populates `_meta.ui.resourceUri`, sets the correct MIME type,
 * handles the compat key (`ui/resourceUri`) required by some hosts, and mirrors
 * app resource `_meta.ui` into `resources/read` content items.
 * @module src/mcp-server/apps/appBuilders
 */

import type { ReadResourceResult } from '@modelcontextprotocol/server';
import type { ZodObject, ZodRawShape } from 'zod';

import type { ResourceDefinition } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
import type { ToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import type { ErrorContract } from '@/types-global/errors.js';

/**
 * MIME type for MCP Apps HTML resources.
 * Matches `RESOURCE_MIME_TYPE` from `@modelcontextprotocol/ext-apps/server`
 * so consumers don't need the peer dependency for this constant alone.
 */
export const APP_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * Backwards-compat metadata key required by some MCP hosts.
 * Matches `RESOURCE_URI_META_KEY` from `@modelcontextprotocol/ext-apps/server`.
 */
const RESOURCE_URI_META_KEY = 'ui/resourceUri';

type ResourceContents = ReadResourceResult['contents'];
type AppResourceFormat = ResourceDefinition<
  ZodObject<ZodRawShape>,
  ZodObject<ZodRawShape> | undefined
>['format'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonMimeType(mimeType: string): boolean {
  const normalizedMimeType = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return normalizedMimeType === 'application/json' || normalizedMimeType.endsWith('+json');
}

function formatResourceText(result: unknown, mimeType: string): string {
  return typeof result === 'string' && !isJsonMimeType(mimeType)
    ? result
    : JSON.stringify(result, null, 2);
}

function mergeNestedRecords(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value) ? mergeNestedRecords(existing, value) : value;
  }

  return merged;
}

function mirrorUiMetaIntoContents(
  contents: ResourceContents,
  defaultUiMeta: Record<string, unknown>,
): ResourceContents {
  return contents.map((content) => {
    const contentMeta = isPlainObject(content._meta) ? content._meta : {};
    const contentUiMeta = contentMeta.ui;

    return {
      ...content,
      _meta: {
        ...contentMeta,
        ui: isPlainObject(contentUiMeta)
          ? mergeNestedRecords(defaultUiMeta, contentUiMeta)
          : (contentUiMeta ?? defaultUiMeta),
      },
    };
  });
}

function createAppResourceFormat(
  format: AppResourceFormat,
  defaultUiMeta: Record<string, unknown> | undefined,
): AppResourceFormat {
  if (!defaultUiMeta) return format;

  return (result, meta) => {
    const contents = format?.(result, meta) ?? [
      {
        uri: meta.uri.href,
        text: formatResourceText(result, meta.mimeType),
        mimeType: meta.mimeType,
      },
    ];

    return mirrorUiMetaIntoContents(contents, defaultUiMeta);
  };
}

// ---------------------------------------------------------------------------
// appTool()
// ---------------------------------------------------------------------------

/** Options for `appTool()` — extends standard tool options with the UI resource URI. */
type AppToolOptions<
  TInput extends ZodObject<ZodRawShape>,
  TOutput extends ZodObject<ZodRawShape>,
  TErrors extends readonly ErrorContract[] | undefined = undefined,
> = Omit<ToolDefinition<TInput, TOutput, TErrors>, '_meta' | 'name'> & {
  /**
   * Additional `_meta` fields. `ui` sub-fields (e.g. `csp`, `visibility`, `permissions`)
   * are merged with the auto-populated `resourceUri`. The `resourceUri` value from the
   * top-level option always wins — it cannot be overridden via `extraMeta.ui.resourceUri`.
   */
  extraMeta?: Record<string, unknown>;
  /** URI of the `ui://` resource that hosts will fetch and render as a sandboxed iframe. */
  resourceUri: string;
};

/**
 * Creates an MCP Apps tool definition. Wraps `tool()` with:
 * - `_meta.ui.resourceUri` set automatically
 * - `_meta['ui/resourceUri']` compat key set automatically
 *
 * Accepts the same `errors: [...]` contract as the standard `tool()` builder —
 * the `const TErrors` modifier preserves literal reasons so the handler's
 * `ctx.fail` is typed against the declared reason union.
 *
 * @example
 * ```ts
 * import { appTool, z } from '@cyanheads/mcp-ts-core';
 *
 * export const myAppTool = appTool('my_app_tool', {
 *   resourceUri: 'ui://my-app/app.html',
 *   description: 'Interactive widget.',
 *   input: z.object({ query: z.string().describe('Search query') }),
 *   output: z.object({ items: z.array(z.string()).describe('Results') }),
 *   handler(input, ctx) { return { items: ['a', 'b'] }; },
 * });
 * ```
 */
export function appTool<
  TInput extends ZodObject<ZodRawShape>,
  TOutput extends ZodObject<ZodRawShape>,
  const TErrors extends readonly ErrorContract[] | undefined = undefined,
>(
  name: string,
  options: AppToolOptions<TInput, TOutput, TErrors>,
): ToolDefinition<TInput, TOutput, TErrors> {
  const { resourceUri, extraMeta, ...rest } = options;
  const { ui: extraUi, ...extraMetaRest } = extraMeta ?? {};

  return tool(name, {
    ...rest,
    _meta: {
      ...extraMetaRest,
      ui: {
        ...(typeof extraUi === 'object' && extraUi !== null
          ? (extraUi as Record<string, unknown>)
          : {}),
        resourceUri,
      },
      [RESOURCE_URI_META_KEY]: resourceUri,
    },
  });
}

// ---------------------------------------------------------------------------
// appResource()
// ---------------------------------------------------------------------------

/** Options for `appResource()` — standard resource options with app-specific defaults. */
type AppResourceOptions<
  TParams extends ZodObject<ZodRawShape>,
  TOutput extends ZodObject<ZodRawShape> | undefined = undefined,
  TErrors extends readonly ErrorContract[] | undefined = undefined,
> = Omit<ResourceDefinition<TParams, TOutput, TErrors>, 'mimeType' | 'uriTemplate'> & {
  /** Override the default `text/html;profile=mcp-app` MIME type. Rarely needed. */
  mimeType?: string;
};

/**
 * Creates an MCP Apps resource definition. Wraps `resource()` with:
 * - `mimeType` defaulting to `text/html;profile=mcp-app`
 * - `annotations.audience` defaulting to `['user']`
 * - `_meta.ui` preserved on the definition and mirrored into `resources/read`
 *   content items so hosts receive the same CSP/permission metadata at read time
 *
 * The `uriTemplate` should use the `ui://` scheme.
 *
 * @example
 * ```ts
 * import { appResource, z } from '@cyanheads/mcp-ts-core';
 *
 * export const myAppResource = appResource('ui://my-app/app.html', {
 *   name: 'my-app-ui',
 *   description: 'Interactive UI for my_app_tool.',
 *   params: z.object({}).describe('No parameters.'),
 *   _meta: {
 *     ui: {
 *       csp: { resourceDomains: ['https://cdn.example.com'] },
 *     },
 *   },
 *   handler(_params, ctx) {
 *     return '<html>...</html>';
 *   },
 * });
 * ```
 */
export function appResource<
  TParams extends ZodObject<ZodRawShape>,
  TOutput extends ZodObject<ZodRawShape> | undefined = undefined,
  const TErrors extends readonly ErrorContract[] | undefined = undefined,
>(
  uriTemplate: string,
  options: AppResourceOptions<TParams, TOutput, TErrors>,
): ResourceDefinition<TParams, TOutput, TErrors> {
  const { mimeType, annotations, _meta, format, ...rest } = options;
  const defaultUiMeta = isPlainObject(_meta?.ui) ? _meta.ui : undefined;
  const appResourceFormat = createAppResourceFormat(format, defaultUiMeta);

  return resource(uriTemplate, {
    ...rest,
    ...(_meta && { _meta }),
    ...(appResourceFormat && { format: appResourceFormat }),
    mimeType: mimeType ?? APP_RESOURCE_MIME_TYPE,
    annotations: {
      audience: ['user'],
      ...annotations,
    },
  });
}

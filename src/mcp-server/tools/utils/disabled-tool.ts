/**
 * @fileoverview `disabledTool()` wrapper — marks a tool definition as present
 * in the manifest (and rendered on the HTTP landing page) but skipped during
 * MCP server registration. The result: clients cannot invoke the tool, but
 * operators reading the landing page see it exists with a reason and an
 * optional hint for how to enable it.
 *
 * Designed to compose with feature-flag conditionals at definition time:
 *
 * ```ts
 * const def = tool('brapi_submit_observations', { ... });
 * export const submitObservations = getServerConfig().enableWrites
 *   ? def
 *   : disabledTool(def, {
 *       reason: 'Writes are disabled in this deployment.',
 *       hint: 'Set BRAPI_ENABLE_WRITES=true to enable.',
 *     });
 * ```
 *
 * The wrapper deliberately leaves the public `ToolDefinition` interface and
 * the `tool()` builder untouched — `disabled` is an internal-facing field
 * that only the registry, manifest, and landing renderer read.
 *
 * @module src/mcp-server/tools/utils/disabled-tool
 */

import type { AnyToolDef } from '@/mcp-server/tools/tool-registration.js';

/**
 * Operator-facing metadata describing why a tool is disabled in the current
 * deployment and (optionally) how to enable it.
 */
export interface DisabledMetadata {
  /**
   * Free-form hint about how to enable the tool. Plain text or a fragment of
   * markdown — the renderer treats it as a code-styled block when present.
   * Use this for env vars (`BRAPI_ENABLE_WRITES=true`), config keys, or a
   * reference to a setup doc — whatever makes sense for the gate.
   */
  hint?: string;
  /**
   * One-sentence operator-facing reason. Rendered on the landing card in
   * place of the invocation snippet. Keep it specific enough that the reader
   * understands the gate without leaving the page.
   */
  reason: string;
  /**
   * Optional version string indicating when the tool was disabled or first
   * gated. Surfaces on the card as a small annotation; useful when phasing a
   * tool out behind a flag before removal.
   */
  since?: string;
}

/**
 * Internal string-keyed marker attached to wrapped definitions. Kept off the
 * public `ToolDefinition` interface so the `tool()` builder stays unchanged;
 * `getDisabledMetadata()` is the only sanctioned reader.
 */
const DISABLED_KEY = '__mcpDisabled' as const;

/**
 * Wrap a tool definition to mark it disabled. The returned definition retains
 * every property of the original (so the linter, manifest, and schema preview
 * all keep working) and adds an internal `__mcpDisabled` field that the
 * registry checks before deciding whether to register the tool with the MCP
 * server.
 *
 * @param def  The original tool definition.
 * @param meta The reason (and optional hint) shown on the landing page.
 * @returns The same definition with the disabled marker attached.
 */
export function disabledTool<TDef extends AnyToolDef>(def: TDef, meta: DisabledMetadata): TDef {
  return { ...def, [DISABLED_KEY]: meta } as TDef;
}

/**
 * Predicate + extractor in one call: returns the `DisabledMetadata` when the
 * definition was wrapped with `disabledTool()`, or `undefined` otherwise.
 * Internal — used by `ToolRegistry` and `buildServerManifest()`.
 */
export function getDisabledMetadata(def: AnyToolDef): DisabledMetadata | undefined {
  return (def as AnyToolDef & { readonly [DISABLED_KEY]?: DisabledMetadata })[DISABLED_KEY];
}

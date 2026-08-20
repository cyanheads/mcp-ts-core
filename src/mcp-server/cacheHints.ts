/**
 * @fileoverview Cache hints for the cacheable results of protocol revision
 * 2026-07-28 (SEP-2549) — the framework's view of the SDK's two hint seams:
 * a per-operation map on the server, and a per-resource override carried on the
 * resource definition.
 *
 * The hint rides a symbol-keyed property that is never serialized, and the
 * 2025-era codec has no cache code path, so configuring one can never change
 * what a 2025-era response looks like on the wire.
 * @module src/mcp-server/cacheHints
 */

import type { CacheHint, ServerOptions } from '@modelcontextprotocol/server';

import type { AnyResourceDefinition } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { configurationError } from '@/types-global/errors.js';

/**
 * Cache hints keyed by operation, for the closed set of methods whose
 * 2026-07-28 results carry `ttlMs` / `cacheScope`: `tools/list`,
 * `prompts/list`, `resources/list`, `resources/templates/list`,
 * `resources/read`, and `server/discover`.
 *
 * Derived from the SDK's own option rather than restating the literal list, so
 * the framework cannot drift from the set the SDK actually honors.
 */
export type CacheHints = NonNullable<ServerOptions['cacheHints']>;

/** A method whose 2026-07-28 result is cacheable. */
export type CacheableResultMethod = keyof CacheHints;

/**
 * Rejects a `ttlMs` the SDK would reject at construction time, naming the
 * option that carries it. `cacheScope` needs no runtime check — its union type
 * makes an invalid value a compile error, whereas `ttlMs: number` admits
 * negatives and fractions the spec does not.
 */
function assertValidTtl(hint: CacheHint, field: string): void {
  if (hint.ttlMs !== undefined && (!Number.isSafeInteger(hint.ttlMs) || hint.ttlMs < 0)) {
    throw configurationError(
      `${field}.ttlMs must be a non-negative safe integer (received ${String(hint.ttlMs)}).`,
      { field: `${field}.ttlMs`, value: hint.ttlMs },
    );
  }
}

/**
 * Validates every cache hint an app declares, before any of them reaches the
 * SDK constructor. Turns what would otherwise surface as a bare `RangeError`
 * mid-startup into a configuration error naming the offending field.
 *
 * @throws {McpError} `ConfigurationError` when a `ttlMs` is not a non-negative
 *   safe integer.
 */
export function assertValidCacheHints(
  cacheHints: CacheHints | undefined,
  resources: readonly AnyResourceDefinition[],
): void {
  for (const [method, hint] of Object.entries(cacheHints ?? {})) {
    if (hint) assertValidTtl(hint, `cacheHints['${method}']`);
  }
  for (const def of resources) {
    if (def.cacheHint) {
      assertValidTtl(def.cacheHint, `resource '${def.name ?? def.uriTemplate}' cacheHint`);
    }
  }
}

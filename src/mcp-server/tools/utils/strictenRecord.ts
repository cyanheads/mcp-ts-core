/**
 * @fileoverview What `strictenInput` threw away, kept where `lint:mcp` can read
 * it (#358, #394).
 *
 * Zod 4 keys `.describe()` and `.meta()` to the schema **instance**, in
 * `z.globalRegistry`, and `.strict()` is `catchall(z.never())` — a clone with no
 * `_zod.parent` link, so it inherits no registry entry. `strictenInput` stores
 * that clone, and whatever the author attached to the input root is gone:
 * silently, since the linter reads the same stored schema the wire does and a
 * root carries no describe anything would ask for.
 *
 * `tool()` is the only place both instances exist, so it records the discard
 * here on the way past. The record is a symbol-keyed, non-enumerable property:
 * invisible to `Object.keys`, `JSON.stringify`, a spread, `tools/list`, the
 * server manifest and `_meta` alike, so nothing about what a client sees
 * changes. The symbol comes from the global registry rather than a module
 * binding, because `lint:mcp` can load the framework twice — the linter from
 * the installed package, the definitions from wherever the server imports them
 * — and a module-local key (or a `WeakMap`) would not be shared across the two.
 *
 * Re-applying the discarded entry to the strictened schema is separate, held
 * work: it would change the advertised `inputSchema` bytes. This half changes
 * none of them.
 *
 * @module src/mcp-server/tools/utils/strictenRecord
 */

/** One schema instance whose registry entry `strictenInput` did not carry over. */
export interface StrictenDiscard {
  /** The registry keys that were lost — `description` for `.describe()`, else `.meta()` keys. */
  readonly keys: readonly string[];
  /** Where it sat, in the linter's path vocabulary: `input`, or `input|<i>` for a variant. */
  readonly scope: string;
}

const STRICTEN_DISCARD = Symbol.for('@cyanheads/mcp-ts-core:strictenDiscard');

/**
 * Attaches the discards to a definition without making it part of the
 * definition's value. Only called when something was actually discarded, so an
 * unaffected definition carries no property at all.
 */
export function recordStrictenDiscard(
  definition: object,
  discards: readonly StrictenDiscard[],
): void {
  Object.defineProperty(definition, STRICTEN_DISCARD, {
    configurable: true,
    enumerable: false,
    value: discards,
    writable: false,
  });
}

/** The discards `tool()` recorded, or `undefined` when nothing was discarded. */
export function readStrictenDiscard(definition: unknown): readonly StrictenDiscard[] | undefined {
  if (definition === null || typeof definition !== 'object') return undefined;
  const value = (definition as Record<symbol, unknown>)[STRICTEN_DISCARD];
  return Array.isArray(value) ? (value as readonly StrictenDiscard[]) : undefined;
}

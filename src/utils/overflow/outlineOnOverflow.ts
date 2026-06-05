/**
 * @fileoverview Outline-on-overflow: when a single document-shaped tool payload
 * exceeds a serialized-byte budget, return a section outline (identifiers +
 * per-section size) plus a re-call notice instead of truncating. The agent
 * re-calls the same tool with `sections:[...]` to pull only what it needs.
 *
 * Pure measurement + key-slicing — no DuckDB, no I/O — so it runs identically on
 * stdio / HTTP / Workers. The row-collection sibling is `spillover()` (`/canvas`);
 * this handles the one-fat-document case. See issue #204 and the `techniques`
 * skill (`outline-on-overflow` reference) for the full pattern, including the
 * stateless re-call contract and the optional `ctx.state` cache.
 *
 * @module src/utils/overflow/outlineOnOverflow
 */
import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/** Default serialized-byte budget. Over this, a document overflows to an outline. */
export const DEFAULT_OUTLINE_BUDGET_BYTES = 24_000;

/** One addressable section of a document and its serialized size. */
export interface SectionMeta {
  /** Serialized byte size of the section's value. */
  bytes: number;
  /** Section identifier — the agent passes this in `sections:[...]` to retrieve it. */
  name: string;
}

/**
 * Reusable outline arm for a tool's discriminated-union `output`. Pair it with
 * the tool's full-payload schema so the parity linter validates each branch:
 *
 * ```ts
 * output: z.discriminatedUnion('kind', [
 *   FullLabel.extend({ kind: z.literal('full') }),
 *   OUTLINE_VARIANT,
 * ]),
 * ```
 */
export const OUTLINE_VARIANT = z.object({
  kind: z.literal('outline'),
  sections: z
    .array(
      z.object({
        name: z.string().describe('Section identifier — pass in `sections` to retrieve it'),
        bytes: z.number().int().nonnegative().describe('Serialized byte size of the section'),
      }),
    )
    .describe('Available sections, largest first'),
  notice: z.string().describe('How to re-call the tool for specific sections'),
});

/** The outline payload shape, inferred from {@link OUTLINE_VARIANT}. */
export type OutlinePayload = z.infer<typeof OUTLINE_VARIANT>;

/** Result of {@link outlineOnOverflow}: the full document, or an outline of it. */
export type OutlineResult<T> = (T & { kind: 'full' }) | OutlinePayload;

/** Options for {@link outlineOnOverflow}. */
export interface OutlineOptions<T> {
  /**
   * Serialized-byte budget. When `JSON.stringify(doc).length` exceeds this, the
   * document overflows to an outline. Default {@link DEFAULT_OUTLINE_BUDGET_BYTES}.
   * A helper argument, deliberately not an env var — a deploy-tunable threshold
   * would drift a tool's output *shape* across environments.
   */
  budget?: number;
  /**
   * Section extractor. Default: each top-level key becomes a section sized by
   * `JSON.stringify(value).length`. Override only when "section" means something
   * other than a top-level key.
   */
  extract?: (doc: T) => SectionMeta[];
  /**
   * Builds the re-call notice from the size-sorted sections. Default names the
   * three largest sections as examples.
   */
  notice?: (sections: SectionMeta[]) => string;
}

/** Default extractor: one section per top-level key, sized by serialized length. */
function defaultExtract(doc: Record<string, unknown>): SectionMeta[] {
  return Object.entries(doc).map(([name, value]) => ({
    name,
    bytes: JSON.stringify(value)?.length ?? 0,
  }));
}

/** Default notice: re-call instruction naming the three largest sections. */
function defaultNotice(sections: SectionMeta[]): string {
  const examples = sections
    .slice(0, 3)
    .map((s) => s.name)
    .join(', ');
  return `Record too large to inline. Re-call this tool with sections:[...] to retrieve specific sections — e.g. ${examples}.`;
}

/**
 * Returns the document whole when it fits the budget, or a section outline when
 * it overflows. The caller spreads the result into a discriminated-union `output`
 * keyed on `kind` ({@link OUTLINE_VARIANT} supplies the outline arm).
 *
 * Single-entry short-circuit: a document with fewer than two sections is returned
 * whole even when over budget — an outline of one section would cost a round-trip
 * whose only possible `sections` arg returns the same bytes. (A lone section that
 * itself exceeds the budget is a known limitation; sub-section outlining is out
 * of scope.)
 *
 * @example
 * ```ts
 * async handler(input) {
 *   const doc = await fetchLabel(input.query);
 *   if (input.sections?.length) {
 *     return { ...selectSections(doc, input.sections), kind: 'full' as const };
 *   }
 *   return outlineOnOverflow(doc, { budget: 24_000 });
 * }
 * ```
 */
export function outlineOnOverflow<T extends Record<string, unknown>>(
  doc: T,
  options?: OutlineOptions<T>,
): OutlineResult<T> {
  const budget = options?.budget ?? DEFAULT_OUTLINE_BUDGET_BYTES;

  if (JSON.stringify(doc).length <= budget) {
    return { ...doc, kind: 'full' };
  }

  const sections = (options?.extract ?? defaultExtract)(doc).sort((a, b) => b.bytes - a.bytes);

  // Single-entry short-circuit — nothing to choose between.
  if (sections.length < 2) {
    return { ...doc, kind: 'full' };
  }

  const notice = (options?.notice ?? defaultNotice)(sections);
  return { kind: 'outline', sections, notice };
}

/**
 * Projects a document down to the requested sections plus any always-kept
 * metadata keys — the selection-path counterpart to {@link outlineOnOverflow}.
 * The handler re-fetches the document, then slices it to what the agent asked
 * for. Pure top-level key projection; supply a custom selector when "section"
 * means something other than a top-level key.
 *
 * @param doc - The full document.
 * @param want - Section identifiers the agent requested (from the outline).
 * @param options.alwaysKeep - Metadata keys to retain regardless (ids, timestamps).
 */
export function selectSections<T extends Record<string, unknown>>(
  doc: T,
  want: string[],
  options?: { alwaysKeep?: string[] },
): Partial<T> {
  const keep = new Set<string>([...want, ...(options?.alwaysKeep ?? [])]);
  return Object.fromEntries(Object.entries(doc).filter(([key]) => keep.has(key))) as Partial<T>;
}

/**
 * Renders an outline payload to MCP `content[]` — the markdown twin of the
 * outline's `structuredContent`, so `format()`-parity holds. Drop into a tool's
 * `format`:
 *
 * ```ts
 * format: (r) => (r.kind === 'outline' ? formatOutline(r) : renderFull(r)),
 * ```
 */
export function formatOutline(outline: OutlinePayload): ContentBlock[] {
  const lines = [
    `**${outline.sections.length} sections available** (record too large to inline)`,
    '',
    ...outline.sections.map((s) => `- \`${s.name}\` — ${s.bytes} bytes`),
    '',
    outline.notice,
  ];
  return [{ type: 'text', text: lines.join('\n') }];
}

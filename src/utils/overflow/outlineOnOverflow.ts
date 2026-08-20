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
import type { ContentBlock } from '@modelcontextprotocol/server';
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
 * Reusable outline arm for a tool's `output`. A tool's `output` must be a flat
 * `z.object` — `tool()` rejects a `z.discriminatedUnion` (the `schema-is-object`
 * lint rule and the enrichment `.extend()` are both `ZodObject`-only). Model the
 * two modes as one object with a `kind` discriminator and presence-based optional
 * arms, folding this schema's `sections` / `notice` shape into the outline arm:
 *
 * ```ts
 * output: z.object({
 *   kind: z.enum(['full', 'outline']),
 *   // full-mode arms (present when kind === 'full') — each .optional()
 *   sections: OUTLINE_VARIANT.shape.sections.optional(),   // outline-mode arms
 *   notice: OUTLINE_VARIANT.shape.notice.optional(),
 * }),
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
   * Builds the re-call notice from the size-sorted sections and the budget they
   * were measured against. Default names the largest section that fits the
   * budget, with its size inline.
   */
  notice?: (sections: SectionMeta[], budget: number) => string;
}

/** Default extractor: one section per top-level key, sized by serialized length. */
function defaultExtract(doc: Record<string, unknown>): SectionMeta[] {
  return Object.entries(doc).map(([name, value]) => ({
    name,
    bytes: JSON.stringify(value)?.length ?? 0,
  }));
}

/**
 * Default notice: a re-call instruction whose worked example names the largest
 * section that fits the budget, with its size inline.
 *
 * Naming the largest sections instead would hand the agent the most expensive
 * retrieval available — the one most likely to blow the same budget the outline
 * exists to enforce. Picking the largest *fitting* section is also what keeps
 * trivial metadata keys (ids, timestamps — sections that retrieve nothing
 * substantive) out of the example without the helper needing to know which keys
 * those are.
 *
 * One section, not several: each listed size is per-section, and a selection
 * naming several sums them, so a multi-section example would advertise a
 * combination that may not fit. Every section's size is listed alongside the
 * outline, so the agent can build a larger selection deliberately. When nothing
 * fits, no section is named at all — every name available would be a worked
 * example that overflows.
 */
function defaultNotice(sections: SectionMeta[], budget: number): string {
  // `sections` is sorted largest-first, so the first that fits is the largest.
  const fits = sections.find((s) => s.bytes <= budget);
  if (!fits) {
    const smallest = Math.min(...sections.map((s) => s.bytes));
    return `Record too large to inline, and no single section fits the ${budget}-byte budget — the smallest is ${smallest} bytes. Narrow the request through this tool's other inputs; sections:[...] cannot bring this record under the budget.`;
  }
  return `Record too large to inline. Re-call this tool with sections:[...] to retrieve specific sections — e.g. sections:["${fits.name}"] (${fits.bytes} bytes, against a ${budget}-byte budget). Sizes are listed per section and a selection returns whatever it names, so sum them yourself before requesting several.`;
}

/**
 * Returns the document whole when it fits the budget, or a section outline when
 * it overflows. Declare the tool's `output` as a flat `z.object` with a `kind`
 * discriminator and presence-based optional arms — `tool()` rejects a
 * `z.discriminatedUnion` output ({@link OUTLINE_VARIANT} supplies the outline
 * arm's `sections` / `notice`).
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

  const notice = (options?.notice ?? defaultNotice)(sections, budget);
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
 * outline's `structuredContent`, so `format()`-parity holds. The flat-object
 * `output` carries both modes as optional fields, so render each arm on field
 * presence, independently — never branch on `kind`. Parity injects one synthetic
 * sample with every optional field populated at once, so a mutually-exclusive
 * `kind` branch would leave the untaken arm's fields unrendered:
 *
 * ```ts
 * format: (r) => [
 *   ...(r.id ? renderFull(r) : []),  // full arm — key on a full-only field
 *   ...(r.sections ? formatOutline({ kind: 'outline', sections: r.sections, notice: r.notice ?? '' }) : []),
 * ],
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

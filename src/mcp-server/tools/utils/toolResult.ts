/**
 * @fileoverview Shapes the `CallToolResult` a tool call returns: `content[]`
 * from `format()` and collected media, the error envelope mirrored across
 * `content[]` and `structuredContent.error`, and the success result with its
 * enrichment merge and `content[]` trailer.
 * @module src/mcp-server/tools/utils/toolResult
 */

import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/server';

import type { Context, EnrichmentStore } from '@/core/context.js';
import { readContentStore, readEnrichmentStore } from '@/core/context.js';
import { parseOutputContract } from '@/mcp-server/outputContract.js';
import { internalError, type JsonRpcErrorCode } from '@/types-global/errors.js';
import { escapeMarkdownInline } from '@/utils/formatting/markdownInline.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { readWireErrorData } from '@/utils/internal/error-handler/helpers.js';
import type { AnyToolDefinition } from './toolDefinition.js';
import { effectiveOutputSchema } from './toolOutputSchema.js';

// ---------------------------------------------------------------------------
// Default formatter
// ---------------------------------------------------------------------------

const defaultResponseFormatter = (result: unknown): ContentBlock[] => [
  { type: 'text', text: JSON.stringify(result, null, 2) },
];

/**
 * Renders `content[]` for a validated tool result: `format()` (or the JSON
 * default) over the domain payload, with any blocks collected via
 * `ctx.content` (image/audio bytes) prepended. Collected blocks ride
 * `content[]` only — never `structuredContent` — so a handler can surface
 * media for the model without the base64 duplicating into the typed output.
 *
 * A formatter failure is isolated from handler failures so it classifies as
 * an internal error, carrying the formatter's own error as `cause`.
 */
export function renderToolContent(
  def: AnyToolDefinition,
  validatedOutput: Record<string, unknown>,
  ctx: Context,
): ContentBlock[] {
  let content: ContentBlock[];
  try {
    content = (def.format ?? defaultResponseFormatter)(validatedOutput);
  } catch (formatError) {
    throw internalError(
      `Output formatting failed: ${formatError instanceof Error ? formatError.message : String(formatError)}`,
      undefined,
      { cause: formatError },
    );
  }
  const collected = readContentStore(ctx)?.blocks;
  return collected && collected.length > 0 ? [...collected, ...content] : content;
}

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
 * The compact trailing line carrying the two `data` fields a caller branches
 * on — `reason`, the stable identifier, and `retryable`, whether a retry can
 * succeed (#458) — then `request <id>`, the `data.requestId` the server's log
 * records carry (#576). All three reach `structuredContent.error.data`;
 * without this line none reaches the text surface, so a model that just failed
 * cannot tell a deterministic rejection from a transient one, and a failure
 * reported from a `content[]`-only client cannot be matched to its log record.
 *
 * Returns `undefined` when `data` carries none of them — an `McpError` with no
 * `data` outside a request, as `runToolContract` builds it — leaving the text
 * as it was. The numeric `code` and `data.issues` stay JSON-only on purpose:
 * the code is the one envelope field a model cannot act on, and the message
 * already renders the issues as sentences.
 */
function renderBranchableTerms(data: Record<string, unknown> | undefined): string | undefined {
  const terms: string[] = [];
  if (typeof data?.reason === 'string' && data.reason.length > 0) {
    terms.push(`reason ${escapeMarkdownInline(data.reason)}`);
  }
  if (typeof data?.retryable === 'boolean') {
    terms.push(data.retryable ? 'retryable' : 'not retryable');
  }
  if (typeof data?.requestId === 'string' && data.requestId.length > 0) {
    terms.push(`request ${data.requestId}`);
  }
  return terms.length > 0 ? `(${terms.join(' · ')})` : undefined;
}

/**
 * Shapes a `CallToolResult` for a tool error response with parity across both
 * surfaces clients forward to the agent:
 * - `content[]` — read by clients like Claude Desktop (markdown)
 * - `structuredContent.error` — read by clients like Claude Code (JSON)
 *
 * The text carries the message, the `data.recovery.hint` when it adds
 * something, and the `reason` / `retryable` / `request` terms
 * {@link renderBranchableTerms} renders, in that order; the numeric `code` and
 * `data.issues` stay JSON-only.
 *
 * The message, hint, and reason are caller or upstream text, so each is
 * rendered through {@link escapeMarkdownInline} (#760): a CommonMark parse of
 * the block reads each back exactly as `structuredContent.error` carries it,
 * rather than as emphasis, a code span, raw HTML, or a list. A handler throws
 * raw text for that reason — escaping it first would put the backslashes on
 * both surfaces.
 *
 * The `Recovery:` line is dropped when the message already contains the hint
 * verbatim (#459) — `buildArgumentRecoveryHint` restates a constraint or
 * refinement issue as its own message line, and a hint made only of those is
 * the message's issue text, so repeating it costs the reader without adding a
 * next step. Containment, not equality: the argument-rejection preamble leaves
 * that text whole on screen, and so does a handler hint the message embeds.
 * `structuredContent.error.data.recovery.hint` stays populated either way, so
 * #445's guarantee holds on the JSON surface.
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
  const blocks = [`Error: ${escapeMarkdownInline(message)}`];
  if (hint !== undefined && !message.trim().includes(hint.trim())) {
    blocks.push(`Recovery: ${escapeMarkdownInline(hint)}`);
  }
  const terms = renderBranchableTerms(data);
  if (terms !== undefined) blocks.push(terms);
  const text = blocks.join('\n\n');
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
 * `ZodError` (its `issues`, bounded by `classifyOnly` to the first 10 with
 * `issuesCount` beside a cut list, #710), so internal classification context
 * never leaks to clients.
 *
 * `requestId`, when given, is set as `data.requestId` on the envelope — after
 * the thrown data, so the framework's value replaces a thrown one, as
 * canonical fields win in log records (#550) — and closes the `content[]`
 * terms line (#576). It is the one request-context field that reaches `data`,
 * added here rather than to the thrown `McpError.data`, so the error the
 * handler threw and the log record's `errorData` stay context-free (#548).
 * `runToolContract` passes none: it has no real request, so a thrown
 * `data.requestId` is dropped rather than rendered as one.
 *
 * Never throws on the thrown value (#697): its `code`, `message`, and `data`
 * are read as {@link ErrorHandler.classifyOnly} reads them, so one that cannot
 * be read is `InternalError`, `'[Unreadable]'`, or left out, and `data` is a
 * copy of the thrown one in which every field is one the wire carries
 * ({@link readWireErrorData}).
 *
 * Use after invoking {@link ErrorHandler.handleError} for OTel/logging side
 * effects — this helper does not log.
 */
export function classifyAndBuildToolErrorResult(
  error: unknown,
  requestId?: string,
): CallToolResult {
  const withRequestId = (data: Record<string, unknown> | undefined) => {
    if (requestId !== undefined) return { ...data, requestId };
    if (data?.requestId === undefined) return data;
    const { requestId: _thrown, ...rest } = data;
    return Object.keys(rest).length > 0 ? rest : undefined;
  };
  // `classifyOnly` returns only a `ZodError`'s bounded issues as `data`; a thrown `McpError`'s is copied here.
  const { code, message, data } = ErrorHandler.classifyOnly(error);
  return buildToolErrorResult(code, message, withRequestId(readWireErrorData(error) ?? data));
}

// ---------------------------------------------------------------------------
// Success response shaping — enrichment merge + trailer
// ---------------------------------------------------------------------------

/**
 * Parses a handler's returned value against the tool's `output` schema. A value
 * that breaks it fails as `InternalError` naming the tool and the output
 * contract — a server fault, never the caller's `ValidationError` (#480).
 * {@link createToolHandler} and the `runToolContract` test helper both route
 * through it.
 */
export function parseToolOutput(def: AnyToolDefinition, value: unknown): Record<string, unknown> {
  return parseOutputContract(def.output, value, {
    kind: 'Tool',
    name: def.name,
    contract: 'output',
  }) as Record<string, unknown>;
}

/**
 * Renders an enrichment value as compact trailer text for the echo, delta, and
 * default arms. A string, and the JSON of an object, is caller or upstream data,
 * so it goes through {@link escapeMarkdownInline} and a CommonMark parse reads
 * it back as written (#640); a number, boolean, or `null` renders as itself.
 */
function formatEnrichmentScalar(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value === 'object') return escapeMarkdownInline(JSON.stringify(value));
  if (typeof value === 'string') return escapeMarkdownInline(value);
  return String(value);
}

/**
 * True when a rendered field's last line leaves open a CommonMark container that
 * lazy continuation would pull the next field into — a block quote (`>`) or a
 * list item (`-`, `+`, `*`, `1.`, `1)`), each indented up to three spaces.
 *
 * Keyed on the line, not the field kind: a custom `enrichmentTrailer.render` can
 * emit multi-line markdown whose final line is a quote or a bullet, and either
 * one swallows what follows exactly as a `notice` does.
 *
 * A list marker must be followed by a space or end the line, so `**0 total**`
 * and a `***` rule are not mistaken for bullets.
 */
function opensLazyContainer(text: string): boolean {
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  return /^ {0,3}(?:>|(?:[-+*]|\d{1,9}[.)])(?: |$))/.test(lastLine);
}

/**
 * Joins rendered fields into the trailer body, closing any open container before
 * the next field. CommonMark lazy continuation folds an unprefixed paragraph line
 * that follows a block quote or list item *into* it, so a bare `\n` would render
 * server-authored facts (totals, query echoes) as quoted text attributed to the
 * notice, or as the tail of somebody's last bullet. Emitting the blank line only
 * after those lines keeps the compact single-`\n` layout everywhere else.
 */
function joinTrailerFields(fields: string[]): string {
  let text = '';
  for (const field of fields) {
    if (text.length > 0) text += opensLazyContainer(text) ? '\n\n' : '\n';
    text += field;
  }
  return text;
}

/**
 * Renders accumulated enrichment as a single `content[]` trailer block, so
 * `content[]`-only clients see the same context `structuredContent` clients get
 * from the merged output. Per field, rendering resolves in order:
 *   1. a per-field `enrichmentTrailer.render` (the author's full control; wins
 *      over everything — the escape hatch for structured fields that would
 *      otherwise JSON-blob),
 *   2. the kind-tag set by a field-helper (notice → blockquote, total →
 *      "N total", echo → "Query: …", delta → "field: before → after"),
 *   3. the generic `**key:** value` fallback (key overridable via `label`),
 *      `JSON.stringify`-ing non-scalars.
 *
 * Echo, delta, and default values are data, rendered through
 * {@link formatEnrichmentScalar} so their Markdown-active characters read back
 * literally. Authored text stays live Markdown: a `render` result, a `label`,
 * the `total` line, and the `notice` blockquote, whose author escapes any
 * untrusted text embedded in it.
 *
 * `parsed` is the validated effective output, so renderers receive the typed,
 * post-parse value rather than the raw accumulator entry. The rendered markdown
 * is appended to `content[]` only — `structuredContent` is built separately from
 * the raw merged values and never carries this trailer text. The trailer text
 * leads with a blank-line separator so it stands off the preceding block on
 * clients that concatenate adjacent text blocks with no join (#257); markdown
 * collapses consecutive blank lines, so clients that do insert their own
 * separator render at most one blank line either way. Fields are joined by
 * {@link joinTrailerFields}, which terminates block quotes so a following field
 * renders as its own block (#308). Returns `[]` when nothing was enriched.
 */
function renderEnrichmentTrailer(
  store: EnrichmentStore,
  trailer: AnyToolDefinition['enrichmentTrailer'],
  parsed: Record<string, unknown>,
): ContentBlock[] {
  const fields: string[] = [];
  for (const key of Object.keys(store.values)) {
    // Skip keys the effective-output parse stripped (enriched but not declared in
    // the block) — the trailer mirrors what reached structuredContent.
    if (!(key in parsed)) continue;
    const value = parsed[key];
    const cfg = trailer?.[key];
    if (cfg?.render) {
      fields.push(cfg.render(value));
      continue;
    }
    switch (store.kinds.get(key)) {
      case 'notice':
        // Every line is quoted: one left bare ends the quote, and the rest of
        // the notice renders as top-level Markdown (#765).
        fields.push(
          String(value)
            .split(/\r\n|\r|\n/)
            .map((line) => (line === '' ? '>' : `> ${line}`))
            .join('\n'),
        );
        break;
      case 'total':
        fields.push(`**${String(value)} total**`);
        break;
      case 'echo':
        fields.push(`Query: ${formatEnrichmentScalar(value)}`);
        break;
      case 'delta': {
        const d = (value ?? {}) as { after?: unknown; before?: unknown };
        fields.push(
          `**${cfg?.label ?? key}:** ${formatEnrichmentScalar(d.before)} → ${formatEnrichmentScalar(d.after)}`,
        );
        break;
      }
      default:
        fields.push(`**${cfg?.label ?? key}:** ${formatEnrichmentScalar(value)}`);
    }
  }
  return fields.length > 0 ? [{ type: 'text', text: `\n\n${joinTrailerFields(fields)}` }] : [];
}

/**
 * Shapes the success `CallToolResult` surfaces from the validated domain payload
 * plus any accumulated enrichment:
 * - `structuredContent` — domain output merged with enrichment (validated against
 *   `output.extend(enrichment)`); the bare domain output when no enrichment block.
 * - `content[]` — the caller-rendered domain content (from `format()` or the
 *   JSON-stringify default, applied to the **domain payload only**) with the
 *   enrichment trailer always appended. Rendering the domain payload — never the
 *   merged object — keeps enrichment out of the JSON blob and avoids double-render.
 *
 * A required enrichment field the handler never populated fails the parse here,
 * surfacing the authoring bug as a loud `InternalError` naming the enrichment
 * contract rather than dropping it silently (#480).
 */
export function buildToolSuccessResult(
  def: AnyToolDefinition,
  ctx: Context,
  domainValidated: Record<string, unknown>,
  domainContent: ContentBlock[],
): Pick<CallToolResult, 'content' | 'structuredContent'> {
  if (!def.enrichment) {
    return { structuredContent: domainValidated, content: domainContent };
  }
  const store = readEnrichmentStore(ctx);
  const values = store?.values ?? {};
  const structuredContent = parseOutputContract(
    effectiveOutputSchema(def),
    { ...domainValidated, ...values },
    { kind: 'Tool', name: def.name, contract: 'enrichment' },
  ) as Record<string, unknown>;
  const trailer =
    store && Object.keys(values).length > 0
      ? renderEnrichmentTrailer(store, def.enrichmentTrailer, structuredContent)
      : [];
  return {
    structuredContent,
    content: trailer.length > 0 ? [...domainContent, ...trailer] : domainContent,
  };
}

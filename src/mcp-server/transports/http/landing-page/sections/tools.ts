/**
 * @fileoverview Tools section — responsive card grid grouped by safety
 * mutability (read / write / destructive). Each card carries annotation
 * pills, a scope chip, a JSON-RPC invocation snippet, and a collapsible
 * input-schema preview. A filter bar above the grid wires chip + search
 * filtering through `data-mutability` / `data-name` attributes consumed
 * by the inline filter script.
 *
 * @module src/mcp-server/transports/http/landing-page/sections/tools
 */

import type { ManifestTool } from '@/core/serverManifest.js';
import { html, type SafeHtml } from '@/utils/formatting/html.js';

import { renderPill, renderSectionHeading, renderSnippet } from '../primitives.js';

type Mutability = 'read' | 'unspecified' | 'write' | 'destructive';
type Bucket = Mutability | 'disabled';

/**
 * Bucket order — safety-ascending (`read` → `unspecified` → `write` →
 * `destructive`), then `disabled` last as operator-facing context for tools
 * that exist in this server but are skipped at registration. Filter chips
 * render in this order too.
 */
const BUCKET_ORDER: readonly Bucket[] = ['read', 'unspecified', 'write', 'destructive', 'disabled'];

export function renderToolsSection(tools: ManifestTool[]): SafeHtml {
  if (tools.length === 0) return html``;

  const buckets = bucketTools(tools);
  const populatedBuckets = BUCKET_ORDER.filter((b) => buckets[b].length > 0);
  // A single bucket is redundant with the section header — skip per-group
  // labels in that case but keep `data-mutability` on cards so the filter
  // chips still work.
  const showHeadings = populatedBuckets.length > 1;

  const groups = populatedBuckets.map((bucket) => {
    const bucketTools = buckets[bucket];
    const heading = showHeadings
      ? html`<h4 class="group-heading" data-group="${bucket}">${bucket} <span class="group-count">${String(bucketTools.length)}</span></h4>`
      : html``;
    return html`${heading}<div class="card-grid" data-grid="${bucket}">${bucketTools.map((t) => renderToolCard(t, bucket))}</div>`;
  });

  return html`
    <section aria-labelledby="section-tools" data-tools-section>
      ${renderSectionHeading('section-tools', 'Tools', tools.length)}
      ${renderToolFilterBar(populatedBuckets)}
      <div class="tools-body">${groups}</div>
      <p class="tools-empty" hidden>No tools match the current filter.</p>
    </section>
  `;
}

function renderToolFilterBar(populatedBuckets: readonly Bucket[]): SafeHtml {
  const chips: SafeHtml[] = [
    html`<button type="button" class="tool-chip" data-filter-mutability="all" aria-pressed="true">all</button>`,
  ];
  for (const b of populatedBuckets) {
    chips.push(
      html`<button type="button" class="tool-chip tool-chip--${b}" data-filter-mutability="${b}" aria-pressed="false">${b}</button>`,
    );
  }

  return html`
    <div class="tool-filter-bar" role="search" aria-label="Filter tools">
      <div class="tool-chips" role="group" aria-label="Filter by mutability">${chips}</div>
      <label class="tool-search">
        <span class="visually-hidden">Search tools</span>
        <input
          type="search"
          data-tool-search
          placeholder="Search tools…"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
    </div>
  `;
}

function renderToolCard(tool: ManifestTool, bucket: Bucket): SafeHtml {
  const anchor = `tool-${tool.name}`;
  const annotations = tool.annotations as { openWorldHint?: boolean } | undefined;
  const isDisabled = bucket === 'disabled';

  // The spine carries the mutability glance signal; the pill remains for
  // a11y (colorblind users, screen-reader text) but de-emphasized into the
  // card meta strip. Disabled cards still lead with the disabled pill +
  // underlying classification companion so operators see what's gated.
  const mutabilityPills: SafeHtml[] = [renderPill(bucket, bucket)];
  if (isDisabled) {
    const underlying = classifyMutability(tool);
    if (underlying !== 'unspecified') {
      mutabilityPills.push(renderPill(`would be ${underlying}`, `${underlying}-muted`));
    }
  }
  // Auxiliary signals are orthogonal to mutability and worth a dedicated
  // slot — these surface inline with the title rather than in the meta strip
  // because they're rare and meaningful.
  const auxPills: SafeHtml[] = [];
  if (annotations?.openWorldHint) auxPills.push(renderPill('open-world', 'openworld'));
  if (tool.isTask) auxPills.push(renderPill('task', 'task'));
  if (tool.isApp) auxPills.push(renderPill('app', 'app'));

  const auxPillRow =
    auxPills.length > 0 ? html`<div class="pill-row" role="list">${auxPills}</div>` : html``;

  const scopeChips =
    tool.auth && tool.auth.length > 0
      ? html`<span class="card-scope" title="${tool.auth.join(', ')}"><span class="card-meta-label">scope</span>${tool.auth.map(
          (scope) => html` <code class="scope-chip">${scopeAccessLevel(scope)}</code>`,
        )}</span>`
      : html``;

  const schemaPreview = tool.inputSchema
    ? html`
        <details class="card-detail">
          <summary>schema</summary>
          <pre><code>${JSON.stringify(tool.inputSchema, null, 2)}</code></pre>
        </details>
      `
    : html``;

  // Disabled tools replace the invocation snippet with an operator-facing
  // disabled notice (reason + optional hint + optional `since`). Schema
  // preview stays — the contract a tool exposes is still useful info even
  // when the tool can't be invoked.
  const callout = isDisabled
    ? renderDisabledCallout(tool)
    : html`
        <details class="card-detail">
          <summary>invocation</summary>
          ${renderSnippet(`tool-${tool.name}`, buildInvocationSnippet(tool))}
        </details>
      `;

  const source = tool.sourceUrl
    ? html`<a class="source-link" href="${tool.sourceUrl}" rel="noopener" aria-label="View source for ${tool.name}">view source ↗</a>`
    : html``;

  // Search target: name + description as a single lowercase string. Hidden
  // attribute (not visible) so the filter script can match without parsing
  // DOM text repeatedly. Description gets normalized whitespace so multi-line
  // entries don't waste haystack length.
  const searchTarget = `${tool.name} ${tool.description}`.replace(/\s+/g, ' ').toLowerCase();

  const cardClass = isDisabled ? 'card tool-card tool-card--disabled' : 'card tool-card';

  return html`
    <article
      class="${cardClass}"
      id="${anchor}"
      data-tool-card
      data-mutability="${bucket}"
      data-name="${tool.name}"
      data-search="${searchTarget}"
    >
      <header class="card-head">
        <h3 class="card-title"><a href="#${anchor}">${tool.name}</a></h3>
        ${auxPillRow}
      </header>
      <p class="card-desc">${tool.description}</p>
      <footer class="card-foot">
        <div class="card-meta">
          <div class="pill-row pill-row--meta" role="list">${mutabilityPills}</div>
          ${scopeChips}
        </div>
        <div class="card-actions">
          ${callout}
          ${schemaPreview}
          ${source}
        </div>
      </footer>
    </article>
  `;
}

function renderDisabledCallout(tool: ManifestTool): SafeHtml {
  const meta = tool.disabled;
  if (!meta) return html``;
  const since = meta.since
    ? html` <span class="disabled-since">since ${meta.since}</span>`
    : html``;
  const hint = meta.hint
    ? html`<pre class="disabled-hint"><code>${meta.hint}</code></pre>`
    : html``;
  return html`
    <div class="disabled-callout" role="note">
      <p class="disabled-reason"><strong>Disabled.</strong> ${meta.reason}${since}</p>
      ${hint}
    </div>
  `;
}

/**
 * Map a tool to a mutability bucket using its annotations. Renders only what
 * the author actually declared:
 *
 * - `destructiveHint === true`        → `destructive`
 * - `readOnlyHint === true`           → `read`
 * - `readOnlyHint === false` (only)   → `write` (deliberate mutation claim)
 * - neither set                       → `unspecified` (no claim either way)
 *
 * The MCP spec defaults `destructiveHint` to `true` when `readOnlyHint` is
 * `false`, but treating annotation-less tools as `destructive` (or `write`,
 * the prior fallback) surprises readers — surfacing `unspecified` is
 * honest, gently nudges authors to declare, and keeps the safety pills as
 * deliberate signals rather than inferred ones.
 */
function classifyMutability(tool: ManifestTool): Mutability {
  const a = tool.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined;
  if (a?.destructiveHint === true) return 'destructive';
  if (a?.readOnlyHint === true) return 'read';
  if (a?.readOnlyHint === false) return 'write';
  return 'unspecified';
}

function bucketTools(tools: ManifestTool[]): Record<Bucket, ManifestTool[]> {
  const buckets: Record<Bucket, ManifestTool[]> = {
    read: [],
    unspecified: [],
    write: [],
    destructive: [],
    disabled: [],
  };
  for (const tool of tools) {
    if (tool.disabled) {
      buckets.disabled.push(tool);
      continue;
    }
    buckets[classifyMutability(tool)].push(tool);
  }
  return buckets;
}

/**
 * Reduce a colon-delimited scope (`tool:foo:read`) to its trailing access
 * level (`read`). Scopes that don't match the convention render verbatim —
 * the linter doesn't enforce shape, so falling back is friendlier than
 * eating the value.
 */
function scopeAccessLevel(scope: string): string {
  const idx = scope.lastIndexOf(':');
  if (idx < 0 || idx === scope.length - 1) return scope;
  return scope.slice(idx + 1);
}

function buildInvocationSnippet(tool: ManifestTool): string {
  const args: Record<string, unknown> = {};
  for (const field of tool.requiredFields) {
    args[field] = `<${field}>`;
  }
  return JSON.stringify(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: tool.name,
        arguments: args,
      },
    },
    null,
    2,
  );
}

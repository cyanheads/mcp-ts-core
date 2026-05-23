/**
 * @fileoverview Resources section — responsive card grid showing each
 * resource's URI template, mime type, description, and optional source link.
 *
 * @module src/mcp-server/transports/http/landing-page/sections/resources
 */

import type { ManifestResource } from '@/core/serverManifest.js';
import { html, type SafeHtml } from '@/utils/formatting/html.js';

import { renderSectionHeading } from '../primitives.js';

export function renderResourcesSection(resources: ManifestResource[]): SafeHtml {
  if (resources.length === 0) return html``;
  return html`
    <section aria-labelledby="section-resources">
      ${renderSectionHeading('section-resources', 'Resources', resources.length)}
      <div class="card-grid">${resources.map(renderResourceCard)}</div>
    </section>
  `;
}

function renderResourceCard(resource: ManifestResource): SafeHtml {
  const anchor = `resource-${slugifyUri(resource.uriTemplate || resource.name)}`;
  const source = resource.sourceUrl
    ? html`<a class="source-link" href="${resource.sourceUrl}" rel="noopener">view source ↗</a>`
    : html``;

  return html`
    <article class="card" id="${anchor}">
      <div class="card-head">
        <h3 class="card-title"><a href="#${anchor}">${resource.name}</a></h3>
      </div>
      <p class="card-desc">${resource.description}</p>
      <div class="card-meta">
        <span><span class="card-meta-label">uri</span> <code>${resource.uriTemplate}</code></span>
        ${resource.mimeType ? html`<span><span class="card-meta-label">mime</span> <code>${resource.mimeType}</code></span>` : html``}
      </div>
      ${source ? html`<footer class="card-foot">${source}</footer>` : html``}
    </article>
  `;
}

function slugifyUri(template: string): string {
  return template
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

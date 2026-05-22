/**
 * @fileoverview Prompts section — responsive card grid showing each prompt's
 * description, args list (with required markers + inline descriptions), and
 * optional source link.
 *
 * @module src/mcp-server/transports/http/landing-page/sections/prompts
 */

import type { ManifestPrompt } from '@/core/serverManifest.js';
import { html, type SafeHtml } from '@/utils/formatting/html.js';

import { renderSectionHeading } from '../primitives.js';

export function renderPromptsSection(prompts: ManifestPrompt[]): SafeHtml {
  if (prompts.length === 0) return html``;
  return html`
    <section aria-labelledby="section-prompts">
      ${renderSectionHeading('section-prompts', 'Prompts', prompts.length)}
      <div class="card-grid">${prompts.map(renderPromptCard)}</div>
    </section>
  `;
}

function renderPromptCard(prompt: ManifestPrompt): SafeHtml {
  const anchor = `prompt-${prompt.name}`;
  const source = prompt.sourceUrl
    ? html`<a class="source-link" href="${prompt.sourceUrl}" rel="noopener">view source ↗</a>`
    : html``;

  const argsList =
    prompt.args.length > 0
      ? html`
        <ul class="args-list">
          ${prompt.args.map(
            (arg) => html`
              <li>
                <code>${arg.name}</code>${
                  arg.required ? html`<span class="args-required">required</span>` : html``
                }
                ${arg.description ? html` — ${arg.description}` : html``}
              </li>
            `,
          )}
        </ul>
      `
      : html``;

  return html`
    <article class="card" id="${anchor}">
      <div class="card-head">
        <h3 class="card-title"><a href="#${anchor}">${prompt.name}</a></h3>
      </div>
      <p class="card-desc">${prompt.description}</p>
      ${argsList}
      ${source ? html`<footer class="card-foot">${source}</footer>` : html``}
    </article>
  `;
}

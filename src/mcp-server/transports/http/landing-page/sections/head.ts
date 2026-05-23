/**
 * @fileoverview `<head>` metadata renderer — title, description, Open Graph
 * tags, theme color, JSON-LD structured data, favicon (when a data URI logo
 * is available), canonical link, framework generator meta (when attribution
 * is on), and the `mcp-endpoint` / server-card alternate links.
 *
 * @module src/mcp-server/transports/http/landing-page/sections/head
 */

import type { ServerManifest } from '@/core/serverManifest.js';
import { html, type SafeHtml, unsafeRaw } from '@/utils/formatting/html.js';

/**
 * Open Graph locale tag. The landing page body is English-only (the surrounding
 * `<html lang="en">` matches), so a hardcoded `en_US` is accurate. Lift to a
 * `landing.locale` config option if i18n is ever wired up.
 */
const OG_LOCALE = 'en_US';

export function renderHead(manifest: ServerManifest, pageUrl: string): SafeHtml {
  const { server, landing, framework } = manifest;
  const title = `${server.name} · MCP server`;
  const description = landing.tagline ?? server.description ?? `MCP server: ${server.name}`;
  const ogImage = landing.logo?.startsWith('http')
    ? html`<meta property="og:image" content="${landing.logo}" />`
    : html``;
  const favicon =
    landing.logo && isImageDataUri(landing.logo)
      ? html`<link rel="icon" href="${landing.logo}" />`
      : html``;
  const themeColor = html`<meta name="theme-color" content="${landing.theme.accent}" />`;
  // Framework footprint marker (mirrors WordPress/Hugo/Jekyll/Gatsby's
  // generator convention). Gated on landing.attribution so operators who
  // opt out of the visible "Built on …" badge also opt out of the
  // machine-readable footprint.
  const generator = landing.attribution
    ? html`<meta name="generator" content="${framework.name} ${framework.version}" />`
    : html``;

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: server.name,
    description,
    applicationCategory: 'DeveloperApplication',
    softwareVersion: server.version,
    ...(server.homepage && { url: server.homepage }),
  });

  return html`
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <meta name="description" content="${description}" />
    ${generator}
    <link rel="canonical" href="${pageUrl}" />
    ${themeColor}
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="${server.name}" />
    <meta property="og:locale" content="${OG_LOCALE}" />
    <meta property="og:url" content="${pageUrl}" />
    ${ogImage}
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    ${favicon}
    <link rel="mcp-endpoint" href="${manifest.transport.endpointPath}" />
    <link rel="alternate" type="application/json" href="/.well-known/mcp.json" title="MCP Server Card" />
    <script type="application/ld+json">${unsafeRaw(escapeLdJson(jsonLd))}</script>
  `;
}

function isImageDataUri(value: string | undefined): boolean {
  if (!value) return false;
  return /^data:image\/(png|svg\+xml|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon)/i.test(value);
}

/**
 * Escape a JSON string for safe embedding inside `<script type="application/ld+json">`.
 * Replaces HTML-sensitive characters with Unicode escapes — `<` → `<`,
 * `>` → `>`, `&` → `&`, U+2028/U+2029 line terminators → escaped.
 * Matches the hardening recommendation in https://html.spec.whatwg.org/#script-data-state.
 */
function escapeLdJson(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * @fileoverview Builds the `Content-Security-Policy` header the sandbox applies to an MCP
 * Apps view, from the resource's `_meta.ui.csp`, as the MCP Apps specification prescribes
 * ("Content Security Policy Enforcement"; "Restrictive Default" when no metadata is given).
 * `eval` stays blocked: no `'unsafe-eval'` is ever added.
 * @module src/testing/apps/csp
 */

import { validationError } from '@/types-global/errors.js';

/** The domain lists of a resource's `_meta.ui.csp`. */
export interface AppCspMetadata {
  baseUriDomains?: string[];
  connectDomains?: string[];
  frameDomains?: string[];
  resourceDomains?: string[];
}

const RESTRICTIVE_DEFAULT = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

/** Characters that would let a domain entry end its directive or add a source keyword. */
const UNSAFE_ENTRY = /[;\r\n'"\s,]/;

/** The CSP header value for a view whose resource declared `csp` (or nothing). */
export function buildCsp(csp: AppCspMetadata | undefined): string {
  if (!csp) return RESTRICTIVE_DEFAULT;
  const list = (field: keyof AppCspMetadata): string => {
    const entries = csp[field] ?? [];
    for (const entry of entries) {
      if (typeof entry !== 'string' || entry === '' || UNSAFE_ENTRY.test(entry)) {
        throw validationError(
          `The resource's _meta.ui.csp.${field} holds ${JSON.stringify(entry)}, which is not a plain origin. Remove separators, quotes, and whitespace from CSP domain entries.`,
          { reason: 'invalid_csp_entry', field },
        );
      }
    }
    return entries.join(' ');
  };
  const resources = list('resourceDomains');
  const withSources = (head: string, sources: string) => (sources ? `${head} ${sources}` : head);
  return [
    "default-src 'none'",
    withSources("script-src 'self' 'unsafe-inline'", resources),
    withSources("style-src 'self' 'unsafe-inline'", resources),
    withSources("connect-src 'self'", list('connectDomains')),
    withSources("img-src 'self' data:", resources),
    withSources("font-src 'self'", resources),
    withSources("media-src 'self' data:", resources),
    `frame-src ${list('frameDomains') || "'none'"}`,
    "object-src 'none'",
    `base-uri ${list('baseUriDomains') || "'self'"}`,
  ].join('; ');
}

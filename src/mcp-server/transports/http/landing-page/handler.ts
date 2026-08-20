/**
 * @fileoverview Hono handler factory for `GET /` — serves the HTML landing
 * page. Cache and body shape depend on `manifest.landing.requireAuth` and,
 * when an auth strategy is provided, whether the caller presents a valid
 * bearer token.
 *
 * @module src/mcp-server/transports/http/landing-page/handler
 */

import type { Context } from 'hono';

import type { ServerManifest } from '@/core/serverManifest.js';
import type { AuthStrategy } from '@/mcp-server/transports/auth/strategies/authStrategy.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService, withExtra } from '@/utils/internal/requestContext.js';

import { renderLandingPage } from './render.js';

/**
 * Content-Security-Policy for the landing page. The page is fully
 * self-contained: a single inlined `<style>` block, a single inlined
 * copy-to-clipboard `<script>`, and a JSON-LD structured data block. Logos
 * are the only element with a variable source and are always either a
 * data URI or an `https://` URL. Nothing else is fetched, framed, or
 * submitted — the policy reflects that reality.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "img-src 'self' data: https:",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * Factory for the `GET /` route handler.
 *
 * Cache behavior and body shape depend on `manifest.landing.requireAuth`:
 *
 * | `requireAuth` | Authenticated | Unauthenticated |
 * |:---|:---|:---|
 * | `false` (default) | full page · `Cache-Control: public, max-age=60` | full page · same |
 * | `true` | full page · `Cache-Control: private, max-age=60` · `Vary: Authorization` | reduced hero-only page · same cache headers |
 *
 * When `requireAuth` is `true` the handler validates the bearer token via the
 * provided {@link AuthStrategy} (the same strategy the MCP endpoint uses). A
 * missing, malformed, or invalid token produces the degraded page. When no
 * auth strategy is configured (e.g. `MCP_AUTH_MODE=none`) while `requireAuth`
 * is on, there is no way to authenticate — every caller gets the degraded
 * page. This keeps the inventory hidden by default rather than falling back
 * to a header-presence heuristic that any caller can bypass.
 *
 * When `manifest.transport.publicUrl` is set, the base URL is deterministic,
 * so both page variants (full and degraded) are rendered once at factory
 * time and served from memory on each request — the render pipeline then
 * only runs when the origin must be derived per-request from
 * `new URL(c.req.url).origin`.
 */
export function createLandingPageHandler(
  manifest: ServerManifest,
  authStrategy?: AuthStrategy | null,
) {
  const { publicUrl } = manifest.transport;
  const precomputed = publicUrl
    ? {
        full: renderLandingPage(manifest, publicUrl, false),
        degraded: renderLandingPage(manifest, publicUrl, true),
      }
    : null;

  const requireAuth = manifest.landing.requireAuth;
  // When requireAuth is on without a strategy, `degraded` stays true on every
  // request and nobody unlocks the full inventory. Narrow the strategy once
  // so the per-request closure doesn't need a non-null assertion.
  const verifier: AuthStrategy | null = requireAuth && authStrategy ? authStrategy : null;

  return async (c: Context): Promise<Response> => {
    const context = requestContextService.createRequestContext({
      operation: 'landingPageHandler',
    });
    const baseUrl = publicUrl ?? new URL(c.req.url).origin;

    let isAuthenticated = false;
    if (verifier) {
      // Matches authMiddleware's extraction: case-sensitive 'Bearer ' prefix,
      // token is everything after. Keeps both surfaces consistent on what
      // counts as a well-formed Authorization header.
      const authHeader = c.req.header('authorization');
      const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined;
      if (token) {
        try {
          await verifier.verify(token);
          isAuthenticated = true;
        } catch (err) {
          logger.debug(
            'Landing page bearer validation failed.',
            withExtra(context, { error: err instanceof Error ? err.message : String(err) }),
          );
        }
      }
    }
    const degraded = requireAuth && !isAuthenticated;

    const html = precomputed
      ? degraded
        ? precomputed.degraded
        : precomputed.full
      : renderLandingPage(manifest, baseUrl, degraded);

    logger.debug(
      'Serving landing page.',
      withExtra(context, {
        accept: c.req.header('accept'),
        bytes: html.length,
        requireAuth,
        degraded,
        cached: precomputed !== null,
      }),
    );

    c.header('Content-Type', 'text/html; charset=utf-8');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    if (requireAuth) {
      c.header('Cache-Control', 'private, max-age=60');
      c.header('Vary', 'Authorization');
    } else {
      c.header('Cache-Control', 'public, max-age=60');
    }
    return c.body(html);
  };
}

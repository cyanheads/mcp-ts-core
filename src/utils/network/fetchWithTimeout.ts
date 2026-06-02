/**
 * @fileoverview Provides a utility function to make fetch requests with a specified timeout
 * and optional SSRF protection including DNS resolution validation and redirect following.
 * @module src/utils/network/fetchWithTimeout
 */
import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  timeout,
  validationError,
} from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { runtimeCaps } from '@/utils/internal/runtime.js';
import { httpStatusToErrorCode } from '@/utils/network/httpError.js';
import { createHistogram } from '@/utils/telemetry/metrics.js';

/** Maximum captured bytes of an upstream error response body. Keeps tool errors from poisoning the agent's context. */
const ERROR_BODY_LIMIT = 500;

let clientDurationHistogram: ReturnType<typeof createHistogram> | undefined;

function getHttpClientMetrics() {
  clientDurationHistogram ??= createHistogram(
    'http.client.request.duration',
    'Duration of outbound HTTP requests',
    's',
  );
  return { clientDurationHistogram };
}

/** Eagerly creates the HTTP client duration histogram so the series exists from startup. */
export function initHttpClientMetrics(): void {
  getHttpClientMetrics();
}

/**
 * Redacts a URL to `origin + pathname` for safe inclusion in error messages and
 * logs. Drops the query string — where API keys commonly ride (`?api-key=…`,
 * `?api_key=…`, `?key=…`) — along with the fragment and any embedded
 * `user:pass@` credentials (`URL.origin` omits userinfo). A trailing `?…` marks
 * that a query was present (redacted) so diagnostics still signal it; a
 * bare-domain `/` pathname is elided to keep output clean.
 *
 * Fail-closed: an unparseable URL returns a fixed placeholder rather than
 * echoing the raw (possibly secret-bearing) string.
 *
 * Used only for log/error *text* — never for the actual `fetch` call, which
 * always receives the full URL.
 */
function redactUrl(url: string | URL): string {
  try {
    const parsed = url instanceof URL ? url : new URL(String(url));
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    const marker = parsed.search ? '?…' : '';
    return `${parsed.origin}${path}${marker}`;
  } catch {
    return '[unparseable URL]';
  }
}

/**
 * Options for the `fetchWithTimeout` utility.
 *
 * Extends the standard `RequestInit` type, omitting `signal` (which is managed
 * internally via `AbortController`) and adding SSRF protection and caller-supplied
 * cancellation options.
 */
export interface FetchWithTimeoutOptions extends Omit<RequestInit, 'signal'> {
  /**
   * When `true`, rejects requests to private/reserved IP ranges and localhost.
   *
   * Use this when fetching user-controlled URLs to reduce the SSRF blast radius
   * against internal services (e.g., cloud metadata endpoints, internal APIs).
   * Covered ranges include RFC 1918, loopback (127.x, ::1), link-local (169.254.x),
   * CGNAT (100.64–127.x), and known internal hostnames (e.g., `metadata.google.internal`).
   *
   * DNS is resolved (via `node:dns/promises`) and all A/AAAA records are
   * validated against private ranges before the request is sent. Available in
   * Node, Bun, and Cloudflare Workers under `nodejs_compat`.
   *
   * When enabled, redirects are followed manually (up to {@link MAX_SSRF_REDIRECTS}
   * hops) with SSRF validation applied to each redirect target.
   *
   * **Best-effort, not a hard guarantee — DNS rebinding / TOCTOU still applies.**
   * The pre-validation lookup and the native `fetch` call's own DNS resolution
   * are independent. A malicious authoritative DNS server (or a low-TTL record
   * racing with cache eviction) can return a public IP at validation time and a
   * private IP at fetch time. This helper does not pin the validated address to
   * the connection.
   *
   * For strong SSRF isolation, layer this with network egress controls
   * (Cloudflare egress rules, k8s NetworkPolicy, host firewall), a fetch proxy
   * that performs DNS pinning, or an HTTP client that resolves once and connects
   * to the validated address.
   *
   * Default: `false` (no restriction).
   */
  rejectPrivateIPs?: boolean;
  /**
   * An optional external `AbortSignal` (e.g., `ctx.signal` from the request context)
   * to combine with the internal timeout signal. If this signal aborts before the
   * timeout fires, the fetch is cancelled immediately and a `McpError` with code
   * `InternalError` is thrown.
   */
  signal?: AbortSignal;
}

/**
 * IPv4 patterns for private/reserved ranges that should be blocked when
 * `rejectPrivateIPs` is enabled. Covers RFC 1918, loopback, link-local,
 * and cloud metadata endpoints.
 */
const PRIVATE_IP_PATTERNS = [
  /^127\./, // Loopback
  /^10\./, // RFC 1918 Class A
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC 1918 Class B
  /^192\.168\./, // RFC 1918 Class C
  /^169\.254\./, // Link-local / cloud metadata
  /^0\./, // Current network
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // RFC 6598 (CGNAT)
];

/**
 * IPv6 patterns for private/reserved ranges. Anchored to a 4-hex-digit first
 * segment so canonical forms (e.g. `0fe8::1` → `fe8::1`) don't false-positive
 * against link-local/ULA prefixes.
 */
const PRIVATE_IPV6_PATTERNS = [
  /^fe[89ab][0-9a-f]:/i, // fe80::/10 link-local (third nibble 8/9/a/b)
  /^f[cd][0-9a-f]{2}:/i, // fc00::/7 ULA
];

const PRIVATE_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'metadata.internal']);

/** Maximum number of redirects to follow when rejectPrivateIPs is enabled. */
const MAX_SSRF_REDIRECTS = 5;

/**
 * Extracts the embedded IPv4 from an IPv4-mapped IPv6 address. Accepts both
 * the dotted-decimal form (`::ffff:127.0.0.1`) and the all-hex form
 * (`::ffff:7f00:1`) that URL parsers canonicalize the dotted form into.
 *
 * @returns Dotted-decimal IPv4 string, or `undefined` if not an IPv4-mapped form.
 */
function extractMappedIpv4(lower: string): string | undefined {
  const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = Number.parseInt(hex[1] ?? '0', 16);
    const low = Number.parseInt(hex[2] ?? '0', 16);
    return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }
  return;
}

/**
 * Checks whether an IP address (v4 or v6, including IPv4-mapped IPv6) falls
 * within a private or reserved range.
 *
 * IPv4-mapped IPv6 addresses are unwrapped and run through the IPv4 patterns,
 * so the full RFC 1918 / CGNAT / link-local space is covered automatically
 * without duplicating the table.
 *
 * @param ip - The IP address string to check (bare, no brackets).
 * @returns `true` if the address is private or reserved, `false` otherwise.
 */
function isPrivateIP(ip: string): boolean {
  if (PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(ip))) return true;
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
  const mapped = extractMappedIpv4(lower);
  if (mapped !== undefined) return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(mapped));
  return PRIVATE_IPV6_PATTERNS.some((pattern) => pattern.test(lower));
}

/**
 * Validates that a URL string does not target private or reserved IP space.
 *
 * Performs three checks in order:
 * 1. Known private hostnames (`localhost`, `metadata.google.internal`, etc.)
 * 2. Literal IPv4/IPv6 addresses in the URL hostname
 * 3. DNS resolution — resolves A and AAAA records and validates each
 *    (Node, Bun, Workers under `nodejs_compat`; skipped in pure-browser envs)
 *
 * DNS resolution failures (ENOTFOUND, etc.) are swallowed and left for the native
 * `fetch` to handle; only confirmed private IPs cause rejection.
 *
 * **Best-effort guard, not a hard SSRF boundary.** This validation runs before the
 * native `fetch` call performs its own DNS resolution. A malicious authoritative
 * DNS server can return a public IP for this lookup and a private IP for the
 * fetch's lookup (DNS rebinding / TOCTOU). Strong SSRF isolation requires
 * out-of-band controls — see {@link FetchWithTimeoutOptions.rejectPrivateIPs}.
 *
 * @param urlString - The fully-qualified URL string to validate.
 * @throws {McpError} `ValidationError` if the URL is malformed, the hostname is a known
 *   internal name, the literal IP is private, or DNS resolves to a private address.
 */
async function assertNotPrivateUrl(urlString: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    // Don't echo the raw string — it failed to parse and may carry a secret query.
    throw validationError('Invalid URL: could not be parsed.');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, ''); // Strip IPv6 brackets

  // Check known private hostnames
  if (PRIVATE_HOSTNAMES.has(hostname.toLowerCase())) {
    throw validationError(`Request to private/internal hostname blocked: ${hostname}`);
  }

  // Check literal IP (v4, v6, or IPv4-mapped IPv6)
  if (isPrivateIP(hostname)) {
    throw validationError(`Request to private/reserved IP blocked: ${hostname}`);
  }

  // `node:dns/promises` is available in Node, Bun, and Workers under
  // `nodejs_compat`. `isNode` covers all three.
  if (runtimeCaps.isNode) {
    await assertDnsNotPrivate(hostname);
  }
}

/**
 * Resolves DNS for a hostname (A and AAAA records in parallel) and confirms
 * that none of the resolved IP addresses fall within private or reserved ranges.
 *
 * DNS resolution errors (e.g., `ENOTFOUND`) are silently swallowed — they are
 * not an SSRF signal and are better handled by the native `fetch` call.
 *
 * **TOCTOU caveat:** the resolved addresses are not pinned to the subsequent
 * `fetch` connection — the native fetch performs its own resolution and may
 * receive a different answer (DNS rebinding, low-TTL race). This is a guard,
 * not a guarantee.
 *
 * @param hostname - The bare hostname to resolve (no brackets, no port).
 * @throws {McpError} `ValidationError` if any resolved address is private.
 */
async function assertDnsNotPrivate(hostname: string): Promise<void> {
  try {
    const dns = await import('node:dns/promises');

    const [ipv4Results, ipv6Results] = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname),
    ]);

    const resolvedIPs: string[] = [
      ...(ipv4Results.status === 'fulfilled' ? ipv4Results.value : []),
      ...(ipv6Results.status === 'fulfilled' ? ipv6Results.value : []),
    ];

    for (const ip of resolvedIPs) {
      if (isPrivateIP(ip)) {
        throw validationError(`DNS resolved ${hostname} to private IP ${ip} — SSRF blocked`);
      }
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    // DNS resolution failures (ENOTFOUND, etc.) are not SSRF — let fetch handle them
  }
}

/**
 * Fetches a resource with a configurable timeout and optional SSRF protection.
 *
 * Internally manages an `AbortController` that fires after `timeoutMs`. An optional
 * external `signal` (e.g., `ctx.signal`) can be passed via `options` to support
 * early cancellation by the caller. The two signals are composed — whichever fires
 * first wins.
 *
 * When `options.rejectPrivateIPs` is `true`, the target URL is validated before the
 * request is sent, and all redirects are followed manually with per-hop SSRF checks
 * (up to 5 hops). This mode forces `redirect: 'manual'` on the underlying fetch.
 *
 * Non-2xx responses are treated as errors. The response body is read (truncated
 * to {@link ERROR_BODY_LIMIT} bytes to avoid context-window poisoning when an
 * upstream returns an HTML error page), logged, and wrapped in a `McpError`
 * whose code is mapped from the HTTP status via {@link httpStatusToErrorCode}
 * (e.g. 400 → `InvalidParams`, 403 → `Forbidden`, 404 → `NotFound`, 429 →
 * `RateLimited`, 5xx → `ServiceUnavailable`/`InternalError`/`Timeout`).
 *
 * @param url - The URL to fetch (string or `URL` instance).
 * @param timeoutMs - Maximum duration in milliseconds before the request is aborted.
 * @param context - Log bindings for correlated logging (`requestId`, `operation`, etc.).
 *   Passing the handler `Context` is safe — the logger strips non-serializable fields
 *   such as `signal`, `log`, `state`, and protocol method handles. Pass
 *   `options.signal = ctx.signal` explicitly to wire cancellation.
 * @param options - Optional fetch configuration extending `RequestInit`.
 *   - `rejectPrivateIPs`: Block requests to private/internal IP space (SSRF protection).
 *   - `signal`: External `AbortSignal` to cancel the request independently of the timeout.
 *   - All other standard `RequestInit` fields (method, headers, body, etc.) are forwarded.
 * @returns A promise resolving to the `Response` object on HTTP 2xx.
 * @throws {McpError} `ValidationError` if the URL targets a private/reserved address
 *   and `rejectPrivateIPs` is enabled.
 * @throws {McpError} `Timeout` if the request exceeds `timeoutMs`.
 * @throws {McpError} `InternalError` if the request is cancelled via the external signal.
 * @throws {McpError} A status-mapped code (`InvalidParams`/`Unauthorized`/`Forbidden`/
 *   `NotFound`/`RateLimited`/`ServiceUnavailable`/...) if the server returns a non-2xx
 *   status. `error.data` carries `{ statusCode, statusText, responseBody, retryAfter? }`.
 * @throws {McpError} `ServiceUnavailable` if a network-level error occurs.
 * @example
 * ```ts
 * // Basic GET with a 5-second timeout
 * const response = await fetchWithTimeout(
 *   'https://api.example.com/data',
 *   5000,
 *   ctx,
 * );
 * const data = await response.json();
 *
 * // POST with SSRF protection and caller-cancellable signal
 * const response = await fetchWithTimeout(
 *   userProvidedUrl,
 *   10_000,
 *   ctx,
 *   {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify(payload),
 *     rejectPrivateIPs: true,
 *     signal: ctx.signal,
 *   },
 * );
 * ```
 */
export async function fetchWithTimeout(
  url: string | URL,
  timeoutMs: number,
  context: RequestContext,
  options?: FetchWithTimeoutOptions,
): Promise<Response> {
  const urlString = url.toString();

  // SSRF protection: reject private/internal targets when enabled
  if (options?.rejectPrivateIPs) {
    await assertNotPrivateUrl(urlString);
  }

  const operationDescription = `fetch ${options?.method || 'GET'} ${redactUrl(urlString)}`;

  logger.debug(`Attempting ${operationDescription} with ${timeoutMs}ms timeout.`, context);

  // Strip custom options before passing to native fetch
  const { rejectPrivateIPs: rejectPrivate, signal: externalSignal, ...fetchInit } = options ?? {};

  // When SSRF protection is active, handle redirects manually to validate each hop
  if (rejectPrivate) {
    fetchInit.redirect = 'manual';
  }

  // Use AbortController instead of AbortSignal.timeout() for cross-runtime compatibility
  // (AbortSignal.timeout() can fail in Bun's stdio transport due to realm mismatch)
  const controller = new AbortController();
  const timeoutSentinel = 'FETCH_TIMEOUT';
  const timeoutId = setTimeout(() => controller.abort(timeoutSentinel), timeoutMs);

  // If an external signal is provided (e.g., client disconnect), forward its abort
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), {
        once: true,
        signal: controller.signal,
      });
    }
  }

  const startTime = performance.now();
  const parsedUrl = new URL(urlString);
  const method = (fetchInit.method ?? 'GET').toUpperCase();
  let statusCode = 0;

  try {
    let currentUrl: string | URL = url;
    let redirectCount = 0;

    for (;;) {
      const response = await fetch(currentUrl, {
        ...fetchInit,
        signal: controller.signal,
      });

      // Handle redirects manually when SSRF protection is active
      if (rejectPrivate && response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw serviceUnavailable(
            `Redirect response missing Location header from ${redactUrl(currentUrl)}`,
          );
        }

        redirectCount++;
        if (redirectCount > MAX_SSRF_REDIRECTS) {
          throw validationError(
            `Too many redirects (${MAX_SSRF_REDIRECTS}) — possible SSRF redirect loop`,
          );
        }

        // Resolve relative redirect URLs against the current URL
        const redirectUrl = new URL(location, currentUrl.toString()).toString();

        // Validate the redirect target against SSRF rules
        await assertNotPrivateUrl(redirectUrl);

        logger.debug(
          `Following validated redirect ${redirectCount}: ${redactUrl(redirectUrl)}`,
          context,
        );
        currentUrl = redirectUrl;
        continue;
      }

      statusCode = response.status;

      if (!response.ok) {
        const rawBody = await response.text().catch(() => 'Could not read response body');
        const responseBody =
          rawBody.length > ERROR_BODY_LIMIT ? `${rawBody.slice(0, ERROR_BODY_LIMIT)}…` : rawBody;
        logger.error(`Fetch failed for ${redactUrl(currentUrl)} with status ${response.status}.`, {
          ...context,
          statusCode: response.status,
          statusText: response.statusText,
          responseBody,
          errorSource: 'FetchHttpError',
        });
        const code = httpStatusToErrorCode(response.status) ?? JsonRpcErrorCode.InternalError;
        const retryAfter = response.headers.get('retry-after');
        throw new McpError(
          code,
          `Fetch failed for ${redactUrl(currentUrl)}. Status: ${response.status}`,
          {
            requestId: context.requestId,
            operation: context.operation as string | undefined,
            statusCode: response.status,
            statusText: response.statusText,
            responseBody,
            ...(retryAfter !== null && { retryAfter }),
            errorSource: 'FetchHttpError',
          },
        );
      }

      logger.debug(
        `Successfully fetched ${redactUrl(currentUrl)}. Status: ${response.status}`,
        context,
      );
      return response;
    }
  } catch (error: unknown) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      const isTimeout =
        error.name === 'TimeoutError' || controller.signal.reason === timeoutSentinel;
      if (isTimeout) {
        logger.error(`${operationDescription} timed out after ${timeoutMs}ms.`, {
          ...context,
          errorSource: 'FetchTimeout',
        });
        throw timeout(`${operationDescription} timed out.`, {
          requestId: context.requestId,
          operation: context.operation as string | undefined,
          errorSource: 'FetchTimeout',
        });
      }
      // External signal abort (e.g., client disconnect) — not a timeout
      logger.info(`${operationDescription} aborted by caller.`, {
        ...context,
        errorSource: 'FetchAborted',
      });
      throw new McpError(JsonRpcErrorCode.InternalError, `${operationDescription} was aborted.`, {
        requestId: context.requestId,
        operation: context.operation as string | undefined,
        errorSource: 'FetchAborted',
      });
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Network error during ${operationDescription}: ${errorMessage}`, {
      ...context,
      originalErrorName: error instanceof Error ? error.name : 'UnknownError',
      errorSource: 'FetchNetworkError',
    });

    if (error instanceof McpError) {
      throw error;
    }

    throw serviceUnavailable(`Network error during ${operationDescription}: ${errorMessage}`, {
      requestId: context.requestId,
      operation: context.operation as string | undefined,
      originalErrorName: error instanceof Error ? error.name : 'UnknownError',
      errorSource: 'FetchNetworkErrorWrapper',
    });
  } finally {
    clearTimeout(timeoutId);
    const durationS = (performance.now() - startTime) / 1000;
    const attrs: Record<string, string | number> = {
      'http.request.method': method,
      'server.address': parsedUrl.hostname,
    };
    if (statusCode > 0) {
      attrs['http.response.status_code'] = statusCode;
    }
    getHttpClientMetrics().clientDurationHistogram.record(durationS, attrs);
  }
}

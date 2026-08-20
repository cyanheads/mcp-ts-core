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
import { type RequestContext, withExtra } from '@/utils/internal/requestContext.js';
import { runtimeCaps } from '@/utils/internal/runtime.js';
import { httpStatusToErrorCode } from '@/utils/network/httpError.js';
import { readBoundedResponseText } from '@/utils/network/responseBody.js';
import { createHistogram } from '@/utils/telemetry/metrics.js';

/** Default captured bytes of an upstream error response body. Keeps tool errors from poisoning the agent's context. */
const ERROR_BODY_LIMIT = 500;

/**
 * Bytes of an error body the capture may *read* to locate its end. Well above
 * {@link ERROR_BODY_LIMIT} so a document that wraps its diagnostic in a preamble
 * is seen whole and captured head + tail; anything still streaming at this
 * ceiling falls back to a head-only capture.
 */
const ERROR_BODY_SCAN_LIMIT = 16_384;

/**
 * Statuses the Fetch spec defines as carrying a null body. Runtimes disagree on
 * what `fetch` hands back for them — Node yields `body: null`, Bun yields an
 * empty stream — and `new Response(stream, { status })` throws on Node for
 * exactly this set, so these responses are returned untouched.
 */
const NULL_BODY_STATUS = new Set([204, 205, 304]);

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
   * Bytes of a non-2xx response body captured into `error.data.body` and the
   * failure log. The cap bounds how much upstream text reaches the agent's
   * context; it is not a judgement about which part of the body is diagnostic,
   * so an over-budget document is captured from both ends around an elision
   * marker rather than head-truncated.
   *
   * Raise it for an upstream whose error documents are larger than the useful
   * window (a verbose HTML or XML fault wrapper). Default: `500`.
   */
  errorBodyLimit?: number;
  /**
   * HTTP status codes the caller treats as an *expected* outcome rather than a
   * failure — e.g. a service that maps `404` to an empty result set. A non-2xx
   * response whose status is listed is logged at `debug` instead of `error`;
   * the status-mapped `McpError` is still thrown, unchanged, so the caller's
   * catch and classification stay byte-identical — only the log severity drops.
   *
   * Default: empty — every non-2xx response is logged at `error`.
   */
  expectedStatuses?: number[];
  /**
   * When `true`, rejects requests to non-global/reserved IP ranges and localhost.
   *
   * Use this when fetching user-controlled URLs to reduce the SSRF blast radius
   * against internal services (e.g., cloud metadata endpoints, internal APIs).
   * Covered ranges include private/shared space, loopback, link-local, unspecified,
   * protocol assignments, documentation/benchmarking ranges, multicast, reserved,
   * broadcast, and known internal hostnames (e.g., `metadata.google.internal`).
   *
   * DNS is resolved (via `node:dns/promises`) and all A/AAAA records are
   * validated against those ranges before the request is sent. Available in
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
 * Parse a dotted-decimal IPv4 address. URL parsing canonicalizes unusual IPv4
 * spellings (integer, octal, hexadecimal) before this point; DNS answers are
 * already dotted decimal.
 */
function parseIpv4(ip: string): [number, number, number, number] | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return;
  return octets as [number, number, number, number];
}

/**
 * IPv4 destinations that are not globally routable unicast. Includes private,
 * shared, loopback, link-local, protocol-assignment, documentation,
 * benchmarking, multicast, reserved, and limited-broadcast space.
 */
function isNonGlobalIpv4(ip: string): boolean {
  const octets = parseIpv4(ip);
  if (!octets) return false;
  const [a, b, c, d] = octets;

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC 6598 shared/CGNAT
  if (a === 169 && b === 254) return true; // Link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return d !== 9 && d !== 10;
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return d !== 2; // Deprecated 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return true; // Benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  return a >= 224; // Multicast (224/4), reserved (240/4), limited broadcast
}

/** Convert a conventional or compressed IPv6 address to a 128-bit integer. */
function ipv6ToBigInt(ip: string): bigint | undefined {
  let lower = ip.toLowerCase();
  if (!lower.includes(':') || lower.includes('%')) return;

  // DNS APIs may retain dotted-decimal notation in an IPv4-embedded address,
  // while URL parsing canonicalizes it to two hexadecimal segments.
  if (lower.includes('.')) {
    const finalColon = lower.lastIndexOf(':');
    const embedded = parseIpv4(lower.slice(finalColon + 1));
    if (!embedded) return;
    const [a, b, c, d] = embedded;
    lower = `${lower.slice(0, finalColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = lower.split('::');
  if (halves.length > 2) return;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return;

  const segments = [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
  if (segments.length !== 8 || segments.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return;

  return segments.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function isInIpv6Cidr(value: bigint, network: string, prefixLength: number): boolean {
  const networkValue = ipv6ToBigInt(network);
  if (networkValue === undefined) return false;
  const shift = 128n - BigInt(prefixLength);
  return value >> shift === networkValue >> shift;
}

/** Non-global/reserved ranges within the otherwise globally routed 2000::/3 block. */
const NON_GLOBAL_IPV6_CIDRS: ReadonlyArray<readonly [network: string, prefixLength: number]> = [
  ['2001::', 32], // Teredo transition space
  ['2001:2::', 48], // Benchmarking
  ['2001:10::', 28], // ORCHID
  ['2001:20::', 28], // ORCHIDv2
  ['2001:db8::', 32], // Documentation
  ['2002::', 16], // Deprecated 6to4 transition space
  ['3fff::', 20], // Documentation
];

function isNonGlobalIpv6(ip: string): boolean {
  const value = ipv6ToBigInt(ip);
  if (value === undefined) return false;

  // Current globally routable IPv6 unicast allocation. This rejects unspecified,
  // loopback, IPv4-compatible, discard-only, ULA, site/link-local, and multicast.
  if (!isInIpv6Cidr(value, '2000::', 3)) return true;
  return NON_GLOBAL_IPV6_CIDRS.some(([network, prefix]) => isInIpv6Cidr(value, network, prefix));
}

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
 * Checks whether an IP address (v4 or v6, including IPv4-mapped IPv6) is not a
 * globally routable unicast destination.
 *
 * IPv4-mapped IPv6 addresses are unwrapped and run through the IPv4 check, so
 * the full RFC 1918 / CGNAT / link-local space is covered automatically without
 * duplicating the ranges.
 *
 * @param ip - The IP address string to check (bare, no brackets).
 * @returns `true` if the address is not globally routable unicast, `false` otherwise.
 */
function isNonGlobalIP(ip: string): boolean {
  if (isNonGlobalIpv4(ip)) return true;
  const lower = ip.toLowerCase();
  const mapped = extractMappedIpv4(lower);
  if (mapped !== undefined) return isNonGlobalIpv4(mapped);
  return isNonGlobalIpv6(lower);
}

/** Parses a URL, rejecting anything that isn't a well-formed `http:`/`https:` target. */
function parseHttpUrl(urlString: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    // Don't echo the raw string — it failed to parse and may carry a secret query.
    throw validationError('Invalid URL: could not be parsed.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw validationError('Only HTTP and HTTPS URLs are allowed.');
  }
  return parsed;
}

/**
 * Validates that an HTTP(S) URL does not target non-global or reserved IP space.
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
 *   internal name, the literal IP is non-global, or DNS resolves to a non-global address.
 */
async function assertNotPrivateUrl(urlString: string): Promise<void> {
  const parsed = parseHttpUrl(urlString);

  const hostname = parsed.hostname.replace(/^\[|\]$/g, ''); // Strip IPv6 brackets

  // Check known private hostnames
  if (PRIVATE_HOSTNAMES.has(hostname.toLowerCase())) {
    throw validationError(`Request to private/internal hostname blocked: ${hostname}`);
  }

  // Check literal IP (v4, v6, or IPv4-mapped IPv6)
  if (isNonGlobalIP(hostname)) {
    throw validationError(`Request to non-global/reserved IP blocked: ${hostname}`);
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
 * @throws {McpError} `ValidationError` if any resolved address is non-global.
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
      if (isNonGlobalIP(ip)) {
        throw validationError(`DNS resolved ${hostname} to non-global IP ${ip} — SSRF blocked`);
      }
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    // DNS resolution failures (ENOTFOUND, etc.) are not SSRF — let fetch handle them
  }
}

/**
 * Re-wraps a 2xx response so the request deadline keeps covering the body.
 *
 * `fetch` resolves once headers arrive, so a deadline disarmed at that point
 * leaves the caller's `.text()`/`.json()` unbounded — a peer that answers
 * promptly and then stalls the stream holds the exchange open indefinitely.
 * The returned response streams through a passthrough that reports back when
 * the body closes, errors, or is cancelled, which is what disarms the deadline;
 * until then an expiring deadline aborts the stream mid-read and the caller's
 * body read rejects with the classified failure from `classify`.
 *
 * `new Response` cannot carry `url`/`redirected`/`type` across, so they are
 * restored onto the wrapper — a caller following redirects still sees the final
 * URL, and the response reports the same kind it did before the passthrough.
 */
function withBodyDeadline(
  response: Response,
  body: NonNullable<Response['body']>,
  deadline: { settle: () => void; classify: (error: unknown) => unknown },
): Response {
  const source = body.getReader();
  const monitored = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await source.read();
        if (done) {
          deadline.settle();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        deadline.settle();
        controller.error(deadline.classify(error));
      }
    },
    cancel(reason) {
      deadline.settle();
      return source.cancel(reason);
    },
  });

  const wrapped = new Response(monitored, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperty(wrapped, 'url', { value: response.url, configurable: true });
  Object.defineProperty(wrapped, 'redirected', { value: response.redirected, configurable: true });
  Object.defineProperty(wrapped, 'type', { value: response.type, configurable: true });
  return wrapped;
}

/**
 * Fetches a resource with a configurable timeout and optional SSRF protection.
 *
 * Internally manages an `AbortController` that fires after `timeoutMs`. An optional
 * external `signal` (e.g., `ctx.signal`) can be passed via `options` to support
 * early cancellation by the caller. The two signals are composed — whichever fires
 * first wins.
 *
 * `timeoutMs` bounds the **whole exchange**, headers and body. `fetch` resolves
 * once headers arrive, so on a 2xx the deadline is handed to the response body:
 * the returned `Response` streams through a passthrough that disarms the
 * deadline when the body closes, errors, or is cancelled. A body still pending
 * when the deadline expires is aborted mid-read and the caller's
 * `.text()`/`.json()` rejects with the same `Timeout` `McpError` the header
 * phase would have thrown. A caller that never reads the body has its stream
 * aborted at the deadline rather than held open.
 *
 * When `options.rejectPrivateIPs` is `true`, the target URL is validated before the
 * request is sent, and all redirects are followed manually with per-hop SSRF checks
 * (up to 5 hops). This mode forces `redirect: 'manual'` on the underlying fetch.
 *
 * Non-2xx responses are treated as errors. The response body is captured under a
 * byte budget (`options.errorBodyLimit`, default {@link ERROR_BODY_LIMIT}) to avoid
 * context-window poisoning when an upstream returns an HTML error page, logged,
 * and wrapped in a `McpError` whose code is mapped from the HTTP status via
 * {@link httpStatusToErrorCode} (e.g. 400 → `InvalidParams`, 403 → `Forbidden`,
 * 404 → `NotFound`, 429 → `RateLimited`, 5xx →
 * `ServiceUnavailable`/`InternalError`/`Timeout`).
 *
 * @param url - The URL to fetch (string or `URL` instance).
 * @param timeoutMs - Maximum duration in milliseconds before the exchange is aborted.
 * @param context - Log bindings for correlated logging (`requestId`, `operation`, etc.).
 *   Accepts the handler `Context` as well as a `RequestContext` bag — the logger
 *   strips non-serializable fields such as `signal`, `log`, `state`, and protocol
 *   method handles. Pass `options.signal = ctx.signal` explicitly to wire cancellation.
 * @param options - Optional fetch configuration extending `RequestInit`.
 *   - `rejectPrivateIPs`: Block requests to private/internal IP space (SSRF protection).
 *   - `signal`: External `AbortSignal` to cancel the request independently of the timeout.
 *   - `errorBodyLimit`: Bytes of a non-2xx body captured into `error.data.body`.
 *   - All other standard `RequestInit` fields (method, headers, body, etc.) are forwarded.
 * @returns A promise resolving to the `Response` object on HTTP 2xx. On a response
 *   carrying a body this is a wrapper around the original: status, statusText,
 *   headers, `url`, `redirected`, and `type` are preserved, and the body streams
 *   through unchanged under the deadline.
 * @throws {McpError} `ValidationError` for a non-HTTP(S) URL, or if the URL targets
 *   a non-global/reserved address and `rejectPrivateIPs` is enabled.
 * @throws {McpError} `Timeout` if the exchange exceeds `timeoutMs`. Raised from the
 *   call itself when the deadline expires before headers, and from the body read
 *   when it expires during the stream.
 * @throws {McpError} `InternalError` if the request is cancelled via the external
 *   signal — likewise from the body read when the cancellation lands mid-stream.
 * @throws {McpError} A status-mapped code (`InvalidParams`/`Unauthorized`/`Forbidden`/
 *   `NotFound`/`RateLimited`/`ServiceUnavailable`/...) if the server returns a non-2xx
 *   status. `error.data` carries `{ status, statusText, body, retryAfter? }` — plus the
 *   legacy aliases `statusCode` (= `status`) and `responseBody` (= `body`), kept for
 *   existing consumers and slated for consolidation in a future major. List a status in
 *   `options.expectedStatuses` to log it at `debug` rather than `error` (still thrown).
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
  const parsedUrl = parseHttpUrl(urlString);

  // SSRF protection: reject non-global/internal targets when enabled
  if (options?.rejectPrivateIPs) {
    await assertNotPrivateUrl(urlString);
  }

  const operationDescription = `fetch ${options?.method || 'GET'} ${redactUrl(urlString)}`;

  logger.debug(`Attempting ${operationDescription} with ${timeoutMs}ms timeout.`, context);

  // Strip custom options before passing to native fetch
  const {
    rejectPrivateIPs: rejectPrivate,
    signal: externalSignal,
    expectedStatuses,
    errorBodyLimit = ERROR_BODY_LIMIT,
    ...fetchInit
  } = options ?? {};

  // When SSRF protection is active, handle redirects manually to validate each hop
  if (rejectPrivate) {
    fetchInit.redirect = 'manual';
  }

  // Use AbortController instead of AbortSignal.timeout() for cross-runtime compatibility
  // (AbortSignal.timeout() can fail in Bun's stdio transport due to realm mismatch)
  const controller = new AbortController();
  /**
   * Abort with a real exception, not a string. `fetch` rejects with the abort
   * reason *value*, so a string reason produces a rejection that no
   * `instanceof Error` branch can classify — the timeout then falls through to
   * the generic network-error wrapper. A `TimeoutError` DOMException is what
   * `AbortSignal.timeout()` itself raises, and holding the instance lets the
   * catch block identity-match it: a caller signal that aborts with its own
   * `TimeoutError` stays classified as a caller abort, not our timeout.
   */
  const timeoutReason = new DOMException(
    `${operationDescription} timed out after ${timeoutMs}ms.`,
    'TimeoutError',
  );
  const timeoutId = setTimeout(() => controller.abort(timeoutReason), timeoutMs);

  // Compose the timeout signal with any caller-supplied signal. AbortSignal.any
  // is available on all supported floors (Node ≥24, Bun ≥1.3, workerd).
  const fetchSignal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;

  /**
   * Set once the deadline has been handed to the response body, so the `finally`
   * below leaves it armed for the caller's read instead of disarming it at return.
   */
  let deadlineFollowsBody = false;
  const errorIdentity = {
    requestId: context.requestId,
    operation: context.operation,
  };
  const timeoutFailure = (): McpError => {
    logger.error(
      `${operationDescription} timed out after ${timeoutMs}ms.`,
      withExtra(context, { errorSource: 'FetchTimeout' }),
    );
    return timeout(`${operationDescription} timed out.`, {
      ...errorIdentity,
      errorSource: 'FetchTimeout',
    });
  };
  const abortedFailure = (): McpError => {
    logger.info(
      `${operationDescription} aborted by caller.`,
      withExtra(context, { errorSource: 'FetchAborted' }),
    );
    return new McpError(JsonRpcErrorCode.InternalError, `${operationDescription} was aborted.`, {
      ...errorIdentity,
      errorSource: 'FetchAborted',
    });
  };

  const startTime = performance.now();
  const method = (fetchInit.method ?? 'GET').toUpperCase();
  let statusCode = 0;

  try {
    let currentUrl: string | URL = url;
    let redirectCount = 0;

    for (;;) {
      const response = await fetch(currentUrl, {
        ...fetchInit,
        signal: fetchSignal,
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
        const responseBody = await readBoundedResponseText(response, errorBodyLimit, {
          scanBytes: ERROR_BODY_SCAN_LIMIT,
        }).catch(() => 'Could not read response body');
        // Callers that treat a status as expected (e.g. 404 → empty result) get a
        // debug line instead of error; the thrown McpError below is unchanged.
        const logMessage = `Fetch failed for ${redactUrl(currentUrl)} with status ${response.status}.`;
        const logPayload = withExtra(context, {
          statusCode: response.status,
          statusText: response.statusText,
          responseBody,
          errorSource: 'FetchHttpError',
        });
        if (expectedStatuses?.includes(response.status)) {
          logger.debug(logMessage, logPayload);
        } else {
          logger.error(logMessage, logPayload);
        }
        const code = httpStatusToErrorCode(response.status) ?? JsonRpcErrorCode.InternalError;
        const retryAfter = response.headers.get('retry-after');
        throw new McpError(
          code,
          `Fetch failed for ${redactUrl(currentUrl)}. Status: ${response.status}`,
          {
            ...errorIdentity,
            // Canonical (Fetch `Response`-aligned) field names.
            status: response.status,
            statusText: response.statusText,
            body: responseBody,
            // Legacy aliases — kept for consumers reading the original shape;
            // slated for consolidation onto `status`/`body` in a future major.
            statusCode: response.status,
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

      // Nothing left to read (HEAD, 204, …) — the exchange is over, disarm at return.
      if (!response.body || NULL_BODY_STATUS.has(response.status)) return response;

      deadlineFollowsBody = true;
      /**
       * The deadline now outlives this call, so it must stop holding the event
       * loop open: a caller that reads the status and drops the response would
       * otherwise pin the runtime for the rest of `timeoutMs`. Unref'd, the
       * abort still fires in any process with work left to do — a server, which
       * is where a stalled socket actually needs closing.
       */
      (timeoutId as { unref?: () => void }).unref?.();
      return withBodyDeadline(response, response.body, {
        settle: () => clearTimeout(timeoutId),
        classify: (error) => {
          if (controller.signal.reason === timeoutReason) return timeoutFailure();
          if (fetchSignal.aborted) return abortedFailure();
          return error;
        },
      });
    }
  } catch (error: unknown) {
    // A status-mapped HTTP error from the non-OK branch was already logged there,
    // at the severity the caller asked for (`expectedStatuses` → debug). Re-throw
    // it as-is instead of relabeling it a network error and logging it again.
    if (error instanceof McpError && error.data?.errorSource === 'FetchHttpError') {
      throw error;
    }

    /**
     * Classify aborts from the signals, not from the rejection value. `fetch`
     * rejects with the abort *reason*, and a reason may be any value — a
     * string, a plain object — so an `instanceof Error` gate silently drops
     * both our own timeout and any caller abort carrying a custom reason into
     * the generic network-error wrapper below.
     */
    if (controller.signal.reason === timeoutReason) {
      throw timeoutFailure();
    }

    // External signal abort (e.g. client disconnect) — not a timeout. The
    // `AbortError` fallback covers an abort raised somewhere other than the
    // two signals composed here, such as a response body stream.
    if (fetchSignal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw abortedFailure();
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      `Network error during ${operationDescription}: ${errorMessage}`,
      withExtra(context, {
        originalErrorName: error instanceof Error ? error.name : 'UnknownError',
        errorSource: 'FetchNetworkError',
      }),
    );

    if (error instanceof McpError) {
      throw error;
    }

    throw serviceUnavailable(`Network error during ${operationDescription}: ${errorMessage}`, {
      ...errorIdentity,
      originalErrorName: error instanceof Error ? error.name : 'UnknownError',
      errorSource: 'FetchNetworkErrorWrapper',
    });
  } finally {
    if (!deadlineFollowsBody) clearTimeout(timeoutId);
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

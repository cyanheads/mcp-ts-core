/**
 * @fileoverview Unit tests for the fetchWithTimeout utility.
 * @module tests/utils/network/fetchWithTimeout.test
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { z } from 'zod';

import {
  type AnyToolDefinition,
  tool,
} from '../../../../src/mcp-server/tools/utils/toolDefinition.js';
import { createToolHandler } from '../../../../src/mcp-server/tools/utils/toolHandlerFactory.js';
import { JsonRpcErrorCode, McpError } from '../../../../src/types-global/errors.js';
import { ErrorHandler } from '../../../../src/utils/internal/error-handler/errorHandler.js';
import { logger } from '../../../../src/utils/internal/logger.js';
import { withExtra } from '../../../../src/utils/internal/requestContext.js';
import { fetchWithTimeout } from '../../../../src/utils/network/fetchWithTimeout.js';
import { httpErrorFromResponse } from '../../../../src/utils/network/httpError.js';
import { withRetry } from '../../../../src/utils/network/retry.js';
import { legacyCapabilityView, makeServerContext } from '../../../helpers/server-context.js';

/**
 * The SSRF guard resolves through `node:dns/promises`. Holding each function in
 * a mutable slot behind a getter lets a test swap one out entirely — including
 * removing `lookup`, which is how a runtime without it (Workers under
 * `nodejs_compat`) presents.
 */
const dnsSlots = vi.hoisted(() => ({
  resolve4: undefined as unknown,
  resolve6: undefined as unknown,
  lookup: undefined as unknown,
}));

vi.mock('node:dns/promises', () => ({
  get resolve4() {
    return dnsSlots.resolve4;
  },
  get resolve6() {
    return dnsSlots.resolve6;
  },
  get lookup() {
    return dnsSlots.lookup;
  },
}));

/** The rejection a resolver raises for a name it cannot see. Never an SSRF signal. */
function unresolvable(): Error & { code: string } {
  return Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' });
}

describe('fetchWithTimeout', () => {
  const context = {
    requestId: 'ctx-1',
    timestamp: new Date().toISOString(),
  };
  let debugSpy: MockInstance;
  let errorSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: nothing resolves anywhere, so the guard stays silent and no unit
    // test reaches the network for a name.
    dnsSlots.resolve4 = vi.fn().mockRejectedValue(unresolvable());
    dnsSlots.resolve6 = vi.fn().mockRejectedValue(unresolvable());
    dnsSlots.lookup = vi.fn().mockRejectedValue(unresolvable());
    debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves with the response when fetch succeeds', async () => {
    const response = new Response('ok', { status: 200, headers: { 'x-trace': 'abc' } });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as Response);

    const result = await fetchWithTimeout('https://example.com', 1000, context);

    // A response carrying a body is handed back through the body-deadline
    // passthrough, so it is an equivalent response rather than the same object.
    expect(result.status).toBe(200);
    expect(result.headers.get('x-trace')).toBe('abc');
    expect(await result.text()).toBe('ok');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(debugSpy).toHaveBeenCalledWith(
      'Successfully fetched https://example.com. Status: 200',
      context,
    );
  });

  it('throws an McpError when the response is not ok', async () => {
    const response = new Response('nope', {
      status: 503,
      statusText: 'Service Unavailable',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as Response);

    await expect(fetchWithTimeout('https://example.com', 1000, context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining('Status: 503'),
    });

    expect(errorSpy).toHaveBeenCalledWith(
      'Fetch failed for https://example.com with status 503.',
      expect.objectContaining({
        extra: expect.objectContaining({
          errorSource: 'FetchHttpError',
          statusCode: 503,
        }),
      }),
    );
  });

  // The full status table is pinned in httpError.test.ts; these rows prove the wiring.
  it.each([
    [404, JsonRpcErrorCode.NotFound],
    [410, JsonRpcErrorCode.InvalidRequest],
  ])('maps status %d through httpStatusToErrorCode to code %d', async (status, expectedCode) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('err', { status }));
    await expect(fetchWithTimeout('https://example.com', 1000, context)).rejects.toMatchObject({
      code: expectedCode,
      data: { statusCode: status },
    });
  });

  describe('upstream 5xx retryability (#323)', () => {
    it('leaves a 500 free to retry — no in-band opt-out on error.data', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
      const error = (await fetchWithTimeout('https://example.com', 1000, context).catch(
        (e) => e,
      )) as McpError;

      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).not.toHaveProperty('retryable');
    });

    it('opts a 501 out of retry in band while keeping the upstream classification', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('not implemented', { status: 501 }),
      );
      const error = (await fetchWithTimeout('https://example.com', 1000, context).catch(
        (e) => e,
      )) as McpError;

      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data?.retryable).toBe(false);
    });
  });

  it('preserves errorSource and statusText on error.data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('forbidden', { status: 403, statusText: 'Forbidden' }),
    );
    await expect(fetchWithTimeout('https://example.com', 1000, context)).rejects.toMatchObject({
      data: { errorSource: 'FetchHttpError', statusText: 'Forbidden' },
    });
  });

  it('captures Retry-After header for 429 responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } }),
    );
    await expect(fetchWithTimeout('https://example.com', 1000, context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { retryAfter: '30' },
    });
  });

  it('omits retryAfter from error.data when the header is absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('err', { status: 500 }));
    const error = await fetchWithTimeout('https://example.com', 1000, context).catch((e) => e);
    expect((error as { data?: Record<string, unknown> }).data).not.toHaveProperty('retryAfter');
  });

  it('keeps ERROR_BODY_LIMIT bytes of a large error body, split head and tail', async () => {
    const huge = `HEAD${'x'.repeat(10_000)}TAIL`;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(huge, { status: 500 }));
    const error = await fetchWithTimeout('https://example.com', 1000, context).catch((e) => e);
    const body = (error as { data?: { responseBody?: string } }).data?.responseBody ?? '';
    expect(body.startsWith('HEAD')).toBe(true);
    expect(body.endsWith('TAIL')).toBe(true);
    expect(body).toContain('…[9508 bytes elided]…');
    // 500 bytes of body content, plus the elision marker itself.
    expect(body.replace(/…\[\d+ bytes elided]…/, '')).toHaveLength(500);
  });

  it('reads past the capture budget to reach the tail of an over-budget body', async () => {
    // The Overpass 400 shape: the diagnostic sits behind a fixed preamble, past
    // the 500-byte cap, so a head-only capture would drop the only useful line.
    const document = `<html>${'<!-- boilerplate -->'.repeat(30)}<strong>Error</strong>: line 1: parse error</html>`;
    expect(document.length).toBeGreaterThan(500);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(document, { status: 400 }));
    const error = await fetchWithTimeout('https://example.com', 1000, context).catch((e) => e);
    expect((error as McpError).data?.body).toContain('parse error');
  });

  it('honors an explicit errorBodyLimit', async () => {
    const document = `HEAD${'x'.repeat(4000)}TAIL`;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(document, { status: 500 }));
    const error = await fetchWithTimeout('https://example.com', 1000, context, {
      errorBodyLimit: 2000,
    }).catch((e) => e);
    const body = (error as { data?: { body?: string } }).data?.body ?? '';
    expect(body.replace(/…\[\d+ bytes elided]…/, '')).toHaveLength(2000);
    expect(body.endsWith('TAIL')).toBe(true);
  });

  it('does not truncate bodies shorter than ERROR_BODY_LIMIT', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('short error', { status: 500 }));
    await expect(fetchWithTimeout('https://example.com', 1000, context)).rejects.toMatchObject({
      data: { responseBody: 'short error' },
    });
  });

  it('does not add ellipsis when body is exactly ERROR_BODY_LIMIT bytes', async () => {
    const exact = 'x'.repeat(500);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(exact, { status: 500 }));
    await expect(fetchWithTimeout('https://example.com', 1000, context)).rejects.toMatchObject({
      data: { responseBody: exact },
    });
  });

  it('elides as soon as body exceeds ERROR_BODY_LIMIT by one byte', async () => {
    const over = 'x'.repeat(501);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(over, { status: 500 }));
    const error = await fetchWithTimeout('https://example.com', 1000, context).catch((e) => e);
    const body = (error as { data?: { responseBody?: string } }).data?.responseBody ?? '';
    expect(body).toBe(`${'x'.repeat(200)}…[1 byte elided]…${'x'.repeat(300)}`);
  });

  it('handles empty error bodies cleanly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    await expect(fetchWithTimeout('https://example.com', 1000, context)).rejects.toMatchObject({
      data: { responseBody: '' },
    });
  });

  it('throws a timeout McpError when the request exceeds the allotted time', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          // Spec behaviour: `fetch` rejects with the abort *reason* value
          // itself, whatever its type — never a synthesized `AbortError`.
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );

    await expect(fetchWithTimeout('https://slow.example.com', 5, context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: expect.objectContaining({ errorSource: 'FetchTimeout' }),
    });

    expect(errorSpy).toHaveBeenCalledWith(
      'fetch GET https://slow.example.com timed out after 5ms.',
      expect.objectContaining({ extra: expect.objectContaining({ errorSource: 'FetchTimeout' }) }),
    );
  });

  it('wraps unknown fetch errors into an McpError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection reset'));

    await expect(
      fetchWithTimeout('https://error.example.com', 1000, context),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: expect.objectContaining({
        errorSource: 'FetchNetworkErrorWrapper',
        originalErrorName: 'Error',
      }),
    });

    expect(errorSpy).toHaveBeenCalledWith(
      'Network error during fetch GET https://error.example.com: connection reset',
      expect.objectContaining({
        extra: expect.objectContaining({
          errorSource: 'FetchNetworkError',
          originalErrorName: 'Error',
        }),
      }),
    );
  });

  it('rethrows an existing McpError without wrapping it again', async () => {
    const existingError = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'upstream unavailable');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(existingError);

    await expect(fetchWithTimeout('https://error.example.com', 1000, context)).rejects.toBe(
      existingError,
    );

    expect(errorSpy).toHaveBeenCalledWith(
      'Network error during fetch GET https://error.example.com: upstream unavailable',
      expect.objectContaining({
        extra: expect.objectContaining({
          errorSource: 'FetchNetworkError',
          originalErrorName: 'McpError',
        }),
      }),
    );
  });

  it('falls back to placeholder response body when response.text() fails', async () => {
    const failingResponse = {
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      headers: new Headers(),
      body: {
        getReader: vi.fn(() => {
          throw new Error('stream closed');
        }),
      },
    } as unknown as Response;

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(failingResponse);

    await expect(
      fetchWithTimeout('https://bad-body.example.com', 1000, context),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: expect.objectContaining({
        responseBody: 'Could not read response body',
        statusCode: 502,
      }),
    });

    expect(failingResponse.body?.getReader).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'Fetch failed for https://bad-body.example.com with status 502.',
      expect.objectContaining({
        extra: expect.objectContaining({
          responseBody: 'Could not read response body',
          errorSource: 'FetchHttpError',
        }),
      }),
    );
  });

  it('cancels an endless streaming error body after bounded read-ahead', async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(300).fill(120));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, { status: 500 }));

    const error = await fetchWithTimeout('https://example.com', 1000, context).catch((e) => e);
    // A body still streaming at the scan ceiling never showed its tail, so the
    // capture stays head-only — and the read stops at the ceiling, not the body's end.
    expect((error as McpError).data?.responseBody).toBe(`${'x'.repeat(500)}…`);
    expect(pulls).toBeLessThanOrEqual(Math.ceil(16_384 / 300) + 1);
    expect(cancelled).toBe(true);
  });

  it('wraps non-Error rejection values into McpError instances', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue('catastrophic failure');

    await expect(
      fetchWithTimeout('https://string-error.example.com', 500, context),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining('catastrophic failure'),
      data: expect.objectContaining({
        originalErrorName: 'UnknownError',
        errorSource: 'FetchNetworkErrorWrapper',
      }),
    });

    expect(errorSpy).toHaveBeenCalledWith(
      'Network error during fetch GET https://string-error.example.com: catastrophic failure',
      expect.objectContaining({
        extra: expect.objectContaining({
          originalErrorName: 'UnknownError',
          errorSource: 'FetchNetworkError',
        }),
      }),
    );
  });

  it('throws FetchAborted (not Timeout) when an external signal aborts the request', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const externalController = new AbortController();

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          // Spec behaviour: `fetch` rejects with the abort *reason* value
          // itself, whatever its type — never a synthesized `AbortError`.
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );

    const promise = fetchWithTimeout('https://example.com', 30_000, context, {
      signal: externalController.signal,
    });

    externalController.abort('client disconnected');

    await expect(promise).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
      data: expect.objectContaining({ errorSource: 'FetchAborted' }),
    });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('aborted by caller'),
      expect.objectContaining({ extra: expect.objectContaining({ errorSource: 'FetchAborted' }) }),
    );
  });

  describe('a caller signal aborted by a deadline', () => {
    /** A fetch that settles only when its signal aborts, rejecting with the reason. */
    function hangUntilAborted() {
      return vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            signal?.addEventListener('abort', () => reject(signal.reason));
          }),
      );
    }

    it('reports a TimeoutError abort reason as Timeout, distinct from the helper’s own timeout', async () => {
      const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
      hangUntilAborted();
      const externalController = new AbortController();

      const promise = fetchWithTimeout('https://example.com', 30_000, context, {
        signal: externalController.signal,
      });

      // The caller's own deadline — not this helper's `timeoutMs`, so it keeps
      // an errorSource of its own rather than the internal FetchTimeout.
      externalController.abort(new DOMException('caller deadline', 'TimeoutError'));

      const error = (await promise.catch((e: unknown) => e)) as McpError;
      expect(error).toBeInstanceOf(McpError);
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data).toEqual({ errorSource: 'FetchSignalTimeout' });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("timed out on the caller's signal"),
        expect.objectContaining({
          extra: expect.objectContaining({ errorSource: 'FetchSignalTimeout' }),
        }),
      );
      expect(infoSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('aborted by caller'),
        expect.anything(),
      );
    });

    it('reports an AbortSignal.timeout() signal as Timeout', async () => {
      hangUntilAborted();

      const error = (await fetchWithTimeout('https://example.com', 30_000, context, {
        signal: AbortSignal.timeout(10),
      }).catch((e: unknown) => e)) as McpError;

      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data?.errorSource).toBe('FetchSignalTimeout');
    });

    it('reports a composed AbortSignal.any whose timeout fired as Timeout', async () => {
      hangUntilAborted();
      const request = new AbortController();

      const error = (await fetchWithTimeout('https://example.com', 30_000, context, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(10)]),
      }).catch((e: unknown) => e)) as McpError;

      expect(request.signal.aborted).toBe(false);
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data?.errorSource).toBe('FetchSignalTimeout');
    });

    it('keeps a composed AbortSignal.any cancelled by its other member as RequestCancelled', async () => {
      vi.spyOn(logger, 'info').mockImplementation(() => {});
      hangUntilAborted();
      const request = new AbortController();

      const promise = fetchWithTimeout('https://example.com', 30_000, context, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
      });
      request.abort('client disconnected');

      await expect(promise).rejects.toMatchObject({
        code: JsonRpcErrorCode.RequestCancelled,
        data: { errorSource: 'FetchAborted' },
      });
    });

    it('keeps an AbortError reason as RequestCancelled', async () => {
      vi.spyOn(logger, 'info').mockImplementation(() => {});
      hangUntilAborted();
      const request = new AbortController();

      const promise = fetchWithTimeout('https://example.com', 30_000, context, {
        signal: request.signal,
      });
      request.abort();

      await expect(promise).rejects.toMatchObject({
        code: JsonRpcErrorCode.RequestCancelled,
        data: { errorSource: 'FetchAborted' },
      });
    });
  });

  it('emits both status/body and legacy statusCode/responseBody with equal values (#279)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    );
    const error = (await fetchWithTimeout('https://example.com', 1000, context).catch(
      (e) => e,
    )) as McpError;
    const data = error.data as Record<string, unknown>;

    expect(data.status).toBe(500);
    expect(data.statusCode).toBe(500);
    expect(data.status).toBe(data.statusCode);
    expect(data.body).toBe('boom');
    expect(data.responseBody).toBe('boom');
    expect(data.body).toBe(data.responseBody);
  });

  describe('expectedStatuses (#256)', () => {
    it('logs an expected status at debug (not error) but still throws the same McpError', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('missing', { status: 404 }));

      await expect(
        fetchWithTimeout('https://example.com', 1000, context, { expectedStatuses: [404] }),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { status: 404, statusCode: 404 },
      });

      // Non-vacuity: pre-fix a 404 logged at error — this must stay clean.
      expect(errorSpy).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        'Fetch failed for https://example.com with status 404.',
        expect.objectContaining({
          extra: expect.objectContaining({ statusCode: 404, errorSource: 'FetchHttpError' }),
        }),
      );
    });

    it('still logs at error for a non-2xx status not listed in expectedStatuses', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));

      await expect(
        fetchWithTimeout('https://example.com', 1000, context, { expectedStatuses: [404] }),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });

      expect(errorSpy).toHaveBeenCalledWith(
        'Fetch failed for https://example.com with status 500.',
        expect.objectContaining({
          extra: expect.objectContaining({ statusCode: 500, errorSource: 'FetchHttpError' }),
        }),
      );
    });
  });

  describe("3xx under redirect: 'manual' (#460)", () => {
    /** The 3xx `fetch` hands back when the caller opts out of following it. */
    function movedResponse(): Response {
      return new Response(null, {
        status: 302,
        statusText: 'Found',
        headers: { location: 'https://elsewhere.example/moved' },
      });
    }

    it('classifies the redirect as InvalidRequest rather than InternalError', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(movedResponse());

      await expect(
        fetchWithTimeout('https://example.com', 1000, context, { redirect: 'manual' }),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidRequest,
        data: { status: 302, statusCode: 302, statusText: 'Found' },
      });
    });

    it('is not retried by the real withRetry ladder', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(movedResponse());

      const error = (await withRetry(
        () => fetchWithTimeout('https://example.com', 1000, context, { redirect: 'manual' }),
        { maxRetries: 3, baseDelayMs: 1, jitter: 0 },
      ).catch((e) => e)) as McpError;

      expect(error.code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(error.data).not.toHaveProperty('retryAttempts');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('still climbs the ladder for a transient upstream failure', async () => {
      // Non-vacuity for the assertion above: this harness does retry when the
      // classified code is transient.
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('boom', { status: 503 }));

      const error = (await withRetry(() => fetchWithTimeout('https://example.com', 1000, context), {
        maxRetries: 2,
        baseDelayMs: 1,
        jitter: 0,
      }).catch((e) => e)) as McpError;

      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data?.retryAttempts).toBe(3);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe('selected error headers (#302)', () => {
    /** Non-2xx carrying both a diagnostic header and a credential-bearing one. */
    function throttledResponse(): Response {
      return new Response('slow down', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: {
          'x-ratelimit-remaining-usd': '0.42',
          'x-request-id': 'req-7',
          'set-cookie': 'session=secret; HttpOnly',
        },
      });
    }

    it('emits no headers key when the selector is omitted', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(throttledResponse());

      const error = (await fetchWithTimeout('https://example.com', 1000, context).catch(
        (e) => e,
      )) as McpError;

      expect(error.data).not.toHaveProperty('headers');
      expect(error.data?.retryAfter).toBeUndefined();
    });

    it('captures the selected headers case-insensitively under lowercase keys', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(throttledResponse());

      const error = (await fetchWithTimeout('https://example.com', 1000, context, {
        errorHeaders: ['X-RateLimit-Remaining-USD', 'x-request-id', 'x-absent'],
      }).catch((e) => e)) as McpError;

      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data?.headers).toEqual({
        'x-ratelimit-remaining-usd': '0.42',
        'x-request-id': 'req-7',
      });
    });

    it('never captures set-cookie, whatever the selector says', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(throttledResponse());

      const error = (await fetchWithTimeout('https://example.com', 1000, context, {
        errorHeaders: ['set-cookie'],
      }).catch((e) => e)) as McpError;

      expect(error.data).not.toHaveProperty('headers');
      expect(JSON.stringify(error.data)).not.toContain('session=secret');
    });

    it('strips errorHeaders from the RequestInit handed to native fetch', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(throttledResponse());

      await fetchWithTimeout('https://example.com', 1000, context, {
        errorHeaders: ['x-request-id'],
      }).catch(() => undefined);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.com',
        expect.not.objectContaining({ errorHeaders: expect.anything() }),
      );
    });

    it('produces the same headers record as httpErrorFromResponse for one response', async () => {
      const errorHeaders = ['X-Request-Id', 'x-ratelimit-remaining-usd', 'set-cookie', 'x-absent'];
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(throttledResponse());

      const fromFetch = (await fetchWithTimeout('https://example.com', 1000, context, {
        errorHeaders,
      }).catch((e) => e)) as McpError;
      const fromResponse = await httpErrorFromResponse(throttledResponse(), { errorHeaders });

      expect(fromFetch.data?.headers).toEqual(fromResponse.data?.headers);
    });

    it("selects location on a 3xx the caller sees via redirect: 'manual'", async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: 'https://elsewhere.example/moved' },
        }),
      );

      const error = (await fetchWithTimeout('https://example.com', 1000, context, {
        redirect: 'manual',
        errorHeaders: ['location'],
      }).catch((e) => e)) as McpError;

      expect(error.code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(error.data?.headers).toEqual({ location: 'https://elsewhere.example/moved' });
    });

    it('captures nothing from a 3xx that rejectPrivateIPs consumes first', async () => {
      // The SSRF branch handles the redirect before the non-ok throw, so the
      // selector never sees it — the two options do not compose.
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'https://example.com/loop' } }),
      );

      const error = (await fetchWithTimeout('https://loop.example.com', 1000, context, {
        rejectPrivateIPs: true,
        errorHeaders: ['location'],
      }).catch((e) => e)) as McpError;

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toContain('Too many redirects');
      expect(error.data?.errorSource).not.toBe('FetchHttpError');
      expect(error.data ?? {}).not.toHaveProperty('headers');
    });
  });

  /**
   * The 2xx body streams through a passthrough that carries the deadline. Each
   * upstream body here holds a first chunk, so the passthrough has already
   * buffered it and sits idle — no read is pending that could disarm the
   * deadline on the caller's behalf.
   */
  describe('2xx body passthrough', () => {
    const firstChunk = () => new TextEncoder().encode('partial');

    afterEach(() => {
      vi.useRealTimers();
    });

    it('disarms the deadline and cancels the upstream body when the caller cancels', async () => {
      vi.useFakeTimers();
      let upstreamCancelReason: unknown = 'never cancelled';
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(firstChunk());
            },
            cancel(reason) {
              upstreamCancelReason = reason;
            },
          }),
          { status: 200 },
        ),
      );

      const response = await fetchWithTimeout('https://example.com', 30_000, context);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);

      await response.body?.cancel('caller is done');

      // The upstream socket is released now, not when the deadline would have fired.
      expect(upstreamCancelReason).toBe('caller is done');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('surfaces a mid-body upstream failure as itself and disarms the deadline', async () => {
      vi.useFakeTimers();
      const reset = new TypeError('terminated');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(firstChunk());
            },
            pull(controller) {
              controller.error(reset);
            },
          }),
          { status: 200 },
        ),
      );

      const response = await fetchWithTimeout('https://example.com', 30_000, context);

      // Neither signal fired, so this is no timeout or cancellation to relabel.
      await expect(response.text()).rejects.toBe(reset);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('carries a followed redirect across the passthrough', async () => {
      const upstream = new Response('moved here', { status: 200 });
      Object.defineProperty(upstream, 'redirected', { value: true });
      Object.defineProperty(upstream, 'url', { value: 'https://example.com/final' });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(upstream);

      const response = await fetchWithTimeout('https://example.com/start', 1000, context);

      expect(response.redirected).toBe(true);
      expect(response.url).toBe('https://example.com/final');
      expect(await response.text()).toBe('moved here');
    });
  });

  describe('URL redaction (#190 — query-string secrets must not leak)', () => {
    // The Guardian (?api-key=…) and many api.data.gov services (?api_key=…)
    // authenticate via the query string. The secret must never reach a
    // client-facing error message or the logs. The path is elided too (#626),
    // so the request is named by its origin and the two elision markers.
    const secretUrl = 'https://api.example.com/search?q=cats&api-key=SUPERSECRET';
    const safeName = 'https://api.example.com/…?…';

    it('redacts the secret from the thrown error and the log on a non-OK response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 401 }));
      const error = (await fetchWithTimeout(secretUrl, 1000, context).catch((e) => e)) as McpError;

      expect(error.message).not.toContain('SUPERSECRET');
      expect(error.message).not.toContain('api-key');
      expect(error.message).not.toContain('/search');
      expect(error.message).toContain(safeName);

      const logged = String(errorSpy.mock.calls.at(-1)?.[0]);
      expect(logged).not.toContain('SUPERSECRET');
      expect(logged).not.toContain('/search');
      expect(logged).toContain(safeName);
    });

    it('redacts the secret from the timeout error', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            signal?.addEventListener('abort', () => reject(signal.reason));
          }),
      );
      const error = (await fetchWithTimeout(secretUrl, 5, context).catch((e) => e)) as McpError;
      expect(error.message).not.toContain('SUPERSECRET');
      expect(error.message).not.toContain('/search');
      expect(error.message).toContain(safeName);
    });

    it('redacts the secret from the network-error wrapper', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection reset'));
      const error = (await fetchWithTimeout(secretUrl, 1000, context).catch((e) => e)) as McpError;
      expect(error.message).not.toContain('SUPERSECRET');
      expect(error.message).not.toContain('/search');
      expect(error.message).toContain(safeName);
    });

    it('redacts the secret from the success debug log', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
      await (await fetchWithTimeout(secretUrl, 1000, context)).text();
      const logged = String(
        debugSpy.mock.calls.find((c) => String(c[0]).includes('Successfully fetched'))?.[0],
      );
      expect(logged).not.toContain('SUPERSECRET');
      expect(logged).not.toContain('/search');
      expect(logged).toContain(safeName);
    });
  });

  describe('path redaction (#626 — a key carried in the path must not leak)', () => {
    // Telegram (`/bot<token>/…`), webhook URLs, and `https://host/<KEY>/…`
    // services carry the credential in the path, where query redaction alone
    // leaves it in every message and log record.
    const keyUrl = 'https://api.example.com/sk-test-0000/reverse?lat=1&lon=2';
    const name = 'https://api.example.com/…?…';
    const PATH_PARTS = ['sk-test-0000', '/reverse', 'lat=1', 'lon=2'];
    let infoSpy: MockInstance;

    beforeEach(() => {
      infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    });

    /** Every record the logger received, serialized — message and context alike. */
    function everyRecord(): string {
      return JSON.stringify([
        ...debugSpy.mock.calls,
        ...infoSpy.mock.calls,
        ...errorSpy.mock.calls,
      ]);
    }

    function expectNoPath(text: string): void {
      for (const part of PATH_PARTS) expect(text).not.toContain(part);
    }

    /** A fetch that settles only when its signal aborts, rejecting with the reason. */
    function hangUntilAborted() {
      return vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            signal?.addEventListener('abort', () => reject(signal.reason));
          }),
      );
    }

    it('names a non-2xx response by origin, with classification and the request unchanged', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('not found', { status: 404 }));

      const error = (await fetchWithTimeout(keyUrl, 30_000, context).catch((e) => e)) as McpError;

      expect(error.message).toBe(`Fetch failed for ${name}. Status: 404`);
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data).toMatchObject({
        status: 404,
        statusCode: 404,
        body: 'not found',
        responseBody: 'not found',
      });
      expect(debugSpy).toHaveBeenCalledWith(
        `Attempting fetch GET ${name} with 30000ms timeout.`,
        context,
      );
      expect(errorSpy).toHaveBeenCalledWith(
        `Fetch failed for ${name} with status 404.`,
        expect.objectContaining({ extra: expect.objectContaining({ statusCode: 404 }) }),
      );
      expectNoPath(error.message);
      expectNoPath(everyRecord());
      // The upstream still receives the full path and query.
      expect(fetchMock).toHaveBeenCalledWith(keyUrl, expect.anything());
    });

    it.each([
      [401, JsonRpcErrorCode.Unauthorized],
      [503, JsonRpcErrorCode.ServiceUnavailable],
    ])('keeps a %d classified as %d', async (status, code) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('upstream says', { status }));

      const error = (await fetchWithTimeout(keyUrl, 1000, context).catch((e) => e)) as McpError;

      expect(error.code).toBe(code);
      expect(error.message).toBe(`Fetch failed for ${name}. Status: ${status}`);
      expect(error.data).toMatchObject({ status, statusCode: status, body: 'upstream says' });
      expectNoPath(everyRecord());
    });

    it('names the request by origin on a timeout', async () => {
      hangUntilAborted();

      const error = (await fetchWithTimeout(keyUrl, 5, context).catch((e) => e)) as McpError;

      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.message).toBe(`fetch GET ${name} timed out.`);
      expect(errorSpy).toHaveBeenCalledWith(
        `fetch GET ${name} timed out after 5ms.`,
        expect.anything(),
      );
      expectNoPath(everyRecord());
    });

    it("names the request by origin when the caller's deadline fires", async () => {
      hangUntilAborted();

      const error = (await fetchWithTimeout(keyUrl, 30_000, context, {
        signal: AbortSignal.timeout(5),
      }).catch((e) => e)) as McpError;

      expect(error.data?.errorSource).toBe('FetchSignalTimeout');
      expect(error.message).toBe(`fetch GET ${name} timed out on the caller's signal.`);
      expect(errorSpy).toHaveBeenCalledWith(
        `fetch GET ${name} timed out on the caller's signal.`,
        expect.anything(),
      );
      expectNoPath(everyRecord());
    });

    it('names the request by origin when the caller aborts', async () => {
      hangUntilAborted();
      const controller = new AbortController();

      const promise = fetchWithTimeout(keyUrl, 30_000, context, {
        method: 'POST',
        signal: controller.signal,
      });
      controller.abort('client disconnected');
      const error = (await promise.catch((e) => e)) as McpError;

      expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(error.message).toBe(`fetch POST ${name} was aborted.`);
      expect(infoSpy).toHaveBeenCalledWith(
        `fetch POST ${name} aborted by caller.`,
        expect.anything(),
      );
      expectNoPath(everyRecord());
    });

    it('names the request by origin on a network error', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection reset'));

      const error = (await fetchWithTimeout(keyUrl, 1000, context).catch((e) => e)) as McpError;

      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toBe(`Network error during fetch GET ${name}: connection reset`);
      expect(errorSpy).toHaveBeenCalledWith(
        `Network error during fetch GET ${name}: connection reset`,
        expect.anything(),
      );
      expectNoPath(everyRecord());
    });

    it.each([
      [
        'an Error',
        // Bun 1.4 quotes the request URL whole in this rejection's message.
        new TypeError(
          `Malformed_HTTP_Response fetching "${keyUrl}". For more information, pass \`verbose: true\` in the second argument to fetch()`,
        ),
        `Malformed_HTTP_Response fetching "${name}". For more information, pass \`verbose: true\` in the second argument to fetch()`,
      ],
      ['a non-Error value', `socket hang up on ${keyUrl}`, `socket hang up on ${name}`],
    ])('redacts a URL the runtime quotes in %s rejection', async (_label, rejection, rendered) => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(rejection);

      const error = (await fetchWithTimeout(keyUrl, 1000, context).catch((e) => e)) as McpError;

      expect(error.message).toBe(`Network error during fetch GET ${name}: ${rendered}`);
      expect(errorSpy).toHaveBeenCalledWith(
        `Network error during fetch GET ${name}: ${rendered}`,
        expect.anything(),
      );
      expectNoPath(error.message);
      expectNoPath(everyRecord());
    });

    describe('a rejection whose message cannot be written', () => {
      /**
       * A replaced or instrumented `globalThis.fetch`, or a test fake, can reject
       * with an error whose `message` refuses assignment. Assigning it throws in
       * a module, so the redaction must not replace the failure being reported.
       */
      const keyedUrl = `${keyUrl}&key=sk-query-0000`;
      const quoting = `fetch failed for "${keyedUrl}"`;
      const redacted = `fetch failed for "${name}"`;
      const wrapperMessage = `Network error during fetch GET ${name}: ${redacted}`;

      /** `message` as an own accessor with no setter. */
      function getterOnlyMessage(): TypeError {
        const error = new TypeError('placeholder');
        Object.defineProperty(error, 'message', { get: () => quoting });
        return error;
      }

      it.each([
        ['a frozen TypeError', () => Object.freeze(new TypeError(quoting)), 'TypeError', undefined],
        [
          'a non-abort DOMException',
          () => new DOMException(quoting, 'NetworkError'),
          'NetworkError',
          undefined,
        ],
        ['a TypeError with a getter-only message', getterOnlyMessage, 'TypeError', undefined],
        [
          'a TypeError with a non-writable message',
          () => Object.defineProperty(new TypeError(quoting), 'message', { writable: false }),
          'TypeError',
          undefined,
        ],
        [
          'a frozen Bun-shaped rejection with a string code',
          () =>
            Object.freeze(
              Object.assign(new TypeError(quoting), {
                code: 'Malformed_HTTP_Response',
                path: keyedUrl,
              }),
            ),
          'TypeError',
          'Malformed_HTTP_Response',
        ],
      ])(
        'still throws the network-error wrapper for %s quoting the URL',
        async (_label, make, rejectionName, code) => {
          vi.spyOn(globalThis, 'fetch').mockRejectedValue(make());

          const error = (await fetchWithTimeout(keyedUrl, 1000, context).catch(
            (e) => e,
          )) as McpError;

          expect(error).toBeInstanceOf(McpError);
          expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
          expect(error.message).toBe(wrapperMessage);
          expect(error.data).toEqual({
            originalErrorName: rejectionName,
            errorSource: 'FetchNetworkErrorWrapper',
          });
          const cause = error.cause as Error & { code?: unknown };
          expect(cause).toBeInstanceOf(Error);
          expect(cause.name).toBe(rejectionName);
          expect(cause.message).toBe(redacted);
          expect(cause.code).toBe(code);
          // The network-error record is written, its chain read from the same cause.
          expect(errorSpy).toHaveBeenCalledWith(wrapperMessage, {
            ...context,
            extra: {
              originalErrorName: rejectionName,
              errorSource: 'FetchNetworkError',
              ...(code && { causeChain: [{ name: rejectionName, message: redacted, code }] }),
            },
          });
          const surfaces = JSON.stringify([
            everyRecord(),
            error.message,
            error.data,
            cause,
            cause.message,
            cause.stack,
          ]);
          expectNoPath(surfaces);
          expect(surfaces).not.toContain('sk-query-0000');
        },
      );

      it("keeps a transport code carried on the rejection's own cause", async () => {
        const transport = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3614'), {
          code: 'ECONNREFUSED',
        });
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(
          Object.freeze(new TypeError(quoting, { cause: transport })),
        );

        const error = (await fetchWithTimeout(keyedUrl, 1000, context).catch((e) => e)) as McpError;

        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        const cause = error.cause as Error;
        expect(cause.message).toBe(redacted);
        expect(cause.cause).toBe(transport);
        expect(errorSpy).toHaveBeenCalledWith(wrapperMessage, {
          ...context,
          extra: {
            originalErrorName: 'TypeError',
            errorSource: 'FetchNetworkError',
            causeChain: [
              { name: 'TypeError', message: redacted },
              {
                name: 'Error',
                message: 'connect ECONNREFUSED 127.0.0.1:3614',
                code: 'ECONNREFUSED',
              },
            ],
          },
        });
        expectNoPath(everyRecord());
        expect(everyRecord()).not.toContain('sk-query-0000');
      });

      it('logs a redacted rootCause, code included, through tryCatch, and publishes none', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(
          Object.freeze(Object.assign(new TypeError(quoting), { code: 'Malformed_HTTP_Response' })),
        );

        const error = (await ErrorHandler.tryCatch(
          () => fetchWithTimeout(keyedUrl, 1000, context),
          { operation: 'reverseGeocode', context },
        ).catch((e) => e)) as McpError;

        // A cause's message reaches the log record only (#644).
        expect(error.data).not.toHaveProperty('rootCause');
        const handled = errorSpy.mock.calls.at(-1)?.[1] as {
          extra: { errorData: { causeChain: Array<{ code?: string }>; rootCause: unknown } };
        };
        expect(handled.extra.errorData.rootCause).toEqual({ name: 'TypeError', message: redacted });
        expect(handled.extra.errorData.causeChain.at(-1)?.code).toBe('Malformed_HTTP_Response');
        const surfaces = JSON.stringify([everyRecord(), error.message, error.data]);
        expectNoPath(surfaces);
        expect(surfaces).not.toContain('sk-query-0000');
      });

      it('redacts a writable rejection in place, chaining the same object', async () => {
        const rejection = new TypeError(quoting);
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(rejection);

        const error = (await fetchWithTimeout(keyedUrl, 1000, context).catch((e) => e)) as McpError;

        expect(error.message).toBe(wrapperMessage);
        expect(error.cause).toBe(rejection);
        expect(rejection.message).toBe(redacted);
      });
    });

    it('names a successful fetch by origin', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

      await (await fetchWithTimeout(keyUrl, 1000, context)).text();

      expect(debugSpy).toHaveBeenCalledWith(`Successfully fetched ${name}. Status: 200`, context);
      expectNoPath(everyRecord());
    });

    it('names each redirect hop by origin', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: { location: 'https://new.example.com/sk-hop-1111/page?t=9' },
          }),
        )
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      await (await fetchWithTimeout(keyUrl, 1000, context, { rejectPrivateIPs: true })).text();

      expect(debugSpy).toHaveBeenCalledWith(
        'Following validated redirect 1: https://new.example.com/…?…',
        context,
      );
      expect(debugSpy).toHaveBeenCalledWith(
        'Successfully fetched https://new.example.com/…?…. Status: 200',
        context,
      );
      expectNoPath(everyRecord());
      expect(everyRecord()).not.toContain('sk-hop-1111');
    });

    it('names the request by origin when a redirect has no Location', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 302 }));

      const error = (await fetchWithTimeout(keyUrl, 1000, context, {
        rejectPrivateIPs: true,
      }).catch((e) => e)) as McpError;

      // Not followed, so it fails as the HTTP status it is (#647).
      expect(error.code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(error.message).toBe(`Fetch failed for ${name}. Status: 302`);
      expect(errorSpy).toHaveBeenCalledWith(
        `Fetch failed for ${name} with status 302.`,
        expect.anything(),
      );
      expectNoPath(everyRecord());
    });

    it.each([
      ['https://example.com', 'https://example.com'],
      ['https://example.com/', 'https://example.com'],
      ['https://example.com/?k=1', 'https://example.com?…'],
    ])('names a root URL %s as %s, as before', async (url, expected) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

      await (await fetchWithTimeout(url, 1000, context)).text();

      expect(debugSpy).toHaveBeenCalledWith(
        `Successfully fetched ${expected}. Status: 200`,
        context,
      );
    });

    it('carries a withExtra endpoint label on every record for the call', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 404 }));
      const labelled = withExtra(context, { endpoint: 'reverse' });

      await fetchWithTimeout(keyUrl, 1000, labelled).catch(() => undefined);

      const records = [...debugSpy.mock.calls, ...errorSpy.mock.calls];
      expect(records.length).toBeGreaterThanOrEqual(2);
      for (const [, recordContext] of records) {
        expect(recordContext).toMatchObject({ extra: { endpoint: 'reverse' } });
      }
    });

    it('keeps the path out of a withRetry retry record and the exhausted error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('busy', { status: 503 }));

      const error = (await withRetry(() => fetchWithTimeout(keyUrl, 1000, context), {
        maxRetries: 1,
        baseDelayMs: 1,
        jitter: 0,
        operation: 'reverseGeocode',
        context,
      }).catch((e) => e)) as McpError;

      expect(error.message).toBe(`Fetch failed for ${name}. Status: 503 (failed after 2 attempts)`);
      expect(debugSpy).toHaveBeenCalledWith(
        `Retry 1/1 for reverseGeocode: Fetch failed for ${name}. Status: 503 — waiting 1ms`,
        context,
      );
      expectNoPath(error.message);
      expectNoPath(everyRecord());
    });
  });

  describe('network-error cause (#615 — the transport code survives the wrapper)', () => {
    const url = 'https://api.example.com/sk-test-0000/x?key=1';
    const name = 'https://api.example.com/…?…';

    /** Node's shape: `fetch failed`, with the transport code on its cause. */
    function nodeRefusal(): TypeError {
      return new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3614'), {
          code: 'ECONNREFUSED',
        }),
      });
    }

    /**
     * Bun's shape: the code on the rejection itself, an enumerable `path`
     * holding the full URL, and no stack.
     */
    function bunRejection(message: string, code: string): TypeError {
      const rejection = Object.assign(new TypeError(message), { code, path: url, errno: 0 });
      Object.defineProperty(rejection, 'stack', { value: undefined });
      return rejection;
    }

    it("chains the runtime's rejection as cause, leaving code, message, and data unchanged", async () => {
      const rejection = nodeRefusal();
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(rejection);

      const error = (await fetchWithTimeout(url, 1000, context).catch((e) => e)) as McpError;

      expect(error.cause).toBe(rejection);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toBe(`Network error during fetch GET ${name}: fetch failed`);
      expect(error.data).toEqual({
        originalErrorName: 'TypeError',
        errorSource: 'FetchNetworkErrorWrapper',
      });
    });

    it('carries the projected chain on its own network-error record (Node shape)', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(nodeRefusal());

      await fetchWithTimeout(url, 1000, context).catch(() => undefined);

      expect(errorSpy).toHaveBeenCalledWith(
        `Network error during fetch GET ${name}: fetch failed`,
        {
          ...context,
          extra: {
            originalErrorName: 'TypeError',
            errorSource: 'FetchNetworkError',
            causeChain: [
              { name: 'TypeError', message: 'fetch failed' },
              {
                name: 'Error',
                message: 'connect ECONNREFUSED 127.0.0.1:3614',
                code: 'ECONNREFUSED',
              },
            ],
          },
        },
      );
    });

    it("carries the rejection's own code, never its path (Bun shape)", async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        bunRejection(
          'Unable to connect. Is the computer able to access the url?',
          'ConnectionRefused',
        ),
      );

      const error = (await fetchWithTimeout(url, 1000, context).catch((e) => e)) as McpError;

      const record = errorSpy.mock.calls.at(-1)?.[1] as { extra: Record<string, unknown> };
      expect(record.extra.causeChain).toEqual([
        {
          name: 'TypeError',
          message: 'Unable to connect. Is the computer able to access the url?',
          code: 'ConnectionRefused',
        },
      ]);
      expect((error.cause as { code?: unknown }).code).toBe('ConnectionRefused');
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('sk-test-0000');
    });

    it('logs a rejection with no cause and no string code exactly as before', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection reset'));

      await fetchWithTimeout(url, 1000, context).catch(() => undefined);

      expect(errorSpy).toHaveBeenCalledWith(
        `Network error during fetch GET ${name}: connection reset`,
        {
          ...context,
          extra: { originalErrorName: 'Error', errorSource: 'FetchNetworkError' },
        },
      );
    });

    it('redacts a URL the rejection quotes before chaining it, so no record or rootCause carries it', async () => {
      const quoted = (target: string) =>
        `Malformed_HTTP_Response fetching "${target}". For more information, pass \`verbose: true\` in the second argument to fetch()`;
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        bunRejection(quoted(url), 'Malformed_HTTP_Response'),
      );

      const error = (await ErrorHandler.tryCatch(() => fetchWithTimeout(url, 1000, context), {
        operation: 'reverseGeocode',
        context,
      }).catch((e) => e)) as McpError;

      // The chained rejection keeps its identity and code, with the URL reduced.
      const rejection = (error.cause as Error).cause as Error & { code?: unknown };
      expect(rejection).toBeInstanceOf(TypeError);
      expect(rejection.message).toBe(quoted(name));
      expect(rejection.code).toBe('Malformed_HTTP_Response');
      // `handleError` logs the root cause beside a chain carrying the code, and
      // puts none of it on the thrown error's data (#644).
      expect(error.data).not.toHaveProperty('rootCause');
      const handled = errorSpy.mock.calls.at(-1)?.[1] as {
        extra: { errorData: { causeChain: Array<{ code?: string }>; rootCause: unknown } };
      };
      expect(handled.extra.errorData.rootCause).toEqual({
        name: 'TypeError',
        message: quoted(name),
      });
      expect(handled.extra.errorData.causeChain.at(-1)?.code).toBe('Malformed_HTTP_Response');
      const everything = JSON.stringify([errorSpy.mock.calls, error.message, error.data]);
      expect(everything).not.toContain('sk-test-0000');
      expect(everything).not.toContain('key=1');
    });
  });

  describe('SSRF protection', () => {
    describe('hostname/IP pattern checks', () => {
      const ssrfOpts = { rejectPrivateIPs: true };

      it.each([
        'data:text/plain,hello',
        'file:///etc/passwd',
        'ftp://example.com/archive',
        'gopher://example.com/resource',
      ])('rejects the non-HTTP URL scheme in %s before fetch', async (url) => {
        const fetchMock = vi.spyOn(globalThis, 'fetch');

        await expect(fetchWithTimeout(url, 1000, context)).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: 'Only HTTP and HTTPS URLs are allowed.',
        });
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('should reject localhost', async () => {
        await expect(
          fetchWithTimeout('http://localhost/secrets', 1000, context, ssrfOpts),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining('private/internal hostname'),
        });
      });

      it('should reject 127.x.x.x', async () => {
        await expect(
          fetchWithTimeout('http://127.0.0.1/metadata', 1000, context, ssrfOpts),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      });

      it('should reject 10.x.x.x', async () => {
        await expect(
          fetchWithTimeout('http://10.0.0.1/internal', 1000, context, ssrfOpts),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      });

      it('should reject 192.168.x.x', async () => {
        await expect(
          fetchWithTimeout('http://192.168.1.1/admin', 1000, context, ssrfOpts),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      });

      it('should reject 169.254.169.254 (cloud metadata)', async () => {
        await expect(
          fetchWithTimeout('http://169.254.169.254/latest/meta-data/', 1000, context, ssrfOpts),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      });

      it('should reject metadata.google.internal', async () => {
        await expect(
          fetchWithTimeout(
            'http://metadata.google.internal/computeMetadata/v1/',
            1000,
            context,
            ssrfOpts,
          ),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      });

      it('should reject IPv6 loopback ::1', async () => {
        await expect(
          fetchWithTimeout('http://[::1]/secrets', 1000, context, ssrfOpts),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      });

      it('should reject IPv6 loopback full form', async () => {
        await expect(
          fetchWithTimeout('http://[0:0:0:0:0:0:0:1]/secrets', 1000, context, ssrfOpts),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      });

      it('should reject 172.16-31.x.x', async () => {
        await expect(
          fetchWithTimeout('http://172.16.0.1/', 1000, context, ssrfOpts),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
        await expect(
          fetchWithTimeout('http://172.31.255.255/', 1000, context, ssrfOpts),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      });

      it('should reject RFC 6598 CGNAT range', async () => {
        await expect(
          fetchWithTimeout('http://100.64.0.1/', 1000, context, ssrfOpts),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      });

      it.each([
        ['unspecified', '0.0.0.0'],
        ['IETF protocol assignments', '192.0.0.1'],
        ['TEST-NET-1', '192.0.2.1'],
        ['benchmarking', '198.18.0.1'],
        ['TEST-NET-2', '198.51.100.1'],
        ['TEST-NET-3', '203.0.113.1'],
        ['multicast', '224.0.0.1'],
        ['administratively scoped multicast', '239.255.255.250'],
        ['reserved', '240.0.0.1'],
        ['limited broadcast', '255.255.255.255'],
      ])('rejects non-global IPv4 %s destination %s', async (_label, address) => {
        await expect(
          fetchWithTimeout(`http://${address}/`, 1000, context, ssrfOpts),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining('non-global/reserved IP'),
        });
      });

      it.each([
        ['unspecified', '::'],
        ['IPv4-compatible', '::c0a8:101'],
        ['discard-only', '100::1'],
        ['benchmarking', '2001:2::1'],
        ['ORCHIDv2', '2001:20::1'],
        ['documentation', '2001:db8::1'],
        ['deprecated 6to4', '2002::1'],
        ['documentation prefix', '3fff::1'],
        ['deprecated site-local', 'fec0::1'],
        ['multicast', 'ff02::1'],
      ])('rejects non-global IPv6 %s destination %s', async (_label, address) => {
        await expect(
          fetchWithTimeout(`http://[${address}]/`, 1000, context, ssrfOpts),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining('non-global/reserved IP'),
        });
      });

      it('should allow public IPs when SSRF protection is enabled', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
        // 8.8.8.8 is a public IP — string check passes, DNS resolution skipped for literal IPs
        const result = await fetchWithTimeout('https://8.8.8.8', 1000, context, ssrfOpts);
        expect(result.status).toBe(200);
        expect(await result.text()).toBe('ok');
      });

      it('should reject IPv6 ULA fc00::/7', async () => {
        await expect(
          fetchWithTimeout('http://[fc00::1]/', 1000, context, ssrfOpts),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
        await expect(
          fetchWithTimeout('http://[fdab::1]/', 1000, context, ssrfOpts),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      });

      it('should reject IPv6 link-local across full fe80::/10 range', async () => {
        for (const addr of ['fe80::1', 'fe9a::1', 'feaf::1', 'febf::1']) {
          await expect(
            fetchWithTimeout(`http://[${addr}]/`, 1000, context, ssrfOpts),
          ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
        }
      });

      it('should reject zero-stripped IPv6 addresses outside global unicast space', async () => {
        for (const addr of ['fe8::1', 'fc::1']) {
          await expect(
            fetchWithTimeout(`http://[${addr}]/`, 1000, context, ssrfOpts),
          ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
        }
      });

      it('should reject IPv4-mapped IPv6 across full RFC 1918 / CGNAT space', async () => {
        for (const addr of [
          '::ffff:127.0.0.1',
          '::ffff:10.0.0.1',
          '::ffff:172.17.0.1', // 172.17 was uncovered by the old prefix list
          '::ffff:172.31.0.1',
          '::ffff:192.168.1.1',
          '::ffff:169.254.169.254',
          '::ffff:100.64.0.1', // CGNAT, uncovered by the old prefix list
        ]) {
          await expect(
            fetchWithTimeout(`http://[${addr}]/`, 1000, context, ssrfOpts),
          ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
        }
      });

      it('should reject private IPv6 regardless of case', async () => {
        for (const addr of ['FE80::1', 'FC00::1', '::FFFF:7F00:1']) {
          await expect(
            fetchWithTimeout(`http://[${addr}]/`, 1000, context, ssrfOpts),
          ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
        }
      });

      it('should reject non-global IPv6 addresses outside the legacy private prefixes', async () => {
        for (const addr of ['fe7f::1', 'fec0::1', 'fbff::1']) {
          await expect(
            fetchWithTimeout(`http://[${addr}]/`, 1000, context, ssrfOpts),
          ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
        }
      });

      it('should allow public IPv6 addresses', async () => {
        // A fresh Response per call: the returned body is read under the deadline,
        // so one shared instance would be locked after the first request.
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
          Promise.resolve(new Response('ok', { status: 200 })),
        );
        for (const addr of ['2001:4860:4860::8888', '2606:4700:4700::1111']) {
          await expect(
            (await fetchWithTimeout(`http://[${addr}]/`, 1000, context, ssrfOpts)).text(),
          ).resolves.toBe('ok');
        }
      });
    });

    describe('DNS resolver split (#365)', () => {
      const ssrfOpts = { rejectPrivateIPs: true };

      it('queries the c-ares and system resolvers for the same name', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

        await (await fetchWithTimeout('https://public.example/', 1000, context, ssrfOpts)).text();

        expect(dnsSlots.resolve4).toHaveBeenCalledWith('public.example');
        expect(dnsSlots.resolve6).toHaveBeenCalledWith('public.example');
        expect(dnsSlots.lookup).toHaveBeenCalledWith('public.example', { all: true });
      });

      it('blocks a name only the system resolver can see (Bun 1.4 Linux split)', async () => {
        // c-ares does not consult /etc/hosts or systemd-resolved, so `resolve4`
        // fails while `getaddrinfo` — what the connection actually uses — answers
        // with the internal address the guard exists to block.
        dnsSlots.lookup = vi.fn().mockResolvedValue([{ address: '10.0.0.12', family: 4 }]);
        const fetchMock = vi.spyOn(globalThis, 'fetch');

        await expect(
          fetchWithTimeout('http://internal.example/', 1000, context, ssrfOpts),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining('non-global IP 10.0.0.12'),
        });
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('blocks a non-global IPv6 answer from the system resolver', async () => {
        dnsSlots.lookup = vi.fn().mockResolvedValue([{ address: 'fd00::1', family: 6 }]);

        await expect(
          fetchWithTimeout('http://internal.example/', 1000, context, ssrfOpts),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining('fd00::1'),
        });
      });

      it('still blocks on a c-ares answer the system resolver disagrees with', async () => {
        dnsSlots.resolve4 = vi.fn().mockResolvedValue(['192.168.1.5']);
        dnsSlots.lookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

        await expect(
          fetchWithTimeout('http://split.example/', 1000, context, ssrfOpts),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining('192.168.1.5'),
        });
      });

      it('keeps the c-ares answer when lookup is absent from the runtime', async () => {
        // Workers under `nodejs_compat` may not implement every dns function. A
        // missing one must not swallow the answers that did arrive.
        dnsSlots.lookup = undefined;
        dnsSlots.resolve6 = vi.fn().mockResolvedValue(['fd00::99']);

        await expect(
          fetchWithTimeout('http://partial.example/', 1000, context, ssrfOpts),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining('fd00::99'),
        });
      });

      it('keeps the c-ares answer when lookup throws synchronously', async () => {
        dnsSlots.lookup = vi.fn(() => {
          throw new TypeError('dns.lookup is not implemented');
        });
        dnsSlots.resolve4 = vi.fn().mockResolvedValue(['10.1.2.3']);

        await expect(
          fetchWithTimeout('http://partial.example/', 1000, context, ssrfOpts),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining('10.1.2.3'),
        });
      });

      it('lets a name no resolver can see through to fetch', async () => {
        // A resolution failure is not an SSRF signal — `fetch` reports it.
        const fetchMock = vi
          .spyOn(globalThis, 'fetch')
          .mockResolvedValue(new Response('ok', { status: 200 }));

        await expect(
          (await fetchWithTimeout('https://nowhere.example/', 1000, context, ssrfOpts)).text(),
        ).resolves.toBe('ok');
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it('allows a name both resolvers agree is public', async () => {
        dnsSlots.resolve4 = vi.fn().mockResolvedValue(['93.184.216.34']);
        dnsSlots.lookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

        await expect(
          (await fetchWithTimeout('https://public.example/', 1000, context, ssrfOpts)).text(),
        ).resolves.toBe('ok');
      });
    });

    describe('redirect validation', () => {
      it('should reject a redirect to a non-HTTP scheme', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: { location: 'file:///etc/passwd' },
          }),
        );

        await expect(
          fetchWithTimeout('https://public.example.com', 1000, context, {
            rejectPrivateIPs: true,
          }),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: 'Only HTTP and HTTPS URLs are allowed.',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it('should reject redirect to private IP', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: { location: 'http://169.254.169.254/metadata' },
          }),
        );

        await expect(
          fetchWithTimeout('https://public.example.com', 1000, context, {
            rejectPrivateIPs: true,
          }),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
        });
      });

      it('should reject redirect to IPv6 ULA', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: { location: 'http://[fc00::1]/internal' },
          }),
        );
        await expect(
          fetchWithTimeout('https://public.example.com', 1000, context, {
            rejectPrivateIPs: true,
          }),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      });

      it('should reject redirect to IPv4-mapped IPv6 private address', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: { location: 'http://[::ffff:ac11:1]/' }, // 172.17.0.1 in hex form
          }),
        );
        await expect(
          fetchWithTimeout('https://public.example.com', 1000, context, {
            rejectPrivateIPs: true,
          }),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      });

      it('should reject redirect to localhost', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
          new Response(null, {
            status: 301,
            headers: { location: 'http://localhost/admin' },
          }),
        );

        await expect(
          fetchWithTimeout('https://public.example.com', 1000, context, {
            rejectPrivateIPs: true,
          }),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining('private/internal hostname'),
        });
      });

      it('should reject excessive redirects', async () => {
        // Every fetch returns a redirect to a public URL
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(null, {
            status: 302,
            headers: { location: 'https://example.com/loop' },
          }),
        );

        await expect(
          fetchWithTimeout('https://loop.example.com', 1000, context, {
            rejectPrivateIPs: true,
          }),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining('Too many redirects'),
        });
      });

      it('should follow safe redirects', async () => {
        const fetchMock = vi
          .spyOn(globalThis, 'fetch')
          .mockResolvedValueOnce(
            new Response(null, {
              status: 301,
              headers: { location: 'https://new.example.com/page' },
            }),
          )
          .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const result = await fetchWithTimeout('https://old.example.com', 1000, context, {
          rejectPrivateIPs: true,
        });
        expect(result.status).toBe(200);
        expect(await result.text()).toBe('ok');
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      it('re-runs the dual-resolver guard on every redirect hop (#365)', async () => {
        // The first hop is clean; the second resolves — through the system
        // resolver only — to internal space. A guard that ran once at the top
        // would follow it.
        dnsSlots.lookup = vi.fn(async (hostname: string) => {
          if (hostname === 'hop-two.example') return [{ address: '10.0.0.5', family: 4 }];
          throw unresolvable();
        });
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: { location: 'https://hop-two.example/inner' },
          }),
        );

        await expect(
          fetchWithTimeout('https://hop-one.example/', 1000, context, { rejectPrivateIPs: true }),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining('non-global IP 10.0.0.5'),
        });

        expect(dnsSlots.lookup).toHaveBeenCalledWith('hop-one.example', { all: true });
        expect(dnsSlots.lookup).toHaveBeenCalledWith('hop-two.example', { all: true });
        // The second hop was never requested — the guard stopped it.
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it('should fail a redirect missing its Location header as its HTTP status', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 302 }));

        await expect(
          fetchWithTimeout('https://public.example.com', 1000, context, {
            rejectPrivateIPs: true,
          }),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.InvalidRequest,
          data: { status: 302, errorSource: 'FetchHttpError' },
        });
      });

      it('should not use manual redirect mode when SSRF protection is disabled', async () => {
        const fetchMock = vi
          .spyOn(globalThis, 'fetch')
          .mockResolvedValue(new Response('ok', { status: 200 }));

        await (await fetchWithTimeout('https://example.com', 1000, context)).text();

        expect(fetchMock).toHaveBeenCalledWith(
          'https://example.com',
          expect.not.objectContaining({ redirect: 'manual' }),
        );
      });

      it('should use manual redirect mode when SSRF protection is enabled', async () => {
        const fetchMock = vi
          .spyOn(globalThis, 'fetch')
          .mockResolvedValue(new Response('ok', { status: 200 }));

        await (
          await fetchWithTimeout('https://8.8.8.8', 1000, context, { rejectPrivateIPs: true })
        ).text();

        expect(fetchMock).toHaveBeenCalledWith(
          'https://8.8.8.8',
          expect.objectContaining({ redirect: 'manual' }),
        );
      });
    });
  });

  /**
   * Every validation rejection carries a stable `data.reason` and a recovery
   * hint, so a caller can branch on it and the hint reaches both tool surfaces.
   */
  describe('validation failure reasons', () => {
    const ssrfOpts = { rejectPrivateIPs: true };

    async function failureOf(run: () => Promise<unknown>): Promise<McpError> {
      const error = await run().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McpError);
      return error as McpError;
    }

    it.each([
      ['an unparseable URL', 'not a url'],
      ['a non-HTTP scheme', 'ftp://example.com/archive'],
    ])('rejects %s as invalid_url', async (_label, url) => {
      const error = await failureOf(() => fetchWithTimeout(url, 1000, context));

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toEqual({
        reason: 'invalid_url',
        recovery: { hint: 'Pass an absolute http:// or https:// URL.' },
      });
    });

    it('rejects a redirect to a non-HTTP scheme as invalid_url', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } }),
      );

      const error = await failureOf(() =>
        fetchWithTimeout('https://public.example.com', 1000, context, ssrfOpts),
      );

      expect(error.data?.reason).toBe('invalid_url');
    });

    it.each([
      ['a private hostname', 'http://localhost/secrets'],
      ['a non-global literal IP', 'http://10.0.0.1/internal'],
      ['a cloud metadata address', 'http://169.254.169.254/latest'],
    ])('rejects %s as private_address_blocked', async (_label, url) => {
      const error = await failureOf(() => fetchWithTimeout(url, 1000, context, ssrfOpts));

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toEqual({
        reason: 'private_address_blocked',
        recovery: {
          hint: 'Use a publicly routable host — private, loopback, link-local, and cloud-metadata addresses are blocked.',
        },
      });
    });

    it('rejects a name that resolves to a private address as private_address_blocked', async () => {
      dnsSlots.resolve4 = vi.fn().mockResolvedValue(['10.1.2.3']);

      const error = await failureOf(() =>
        fetchWithTimeout('https://sneaky.example.com', 1000, context, ssrfOpts),
      );

      expect(error.message).toContain('SSRF blocked');
      expect(error.data?.reason).toBe('private_address_blocked');
    });

    it('rejects a redirect to a private address as private_address_blocked', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } }),
      );

      const error = await failureOf(() =>
        fetchWithTimeout('https://public.example.com', 1000, context, ssrfOpts),
      );

      expect(error.data?.reason).toBe('private_address_blocked');
    });

    it('rejects a redirect chain past the cap as too_many_redirects', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'https://example.com/loop' } }),
      );

      const error = await failureOf(() =>
        fetchWithTimeout('https://loop.example.com', 1000, context, ssrfOpts),
      );

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toEqual({
        maxRedirects: 5,
        reason: 'too_many_redirects',
        recovery: {
          hint: 'Request the final URL directly instead of one that redirects more than 5 times.',
        },
      });
    });
  });

  /**
   * A redirect hop the SSRF guard rejects is the same policy refusal the initial
   * URL gets before any request is sent, so it leaves the same way: thrown, with
   * no record from `fetchWithTimeout`. The caller logs it, at the severity its
   * own contract declares. Genuine network errors keep their record.
   */
  describe('a redirect hop the SSRF guard rejects (#647)', () => {
    const ssrfOpts = { rejectPrivateIPs: true };
    const START = 'https://public.example.com';
    let atWarningOrAbove: MockInstance[];

    beforeEach(() => {
      atWarningOrAbove = [
        vi.spyOn(logger, 'warning').mockImplementation(() => {}),
        errorSpy,
        vi.spyOn(logger, 'crit').mockImplementation(() => {}),
        vi.spyOn(logger, 'alert').mockImplementation(() => {}),
        vi.spyOn(logger, 'emerg').mockImplementation(() => {}),
      ];
      // `inside.example` resolves to private space; every other name stays unresolvable.
      dnsSlots.lookup = vi.fn(async (hostname: string) => {
        if (hostname === 'inside.example') return [{ address: '10.9.8.7', family: 4 }];
        throw unresolvable();
      });
    });

    function expectNoRecordAtWarningOrAbove() {
      for (const spy of atWarningOrAbove) expect(spy).not.toHaveBeenCalled();
    }

    const redirectTo = (location: string) =>
      new Response(null, { status: 302, headers: { location } });

    it.each([
      ['a non-global literal IP', 'http://10.0.0.1/', 'private_address_blocked'],
      ['a private hostname', 'http://localhost/', 'private_address_blocked'],
      [
        'a name the resolver answers with a private address',
        'https://inside.example/',
        'private_address_blocked',
      ],
      ['a non-HTTP scheme', 'file:///etc/passwd', 'invalid_url'],
    ])(
      'a 302 to %s rejects as that URL does up front, with no record at warning or above',
      async (_label, location, reason) => {
        const upFront = (await fetchWithTimeout(location, 1000, context, ssrfOpts).catch(
          (e) => e,
        )) as McpError;
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(redirectTo(location));

        const error = (await fetchWithTimeout(START, 1000, context, ssrfOpts).catch(
          (e) => e,
        )) as McpError;

        expect(error).toBeInstanceOf(McpError);
        expect(error.data?.reason).toBe(reason);
        expect(error).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: upFront.message,
          data: upFront.data,
        });
        expectNoRecordAtWarningOrAbove();
      },
    );

    it('a redirect loop rejects as too_many_redirects, logging each followed hop at debug only', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        redirectTo('https://example.com/loop'),
      );

      const error = (await fetchWithTimeout(START, 1000, context, ssrfOpts).catch(
        (e) => e,
      )) as McpError;

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'too_many_redirects', maxRedirects: 5 },
      });
      for (let hop = 1; hop <= 5; hop++) {
        expect(debugSpy).toHaveBeenCalledWith(
          `Following validated redirect ${hop}: https://example.com/…`,
          context,
        );
      }
      expectNoRecordAtWarningOrAbove();
    });

    it("a tool declaring severity 'notice' for private_address_blocked logs the rejection only at notice", async () => {
      const noticeSpy = vi.spyOn(logger, 'notice').mockImplementation(() => {});
      vi.spyOn(logger, 'info').mockImplementation(() => {});
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(redirectTo('http://10.0.0.1/admin'));
      const definition = tool('fetch_page', {
        description: 'Fetches one page.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('Always true') }),
        errors: [
          {
            reason: 'private_address_blocked',
            code: JsonRpcErrorCode.ValidationError,
            when: 'The target or a redirect hop is a private address',
            recovery: 'Use a publicly routable host instead of a private one.',
            severity: 'notice',
            thrownBy: 'service',
          },
        ],
        async handler(_input, ctx) {
          await fetchWithTimeout(START, 1000, ctx, ssrfOpts);
          return { ok: true };
        },
      });
      const handler = createToolHandler(
        definition as AnyToolDefinition,
        { logger, storage: undefined } as never,
        {},
        legacyCapabilityView({}),
      );

      const result = (await handler({}, makeServerContext({}))) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'private_address_blocked' },
        },
      });
      expect(noticeSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /^Error in tool:fetch_page: Request to non-global\/reserved IP blocked/,
        ),
        expect.anything(),
      );
      expectNoRecordAtWarningOrAbove();
    });

    it.each([302, 304])(
      'a %i with no Location fails as it does without the option',
      async (status) => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(
          async () => new Response(null, { status }),
        );

        for (const options of [ssrfOpts, {}]) {
          errorSpy.mockClear();

          const error = (await fetchWithTimeout(START, 1000, context, options).catch(
            (e) => e,
          )) as McpError;

          expect(error).toMatchObject({
            code: JsonRpcErrorCode.InvalidRequest,
            message: `Fetch failed for ${START}. Status: ${status}`,
            data: { status, errorSource: 'FetchHttpError' },
          });
          expect(errorSpy).toHaveBeenCalledTimes(1);
          expect(errorSpy).toHaveBeenCalledWith(
            `Fetch failed for ${START} with status ${status}.`,
            expect.objectContaining({
              extra: expect.objectContaining({ errorSource: 'FetchHttpError' }),
            }),
          );
        }
      },
    );

    it('withRetry fetches a 302 with no Location once, as without the option', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => new Response(null, { status: 302 }));

      const error = (await withRetry(() => fetchWithTimeout(START, 1000, context, ssrfOpts), {
        maxRetries: 3,
        baseDelayMs: 1,
        jitter: 0,
      }).catch((e) => e)) as McpError;

      expect(error.code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each<[string, () => Promise<Response>]>([
      [
        'a fetch rejection',
        async () => {
          throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' });
        },
      ],
      ['a 302 with an unparseable Location', async () => redirectTo('https://exa mple.com/')],
    ])(
      '%s still logs a network error with causeChain and throws the wrapper',
      async (_label, fake) => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(fake);

        const error = (await fetchWithTimeout(START, 1000, context, ssrfOpts).catch(
          (e) => e,
        )) as McpError;

        expect(error).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { errorSource: 'FetchNetworkErrorWrapper' },
        });
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringMatching(/^Network error during fetch GET https:\/\/public\.example\.com: /),
          expect.objectContaining({
            extra: expect.objectContaining({
              errorSource: 'FetchNetworkError',
              causeChain: [
                expect.objectContaining({ name: 'TypeError', code: expect.any(String) }),
              ],
            }),
          }),
        );
      },
    );

    it('a guard rejection landing after timeoutMs still throws Timeout', async () => {
      // The redirect target's lookup ignores the signal and answers after the deadline.
      dnsSlots.lookup = vi.fn(async (hostname: string) => {
        if (hostname !== 'slow.example') throw unresolvable();
        await new Promise((resolve) => setTimeout(resolve, 150));
        return [{ address: '10.0.0.9', family: 4 }];
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(redirectTo('https://slow.example/'));

      const error = (await fetchWithTimeout(START, 30, context, ssrfOpts).catch(
        (e) => e,
      )) as McpError;

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { errorSource: 'FetchTimeout' },
      });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        `fetch GET ${START} timed out after 30ms.`,
        expect.anything(),
      );
    });
  });
});

/**
 * @fileoverview Unit tests for the fetchWithTimeout utility.
 * @module tests/utils/network/fetchWithTimeout.test
 */
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { JsonRpcErrorCode, McpError } from '../../../../src/types-global/errors.js';
import { logger } from '../../../../src/utils/internal/logger.js';
import { fetchWithTimeout } from '../../../../src/utils/network/fetchWithTimeout.js';

describe('fetchWithTimeout', () => {
  const context = {
    requestId: 'ctx-1',
    timestamp: new Date().toISOString(),
  };
  let debugSpy: MockInstance;
  let errorSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
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
        errorSource: 'FetchHttpError',
        statusCode: 503,
      }),
    );
  });

  describe.each([
    [400, JsonRpcErrorCode.InvalidParams],
    [401, JsonRpcErrorCode.Unauthorized],
    [403, JsonRpcErrorCode.Forbidden],
    [404, JsonRpcErrorCode.NotFound],
    [408, JsonRpcErrorCode.Timeout],
    [409, JsonRpcErrorCode.Conflict],
    [422, JsonRpcErrorCode.ValidationError],
    [429, JsonRpcErrorCode.RateLimited],
    [500, JsonRpcErrorCode.InternalError],
    [502, JsonRpcErrorCode.ServiceUnavailable],
    [504, JsonRpcErrorCode.Timeout],
  ])('status %d maps to the right error code', (status, expectedCode) => {
    it(`throws with code ${expectedCode}`, async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('err', { status }));
      await expect(fetchWithTimeout('https://example.com', 1000, context)).rejects.toMatchObject({
        code: expectedCode,
        data: { statusCode: status },
      });
    });
  });

  it('falls through to InvalidRequest for unmapped 4xx codes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('gone', { status: 410 }));
    await expect(fetchWithTimeout('https://example.com', 1000, context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidRequest,
      data: { statusCode: 410 },
    });
  });

  it('falls through to ServiceUnavailable for unmapped 5xx codes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('weird', { status: 599 }));
    await expect(fetchWithTimeout('https://example.com', 1000, context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { statusCode: 599 },
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
      expect.objectContaining({ errorSource: 'FetchTimeout' }),
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
        errorSource: 'FetchNetworkError',
        originalErrorName: 'Error',
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
        errorSource: 'FetchNetworkError',
        originalErrorName: 'McpError',
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
        responseBody: 'Could not read response body',
        errorSource: 'FetchHttpError',
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
        originalErrorName: 'UnknownError',
        errorSource: 'FetchNetworkError',
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
      code: JsonRpcErrorCode.InternalError,
      data: expect.objectContaining({ errorSource: 'FetchAborted' }),
    });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('aborted by caller'),
      expect.objectContaining({ errorSource: 'FetchAborted' }),
    );
  });

  it('keeps a caller TimeoutError classified as FetchAborted, not FetchTimeout', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const externalController = new AbortController();

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );

    const promise = fetchWithTimeout('https://example.com', 30_000, context, {
      signal: externalController.signal,
    });

    // A caller may abort with a TimeoutError of its own — matching on the name
    // alone would misattribute that to this helper's internal timeout.
    externalController.abort(new DOMException('caller deadline', 'TimeoutError'));

    await expect(promise).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      data: expect.objectContaining({ errorSource: 'FetchAborted' }),
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
        expect.objectContaining({ statusCode: 404, errorSource: 'FetchHttpError' }),
      );
    });

    it('still logs at error for a non-2xx status not listed in expectedStatuses', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));

      await expect(
        fetchWithTimeout('https://example.com', 1000, context, { expectedStatuses: [404] }),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.InternalError });

      expect(errorSpy).toHaveBeenCalledWith(
        'Fetch failed for https://example.com with status 500.',
        expect.objectContaining({ statusCode: 500, errorSource: 'FetchHttpError' }),
      );
    });
  });

  describe('URL redaction (#190 — query-string secrets must not leak)', () => {
    // The Guardian (?api-key=…) and many api.data.gov services (?api_key=…)
    // authenticate via the query string. The secret must never reach a
    // client-facing error message or the logs.
    const secretUrl = 'https://api.example.com/search?q=cats&api-key=SUPERSECRET';
    const safePrefix = 'https://api.example.com/search';

    it('redacts the secret from the thrown error and the log on a non-OK response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 401 }));
      const error = (await fetchWithTimeout(secretUrl, 1000, context).catch((e) => e)) as McpError;

      expect(error.message).not.toContain('SUPERSECRET');
      expect(error.message).not.toContain('api-key');
      expect(error.message).toContain(safePrefix);

      const logged = String(errorSpy.mock.calls.at(-1)?.[0]);
      expect(logged).not.toContain('SUPERSECRET');
      expect(logged).toContain(safePrefix);
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
      expect(error.message).toContain(safePrefix);
    });

    it('redacts the secret from the network-error wrapper', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection reset'));
      const error = (await fetchWithTimeout(secretUrl, 1000, context).catch((e) => e)) as McpError;
      expect(error.message).not.toContain('SUPERSECRET');
      expect(error.message).toContain(safePrefix);
    });

    it('redacts the secret from the success debug log', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
      await fetchWithTimeout(secretUrl, 1000, context);
      const logged = String(
        debugSpy.mock.calls.find((c) => String(c[0]).includes('Successfully fetched'))?.[0],
      );
      expect(logged).not.toContain('SUPERSECRET');
      expect(logged).toContain(safePrefix);
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
            fetchWithTimeout(`http://[${addr}]/`, 1000, context, ssrfOpts),
          ).resolves.toMatchObject({ status: 200 });
        }
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
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      it('should reject redirect missing Location header', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 302 }));

        await expect(
          fetchWithTimeout('https://public.example.com', 1000, context, {
            rejectPrivateIPs: true,
          }),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: expect.stringContaining('missing Location header'),
        });
      });

      it('should not use manual redirect mode when SSRF protection is disabled', async () => {
        const fetchMock = vi
          .spyOn(globalThis, 'fetch')
          .mockResolvedValue(new Response('ok', { status: 200 }));

        await fetchWithTimeout('https://example.com', 1000, context);

        expect(fetchMock).toHaveBeenCalledWith(
          'https://example.com',
          expect.not.objectContaining({ redirect: 'manual' }),
        );
      });

      it('should use manual redirect mode when SSRF protection is enabled', async () => {
        const fetchMock = vi
          .spyOn(globalThis, 'fetch')
          .mockResolvedValue(new Response('ok', { status: 200 }));

        await fetchWithTimeout('https://8.8.8.8', 1000, context, { rejectPrivateIPs: true });

        expect(fetchMock).toHaveBeenCalledWith(
          'https://8.8.8.8',
          expect.objectContaining({ redirect: 'manual' }),
        );
      });
    });
  });
});

/**
 * @fileoverview Unit tests for the HTTP error helpers.
 * @module tests/utils/network/httpError.test
 */

import { describe, expect, it } from 'vitest';

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import {
  httpErrorFromResponse,
  httpStatusRetryability,
  httpStatusToErrorCode,
} from '@/utils/network/httpError.js';
import { defaultIsTransient } from '@/utils/network/retry.js';

describe('httpStatusToErrorCode', () => {
  it.each([
    [200, undefined],
    [301, JsonRpcErrorCode.InvalidRequest],
    [400, JsonRpcErrorCode.InvalidParams],
    [401, JsonRpcErrorCode.Unauthorized],
    [402, JsonRpcErrorCode.Forbidden],
    [403, JsonRpcErrorCode.Forbidden],
    [404, JsonRpcErrorCode.NotFound],
    [405, JsonRpcErrorCode.InvalidRequest],
    [408, JsonRpcErrorCode.Timeout],
    [409, JsonRpcErrorCode.Conflict],
    [410, JsonRpcErrorCode.InvalidRequest],
    [422, JsonRpcErrorCode.ValidationError],
    [423, JsonRpcErrorCode.Conflict],
    [424, JsonRpcErrorCode.Conflict],
    [425, JsonRpcErrorCode.Timeout],
    [428, JsonRpcErrorCode.InvalidRequest],
    [429, JsonRpcErrorCode.RateLimited],
    [451, JsonRpcErrorCode.InvalidRequest],
    [499, JsonRpcErrorCode.InvalidRequest],
    [500, JsonRpcErrorCode.ServiceUnavailable],
    [501, JsonRpcErrorCode.ServiceUnavailable],
    [502, JsonRpcErrorCode.ServiceUnavailable],
    [503, JsonRpcErrorCode.ServiceUnavailable],
    [504, JsonRpcErrorCode.Timeout],
    [505, JsonRpcErrorCode.ServiceUnavailable],
    [599, JsonRpcErrorCode.ServiceUnavailable],
  ])('maps status %i to %s', (status, expected) => {
    expect(httpStatusToErrorCode(status)).toBe(expected);
  });

  it('never classifies an upstream status as this server’s own InternalError (#323, #460)', () => {
    // `InternalError` means "this server has a bug". A remote status — redirects
    // included — can never establish that, so no status may map to it.
    const codes = Array.from({ length: 300 }, (_, i) => httpStatusToErrorCode(300 + i));
    expect(codes).not.toContain(JsonRpcErrorCode.InternalError);
  });
});

describe('redirect classification (#460)', () => {
  it.each([300, 301, 302, 303, 304, 307, 308, 399])(
    'maps redirect status %i to InvalidRequest',
    (status) => {
      // A 3xx reaching error mapping means the request as sent cannot be served
      // at this URL — an upstream-origin outcome, not a fault in this server.
      expect(httpStatusToErrorCode(status)).toBe(JsonRpcErrorCode.InvalidRequest);
    },
  );

  it.each([100, 101, 200, 204, 299])('leaves non-error status %i unmapped', (status) => {
    expect(httpStatusToErrorCode(status)).toBeUndefined();
  });

  it('keeps a 3xx out of withRetry’s transient set', () => {
    // `InvalidRequest` is deliberately outside TRANSIENT_CODES: re-issuing the
    // same request to the same URL returns the same redirect.
    const code = httpStatusToErrorCode(302);
    expect(code).toBe(JsonRpcErrorCode.InvalidRequest);
    expect(defaultIsTransient(new McpError(code as JsonRpcErrorCode, 'redirect'))).toBe(false);
  });
});

describe('httpStatusRetryability (#323)', () => {
  it('marks 501 Not Implemented as permanently non-retryable', () => {
    // The endpoint does not exist upstream; a second attempt cannot change that.
    expect(httpStatusRetryability(501)).toEqual({ retryable: false });
  });

  it('has no opinion on 500, which is retryable under the default predicate', () => {
    expect(httpStatusRetryability(500)).toBeUndefined();
  });

  it.each([400, 404, 429, 502, 503, 504, 599])('has no opinion on %i', (status) => {
    expect(httpStatusRetryability(status)).toBeUndefined();
  });
});

describe('httpErrorFromResponse', () => {
  function makeResponse(
    status: number,
    options: {
      body?: string;
      headers?: Record<string, string>;
      statusText?: string;
      url?: string;
    } = {},
  ): Response {
    // Null-body statuses (204/205/304) reject any body, including ''. Default to
    // null so the helper works across runtimes; `.text()` still yields ''.
    const response = new Response(options.body ?? null, {
      status,
      statusText: options.statusText ?? '',
      ...(options.headers && { headers: options.headers }),
    });
    if (options.url) {
      Object.defineProperty(response, 'url', { value: options.url });
    }
    return response;
  }

  it('classifies 429 as RateLimited and includes Retry-After', async () => {
    const response = makeResponse(429, {
      body: 'slow down',
      headers: { 'retry-after': '30' },
      statusText: 'Too Many Requests',
      url: 'https://api.example.com/foo',
    });

    const error = await httpErrorFromResponse(response, { service: 'NCBI' });

    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.message).toBe('NCBI returned HTTP 429 Too Many Requests.');
    expect(error.data).toMatchObject({
      status: 429,
      statusText: 'Too Many Requests',
      body: 'slow down',
      retryAfter: '30',
    });
  });

  describe('upstream URL exposure (#307)', () => {
    // `error.data` is forwarded to the client verbatim, and an upstream request
    // URL routinely carries user input or an API key in its query string.
    const secretUrl = 'https://api.example.com/v1/search?q=secret-term&api_key=REDACTED';

    it('omits the upstream URL from error.data by default', async () => {
      const error = await httpErrorFromResponse(makeResponse(400, { url: secretUrl }), {
        service: 'Example',
        captureBody: false,
      });

      expect(Object.keys(error.data as Record<string, unknown>)).not.toContain('url');
      expect(JSON.stringify(error.data)).not.toContain('secret-term');
    });

    it('omits the URL at every status, not only the ones that carry a body', async () => {
      for (const status of [400, 401, 403, 404, 422, 429, 500, 503]) {
        const error = await httpErrorFromResponse(makeResponse(status, { url: secretUrl }));
        expect(error.data).not.toHaveProperty('url');
      }
    });

    it('puts the full URL on data.url when includeUrl is set', async () => {
      const error = await httpErrorFromResponse(makeResponse(400, { url: secretUrl }), {
        includeUrl: true,
      });

      expect(error.data?.url).toBe(secretUrl);
    });

    it('adds no url key when response.url is empty, with or without includeUrl', async () => {
      for (const includeUrl of [false, true]) {
        const error = await httpErrorFromResponse(makeResponse(500), { includeUrl });
        expect(Object.keys(error.data as Record<string, unknown>)).not.toContain('url');
      }
    });

    it('still lets a caller put its own url on error.data', async () => {
      const error = await httpErrorFromResponse(makeResponse(500, { url: secretUrl }), {
        data: { url: 'https://api.example.com/v1/search' },
      });

      expect(error.data?.url).toBe('https://api.example.com/v1/search');
    });

    it('keeps the host in the message even though the URL is dropped from data', async () => {
      const error = await httpErrorFromResponse(makeResponse(503, { url: secretUrl }));

      expect(error.message).toBe('api.example.com returned HTTP 503.');
      expect(error.data).not.toHaveProperty('url');
    });
  });

  describe('selected error headers (#302)', () => {
    // Every selected value reaches the MCP client verbatim, so capture is opt-in
    // and never widens to headers the caller did not name.
    const headers = {
      'x-ratelimit-remaining-usd': '0.42',
      'x-request-id': 'req-7',
      'x-empty': '',
      'set-cookie': 'session=secret; HttpOnly',
    };

    it('emits no headers key when the selector is omitted or empty', async () => {
      for (const errorHeaders of [undefined, []]) {
        const error = await httpErrorFromResponse(makeResponse(429, { headers }), {
          ...(errorHeaders && { errorHeaders }),
        });

        expect(error.data).not.toHaveProperty('headers');
      }
    });

    it('leaves the rest of error.data byte-identical to a capture-free error', async () => {
      const baseline = await httpErrorFromResponse(
        makeResponse(429, { body: 'slow down', headers, statusText: 'Too Many Requests' }),
        { service: 'Example' },
      );
      const selected = await httpErrorFromResponse(
        makeResponse(429, { body: 'slow down', headers, statusText: 'Too Many Requests' }),
        { service: 'Example', errorHeaders: ['x-request-id'] },
      );
      const { headers: captured, ...rest } = selected.data as Record<string, unknown>;

      expect(captured).toEqual({ 'x-request-id': 'req-7' });
      expect(rest).toEqual(baseline.data);
      expect(selected.code).toBe(baseline.code);
      expect(selected.message).toBe(baseline.message);
    });

    it('selects case-insensitively and lowercases the keys', async () => {
      const error = await httpErrorFromResponse(makeResponse(429, { headers }), {
        errorHeaders: ['X-Request-Id', 'X-RateLimit-Remaining-USD'],
      });

      expect(error.data?.headers).toEqual({
        'x-request-id': 'req-7',
        'x-ratelimit-remaining-usd': '0.42',
      });
    });

    it('collapses selector entries that differ only in case', async () => {
      const error = await httpErrorFromResponse(makeResponse(429, { headers }), {
        errorHeaders: ['x-request-id', 'X-Request-Id', 'X-REQUEST-ID'],
      });

      expect(Object.keys(error.data?.headers as Record<string, string>)).toEqual(['x-request-id']);
    });

    it('adds no key for a selected header the response does not carry', async () => {
      const error = await httpErrorFromResponse(makeResponse(429, { headers }), {
        errorHeaders: ['x-request-id', 'x-absent'],
      });

      expect(error.data?.headers).toEqual({ 'x-request-id': 'req-7' });
    });

    it('captures a present-but-empty header as an empty string', async () => {
      // Presence follows `Headers.has()`, not truthiness of the value.
      const error = await httpErrorFromResponse(makeResponse(429, { headers }), {
        errorHeaders: ['x-empty'],
      });

      expect(error.data?.headers).toEqual({ 'x-empty': '' });
    });

    it('captures a multi-valued field comma-joined, as Headers.get returns it', async () => {
      const response = new Response(null, { status: 429 });
      response.headers.append('x-multi', 'one');
      response.headers.append('x-multi', 'two');

      const error = await httpErrorFromResponse(response, { errorHeaders: ['x-multi'] });

      expect(error.data?.headers).toEqual({ 'x-multi': 'one, two' });
    });

    it('never captures set-cookie, whatever the selector says', async () => {
      const error = await httpErrorFromResponse(makeResponse(429, { headers }), {
        errorHeaders: ['Set-Cookie', 'x-request-id'],
      });

      expect(error.data?.headers).toEqual({ 'x-request-id': 'req-7' });
      expect(JSON.stringify(error.data)).not.toContain('session=secret');
    });

    it('emits no headers key when set-cookie is the only selected header', async () => {
      const error = await httpErrorFromResponse(makeResponse(429, { headers }), {
        errorHeaders: ['set-cookie'],
      });

      expect(error.data).not.toHaveProperty('headers');
    });

    it('lets caller-supplied data.headers win on key collision', async () => {
      const error = await httpErrorFromResponse(makeResponse(429, { headers }), {
        errorHeaders: ['x-request-id'],
        data: { headers: { 'x-request-id': 'caller-owned' } },
      });

      expect(error.data?.headers).toEqual({ 'x-request-id': 'caller-owned' });
    });

    it('selects location on a redirect the caller chose to see', async () => {
      const error = await httpErrorFromResponse(
        makeResponse(302, { headers: { location: 'https://elsewhere.example/moved' } }),
        { errorHeaders: ['location'] },
      );

      expect(error.data?.headers).toEqual({ location: 'https://elsewhere.example/moved' });
    });
  });

  it('falls back to "Upstream" when no service or URL is available', async () => {
    const error = await httpErrorFromResponse(makeResponse(500));

    expect(error.message).toBe('Upstream returned HTTP 500.');
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('classifies an upstream 500 as ServiceUnavailable and leaves it retryable (#323)', async () => {
    const error = await httpErrorFromResponse(makeResponse(500), { service: 'NCBI' });

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).not.toHaveProperty('retryable');
  });

  it('marks an upstream 501 non-retryable while keeping it ServiceUnavailable (#323)', async () => {
    const error = await httpErrorFromResponse(makeResponse(501), { service: 'NCBI' });

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.retryable).toBe(false);
  });

  it('lets caller-supplied data override the 501 retryability default (#323)', async () => {
    const error = await httpErrorFromResponse(makeResponse(501), {
      data: { retryable: true },
    });

    expect(error.data?.retryable).toBe(true);
  });

  it('truncates large bodies to bodyLimit', async () => {
    const huge = 'x'.repeat(10_000);
    const response = makeResponse(500, { body: huge });

    const error = await httpErrorFromResponse(response, { bodyLimit: 50 });

    expect(typeof error.data?.body).toBe('string');
    const body = error.data?.body as string;
    expect(body.length).toBe(51); // 50 chars + ellipsis
    expect(body.endsWith('…')).toBe(true);
  });

  it('cancels an oversized streaming body and bounds multibyte capture by bytes', async () => {
    let cancelled = false;
    const encoded = new TextEncoder().encode('😀'.repeat(100));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded);
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 500 },
    );

    const error = await httpErrorFromResponse(response, { bodyLimit: 50 });
    const body = error.data?.body as string;
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(53);
    expect(body.endsWith('…')).toBe(true);
    expect(cancelled).toBe(true);
  });

  it('merges extra data fields', async () => {
    const error = await httpErrorFromResponse(makeResponse(404), {
      data: { endpoint: 'esearch', requestId: 'abc-123' },
    });

    expect(error.data).toMatchObject({
      status: 404,
      endpoint: 'esearch',
      requestId: 'abc-123',
    });
  });

  it('honours codeOverride for service-specific mappings', async () => {
    const error = await httpErrorFromResponse(makeResponse(404), {
      // Some upstreams use 404 for "DOI not in index" — caller can downgrade
      // to a structural ServiceUnavailable instead of NotFound.
      codeOverride: (status) => (status === 404 ? JsonRpcErrorCode.ServiceUnavailable : undefined),
    });

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('falls through to default mapping when codeOverride returns undefined', async () => {
    const error = await httpErrorFromResponse(makeResponse(429), {
      codeOverride: () => undefined,
    });

    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
  });

  it('attaches cause when provided', async () => {
    const original = new Error('socket hang up');
    const error = await httpErrorFromResponse(makeResponse(500), { cause: original });

    expect(error.cause).toBe(original);
  });

  it('returns InternalError fallback for non-error status codes', async () => {
    // Defensive: 1xx/2xx shouldn't reach this helper, but if they do
    // we get a sane code instead of `undefined`.
    const error = await httpErrorFromResponse(makeResponse(204));

    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
  });

  it('classifies a redirect as InvalidRequest rather than InternalError (#460)', async () => {
    // Reachable: a caller using `redirect: 'manual'` gets the 3xx back and maps it.
    const error = await httpErrorFromResponse(
      makeResponse(302, { headers: { location: 'https://elsewhere.example/moved' } }),
      { service: 'Example' },
    );

    expect(error.code).toBe(JsonRpcErrorCode.InvalidRequest);
    expect(error.data).toMatchObject({ status: 302, statusCode: 302 });
  });

  it('emits both status/body and legacy statusCode/responseBody with equal values (#279)', async () => {
    const response = makeResponse(500, { body: 'boom', url: 'https://api.example.com/x' });
    const error = await httpErrorFromResponse(response);
    const data = error.data as Record<string, unknown>;

    expect(data.status).toBe(500);
    expect(data.statusCode).toBe(500);
    expect(data.status).toBe(data.statusCode);
    expect(data.body).toBe('boom');
    expect(data.responseBody).toBe('boom');
    expect(data.body).toBe(data.responseBody);
  });

  it('omits both body and responseBody when captureBody is false (#279)', async () => {
    const error = await httpErrorFromResponse(makeResponse(500, { body: 'secret' }), {
      captureBody: false,
    });

    expect(error.data).not.toHaveProperty('body');
    expect(error.data).not.toHaveProperty('responseBody');
  });
});

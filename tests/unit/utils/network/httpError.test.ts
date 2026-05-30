/**
 * @fileoverview Unit tests for the HTTP error helpers.
 * @module tests/utils/network/httpError.test
 */

import { describe, expect, it } from 'vitest';

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { httpErrorFromResponse, httpStatusToErrorCode } from '@/utils/network/httpError.js';

describe('httpStatusToErrorCode', () => {
  it.each([
    [200, undefined],
    [301, undefined],
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
    [500, JsonRpcErrorCode.InternalError],
    [501, JsonRpcErrorCode.InternalError],
    [502, JsonRpcErrorCode.ServiceUnavailable],
    [503, JsonRpcErrorCode.ServiceUnavailable],
    [504, JsonRpcErrorCode.Timeout],
    [505, JsonRpcErrorCode.ServiceUnavailable],
    [599, JsonRpcErrorCode.ServiceUnavailable],
  ])('maps status %i to %s', (status, expected) => {
    expect(httpStatusToErrorCode(status)).toBe(expected);
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
      url: 'https://api.example.com/foo',
      status: 429,
      statusText: 'Too Many Requests',
      body: 'slow down',
      retryAfter: '30',
    });
  });

  it('uses the response host when service is omitted', async () => {
    const response = makeResponse(503, { url: 'https://api.example.com/foo' });

    const error = await httpErrorFromResponse(response);

    expect(error.message).toContain('api.example.com');
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('falls back to "Upstream" when no service or URL is available', async () => {
    const error = await httpErrorFromResponse(makeResponse(500));

    expect(error.message).toBe('Upstream returned HTTP 500.');
    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
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

  it('skips body capture when captureBody is false', async () => {
    const response = makeResponse(500, { body: 'secret' });

    const error = await httpErrorFromResponse(response, { captureBody: false });

    expect(error.data).not.toHaveProperty('body');
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
    // Defensive: 1xx/2xx/3xx shouldn't reach this helper, but if they do
    // we get a sane code instead of `undefined`.
    const error = await httpErrorFromResponse(makeResponse(204));

    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
  });
});

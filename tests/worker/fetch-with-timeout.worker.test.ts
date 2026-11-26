/**
 * @fileoverview Worker-runtime tests for `fetchWithTimeout`'s body-deadline
 * passthrough and redirect following. Runs under `tests/config/vitest.worker.ts`
 * (Cloudflare workerd pool). The passthrough hands back a reconstructed `Response`
 * and restores `url` / `redirected` onto it, and a followed redirect sets both on
 * the response its chain ends on, all of which is runtime-sensitive: workerd's
 * `Response` is a host object, so this suite pins that the response is built and
 * shaped there exactly as it is on Node and Bun. Deadline expiry itself is covered
 * on the Node lane against a real peer — erroring a response body stream inside
 * the workerd pool surfaces as an unhandled rejection regardless of the code under
 * test, so it cannot be asserted here.
 * @module tests/worker/fetch-with-timeout.worker.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchWithTimeout } from '../../src/utils/network/fetchWithTimeout.js';

const context = { requestId: 'worker-fetch', timestamp: '2026-01-01T00:00:00.000Z' };

describe('fetchWithTimeout under workerd', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves status, headers, url, and body through the deadline passthrough', async () => {
    const upstream = new Response('worker body', {
      status: 200,
      headers: { 'x-marker': 'kept' },
    });
    Object.defineProperty(upstream, 'url', {
      value: 'https://example.com/data',
      configurable: true,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(upstream);

    const response = await fetchWithTimeout('https://example.com/data', 1000, context);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-marker')).toBe('kept');
    expect(response.url).toBe('https://example.com/data');
    expect(response.redirected).toBe(false);
    expect(await response.text()).toBe('worker body');
  });

  it('streams a chunked body through the passthrough in order', async () => {
    const chunks = ['{"a":1', ',"b":2', '}'];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );

    const response = await fetchWithTimeout('https://example.com/data', 1000, context);

    expect(await response.json()).toEqual({ a: 1, b: 2 });
  });

  /** One redirect from `/start` to `location`, then `final()` for the next path. */
  function redirectOnce(location: string, final: () => Response) {
    return vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) =>
        new URL(String(input)).pathname === '/start'
          ? new Response(null, { status: 302, headers: { location } })
          : final(),
      );
  }

  it('follows a redirect under manual on every hop, reporting redirected and the final url', async () => {
    const fetchMock = redirectOnce('/end#frag', () => new Response('landed', { status: 200 }));

    const response = await fetchWithTimeout('https://example.com/start', 1000, context);

    expect(fetchMock.mock.calls.map(([, init]) => init?.redirect)).toEqual(['manual', 'manual']);
    expect(response.redirected).toBe(true);
    expect(response.url).toBe('https://example.com/end');
    expect(await response.text()).toBe('landed');
  });

  it('reports redirected and url on a null-body response a chain ends on', async () => {
    redirectOnce('/gone', () => new Response(null, { status: 204 }));

    const response = await fetchWithTimeout('https://example.com/start', 1000, context);

    expect(response.status).toBe(204);
    expect(response.redirected).toBe(true);
    expect(response.url).toBe('https://example.com/gone');
  });
});

/**
 * @fileoverview Tests for OTel metric recording in fetchWithTimeout.
 * Verifies that the `http.client.request.duration` histogram is recorded
 * in the `finally` block with correct attributes across success, timeout,
 * and network error scenarios.
 * @module tests/unit/utils/network/fetchWithTimeout.metrics.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/utils/internal/logger.js';
import { fetchWithTimeout, initHttpClientMetrics } from '@/utils/network/fetchWithTimeout.js';

const { createHistogramMock, mockRecord } = vi.hoisted(() => ({
  createHistogramMock: vi.fn(),
  mockRecord: vi.fn(),
}));

createHistogramMock.mockReturnValue({ record: mockRecord });

vi.mock('@/utils/telemetry/metrics.js', () => ({
  createHistogram: createHistogramMock,
}));

describe('fetchWithTimeout – http.client.request.duration histogram', () => {
  const context = {
    requestId: 'metrics-ctx-1',
    timestamp: new Date().toISOString(),
  };

  beforeEach(() => {
    mockRecord.mockClear();
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the correct metric name and unit via createHistogram', () => {
    initHttpClientMetrics();

    expect(createHistogramMock).toHaveBeenCalledWith(
      'http.client.request.duration',
      'Duration of outbound HTTP requests',
      's',
    );
  });

  it('records duration with method, host, and status code on 2xx success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await fetchWithTimeout('https://api.example.com/data', 5000, context);

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [durationS, attrs] = mockRecord.mock.calls[0]!;
    expect(typeof durationS).toBe('number');
    expect(durationS).toBeGreaterThanOrEqual(0);
    expect(attrs).toEqual({
      'http.request.method': 'GET',
      'server.address': 'api.example.com',
      'http.response.status_code': 200,
    });
  });

  it('records duration with explicit POST method', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('created', { status: 201 }));

    await fetchWithTimeout('https://api.example.com/items', 5000, context, {
      method: 'POST',
      body: '{}',
    });

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [, attrs] = mockRecord.mock.calls[0]!;
    expect(attrs['http.request.method']).toBe('POST');
    expect(attrs['http.response.status_code']).toBe(201);
  });

  it('records duration with status code on non-2xx HTTP error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('bad', { status: 503, statusText: 'Service Unavailable' }),
    );

    await expect(fetchWithTimeout('https://api.example.com/fail', 5000, context)).rejects.toThrow();

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [durationS, attrs] = mockRecord.mock.calls[0]!;
    expect(typeof durationS).toBe('number');
    expect(attrs).toEqual({
      'http.request.method': 'GET',
      'server.address': 'api.example.com',
      'http.response.status_code': 503,
    });
  });

  it('records duration without status code on timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    await expect(fetchWithTimeout('https://slow.example.com/wait', 5, context)).rejects.toThrow();

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [durationS, attrs] = mockRecord.mock.calls[0]!;
    expect(typeof durationS).toBe('number');
    expect(attrs).toEqual({
      'http.request.method': 'GET',
      'server.address': 'slow.example.com',
    });
    expect(attrs).not.toHaveProperty('http.response.status_code');
  });

  it('records duration without status code on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(fetchWithTimeout('https://down.example.com/api', 5000, context)).rejects.toThrow();

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [durationS, attrs] = mockRecord.mock.calls[0]!;
    expect(typeof durationS).toBe('number');
    expect(durationS).toBeGreaterThanOrEqual(0);
    expect(attrs).toEqual({
      'http.request.method': 'GET',
      'server.address': 'down.example.com',
    });
  });

  it('records duration in seconds (not milliseconds)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await fetchWithTimeout('https://example.com', 5000, context);

    const [durationS] = mockRecord.mock.calls[0]!;
    // Duration should be well under 1 second for a mocked fetch
    expect(durationS).toBeLessThan(1);
  });
});

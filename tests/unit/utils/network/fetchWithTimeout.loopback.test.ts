/**
 * @fileoverview `fetchWithTimeout` against real loopback peers: the request is
 * named by its origin in every message and record the framework writes (#626),
 * including the tool envelope a failed call becomes and a runtime rejection that
 * quotes the URL itself; and a refused connection keeps its transport code
 * through the network-error wrapper and `withRetry` (#615). A mocked `fetch`
 * cannot produce the runtime's own rejection shapes, which differ between Bun
 * and Node.
 * @module tests/utils/network/fetchWithTimeout.loopback.test
 */
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';

import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { type AnyToolDefinition, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { createToolHandler } from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { createInMemoryStorage } from '@/testing/index.js';
import { JsonRpcErrorCode, type McpError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { logger } from '@/utils/internal/logger.js';
import { fetchWithTimeout } from '@/utils/network/fetchWithTimeout.js';
import { withRetry } from '@/utils/network/retry.js';
import { makeServerContext } from '../../../helpers/server-context.js';

const KEY_PATH = '/sk-test-0000/reverse?lat=1&lon=2';
const PATH_PARTS = ['sk-test-0000', '/reverse', 'lat=1', 'lon=2'];
const context = { requestId: 'loopback', timestamp: new Date().toISOString() };

let httpServer: Server;
let httpOrigin: string;
let lastRequestUrl: string | undefined;
let garbageServer: NetServer;
let garbageOrigin: string;

async function listen(server: Server | NetServer): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  return `http://127.0.0.1:${address.port}`;
}

beforeAll(async () => {
  httpServer = createServer((req, res) => {
    lastRequestUrl = req.url;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  httpOrigin = await listen(httpServer);
  // Answers every request with bytes that are not HTTP.
  garbageServer = createNetServer((socket) => {
    socket.once('data', () => socket.end('NOT HTTP AT ALL\r\n\r\n'));
  });
  garbageOrigin = await listen(garbageServer);
});

afterAll(async () => {
  await Promise.all(
    [httpServer, garbageServer].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

const LEVELS = ['debug', 'info', 'notice', 'warning', 'error'] as const;

beforeEach(() => {
  lastRequestUrl = undefined;
  for (const level of LEVELS) vi.spyOn(logger, level).mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every record the logger received, serialized — message and context alike. */
function everyRecord(): string {
  return JSON.stringify(
    LEVELS.flatMap((level): unknown[][] => vi.mocked(logger[level]).mock.calls),
  );
}

function expectNoPath(text: string): void {
  for (const part of PATH_PARTS) expect(text).not.toContain(part);
}

describe('fetchWithTimeout names a request by its origin (#626)', () => {
  it('throws and logs the reproduction without the path, sending the full path upstream', async () => {
    const error = (await fetchWithTimeout(`${httpOrigin}${KEY_PATH}`, 30_000, context).catch(
      (e: unknown) => e,
    )) as McpError;

    expect(error.message).toBe(`Fetch failed for ${httpOrigin}/…?…. Status: 404`);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({ status: 404, statusCode: 404, body: 'not found' });
    expectNoPath(everyRecord());
    expect(lastRequestUrl).toBe(KEY_PATH);
  });

  it('keeps the path out of the tool envelope and every record a failed call writes', async () => {
    const def = tool('reverse_geocode', {
      description: 'Reverse-geocodes a point.',
      input: z.object({}),
      output: z.object({ ok: z.boolean().describe('Never returned.') }),
      async handler(_input, ctx) {
        await fetchWithTimeout(`${httpOrigin}${KEY_PATH}`, 30_000, ctx);
        return { ok: true };
      },
    });
    const handler = createToolHandler(
      def as AnyToolDefinition,
      { logger: logger as never, storage: createInMemoryStorage() },
      {},
    );

    const result = (await handler({}, makeServerContext())) as CallToolResult;

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    const envelope = (result.structuredContent as { error: { code: number; message: string } })
      .error;
    expect(text).toContain(`Error: Fetch failed for ${httpOrigin}/…?…. Status: 404`);
    expect(envelope.message).toBe(`Fetch failed for ${httpOrigin}/…?…. Status: 404`);
    expect(envelope.code).toBe(JsonRpcErrorCode.NotFound);
    expectNoPath(text);
    expectNoPath(JSON.stringify(result.structuredContent));
    expectNoPath(everyRecord());
  });

  it('keeps the path out of a malformed-response failure, whatever the runtime quotes', async () => {
    // Bun rejects with `Malformed_HTTP_Response fetching "<full URL>"`; Node with
    // `fetch failed` over a parser error. Neither may carry the path onward.
    const error = (await fetchWithTimeout(`${garbageOrigin}${KEY_PATH}`, 30_000, context).catch(
      (e: unknown) => e,
    )) as McpError;

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message.startsWith(`Network error during fetch GET ${garbageOrigin}/…?…: `)).toBe(
      true,
    );
    /**
     * Bun 1.4 rejects this response with the URL quoted whole, the case the
     * redaction exists for; pin its code so the test keeps reaching that rejection.
     */
    if (typeof process.versions.bun === 'string') {
      expect((error.cause as { code?: unknown } | undefined)?.code).toBe('Malformed_HTTP_Response');
    }
    expectNoPath(error.message);
    expectNoPath(everyRecord());
  });
});

describe('a refused connection keeps its transport code (#615)', () => {
  /**
   * The runtimes disagree on where the code lives: Bun sets it on the fetch
   * rejection itself, Node's undici on the `cause` of `TypeError: fetch failed`.
   */
  const isBun = typeof process.versions.bun === 'string';
  const refusedCode = isBun ? 'ConnectionRefused' : 'ECONNREFUSED';
  const refusedMessage = isBun
    ? 'Unable to connect. Is the computer able to access the url?'
    : 'fetch failed';

  let closedOrigin: string;

  beforeAll(async () => {
    // A port that was just bound and released — nothing listens on it.
    const placeholder = createServer();
    closedOrigin = await listen(placeholder);
    await new Promise<void>((resolve) => placeholder.close(() => resolve()));
  });

  /** The `causeChain` field of every record that carries one. */
  function loggedChains(level: (typeof LEVELS)[number]): Array<Array<Record<string, unknown>>> {
    return vi
      .mocked(logger[level])
      .mock.calls.map((call) => (call[1] as { extra?: { causeChain?: [] } })?.extra?.causeChain)
      .filter((chain) => chain !== undefined);
  }

  it('chains the rejection and logs its code on the network-error and retry records', async () => {
    const error = (await withRetry(
      () => fetchWithTimeout(`${closedOrigin}/sk-test-0000/x?key=1`, 5000, context),
      { operation: 'demo-fetch', context, baseDelayMs: 5, jitter: 0, maxRetries: 1 },
    ).catch((e: unknown) => e)) as McpError;

    // Exhausted error → the wrapper → the runtime's rejection.
    const wrapper = error.cause as McpError;
    expect(wrapper.message).toBe(
      `Network error during fetch GET ${closedOrigin}/…?…: ${refusedMessage}`,
    );
    expect(wrapper.cause).toBeInstanceOf(TypeError);

    const [networkRecord] = loggedChains('error');
    const [retryRecord] = loggedChains('debug');
    for (const chain of [networkRecord, retryRecord]) {
      expect(chain?.map((node) => node.code)).toContain(refusedCode);
      for (const node of chain ?? []) {
        expect(Object.keys(node).every((key) => ['name', 'message', 'code'].includes(key))).toBe(
          true,
        );
      }
    }
    // Bun's rejection holds the full URL in `path`; nothing carries it onward.
    expectNoPath(everyRecord());
  });

  it("logs a raw fetch rejection's code when withRetry retries it directly", async () => {
    await withRetry(() => fetch(`${closedOrigin}/sk-test-0000/x?key=1`), {
      operation: 'raw-fetch',
      context,
      baseDelayMs: 5,
      jitter: 0,
      maxRetries: 1,
    }).catch(() => undefined);

    const [retryRecord] = loggedChains('debug');
    expect(retryRecord?.at(-1)).toEqual({
      name: isBun ? 'TypeError' : 'Error',
      message: isBun ? refusedMessage : expect.stringContaining('ECONNREFUSED'),
      code: refusedCode,
    });
    expectNoPath(JSON.stringify(retryRecord));
  });

  it('leaves the tool error envelope for a failed network call unchanged', async () => {
    const def = tool('reverse_geocode', {
      description: 'Reverse-geocodes a point.',
      input: z.object({}),
      output: z.object({ ok: z.boolean().describe('Never returned.') }),
      async handler(_input, ctx) {
        await fetchWithTimeout(`${closedOrigin}/x`, 5000, ctx);
        return { ok: true };
      },
    });
    const handler = createToolHandler(
      def as AnyToolDefinition,
      { logger: logger as never, storage: createInMemoryStorage() },
      {},
    );

    const result = (await handler({}, makeServerContext())) as CallToolResult;

    const message = `Network error during fetch GET ${closedOrigin}/…: ${refusedMessage}`;
    expect(result.structuredContent).toEqual({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message,
        data: {
          originalErrorName: 'TypeError',
          errorSource: 'FetchNetworkErrorWrapper',
          requestId: expect.any(String),
        },
      },
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text.startsWith(`Error: ${message}`)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /causeChain|rootCause|ECONNREFUSED|ConnectionRefused/,
    );
  });

  // #644 — the same failure through `tryCatch` publishes nothing the direct throw does not.
  it('rethrows it through tryCatch with no rootCause, logging the code on the chain', async () => {
    const error = (await ErrorHandler.tryCatch(
      () => fetchWithTimeout(`${closedOrigin}/x`, 5000, context),
      { operation: 'reverseGeocode', context },
    ).catch((e: unknown) => e)) as McpError;

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toEqual({
      errorSource: 'FetchNetworkErrorWrapper',
      originalErrorName: 'McpError',
      originalMessage: `Network error during fetch GET ${closedOrigin}/…: ${refusedMessage}`,
    });
    expect(JSON.stringify(error.data)).not.toMatch(/rootCause|ECONNREFUSED|ConnectionRefused/);

    const record = vi
      .mocked(logger.error)
      .mock.calls.find(([message]) => String(message).startsWith('Error in reverseGeocode'))?.[1] as
      | { extra: { errorData: { causeChain: Array<{ code?: string }>; rootCause: unknown } } }
      | undefined;
    expect(record?.extra.errorData.causeChain.at(-1)?.code).toBe(refusedCode);
    expect(record?.extra.errorData.rootCause).toEqual(
      expect.objectContaining({ name: expect.any(String) }),
    );
  });
});

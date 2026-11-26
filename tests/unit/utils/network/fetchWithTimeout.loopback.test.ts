/**
 * @fileoverview `fetchWithTimeout` against real loopback peers: the request is
 * named by its origin in every message and record the framework writes (#626),
 * including the tool envelope a failed call becomes and a runtime rejection that
 * quotes the URL itself; a refused connection keeps its transport code through
 * the network-error wrapper and `withRetry` (#615); a timeout or network failure
 * is recorded at `info`, leaving the `error` record to whoever lets it escape
 * (#864); a caller deadline reports its own reason (#878); and redirects are
 * followed by the helper itself, so both runtimes answer a chain alike (#883). A
 * mocked `fetch` cannot produce the runtime's own rejection shapes, which differ
 * between Bun and Node.
 * @module tests/utils/network/fetchWithTimeout.loopback.test
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';

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
/** Accepts connections and never answers; `onSilentConnection` fires on each. */
let silentServer: NetServer;
let silentOrigin: string;
let onSilentConnection: (() => void) | undefined;
const silentSockets = new Set<Socket>();

async function listen(server: Server | NetServer): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  return `http://127.0.0.1:${address.port}`;
}

beforeAll(async () => {
  httpServer = createServer((req, res) => {
    lastRequestUrl = req.url;
    if (req.url?.startsWith('/reset/')) {
      // Part of a 2xx body, then the connection drops — after the bytes flush,
      // so the headers always land first.
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
      res.write('{"partial":"twenty-b', () => req.socket.destroy());
      return;
    }
    if (req.url?.startsWith('/stall')) {
      // Headers and a first chunk, then a body that never finishes.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"partial":');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  httpOrigin = await listen(httpServer);
  // Answers every request with bytes that are not HTTP.
  garbageServer = createNetServer((socket) => {
    socket.once('data', () => socket.end('NOT HTTP AT ALL\r\n\r\n'));
  });
  garbageOrigin = await listen(garbageServer);
  silentServer = createNetServer((socket) => {
    silentSockets.add(socket);
    socket.on('close', () => silentSockets.delete(socket));
    onSilentConnection?.();
  });
  silentOrigin = await listen(silentServer);
});

afterAll(async () => {
  for (const socket of silentSockets) socket.destroy();
  httpServer.closeAllConnections();
  await Promise.all(
    [httpServer, garbageServer, silentServer].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

const LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'crit', 'alert', 'emerg'] as const;

beforeEach(() => {
  lastRequestUrl = undefined;
  onSilentConnection = undefined;
  for (const level of LEVELS) vi.spyOn(logger, level).mockImplementation(() => {});
});

/** Messages of every record at `warning` or above. */
function messagesAtWarningOrAbove(): string[] {
  return (['warning', 'error', 'crit', 'alert', 'emerg'] as const).flatMap((level) =>
    vi.mocked(logger[level]).mock.calls.map(([message]) => String(message)),
  );
}

/** Messages of every record at `level`. */
function messagesAt(level: (typeof LEVELS)[number]): string[] {
  return vi.mocked(logger[level]).mock.calls.map(([message]) => String(message));
}

/** A tool whose handler is `run`, wrapped by the real handler factory. */
function toolRunning(
  name: string,
  run: (ctx: Parameters<AnyToolDefinition['handler']>[1]) => Promise<unknown>,
) {
  const def = tool(name, {
    description: 'Calls an upstream over loopback.',
    input: z.object({}),
    output: z.object({ ok: z.boolean().describe('Whether the call completed.') }),
    async handler(_input, ctx) {
      await run(ctx);
      return { ok: true };
    },
  });
  return createToolHandler(
    def as AnyToolDefinition,
    { logger: logger as never, storage: createInMemoryStorage() },
    {},
  );
}

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

describe('a 2xx body that fails mid-read reaches the tool envelope as a network failure (#819)', () => {
  it('answers ServiceUnavailable with the wrapper data, naming the request by origin', async () => {
    // Node rejects the read with `TypeError: terminated`, Bun with an
    // `ECONNRESET`-coded TypeError; read the shape off a raw fetch.
    const raw = (await (await fetch(`${httpOrigin}/reset/x`)).text().catch((e: unknown) => e)) as {
      message: string;
      name: string;
    };
    const def = tool('reverse_geocode', {
      description: 'Reverse-geocodes a point.',
      input: z.object({}),
      output: z.object({ ok: z.boolean().describe('Never returned.') }),
      async handler(_input, ctx) {
        const response = await fetchWithTimeout(`${httpOrigin}/reset${KEY_PATH}`, 30_000, ctx);
        await response.text();
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
    expect(result.structuredContent).toEqual({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: `Network error during fetch GET ${httpOrigin}/…?…: ${raw.message}`,
        data: {
          originalErrorName: raw.name,
          errorSource: 'FetchNetworkErrorWrapper',
          requestId: expect.any(String),
        },
      },
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text.startsWith(`Error: Network error during fetch GET ${httpOrigin}/…?…: `)).toBe(true);
    expectNoPath(text);
    expectNoPath(JSON.stringify(result.structuredContent));
    expectNoPath(everyRecord());
    expect(lastRequestUrl).toBe(`/reset${KEY_PATH}`);
  });
});

describe('a refused connection keeps its transport code (#615)', () => {
  /**
   * The runtimes disagree on where the code lives: Bun sets it on the fetch
   * rejection itself, Node's undici on the `cause` of `TypeError: fetch failed`.
   * Bun's code and message also vary by release (`ConnectionRefused` before
   * 1.4.3, `ECONNREFUSED` and an `ECONNREFUSED: ` message prefix from it), so the
   * expected values are read off a raw refused fetch.
   */
  const isBun = typeof process.versions.bun === 'string';
  let refusedCode: string;
  let refusedMessage: string;

  let closedOrigin: string;

  beforeAll(async () => {
    // A port that was just bound and released — nothing listens on it.
    const placeholder = createServer();
    closedOrigin = await listen(placeholder);
    await new Promise<void>((resolve) => placeholder.close(() => resolve()));

    const rejection = (await fetch(closedOrigin).catch((e: unknown) => e)) as {
      message: string;
      code?: unknown;
      cause?: { code?: unknown };
    };
    const code = isBun ? rejection.code : rejection.cause?.code;
    if (typeof code !== 'string') throw new Error('a refused fetch carried no transport code');
    refusedCode = code;
    refusedMessage = rejection.message;
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

    const [networkRecord] = loggedChains('info');
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
    const handler = toolRunning('reverse_geocode', (ctx) =>
      fetchWithTimeout(`${closedOrigin}/x`, 5000, ctx),
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
    // The runtime's own message may name the code; nothing else may carry it.
    expect(JSON.stringify(result).replaceAll(refusedMessage, '')).not.toMatch(
      /causeChain|rootCause|ECONNREFUSED|ConnectionRefused/,
    );
  });

  it('records the escaped failure at error once, from the handler factory, with its causeChain (#864)', async () => {
    const handler = toolRunning('reverse_geocode', (ctx) =>
      fetchWithTimeout(`${closedOrigin}/x`, 5000, ctx),
    );

    await handler({}, makeServerContext());

    const message = `Network error during fetch GET ${closedOrigin}/…: ${refusedMessage}`;
    // The helper's own record keeps its chain, below warning.
    expect(messagesAt('info')).toContain(message);
    expect(loggedChains('info')[0]?.map((node) => node.code)).toContain(refusedCode);
    expect(messagesAtWarningOrAbove()).toEqual([`Error in tool:reverse_geocode: ${message}`]);
    const [, boundaryContext] = vi.mocked(logger.error).mock.calls[0] ?? [];
    const chain = (boundaryContext as { extra?: { errorData?: { causeChain?: [] } } } | undefined)
      ?.extra?.errorData?.causeChain as Array<{ code?: string }> | undefined;
    expect(chain?.map((node) => node.code)).toContain(refusedCode);
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
    expect(JSON.stringify(error.data).replaceAll(refusedMessage, '')).not.toMatch(
      /rootCause|ECONNREFUSED|ConnectionRefused/,
    );

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

/**
 * The helper throws a typed timeout and leaves its severity to whoever handles
 * it (#864): its own record is at `info`, and an escaped one gets the handler
 * factory's `error` record.
 */
describe('a timeout through the tool boundary (#864)', () => {
  const TIMEOUT_MS = 200;

  it('records an escaped timeout at error once, from the handler factory', async () => {
    const handler = toolRunning('stalled_read', async (ctx) => {
      const response = await fetchWithTimeout(`${httpOrigin}/stall`, TIMEOUT_MS, ctx);
      await response.text();
    });

    const result = (await handler({}, makeServerContext())) as CallToolResult;

    const thrown = `fetch GET ${httpOrigin}/… timed out.`;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: JsonRpcErrorCode.Timeout,
        message: thrown,
        data: { errorSource: 'FetchTimeout', requestId: expect.any(String) },
      },
    });
    expect(messagesAt('info')).toContain(
      `fetch GET ${httpOrigin}/… timed out after ${TIMEOUT_MS}ms.`,
    );
    expect(messagesAtWarningOrAbove()).toEqual([`Error in tool:stalled_read: ${thrown}`]);
  });

  it('writes nothing at warning or above when the handler keeps a prefix and succeeds', async () => {
    let chunks = 0;
    const handler = toolRunning('prefix_read', async (ctx) => {
      const response = await fetchWithTimeout(`${httpOrigin}/stall`, TIMEOUT_MS, ctx);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
          chunks++;
        }
      } catch {
        // The deadline cut the stream; the chunks read so far are the result.
      }
    });

    const result = (await handler({}, makeServerContext())) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(chunks).toBeGreaterThan(0);
    expect(messagesAt('info')).toContain(
      `fetch GET ${httpOrigin}/… timed out after ${TIMEOUT_MS}ms.`,
    );
    expect(messagesAtWarningOrAbove()).toEqual([]);
  });
});

/** A caller deadline reports the reason it fired with, not "the caller's signal" (#878). */
describe("a caller deadline's own reason (#878)", () => {
  const BUDGET = 'Upstream requests for this call ran past the 50 s budget.';

  it('throws Timeout carrying the reason, with the same text on its record', async () => {
    const budget = new AbortController();
    // Abort once the request reaches the peer, which never answers.
    onSilentConnection = () => budget.abort(new DOMException(BUDGET, 'TimeoutError'));

    const error = (await fetchWithTimeout(`${silentOrigin}/search`, 30_000, context, {
      signal: budget.signal,
    }).catch((e: unknown) => e)) as McpError;

    const message = `fetch GET ${silentOrigin}/…: ${BUDGET}`;
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toBe(message);
    expect(error.data).toEqual({ errorSource: 'FetchSignalTimeout' });
    expect(messagesAt('info')).toContain(message);
    expect(messagesAtWarningOrAbove()).toEqual([]);
    expect(everyRecord()).not.toContain("caller's signal");
  });
});

/**
 * Redirects against real peers (#883). Two loopback servers, one port each, are
 * two origins, which a cross-origin hop needs. `rejectPrivateIPs` refuses a
 * loopback target before any request, so the guarded loop's hop rules are pinned
 * in fetchWithTimeout.test.ts against a stubbed `fetch`.
 */
describe('redirects against real peers (#883)', () => {
  interface Seen {
    body: string;
    headers: IncomingHttpHeaders;
    method: string;
    origin: 'a' | 'b';
    path: string;
  }
  const seen: Seen[] = [];
  let peerA: Server;
  let peerB: Server;
  let originA: string;
  let originB: string;

  /**
   * `/r/<status>?to=<location>` answers that 3xx, `/loop` redirects to itself,
   * `/chain/<n>` redirects `n` more times, `/no-content` is a 204, and every
   * other path a 200. Each 3xx carries a body, so a followed hop leaves one to
   * discard.
   */
  function peer(origin: 'a' | 'b'): Server {
    return createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://peer');
        seen.push({
          origin,
          path: req.url ?? '',
          method: req.method ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        });
        const redirect = (status: number, location: string) => {
          res.writeHead(status, { location, 'content-type': 'text/plain' });
          res.end('moved');
        };
        const status = /^\/r\/(\d{3})$/.exec(url.pathname)?.[1];
        const left = /^\/chain\/(\d+)$/.exec(url.pathname)?.[1];
        if (status) return redirect(Number(status), url.searchParams.get('to') ?? '');
        if (url.pathname === '/loop') return redirect(302, '/loop');
        if (left && Number(left) > 0) return redirect(302, `/chain/${Number(left) - 1}`);
        if (url.pathname === '/no-content') {
          res.writeHead(204);
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`landed on ${origin}`);
      });
    });
  }

  /** `origin` + `/r/<status>`, redirecting to `to`. */
  const via = (origin: string, status: number, to: string) =>
    `${origin}/r/${status}?to=${encodeURIComponent(to)}`;

  // Retries allowed, so a single request shows a failure withRetry does not repeat.
  const retryOptions = { maxRetries: 3, baseDelayMs: 1, jitter: 0 };

  const streamOf = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });

  beforeAll(async () => {
    peerA = peer('a');
    peerB = peer('b');
    originA = await listen(peerA);
    originB = await listen(peerB);
  });

  afterAll(async () => {
    await Promise.all(
      [peerA, peerB].map((server) => {
        server.closeAllConnections();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      }),
    );
  });

  beforeEach(() => {
    seen.length = 0;
  });

  it('follows a relative Location containing :// to its 200 in 2 requests', async () => {
    const response = await fetchWithTimeout(
      via(originA, 301, '/next/http://example.org/'),
      30_000,
      context,
    );

    expect(response.status).toBe(200);
    expect(response.redirected).toBe(true);
    expect(response.url).toBe(`${originA}/next/http://example.org/`);
    expect(await response.text()).toBe('landed on a');
    expect(seen.map((request) => request.path)).toEqual([
      `/r/301?to=${encodeURIComponent('/next/http://example.org/')}`,
      '/next/http://example.org/',
    ]);
  });

  it('follows a 127-hop chain', async () => {
    const response = await fetchWithTimeout(`${originA}/chain/127`, 30_000, context);

    expect(await response.text()).toBe('landed on a');
    expect(response.url).toBe(`${originA}/chain/0`);
    expect(seen).toHaveLength(128);
  });

  it('fails a loop after 128 requests as too_many_redirects, with no second attempt', async () => {
    const error = (await withRetry(
      () => fetchWithTimeout(`${originA}/loop`, 30_000, context),
      retryOptions,
    ).catch((e: unknown) => e)) as McpError;

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ reason: 'too_many_redirects', maxRedirects: 127 });
    expect(seen).toHaveLength(128);
    expect(messagesAtWarningOrAbove()).toEqual([]);
  });

  it('refuses an ftp: Location as invalid_url after one request, not retried', async () => {
    const error = (await withRetry(
      () => fetchWithTimeout(via(originA, 302, 'ftp://example.org/x'), 30_000, context),
      retryOptions,
    ).catch((e: unknown) => e)) as McpError;

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ reason: 'invalid_url' });
    expect(seen).toHaveLength(1);
  });

  it("fails redirect: 'error' on a 307 as InvalidRequest after one request, not retried", async () => {
    const error = (await withRetry(
      () => fetchWithTimeout(via(originA, 307, '/next'), 30_000, context, { redirect: 'error' }),
      retryOptions,
    ).catch((e: unknown) => e)) as McpError;

    expect(error.code).toBe(JsonRpcErrorCode.InvalidRequest);
    expect(error.data).toMatchObject({ status: 307, errorSource: 'FetchHttpError' });
    expect(seen).toHaveLength(1);
  });

  it('fails a 307 for a stream body as InvalidRequest after one request, not retried', async () => {
    const error = (await withRetry(
      () =>
        fetchWithTimeout(via(originA, 307, '/next'), 30_000, context, {
          method: 'POST',
          body: streamOf('payload'),
          duplex: 'half',
        }),
      retryOptions,
    ).catch((e: unknown) => e)) as McpError;

    expect(error.code).toBe(JsonRpcErrorCode.InvalidRequest);
    expect(error.data).toMatchObject({ status: 307, errorSource: 'FetchHttpError' });
    expect(seen.map((request) => [request.method, request.body])).toEqual([['POST', 'payload']]);
  });

  it('follows a 303 for a stream body as a bodiless GET', async () => {
    const response = await fetchWithTimeout(via(originA, 303, '/next'), 30_000, context, {
      method: 'POST',
      body: streamOf('payload'),
      duplex: 'half',
    });

    expect(await response.text()).toBe('landed on a');
    expect(seen.map((request) => [request.method, request.body])).toEqual([
      ['POST', 'payload'],
      ['GET', ''],
    ]);
  });

  /** What each followed hop sends, against what native following sends on both runtimes. */
  describe('each followed hop', () => {
    const headers = {
      authorization: 'Bearer token-0000',
      cookie: 'sid=1',
      'proxy-authorization': 'Basic cHJveHk=',
      'content-type': 'text/plain',
      'content-language': 'en',
      'content-location': '/payload',
      'x-custom': 'kept',
    };
    const BODY_HEADERS = ['content-type', 'content-language', 'content-location'];
    const CREDENTIALS = ['authorization', 'cookie', 'proxy-authorization'];
    const present = (request: Seen | undefined, names: string[]) =>
      names.filter((name) => request?.headers[name] !== undefined);

    async function chain(url: string, method: string): Promise<Seen[]> {
      const response = await fetchWithTimeout(url, 30_000, context, {
        method,
        headers,
        body: 'payload',
      });
      await response.text();
      return seen;
    }

    it.each([
      [301, 'POST'],
      [302, 'POST'],
      [303, 'PUT'],
    ])(
      'continues a %d for a %s as a GET without the body or its headers',
      async (status, method) => {
        const [first, second] = await chain(via(originA, status, '/next'), method);

        expect(first).toMatchObject({ method, body: 'payload' });
        expect(second).toMatchObject({ method: 'GET', body: '', path: '/next' });
        expect(present(second, BODY_HEADERS)).toEqual([]);
        expect(second?.headers['x-custom']).toBe('kept');
        expect(present(second, CREDENTIALS)).toEqual(CREDENTIALS);
      },
    );

    it.each([
      [307, 'POST'],
      [308, 'PUT'],
    ])('keeps the method, body, and headers of a %d for a %s', async (status, method) => {
      const [, second] = await chain(via(originA, status, '/next'), method);

      expect(second).toMatchObject({ method, body: 'payload', path: '/next' });
      expect(present(second, BODY_HEADERS)).toEqual(BODY_HEADERS);
      expect(present(second, CREDENTIALS)).toEqual(CREDENTIALS);
    });

    it('drops the credentials on a hop to another origin, keeping the rest', async () => {
      const [, second] = await chain(via(originA, 307, `${originB}/next`), 'POST');

      expect(second).toMatchObject({ origin: 'b', method: 'POST', body: 'payload' });
      expect(present(second, CREDENTIALS)).toEqual([]);
      expect(second?.headers['x-custom']).toBe('kept');
      expect(second?.headers['content-type']).toBe('text/plain');
    });

    // A short deadline: a GET still claiming the old body's length would wait on bytes never sent.
    it('drops a caller-set Content-Length with the body', async () => {
      const response = await fetchWithTimeout(via(originA, 301, '/next'), 5000, context, {
        method: 'POST',
        headers: { 'content-length': '7' },
        body: 'payload',
      });
      await response.text();

      expect(seen.map((request) => [request.method, request.headers['content-length']])).toEqual([
        ['POST', '7'],
        ['GET', undefined],
      ]);
    });

    it('sends the new origin its own Host in place of a caller-set one', async () => {
      const response = await fetchWithTimeout(via(originA, 307, `${originB}/next`), 5000, context, {
        method: 'POST',
        headers: { host: new URL(originA).host },
        body: 'payload',
      });
      await response.text();

      expect(seen.map((request) => [request.origin, request.headers.host])).toEqual([
        ['a', new URL(originA).host],
        ['b', new URL(originB).host],
      ]);
    });

    it('keeps them dropped for the rest of the chain, back on the first origin included', async () => {
      const requests = await chain(via(originA, 307, via(originB, 307, `${originA}/back`)), 'POST');

      expect(requests.map((request) => request.origin)).toEqual(['a', 'b', 'a']);
      expect(present(requests[0], CREDENTIALS)).toEqual(CREDENTIALS);
      expect(present(requests[2], CREDENTIALS)).toEqual([]);
      expect(requests[2]?.headers['x-custom']).toBe('kept');
    });
  });

  it.each([
    ['a final 204', 'GET', '/no-content'],
    ['a final HEAD', 'HEAD', '/landing'],
  ])('reports redirected and url on %s', async (_label, method, path) => {
    const response = await fetchWithTimeout(via(originA, 302, `${path}#frag`), 30_000, context, {
      method,
    });

    expect(response.redirected).toBe(true);
    // `Response.url` never carries a fragment.
    expect(response.url).toBe(`${originA}${path}`);
    expect(seen).toHaveLength(2);
  });

  it('throws ServiceUnavailable for an unparseable Location, as under the guard (#647)', async () => {
    const error = (await fetchWithTimeout(
      via(originA, 302, 'http://127.0.0.1:99999/'),
      30_000,
      context,
    ).catch((e: unknown) => e)) as McpError;

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ errorSource: 'FetchNetworkErrorWrapper' });
    expect(seen).toHaveLength(1);
  });
});

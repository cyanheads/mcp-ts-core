/**
 * @fileoverview Verifies that `fetchWithTimeout`'s `timeoutMs` bounds the whole
 * exchange — headers *and* body — against a real `node:http` peer, and how a
 * failure after the headers arrive is classified: a non-2xx body capture cut
 * short, and a 2xx body that fails mid-stream. Bun.serve is deliberately
 * avoided: its URL normalization masks a class of request bugs.
 * @module tests/utils/network/fetchWithTimeout.bodyDeadline.test
 */
import { createServer, type Server, STATUS_CODES } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonRpcErrorCode, McpError } from '../../../../src/types-global/errors.js';
import { serverOnlyFields } from '../../../../src/utils/internal/error-handler/helpers.js';
import { logger } from '../../../../src/utils/internal/logger.js';
import { fetchWithTimeout } from '../../../../src/utils/network/fetchWithTimeout.js';
import { withRetry } from '../../../../src/utils/network/retry.js';

/**
 * Timing budget. The deadline is 250ms and every wait that must outlast it is 4×
 * that. Waits are lower bounds — a starved event loop in a saturated worker pool
 * only ever delays them — and a stalled body is compared against "did the
 * deadline fire at all", never against a tight arrival window.
 */
const DEADLINE_MS = 250;
const PAST_DEADLINE_MS = 1000;
/**
 * The deadline for exchanges that must complete. It still has to cover the
 * header phase, which a saturated host can stretch past 250ms on a cold
 * request. The odd value lets {@link trackDeadlineTimer} pick its timer out.
 */
const UNREACHED_DEADLINE_MS = 9_876;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const errorStall = req.url?.match(/^\/error-stall\/(\d{3})$/);
    if (errorStall) {
      const status = Number(errorStall[1]);
      res.writeHead(status, {
        'content-type': 'text/plain',
        ...(status === 429 && { 'retry-after': '7' }),
      });
      // A non-2xx whose diagnostic body never finishes.
      res.write('partial error body');
      return;
    }
    if (req.url?.startsWith('/reset/')) {
      // Part of a 2xx body, then the connection drops. The write callback holds
      // the close until the bytes are flushed, so the headers always land first.
      res.writeHead(
        200,
        req.url === '/reset/content-length'
          ? { 'content-type': 'application/json', 'content-length': '100' }
          : { 'content-type': 'application/json' },
      );
      res.write('{"partial":"twenty-b', () => req.socket.destroy());
      return;
    }
    if (req.url?.startsWith('/stall')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      // Flush headers plus a first chunk, then never finish the body.
      res.write('{"partial":');
      return;
    }
    if (req.url?.startsWith('/slow')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first ');
      setTimeout(() => res.end('second'), 40);
      return;
    }
    if (req.url?.startsWith('/no-content')) {
      res.writeHead(204, { 'x-marker': 'empty' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'x-marker': 'fast' });
    res.end('complete body');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const context = { requestId: 'body-deadline', timestamp: new Date().toISOString() };

/**
 * Tracks the deadline timer armed for a request with the given delay. The handle
 * is the only thing that tells the deadline apart from whatever timers the
 * runtime schedules for its own reasons, so both the unref and the disarm are
 * asserted against it rather than against a call count.
 */
function trackDeadlineTimer(delayMs: number) {
  type SetTimeout = typeof globalThis.setTimeout;
  const realSetTimeout: SetTimeout = globalThis.setTimeout;
  const handles: unknown[] = [];
  const unreffed: unknown[] = [];

  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<SetTimeout>) => {
    const handle = realSetTimeout(...args) as ReturnType<SetTimeout> & { unref?: () => unknown };
    if (args[1] === delayMs) {
      handles.push(handle);
      const nativeUnref = handle.unref?.bind(handle);
      handle.unref = () => {
        unreffed.push(handle);
        return nativeUnref?.();
      };
    }
    return handle;
  }) as SetTimeout);

  const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

  return {
    unreffed: () => unreffed,
    cleared: () => clearTimeoutSpy.mock.calls.filter(([handle]) => handles.includes(handle)),
  };
}

/** A deadline {@link holdDeadline} holds back; its odd value singles out its timer. */
const HELD_DEADLINE_MS = 8_765;

/**
 * Holds back the deadline timer armed with {@link HELD_DEADLINE_MS} and returns
 * a trigger that fires it, so the deadline lands on cue while every other timer
 * and both sockets stay real. The handle handed back is a no-op timer, so the
 * helper's own `clearTimeout` and `unref` still have something to act on.
 */
function holdDeadline(): () => void {
  type SetTimeout = typeof globalThis.setTimeout;
  const realSetTimeout: SetTimeout = globalThis.setTimeout;
  let fire: (() => void) | undefined;

  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<SetTimeout>) => {
    const [handler, delay] = args;
    if (delay !== HELD_DEADLINE_MS) return realSetTimeout(...args);
    fire = handler as () => void;
    return realSetTimeout(() => undefined, 0);
  }) as SetTimeout);

  return () => fire?.();
}

/**
 * Calls through to the real `fetch` and runs `callback` once it resolves — the
 * moment the headers are in and `fetchWithTimeout` moves on to the body — so a
 * test lands an abort inside the body phase on an event rather than a delay.
 */
function onHeaders(callback: () => void) {
  const realFetch = globalThis.fetch;
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (...args: Parameters<typeof fetch>) => {
      const response = await realFetch(...args);
      callback();
      return response;
    });
}

/** Messages of every record the logger received at `level`. */
function messagesAt(level: 'debug' | 'error' | 'info'): string[] {
  return vi.mocked(logger[level]).mock.calls.map(([message]) => String(message));
}

/** Every string `code` along an error's cause chain, the error itself first. */
function codesOf(error: unknown): string[] {
  const codes: string[] = [];
  for (let node = error; node instanceof Error; node = node.cause) {
    const { code } = node as { code?: unknown };
    if (typeof code === 'string') codes.push(code);
  }
  return codes;
}

beforeEach(() => {
  vi.spyOn(logger, 'debug').mockImplementation(() => {});
  vi.spyOn(logger, 'error').mockImplementation(() => {});
  vi.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchWithTimeout body deadline (issue #341)', () => {
  it('returns a response whose status, headers, and body survive the passthrough', async () => {
    const response = await fetchWithTimeout(`${origin}/fast`, UNREACHED_DEADLINE_MS, context);

    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    expect(response.headers.get('x-marker')).toBe('fast');
    expect(response.url).toBe(`${origin}/fast`);
    expect(response.redirected).toBe(false);
    expect(await response.text()).toBe('complete body');

    // `type` is runtime-specific ('basic' on Node, 'default' on Bun), so the
    // unwrapped response from the same peer is what the wrapper is held to.
    const native = await fetch(`${origin}/fast`);
    expect(response.type).toBe(native.type);
    await native.text();
  });

  it('passes a null-body status straight through', async () => {
    // Runtimes disagree on `response.body` for a 204 — Node yields null, Bun an
    // empty stream — so the assertion is on what the caller can observe.
    const response = await fetchWithTimeout(`${origin}/no-content`, UNREACHED_DEADLINE_MS, context);

    expect(response.status).toBe(204);
    expect(response.headers.get('x-marker')).toBe('empty');
    expect(await response.text()).toBe('');
  });

  it('resolves a body that completes within the deadline', async () => {
    const response = await fetchWithTimeout(`${origin}/slow`, UNREACHED_DEADLINE_MS, context);

    expect(await response.text()).toBe('first second');
  });

  it('disarms the deadline once the body settles', async () => {
    const deadline = trackDeadlineTimer(UNREACHED_DEADLINE_MS);
    const response = await fetchWithTimeout(`${origin}/slow`, UNREACHED_DEADLINE_MS, context);
    expect(deadline.cleared()).toHaveLength(0);

    await response.text();

    // Disarming is what keeps the timer from outliving the exchange, and the
    // call is its only observable — a settled body has nothing left to abort.
    expect(deadline.cleared()).toHaveLength(1);
  });

  it('unrefs the deadline it hands to the body', async () => {
    const deadline = trackDeadlineTimer(UNREACHED_DEADLINE_MS);
    const response = await fetchWithTimeout(`${origin}/fast`, UNREACHED_DEADLINE_MS, context);

    // A ref'd deadline would keep the runtime alive for the rest of the window
    // whenever a caller reads the status and never touches the body.
    expect(deadline.unreffed()).toHaveLength(1);

    await response.text();
  });

  it('aborts a body still stalled at the deadline and classifies it as a timeout', async () => {
    const startedAt = Date.now();
    const response = await fetchWithTimeout(`${origin}/stall`, DEADLINE_MS, context);

    // Headers arrive well inside the deadline — this is the gap the bug lived in.
    expect(Date.now() - startedAt).toBeLessThan(DEADLINE_MS);

    const failure = (await response.text().then(
      () => new Error('body read resolved despite the deadline'),
      (error: unknown) => error,
    )) as McpError;

    expect(failure).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: expect.objectContaining({ errorSource: 'FetchTimeout' }),
    });
    expect(Date.now() - startedAt).toBeLessThan(PAST_DEADLINE_MS);
  });

  it('fires the deadline on a body that is never read', async () => {
    const response = await fetchWithTimeout(`${origin}/stall`, DEADLINE_MS, context);

    // Nothing touches the body until well past the deadline, so the timer is on
    // its own. Waiting is a lower bound only — a starved loop delays it, never
    // shortens it — and a deadline that never fired would hang the read below.
    await new Promise((resolve) => setTimeout(resolve, PAST_DEADLINE_MS));

    await expect(response.text()).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: expect.objectContaining({ errorSource: 'FetchTimeout' }),
    });
  });

  it('lets an external signal abort the body read', async () => {
    const caller = new AbortController();
    const response = await fetchWithTimeout(`${origin}/stall`, 30_000, context, {
      signal: caller.signal,
    });
    setTimeout(() => caller.abort('client disconnected'), DEADLINE_MS);

    await expect(response.text()).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
      data: expect.objectContaining({ errorSource: 'FetchAborted' }),
    });
  });

  it('classifies a caller deadline that fires mid-body as Timeout, not a cancellation', async () => {
    const response = await fetchWithTimeout(`${origin}/stall`, 30_000, context, {
      signal: AbortSignal.timeout(DEADLINE_MS),
    });

    await expect(response.text()).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { errorSource: 'FetchSignalTimeout' },
    });
  });

  it('reports the timeout once, from the body read', async () => {
    const response = await fetchWithTimeout(`${origin}/stall`, DEADLINE_MS, context);
    await response.text().catch(() => undefined);

    const timeoutLogs = vi
      .mocked(logger.error)
      .mock.calls.filter(([message]) => String(message).includes('timed out'));
    expect(timeoutLogs).toHaveLength(1);
  });
});

/**
 * The upstream answered with a non-2xx whose diagnostic body never finishes.
 * A caller signal that cuts the capture is the caller's outcome; `timeoutMs`
 * cutting it leaves the status the upstream already reported.
 */
describe('a non-2xx body capture cut short (#604)', () => {
  const fetchFailedRecords = () =>
    [...messagesAt('error'), ...messagesAt('debug')].filter((m) => m.startsWith('Fetch failed'));

  it('reports a caller abort that cuts a 503 capture as RequestCancelled, not the status', async () => {
    const caller = new AbortController();
    onHeaders(() => caller.abort('client disconnected'));

    const error = await fetchWithTimeout(
      `${origin}/error-stall/503`,
      UNREACHED_DEADLINE_MS,
      context,
      { signal: caller.signal },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect((error as McpError).data).toEqual({ errorSource: 'FetchAborted' });
    expect(logger.info).toHaveBeenCalledWith(
      `fetch GET ${origin}/… aborted by caller.`,
      expect.objectContaining({ extra: expect.objectContaining({ errorSource: 'FetchAborted' }) }),
    );
    // The status was never reported, so no record names it.
    expect(fetchFailedRecords()).toEqual([]);
  });

  it("reports a caller deadline that cuts a 503 capture as Timeout on the caller's signal", async () => {
    const caller = new AbortController();
    // The reason `AbortSignal.timeout()` aborts with, landed on an event instead of a clock.
    onHeaders(() => caller.abort(new DOMException('The operation timed out.', 'TimeoutError')));

    const error = await fetchWithTimeout(
      `${origin}/error-stall/503`,
      UNREACHED_DEADLINE_MS,
      context,
      { signal: caller.signal },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.Timeout);
    expect((error as McpError).data).toEqual({ errorSource: 'FetchSignalTimeout' });
    expect(logger.error).toHaveBeenCalledWith(
      `fetch GET ${origin}/… timed out on the caller's signal.`,
      expect.objectContaining({
        extra: expect.objectContaining({ errorSource: 'FetchSignalTimeout' }),
      }),
    );
    expect(fetchFailedRecords()).toEqual([]);
  });

  it.each([
    [503, JsonRpcErrorCode.ServiceUnavailable, {}],
    [400, JsonRpcErrorCode.InvalidParams, {}],
    [429, JsonRpcErrorCode.RateLimited, { retryAfter: '7' }],
    [501, JsonRpcErrorCode.ServiceUnavailable, { retryable: false }],
  ])('keeps a %d whose capture timeoutMs cut status-mapped', async (status, code, extra) => {
    const fireDeadline = holdDeadline();
    onHeaders(fireDeadline);

    const error = await fetchWithTimeout(
      `${origin}/error-stall/${status}`,
      HELD_DEADLINE_MS,
      context,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(code);
    expect((error as McpError).data).toEqual({
      status,
      statusText: STATUS_CODES[status],
      body: 'Could not read response body',
      statusCode: status,
      responseBody: 'Could not read response body',
      ...extra,
      errorSource: 'FetchHttpError',
      ...serverOnlyFields(['body', 'responseBody']),
    });
    expect(fetchFailedRecords()).toEqual([`Fetch failed for ${origin}/… with status ${status}.`]);
    expect(messagesAt('error').filter((m) => m.includes('timed out'))).toEqual([]);
  });

  it('logs an expected status at debug when timeoutMs cut its capture', async () => {
    const fireDeadline = holdDeadline();
    onHeaders(fireDeadline);

    const error = await fetchWithTimeout(`${origin}/error-stall/404`, HELD_DEADLINE_MS, context, {
      expectedStatuses: [404],
    }).catch((e: unknown) => e);

    expect((error as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect(messagesAt('debug')).toContain(`Fetch failed for ${origin}/… with status 404.`);
    expect(messagesAt('error')).toEqual([]);
  });

  it.each([
    ['an abort', () => 'client disconnected', JsonRpcErrorCode.RequestCancelled],
    [
      'a TimeoutError',
      () => new DOMException('The operation timed out.', 'TimeoutError'),
      JsonRpcErrorCode.Timeout,
    ],
  ])(
    'makes one attempt inside withRetry when the caller cuts the capture with %s',
    async (_label, reason, code) => {
      const caller = new AbortController();
      const fetchSpy = onHeaders(() => caller.abort(reason()));

      // The ladder is not handed the caller's signal: only the classification keeps it out.
      const error = await withRetry(
        () =>
          fetchWithTimeout(`${origin}/error-stall/503`, UNREACHED_DEADLINE_MS, context, {
            signal: caller.signal,
          }),
        { baseDelayMs: 1, jitter: 0, maxRetries: 3, operation: 'fetchThing', context },
      ).catch((e: unknown) => e);

      expect((error as McpError).code).toBe(code);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(messagesAt('debug').filter((m) => m.startsWith('Retry '))).toEqual([]);
    },
  );

  it.each([
    [400, 1],
    [503, 3],
  ])('lets the status decide retry when timeoutMs cut a %d capture', async (status, attempts) => {
    const fireDeadline = holdDeadline();
    const fetchSpy = onHeaders(() => fireDeadline());

    const error = await withRetry(
      () => fetchWithTimeout(`${origin}/error-stall/${status}`, HELD_DEADLINE_MS, context),
      { baseDelayMs: 1, jitter: 0, maxRetries: 2, operation: 'fetchThing', context },
    ).catch((e: unknown) => e);

    expect((error as McpError).data).toMatchObject({ status, errorSource: 'FetchHttpError' });
    expect(fetchSpy).toHaveBeenCalledTimes(attempts);
  });
});

/**
 * The connection drops partway through a 2xx body. The runtimes reject the
 * read differently — Node with `TypeError: terminated` over a socket error,
 * Bun with an `ECONNRESET`-coded `TypeError` — so the expected name, message,
 * and transport codes are read off a raw `fetch` of the same route.
 */
describe('a 2xx body that fails mid-stream (#819)', () => {
  async function rawRejection(path: string): Promise<Error> {
    const response = await fetch(`${origin}${path}`);
    const rejection = await response.text().then(
      () => undefined,
      (e: unknown) => e,
    );
    if (!(rejection instanceof Error)) throw new Error('a raw read of the reset did not reject');
    return rejection;
  }

  it.each(['content-length', 'chunked'])(
    'rejects the read of a %s body reset mid-stream as a network failure',
    async (framing) => {
      const path = `/reset/${framing}`;
      const raw = await rawRejection(path);
      // Both runtimes carry a transport code somewhere on the chain.
      expect(codesOf(raw).length).toBeGreaterThan(0);

      const response = await fetchWithTimeout(`${origin}${path}`, UNREACHED_DEADLINE_MS, context);
      const failure = await response.text().then(
        () => new Error('the body read resolved'),
        (e: unknown) => e,
      );

      const message = `Network error during fetch GET ${origin}/…: ${raw.message}`;
      expect(failure).toBeInstanceOf(McpError);
      expect(failure).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable, message });
      expect((failure as McpError).data).toEqual({
        originalErrorName: raw.name,
        errorSource: 'FetchNetworkErrorWrapper',
      });
      const { cause } = failure as McpError;
      expect(cause).toBeInstanceOf(Error);
      expect(cause).toMatchObject({ name: raw.name, message: raw.message });
      expect(codesOf(cause)).toEqual(codesOf(raw));

      const records = vi
        .mocked(logger.error)
        .mock.calls.filter(([recorded]) => String(recorded).startsWith('Network error'));
      expect(records).toHaveLength(1);
      const [recorded, recordContext] = records[0] ?? [];
      expect(recorded).toBe(message);
      const extra = (recordContext as { extra?: { causeChain?: Array<{ code?: string }> } })?.extra;
      expect(extra).toMatchObject({
        originalErrorName: raw.name,
        errorSource: 'FetchNetworkError',
      });
      expect(extra?.causeChain?.flatMap((node) => node.code ?? [])).toEqual(codesOf(raw));
    },
  );
});

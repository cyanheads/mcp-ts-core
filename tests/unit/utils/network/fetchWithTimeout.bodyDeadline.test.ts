/**
 * @fileoverview Verifies that `fetchWithTimeout`'s `timeoutMs` bounds the whole
 * exchange — headers *and* body — against a real `node:http` peer. Bun.serve is
 * deliberately avoided: its URL normalization masks a class of request bugs.
 * @module tests/utils/network/fetchWithTimeout.bodyDeadline.test
 */
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonRpcErrorCode, type McpError } from '../../../../src/types-global/errors.js';
import { logger } from '../../../../src/utils/internal/logger.js';
import { fetchWithTimeout } from '../../../../src/utils/network/fetchWithTimeout.js';

/**
 * Timing budget. The deadline is 250ms and every wait that must outlast it is 4×
 * that. Waits are lower bounds — a starved event loop in a saturated worker pool
 * only ever delays them — and a stalled body is compared against "did the
 * deadline fire at all", never against a tight arrival window.
 */
const DEADLINE_MS = 250;
const PAST_DEADLINE_MS = 1000;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
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
    const response = await fetchWithTimeout(`${origin}/fast`, DEADLINE_MS, context);

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
    const response = await fetchWithTimeout(`${origin}/no-content`, DEADLINE_MS, context);

    expect(response.status).toBe(204);
    expect(response.headers.get('x-marker')).toBe('empty');
    expect(await response.text()).toBe('');
  });

  it('resolves a body that completes within the deadline', async () => {
    const response = await fetchWithTimeout(`${origin}/slow`, DEADLINE_MS, context);

    expect(await response.text()).toBe('first second');
  });

  it('disarms the deadline once the body settles', async () => {
    const deadline = trackDeadlineTimer(DEADLINE_MS);
    const response = await fetchWithTimeout(`${origin}/slow`, DEADLINE_MS, context);
    expect(deadline.cleared()).toHaveLength(0);

    await response.text();

    // Disarming is what keeps the timer from outliving the exchange, and the
    // call is its only observable — a settled body has nothing left to abort.
    expect(deadline.cleared()).toHaveLength(1);
  });

  it('unrefs the deadline it hands to the body', async () => {
    const deadline = trackDeadlineTimer(DEADLINE_MS);
    const response = await fetchWithTimeout(`${origin}/fast`, DEADLINE_MS, context);

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
      code: JsonRpcErrorCode.InternalError,
      data: expect.objectContaining({ errorSource: 'FetchAborted' }),
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

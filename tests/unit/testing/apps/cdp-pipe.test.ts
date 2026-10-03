/**
 * @fileoverview Tests for the CDP pipe client against in-memory streams: NUL framing
 * across split and coalesced chunks, command/response matching, protocol errors,
 * session-tagged events, abort signals, pipe close, and session detach. `spawnPiped` is
 * exercised against a stand-in process that speaks the pipe on fds 3 and 4.
 * @module tests/unit/testing/apps/cdp-pipe.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CdpError, CdpPipe, spawnPiped } from '@/testing/apps/cdp-pipe.js';
import { writeStandIn } from './stand-in-process.js';

/** A pipe wired to two in-memory streams, with what it wrote parsed back. */
function connect() {
  const fromBrowser = new PassThrough();
  const toBrowser = new PassThrough();
  const pipe = new CdpPipe(fromBrowser, toBrowser);
  let written = '';
  toBrowser.on('data', (chunk: Buffer) => {
    written += chunk.toString('utf8');
  });
  const sent = () =>
    written
      .split('\0')
      .filter(Boolean)
      .map((text) => JSON.parse(text) as Record<string, unknown>);
  const reply = (message: Record<string, unknown>) =>
    fromBrowser.write(`${JSON.stringify(message)}\0`);
  return { pipe, fromBrowser, toBrowser, sent, reply, written: () => written };
}

/** Let stream callbacks run. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('CdpPipe', () => {
  it('writes each command as NUL-terminated JSON and resolves with its result', async () => {
    const { pipe, sent, reply, written } = connect();
    const first = pipe.send('Browser.getVersion');
    const second = pipe.send('Target.createTarget', { url: 'about:blank' }, { sessionId: 'S1' });
    await tick();

    expect(written().endsWith('\0')).toBe(true);
    expect(sent()).toEqual([
      { id: 1, method: 'Browser.getVersion', params: {} },
      { id: 2, method: 'Target.createTarget', params: { url: 'about:blank' }, sessionId: 'S1' },
    ]);

    reply({ id: 2, result: { targetId: 'T' } });
    reply({ id: 1, result: { product: 'HeadlessChrome' } });
    await expect(first).resolves.toEqual({ product: 'HeadlessChrome' });
    await expect(second).resolves.toEqual({ targetId: 'T' });
  });

  it('resolves with an empty object when a response carries no result', async () => {
    const { pipe, reply } = connect();
    const pending = pipe.send('Page.enable');
    reply({ id: 1 });
    await expect(pending).resolves.toEqual({});
  });

  it('reassembles a message split across chunks, including inside a multi-byte character', async () => {
    const { pipe, fromBrowser } = connect();
    const pending = pipe.send('Runtime.evaluate');
    const bytes = Buffer.from(`${JSON.stringify({ id: 1, result: { value: 'héllo ✓' } })}\0`);
    const split = bytes.indexOf(Buffer.from('✓')) + 1;
    fromBrowser.write(bytes.subarray(0, 5));
    fromBrowser.write(bytes.subarray(5, split));
    fromBrowser.write(bytes.subarray(split));
    await expect(pending).resolves.toEqual({ value: 'héllo ✓' });
  });

  it('dispatches several messages coalesced into one chunk, in order', async () => {
    const { pipe, fromBrowser } = connect();
    const seen: string[] = [];
    pipe.on('Page.loadEventFired', () => seen.push('event'));
    const pending = pipe.send('Page.navigate');
    void pending.then(() => seen.push('response'));
    fromBrowser.write(
      `${JSON.stringify({ method: 'Page.loadEventFired', params: {} })}\0${JSON.stringify({ id: 1, result: { frameId: 'F' } })}\0{"method":"Page.frame`,
    );
    await expect(pending).resolves.toEqual({ frameId: 'F' });
    expect(seen).toEqual(['event', 'response']);
  });

  it('rejects a protocol error as a CdpError carrying its code and data', async () => {
    const { pipe, reply } = connect();
    const withData = pipe.send('Page.navigate');
    const without = pipe.send('Runtime.evaluate');
    reply({ id: 1, error: { code: -32000, message: 'Cannot navigate', data: 'invalid URL' } });
    reply({ id: 2, error: { code: -32601, message: 'Method not found' } });

    const err = await withData.catch((error: unknown) => error);
    expect(err).toBeInstanceOf(CdpError);
    expect(err).toMatchObject({
      name: 'CdpError',
      kind: 'protocol',
      method: 'Page.navigate',
      code: -32000,
      message: 'Page.navigate: Cannot navigate (invalid URL)',
    });
    await expect(without).rejects.toMatchObject({
      kind: 'protocol',
      code: -32601,
      message: 'Runtime.evaluate: Method not found',
    });
  });

  it('ignores responses to unknown ids and messages that are neither response nor event', async () => {
    const { pipe, reply } = connect();
    const pending = pipe.send('Page.enable');
    reply({ id: 99, result: {} });
    reply({ params: { stray: true } });
    reply({ method: 'Nobody.listens', params: {} });
    reply({ id: 1, result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
    expect(pipe.isClosed).toBe(false);
  });

  it('delivers events with their session id to every listener until unsubscribed', async () => {
    const { pipe, reply } = connect();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = pipe.on('Runtime.consoleAPICalled', first);
    pipe.on('Runtime.consoleAPICalled', second);

    reply({ method: 'Runtime.consoleAPICalled', params: { type: 'error' }, sessionId: 'S1' });
    reply({ method: 'Runtime.consoleAPICalled' });
    await tick();
    expect(first.mock.calls).toEqual([
      [{ type: 'error' }, 'S1'],
      [{}, undefined],
    ]);
    expect(second).toHaveBeenCalledTimes(2);

    expect(unsubscribe()).toBe(true);
    reply({ method: 'Runtime.consoleAPICalled', params: {}, sessionId: 'S2' });
    await tick();
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(3);
  });

  it('rejects at once, writing nothing, when the signal is already aborted', async () => {
    const { pipe, sent } = connect();
    const reason = new Error('gave up');
    await expect(pipe.send('Page.enable', {}, { signal: AbortSignal.abort(reason) })).rejects.toBe(
      reason,
    );
    await tick();
    expect(sent()).toEqual([]);
  });

  it('rejects with the abort reason mid-flight and drops the late response', async () => {
    const { pipe, reply } = connect();
    const controller = new AbortController();
    const pending = pipe.send('Page.navigate', {}, { signal: controller.signal });
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');

    reply({ id: 1, result: { frameId: 'late' } });
    await tick();
    expect(pipe.isClosed).toBe(false);

    const settled = new AbortController();
    const releaseSpy = vi.spyOn(settled.signal, 'removeEventListener');
    const next = pipe.send('Page.enable', {}, { signal: settled.signal });
    reply({ id: 2, result: {} });
    await expect(next).resolves.toEqual({});
    expect(releaseSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('closes once, ends the output, and rejects pending and later commands as closed', async () => {
    const { pipe, toBrowser } = connect();
    const controller = new AbortController();
    const release = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = pipe.send('Page.navigate', {}, { signal: controller.signal });
    let resolvedClosed = false;
    void pipe.closed.then(() => {
      resolvedClosed = true;
    });

    pipe.close('test shutdown');
    pipe.close('second call is a no-op');
    await expect(pending).rejects.toMatchObject({
      kind: 'closed',
      method: 'Page.navigate',
      message: 'Page.navigate: test shutdown',
    });
    expect(release).toHaveBeenCalled();
    expect(pipe.isClosed).toBe(true);
    expect(toBrowser.writableEnded).toBe(true);
    await tick();
    expect(resolvedClosed).toBe(true);

    await expect(pipe.send('Page.enable')).rejects.toMatchObject({
      kind: 'closed',
      message: 'Page.enable: test shutdown',
    });
  });

  it('closes without ending an output that is already destroyed', () => {
    const { pipe, toBrowser } = connect();
    toBrowser.destroy();
    pipe.close();
    expect(pipe.isClosed).toBe(true);
  });

  it('closes when the browser ends the pipe', async () => {
    const { pipe, fromBrowser } = connect();
    const pending = pipe.send('Page.enable');
    fromBrowser.end();
    await expect(pending).rejects.toMatchObject({
      kind: 'closed',
      message: 'Page.enable: the browser closed the DevTools pipe',
    });
  });

  it('closes when either stream fails', async () => {
    const inbound = connect();
    const a = inbound.pipe.send('Page.enable');
    inbound.fromBrowser.destroy(new Error('read failed'));
    await expect(a).rejects.toThrow('the DevTools pipe failed: read failed');

    const outbound = connect();
    const b = outbound.pipe.send('Page.enable');
    outbound.toBrowser.destroy(new Error('write failed'));
    await expect(b).rejects.toThrow('the DevTools pipe failed: write failed');
  });

  it('closes on a message that is not JSON and ignores what follows in the chunk', async () => {
    const { pipe, fromBrowser } = connect();
    const listener = vi.fn();
    pipe.on('Page.loadEventFired', listener);
    const pending = pipe.send('Page.enable');
    fromBrowser.write(
      `not json at all\0${JSON.stringify({ method: 'Page.loadEventFired' })}\0tail`,
    );
    await expect(pending).rejects.toMatchObject({
      kind: 'closed',
      message: 'Page.enable: the browser sent a message that is not JSON: not json at all',
    });
    expect(listener).not.toHaveBeenCalled();

    fromBrowser.write(`${JSON.stringify({ method: 'Page.loadEventFired' })}\0`);
    await tick();
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects only the detached session’s commands, and still delivers the event', async () => {
    const { pipe, reply } = connect();
    const onDetached = vi.fn();
    pipe.on('Target.detachedFromTarget', onDetached);
    const inSession = pipe.send('Runtime.evaluate', {}, { sessionId: 'S1' });
    const elsewhere = pipe.send('Runtime.evaluate', {}, { sessionId: 'S2' });
    const browserLevel = pipe.send('Target.getTargets');

    reply({ method: 'Target.detachedFromTarget', params: { sessionId: 'S1', targetId: 'T1' } });
    await expect(inSession).rejects.toMatchObject({
      kind: 'detached',
      method: 'Runtime.evaluate',
      message: 'Runtime.evaluate: session S1 detached',
    });
    expect(onDetached).toHaveBeenCalledWith({ sessionId: 'S1', targetId: 'T1' }, undefined);

    reply({ id: 2, result: { value: 2 } });
    reply({ id: 3, result: { targetInfos: [] } });
    await expect(elsewhere).resolves.toEqual({ value: 2 });
    await expect(browserLevel).resolves.toEqual({ targetInfos: [] });
  });
});

describe('spawnPiped', () => {
  let dir: string;
  let echo: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cdp-pipe-test-'));
    echo = await writeStandIn(dir, 'pipe-echo', ECHO_LOOP);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('speaks CDP over fds 3 and 4, keeps a stderr tail, and reports the exit', async () => {
    const proc = await spawnPiped(echo, ['--flag']);
    expect(proc.pid).toBeGreaterThan(0);
    await expect(proc.cdp.send('Browser.getVersion')).resolves.toEqual({
      echo: 'Browser.getVersion',
    });
    await expect(proc.cdp.send('Browser.close')).resolves.toEqual({ echo: 'Browser.close' });
    await expect(proc.exited).resolves.toEqual({ code: 0, signal: null });
    expect(proc.stderrTail()).toContain('stderr: Browser.getVersion');
    await proc.cdp.closed;
    expect(proc.cdp.isClosed).toBe(true);
    proc.kill();
  });

  it('kills its own process by PID and closes the pipe naming the signal', async () => {
    const proc = await spawnPiped(echo, []);
    await proc.cdp.send('Browser.getVersion');
    proc.kill();
    await expect(proc.exited).resolves.toEqual({ code: null, signal: 'SIGKILL' });
    await proc.cdp.closed;
    await expect(proc.cdp.send('Page.enable')).rejects.toThrow(
      /the browser (exited on SIGKILL|closed the DevTools pipe)/,
    );
  });

  it('rejects with the spawn error when the executable cannot start', async () => {
    await expect(spawnPiped(path.join(dir, 'missing-binary'), [])).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

/**
 * Answers every command on fd 3 with `{ id, result: { echo: method } }` on fd 4, and
 * writes `stderr: <method>` for each. `Browser.close` answers, then exits 0.
 */
const ECHO_LOOP = `let buffered = '';
input.on('data', (chunk) => {
  buffered += chunk.toString('utf8');
  let end;
  while ((end = buffered.indexOf('\\0')) !== -1) {
    const message = JSON.parse(buffered.slice(0, end));
    buffered = buffered.slice(end + 1);
    process.stderr.write('stderr: ' + message.method + '\\n');
    output.write(JSON.stringify({ id: message.id, result: { echo: message.method } }) + '\\0');
    if (message.method === 'Browser.close') output.end(() => process.exit(0));
  }
});`;

/** @fileoverview Deliberate clean/leaking cases; only the dedicated sentinel config selects this file. */
import { createServer } from 'node:net';
import { expect, it } from 'vitest';

it('exercises the lifecycle selected by the parent process', async () => {
  const mode = process.env.MCP_LEAK_PROBE;
  const retained = globalThis as typeof globalThis & { retained?: Promise<unknown> };
  if (mode === 'promise') retained.retained = new Promise(() => {});
  else if (mode === 'adopted')
    retained.retained = new Promise((resolve) => resolve(new Promise(() => {})));
  else if (mode === 'timer' || mode === 'unref-timer') {
    const timer = setInterval(() => {}, 60_000);
    if (mode === 'unref-timer') timer.unref();
  } else if (mode === 'socket') {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
  } else if (mode === 'descendant-timer' || mode === 'descendant-socket') {
    const helperPath = './descendant.mjs';
    const { leakTimer, leakSocket } = await import(helperPath);
    setTimeout(mode === 'descendant-timer' ? leakTimer : leakSocket, 0);
  } else if (mode?.startsWith('finalizer')) {
    const helperPath = './descendant.mjs';
    const { installFinalizer } = await import(helperPath);
    installFinalizer(mode);
  } else if (mode === 'clean') {
    await Promise.race([Promise.resolve('done'), new Promise(() => {})]);
    clearInterval(setInterval(() => {}, 60_000));
    const timer = setTimeout(() => {}, 60_000);
    timer.unref();
    clearTimeout(timer);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  } else if (mode === 'test-failure') {
    expect('actual').toBe('expected');
  } else {
    throw new Error(`Unknown sentinel: ${mode}`);
  }
  expect(true).toBe(true);
});

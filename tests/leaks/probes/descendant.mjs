/** @fileoverview Callback allocations with no sentinel-file stack frame. */
import { createServer } from 'node:net';
export function leakTimer() {
  setInterval(() => {}, 60_000);
}
export function leakSocket() {
  createServer().listen(0);
}

export function installFinalizer(mode) {
  globalThis.leakGateRegistry = new FinalizationRegistry(() => {
    if (mode === 'finalizer-promise') globalThis.leakGatePending = new Promise(() => {});
    else if (mode === 'finalizer-unref')
      globalThis.leakGateTimer = setInterval(() => {}, 60_000).unref();
    else leakTimer();
  });
  globalThis.leakGateRegistry.register({}, 'test');
}

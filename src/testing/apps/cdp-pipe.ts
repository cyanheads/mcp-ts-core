/**
 * @fileoverview Chrome DevTools Protocol client over `--remote-debugging-pipe`. The
 * browser reads commands from its fd 3 and writes responses and events to its fd 4, each
 * message one JSON text ended by a NUL byte. No DevTools port is opened, and Chromium
 * exits when fd 3 closes, so a harness that dies takes its browser with it.
 *
 * Sessions are flat: a command for a target carries the `sessionId` from
 * `Target.attachToTarget({ flatten: true })` or `Target.setAutoAttach({ flatten: true })`,
 * and events arrive on one stream tagged with theirs. Events are dispatched synchronously
 * in arrival order, so subscribe before sending the command whose events you need.
 * @module src/testing/apps/cdp-pipe
 */

import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/** CDP params and results: JSON objects whose shape is the method's. */
export type CdpObject = Record<string, unknown>;

/**
 * Why a command returned no result:
 * - `protocol` — the browser answered with a CDP error, whose number is `code`;
 * - `closed` — the pipe closed first: the browser exited or crashed, or `close()` ran;
 * - `detached` — the command's session ended first (`Target.detachedFromTarget`).
 */
export type CdpErrorKind = 'protocol' | 'closed' | 'detached';

/** A command that failed; an aborted command rejects with its signal's reason instead. */
export class CdpError extends Error {
  override readonly name = 'CdpError';
  readonly kind: CdpErrorKind;
  readonly method: string;
  readonly code: number | undefined;

  constructor(kind: CdpErrorKind, method: string, message: string, code?: number) {
    super(`${method}: ${message}`);
    this.kind = kind;
    this.method = method;
    this.code = code;
  }
}

/** Per-command options. */
export interface SendOptions {
  /** The target session; omit for the browser session. */
  sessionId?: string | undefined;
  /** Rejects the command with the signal's reason; a response arriving after is dropped. */
  signal?: AbortSignal | undefined;
}

/** Receives one event's params and the session it arrived on (undefined: the browser). */
export type CdpListener<P = CdpObject> = (params: P, sessionId: string | undefined) => void;

interface Pending {
  method: string;
  reject(error: unknown): void;
  release(): void;
  resolve(result: unknown): void;
  sessionId: string | undefined;
}

interface Message {
  error?: { code: number; message: string; data?: string };
  id?: number;
  method?: string;
  params?: CdpObject;
  result?: CdpObject;
  sessionId?: string;
}

/** A CDP connection over a pair of streams: `input` from the browser, `output` to it. */
export class CdpPipe {
  readonly #output: Writable;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Map<string, Set<CdpListener<never>>>();
  readonly #closed = Promise.withResolvers<void>();
  #nextId = 1;
  #isClosed = false;
  #closeReason = '';
  #partial: Buffer[] = [];

  constructor(input: Readable, output: Writable) {
    this.#output = output;
    input.on('data', (chunk: Buffer) => this.#receive(chunk));
    input.on('end', () => this.close('the browser closed the DevTools pipe'));
    input.on('error', (err) => this.close(`the DevTools pipe failed: ${err.message}`));
    output.on('error', (err) => this.close(`the DevTools pipe failed: ${err.message}`));
  }

  /** Resolves once the pipe has closed, from either end. */
  get closed(): Promise<void> {
    return this.#closed.promise;
  }

  get isClosed(): boolean {
    return this.#isClosed;
  }

  /** Send one command and resolve with its result. */
  send<R = CdpObject>(
    method: string,
    params: CdpObject = {},
    options: SendOptions = {},
  ): Promise<R> {
    const { sessionId, signal } = options;
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#isClosed) return Promise.reject(new CdpError('closed', method, this.#closeReason));
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<R>();
    const onAbort = () => {
      this.#pending.delete(id);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    this.#pending.set(id, {
      method,
      sessionId,
      resolve: resolve as (result: unknown) => void,
      reject,
      release: () => signal?.removeEventListener('abort', onAbort),
    });
    const message = { id, method, params, ...(sessionId !== undefined && { sessionId }) };
    this.#output.write(`${JSON.stringify(message)}\0`);
    return promise;
  }

  /** Call `listener` for every `method` event until the returned function is called. */
  on<P = CdpObject>(method: string, listener: CdpListener<P>): () => void {
    let listeners = this.#listeners.get(method);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(method, listeners);
    }
    const entry = listener as CdpListener<never>;
    listeners.add(entry);
    return () => listeners.delete(entry);
  }

  /**
   * End the pipe to the browser (Chromium exits on reading EOF) and reject every pending
   * command as `closed`. Idempotent.
   */
  close(reason = 'the DevTools pipe was closed'): void {
    if (this.#isClosed) return;
    this.#isClosed = true;
    this.#closeReason = reason;
    this.#partial = [];
    if (!this.#output.writableEnded && !this.#output.destroyed) this.#output.end();
    for (const pending of this.#pending.values()) {
      pending.release();
      pending.reject(new CdpError('closed', pending.method, reason));
    }
    this.#pending.clear();
    this.#closed.resolve();
  }

  #receive(chunk: Buffer): void {
    let start = 0;
    for (let end = chunk.indexOf(0); end !== -1; end = chunk.indexOf(0, start)) {
      if (this.#isClosed) return;
      this.#partial.push(chunk.subarray(start, end));
      const text = Buffer.concat(this.#partial).toString('utf8');
      this.#partial = [];
      this.#dispatch(text);
      start = end + 1;
    }
    if (start < chunk.length && !this.#isClosed) {
      this.#partial.push(Buffer.from(chunk.subarray(start)));
    }
  }

  #dispatch(text: string): void {
    let message: Message;
    try {
      message = JSON.parse(text) as Message;
    } catch {
      this.close(`the browser sent a message that is not JSON: ${text.slice(0, 80)}`);
      return;
    }
    if (message.id !== undefined) {
      this.#settle(message.id, message);
      return;
    }
    if (message.method === undefined) return;
    const params = message.params ?? {};
    if (message.method === 'Target.detachedFromTarget') this.#detach(params.sessionId);
    for (const listener of this.#listeners.get(message.method) ?? []) {
      (listener as CdpListener)(params, message.sessionId);
    }
  }

  #settle(id: number, message: Message): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    pending.release();
    const { error } = message;
    if (error) {
      const detail = error.data ? `${error.message} (${error.data})` : error.message;
      pending.reject(new CdpError('protocol', pending.method, detail, error.code));
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  #detach(sessionId: unknown): void {
    for (const [id, pending] of this.#pending) {
      if (pending.sessionId !== sessionId) continue;
      this.#pending.delete(id);
      pending.release();
      pending.reject(
        new CdpError('detached', pending.method, `session ${String(sessionId)} detached`),
      );
    }
  }
}

/** How a spawned process ended: an exit code, or the signal that killed it. */
export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** A browser process with its CDP pipe on fds 3 and 4. */
export interface PipedProcess {
  readonly cdp: CdpPipe;
  /** Settles when the process exits; never rejects. */
  readonly exited: Promise<ProcessExit>;
  /** SIGKILL this process by its own PID. A no-op once it has exited. */
  kill(): void;
  readonly pid: number;
  /** The last 8 KiB of the process's stderr. */
  stderrTail(): string;
}

const STDERR_TAIL_CHARS = 8 * 1024;

/**
 * Spawn `executable` with a CDP pipe on its fds 3 (commands in) and 4 (messages out).
 * Rejects with the spawn error (`ENOENT`, `EACCES`, ...) when the process cannot start.
 * Stdin and stdout are discarded.
 */
export async function spawnPiped(
  executable: string,
  args: readonly string[],
): Promise<PipedProcess> {
  const child = spawn(executable, args, {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise<ProcessExit>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });

  const cdp = new CdpPipe(child.stdio[4] as Readable, child.stdio[3] as Writable);
  void exited.then(({ code, signal }) =>
    cdp.close(`the browser exited ${signal ? `on ${signal}` : `with code ${code}`}`),
  );
  let tail = '';
  child.stderr?.setEncoding('utf8').on('data', (text: string) => {
    tail = (tail + text).slice(-STDERR_TAIL_CHARS);
  });

  return {
    pid: child.pid as number,
    cdp,
    exited,
    stderrTail: () => tail,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
}

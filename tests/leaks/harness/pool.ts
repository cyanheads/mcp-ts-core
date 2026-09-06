/** @fileoverview Vitest fork transport that requires the actual test worker to exit naturally. */
import { type ChildProcess, fork } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolOptions, PoolRunnerInitializer, PoolWorker, WorkerRequest } from 'vitest/node';
import { evidenceFilename } from './evidence.js';

/** Keep Vitest's worker protocol; replace forced successful termination with a lifecycle check. */
class NaturalExitWorker implements PoolWorker {
  readonly name = 'forks';
  readonly cacheFs = true;
  private child!: ChildProcess;
  private readonly options: PoolOptions;
  private identities: string[] = [];

  constructor(options: PoolOptions) {
    this.options = options;
  }
  canReuse() {
    return false;
  }
  on: PoolWorker['on'] = (event, callback) => {
    this.child.on(event, callback);
  };
  off: PoolWorker['off'] = (event, callback) => {
    this.child.off(event, callback);
  };
  deserialize(data: unknown) {
    return data;
  }
  send(message: WorkerRequest) {
    if (message.type === 'run' || message.type === 'collect') {
      this.identities = message.context.files.map(
        (file) => `${this.options.project.name}:${file.filepath}`,
      );
    }
    this.child.send(message);
  }
  async start() {
    this.child = fork(join(this.options.distPath, 'workers/forks.js'), [], {
      env: this.options.env,
      execArgv: this.options.execArgv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'advanced',
    });
    this.child.stdout!.on('data', (chunk) =>
      this.options.project.vitest.logger.outputStream.write(chunk),
    );
    this.child.stderr!.on('data', (chunk) =>
      this.options.project.vitest.logger.errorStream.write(chunk),
    );
  }
  async stop() {
    const child = this.child;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve({ code: child.exitCode, signal: child.signalCode });
        return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      }, 3_000);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        resolve({ code, signal });
      });
      // Vitest has acknowledged its stop message and removed worker listeners.
      // IPC is harness-owned; disconnect it and allow Node/napi_env to finish.
      if (child.connected) child.disconnect();
    });
    const directory = process.env.MCP_LEAK_REPORT_DIR;
    if (!directory) throw new Error('Missing MCP_LEAK_REPORT_DIR');
    for (const identity of this.identities)
      writeFileSync(
        join(directory, `lifetime-${evidenceFilename(identity)}`),
        JSON.stringify({
          identity,
          timedOut,
          ...result,
        }),
      );
    if (timedOut || result.code !== 0 || result.signal) {
      // Worker shutdown follows result reporting, so propagate lifecycle failure explicitly.
      process.exitCode = 1;
      this.options.project.vitest.logger.error(
        `Test worker did not exit naturally: ${this.identities.join(', ')} (timeout=${timedOut}, code=${result.code}, signal=${result.signal})`,
      );
    }
  }
}

/** Public Vitest pool extension; no installed package patches or private pool fields. */
export const naturalExitPool: PoolRunnerInitializer = {
  name: 'lifecycle-forks',
  createPoolWorker: (options) => new NaturalExitWorker(options),
};

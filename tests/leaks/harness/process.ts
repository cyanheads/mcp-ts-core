/** @fileoverview Real-Node selection and bounded child execution for lifecycle evidence. */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Bun's run.bun shim also answers to node; inspect each candidate's actual runtime. */
export function findNode(path = process.env.PATH ?? ''): string {
  for (const directory of new Set(path.split(delimiter))) {
    const candidate = join(directory, 'node');
    if (!existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-p', 'JSON.stringify(process.versions)'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (probe.status !== 0) continue;
    try {
      const versions = JSON.parse(probe.stdout) as { bun?: string; node?: string };
      if (!versions.bun && versions.node && Number(versions.node.split('.')[0]) >= 24)
        return candidate;
    } catch {
      // This PATH entry is not a usable Node executable; inspect the next candidate.
    }
  }
  throw new Error('test:leaks requires real Node >=24 on PATH (Bun shims do not qualify)');
}

/** Wait for natural process completion. Timeout termination is always a failed result. */
export async function runProcess(
  executable: string,
  args: string[],
  options: {
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    onOutput?: (text: string) => void;
  },
) {
  return await new Promise<{
    code: number | null;
    signal: string | null;
    timedOut: boolean;
    output: string;
  }>((resolve, reject) => {
    const child = spawn(executable, args, {
      env: options.env ?? process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1_000);
      killTimer.unref();
    }, options.timeoutMs);
    const receive = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      options.onOutput?.(text);
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.once('error', (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ code, signal, timedOut, output });
    });
  });
}

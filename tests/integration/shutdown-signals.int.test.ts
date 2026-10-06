/**
 * @fileoverview The signal half of the exit contract, observed on a real
 * process: a clean `SIGTERM` exits 0 after running `teardown()` once, a shutdown
 * that never settles is cut by the 10 s ceiling with exit 1 and a warning naming
 * the stuck step, and a second `SIGTERM` mid-shutdown terminates on the OS
 * default. The unit suite pins the same behavior with `process.on` and
 * `setTimeout` mocked; only a real process shows that no other listener (a
 * dependency's own `SIGTERM` handler) swallows the operator's force-kill.
 *
 * The fixture is written per run to a temp directory and imports the built
 * package by file URL, so it runs on whichever runtime hosts this lane.
 * @module tests/integration/shutdown-signals.int.test
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PACKAGE_ENTRY = pathToFileURL(resolve(process.cwd(), 'dist/core/index.js')).href;
const READY_LINE = 'is now running and ready.';
const SHUTDOWN_STARTED = 'Initiating graceful shutdown';
const TEARDOWN_LINE = 'shutdown-signals teardown ran.';
const READY_TIMEOUT_MS = 15_000;
/** Generous over the 10 s ceiling, so only a ceiling that never fires times out. */
const EXIT_TIMEOUT_MS = 20_000;

/**
 * A server whose `teardown()` logs one line and then either settles or never
 * does, chosen by `SHUTDOWN_SIGNALS_TEARDOWN`.
 */
const FIXTURE = `
import { createApp } from ${JSON.stringify(PACKAGE_ENTRY)};

await createApp({
  name: 'shutdown-signals-fixture',
  version: '0.0.0-test',
  teardown(core) {
    core.logger.info(${JSON.stringify(TEARDOWN_LINE)}, {
      requestId: 'shutdown-signals',
      timestamp: new Date().toISOString(),
    });
    if (process.env.SHUTDOWN_SIGNALS_TEARDOWN === 'hangs') return new Promise(() => {});
  },
});
`;

interface Run {
  child: ChildProcess;
  /** How the process ended. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Everything the process has written to stderr so far. */
  stderr(): string;
  /** Resolves once stderr contains `text`; rejects if the process exits first. */
  waitFor(text: string, timeoutMs: number): Promise<void>;
}

describe('signal shutdown on a real process', () => {
  let fixtureDir: string;
  let fixturePath: string;
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'mcp-shutdown-signals-'));
    fixturePath = join(fixtureDir, 'server.mjs');
    await writeFile(fixturePath, FIXTURE, 'utf8');
  });

  afterAll(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await rm(fixtureDir, { force: true, recursive: true });
  });

  /** Starts the fixture over piped stdio (stdin held open) and waits for the ready line. */
  async function start(teardown: 'settles' | 'hangs'): Promise<Run> {
    const child = spawn(process.execPath, [fixturePath], {
      cwd: fixtureDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MCP_LOG_LEVEL: 'info',
        MCP_TRANSPORT_TYPE: 'stdio',
        // The logger installs no stderr sink under `testing`, and stderr is
        // where the shutdown trace this suite reads has to appear.
        NODE_ENV: 'development',
        SHUTDOWN_SIGNALS_TEARDOWN: teardown,
      },
    });
    children.push(child);
    child.stderr?.setEncoding('utf8');
    let stderr = '';
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle) => {
      child.once('exit', (code, signal) => settle({ code, signal }));
    });

    const waitFor = (text: string, timeoutMs: number) =>
      new Promise<void>((found, failed) => {
        const timer = setTimeout(
          () => failed(new Error(`never saw "${text}":\n${stderr}`)),
          timeoutMs,
        );
        const check = () => {
          if (!stderr.includes(text)) return;
          clearTimeout(timer);
          child.stderr?.off('data', check);
          found();
        };
        child.stderr?.on('data', check);
        void exited.then(() => {
          clearTimeout(timer);
          if (stderr.includes(text)) found();
          else failed(new Error(`exited before "${text}":\n${stderr}`));
        });
        check();
      });

    await waitFor(READY_LINE, READY_TIMEOUT_MS);
    return { child, exited, stderr: () => stderr, waitFor };
  }

  /** The process's exit, or `null` when it was still running after `timeoutMs`. */
  const exitWithin = (run: Run, timeoutMs: number) =>
    Promise.race([
      run.exited,
      new Promise<null>((settle) => setTimeout(() => settle(null), timeoutMs)),
    ]);

  it('exits 0 on SIGTERM once the shutdown settles, running teardown() once', async () => {
    const run = await start('settles');

    run.child.kill('SIGTERM');

    expect(await exitWithin(run, EXIT_TIMEOUT_MS)).toEqual({ code: 0, signal: null });
    expect(run.stderr().split(TEARDOWN_LINE)).toHaveLength(2);
    expect(run.stderr()).toContain('Graceful shutdown completed successfully.');
    expect(run.stderr()).not.toContain('did not settle');
  });

  it('terminates on the OS default when a second SIGTERM arrives mid-shutdown', async () => {
    const run = await start('hangs');

    run.child.kill('SIGTERM');
    await run.waitFor(TEARDOWN_LINE, EXIT_TIMEOUT_MS);
    const secondSignalAt = Date.now();
    run.child.kill('SIGTERM');

    // Killed by the signal itself, well inside the ceiling it would otherwise wait out.
    expect(await exitWithin(run, 5_000)).toEqual({ code: null, signal: 'SIGTERM' });
    expect(Date.now() - secondSignalAt).toBeLessThan(5_000);
    expect(run.stderr()).toContain(SHUTDOWN_STARTED);
    expect(run.stderr()).not.toContain('did not settle');
  });

  it(
    'exits 1 at the ceiling, after a warning naming the step that never settled',
    async () => {
      const run = await start('hangs');
      const signalledAt = Date.now();

      run.child.kill('SIGTERM');

      expect(await exitWithin(run, EXIT_TIMEOUT_MS)).toEqual({ code: 1, signal: null });
      expect(Date.now() - signalledAt).toBeGreaterThanOrEqual(9_000);
      const warning = run
        .stderr()
        .split('\n')
        .find((line) => line.includes('did not settle'));
      expect(warning).toBeDefined();
      expect(JSON.parse(warning as string)).toMatchObject({
        cleanupStep: 'teardown',
        triggerEvent: 'SIGTERM',
      });
    },
    EXIT_TIMEOUT_MS + READY_TIMEOUT_MS,
  );
});

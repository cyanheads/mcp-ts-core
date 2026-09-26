/**
 * @fileoverview Black-box tests for the logger's sink wiring: which records
 * reach stderr and each file sink at a given level (#511), and what happens
 * when a file sink cannot be opened (#497). Every case runs a real subprocess,
 * because the stderr sink lives in pino's transport worker and writes fd 2
 * directly — nothing in-process can observe it.
 * @module tests/integration/logger-sinks.int.test
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseLogLines, runStdioSession } from '../helpers/stdio-session.js';

const LOGGER_FIXTURE = resolve(process.cwd(), 'tests/fixtures/logger-levels.js');
const SERVER_FIXTURE = resolve(process.cwd(), 'tests/fixtures/stdio-log-server.js');

/** Root ignores mode bits, so a permission-based case proves nothing there. */
const RUNNING_AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

const DEBUG_AT_START = 'fixture: debug at start level';
const DEBUG_AFTER_SET = 'fixture: debug after setLevel(debug)';
const INFO_AFTER_WARNING = 'fixture: info after setLevel(warning)';
const BARRIER = 'fixture: barrier';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    // A mode-555 directory cannot be emptied until its write bit is back.
    if (existsSync(dir)) chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

function readMessages(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  return parseLogLines(readFileSync(filePath, 'utf8')).map((record) => String(record.msg));
}

function readRecords(filePath: string): Array<Record<string, unknown>> {
  if (!existsSync(filePath)) return [];
  return parseLogLines(readFileSync(filePath, 'utf8'));
}

/** What a logger-fixture run left behind once the barrier had settled. */
interface FixtureRun {
  code: number | null;
  stderr: string;
}

/**
 * Runs the logger fixture until `settled` holds for the output so far, then
 * closes stdin so the fixture closes its logger and exits.
 */
async function runLoggerFixture(
  env: Record<string, string>,
  settled: (stderr: string) => boolean,
): Promise<FixtureRun> {
  const child = spawn(process.execPath, [LOGGER_FIXTURE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', ...env },
  });
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((settle) => child.once('exit', settle));

  try {
    await expect.poll(() => settled(stderr), { timeout: 10_000, interval: 50 }).toBe(true);
    child.stdin.end();
    const code = await Promise.race([
      exited,
      new Promise<'timeout'>((settle) => setTimeout(() => settle('timeout'), 10_000)),
    ]);
    expect(code, `logger fixture did not exit:\n${stderr}`).not.toBe('timeout');
    return { code: code === 'timeout' ? null : code, stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      process.kill(child.pid, 'SIGKILL');
    }
  }
}

describe('logger sink levels (#511)', () => {
  it('delivers debug records to stderr and combined.log when started at debug', async () => {
    const logsDir = makeTempDir('mcp-logger-debug-');
    const combined = join(logsDir, 'combined.log');

    const run = await runLoggerFixture(
      { FIXTURE_START_LEVEL: 'debug', LOGS_DIR: logsDir },
      (stderr) => stderr.includes(BARRIER) && readMessages(combined).includes(BARRIER),
    );

    expect(run.code).toBe(0);
    const stderrRecords = parseLogLines(run.stderr);
    expect(stderrRecords).toContainEqual(
      expect.objectContaining({ msg: DEBUG_AT_START, level: 20 }),
    );
    expect(readRecords(combined)).toContainEqual(
      expect.objectContaining({ msg: DEBUG_AT_START, level: 20 }),
    );
  });

  it('keeps level-20 records off stderr and combined.log at the default info level', async () => {
    const logsDir = makeTempDir('mcp-logger-info-');
    const combined = join(logsDir, 'combined.log');

    const run = await runLoggerFixture(
      { FIXTURE_START_LEVEL: 'info', LOGS_DIR: logsDir },
      (stderr) => stderr.includes(BARRIER) && readMessages(combined).includes(BARRIER),
    );

    expect(run.code).toBe(0);
    expect(run.stderr).not.toContain(DEBUG_AT_START);
    expect(readMessages(combined)).not.toContain(DEBUG_AT_START);
  });

  it('follows setLevel() on stderr and combined.log in both directions', async () => {
    const logsDir = makeTempDir('mcp-logger-setlevel-');
    const combined = join(logsDir, 'combined.log');

    const run = await runLoggerFixture(
      { FIXTURE_START_LEVEL: 'info', LOGS_DIR: logsDir },
      (stderr) => stderr.includes(BARRIER) && readMessages(combined).includes(BARRIER),
    );

    expect(run.code).toBe(0);
    // Raised to debug after an info start: the next debug record reaches both sinks.
    expect(run.stderr).toContain(DEBUG_AFTER_SET);
    expect(readMessages(combined)).toContain(DEBUG_AFTER_SET);
    // Lowered to warning: info records stop on both.
    expect(run.stderr).not.toContain(INFO_AFTER_WARNING);
    expect(readMessages(combined)).not.toContain(INFO_AFTER_WARNING);
  });

  it('keeps error.log at level 50 and above', async () => {
    const logsDir = makeTempDir('mcp-logger-errorlog-');
    const errorLog = join(logsDir, 'error.log');

    await runLoggerFixture(
      { FIXTURE_START_LEVEL: 'debug', LOGS_DIR: logsDir },
      (stderr) => stderr.includes(BARRIER) && readMessages(errorLog).includes(BARRIER),
    );

    const levels = readRecords(errorLog).map((record) => record.level as number);
    expect(levels.length).toBeGreaterThan(0);
    expect(levels.every((level) => level >= 50)).toBe(true);
  });
});

describe('unwritable file sinks (#497)', () => {
  /** The single warning naming every dropped file sink. */
  function droppedSinkWarnings(stderr: string): Array<Record<string, unknown>> {
    return parseLogLines(stderr).filter(
      (record) => record.level === 40 && String(record.msg).includes('File logging disabled'),
    );
  }

  it.skipIf(RUNNING_AS_ROOT)(
    'serves tools/call and exits 0 when LOGS_DIR is an existing read-only directory',
    async () => {
      const logsDir = makeTempDir('mcp-logger-ro-');
      chmodSync(logsDir, 0o555);

      const run = await runStdioSession({
        entry: SERVER_FIXTURE,
        env: { LOGS_DIR: logsDir, MCP_LOG_LEVEL: 'info', NODE_ENV: 'production' },
        requests: [
          { method: 'tools/call', params: { name: 'echo_logged', arguments: { message: 'hi' } } },
        ],
      });

      expect(run.responses[0]?.result).toMatchObject({ structuredContent: { message: 'hi' } });
      expect(run.stillAlive).toBe(false);
      expect(run.code).toBe(0);
      expect(run.stderr).toContain('echo_logged handler ran');

      const warnings = droppedSinkWarnings(run.stderr);
      expect(warnings).toHaveLength(1);
      for (const file of ['combined.log', 'error.log', 'interactions.log']) {
        expect(warnings[0]?.msg).toContain(join(logsDir, file));
      }
      expect(warnings[0]?.msg).toContain('EACCES');
    },
  );

  it('serves tools/call and exits 0 when LOGS_DIR sits under a file', async () => {
    const logsDir = '/dev/null/mcp-logger-test';

    const run = await runStdioSession({
      entry: SERVER_FIXTURE,
      env: { LOGS_DIR: logsDir, MCP_LOG_LEVEL: 'info', NODE_ENV: 'production' },
      requests: [
        { method: 'tools/call', params: { name: 'echo_logged', arguments: { message: 'hi' } } },
      ],
    });

    expect(run.responses[0]?.result).toMatchObject({ structuredContent: { message: 'hi' } });
    expect(run.stillAlive).toBe(false);
    expect(run.code).toBe(0);

    const warnings = droppedSinkWarnings(run.stderr);
    expect(warnings).toHaveLength(1);
    for (const file of ['combined.log', 'error.log', 'interactions.log']) {
      expect(warnings[0]?.msg).toContain(join(logsDir, file));
    }
    expect(warnings[0]?.msg).toContain('ENOTDIR');
  });

  it.skipIf(RUNNING_AS_ROOT)(
    'drops only a read-only error.log and keeps the other file sinks writing',
    async () => {
      const logsDir = makeTempDir('mcp-logger-ro-file-');
      const errorLog = join(logsDir, 'error.log');
      writeFileSync(errorLog, '');
      chmodSync(errorLog, 0o444);
      const combined = join(logsDir, 'combined.log');
      const interactions = join(logsDir, 'interactions.log');

      const run = await runLoggerFixture(
        { FIXTURE_START_LEVEL: 'info', LOGS_DIR: logsDir },
        (stderr) =>
          stderr.includes(BARRIER) &&
          readMessages(combined).includes(BARRIER) &&
          readRecords(interactions).some((r) => r.interactionName === 'fixture-interaction'),
      );

      expect(run.code).toBe(0);
      expect(readFileSync(errorLog, 'utf8')).toBe('');
      const warnings = droppedSinkWarnings(run.stderr);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.msg).toContain(errorLog);
      expect(warnings[0]?.msg).toContain('EACCES');
      expect(warnings[0]?.msg).not.toContain(combined);
      expect(warnings[0]?.msg).not.toContain(interactions);
    },
  );

  it('creates and writes all three files when the directory is writable', async () => {
    const logsDir = join(makeTempDir('mcp-logger-rw-'), 'nested', 'logs');
    const combined = join(logsDir, 'combined.log');
    const errorLog = join(logsDir, 'error.log');
    const interactions = join(logsDir, 'interactions.log');

    const run = await runLoggerFixture(
      { FIXTURE_START_LEVEL: 'info', LOGS_DIR: logsDir },
      (stderr) =>
        stderr.includes(BARRIER) &&
        readMessages(combined).includes(BARRIER) &&
        readMessages(errorLog).includes(BARRIER) &&
        readRecords(interactions).some((r) => r.interactionName === 'fixture-interaction'),
    );

    expect(run.code).toBe(0);
    expect(droppedSinkWarnings(run.stderr)).toHaveLength(0);
  });
});

/**
 * @fileoverview `composeServices` and `createApp` let `./.env` contribute before
 * their raw environment reads (#634): the `sessionMode.default` seed, the
 * `OTEL_SERVICE_*` seeds, and the `MCP_TRANSPORT_TYPE` read that decides
 * whether to suppress colors. Each case imports a fresh module graph whose
 * config has never been read, so the load these entry points trigger is the
 * process's first.
 * @module tests/unit/core/app.dotenv.test
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The object `process.loadEnvFile()` writes to; every case runs with it as `process.env`. */
const liveEnv = process.env;
const nativeLoad = process.loadEnvFile.bind(process);
const originalIsTTY = process.stdout.isTTY;

/** Every variable a case, its `.env`, or the code under test writes. */
const KEYS = [
  'DEBUG',
  'FORCE_COLOR',
  'MCP_LOG_LEVEL',
  'MCP_SERVER_NAME',
  'MCP_SERVER_VERSION',
  'MCP_SESSION_MODE',
  'MCP_TRANSPORT_TYPE',
  'NO_COLOR',
  'OTEL_SERVICE_NAME',
  'OTEL_SERVICE_VERSION',
] as const;

const saved = new Map<string, string | undefined>();
const tempDirs: string[] = [];

/** Routes `process.loadEnvFile()` to a real `.env` holding `contents`. */
function useEnvFile(contents: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-app-env-'));
  tempDirs.push(dir);
  const path = join(dir, '.env');
  writeFileSync(path, contents);
  return vi.spyOn(process, 'loadEnvFile').mockImplementation(() => nativeLoad(path));
}

/** Makes `process.exit` throw, so a startup failure ends `createApp()` with a rejection. */
function stubExit() {
  return vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
}

/** Captures stderr instead of writing it. */
function captureStderr(): () => string {
  let text = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    text += String(chunk);
    return true;
  });
  return () => text;
}

describe('composeServices and createApp read .env before their raw environment reads (#634)', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of KEYS) {
      saved.set(key, liveEnv[key]);
      delete liveEnv[key];
    }
    process.env = liveEnv;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = liveEnv;
    process.stdout.isTTY = originalIsTTY;
    for (const [key, value] of saved) {
      if (value === undefined) delete liveEnv[key];
      else liveEnv[key] = value;
    }
    saved.clear();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('lets a .env MCP_SESSION_MODE and OTEL_SERVICE_* win over the createApp options', async () => {
    useEnvFile(
      'MCP_SESSION_MODE=stateless\nOTEL_SERVICE_NAME=from-dotenv\nOTEL_SERVICE_VERSION=7.0.0\n',
    );
    const { composeServices } = await import('@/core/app.js');
    const { config } = await import('@/config/index.js');

    const composed = await composeServices({
      name: 'from-option',
      sessionMode: { default: 'stateful' },
      version: '1.2.3',
    });
    composed.coreServices.rateLimiter.dispose();

    expect(config.mcpSessionMode).toBe('stateless');
    expect(composed.manifest.transport.sessionMode).toBe('stateless');
    expect(config.openTelemetry.serviceName).toBe('from-dotenv');
    expect(config.openTelemetry.serviceVersion).toBe('7.0.0');
    expect(config.mcpServerName).toBe('from-option');
  });

  it('keeps colors on for a TTY when MCP_TRANSPORT_TYPE=http is set only in .env', async () => {
    useEnvFile('MCP_TRANSPORT_TYPE=http\n');
    // An invalid framework variable stops createApp() at its first config
    // read, which comes right after the color decision.
    liveEnv.MCP_LOG_LEVEL = 'not-a-level';
    process.stdout.isTTY = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    captureStderr();
    const exit = stubExit();
    const { createApp } = await import('@/core/app.js');

    await expect(createApp()).rejects.toThrow('process.exit(1)');

    expect(exit).toHaveBeenCalledWith(1);
    expect(liveEnv.MCP_TRANSPORT_TYPE).toBe('http');
    expect(liveEnv.NO_COLOR).toBeUndefined();
    expect(liveEnv.FORCE_COLOR).toBeUndefined();
  });

  it('reports a .env load failure through the startup banner, after retrying the load', async () => {
    const load = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      throw new TypeError('Contents of .env should be a valid string.');
    });
    const stderr = captureStderr();
    const exit = stubExit();
    const { createApp } = await import('@/core/app.js');

    await expect(createApp()).rejects.toThrow('process.exit(1)');

    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr()).toContain('Configuration error — server failed to start');
    expect(stderr()).toContain('Failed to load .env from the working directory.');
    // createApp()'s early attempt deferred the failure; its startup boundary retried and reported it.
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('reports a .env load failure through the startup banner when no framework config read follows', async () => {
    const load = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      throw new TypeError('Contents of .env should be a valid string.');
    });
    const stderr = captureStderr();
    const exit = stubExit();
    // A config cached from overrides is never re-parsed, so no config read retries the load.
    const { resetConfig } = await import('@/config/index.js');
    resetConfig({ MCP_LOG_LEVEL: 'info' });
    const { createApp } = await import('@/core/app.js');
    const setup = vi.fn(() => {
      throw new Error('setup() ran');
    });

    await expect(createApp({ setup })).rejects.toThrow('process.exit(1)');

    expect(exit).toHaveBeenCalledWith(1);
    expect(setup).not.toHaveBeenCalled();
    expect(stderr()).toContain('Failed to load .env from the working directory.');
    expect(load).toHaveBeenCalledTimes(2);
  });
});

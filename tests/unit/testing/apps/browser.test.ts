/**
 * @fileoverview Tests for browser discovery and launch in the headless MCP Apps host.
 * Discovery runs against a temporary Puppeteer cache under a stubbed home directory;
 * launch runs a stand-in process that speaks CDP on fds 3 and 4, never a browser.
 * @module tests/unit/testing/apps/browser.test
 */

import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { BROWSER_PATH_ENV, discoverBrowser, launchBrowser } from '@/testing/apps/browser.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { writeStandIn } from './stand-in-process.js';

const INSTALL_HINT = 'npx @puppeteer/browsers install chrome-headless-shell@stable';

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'mcp-apps-browser-test-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Write a do-nothing shell script at `file` with `mode`, creating its directory. */
async function writeExecutable(file: string, mode = 0o755) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '#!/bin/sh\nexit 0\n');
  await chmod(file, mode);
  return file;
}

async function rejection(promise: Promise<unknown>): Promise<Error & { data?: unknown }> {
  const err = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(err).toBeMcpError(JsonRpcErrorCode.ConfigurationError);
  expect(err).toMatchObject({ data: { reason: 'browser_unavailable' } });
  return err as Error;
}

/** Pretend to run on `platform`/`arch` for one test. */
function onPlatform(platform: string, arch: string): void {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  restorers.push(() => {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    if (archDescriptor) Object.defineProperty(process, 'arch', archDescriptor);
  });
}

const restorers: (() => void)[] = [];

describe('discoverBrowser', () => {
  let home: string;
  let cache: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(scratch, 'home-'));
    cache = path.join(home, '.cache', 'puppeteer', 'chrome-headless-shell');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv(BROWSER_PATH_ENV, '');
    onPlatform('darwin', 'arm64');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const restore of restorers.splice(0)) restore();
  });

  /** A cached build: `<folder>-<build>/chrome-headless-shell-<suffix>/<exe>`. */
  function build(dirName: string, exe = 'chrome-headless-shell', mode = 0o755) {
    return writeExecutable(path.join(cache, dirName, 'chrome-headless-shell-mac-arm64', exe), mode);
  }

  it('picks the newest build by numeric build id, not by string order', async () => {
    await build('mac_arm-99.0.4844.51');
    await build('mac_arm-138.0.7204.168');
    const newest = await build('mac_arm-138.0.7204.1000');
    await build('mac_arm-138.0');
    await expect(discoverBrowser()).resolves.toBe(newest);
  });

  it('compares build ids of different lengths, treating missing parts as zero', async () => {
    const longer = await build('mac_arm-120.0.1');
    await build('mac_arm-120');
    await build('mac_arm-120.0');
    await build('mac_arm-120.0.0');
    await build('mac_arm-119.9.9.9');
    await expect(discoverBrowser()).resolves.toBe(longer);
  });

  it('skips a build entry that is a file rather than a folder', async () => {
    const usable = await build('mac_arm-100.0');
    await writeExecutable(path.join(cache, 'mac_arm-200.0'));
    await expect(discoverBrowser()).resolves.toBe(usable);
  });

  it('ignores other platforms, malformed build ids, and folders that are not builds', async () => {
    const usable = await build('mac_arm-100.0');
    await build('linux-200.0');
    await build('mac_arm-latest');
    await build('mac_arm-');
    await writeExecutable(
      path.join(cache, 'mac_arm-300.0', 'unrelated-folder', 'chrome-headless-shell'),
    );
    await expect(discoverBrowser()).resolves.toBe(usable);
  });

  it('falls back to an older build when the newest one is not runnable', async () => {
    const usable = await build('mac_arm-100.0');
    await build('mac_arm-200.0', 'chrome-headless-shell', 0o644);
    await mkdir(path.join(cache, 'mac_arm-300.0'), { recursive: true });
    await expect(discoverBrowser()).resolves.toBe(usable);
  });

  it('fails with the install command when the cache is missing', async () => {
    const err = await rejection(discoverBrowser());
    expect(err.message).toContain(
      `No browser found: ${cache} holds no chrome-headless-shell build for mac_arm.`,
    );
    expect(err.message).toContain(INSTALL_HINT);
    expect(err.message).toContain(BROWSER_PATH_ENV);
  });

  it('fails with the install command when the cache holds no usable build', async () => {
    await build('mac_arm-100.0', 'chrome-headless-shell', 0o644);
    const err = await rejection(discoverBrowser());
    expect(err.message).toContain(INSTALL_HINT);
  });

  it.each([
    ['darwin', 'x64', 'mac', 'chrome-headless-shell'],
    ['linux', 'x64', 'linux', 'chrome-headless-shell'],
    ['linux', 'arm64', 'linux_arm', 'chrome-headless-shell'],
    ['win32', 'x64', 'win64', 'chrome-headless-shell.exe'],
    ['win32', 'arm64', 'win64', 'chrome-headless-shell.exe'],
    ['win32', 'ia32', 'win32', 'chrome-headless-shell.exe'],
  ])('maps %s/%s to the %s cache folder', async (platform, arch, folder, exe) => {
    onPlatform(platform, arch);
    const file = await writeExecutable(
      path.join(cache, `${folder}-131.0.6778.85`, `chrome-headless-shell-${folder}`, exe),
    );
    await expect(discoverBrowser()).resolves.toBe(file);
  });

  it('fails on a platform chrome-headless-shell has no build for', async () => {
    onPlatform('aix', 'ppc64');
    const err = await rejection(discoverBrowser());
    expect(err.message).toBe('No browser found: chrome-headless-shell has no build for aix/ppc64.');
  });

  it('returns an explicit executable path as given', async () => {
    const file = await writeExecutable(path.join(home, 'bin', 'my-shell'));
    await expect(discoverBrowser(file)).resolves.toBe(file);
  });

  it('fails on an explicit path that does not exist, without falling back to the cache', async () => {
    await build('mac_arm-100.0');
    const missing = path.join(home, 'nowhere', 'chrome-headless-shell');
    const err = await rejection(discoverBrowser(missing));
    expect(err.message).toBe(`The browser path ${missing} does not exist.`);
  });

  it('fails on an explicit path that runs through a file', async () => {
    const file = await writeExecutable(path.join(home, 'bin', 'plain'));
    const err = await rejection(discoverBrowser(path.join(file, 'child')));
    expect(err.message).toContain('does not exist.');
  });

  it('fails on an explicit path that is a directory', async () => {
    await build('mac_arm-100.0');
    const dir = path.join(home, 'a-directory');
    await mkdir(dir);
    const err = await rejection(discoverBrowser(dir));
    expect(err.message).toBe(
      `The browser path ${dir} is not a file. Point it at the browser executable itself.`,
    );
  });

  it('fails on an explicit path that is not executable, without falling back', async () => {
    await build('mac_arm-100.0');
    const file = await writeExecutable(path.join(home, 'bin', 'not-executable'), 0o644);
    const err = await rejection(discoverBrowser(file));
    expect(err.message).toBe(`The browser path ${file} is not executable.`);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails on an explicit path that cannot be read',
    async () => {
      const locked = path.join(home, 'locked');
      const file = await writeExecutable(path.join(locked, 'chrome-headless-shell'));
      await chmod(locked, 0o000);
      try {
        const err = await rejection(discoverBrowser(file));
        expect(err.message).toBe(`The browser path ${file} cannot be read (EACCES).`);
      } finally {
        await chmod(locked, 0o755);
      }
    },
  );

  it(`uses ${BROWSER_PATH_ENV} when no path is passed, and fails on it without falling back`, async () => {
    await build('mac_arm-100.0');
    const file = await writeExecutable(path.join(home, 'bin', 'from-env'));
    vi.stubEnv(BROWSER_PATH_ENV, file);
    await expect(discoverBrowser()).resolves.toBe(file);

    const missing = path.join(home, 'bin', 'missing');
    vi.stubEnv(BROWSER_PATH_ENV, missing);
    const err = await rejection(discoverBrowser());
    expect(err.message).toBe(`The browser path ${missing} does not exist.`);
  });

  it(`prefers an explicit path over ${BROWSER_PATH_ENV}`, async () => {
    const explicit = await writeExecutable(path.join(home, 'bin', 'explicit'));
    vi.stubEnv(BROWSER_PATH_ENV, path.join(home, 'bin', 'missing'));
    await expect(discoverBrowser(explicit)).resolves.toBe(explicit);
  });
});

describe('launchBrowser', () => {
  let standIn: string;

  beforeAll(async () => {
    const dir = path.join(scratch, 'stand-in');
    await mkdir(dir, { recursive: true });
    standIn = await writeStandIn(dir, 'browser-stand-in', STAND_IN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function profiles(): Promise<string[]> {
    return (await readdir(os.tmpdir())).filter((name) => name.startsWith('mcp-apps-host-'));
  }

  it('launches headless over a pipe on a fresh profile, then closes and deletes it', async () => {
    const browser = await launchBrowser(standIn);
    expect(browser.executable).toBe(standIn);
    expect(path.basename(browser.profileDir)).toMatch(/^mcp-apps-host-/);
    expect(existsSync(browser.profileDir)).toBe(true);
    await vi.waitFor(() => expect(browser.process.stderrTail()).toContain('about:blank'));
    const argv = browser.process.stderrTail();
    expect(argv).toContain('--headless');
    expect(argv).toContain('--remote-debugging-pipe');
    expect(argv).toContain(`--user-data-dir=${browser.profileDir}`);
    expect(argv).toContain('about:blank');

    const closing = browser.close();
    expect(browser.close()).toBe(closing);
    await closing;
    await expect(browser.process.exited).resolves.toEqual({ code: 0, signal: null });
    expect(browser.process.cdp.isClosed).toBe(true);
    expect(existsSync(browser.profileDir)).toBe(false);
  });

  it('kills the process by its PID when it does not exit after Browser.close', async () => {
    vi.stubEnv('STAND_IN_MODE', 'linger');
    const browser = await launchBrowser(standIn);
    await browser.close();
    await expect(browser.process.exited).resolves.toEqual({ code: null, signal: 'SIGKILL' });
    expect(existsSync(browser.profileDir)).toBe(false);
  }, 15_000);

  it('still waits for the exit when Browser.close answers with an error', async () => {
    vi.stubEnv('STAND_IN_MODE', 'refuse-close');
    const browser = await launchBrowser(standIn);
    await browser.close();
    await expect(browser.process.exited).resolves.toEqual({ code: 0, signal: null });
    expect(existsSync(browser.profileDir)).toBe(false);
  });

  it('skips Browser.close when the pipe is already closed', async () => {
    const browser = await launchBrowser(standIn);
    browser.process.cdp.close();
    await browser.close();
    expect(existsSync(browser.profileDir)).toBe(false);
  });

  it('fails naming the stderr tail when the process exits before answering, and cleans up', async () => {
    vi.stubEnv('STAND_IN_MODE', 'crash');
    const before = await profiles();
    const err = await rejection(launchBrowser(standIn));
    expect(err.message).toContain(`The browser at ${standIn} failed to start:`);
    expect(err.message).toContain('(stand-in: cannot start)');
    expect(await profiles()).toEqual(before);
  });

  it('fails without a stderr suffix when the process writes nothing', async () => {
    vi.stubEnv('STAND_IN_MODE', 'silent-crash');
    const err = await rejection(launchBrowser(standIn));
    expect(err.message).toMatch(
      /failed to start: Browser\.getVersion: the browser (exited with code 3|closed the DevTools pipe)$/,
    );
  });

  it('fails with the spawn error and deletes the profile when the executable cannot start', async () => {
    const before = await profiles();
    const missing = path.join(scratch, 'stand-in', 'missing-browser');
    const err = await rejection(launchBrowser(missing));
    expect(err.message).toMatch(new RegExp(`^Could not launch ${missing}: .*ENOENT`));
    expect(await profiles()).toEqual(before);
  });
});

/**
 * A stand-in browser: prints its argv to stderr, answers every command on fd 3 on fd 4,
 * and exits after `Browser.close`. `STAND_IN_MODE=linger` answers `Browser.close` but stays
 * up; `refuse-close` answers it with a protocol error, then exits; `crash` and
 * `silent-crash` exit 3 before answering anything.
 */
const STAND_IN = `const mode = process.env.STAND_IN_MODE ?? 'normal';
if (mode === 'crash') { process.stderr.write('stand-in: cannot start\\n'); process.exit(3); }
if (mode === 'silent-crash') process.exit(3);
process.stderr.write(process.argv.slice(2).join(' ') + '\\n');
if (mode === 'linger') setInterval(() => {}, 1000);
let buffered = '';
input.on('data', (chunk) => {
  buffered += chunk.toString('utf8');
  let end;
  while ((end = buffered.indexOf('\\0')) !== -1) {
    const message = JSON.parse(buffered.slice(0, end));
    buffered = buffered.slice(end + 1);
    const refused = message.method === 'Browser.close' && mode === 'refuse-close';
    const reply = refused ? { id: message.id, error: { code: -32000, message: 'Not allowed' } } : { id: message.id, result: {} };
    output.write(JSON.stringify(reply) + '\\0');
    if (message.method === 'Browser.close' && mode !== 'linger') output.end(() => process.exit(0));
  }
});
input.on('end', () => { if (mode !== 'linger') process.exit(0); });
`;

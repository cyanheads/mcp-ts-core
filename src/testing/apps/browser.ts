/**
 * @fileoverview Browser discovery, launch, and teardown for the headless MCP Apps host.
 * Only `chrome-headless-shell` is used: the newest build in Puppeteer's cache, or an
 * explicit executable path. Installed Chrome, Edge, Brave, and Chromium are never searched.
 * Each launch gets a fresh profile directory; teardown stops the process by its own PID
 * and deletes the profile.
 * @module src/testing/apps/browser
 */

import { constants } from 'node:fs';
import { access, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { configurationError, type ErrorFactoryOptions } from '@/types-global/errors.js';

import { type PipedProcess, spawnPiped } from './cdp-pipe.js';

/** Environment variable naming the browser executable; when set, the only candidate. */
export const BROWSER_PATH_ENV = 'MCP_APPS_BROWSER_PATH';

/** `--path` matters: without it `@puppeteer/browsers` installs into the working directory. */
const INSTALL_HINT =
  'npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer';

/** Launch flags, besides the profile directory. */
const LAUNCH_FLAGS: readonly string[] = [
  '--headless',
  '--remote-debugging-pipe',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-domain-reliability',
  '--disable-extensions',
  '--disable-sync',
  '--disable-breakpad',
  '--no-pings',
  '--mute-audio',
  '--hide-scrollbars',
  '--site-per-process',
];

const browserUnavailable = (message: string, options?: ErrorFactoryOptions) =>
  configurationError(message, { reason: 'browser_unavailable' }, options);

/**
 * The executable to launch. An explicit path (option, then `MCP_APPS_BROWSER_PATH`) that is
 * not an executable file fails with no fallback; otherwise the newest cached build.
 */
export async function discoverBrowser(explicitPath?: string): Promise<string> {
  const browserPath = explicitPath ?? (process.env[BROWSER_PATH_ENV] || undefined);
  if (browserPath !== undefined) {
    const problem = await launchProblem(browserPath);
    if (problem) throw browserUnavailable(`The browser path ${browserPath} ${problem}`);
    return browserPath;
  }
  const folder = puppeteerPlatform(process.platform, process.arch);
  if (!folder) {
    throw browserUnavailable(
      `No browser found: chrome-headless-shell has no build for ${process.platform}/${process.arch}.`,
    );
  }
  const root = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome-headless-shell');
  const found = await newestHeadlessShell(root, folder);
  if (found) return found;
  throw browserUnavailable(
    `No browser found: ${root} holds no chrome-headless-shell build for ${folder}. Install one with \`${INSTALL_HINT}\`, or pass an executable path (--browser, or ${BROWSER_PATH_ENV}).`,
  );
}

/** A launched browser with its throwaway profile. */
export interface LaunchedBrowser {
  /** Stop the process by its PID and delete the profile directory. Idempotent. */
  close(): Promise<void>;
  readonly executable: string;
  readonly process: PipedProcess;
  readonly profileDir: string;
}

/** Launch `executable` headless over a CDP pipe on a fresh profile. */
export async function launchBrowser(executable: string): Promise<LaunchedBrowser> {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-apps-host-'));
  const proc = await spawnPiped(executable, [
    ...LAUNCH_FLAGS,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ]).catch(async (err: unknown) => {
    await rm(profileDir, { recursive: true, force: true });
    throw browserUnavailable(`Could not launch ${executable}: ${errorMessage(err)}`, {
      cause: err,
    });
  });
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      if (!proc.cdp.isClosed) {
        await proc.cdp
          .send('Browser.close', {}, { signal: AbortSignal.timeout(2_000) })
          .catch(() => {});
      }
      const exited = await Promise.race([
        proc.exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000).unref()),
      ]);
      if (!exited) {
        proc.kill();
        await proc.exited;
      }
      proc.cdp.close();
      await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    })();
    return closing;
  };
  try {
    await proc.cdp.send('Browser.getVersion', {}, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    await close();
    const stderr = proc.stderrTail().trim().split('\n').at(-1);
    throw browserUnavailable(
      `The browser at ${executable} failed to start: ${errorMessage(err)}${stderr ? ` (${stderr})` : ''}`,
      { cause: err },
    );
  }
  return { executable, process: proc, profileDir, close };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The platform prefix `@puppeteer/browsers` gives each build folder in its cache. */
function puppeteerPlatform(platform: NodeJS.Platform, arch: string): string | undefined {
  switch (platform) {
    case 'darwin':
      return arch === 'arm64' ? 'mac_arm' : 'mac';
    case 'linux':
      return arch === 'arm64' ? 'linux_arm' : 'linux';
    case 'win32':
      return arch === 'x64' || arch === 'arm64' ? 'win64' : 'win32';
    default:
      return undefined;
  }
}

/** The executable of the newest `<folder>-<buildId>` build under `root`. */
async function newestHeadlessShell(root: string, folder: string): Promise<string | undefined> {
  const prefix = `${folder}-`;
  const exe = folder.startsWith('win') ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  const builds = (await readdir(root).catch(() => []))
    .filter((name) => name.startsWith(prefix) && /^\d+(\.\d+)*$/.test(name.slice(prefix.length)))
    .sort((a, b) => compareBuildIds(b.slice(prefix.length), a.slice(prefix.length)));
  for (const build of builds) {
    const dir = path.join(root, build);
    for (const sub of await readdir(dir).catch(() => [])) {
      if (!sub.startsWith('chrome-headless-shell-')) continue;
      const file = path.join(dir, sub, exe);
      if (!(await launchProblem(file))) return file;
    }
  }
  return undefined;
}

function compareBuildIds(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Why `file` cannot be launched, as the end of a sentence; undefined when it can. */
async function launchProblem(file: string): Promise<string | undefined> {
  const info = await stat(file).catch((err: NodeJS.ErrnoException) => err);
  if (info instanceof Error) {
    return info.code === 'ENOENT' || info.code === 'ENOTDIR'
      ? 'does not exist.'
      : `cannot be read (${info.code}).`;
  }
  if (!info.isFile()) return 'is not a file. Point it at the browser executable itself.';
  const runnable = await access(file, constants.X_OK).then(
    () => true,
    () => false,
  );
  return runnable ? undefined : 'is not executable.';
}

/**
 * @fileoverview The once-per-process load of `./.env` into `process.env`,
 * shared by framework config (`parseConfig`), server config
 * (`parseEnvConfig`), and the raw environment reads `createApp()` and
 * `composeServices()` make before either parses. Whichever reads the process
 * environment first loads the file; nothing loads it at import, so a test or
 * a script that imports the package can still set up the environment first.
 * @module src/config/envFile
 */
import { statSync } from 'node:fs';

import { configurationError } from '../types-global/errors.js';
import { runtimeCaps } from '../utils/internal/runtime.js';

let loaded = false;

/**
 * Whether a load failure means there is no `.env` to read. Node's
 * `process.loadEnvFile()` reports an existing file it cannot read as `ENOENT`
 * too — mode `000`, or a symlink into a directory the process cannot search —
 * so a `stat` of the same relative path decides: only nothing there (a symlink
 * to nothing included) is missing. `existsSync` would answer `false` for the
 * unsearchable directory as well, since it swallows `EACCES`.
 */
function isMissingEnvFile(error: unknown): boolean {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return false;
  try {
    return statSync('.env', { throwIfNoEntry: false }) === undefined;
  } catch {
    return false;
  }
}

/**
 * Loads `./.env` from the working directory into `process.env`, at most once
 * per process, with Node's native `process.loadEnvFile()`. Variables already
 * set are never overridden. A missing file is the normal case and counts as
 * loaded. Does nothing outside a Node or Bun process, so a Worker never reads
 * a file.
 *
 * @throws {McpError} `ConfigurationError` when the file exists but cannot be
 *   loaded (unreadable, a directory). The load is not marked done, so the
 *   next call tries again.
 */
export function loadEnvFile(): void {
  if (loaded || !runtimeCaps.isNode || runtimeCaps.isWorkerLike) return;
  try {
    process.loadEnvFile();
  } catch (error) {
    if (!isMissingEnvFile(error)) {
      throw configurationError(
        'Failed to load .env from the working directory.',
        { cwd: process.cwd() },
        { cause: error },
      );
    }
  }
  loaded = true;
}

/**
 * {@link loadEnvFile} for a read that runs before `createApp()`'s startup
 * error boundary — server config parsed at import, the raw reads at the top of
 * `createApp()` and `composeServices()`. A load failure is left for a later
 * {@link loadEnvFile} to retry and throw: `createApp()`'s startup boundary,
 * which reports it through the banner, or outside `createApp()` the next
 * framework config read (`parseConfig()`, the `config` proxy).
 */
export function preloadEnvFile(): void {
  try {
    loadEnvFile();
  } catch {
    // Deferred: the flag stays unset, so the next loadEnvFile() retries the load and throws.
  }
}

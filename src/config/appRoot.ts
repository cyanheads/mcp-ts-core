/**
 * @fileoverview Resolves the consuming application's root — the directory of
 * the nearest `package.json` at or above the process entry module. Server
 * identity (name, version, description, keywords) and relative filesystem
 * paths anchor here, so they follow the installed server rather than whatever
 * directory the launching client happened to be in.
 * @module src/config/appRoot
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

import { runtimeCaps } from '../utils/internal/runtime.js';

/** The subset of `package.json` fields that feed server identity. */
export type PackageManifest = {
  name?: string;
  version?: string;
  description?: string;
  keywords?: string[];
};

/** A resolved application root: the manifest and the directory holding it. */
export interface AppRoot {
  /** Absolute path to the directory containing the manifest. */
  dir: string;
  /** The identity fields read from that directory's `package.json`. */
  manifest: PackageManifest;
}

/** Reads the identity fields of `<dir>/package.json`, or `undefined` if absent/unreadable. */
function readManifest(dir: string): PackageManifest | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
  const manifest: PackageManifest = {};
  if (typeof parsed.name === 'string') manifest.name = parsed.name;
  if (typeof parsed.version === 'string') manifest.version = parsed.version;
  if (typeof parsed.description === 'string') manifest.description = parsed.description;
  if (Array.isArray(parsed.keywords)) {
    manifest.keywords = parsed.keywords.filter((k): k is string => typeof k === 'string');
  }
  return manifest;
}

/** Walks up from `startDir` and returns the first directory holding a readable `package.json`. */
function findManifestUpward(startDir: string): AppRoot | undefined {
  let dir = startDir;
  for (;;) {
    const manifest = readManifest(dir);
    if (manifest) return { dir, manifest };
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Returns the directory that owns the `node_modules` tree containing `dir`,
 * or `undefined` when `dir` is not inside one.
 */
function nodeModulesOwner(dir: string): string | undefined {
  const segments = dir.split(sep);
  const index = segments.lastIndexOf('node_modules');
  if (index <= 0) return undefined;
  return segments.slice(0, index).join(sep) || sep;
}

/** Absolute, symlink-resolved path, or `undefined` when it cannot be read. */
function realPath(path: string): string | undefined {
  try {
    return realpathSync(resolve(path));
  } catch {
    return undefined;
  }
}

/**
 * Directory of the process entry module. `process.argv[1]` may name a file, a
 * directory (`node .`), or a symlinked bin shim, so the path is resolved
 * through the filesystem before its directory is taken.
 */
function entryDirectory(): string | undefined {
  const entry = process.argv[1];
  if (!entry) return undefined;
  const real = realPath(entry);
  if (!real) return undefined;
  try {
    return statSync(real).isDirectory() ? real : dirname(real);
  } catch {
    return dirname(real);
  }
}

/**
 * Resolves the application root without consulting the cache.
 *
 * Resolution order:
 *
 * 1. The nearest `package.json` at or above the entry module (`process.argv[1]`).
 *    This is the installed server's own package on every stdio launch path —
 *    `npx`, `.mcpb` bundles, a client config naming `dist/index.js` — none of
 *    which run from the package root.
 * 2. When that manifest belongs to a tool installed under the application's own
 *    `node_modules` and the process runs from the directory owning it — a test
 *    runner spawning the process is the common case — the owning directory's
 *    manifest wins. A dependency's manifest is never the application's identity.
 * 3. The nearest `package.json` at or above `process.cwd()`, when there is no
 *    entry module to anchor on (`node -e`, an embedded host).
 */
function computeAppRoot(): AppRoot | undefined {
  if (!runtimeCaps.isNode || !runtimeCaps.hasProcess || runtimeCaps.isWorkerLike) return undefined;

  const cwd = realPath(process.cwd());
  const entryDir = entryDirectory();
  const fromEntry = entryDir ? findManifestUpward(entryDir) : undefined;
  if (!fromEntry) return cwd ? findManifestUpward(cwd) : undefined;

  const owner = nodeModulesOwner(fromEntry.dir);
  if (owner && owner === cwd) {
    const manifest = readManifest(owner);
    if (manifest) return { dir: owner, manifest };
  }
  return fromEntry;
}

let _appRoot: AppRoot | undefined;
let _resolved = false;

/**
 * Resolves the consuming application's root, cached after the first call — the
 * install location does not change at runtime. See {@link computeAppRoot} for
 * the resolution order.
 *
 * @returns The resolved root, or `undefined` in Workers and when no manifest is found.
 */
export function resolveAppRoot(): AppRoot | undefined {
  if (!_resolved) {
    _appRoot = computeAppRoot();
    _resolved = true;
  }
  return _appRoot;
}

/**
 * Clears the cached root so the next {@link resolveAppRoot} call re-resolves.
 * Exists for tests that move the entry module or working directory.
 */
export function resetAppRootCache(): void {
  _appRoot = undefined;
  _resolved = false;
}

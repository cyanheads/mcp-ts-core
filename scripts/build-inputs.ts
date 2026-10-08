/**
 * @fileoverview Repo-relative paths whose mtime determines whether `dist/` is
 * stale. Shared so the package verifier and the integration-test harness cannot
 * drift apart — a build input added to only one of them would silently weaken
 * that side's freshness check.
 * @module scripts/build-inputs
 */

/** Repo-relative build inputs, resolved against the repo root by each consumer. */
export const BUILD_INPUT_PATHS = [
  'src',
  'package.json',
  'scripts/build.ts',
  'tsconfig.json',
  'config/tsconfig.base.json',
  'config/tsconfig.build.json',
] as const;

/**
 * Whether a freshness walk of a build input directory counts an entry: a
 * TypeScript source or a JSON module, or a directory it descends into for
 * them — never a dotfile or dot-directory, which tsc's wildcards skip, so a
 * Finder `.DS_Store` or an editor's swap or backup file cannot mark `dist/`
 * stale. A directory's own mtime is never counted, only the files under it.
 */
export function readByBuild(name: string, directory: boolean): boolean {
  if (name.startsWith('.')) return false;
  return directory || /\.(?:[cm]?ts|tsx|json)$/.test(name);
}

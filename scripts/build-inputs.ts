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
  'tsconfig.base.json',
  'tsconfig.build.json',
] as const;

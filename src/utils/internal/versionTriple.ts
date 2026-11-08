/**
 * @fileoverview `X.Y.Z` version parsing and comparison for the runtime floors
 * the framework reads from its own `package.json` `engines` field: the Node.js
 * check in `createApp()` and the Bun check in the mirror store's open.
 * @module src/utils/internal/versionTriple
 */

/** A version's major, minor, and patch numbers. */
export type VersionTriple = readonly [major: number, minor: number, patch: number];

/**
 * The `X.Y.Z` a version string starts with, as numbers. A prerelease or build
 * suffix is ignored, so a nightly or release candidate is judged by the release
 * it precedes; a string with no leading `X.Y.Z` yields `undefined`.
 */
export function parseVersionTriple(version: string): VersionTriple | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** The floor an `engines` range states when it is one `>=X.Y.Z` comparator; `undefined` for any other range. */
export function enginesFloor(range: string): VersionTriple | undefined {
  return range.startsWith('>=') ? parseVersionTriple(range.slice(2)) : undefined;
}

/** Whether `version` sorts below `floor`, comparing major, then minor, then patch. */
export function isBelow(version: VersionTriple, floor: VersionTriple): boolean {
  return (version[0] - floor[0] || version[1] - floor[1] || version[2] - floor[2]) < 0;
}

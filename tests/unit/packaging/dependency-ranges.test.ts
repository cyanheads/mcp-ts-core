/**
 * @fileoverview Structural test: a package listed in both `dependencies` and
 * `peerDependencies` must carry the same range in each. A lower peer floor lets
 * a consumer's older copy satisfy the peer while the framework nests its own,
 * splitting types across two installs (the TS2883 portability error for zod).
 * @module tests/unit/packaging/dependency-ranges.test
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
};

describe('package.json dependency ranges', () => {
  it('gives every package in both dependencies and peerDependencies one range', () => {
    const mismatched = Object.entries(pkg.peerDependencies)
      .filter(([name, range]) => name in pkg.dependencies && pkg.dependencies[name] !== range)
      .map(([name, range]) => `${name}: dependency ${pkg.dependencies[name]}, peer ${range}`);

    expect(mismatched).toEqual([]);
  });

  it('lists zod in both sections', () => {
    expect(pkg.dependencies.zod).toBeDefined();
    expect(pkg.peerDependencies.zod).toBe(pkg.dependencies.zod);
  });
});

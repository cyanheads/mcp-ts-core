/**
 * @fileoverview Dedicated published-package verification config.
 * @module tests/config/vitest.package
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const repoRoot = resolve(import.meta.dirname, '../..');

export default defineConfig({
  root: repoRoot,
  resolve: { tsconfigPaths: true },
  ssr: {
    noExternal: ['zod'],
  },
  test: {
    environment: 'node',
    expect: {
      requireAssertions: true,
    },
    include: ['tests/integration/package-consumer.int.test.ts'],
    maxWorkers: 1,
    isolate: true,
    pool: 'forks',
    /** A cold run packs the tarball, installs ~16 support packages, and runs two runtimes plus six `tsc` invocations — two of them over the whole public declaration graph with `skipLibCheck: false`. */
    testTimeout: 600_000,
  },
});

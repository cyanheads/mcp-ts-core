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
    /** A cold run packs the tarball and installs it into two consumer roots — a Node one with ~15 support packages and a `@types/node`-free Worker one — then runs two runtimes plus six `tsc` invocations, four of them over the public declaration graph with `skipLibCheck: false`. */
    testTimeout: 600_000,
  },
});

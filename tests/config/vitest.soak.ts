/**
 * @fileoverview Memory soak lane: sustained HTTP traffic against the built package, run on Bun.
 * @module tests/config/vitest.soak
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const repoRoot = resolve(import.meta.dirname, '../..');

export default defineConfig({
  root: repoRoot,
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    expect: { requireAssertions: true },
    include: ['tests/soak/**/*.soak.test.ts'],
    maxWorkers: 1,
    fileParallelism: false,
    isolate: true,
    pool: 'forks',
    /** 22,000 loopback requests plus server startup; a run takes well under a minute. */
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});

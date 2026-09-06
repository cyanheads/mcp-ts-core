/**
 * @fileoverview Integration lane: real server subprocesses over stdio and HTTP.
 * @module tests/config/vitest.integration
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
    expect: {
      requireAssertions: true,
    },
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['tests/integration/package-consumer.int.test.ts'],
    setupFiles: ['./tests/integration/setup.ts'],
    pool: 'forks',
    maxWorkers: 1, // Sequential — shared server processes
    isolate: true,
    testTimeout: 30_000, // Longer timeout for subprocess startup
    hookTimeout: 30_000, // Server subprocess needs time to start
  },
});

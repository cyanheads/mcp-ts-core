/**
 * @fileoverview Standalone Worker startup under the real Node-hosted Wrangler toolchain.
 * @module tests/config/vitest.worker-bundle
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const repoRoot = resolve(import.meta.dirname, '../..');

export default defineConfig({
  root: repoRoot,
  test: {
    include: ['tests/worker-bundle/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    expect: { requireAssertions: true },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: { NODE_ENV: 'test', WRANGLER_SEND_METRICS: 'false' },
  },
});

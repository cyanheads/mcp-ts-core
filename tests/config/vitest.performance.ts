/**
 * @fileoverview Opt-in I/O measurements; no machine-dependent timing thresholds.
 * @module tests/config/vitest.performance
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { benchmarkEnv } from '../benchmarks/harness/options.js';

const repoRoot = resolve(import.meta.dirname, '../..');

export default defineConfig({
  root: repoRoot,
  test: {
    maxWorkers: 1,
    fileParallelism: false,
    projects: ['http', 'worker', 'native'].map((name) => ({
      root: repoRoot,
      resolve: { tsconfigPaths: true },
      ssr: { noExternal: ['zod'] },
      test: {
        name,
        include: [`tests/benchmarks/io/${name}.perf.test.ts`],
        environment: 'node',
        pool: 'forks',
        isolate: true,
        expect: { requireAssertions: true },
        setupFiles: ['./tests/benchmarks/io/harness/setup.ts'],
        testTimeout: 120_000,
        hookTimeout: 60_000,
        env: { ...benchmarkEnv, WRANGLER_SEND_METRICS: 'false' },
      },
    })),
  },
});

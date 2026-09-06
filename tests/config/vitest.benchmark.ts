/**
 * @fileoverview Serial microbenchmarks, isolated from coverage and ordinary test timing.
 * @module tests/config/vitest.benchmark
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { benchmarkEnv } from '../benchmarks/harness/options.js';

const repoRoot = resolve(import.meta.dirname, '../..');

export default defineConfig({
  root: repoRoot,
  resolve: { tsconfigPaths: true },
  ssr: { noExternal: ['zod'] },
  test: {
    environment: 'node',
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    isolate: true,
    env: { ...benchmarkEnv },
    runner: './tests/benchmarks/harness/runner.ts',
    globalSetup: ['./tests/benchmarks/harness/environment.ts'],
    benchmark: {
      include: ['tests/benchmarks/micro/**/*.bench.ts'],
      outputJson: `reports/benchmarks/${process.versions.bun ? 'bun' : 'node'}.json`,
    },
  },
});

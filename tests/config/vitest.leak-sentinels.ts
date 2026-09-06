/**
 * @fileoverview Isolated negative probes for the leak gate; never selected by ordinary test lanes.
 * @module tests/config/vitest.leak-sentinels
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { naturalExitPool } from '../leaks/harness/pool.js';

const repoRoot = resolve(import.meta.dirname, '../..');

export default defineConfig({
  root: repoRoot,
  test: {
    include: ['tests/leaks/probes/sentinel.test.ts'],
    pool: naturalExitPool,
    maxWorkers: 1,
    isolate: true,
    runner: './tests/leaks/harness/runner.ts',
    execArgv: ['--expose-gc'],
    reporters: ['default', './tests/leaks/harness/reporter.ts'],
    expect: { requireAssertions: true },
  },
});

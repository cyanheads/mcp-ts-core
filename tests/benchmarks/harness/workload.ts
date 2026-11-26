/**
 * @fileoverview Measure one workload with the shared budget, save its result, and compare it with a saved baseline.
 * @module tests/benchmarks/harness/workload
 */
import { join } from 'node:path';
import type { BenchFn, BenchOptions, TestContext } from 'vitest';
import { benchmarkOptions, resultDirectory } from './options.js';

/**
 * Runs `fn` as the calling test's workload and writes the result to
 * `<resultDirectory>/<test name>.json`. When `BENCH_BASELINE_DIR` names an
 * earlier run's directory, the result is compared with that run's file for the
 * same workload instead, and a missing baseline file fails the test.
 *
 * `beforeAll` and `afterAll` run once per warmup and measured phase.
 */
export async function runWorkload(
  { bench, task }: Pick<TestContext, 'bench' | 'task'>,
  hooks: Pick<BenchOptions, 'afterAll' | 'beforeAll'>,
  fn: BenchFn,
): Promise<void> {
  const file = `${task.fullTestName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
  const current = bench(task.name, { ...hooks, writeResult: join(resultDirectory, file) }, fn);
  const baselineDirectory = process.env.BENCH_BASELINE_DIR;
  if (!baselineDirectory) {
    await current.run(benchmarkOptions);
    return;
  }
  await bench.compare(
    current,
    bench.from(`${task.name} (baseline)`, join(baselineDirectory, file)),
    benchmarkOptions,
  );
}

/**
 * @fileoverview Bounded, closed-loop I/O measurement with per-operation samples.
 * @module tests/benchmarks/io/harness/measure
 */
import { performance } from 'node:perf_hooks';

/** Fixed workload shape; setup and warmup are excluded from reported measurements. */
export interface Workload<T> {
  concurrency: number;
  operations: number;
  run: (index: number) => Promise<T>;
  verify: (value: T, index: number) => void;
  warmup: number;
}

/** Measure all operations, draining in-flight work before propagating any failure. */
export async function measure<T>(workload: Workload<T>) {
  async function execute(count: number) {
    let next = 0;
    let failed = false;
    const samplesMs = new Array<number>(count);
    const started = performance.now();
    const workers = Array.from({ length: Math.min(count, workload.concurrency) }, async () => {
      while (!failed && next < count) {
        const index = next++;
        try {
          const before = performance.now();
          const value = await workload.run(index);
          samplesMs[index] = performance.now() - before;
          workload.verify(value, index);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    });
    const settled = await Promise.allSettled(workers);
    const errors = settled.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length > 0) throw new AggregateError(errors, 'I/O workload failed');
    return { samplesMs, elapsedMs: performance.now() - started };
  }
  await execute(workload.warmup);
  const { samplesMs, elapsedMs } = await execute(workload.operations);
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]!;
  return {
    concurrency: workload.concurrency,
    operations: workload.operations,
    warmup: workload.warmup,
    elapsedMs,
    operationsPerSecond: workload.operations / (elapsedMs / 1000),
    latencyMs: {
      min: sorted[0]!,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: sorted.at(-1)!,
    },
    samplesMs,
  };
}

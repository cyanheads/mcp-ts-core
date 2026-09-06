/** @fileoverview Verify that performance reports cannot conceal dropped work or premature cleanup. */
import { performance } from 'node:perf_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import { measure } from '../../benchmarks/io/harness/measure.js';

afterEach(() => vi.restoreAllMocks());

it('bounds concurrency and verifies each warmup and measured operation exactly once', async () => {
  let active = 0;
  let peak = 0;
  const verified: number[] = [];
  const result = await measure({
    concurrency: 3,
    operations: 10,
    warmup: 2,
    async run(index) {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return index;
    },
    verify(value, index) {
      expect(value).toBe(index);
      verified.push(index);
    },
  });
  expect(peak).toBe(3);
  expect(active).toBe(0);
  expect(verified).toEqual([0, 1, ...Array.from({ length: 10 }, (_, i) => i)]);
  expect(result.operations).toBe(10);
  expect(result.samplesMs).toHaveLength(10);
});

it('excludes warmup and verification from latency while counting verification in throughput', async () => {
  let time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  const result = await measure({
    concurrency: 1,
    operations: 4,
    warmup: 2,
    async run(i) {
      time += i + 1;
      return i;
    },
    verify() {
      time += 10;
    },
  });
  expect(result.samplesMs).toEqual([1, 2, 3, 4]);
  expect(result.elapsedMs).toBe(50);
  expect(result.operationsPerSecond).toBe(80);
  expect(result.latencyMs).toEqual({ min: 1, p50: 2, p95: 4, p99: 4, max: 4 });
});

it.each(['operation', 'verification'])(
  'drains in-flight work and stops scheduling after %s failure',
  async (failure) => {
    const started: number[] = [];
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const problem = new Error('broken workload');
    let slowFinished = false;
    const result = measure({
      concurrency: 2,
      operations: 10,
      warmup: 0,
      async run(i) {
        started.push(i);
        if (i === 0) {
          await gate.promise;
          slowFinished = true;
          return i;
        }
        entered.resolve();
        if (failure === 'operation') throw problem;
        return i;
      },
      verify(_value, i) {
        if (i === 1 && failure === 'verification') throw problem;
      },
    });
    let settled = false;
    const observed = result.then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await entered.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    expect(await observed).toMatchObject({ errors: [problem] });
    expect(slowFinished).toBe(true);
    expect(started).toEqual([0, 1]);
  },
);

it('fails during warmup rather than publishing samples for a broken workload', async () => {
  const run = vi.fn().mockRejectedValue(new Error('warmup failed'));
  await expect(
    measure({ concurrency: 1, operations: 20, warmup: 1, run, verify: () => {} }),
  ).rejects.toThrow('I/O workload failed');
  expect(run).toHaveBeenCalledTimes(1);
});

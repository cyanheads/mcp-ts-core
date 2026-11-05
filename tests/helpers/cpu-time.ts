/**
 * @fileoverview Thread-CPU cost of a run, for tests that compare costs across input sizes.
 * Linux charges thread CPU in scheduler ticks (1–4 ms), so one short run reads as 0 or a whole
 * tick and a ratio against it means nothing. Each sample here repeats its run until it has used
 * {@link SAMPLE_FLOOR_MS} of thread CPU, then divides by the runs.
 * @module tests/helpers/cpu-time
 */
import { expect } from 'vitest';

/** Thread CPU each sample accumulates: one 4 ms tick of rounding stays within 20% of it. */
const SAMPLE_FLOOR_MS = 20;

/** Thread-CPU milliseconds since `start`. */
function elapsedMs(start: NodeJS.CpuUsage): number {
  const { user, system } = process.threadCpuUsage(start);
  return (user + system) / 1_000;
}

/** Thread-CPU milliseconds of one `run`, averaged over as many runs as the sample floor takes. */
export function sampleCpuMs(run: () => void): number {
  const start = process.threadCpuUsage();
  let runs = 0;
  let ms = 0;
  do {
    run();
    runs++;
    ms = elapsedMs(start);
  } while (ms < SAMPLE_FLOOR_MS);
  return ms / runs;
}

/** {@link sampleCpuMs} for a run that settles asynchronously. */
async function sampleCpuMsAsync(run: () => Promise<unknown>): Promise<number> {
  const start = process.threadCpuUsage();
  let runs = 0;
  let ms = 0;
  do {
    await run();
    runs++;
    ms = elapsedMs(start);
  } while (ms < SAMPLE_FLOOR_MS);
  return ms / runs;
}

/** The fastest per-run thread-CPU milliseconds of `run` over `samples` samples. */
export function cpuMs(run: () => void, samples = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < samples; sample++) best = Math.min(best, sampleCpuMs(run));
  return best;
}

/** {@link cpuMs} for a run that settles asynchronously. */
export async function cpuMsAsync(run: () => Promise<unknown>, samples = 3): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < samples; sample++) {
    best = Math.min(best, await sampleCpuMsAsync(run));
  }
  return best;
}

/**
 * The fastest per-run thread-CPU milliseconds of each of `runs`, over `rounds` rounds that
 * alternate which one goes first.
 */
export function fastestCpuMs(runs: ReadonlyArray<() => void>, rounds = 5): number[] {
  const best = runs.map(() => Number.POSITIVE_INFINITY);
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 ? [...runs.keys()].reverse() : [...runs.keys()];
    for (const index of order) {
      const run = runs[index];
      if (run) best[index] = Math.min(best[index] ?? Number.POSITIVE_INFINITY, sampleCpuMs(run));
    }
  }
  return best;
}

/**
 * Thread CPU no single sample of {@link expectLinearCost} may reach: several times the largest
 * sample a linear row takes, so a cost beyond linear fails at the first size whose one sample
 * crosses it rather than after every sample of every size.
 */
const SAMPLE_CAP_MS = 1_500;

/**
 * Asserts that the per-call thread-CPU cost of `runAt(size)` grows within 4× of linear over input
 * sizes doubling from 5k to 320k characters. The base is the least of five batched samples; each
 * larger size takes samples until one is within the bound, at most three, so a row within it takes
 * one sample per size. No sample may reach {@link SAMPLE_CAP_MS}. Each size is checked before the
 * next, so a cost beyond linear fails before the largest size runs. `runAt` is called once per size
 * (twice for the first), so it can assert the result at that size before returning the run.
 */
export function expectLinearCost(runAt: (size: number) => () => void): void {
  const sizes = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  const first = sizes[0] as number;
  const sample = (run: () => void, size: number) => {
    const ms = sampleCpuMs(run);
    expect(ms, `${size} characters, one sample`).toBeLessThan(SAMPLE_CAP_MS);
    return ms;
  };
  sample(runAt(first), first);
  const warm = runAt(first);
  let base = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 5; i++) base = Math.min(base, sample(warm, first));
  for (const size of sizes.slice(1)) {
    const bound = (4 * size) / first;
    const run = runAt(size);
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3 && best / base >= bound; i++) best = Math.min(best, sample(run, size));
    expect(best / base, `${size} characters`).toBeLessThan(bound);
  }
}

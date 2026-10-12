/**
 * @fileoverview Thread-CPU cost of a run, for tests that compare costs across input sizes.
 * Linux charges thread CPU in scheduler ticks (1–4 ms), so one short run reads as 0 or a whole
 * tick and a ratio against it means nothing. Each sample here repeats its run until it has used
 * {@link SAMPLE_FLOOR_MS} of thread CPU, then divides by the runs.
 * @module tests/helpers/cpu-time
 */

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

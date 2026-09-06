/**
 * @fileoverview Persist successful I/O runs with hardware and toolchain provenance.
 * @module tests/benchmarks/io/harness/report
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { provenance } from '../../harness/provenance.js';
import type { measure } from './measure.js';

/** One named workload, with every measured operation retained for later analysis. */
export interface Measurement {
  name: string;
  result: Awaited<ReturnType<typeof measure>>;
  round: number;
}

/** Called only after every selected workload and its cleanup has succeeded. */
export async function writeReport(
  lane: string,
  measurements: Measurement[],
  details: Record<string, unknown> = {},
) {
  const directory = process.env.BENCH_OUTPUT_DIR ?? 'reports/benchmarks/io';
  const { recordedAt, runtime, ...rest } = await provenance();
  const report = {
    formatVersion: 1,
    lane,
    recordedAt,
    runtime,
    ...rest,
    lockfileSha256: createHash('sha256')
      .update(await readFile('bun.lock'))
      .digest('hex'),
    model:
      'closed-loop; per-operation latency excludes verification; throughput includes verification and scheduling',
    logging: 'emerg',
    details,
    measurements,
  };
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${lane}-${runtime}-${recordedAt.replaceAll(':', '-')}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(`I/O benchmark report: ${path}`);
}

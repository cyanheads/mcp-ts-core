/**
 * @fileoverview Record runtime, hardware, and source provenance alongside benchmark results.
 * @module tests/benchmarks/harness/environment
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TestProject } from 'vitest/node';
import { benchmarkOptions } from './options.js';
import { provenance } from './provenance.js';

/** Captures metadata before workers start; no measurement is included in this setup. */
export default async function setup(project: TestProject): Promise<void> {
  const output = project.config.benchmark?.outputJson;
  if (!output) throw new Error('Benchmark outputJson is required to preserve run provenance.');
  const metadata = {
    ...(await provenance(project.config.root)),
    measurement: benchmarkOptions,
    logging: 'emerg; no log output during measured workloads',
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(`${output}.environment.json`, `${JSON.stringify(metadata, null, 2)}\n`);
}

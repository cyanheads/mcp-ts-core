/**
 * @fileoverview Record runtime, hardware, and source provenance alongside benchmark results.
 * @module tests/benchmarks/harness/environment
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TestProject } from 'vitest/node';
import { benchmarkOptions, resultDirectory } from './options.js';
import { provenance } from './provenance.js';

/** Captures metadata before workers start; no measurement is included in this setup. */
export default async function setup(project: TestProject): Promise<void> {
  const directory = resolve(project.config.root, resultDirectory);
  const metadata = {
    ...(await provenance(project.config.root)),
    measurement: benchmarkOptions,
    logging: 'emerg; no log output during measured workloads',
  };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'environment.json'), `${JSON.stringify(metadata, null, 2)}\n`);
}

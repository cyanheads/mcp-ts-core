/**
 * @fileoverview Runtime, hardware, and source identity shared by every benchmark artifact.
 * @module tests/benchmarks/harness/provenance
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { cpus, release } from 'node:os';
import { join } from 'node:path';

/** Records the machine and source revision a measurement was taken on. */
export async function provenance(root: string = process.cwd()) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  return {
    recordedAt: new Date().toISOString(),
    runtime: process.versions.bun ? 'bun' : 'node',
    runtimeVersion: process.versions.bun ?? process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpu: cpus()[0]?.model,
    frameworkVersion: pkg.version,
    gitRevision: git('log', '-1', '--format=%H'),
    workingTreeDirty: git('status', '--porcelain').length > 0,
    telemetry: 'no SDK/exporters',
  };
}

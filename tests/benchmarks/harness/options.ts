/**
 * @fileoverview Shared measurement budget, result directory, and lane environment; each task runs serially after warmup.
 * @module tests/benchmarks/harness/options
 */
import type { BenchRunOptions } from 'vitest';

/** Milliseconds and minimum iterations for each independent workload. */
export const benchmarkOptions = {
  time: 1_000,
  warmupTime: 250,
  iterations: 64,
  warmupIterations: 16,
} satisfies BenchRunOptions;

/** Where this run's results land, relative to the repository root. */
export const resultDirectory =
  process.env.BENCH_OUTPUT_DIR ?? `reports/benchmarks/${process.versions.bun ? 'bun' : 'node'}`;

/** Keeps logging, telemetry, and transport setup off every measured path. */
export const benchmarkEnv = {
  NODE_ENV: 'test',
  MCP_LOG_LEVEL: 'emerg',
  MCP_AUTH_MODE: 'none',
  MCP_TRANSPORT_TYPE: 'stdio',
  OTEL_ENABLED: 'false',
  LOGS_DIR: 'reports/benchmarks/logs',
};

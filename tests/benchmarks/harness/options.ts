/**
 * @fileoverview Shared measurement budget and lane environment; each task runs serially after warmup.
 * @module tests/benchmarks/harness/options
 */
import type { bench } from 'vitest';

/** Milliseconds and minimum iterations for each independent workload. */
export const benchmarkOptions = {
  time: 1_000,
  warmupTime: 250,
  iterations: 64,
  warmupIterations: 16,
} satisfies Parameters<typeof bench>[2];

/** Keeps logging, telemetry, and transport setup off every measured path. */
export const benchmarkEnv = {
  NODE_ENV: 'test',
  MCP_LOG_LEVEL: 'emerg',
  MCP_AUTH_MODE: 'none',
  MCP_TRANSPORT_TYPE: 'stdio',
  OTEL_ENABLED: 'false',
  LOGS_DIR: 'reports/benchmarks/logs',
};

/** @fileoverview Loopback HTTP load against the built framework on the host test runtime. */
import { expect, it } from 'vitest';
import { assertBuildFresh, startServerFromEntrypoint } from '../../helpers/server-process.js';
import { writeReport } from './harness/report.js';
import { LOAD_SECRET, transportWorkloads } from './harness/transport-workloads.js';

it('measures authenticated HTTP requests, tenant storage, and rejection bursts', async () => {
  assertBuildFresh();
  const server = await startServerFromEntrypoint('tests/fixtures/load-http-server.js', 'http', {
    MCP_AUTH_MODE: 'jwt',
    MCP_AUTH_SECRET_KEY: LOAD_SECRET,
    MCP_SESSION_MODE: 'stateless',
    MCP_AUTH_DISABLE_SCOPE_CHECKS: 'false',
    DEV_MCP_AUTH_BYPASS: 'false',
    STORAGE_PROVIDER_TYPE: 'in-memory',
    MCP_LOG_LEVEL: 'emerg',
    MCP_ALLOWED_ORIGINS: 'http://example.com',
    OTEL_ENABLED: 'false',
  });
  let measurements: Awaited<ReturnType<typeof transportWorkloads>>;
  try {
    measurements = await transportWorkloads(`http://127.0.0.1:${server.port}/mcp`);
  } finally {
    await server.kill();
  }
  expect(server.process.exitCode !== null || server.process.signalCode !== null).toBe(true);
  await writeReport('http', measurements, {
    protocol: '2026-07-28',
    auth: 'HS256 JWT',
    storage: 'in-memory',
    serverRuntime: process.versions.bun ? 'bun' : 'node',
  });
});

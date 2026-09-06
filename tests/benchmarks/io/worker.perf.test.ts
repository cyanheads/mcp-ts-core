/** @fileoverview Host-clock HTTP timings against real local Workerd, without coverage instrumentation. */
import { expect, it } from 'vitest';
import { startStandaloneWorker } from '../../helpers/standalone-worker.js';
import { writeReport } from './harness/report.js';
import { LOAD_SECRET, transportWorkloads } from './harness/transport-workloads.js';

it('measures real Workerd transport and KV operations from the host clock', async () => {
  expect(process.versions.bun, 'Run the worker project with bench:io (real Node)').toBeUndefined();
  const server = await startStandaloneWorker(LOAD_SECRET);
  let measurements: Awaited<ReturnType<typeof transportWorkloads>>;
  try {
    measurements = await transportWorkloads(server.url);
  } finally {
    await server.close();
  }
  await writeReport('worker', measurements, {
    wranglerVersion: server.wranglerVersion,
    protocol: '2026-07-28',
    auth: 'HS256 JWT',
    storage: 'local emulated KV',
    serverRuntime: 'workerd',
    compatibilityDate: '2026-02-13',
    compatibilityFlags: ['nodejs_compat'],
    timing: 'host clock, loopback HTTP; not Cloudflare network or isolate CPU time',
  });
});

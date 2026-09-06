/** @fileoverview Execute the root lifecycle gate on actual Node and preserve raw evidence. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyEvidence } from './harness/evidence.js';
import { findNode, runProcess } from './harness/process.js';

const node = findNode();
const base = resolve('reports/leaks');
mkdirSync(base, { recursive: true });
const directory = mkdtempSync(join(base, 'run-'));
console.log(
  `Leak gate: ${node}; root runtime suites (unit/compliance/smoke/fuzz). Evidence: ${directory}`,
);
const native = await runProcess(node, ['--expose-gc', 'tests/leaks/probes/native-lifetime.mjs'], {
  timeoutMs: 15_000,
});
writeFileSync(join(directory, 'native.log'), native.output);
if (native.code !== 0 || native.signal || native.timedOut)
  throw new Error(`Native environment did not exit cleanly: ${JSON.stringify(native)}`);
const nativeEvidence = JSON.parse(native.output);
console.log(
  `Runtime: ${nativeEvidence.runtime}. Native startup owners: ${nativeEvidence.startup.map((r: { type: string }) => r.type).join(', ')}; five database cycles closed; natural process exit.`,
);
const run = await runProcess(
  node,
  [
    './node_modules/vitest/vitest.mjs',
    'run',
    '--config',
    'tests/config/vitest.leaks.ts',
    ...process.argv.slice(2),
  ],
  {
    timeoutMs: 600_000,
    env: { ...process.env, MCP_LEAK_REPORT_DIR: directory },
    onOutput: (text) => process.stdout.write(text),
  },
);
writeFileSync(join(directory, 'vitest.log'), run.output);
if (run.code !== 0 || run.signal || run.timedOut)
  throw new Error(
    `Leak test process failed (code=${run.code}, signal=${run.signal}, timeout=${run.timedOut}). See ${directory}`,
  );
const reports = verifyEvidence(directory);
console.log(
  `Leak gate passed: ${reports.length} runtime files; zero retained operation resources. Reports: ${directory}`,
);

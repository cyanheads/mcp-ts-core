/** @fileoverview Prove lifecycle failures affect exit status and missing evidence cannot pass. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evidenceFilename, verifyEvidence } from '../../leaks/harness/evidence.js';
import { findNode, runProcess } from '../../leaks/harness/process.js';

const node = findNode();
const directories: string[] = [];
function temp() {
  const directory = mkdtempSync(join(tmpdir(), 'leak-gate-test-'));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('leak gate self-tests', () => {
  it.each([
    ['clean', null],
    ['promise', 'PROMISE'],
    ['adopted', 'PROMISE'],
    ['timer', 'Timeout'],
    ['unref-timer', 'Timeout'],
    ['socket', 'TCPSERVERWRAP'],
    ['descendant-timer', 'Timeout'],
    ['descendant-socket', 'TCPSERVERWRAP'],
    ['finalizer-promise', 'PROMISE'],
    ['finalizer-unref', 'Timeout'],
  ])(
    'returns a failing process status for retained resources: %s',
    async (mode, type) => {
      const directory = temp();
      const result = await runProcess(
        node,
        [
          './node_modules/vitest/vitest.mjs',
          'run',
          '--config',
          'tests/config/vitest.leak-sentinels.ts',
        ],
        {
          timeoutMs: 20_000,
          env: { ...process.env, MCP_LEAK_REPORT_DIR: directory, MCP_LEAK_PROBE: mode },
        },
      );
      expect(result.timedOut, result.output).toBe(false);
      expect(result.signal, result.output).toBeNull();
      expect(result.code, result.output).toBe(type ? 1 : 0);
      if (type) {
        expect(result.output).toContain(type);
        expect(result.output).toContain('Retained async resources');
        expect(() => verifyEvidence(directory)).toThrow();
      } else {
        expect(verifyEvidence(directory)).toHaveLength(1);
      }
    },
    25_000,
  );

  it('fails when an unattributed finalizer keeps the actual test worker alive', async () => {
    const directory = temp();
    const result = await runProcess(
      node,
      [
        './node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'tests/config/vitest.leak-sentinels.ts',
      ],
      {
        timeoutMs: 20_000,
        env: { ...process.env, MCP_LEAK_REPORT_DIR: directory, MCP_LEAK_PROBE: 'finalizer' },
      },
    );
    expect(result.timedOut, result.output).toBe(false);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('Test worker did not exit naturally');
    expect(() => verifyEvidence(directory)).toThrow();
  }, 25_000);

  it('fails on an ordinary assertion failure even without retained resources', async () => {
    const directory = temp();
    const result = await runProcess(
      node,
      [
        './node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'tests/config/vitest.leak-sentinels.ts',
      ],
      {
        timeoutMs: 20_000,
        env: { ...process.env, MCP_LEAK_REPORT_DIR: directory, MCP_LEAK_PROBE: 'test-failure' },
      },
    );
    expect(result.code, result.output).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(() => verifyEvidence(directory)).toThrow();
  }, 25_000);

  it('reports timeout termination as failure instead of natural completion', async () => {
    const result = await runProcess(node, ['-e', 'setInterval(() => {}, 60000)'], {
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  it('rejects unavailable Node and missing GC support', async () => {
    expect(() => findNode(temp())).toThrow('requires real Node');
    const result = await runProcess(
      node,
      [
        '--input-type=module',
        '-e',
        "import {ResourceObserver} from './tests/leaks/harness/observer.ts'; new ResourceObserver();",
      ],
      { timeoutMs: 5_000 },
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain('requires real Node with --expose-gc');
  });

  it.each([
    'missing manifest',
    'missing file',
    'retained resource',
    'unknown startup',
    'missing lifetime',
    'forced worker exit',
    'worker timeout',
  ])('rejects incomplete or unclassified evidence: %s', (mode) => {
    const directory = temp();
    const identity = 'unit:/test.ts';
    if (mode !== 'missing manifest')
      writeFileSync(
        join(directory, 'manifest.json'),
        JSON.stringify({
          identities: [identity],
          reason: 'passed',
          unhandledErrors: 0,
        }),
      );
    if (mode !== 'missing file')
      writeFileSync(
        join(directory, evidenceFilename(identity)),
        JSON.stringify({
          identity,
          runtime: 'v26.5.0',
          captured: 1,
          findings:
            mode === 'retained resource'
              ? [{ id: 1, type: 'PROMISE', stack: 'test stack', owner: null }]
              : [],
          startup:
            mode === 'unknown startup'
              ? [{ id: 2, type: 'UnknownAddonResource', stack: 'test stack', owner: 'unknown' }]
              : [],
        }),
      );
    if (mode !== 'missing lifetime')
      writeFileSync(
        join(directory, `lifetime-${evidenceFilename(identity)}`),
        JSON.stringify({
          identity,
          code: mode === 'forced worker exit' ? null : 0,
          signal: mode === 'forced worker exit' ? 'SIGTERM' : null,
          timedOut: mode === 'worker timeout',
        }),
      );
    expect(() => verifyEvidence(directory)).toThrow();
  });
});

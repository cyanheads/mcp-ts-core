/** @fileoverview Observe the file through Vitest teardown, then require zero retained operations. */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { TestRunner } from 'vitest';
import { evidenceFilename } from './evidence.js';
import { ResourceObserver } from './observer.js';

/** The pool disconnects IPC only after Vitest acknowledges complete worker teardown. */
export default class LeakTestRunner extends TestRunner {
  override onCollectStart(file: Parameters<TestRunner['onCollectStart']>[0]): void {
    super.onCollectStart(file);
    const observer = new ResourceObserver();
    observer.bootstrap('node:dns: Node environment', () =>
      createRequire(import.meta.url)('node:dns'),
    );
    if (file.filepath.endsWith('/tests/smoke/services/canvas-duckdb.test.ts')) {
      observer.bootstrap('@duckdb/node-api: Node environment', () =>
        createRequire(import.meta.url)('@duckdb/node-api'),
      );
    }
    const identity = `${this.config.name}:${file.filepath}`;
    process.once('disconnect', () =>
      observer.instrument(() => {
        void observer
          .collect()
          .then((evidence) => {
            const directory = process.env.MCP_LEAK_REPORT_DIR;
            if (!directory) throw new Error('Missing MCP_LEAK_REPORT_DIR');
            writeFileSync(
              join(directory, evidenceFilename(identity)),
              JSON.stringify(
                {
                  identity,
                  runtime: process.version,
                  ...evidence,
                },
                null,
                2,
              ),
            );
            if (evidence.findings.length) {
              process.exitCode = 1;
              process.stderr.write(
                `Retained async resources in ${file.filepath}:\n${evidence.findings
                  .map(({ type, stack }) => `${type}\n${stack}`)
                  .join('\n\n')}\n`,
              );
            }
          })
          .catch((error: unknown) => {
            process.exitCode = 1;
            process.stderr.write(`Leak observation failed: ${String(error)}\n`);
          });
      }),
    );
  }
}

/** @fileoverview Record selected runtime files so missing observer evidence fails the outer gate. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Reporter } from 'vitest/reporters';

/** Uses public reporter hooks; no dependency on Vitest's internal leakSet. */
export default class LeakReporter implements Reporter {
  private identities: string[] = [];

  onTestRunStart: NonNullable<Reporter['onTestRunStart']> = (specifications) => {
    this.identities = specifications
      .filter((spec) => spec.pool !== 'typescript')
      .map((spec) => `${spec.project.name}:${spec.moduleId}`);
  };

  onTestRunEnd: NonNullable<Reporter['onTestRunEnd']> = (_modules, errors, reason) => {
    const directory = process.env.MCP_LEAK_REPORT_DIR;
    if (!directory) throw new Error('Missing MCP_LEAK_REPORT_DIR');
    writeFileSync(
      join(directory, 'manifest.json'),
      JSON.stringify(
        {
          identities: this.identities,
          reason,
          unhandledErrors: errors.length,
        },
        null,
        2,
      ),
    );
  };
}

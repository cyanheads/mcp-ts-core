/**
 * @fileoverview Initialize and drain real logging around each benchmark file.
 * @module tests/benchmarks/harness/runner
 */
import { join } from 'node:path';
import { BenchmarkRunner } from 'vitest';

/** Vitest 4's benchmark runner does not execute ordinary beforeAll/afterAll hooks. */
export default class FrameworkBenchmarkRunner extends BenchmarkRunner {
  override async runSuite(suite: Parameters<BenchmarkRunner['runSuite']>[0]): Promise<void> {
    const { logger } = (await this.importFile(
      join(this.config.root, 'src/utils/internal/logger.ts'),
      'collect',
    )) as typeof import('@/utils/internal/logger.js');
    await logger.initialize('emerg', 'stdio');
    try {
      await super.runSuite(suite);
    } finally {
      await logger.close();
    }
  }
}

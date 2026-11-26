/**
 * @fileoverview Initialize and drain real logging around each benchmark file, outside every timed phase.
 * @module tests/benchmarks/harness/setup
 */
import { afterAll, beforeAll } from 'vitest';
import { logger } from '@/utils/internal/logger.js';

beforeAll(async () => {
  await logger.initialize('emerg', 'stdio');
});
afterAll(async () => {
  await logger.close();
});

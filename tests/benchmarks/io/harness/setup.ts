/** @fileoverview Real logger lifecycle for opt-in I/O tests. */
import { afterAll, beforeAll } from 'vitest';
import { logger } from '@/utils/internal/logger.js';

beforeAll(async () => {
  await logger.initialize('emerg', 'stdio');
});
afterAll(async () => {
  await logger.close();
});

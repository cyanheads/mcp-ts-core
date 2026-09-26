#!/usr/bin/env node
/**
 * @fileoverview Drives the framework logger through a start level, two
 * `setLevel()` changes, and an interaction record, then holds until stdin
 * closes, so a test can read every sink before the process ends. The start
 * level comes from `FIXTURE_START_LEVEL`; the last record is an error-level
 * barrier that reaches every sink, marking the earlier writes as settled.
 * @module tests/fixtures/logger-levels
 */

import { logger } from '@cyanheads/mcp-ts-core/utils';

const context = () => ({ requestId: 'logger-fixture', timestamp: new Date().toISOString() });

await logger.initialize(process.env.FIXTURE_START_LEVEL ?? 'info', 'stdio');

logger.debug('fixture: debug at start level', context());
logger.setLevel('debug');
logger.debug('fixture: debug after setLevel(debug)', context());
logger.setLevel('warning');
logger.info('fixture: info after setLevel(warning)', context());
logger.logInteraction('fixture-interaction', { context: context(), payloadSize: 1 });
logger.error('fixture: barrier', context());

process.stdin.resume();
process.stdin.on('end', async () => {
  await logger.close();
  process.exit(0);
});

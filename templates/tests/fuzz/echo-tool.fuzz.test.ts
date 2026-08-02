/**
 * @fileoverview Property-based fuzz coverage for the scaffolded echo tool.
 * @module tests/fuzz/echo-tool.fuzz.test
 */

import { expect, it } from 'vitest';
import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { echoTool } from '@/mcp-server/tools/definitions/echo.tool.js';

it('keeps the echo tool safe across generated and adversarial inputs', async () => {
  const report = await fuzzTool(echoTool, {
    numRuns: 50,
    numAdversarial: 30,
    seed: 20_260_802,
  });

  expect(report.crashes).toHaveLength(0);
  expect(report.leaks).toHaveLength(0);
  expect(report.prototypePollution).toBe(false);
});

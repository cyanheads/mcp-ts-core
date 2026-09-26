#!/usr/bin/env node
/**
 * @fileoverview Stdio fixture with one tool whose handler logs through
 * `ctx.log`, so a black-box test can make a real `tools/call` and follow the
 * record it writes into the logger's sinks and the OTel log pipeline.
 * @module tests/fixtures/stdio-log-server
 */

import { createApp, tool, z } from '@cyanheads/mcp-ts-core';

await createApp({
  name: 'stdio-log-fixture',
  version: '0.0.0-test',
  tools: [
    tool('echo_logged', {
      description: 'Echo a message back, logging it through ctx.log first.',
      input: z.object({ message: z.string().describe('Message to echo.') }),
      output: z.object({ message: z.string().describe('The echoed message.') }),
      handler(input, ctx) {
        ctx.log.info('echo_logged handler ran', { echoed: input.message });
        return { message: input.message };
      },
    }),
  ],
});

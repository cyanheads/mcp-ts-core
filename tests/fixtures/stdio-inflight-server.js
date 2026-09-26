#!/usr/bin/env node
/**
 * @fileoverview Stdio fixture with one tool that stays in flight until its
 * request is aborted, logging when it starts and when it sees the abort, so a
 * black-box test can close stdin mid-call and observe what the handler and the
 * wire each see.
 * @module tests/fixtures/stdio-inflight-server
 */

import { createApp, tool, z } from '@cyanheads/mcp-ts-core';

await createApp({
  name: 'stdio-inflight-fixture',
  version: '0.0.0-test',
  tools: [
    tool('wait_for_abort', {
      description: 'Stays in flight until the request is aborted, then reports the abort.',
      input: z.object({}),
      output: z.object({ aborted: z.boolean().describe('Whether the request signal fired.') }),
      async handler(_input, ctx) {
        ctx.log.info('wait_for_abort started');
        await new Promise((resolve) =>
          ctx.signal.addEventListener('abort', resolve, { once: true }),
        );
        ctx.log.info('wait_for_abort observed abort', { aborted: ctx.signal.aborted });
        return { aborted: ctx.signal.aborted };
      },
    }),
  ],
});

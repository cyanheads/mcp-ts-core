#!/usr/bin/env node
/**
 * @fileoverview Fixture with one tool whose handler always throws, so a
 * black-box test can make a real failing `tools/call` over stdio or HTTP and
 * follow the failed-call payload record (#291) into the logger's sinks.
 * @module tests/fixtures/failure-payload-server
 */

import { createApp, tool, z } from '@cyanheads/mcp-ts-core';

await createApp({
  name: 'failure-payload-fixture',
  version: '0.0.0-test',
  tools: [
    tool('payload_probe', {
      description: 'Always fails inside the handler.',
      input: z.object({
        query: z.string().describe('Search query.'),
        auth: z
          .object({ apiKey: z.string().describe('Upstream API key.') })
          .optional()
          .describe('Upstream credentials.'),
      }),
      output: z.object({ ok: z.boolean().describe('Whether the probe succeeded.') }),
      handler() {
        throw new Error('probe failed');
      },
    }),
  ],
});

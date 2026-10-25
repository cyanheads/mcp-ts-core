/** @fileoverview Built-package HTTP fixture for the memory soak lane: the load tools plus a post-GC heap probe. */
import { createApp, tool, z } from '../../dist/core/index.js';
import { loadTools } from './load-tools.js';

const heapProbe = tool('soak_heap', {
  description: 'Run a full garbage collection, then report the server process heap.',
  input: z.object({}),
  output: z.object({
    collected: z.boolean().describe('Whether a full collection ran before the reading.'),
    heapUsedBytes: z.number().describe('Heap in use after the collection, in bytes.'),
  }),
  handler: () => {
    const collected = typeof globalThis.Bun?.gc === 'function';
    if (collected) globalThis.Bun.gc(true);
    return { collected, heapUsedBytes: process.memoryUsage().heapUsed };
  },
});

await createApp({
  name: 'soak-fixture',
  version: '0.0.0-test',
  tools: [...loadTools, heapProbe],
});

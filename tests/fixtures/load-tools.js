/** @fileoverview Identical deterministic tools for Node/Bun HTTP and Workerd load tests. */
import { tool, z } from '../../dist/core/index.js';

export const loadTools = [
  tool('load_echo', {
    description: 'Echo a fixed payload for transport measurements.',
    input: z.object({ payload: z.string().describe('Payload to echo.') }),
    output: z.object({ payload: z.string().describe('Echoed payload.') }),
    handler: ({ payload }) => ({ payload }),
  }),
  tool('load_state', {
    description: 'Read tenant state, optionally writing a value first.',
    input: z.object({
      key: z.string().describe('Storage key.'),
      value: z.string().optional().describe('Value to store; omit for a read-only probe.'),
    }),
    output: z.object({
      value: z.string().nullable().describe('Read-back value.'),
      tenant: z.string().describe('Resolved tenant.'),
    }),
    async handler({ key, value }, ctx) {
      if (value !== undefined) await ctx.state.set(key, value);
      return { value: await ctx.state.get(key), tenant: ctx.tenantId };
    },
  }),
  tool('load_list', {
    description: 'Page through tenant state using signed storage cursors.',
    input: z.object({
      cursor: z.string().optional().describe('Cursor returned by the previous page.'),
    }),
    output: z.object({
      items: z
        .array(
          z.object({
            key: z.string().describe('Stored key.'),
            value: z.string().describe('Stored value.'),
          }),
        )
        .describe('This page of tenant entries.'),
      cursor: z.string().optional().describe('Next page cursor, if more entries exist.'),
    }),
    handler: ({ cursor }, ctx) => ctx.state.list('shared-', { limit: 3, cursor }),
  }),
];

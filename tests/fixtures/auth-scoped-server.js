#!/usr/bin/env node
/**
 * @fileoverview Minimal HTTP MCP fixture server for auth end-to-end tests.
 * Exposes public, scoped, and stateful tools so integration tests can verify
 * endpoint auth and per-tool authorization against the built package output.
 * @module tests/fixtures/auth-scoped-server
 */

import { setImmediate } from 'node:timers/promises';
import { createApp, tool, z } from '../../dist/core/index.js';

const openEchoTool = tool('open_echo', {
  description: 'Echoes a message without additional scope checks.',
  input: z.object({
    message: z.string().describe('Message to echo.'),
  }),
  output: z.object({
    echoed: z.string().describe('Echoed message.'),
    visibility: z.literal('public').describe('Visibility label for the response.'),
  }),
  async handler(input) {
    return {
      echoed: input.message,
      visibility: 'public',
    };
  },
});

const scopedEchoTool = tool('scoped_echo', {
  description: 'Echoes a message when the caller has the scoped echo permission.',
  input: z.object({
    message: z.string().describe('Message to echo.'),
  }),
  output: z.object({
    echoed: z.string().describe('Echoed message.'),
    visibility: z.literal('protected').describe('Visibility label for the response.'),
  }),
  auth: ['tool:scoped_echo:read'],
  async handler(input) {
    return {
      echoed: input.message,
      visibility: 'protected',
    };
  },
});

const stateWriteTool = tool('state_write', {
  description: 'Writes tenant-scoped state for authorization boundary tests.',
  input: z.object({
    key: z.string().describe('State key.'),
    value: z.string().describe('Value to store.'),
  }),
  output: z.object({
    value: z.string().nullable().describe('Value read back after yielding.'),
    tenant: z.string().describe('Authenticated tenant.'),
  }),
  auth: ['state:write'],
  async handler(input, ctx) {
    await ctx.state.set(input.key, input.value);
    await setImmediate();
    return { value: await ctx.state.get(input.key), tenant: ctx.tenantId };
  },
});

const stateReadTool = tool('state_read', {
  description: 'Reads tenant-scoped state for authorization boundary tests.',
  input: z.object({ key: z.string().describe('State key.') }),
  output: z.object({ value: z.string().nullable().describe('Stored value or null.') }),
  auth: ['state:read'],
  async handler(input, ctx) {
    return { value: await ctx.state.get(input.key) };
  },
});

await createApp({
  name: 'auth-scoped-fixture',
  version: '0.0.0-test',
  tools: [openEchoTool, scopedEchoTool, stateWriteTool, stateReadTool],
});

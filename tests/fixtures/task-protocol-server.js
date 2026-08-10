#!/usr/bin/env node
/**
 * @fileoverview Built-package MCP Tasks fixture. Exposes successful, failing,
 * cancellable, and timeout-driven auto-task behavior plus a normal probe tool
 * that makes handler-side cancellation observable over the protocol.
 * @module tests/fixtures/task-protocol-server
 */

import { createApp, tool, z } from '@cyanheads/mcp-ts-core';

const AUTO_TASK_TIMEOUT = Symbol.for('AUTO_TASK_TIMEOUT');
const observations = {
  activeLongTasks: 0,
  cancellations: 0,
  completions: 0,
  starts: 0,
  timeouts: 0,
};

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

const autoEcho = tool('auto_echo', {
  description: 'Completes as an automatically managed task or fails on request.',
  input: z.object({
    fail: z.boolean().default(false).describe('Whether to fail the task intentionally.'),
    value: z.string().describe('Value returned by the task.'),
  }),
  output: z.object({
    echoed: z.string().describe('Echoed input value.'),
  }),
  task: true,
  async handler(input, ctx) {
    await ctx.progress?.update('auto-echo-started');
    if (input.fail) throw new Error(`intentional task failure: ${input.value}`);
    observations.completions += 1;
    return { echoed: input.value };
  },
});

const longControl = tool('long_control', {
  description: 'Waits for cancellation or the framework task deadline.',
  input: z.object({
    mode: z.enum(['cancel', 'timeout']).describe('How this task is expected to end.'),
  }),
  output: z.object({
    outcome: z.string().describe('Terminal outcome when the task completes normally.'),
  }),
  task: true,
  async handler(input, ctx) {
    observations.starts += 1;
    observations.activeLongTasks += 1;
    await ctx.progress?.update(`waiting-for-${input.mode}`);
    try {
      await waitForAbort(ctx.signal);
      return { outcome: 'unexpected-completion' };
    } catch (error) {
      if (ctx.signal.reason === AUTO_TASK_TIMEOUT) observations.timeouts += 1;
      else observations.cancellations += 1;
      throw error;
    } finally {
      observations.activeLongTasks -= 1;
    }
  },
});

const delayedEcho = tool('delayed_echo', {
  description: 'Completes after a controllable delay for status polling tests.',
  input: z.object({
    delayMs: z.number().int().min(1).max(500).describe('Delay before completion in milliseconds.'),
    value: z.string().describe('Value returned after the delay.'),
  }),
  output: z.object({
    echoed: z.string().describe('Echoed input value.'),
  }),
  task: true,
  async handler(input, ctx) {
    await ctx.progress?.update('delayed-echo-working');
    await abortableDelay(input.delayMs, ctx.signal);
    observations.completions += 1;
    return { echoed: input.value };
  },
});

const taskProbe = tool('task_probe', {
  description: 'Returns task-handler observations for protocol conformance tests.',
  input: z.object({}),
  output: z.object({
    activeLongTasks: z.number().int().describe('Currently active long-running handlers.'),
    cancellations: z.number().int().describe('Handlers that observed client cancellation.'),
    completions: z.number().int().describe('Handlers that completed successfully.'),
    starts: z.number().int().describe('Long-running handlers that started.'),
    timeouts: z.number().int().describe('Handlers that observed the framework deadline.'),
  }),
  handler() {
    return { ...observations };
  },
});

await createApp({
  name: 'task-protocol-fixture',
  version: '0.0.0-test',
  tools: [autoEcho, delayedEcho, longControl, taskProbe],
});

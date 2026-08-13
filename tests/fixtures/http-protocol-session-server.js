#!/usr/bin/env node
/**
 * @fileoverview Stateful HTTP protocol-session fixture. Exposes elicitation
 * and indefinitely-running tool/resource handlers so black-box tests can
 * verify capability restoration and cross-request cancellation.
 * @module tests/fixtures/http-protocol-session-server
 */

import { createApp, resource, tool, z } from '@cyanheads/mcp-ts-core';

const observations = {
  resourceActive: 0,
  resourceCancellations: 0,
  resourceStarts: 0,
  toolActive: 0,
  toolCancellations: 0,
  toolStarts: 0,
};

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

const elicitationProbe = tool('session_elicitation_probe', {
  description: 'Exercises form and URL elicitation through a stateful HTTP session.',
  input: z.object({
    label: z.string().optional().describe('Value label used to correlate concurrent requests.'),
    mode: z.enum(['form', 'url']).describe('Elicitation mode to exercise.'),
  }),
  output: z.object({
    action: z.string().nullable().describe('Client elicitation action, if available.'),
    available: z.boolean().describe('Whether elicitation is available in this request.'),
    value: z.string().nullable().describe('Accepted form value, when supplied.'),
  }),
  async handler(input, ctx) {
    if (!ctx.elicit) return { action: null, available: false, value: null };
    if (input.mode === 'url') {
      const result = await ctx.elicit.url(
        'Authorize the protocol-session fixture.',
        'https://example.test/authorize',
      );
      return { action: result.action, available: true, value: null };
    }
    const result = await ctx.elicit(
      `Choose a protocol-session value${input.label ? ` for ${input.label}` : ''}.`,
      z.object({ value: z.string().describe('Value returned to the fixture.') }),
    );
    return {
      action: result.action,
      available: true,
      value: typeof result.content?.value === 'string' ? result.content.value : null,
    };
  },
});

const cancellableTool = tool('session_cancellable_tool', {
  description: 'Waits until an ordinary MCP request cancellation reaches its handler signal.',
  input: z.object({ label: z.string().describe('Request label.') }),
  output: z.object({ completed: z.boolean().describe('Whether the wait completed normally.') }),
  async handler(_input, ctx) {
    observations.toolStarts += 1;
    observations.toolActive += 1;
    try {
      await waitForAbort(ctx.signal);
      return { completed: true };
    } catch (error) {
      observations.toolCancellations += 1;
      throw error;
    } finally {
      observations.toolActive -= 1;
    }
  },
});

const cancellableResource = resource('session-test://wait/{id}', {
  name: 'session-cancellable-resource',
  description: 'Waits until an ordinary resource cancellation reaches its handler signal.',
  mimeType: 'application/json',
  params: z.object({ id: z.string().describe('Request identifier.') }),
  output: z.object({ completed: z.boolean().describe('Whether the wait completed normally.') }),
  async handler(_params, ctx) {
    observations.resourceStarts += 1;
    observations.resourceActive += 1;
    try {
      await waitForAbort(ctx.signal);
      return { completed: true };
    } catch (error) {
      observations.resourceCancellations += 1;
      throw error;
    } finally {
      observations.resourceActive -= 1;
    }
  },
});

const sessionProbe = tool('session_observations', {
  description: 'Returns process-wide observations from protocol-session handlers.',
  input: z.object({}),
  output: z.object({
    resourceActive: z.number().int().describe('Active cancellable resource handlers.'),
    resourceCancellations: z.number().int().describe('Resource handlers that observed abort.'),
    resourceStarts: z.number().int().describe('Cancellable resource handlers started.'),
    toolActive: z.number().int().describe('Active cancellable tool handlers.'),
    toolCancellations: z.number().int().describe('Tool handlers that observed abort.'),
    toolStarts: z.number().int().describe('Cancellable tool handlers started.'),
  }),
  handler() {
    return { ...observations };
  },
});

await createApp({
  name: 'http-protocol-session-fixture',
  version: '0.0.0-test',
  tools: [elicitationProbe, cancellableTool, sessionProbe],
  resources: [cancellableResource],
});

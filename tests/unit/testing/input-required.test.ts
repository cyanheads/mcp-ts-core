/**
 * @fileoverview Contract tests for the consumer helper that captures multi-round-trip input.
 * @module tests/unit/testing/input-required.test
 */
import { inputRequired } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { isInputRequiredSignal } from '@/mcp-server/inputRequired.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { createMockContext, expectInputRequired, runToolContract } from '@/testing/index.js';

it.each([false, true])('captures real request-input signals (async=%s)', async (asynchronous) => {
  const ctx = createMockContext();
  const run = () => ctx.requestInput({ requestState: 'round-1' });
  const result = await expectInputRequired(asynchronous ? async () => run() : run);
  expect(result).toEqual({ resultType: 'input_required', requestState: 'round-1' });
  const next = createMockContext({ requestState: result.requestState });
  expect(next.inputs.state()).toBe('round-1');
});

it.each([
  new Error('handler failure'),
  { result: { resultType: 'input_required' } },
  'plain failure',
])('preserves unrelated failures by identity: %j', async (error) => {
  await expect(
    expectInputRequired(() => {
      throw error;
    }),
  ).rejects.toBe(error);
});

it('fails when the handler returns normally, including a lookalike input-required result', async () => {
  await expect(expectInputRequired(() => ({ resultType: 'input_required' }))).rejects.toThrow(
    'Expected the handler to request input, but it returned: {"resultType":"input_required"}',
  );
});

// Issue #667 — a round is asserted through the contract boundary, and the next
// round completes through it with the answer seeded.
it('captures the round runToolContract rejects with, then completes the next round through it', async () => {
  const Format = z.object({ format: z.enum(['json', 'csv']).describe('Output format') });
  const exportReport = tool('export_report', {
    description: 'Exports a report in the format the caller picks.',
    input: z.object({}),
    output: z.object({ format: z.string().describe('Format used') }),
    handler(_input, ctx) {
      const answer = ctx.inputs.accepted('format', Format);
      if (!answer) {
        return ctx.requestInput({
          inputRequests: {
            format: inputRequired.elicit({ message: 'What format?', requestedSchema: Format }),
          },
          requestState: 'round-1',
        });
      }
      return { format: answer.format };
    },
    format: (result) => [{ type: 'text', text: `format=${result.format}` }],
  });

  await expect(runToolContract(exportReport, {})).rejects.toSatisfy(isInputRequiredSignal);

  const asked = await expectInputRequired(() => runToolContract(exportReport, {}));
  expect(asked.requestState).toBe('round-1');
  expect(asked.inputRequests?.format?.method).toBe('elicitation/create');

  const answered = await runToolContract(
    exportReport,
    {},
    {
      context: {
        inputResponses: { format: { action: 'accept', content: { format: 'csv' } } },
        requestState: asked.requestState,
      },
    },
  );
  expect(answered).toEqual({
    content: [{ type: 'text', text: 'format=csv' }],
    structuredContent: { format: 'csv' },
  });
});

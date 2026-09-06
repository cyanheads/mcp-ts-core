/**
 * @fileoverview Contract tests for the consumer helper that captures multi-round-trip input.
 * @module tests/unit/testing/input-required.test
 */
import { expect, it } from 'vitest';
import { createMockContext, expectInputRequired } from '@/testing/index.js';

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

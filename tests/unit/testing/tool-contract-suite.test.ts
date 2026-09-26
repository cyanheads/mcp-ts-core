/**
 * @fileoverview Self-hosting coverage for the reusable Vitest tool-contract suite.
 * @module tests/testing/tool-contract-suite.test
 */

import { expect } from 'vitest';
import { z } from 'zod';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { toolContractSuite } from '@/testing/vitest.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';

const definition = tool('suite_contract', {
  description: 'Definition used to verify the conformance suite.',
  errors: [
    {
      reason: 'empty_value',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The value is empty.',
      recovery: 'Provide a non-empty value and retry.',
    },
  ],
  input: z.object({ value: z.string().describe('Value') }),
  output: z.object({ value: z.string().describe('Value') }),
  handler(input, ctx) {
    if (!input.value) throw ctx.fail('empty_value');
    return { value: input.value };
  },
  format: (output) => [{ type: 'text', text: output.value }],
});

toolContractSuite(definition, {
  context: { requestId: 'suite-request' },
  success: [
    {
      name: 'matches expected structured behavior',
      input: { value: 'ok' },
      expected: { value: 'ok' },
    },
    {
      name: 'supports behavior-specific assertions',
      input: { value: 'asserted' },
      assert: (result) => {
        expect(result.content).toContainEqual({ type: 'text', text: 'asserted' });
      },
    },
  ],
  errors: [
    {
      name: 'checks the public error envelope',
      input: { value: '' },
      code: JsonRpcErrorCode.InvalidParams,
      reason: 'empty_value',
    },
    {
      // The suite has no parse path of its own — it delegates to
      // `runToolContract`, so an argument the schema rejects arrives as the
      // `InvalidParams` envelope a client receives, with no suite-side change.
      // A boolean, since an integer for `value` is repaired first (#487).
      name: 'inherits the argument-rejection envelope for schema-invalid input',
      input: { value: true } as unknown as { value: string },
      code: JsonRpcErrorCode.InvalidParams,
    },
  ],
});

// Issue #513 — the suite inherits `runToolContract`'s cancellation settle, so a
// case run on an aborted signal asserts the envelope production emits.
const cancelledController = new AbortController();
cancelledController.abort();

const cancellable = tool('suite_cancellable', {
  description: 'Stops as soon as the request is cancelled.',
  input: z.object({}),
  output: z.object({ ok: z.boolean().describe('Never returned.') }),
  handler(_input, ctx) {
    ctx.signal.throwIfAborted();
    return { ok: true };
  },
});

toolContractSuite(cancellable, {
  success: [{ name: 'completes while the signal is live', input: {} }],
  errors: [
    {
      name: 'settles an aborted signal as RequestCancelled',
      input: {},
      context: { signal: cancelledController.signal },
      code: JsonRpcErrorCode.RequestCancelled,
    },
  ],
});

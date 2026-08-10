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
  ],
});

/**
 * @fileoverview Self-hosting coverage for the reusable Vitest tool-contract suite.
 * @module tests/testing/tool-contract-suite.test
 */

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
      name: 'accepts schema-valid handler output',
      input: { value: 'ok' },
      assert: (result) => {
        if (result.structuredContent?.value !== 'ok') {
          throw new Error('Behavior assertion did not receive the handler result.');
        }
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

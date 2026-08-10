/**
 * @fileoverview Compile-time contract for tool success cases.
 * @module tests/types/tool-contract-suite.test-d
 */

import { expectTypeOf, test } from 'vitest';
import { tool, z } from '@/core/index.js';
import type { ToolContractSuccessCase } from '@/testing/vitest.js';

const definition = tool('typed_contract', {
  description: 'Exercises the contract suite types.',
  input: z.object({ id: z.string() }),
  output: z.object({ found: z.boolean(), id: z.string() }),
  handler: ({ id }) => ({ found: true, id }),
});

const expectedCase = {
  name: 'checks a structured result subset',
  input: { id: 'item-1' },
  expected: { found: true },
} satisfies ToolContractSuccessCase<typeof definition>;

const assertionCase = {
  name: 'checks richer result behavior',
  input: { id: 'item-1' },
  assert(result) {
    void result.content;
  },
} satisfies ToolContractSuccessCase<typeof definition>;

test('types expected output subsets against the declared schema', () => {
  expectTypeOf(expectedCase.expected).toEqualTypeOf<{ found: true }>();
  expectTypeOf(assertionCase.assert).toBeFunction();
});

const contractOnlyCase: ToolContractSuccessCase<typeof definition> = {
  name: 'relies on the shared contract checks alone',
  input: { id: 'item-1' },
};

const invalidExpectedCase: ToolContractSuccessCase<typeof definition> = {
  name: 'checks an invalid output field',
  input: { id: 'item-1' },
  // @ts-expect-error Expected subsets are limited to the declared output schema.
  expected: { missing: true },
};

void [contractOnlyCase, invalidExpectedCase];

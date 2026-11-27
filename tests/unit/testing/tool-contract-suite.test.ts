/**
 * @fileoverview Self-hosting coverage for the reusable Vitest tool-contract suite.
 * @module tests/testing/tool-contract-suite.test
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
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

// Issue #668 — a success case accepts every success `runToolContract` returns.
// Its output is parsed once, as production parses it; a second parse of the
// merged result refuses a strict root's enrichment keys and any field whose
// parsed value is not valid input to it.
const structured = (expected: Record<string, unknown>) => (result: CallToolResult) => {
  expect(result.structuredContent).toEqual(expected);
};

toolContractSuite(
  tool('suite_strict_enriched', {
    description: 'Strict output beside an enrichment field the handler sets.',
    input: z.object({}),
    output: z.object({ ok: z.boolean().describe('Success') }).strict(),
    enrichment: { total: z.number().describe('Total matches') },
    handler(_input, ctx) {
      ctx.enrich({ total: 1 });
      return { ok: true };
    },
  }),
  {
    success: [
      {
        name: 'passes a strict output with an enrichment field set',
        input: {},
        expected: { ok: true },
        assert: structured({ ok: true, total: 1 }),
      },
    ],
  },
);

toolContractSuite(
  tool('suite_strict_unset', {
    description: 'Strict output beside an optional enrichment field never set.',
    input: z.object({}),
    output: z.object({ ok: z.boolean().describe('Success') }).strict(),
    enrichment: { total: z.number().optional().describe('Total matches') },
    handler: () => ({ ok: true }),
  }),
  {
    success: [
      {
        name: 'passes a strict output with an optional enrichment field unset',
        input: {},
        assert: structured({ ok: true }),
      },
    ],
  },
);

toolContractSuite(
  tool('suite_stringbool', {
    description: 'A stringbool output field.',
    input: z.object({}),
    output: z.object({ flag: z.stringbool().describe('Flag') }),
    handler: () => ({ flag: 'true' }),
    format: (result) => [{ type: 'text', text: `flag=${String(result.flag)}` }],
  }),
  {
    success: [
      {
        name: 'passes a stringbool output field',
        input: {},
        expected: { flag: true },
        assert: (result) => {
          expect(result.content).toEqual([{ type: 'text', text: 'flag=true' }]);
        },
      },
    ],
  },
);

toolContractSuite(
  tool('suite_piped_enriched', {
    description: 'A transform-and-pipe output field beside an enrichment block.',
    input: z.object({}),
    output: z.object({
      len: z
        .string()
        .transform((value) => value.length)
        .pipe(z.number())
        .describe('Length'),
    }),
    enrichment: { note: z.string().optional().describe('Note') },
    handler(_input, ctx) {
      ctx.enrich({ note: 'n' });
      return { len: 'hello' };
    },
    format: (result) => [{ type: 'text', text: `len=${result.len}` }],
  }),
  {
    success: [
      {
        name: 'passes a transform-and-pipe output field beside enrichment',
        input: {},
        expected: { len: 5 },
        assert: structured({ len: 5, note: 'n' }),
      },
    ],
  },
);

toolContractSuite(
  tool('suite_strip_enriched', {
    description: 'Strip-mode output beside an enrichment field the handler sets.',
    input: z.object({}),
    output: z.object({ ok: z.boolean().describe('Success') }),
    enrichment: { total: z.number().describe('Total matches') },
    handler(_input, ctx) {
      ctx.enrich({ total: 1 });
      return { ok: true };
    },
  }),
  {
    success: [
      {
        name: 'passes a strip-mode output with enrichment',
        input: {},
        assert: structured({ ok: true, total: 1 }),
      },
    ],
  },
);

toolContractSuite(
  tool('suite_passthrough_enriched', {
    description: 'Passthrough output beside an enrichment field the handler sets.',
    input: z.object({}),
    output: z.object({ ok: z.boolean().describe('Success') }).passthrough(),
    enrichment: { total: z.number().describe('Total matches') },
    handler(_input, ctx) {
      ctx.enrich({ total: 2 });
      return { ok: true, extra: 'x' };
    },
  }),
  {
    success: [
      {
        name: 'passes a passthrough output with enrichment',
        input: {},
        assert: structured({ ok: true, extra: 'x', total: 2 }),
      },
    ],
  },
);

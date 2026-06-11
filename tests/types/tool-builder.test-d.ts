/**
 * @fileoverview Typecheck suite for the `tool()` builder — handler input/output
 * inference from the Zod schemas, error contract flow-through, and the
 * `AnyToolDefinition` type-erased form.
 * @module tests/types/tool-builder.test-d
 */

import type { HandlerContext, ReasonOf, ToolDefinition } from '@cyanheads/mcp-ts-core';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { type ErrorContract, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expectTypeOf, it } from 'vitest';

// ---------------------------------------------------------------------------
// Fixture schemas
// ---------------------------------------------------------------------------

const INPUT = z.object({
  query: z.string().describe('Search query.'),
  limit: z.number().optional().describe('Maximum results to return.'),
});

const OUTPUT = z.object({
  items: z.array(z.string()).describe('Matching items.'),
  total: z.number().describe('Total matches.'),
});

const ERRORS = [
  {
    reason: 'no_match',
    code: JsonRpcErrorCode.NotFound,
    when: 'No items matched the query.',
    recovery: 'Broaden the query or try a different identifier.',
  },
  {
    reason: 'upstream_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Upstream API is unreachable.',
    retryable: true,
    recovery: 'Retry after a brief delay.',
  },
] as const satisfies readonly ErrorContract[];

// ---------------------------------------------------------------------------
// tool() input inference
// ---------------------------------------------------------------------------

describe('tool() input inference', () => {
  it('handler input is inferred from the input Zod schema', () => {
    tool('demo', {
      description: 'demo',
      input: INPUT,
      output: OUTPUT,
      async handler(input, _ctx) {
        expectTypeOf(input).toEqualTypeOf<{
          query: string;
          limit?: number | undefined;
        }>();
        return { items: [], total: 0 };
      },
    });
  });

  it('handler rejects a field not in the input schema', () => {
    tool('demo', {
      description: 'demo',
      input: INPUT,
      output: OUTPUT,
      async handler(input, _ctx) {
        // @ts-expect-error — 'notAField' is not in the input schema
        void input.notAField;
        return { items: [], total: 0 };
      },
    });
  });
});

// ---------------------------------------------------------------------------
// tool() output inference
// ---------------------------------------------------------------------------

describe('tool() output inference', () => {
  it('handler return type is inferred from the output Zod schema', () => {
    tool('demo', {
      description: 'demo',
      input: INPUT,
      output: OUTPUT,
      async handler(_input, _ctx) {
        // Correct return shape — type-checks cleanly
        return { items: ['a', 'b'], total: 2 };
      },
    });
  });

  it('handler rejects a return value missing a required output field', () => {
    tool('demo', {
      description: 'demo',
      input: INPUT,
      output: OUTPUT,
      // @ts-expect-error — 'total' is required but missing
      async handler(_input, _ctx) {
        return { items: [] };
      },
    });
  });

  it('output type does not include fields outside the schema', () => {
    // z.infer<typeof OUTPUT> is { items: string[]; total: number }
    // Assert that 'extra' is NOT a key of the declared output type.
    type OutputType = { items: string[]; total: number };
    type HasExtra = 'extra' extends keyof OutputType ? true : false;
    expectTypeOf<HasExtra>().toEqualTypeOf<false>();

    // Negative: excess property check — direct object literal to typed variable
    // triggers TS excess property checking (unlike return from a handler).
    // @ts-expect-error — Object literal may only specify known properties; 'extra' not in OutputType
    const _bad: OutputType = { items: [], total: 0, extra: 'oops' };
    void _bad;
  });
});

// ---------------------------------------------------------------------------
// tool() error contract flow-through
// ---------------------------------------------------------------------------

describe('tool() error contract flow-through', () => {
  it('ctx.fail is typed to the declared reason union', () => {
    tool('demo', {
      description: 'demo',
      input: INPUT,
      output: OUTPUT,
      errors: ERRORS,
      async handler(_input, ctx) {
        expectTypeOf(ctx.fail).parameter(0).toEqualTypeOf<'no_match' | 'upstream_error'>();
        return { items: [], total: 0 };
      },
    });
  });

  it('ctx.fail rejects a reason not in the declared contract', () => {
    tool('demo', {
      description: 'demo',
      input: INPUT,
      output: OUTPUT,
      errors: ERRORS,
      async handler(_input, ctx) {
        // @ts-expect-error — 'typo_reason' is not in the contract
        ctx.fail('typo_reason');
        return { items: [], total: 0 };
      },
    });
  });

  it('ctx has no fail when no error contract is declared', () => {
    tool('demo', {
      description: 'demo',
      input: INPUT,
      output: OUTPUT,
      async handler(_input, ctx) {
        // ctx is plain Context — no fail method
        expectTypeOf(ctx).not.toHaveProperty('fail');
        return { items: [], total: 0 };
      },
    });
  });
});

// ---------------------------------------------------------------------------
// ToolDefinition<TInput, TOutput, TErrors, TEnrich> — structural types
// ---------------------------------------------------------------------------

describe('ToolDefinition structural types', () => {
  it('handler signature matches the ToolDefinition type parameters', () => {
    type MyTool = ToolDefinition<typeof INPUT, typeof OUTPUT, typeof ERRORS, undefined>;

    // handler input must be z.infer<typeof INPUT>
    type HandlerInput = Parameters<MyTool['handler']>[0];
    expectTypeOf<HandlerInput>().toEqualTypeOf<{ query: string; limit?: number | undefined }>();

    // handler ctx must be HandlerContext<ReasonOf<typeof ERRORS>, undefined>
    type HandlerCtx = Parameters<MyTool['handler']>[1];
    type ExpectedCtx = HandlerContext<ReasonOf<typeof ERRORS>, undefined>;
    expectTypeOf<HandlerCtx>().toEqualTypeOf<ExpectedCtx>();
  });

  it('ToolDefinition handler return type matches z.infer<TOutput>', () => {
    type MyTool = ToolDefinition<typeof INPUT, typeof OUTPUT, undefined, undefined>;
    type RetType = Awaited<ReturnType<MyTool['handler']>>;
    expectTypeOf<RetType>().toEqualTypeOf<{ items: string[]; total: number }>();
  });

  it('format() receives z.infer<TOutput> when declared', () => {
    const myTool = tool('demo', {
      description: 'demo',
      input: INPUT,
      output: OUTPUT,
      format(result) {
        // result is z.infer<typeof OUTPUT>
        expectTypeOf(result).toEqualTypeOf<{ items: string[]; total: number }>();
        return [];
      },
      async handler(_input, _ctx) {
        return { items: [], total: 0 };
      },
    });
    void myTool;
  });
});

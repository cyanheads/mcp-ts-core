/**
 * @fileoverview Typecheck suite for the `tool()` builder — handler input/output
 * inference from the Zod schemas and the `ToolDefinition` structural types.
 * Error contract flow-through into `ctx` is covered by `error-contract.test-d.ts`.
 * @module tests/types/tool-builder.test-d
 */

import { describe, expectTypeOf, it } from 'vitest';
// The package's root and `/errors` entry modules, read from `src/`: the package
// name resolves through `exports` to `dist/`, which is only as current as the
// last build.
import type { ContentBlock, HandlerContext, ReasonOf, ToolDefinition } from '@/core/index.js';
import { tool, z } from '@/core/index.js';
import { type ErrorContract, JsonRpcErrorCode } from '@/types-global/errors.js';

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
  it('handler rejects a return value missing a required output field', () => {
    const demo = tool('demo', {
      description: 'demo',
      input: INPUT,
      output: OUTPUT,
      async handler(_input, _ctx) {
        return { items: [], total: 0 };
      },
    });
    type Handler = (typeof demo)['handler'];

    expectTypeOf<() => Promise<{ items: string[]; total: number }>>().toExtend<Handler>();
    // 'total' is required by the output schema
    expectTypeOf<() => Promise<{ items: string[] }>>().not.toExtend<Handler>();
  });

  /**
   * The handler returns what the framework parses — the output schema's input
   * side — and `format()` receives the parse (#846).
   */
  it('a z.stringbool() field takes its input form from the handler and reaches format() parsed', () => {
    const flagTool = tool('flag', {
      description: 'demo',
      input: INPUT,
      output: z.object({ flag: z.stringbool().describe('Flag.') }),
      async handler(_input, _ctx) {
        return { flag: 'true' };
      },
      format(result) {
        expectTypeOf(result).toEqualTypeOf<{ flag: boolean }>();
        return [];
      },
    });

    expectTypeOf<Awaited<ReturnType<(typeof flagTool)['handler']>>>().toEqualTypeOf<{
      flag: string;
    }>();
  });

  it('a z.boolean() field is unchanged: the handler returns a boolean and format() sees one', () => {
    const flagTool = tool('flag', {
      description: 'demo',
      input: INPUT,
      output: z.object({ flag: z.boolean().describe('Flag.') }),
      async handler(_input, _ctx) {
        return { flag: true };
      },
      format(result) {
        expectTypeOf(result).toEqualTypeOf<{ flag: boolean }>();
        return [];
      },
    });
    type Handler = (typeof flagTool)['handler'];

    expectTypeOf<Awaited<ReturnType<Handler>>>().toEqualTypeOf<{ flag: boolean }>();
    expectTypeOf<() => Promise<{ flag: string }>>().not.toExtend<Handler>();
  });

  it('a .default() field may be omitted by the handler and is present in format()', () => {
    const pagedTool = tool('paged', {
      description: 'demo',
      input: INPUT,
      output: z.object({ page: z.number().default(1).describe('Page number.') }),
      async handler(_input, _ctx) {
        return {};
      },
      format(result) {
        expectTypeOf(result).toEqualTypeOf<{ page: number }>();
        return [];
      },
    });

    expectTypeOf<Awaited<ReturnType<(typeof pagedTool)['handler']>>>().toEqualTypeOf<{
      page?: number | undefined;
    }>();
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

  it('ToolDefinition handler return type matches z.input<TOutput>', () => {
    type MyTool = ToolDefinition<typeof INPUT, typeof OUTPUT, undefined, undefined>;
    type RetType = Awaited<ReturnType<MyTool['handler']>>;
    expectTypeOf<RetType>().toEqualTypeOf<{ items: string[]; total: number }>();
  });

  it('format() returns the root-exported ContentBlock type', () => {
    type FormatReturn = ReturnType<
      NonNullable<ToolDefinition<typeof INPUT, typeof OUTPUT>['format']>
    >;
    expectTypeOf<FormatReturn>().toEqualTypeOf<ContentBlock[]>();
    expectTypeOf<{ type: 'text'; text: string }>().toExtend<ContentBlock>();
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

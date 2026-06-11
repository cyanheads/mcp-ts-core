/**
 * @fileoverview Typecheck suite for the error-contract typed surfaces:
 * `TypedFail`/`ReasonOf` unions, `createFail`/`createRecoveryFor`, and
 * `createMockContext({ errors })` propagation via `HandlerContext<R>`.
 * @module tests/types/error-contract.test-d
 */

import type { HandlerContext, ReasonOf, TypedFail, TypedRecoveryFor } from '@cyanheads/mcp-ts-core';
import { createFail, createRecoveryFor, tool, z } from '@cyanheads/mcp-ts-core';
import { type ErrorContract, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expectTypeOf, it } from 'vitest';

// ---------------------------------------------------------------------------
// Shared fixture contract
// ---------------------------------------------------------------------------

const CONTRACT = [
  {
    reason: 'no_match',
    code: JsonRpcErrorCode.NotFound,
    when: 'No items matched the query.',
    recovery: 'Broaden the query or try a different identifier.',
  },
  {
    reason: 'rate_limited',
    code: JsonRpcErrorCode.RateLimited,
    when: 'Upstream rate limit hit.',
    retryable: true,
    recovery: 'Wait a few seconds before retrying the request.',
  },
] as const satisfies readonly ErrorContract[];

// ---------------------------------------------------------------------------
// ReasonOf<E>
// ---------------------------------------------------------------------------

describe('ReasonOf<E>', () => {
  it('extracts the literal reason union from a const tuple', () => {
    type R = ReasonOf<typeof CONTRACT>;
    expectTypeOf<R>().toEqualTypeOf<'no_match' | 'rate_limited'>();
  });

  it('returns never for undefined', () => {
    type R = ReasonOf<undefined>;
    expectTypeOf<R>().toEqualTypeOf<never>();
  });

  it('returns never for the wide ErrorContract[] type (no literal narrowing)', () => {
    type R = ReasonOf<readonly ErrorContract[]>;
    expectTypeOf<R>().toEqualTypeOf<never>();
  });

  it('returns never for a non-contract shape', () => {
    type R = ReasonOf<{ foo: 'bar' }>;
    expectTypeOf<R>().toEqualTypeOf<never>();
  });
});

// ---------------------------------------------------------------------------
// TypedFail<R>
// ---------------------------------------------------------------------------

describe('TypedFail<R>', () => {
  it('parameter(0) is the declared reason union', () => {
    type F = TypedFail<'no_match' | 'rate_limited'>;
    expectTypeOf<F>().parameter(0).toEqualTypeOf<'no_match' | 'rate_limited'>();
  });

  it('parameter(1) accepts an optional string message', () => {
    type F = TypedFail<'no_match'>;
    expectTypeOf<F>().parameter(1).toEqualTypeOf<string | undefined>();
  });
});

// ---------------------------------------------------------------------------
// createFail — return type
// ---------------------------------------------------------------------------

describe('createFail', () => {
  it('returns TypedFail<string> (the wide runtime form)', () => {
    const fail = createFail(CONTRACT);
    expectTypeOf(fail).parameter(0).toEqualTypeOf<string>();
  });
});

// ---------------------------------------------------------------------------
// TypedRecoveryFor<R>
// ---------------------------------------------------------------------------

describe('TypedRecoveryFor<R>', () => {
  it('parameter(0) is the declared reason union', () => {
    type RF = TypedRecoveryFor<'no_match' | 'rate_limited'>;
    expectTypeOf<RF>().parameter(0).toEqualTypeOf<'no_match' | 'rate_limited'>();
  });

  it('return type is the non-empty wire shape', () => {
    type RF = TypedRecoveryFor<'no_match'>;
    expectTypeOf<RF>().returns.toEqualTypeOf<{ recovery: { hint: string } }>();
  });
});

// ---------------------------------------------------------------------------
// createRecoveryFor — return type
// ---------------------------------------------------------------------------

describe('createRecoveryFor', () => {
  it('returns the union of wire shape or empty record', () => {
    const recoveryFor = createRecoveryFor(CONTRACT);
    type R = ReturnType<typeof recoveryFor>;
    expectTypeOf<R>().toEqualTypeOf<{ recovery: { hint: string } } | Record<string, never>>();
  });
});

// ---------------------------------------------------------------------------
// HandlerContext<R> and ctx.fail / ctx.recoveryFor — negative cases
// ---------------------------------------------------------------------------

describe('HandlerContext<R> — negative cases', () => {
  it('ctx.fail rejects an undeclared reason', () => {
    type Ctx = HandlerContext<'no_match' | 'rate_limited'>;
    // Positive: declared reasons are assignable
    expectTypeOf<Ctx>().toHaveProperty('fail');
    type FailFn = Ctx extends { fail: infer F } ? F : never;
    expectTypeOf<FailFn>().parameter(0).toEqualTypeOf<'no_match' | 'rate_limited'>();

    // Negative: 'not_declared' must not be assignable to the reason union
    type IsAssignable = 'not_declared' extends 'no_match' | 'rate_limited' ? true : false;
    expectTypeOf<IsAssignable>().toEqualTypeOf<false>();
  });

  it('ctx.recoveryFor on HandlerContext<R> rejects an undeclared reason', () => {
    type Ctx = HandlerContext<'no_match' | 'rate_limited'>;
    type RecoveryFn = Ctx extends { recoveryFor: infer F } ? F : never;
    expectTypeOf<RecoveryFn>().parameter(0).toEqualTypeOf<'no_match' | 'rate_limited'>();

    type IsAssignable = 'unknown_reason' extends 'no_match' | 'rate_limited' ? true : false;
    expectTypeOf<IsAssignable>().toEqualTypeOf<false>();
  });

  it('ctx.fail is absent when no contract is declared (R = never)', () => {
    type Ctx = HandlerContext<never>;
    expectTypeOf<Ctx>().not.toHaveProperty('fail');
  });
});

// ---------------------------------------------------------------------------
// tool() handler — @ts-expect-error negative cases (compile-time enforcement)
// ---------------------------------------------------------------------------

describe('tool() handler — compile-time negative cases', () => {
  it('ctx.fail rejects an undeclared reason inside a tool handler', () => {
    tool('demo', {
      description: 'demo',
      input: z.object({ q: z.string().describe('query') }),
      output: z.object({ r: z.string().describe('result') }),
      errors: CONTRACT,
      async handler(_input, ctx) {
        expectTypeOf(ctx.fail).parameter(0).toEqualTypeOf<'no_match' | 'rate_limited'>();
        // @ts-expect-error — 'not_a_declared_reason' is not in the contract
        ctx.fail('not_a_declared_reason');
        return { r: 'ok' };
      },
    });
  });

  it('ctx.recoveryFor rejects an undeclared reason inside a tool handler', () => {
    tool('demo', {
      description: 'demo',
      input: z.object({ q: z.string().describe('query') }),
      output: z.object({ r: z.string().describe('result') }),
      errors: CONTRACT,
      async handler(_input, ctx) {
        expectTypeOf(ctx.recoveryFor).parameter(0).toEqualTypeOf<'no_match' | 'rate_limited'>();
        // @ts-expect-error — 'unknown_reason' is not in the contract
        ctx.recoveryFor('unknown_reason');
        return { r: 'ok' };
      },
    });
  });
});

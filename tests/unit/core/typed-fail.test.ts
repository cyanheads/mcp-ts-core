/**
 * @fileoverview Tests for the type-driven error contract — `createFail` runtime
 * helper, reason → code mapping, and `data.reason` propagation.
 * @module tests/unit/core/typed-fail.test
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { HandlerContext, ReasonOf } from '@/core/context.js';
import { createFail, createRecoveryFor } from '@/core/context.js';
import { type ErrorContract, JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

describe('createFail (runtime)', () => {
  const contract = [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No items matched',
      recovery: 'Try a different identifier and retry the call.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Upstream throttled',
      retryable: true,
      recovery: 'Wait a few seconds before retrying.',
    },
  ] as const satisfies readonly ErrorContract[];

  it('builds an McpError with the contract code for a known reason', () => {
    const fail = createFail(contract);
    const err = fail('no_match', 'No widgets found');

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.message).toBe('No widgets found');
    expect(err.data).toMatchObject({ reason: 'no_match' });
  });

  it('falls back to the contract `when` text when no message is provided', () => {
    const fail = createFail(contract);
    const err = fail('rate_limited');
    expect(err.message).toBe('Upstream throttled');
    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
  });

  it('merges custom data with the auto-populated reason', () => {
    const fail = createFail(contract);
    const err = fail('no_match', 'msg', { itemId: '123', source: 'pubmed' });
    expect(err.data).toEqual({ reason: 'no_match', itemId: '123', source: 'pubmed' });
  });

  it('refuses to let caller-supplied data.reason override the contract reason', () => {
    // Regression: spread order in createFail was `{ reason, ...data }`, which
    // let user data overwrite the framework-canonical reason. The fix flips it
    // to `{ ...data, reason }` so the contract reason always wins. This is a
    // load-bearing invariant for observability — observers rely on data.reason
    // matching the contract entry.
    const fail = createFail(contract);
    const err = fail('no_match', 'msg', {
      reason: 'attacker_set_this',
      itemId: '123',
    } as Record<string, unknown>);
    expect(err.data?.reason).toBe('no_match');
    expect(err.data?.itemId).toBe('123');
  });

  it('preserves caller data when the keys do not collide with reason', () => {
    const fail = createFail(contract);
    const err = fail('rate_limited', 'msg', {
      retryAfterMs: 5000,
      upstream: 'pubmed',
    });
    expect(err.data).toEqual({
      reason: 'rate_limited',
      retryAfterMs: 5000,
      upstream: 'pubmed',
      // Auto-populated from the contract entry — `rate_limited` declares `retryable: true`.
      retryable: true,
    });
  });

  it('attaches cause when supplied', () => {
    const fail = createFail(contract);
    const original = new Error('socket hang up');
    const err = fail('rate_limited', undefined, undefined, { cause: original });
    expect(err.cause).toBe(original);
  });

  it('returns InternalError with diagnostic when a JS caller hits an unknown reason', () => {
    const fail = createFail(contract);
    // Cast to bypass the type-system guard — simulates a JS caller or stale contract
    const err = (fail as (r: string) => McpError)('not_a_reason');
    expect(err.code).toBe(JsonRpcErrorCode.InternalError);
    expect(err.message).toContain('not_a_reason');
    expect(err.data).toMatchObject({
      reason: 'not_a_reason',
      declaredReasons: ['no_match', 'rate_limited'],
    });
  });
});

describe('ReasonOf<E> (type-only)', () => {
  it('extracts the literal reason union from a const tuple', () => {
    const errors = [
      {
        reason: 'a',
        code: JsonRpcErrorCode.NotFound,
        when: 'x',
        recovery: 'Try a different identifier and retry the call.',
      },
      {
        reason: 'b',
        code: JsonRpcErrorCode.RateLimited,
        when: 'y',
        recovery: 'Wait a few seconds before retrying.',
      },
    ] as const;
    type R = ReasonOf<typeof errors>;
    expectTypeOf<R>().toEqualTypeOf<'a' | 'b'>();
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

describe('HandlerContext<R> (type-only)', () => {
  it('omits fail when R is never (no contract)', () => {
    type Ctx = HandlerContext<never>;
    expectTypeOf<Ctx>().not.toHaveProperty('fail');
  });

  it('includes a typed fail when R is a literal union', () => {
    type Ctx = HandlerContext<'a' | 'b'>;
    expectTypeOf<Ctx>().toHaveProperty('fail');
    // The fail signature should accept 'a' | 'b' but not other strings
    type FailFn = Ctx extends { fail: infer F } ? F : never;
    expectTypeOf<FailFn>().parameter(0).toEqualTypeOf<'a' | 'b'>();
  });

  it('includes a typed recoveryFor when R is a literal union', () => {
    type Ctx = HandlerContext<'a' | 'b'>;
    expectTypeOf<Ctx>().toHaveProperty('recoveryFor');
    type RecoveryFn = Ctx extends { recoveryFor: infer F } ? F : never;
    expectTypeOf<RecoveryFn>().parameter(0).toEqualTypeOf<'a' | 'b'>();
  });
});

describe('createRecoveryFor (runtime)', () => {
  const contract = [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No items matched',
      recovery: 'Try a different identifier and retry the call.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Upstream throttled',
      retryable: true,
      recovery: 'Wait a few seconds before retrying.',
    },
  ] as const satisfies readonly ErrorContract[];

  it('returns the wire shape for a declared reason', () => {
    const recoveryFor = createRecoveryFor(contract);
    expect(recoveryFor('no_match')).toEqual({
      recovery: { hint: 'Try a different identifier and retry the call.' },
    });
    expect(recoveryFor('rate_limited')).toEqual({
      recovery: { hint: 'Wait a few seconds before retrying.' },
    });
  });

  it('returns {} for an unknown reason (JS callers / stale contracts)', () => {
    const recoveryFor = createRecoveryFor(contract);
    expect(recoveryFor('typo_reason')).toEqual({});
  });

  it('spreads safely into ctx.fail data without overriding caller fields', () => {
    const fail = createFail(contract);
    const recoveryFor = createRecoveryFor(contract);

    const err = fail('no_match', 'No widgets', {
      itemId: '123',
      ...recoveryFor('no_match'),
    });

    expect(err.data).toEqual({
      reason: 'no_match',
      itemId: '123',
      recovery: { hint: 'Try a different identifier and retry the call.' },
    });
  });

  it('lets the caller override recovery with explicit dynamic context', () => {
    const recoveryFor = createRecoveryFor(contract);
    // Spread the contract default first, then override with dynamic hint.
    const data = {
      ...recoveryFor('no_match'),
      recovery: { hint: 'No widget #123; try IDs 1-100 instead.' },
    };
    expect(data.recovery.hint).toBe('No widget #123; try IDs 1-100 instead.');
  });

  it('returns {} for an empty contract (no-op resolver)', () => {
    const recoveryFor = createRecoveryFor([]);
    expect(recoveryFor('anything')).toEqual({});
  });
});

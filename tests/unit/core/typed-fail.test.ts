/**
 * @fileoverview Tests for the type-driven error contract — `createFail` runtime
 * helper, reason → code mapping, and `data.reason` propagation.
 * @module tests/unit/core/typed-fail.test
 */

import { describe, expect, it } from 'vitest';

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

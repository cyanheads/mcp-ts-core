/**
 * @fileoverview Typecheck coverage for `withRetry`'s operation parameter. The
 * signature widened to `(attempt: RetryAttempt) => Promise<T>` with no overloads
 * (#455), so the cases that matter are the ones that must keep compiling.
 * @module tests/types/retry.test-d
 */

import { describe, expectTypeOf, it } from 'vitest';

import type { Context } from '@/core/context.js';
import type { RetryAttempt, RetryOptions } from '@/utils/network/retry.js';
import { withRetry } from '@/utils/network/retry.js';

describe('withRetry operation parameter (issue #455)', () => {
  it('still accepts a zero-argument operation', async () => {
    // The pre-#455 shape. A wider parameter list is assignable to a narrower
    // one, so every existing caller compiles untouched.
    const result = await withRetry(async () => 'ok');
    expectTypeOf(result).toEqualTypeOf<string>();
  });

  it('still accepts a pre-typed zero-argument function reference', async () => {
    const fetchThing: () => Promise<number> = async () => 1;
    const result = await withRetry(fetchThing, { operation: 'fetchThing' });
    expectTypeOf(result).toEqualTypeOf<number>();
  });

  it('infers the attempt fields on an un-annotated destructured parameter', async () => {
    // The case two overloads could not serve: with a zero-argument overload
    // first, this destructuring is an implicit any (TS7031).
    const result = await withRetry(
      async ({ signal, remainingMs }) => {
        expectTypeOf(signal).toEqualTypeOf<AbortSignal>();
        expectTypeOf(remainingMs).toEqualTypeOf<number>();
        return { ok: true };
      },
      { deadlineMs: 1000 },
    );
    expectTypeOf(result).toEqualTypeOf<{ ok: boolean }>();
  });

  it('infers the attempt type on an un-annotated whole parameter', async () => {
    await withRetry(async (attempt) => {
      expectTypeOf(attempt).toEqualTypeOf<RetryAttempt>();
      return null;
    });
  });

  it('names the attempt type through Parameters<typeof withRetry>', () => {
    // A single signature means the utility type resolves to the real parameter,
    // not merely the last of several overloads.
    type Operation = Parameters<typeof withRetry>[0];
    expectTypeOf<Parameters<Operation>[0]>().toEqualTypeOf<RetryAttempt>();
  });

  it('keeps the attempt fields readonly', () => {
    expectTypeOf<RetryAttempt>().toEqualTypeOf<{
      readonly remainingMs: number;
      readonly signal: AbortSignal;
    }>();
  });

  it('types deadlineMs as an optional number on RetryOptions', () => {
    expectTypeOf<RetryOptions['deadlineMs']>().toEqualTypeOf<number | undefined>();
    const options: RetryOptions = { deadlineMs: 50_000 };
    expectTypeOf(options.deadlineMs).toEqualTypeOf<number | undefined>();
  });

  it('still takes the handler Context on options.context', () => {
    expectTypeOf<Context>().toMatchTypeOf<NonNullable<RetryOptions['context']>>();
  });

  it('rejects an operation declaring an incompatible first parameter', () => {
    // @ts-expect-error a `string` parameter cannot receive a `RetryAttempt`.
    void withRetry(async (label: string) => label);
  });
});

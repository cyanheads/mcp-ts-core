/**
 * @fileoverview Typecheck coverage for RequestContextLike structural inputs.
 * @module tests/types/request-context-like.test-d
 */

import { describe, expectTypeOf, it } from 'vitest';

import type { Context } from '@/core/context.js';
import type { RequestContext, RequestContextLike } from '@/utils/internal/requestContext.js';
import type { countTokens } from '@/utils/metrics/tokenCounter.js';
import type { fetchWithTimeout } from '@/utils/network/fetchWithTimeout.js';
import type { RetryOptions } from '@/utils/network/retry.js';
import type { paginateArray } from '@/utils/pagination/pagination.js';
import type { parseDateString } from '@/utils/parsing/dateParser.js';
import type { JsonParser } from '@/utils/parsing/jsonParser.js';

type FetchContextArg = Parameters<typeof fetchWithTimeout>[2];

describe('RequestContextLike structural assignability (issue #108)', () => {
  it('accepts the handler Context without a slice helper', () => {
    expectTypeOf<Context>().toMatchTypeOf<RequestContextLike>();
  });

  it('accepts the open RequestContext bag', () => {
    expectTypeOf<RequestContext>().toMatchTypeOf<RequestContextLike>();
  });
});

describe('public /utils context parameters (issue #297)', () => {
  it('takes the handler Context on the helpers a tool handler calls directly', () => {
    expectTypeOf<Context>().toMatchTypeOf<FetchContextArg>();
    expectTypeOf<Context>().toMatchTypeOf<NonNullable<RetryOptions['context']>>();
    expectTypeOf<Context>().toMatchTypeOf<Parameters<typeof paginateArray>[4]>();
    expectTypeOf<Context>().toMatchTypeOf<NonNullable<Parameters<typeof countTokens>[1]>>();
    expectTypeOf<Context>().toMatchTypeOf<Parameters<typeof parseDateString>[1]>();
    expectTypeOf<Context>().toMatchTypeOf<NonNullable<Parameters<JsonParser['parse']>[2]>>();
  });

  it('still takes the RequestContext bag', () => {
    expectTypeOf<RequestContext>().toMatchTypeOf<FetchContextArg>();
  });

  it('still takes an inline literal carrying ad-hoc fields', () => {
    // The assignment is the assertion: a closed projection alone would fail
    // excess-property checking here and break existing call sites.
    const arg: FetchContextArg = { requestId: 'req-1', timestamp: 'now', operation: 'demo' };
    expectTypeOf(arg).toMatchTypeOf<RequestContextLike | RequestContext>();
  });
});

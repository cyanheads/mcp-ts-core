/**
 * @fileoverview Typecheck coverage for the unified request-context type.
 * @module tests/types/request-context.test-d
 */

import { describe, expectTypeOf, it } from 'vitest';

import type { Context } from '@/core/context.js';
import type { StorageService } from '@/storage/core/StorageService.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import type { countTokens } from '@/utils/metrics/tokenCounter.js';
import type { fetchWithTimeout } from '@/utils/network/fetchWithTimeout.js';
import type { RetryOptions } from '@/utils/network/retry.js';
import type { paginateArray } from '@/utils/pagination/pagination.js';
import type { parseDateString } from '@/utils/parsing/dateParser.js';
import type { JsonParser } from '@/utils/parsing/jsonParser.js';

type FetchContextArg = Parameters<typeof fetchWithTimeout>[2];

describe('one canonical request-context type (issue #110)', () => {
  it('makes the handler Context assignable to RequestContext', () => {
    expectTypeOf<Context>().toMatchTypeOf<RequestContext>();
  });

  it('accepts the handler Context on the service layer, with no slice helper', () => {
    // The failure this issue was filed for: `storage.get('key', ctx)` used to
    // error with "Index signature for type 'string' is missing in type 'Context'".
    expectTypeOf<Context>().toMatchTypeOf<Parameters<StorageService['get']>[1]>();
  });

  it('rejects a misspelled canonical field', () => {
    // @ts-expect-error `tenatId` is not a RequestContext field — the closed
    // type is what makes this a compile error instead of a silent no-op.
    const typo: RequestContext = { requestId: 'r', timestamp: 't', tenatId: 'oops' };
    void typo;
  });

  it('carries operation-specific data in `extra`, not at the top level', () => {
    const ctx: RequestContext = {
      requestId: 'req-1',
      timestamp: 'now',
      operation: 'demo',
      extra: { attempt: 2, url: 'https://example.test' },
    };
    expectTypeOf(ctx.extra).toMatchTypeOf<Readonly<Record<string, unknown>> | undefined>();
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

  it('still takes an inline literal carrying only canonical fields', () => {
    const arg: FetchContextArg = { requestId: 'req-1', timestamp: 'now', operation: 'demo' };
    expectTypeOf(arg).toMatchTypeOf<RequestContext>();
  });
});

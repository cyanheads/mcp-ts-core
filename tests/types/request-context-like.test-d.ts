/**
 * @fileoverview Typecheck coverage for RequestContextLike structural inputs.
 * @module tests/types/request-context-like.test-d
 */

import { describe, expectTypeOf, it } from 'vitest';

import type { Context } from '@/core/context.js';
import type { RequestContext, RequestContextLike } from '@/utils/internal/requestContext.js';

describe('RequestContextLike structural assignability (issue #108)', () => {
  it('accepts the handler Context without a slice helper', () => {
    expectTypeOf<Context>().toMatchTypeOf<RequestContextLike>();
  });

  it('accepts the open RequestContext bag', () => {
    expectTypeOf<RequestContext>().toMatchTypeOf<RequestContextLike>();
  });
});

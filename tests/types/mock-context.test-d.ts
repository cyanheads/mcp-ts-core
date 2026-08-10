/**
 * @fileoverview Typecheck suite for the `/testing` mock context factories.
 * Pins that `createMockContext` / `createMockSession` are generic over a
 * supplied `errors[]` contract, so a definition's own contract can be forwarded
 * under `exactOptionalPropertyTypes` and the resulting context is assignable to
 * the handler parameter of the definition it came from.
 * @module tests/types/mock-context.test-d
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, createMockSession } from '@cyanheads/mcp-ts-core/testing';
import { describe, expectTypeOf, it } from 'vitest';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const contractTool = tool('mock_ctx_contract', {
  description: 'Reports a declared domain failure.',
  input: z.object({ id: z.string().describe('Item ID') }),
  output: z.object({ id: z.string().describe('Item ID') }),
  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'Nothing matched.',
      recovery: 'Try a different identifier and retry.',
    },
  ],
  handler(input, ctx) {
    if (!input.id) throw ctx.fail('no_match');
    return { id: input.id };
  },
});

const enrichedTool = tool('mock_ctx_enriched', {
  description: 'Declares both an error contract and an enrichment block.',
  input: z.object({ id: z.string().describe('Item ID') }),
  output: z.object({ id: z.string().describe('Item ID') }),
  enrichment: { totalCount: z.number().describe('Total matches before any cap.') },
  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'Nothing matched.',
      recovery: 'Try a different identifier and retry.',
    },
  ],
  handler(input, ctx) {
    ctx.enrich.total(1);
    if (!input.id) throw ctx.fail('no_match');
    return { id: input.id };
  },
});

const plainTool = tool('mock_ctx_plain', {
  description: 'Declares no contract.',
  input: z.object({ id: z.string().describe('Item ID') }),
  output: z.object({ id: z.string().describe('Item ID') }),
  handler: (input) => ({ id: input.id }),
});

// ---------------------------------------------------------------------------
// createMockContext
// ---------------------------------------------------------------------------

describe('createMockContext — contract dimension', () => {
  it('accepts a definition’s own errors and types fail against its reasons', () => {
    const ctx = createMockContext({ errors: contractTool.errors });
    expectTypeOf(ctx.fail).parameter(0).toEqualTypeOf<'no_match'>();
    expectTypeOf(ctx.recoveryFor).parameter(0).toEqualTypeOf<'no_match'>();
  });

  it('rejects a reason outside the supplied contract', () => {
    const ctx = createMockContext({ errors: contractTool.errors });
    // @ts-expect-error — 'typo' is not declared in the contract
    ctx.fail('typo');
  });

  it('produces a context assignable to the contract handler’s ctx parameter', async () => {
    const ctx = createMockContext({ errors: contractTool.errors });
    const result = await contractTool.handler(contractTool.input.parse({ id: 'x' }), ctx);
    expectTypeOf(result).toExtend<{ id: string }>();
  });

  it('produces a context assignable to a handler declaring errors and enrichment', async () => {
    const ctx = createMockContext({ errors: enrichedTool.errors });
    const result = await enrichedTool.handler(enrichedTool.input.parse({ id: 'x' }), ctx);
    expectTypeOf(result).toExtend<{ id: string }>();
  });

  it('returns a plain Context when no contract is supplied', async () => {
    const ctx = createMockContext();
    expectTypeOf(ctx).toExtend<Context>();
    expectTypeOf(ctx).not.toHaveProperty('fail');
    await plainTool.handler(plainTool.input.parse({ id: 'x' }), ctx);
  });

  it('stays assignable to Context when other options are supplied', () => {
    const ctx = createMockContext({ tenantId: 'tenant-a', requestId: 'req-1' });
    expectTypeOf(ctx).toExtend<Context>();
  });
});

// ---------------------------------------------------------------------------
// createMockSession
// ---------------------------------------------------------------------------

describe('createMockSession — contract dimension', () => {
  it('carries the contract through to session.ctx', async () => {
    const session = createMockSession({ errors: contractTool.errors });
    expectTypeOf(session.ctx.fail).parameter(0).toEqualTypeOf<'no_match'>();
    await contractTool.handler(contractTool.input.parse({ id: 'x' }), session.ctx);
  });

  it('returns a plain Context on session.ctx without a contract', () => {
    const session = createMockSession({ tenantId: 'tenant-a' });
    expectTypeOf(session.ctx).toExtend<Context>();
    expectTypeOf(session.ctx).not.toHaveProperty('fail');
  });
});

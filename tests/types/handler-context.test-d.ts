/**
 * @fileoverview Typecheck suite for `HandlerContext<R, E>` — typed `enrich` and
 * the Omit-and-replace narrowing of `recoveryFor` and `enrich` on the handler
 * context.
 * @module tests/types/handler-context.test-d
 */

import { describe, expectTypeOf, it } from 'vitest';
// The package's root and `/errors` entry modules, read from `src/`: the package
// name resolves through `exports` to `dist/`, which is only as current as the
// last build.
import type { Context, Enrich, HandlerContext, ReasonOf, TypedEnrich } from '@/core/index.js';
import { tool, z } from '@/core/index.js';
import { type ErrorContract, JsonRpcErrorCode } from '@/types-global/errors.js';

// ---------------------------------------------------------------------------
// Fixture contract and enrichment shape
// ---------------------------------------------------------------------------

const ERRORS = [
  {
    reason: 'no_match',
    code: JsonRpcErrorCode.NotFound,
    when: 'No items matched.',
    recovery: 'Broaden the query or try a different identifier.',
  },
] as const satisfies readonly ErrorContract[];

const ENRICH_SHAPE = {
  totalCount: z.number().describe('Total matches before any cap.'),
  notice: z.string().optional().describe('Caveat when results are empty or capped.'),
};

// ---------------------------------------------------------------------------
// HandlerContext<R> — error contract dimension
// ---------------------------------------------------------------------------

describe('HandlerContext<R> — error contract dimension', () => {
  it('has fail typed to the declared reason union', () => {
    type Ctx = HandlerContext<'no_match'>;
    type FailFn = Ctx extends { fail: infer F } ? F : never;
    expectTypeOf<FailFn>().parameter(0).toEqualTypeOf<'no_match'>();
  });

  it('has recoveryFor typed to the declared reason union', () => {
    type Ctx = HandlerContext<'no_match'>;
    type RecoveryFn = Ctx extends { recoveryFor: infer F } ? F : never;
    expectTypeOf<RecoveryFn>().parameter(0).toEqualTypeOf<'no_match'>();
  });

  it('omits fail when R = never (no contract)', () => {
    type Ctx = HandlerContext<never>;
    expectTypeOf<Ctx>().not.toHaveProperty('fail');
  });

  it('recoveryFor on HandlerContext<never> is the loose Context form', () => {
    type Ctx = HandlerContext<never>;
    type RecoveryFn = Ctx['recoveryFor'];
    // The loose base Context.recoveryFor accepts any string
    expectTypeOf<RecoveryFn>().parameter(0).toEqualTypeOf<string>();
  });
});

// ---------------------------------------------------------------------------
// HandlerContext<R, E> — enrichment dimension
// ---------------------------------------------------------------------------

describe('HandlerContext<R, E> — enrichment dimension', () => {
  it('enrich is TypedEnrich<E> when an enrichment shape is declared', () => {
    type Ctx = HandlerContext<never, typeof ENRICH_SHAPE>;
    type EnrichFn = Ctx['enrich'];
    expectTypeOf<EnrichFn>().toExtend<TypedEnrich<typeof ENRICH_SHAPE>>();
  });

  it('enrich is the loose base Enrich when no enrichment is declared', () => {
    type Ctx = HandlerContext<never, undefined>;
    type EnrichFn = Ctx['enrich'];
    expectTypeOf<EnrichFn>().toExtend<Enrich>();
  });

  it("enrich takes each field's input form, which the framework parses (#846)", () => {
    const shape = {
      flag: z.stringbool().describe('Flag.'),
      pageSize: z.number().default(25).describe('Page size.'),
    };
    type EnrichParam = Parameters<HandlerContext<never, typeof shape>['enrich']>[0];

    expectTypeOf<EnrichParam>().toEqualTypeOf<{
      flag?: string;
      pageSize?: number | undefined;
    }>();
  });
});

// ---------------------------------------------------------------------------
// tool() handler — HandlerContext<R, E> end-to-end narrowing
// ---------------------------------------------------------------------------

describe('tool() handler — HandlerContext<R, E> end-to-end narrowing', () => {
  it('ctx receives both fail and typed enrich when both dimensions declared', () => {
    tool('demo', {
      description: 'demo',
      input: z.object({ q: z.string().describe('query') }),
      output: z.object({ r: z.string().describe('result') }),
      errors: ERRORS,
      enrichment: ENRICH_SHAPE,
      async handler(_input, ctx) {
        // Positive: fail exists and is typed
        expectTypeOf(ctx.fail).parameter(0).toEqualTypeOf<'no_match'>();
        // Positive: enrich accepts declared fields
        type EnrichParam = Parameters<typeof ctx.enrich>[0];
        type HasTotalCount = 'totalCount' extends keyof EnrichParam ? true : false;
        expectTypeOf<HasTotalCount>().toEqualTypeOf<true>();

        // Negative: enrich does NOT accept a field not declared in enrichment
        // @ts-expect-error — 'undeclaredField' is not in the enrichment shape
        ctx.enrich({ undeclaredField: 'oops' });

        return { r: 'ok' };
      },
    });
  });

  it('enrich takes a z.stringbool() field as a string; its trailer render receives the boolean', () => {
    tool('demo', {
      description: 'demo',
      input: z.object({ q: z.string().describe('query') }),
      output: z.object({ r: z.string().describe('result') }),
      enrichment: { cached: z.stringbool().describe('Served from cache.') },
      enrichmentTrailer: {
        cached: {
          render(value) {
            expectTypeOf(value).toEqualTypeOf<boolean>();
            return '';
          },
        },
      },
      async handler(_input, ctx) {
        ctx.enrich({ cached: 'yes' });
        // @ts-expect-error — the parse takes the string form, not the boolean it yields
        ctx.enrich({ cached: true });
        return { r: 'ok' };
      },
    });
  });

  it('ctx has no fail and loose enrich when neither dimension is declared', () => {
    tool('demo', {
      description: 'demo',
      input: z.object({ q: z.string().describe('query') }),
      output: z.object({ r: z.string().describe('result') }),
      async handler(_input, ctx) {
        // ctx is plain Context — no fail
        expectTypeOf(ctx).not.toHaveProperty('fail');
        // enrich is the loose base form — any Record<string, unknown> is fine
        type EnrichParam = Parameters<typeof ctx.enrich>[0];
        expectTypeOf<EnrichParam>().toEqualTypeOf<Record<string, unknown>>();
        return { r: 'ok' };
      },
    });
  });

  it('ctx type is assignable to Context (HandlerContext extends Context)', () => {
    type Ctx = HandlerContext<'no_match', typeof ENRICH_SHAPE>;
    // HandlerContext<R, E> must be assignable to Context — used in service layer
    type ExtendsContext = Ctx extends Context ? true : false;
    expectTypeOf<ExtendsContext>().toEqualTypeOf<true>();
  });
});

// ---------------------------------------------------------------------------
// ReasonOf derivation matches HandlerContext<R>
// ---------------------------------------------------------------------------

describe('ReasonOf derivation matches HandlerContext<R>', () => {
  it('ReasonOf<typeof ERRORS> equals the reason union used in HandlerContext', () => {
    type R = ReasonOf<typeof ERRORS>;
    // R must equal 'no_match' — the only reason in ERRORS
    expectTypeOf<R>().toEqualTypeOf<'no_match'>();
    // HandlerContext<R> with a non-never R gets a typed fail
    type Ctx = HandlerContext<R>;
    expectTypeOf<Ctx>().toHaveProperty('fail');
    // The fail parameter must equal the same R
    type FailParam = Parameters<
      Ctx extends { fail: (...a: infer A) => unknown } ? (...a: A) => void : never
    >[0];
    expectTypeOf<FailParam>().toEqualTypeOf<R>();
  });
});

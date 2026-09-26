/**
 * @fileoverview Typecheck coverage for context content and enrichment helpers.
 * @module tests/types/context-helpers.test-d
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { describe, expectTypeOf, it } from 'vitest';

describe('context helper types', () => {
  it('exposes callable content helpers on every tool context', () => {
    tool('typed_content', {
      description: 'demo',
      input: z.object({ q: z.string().describe('q') }),
      output: z.object({ ok: z.boolean().describe('ok') }),
      handler: (_input, ctx) => {
        expectTypeOf(ctx.content).toBeFunction();
        ctx.content.image('aGVsbG8=', 'image/png');
        ctx.content.audio('aGVsbG8=', 'audio/mpeg');
        ctx.content({ type: 'text', text: 'raw' });
        return { ok: true };
      },
    });
  });

  it('types declared enrichment fields and leaves the base context open', () => {
    tool('typed_enrich', {
      description: 'demo',
      input: z.object({ q: z.string().describe('q') }),
      output: z.object({ items: z.array(z.string()).describe('items') }),
      enrichment: {
        totalCount: z.number().describe('total'),
        notice: z.string().optional().describe('notice'),
      },
      handler: (_input, ctx) => {
        ctx.enrich({ totalCount: 1 });
        ctx.enrich({ notice: 'ok' });
        // @ts-expect-error — totalCount must be a number
        ctx.enrich({ totalCount: 'nope' });
        ctx.enrich.total(2);
        return { items: [] };
      },
    });

    tool('no_enrich', {
      description: 'demo',
      input: z.object({ q: z.string().describe('q') }),
      output: z.object({ items: z.array(z.string()).describe('items') }),
      handler: (_input, ctx) => {
        expectTypeOf(ctx.enrich).toBeFunction();
        ctx.enrich({ anything: 1 });
        return { items: [] };
      },
    });
  });

  it('takes an optional fallbackHint beside the spec, in return position either way', () => {
    tool('typed_request_input', {
      description: 'demo',
      input: z.object({ noun: z.string().optional().describe('noun') }),
      output: z.object({ noun: z.string().describe('noun') }),
      handler: (input, ctx) => {
        expectTypeOf(ctx.requestInput).returns.toBeNever();
        expectTypeOf(ctx.requestInput)
          .parameter(1)
          .toEqualTypeOf<{ fallbackHint?: string } | undefined>();
        if (!input.noun) return ctx.requestInput({ requestState: 'round-1' });
        if (input.noun === 'ask') {
          return ctx.requestInput(
            { requestState: 'round-1' },
            { fallbackHint: 'Or call again with noun supplied.' },
          );
        }
        // @ts-expect-error — the fallback is a sentence, not a flag
        ctx.requestInput({ requestState: 'round-1' }, { fallbackHint: true });
        return { noun: input.noun };
      },
    });
  });
});

/**
 * @fileoverview Typecheck suite for the `resource()` builder's handler return:
 * with an `output` schema, the handler returns that schema's input side, which
 * is what the framework parses the return against before `format()` runs.
 * @module tests/types/resource-builder.test-d
 */

import { describe, expectTypeOf, it } from 'vitest';
// The package's root entry module, read from `src/`: the package name resolves
// through `exports` to `dist/`, which is only as current as the last build.
import { resource, z } from '@/core/index.js';

const PARAMS = z.object({ itemId: z.string().describe('Item identifier.') });

describe('resource() handler return with an output schema', () => {
  it('a z.stringbool() field takes its input form from the handler', () => {
    const flagResource = resource('test://{itemId}/flag', {
      description: 'demo',
      params: PARAMS,
      output: z.object({ flag: z.stringbool().describe('Flag.') }),
      async handler(_params, _ctx) {
        return { flag: 'true' };
      },
    });

    expectTypeOf<Awaited<ReturnType<(typeof flagResource)['handler']>>>().toEqualTypeOf<{
      flag: string;
    }>();
  });

  it('a .default() field may be omitted by the handler', () => {
    const pagedResource = resource('test://{itemId}/page', {
      description: 'demo',
      params: PARAMS,
      output: z.object({ page: z.number().default(1).describe('Page number.') }),
      async handler(_params, _ctx) {
        return {};
      },
    });

    expectTypeOf<Awaited<ReturnType<(typeof pagedResource)['handler']>>>().toEqualTypeOf<{
      page?: number | undefined;
    }>();
  });

  it('a plain z.boolean() field is unchanged: the handler returns a boolean', () => {
    const flagResource = resource('test://{itemId}/plain', {
      description: 'demo',
      params: PARAMS,
      output: z.object({ flag: z.boolean().describe('Flag.') }),
      async handler(_params, _ctx) {
        return { flag: true };
      },
    });
    type Handler = (typeof flagResource)['handler'];

    expectTypeOf<Awaited<ReturnType<Handler>>>().toEqualTypeOf<{ flag: boolean }>();
    expectTypeOf<() => Promise<{ flag: string }>>().not.toExtend<Handler>();
  });

  it('without an output schema the handler returns anything', () => {
    const rawResource = resource('test://{itemId}/raw', {
      description: 'demo',
      params: PARAMS,
      async handler(_params, _ctx) {
        return '<html></html>';
      },
    });

    expectTypeOf<Awaited<ReturnType<(typeof rawResource)['handler']>>>().toEqualTypeOf<unknown>();
  });
});

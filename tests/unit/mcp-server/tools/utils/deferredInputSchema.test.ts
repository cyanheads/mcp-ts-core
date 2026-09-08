/**
 * @fileoverview The advertising half of the deferred input schema (#377). The
 * framework only moves *where* an argument rejection is reported; what
 * `tools/list` publishes must stay byte-identical to the source schema's own
 * projection, strict root keys and `x-mcp-header` designations included.
 * @module tests/unit/mcp-server/tools/utils/deferredInputSchema.test
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { deferInputValidation } from '@/mcp-server/tools/utils/deferredInputSchema.js';
import { headerParam } from '@/mcp-server/tools/utils/headerParam.js';

const project = (schema: ReturnType<typeof deferInputValidation>) =>
  schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' });

describe('deferInputValidation (#377)', () => {
  it.each(['input', 'output'] as const)(
    'projects the source %s schema verbatim, strict root keys included',
    (io) => {
      const input = z
        .object({
          query: z.string().min(1).describe('Search query.'),
          limit: z.number().int().default(10).describe('Maximum results.'),
        })
        .strict();

      expect(
        deferInputValidation(input)['~standard'].jsonSchema[io]({ target: 'draft-2020-12' }),
      ).toEqual(z.toJSONSchema(input, { target: 'draft-2020-12', io }));
    },
  );

  it('carries an x-mcp-header designation through to the advertised schema', () => {
    const input = z
      .object({ region: headerParam(z.string().describe('Region.'), 'Region') })
      .strict();

    const properties = project(deferInputValidation(input)).properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.region?.['x-mcp-header']).toBe('Region');
  });

  it('projects a discriminated-union input root', () => {
    const input = z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('read'), id: z.string().describe('Id.') }).strict(),
      z.object({ mode: z.literal('write'), body: z.string().describe('Body.') }).strict(),
    ]);

    expect(project(deferInputValidation(input))).toEqual(
      z.toJSONSchema(input, { target: 'draft-2020-12', io: 'input' }),
    );
  });

  it('passes arguments through untouched so the handler owns the rejection', () => {
    const input = z.object({ query: z.string().describe('Search query.') }).strict();
    const args = { query: 'ok', salt: true };

    // A schema failure here would become the SDK's text-only tool error; the
    // framework parses these same arguments one layer down instead.
    expect(deferInputValidation(input)['~standard'].validate(args)).toEqual({ value: args });
  });
});

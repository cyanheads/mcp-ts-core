/**
 * @fileoverview The validation-deferring schema wrapper both tool schemas are
 * registered through (#377, #846). The framework only moves *where* an input
 * rejection is reported and keeps the output parse to its own single pass; what
 * `tools/list` publishes must stay byte-identical to the source schema's own
 * projection — strict root keys, `x-mcp-header` designations, and the widened
 * output's `anyOf` refinement included.
 * @module tests/unit/mcp-server/tools/utils/deferredSchema.test
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { deferValidation } from '@/mcp-server/tools/utils/deferredSchema.js';
import { headerParam } from '@/mcp-server/tools/utils/headerParam.js';
import { type AnyToolDefinition, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { advertisedOutputSchema } from '@/mcp-server/tools/utils/toolOutputSchema.js';

const project = (schema: ReturnType<typeof deferValidation>, io: 'input' | 'output' = 'input') =>
  schema['~standard'].jsonSchema[io]({ target: 'draft-2020-12' });

/** A tool whose output fields each parse to a value their own input side refuses. */
const crossTypeTool = tool('cross_type_output', {
  description: 'Declares output fields whose parsed value differs in type from their input.',
  input: z.object({}),
  output: z.object({
    flag: z.stringbool().describe('Flag'),
    len: z
      .string()
      .transform((s) => s.length)
      .pipe(z.number())
      .describe('Length'),
    n: z.codec(z.string(), z.number(), { decode: Number, encode: String }).describe('Number'),
  }),
  enrichment: { note: z.string().optional().describe('Note') },
  handler: () => ({ flag: 'true', len: 'hello', n: '42' }) as never,
}) as AnyToolDefinition;

describe('deferValidation (#377, #846)', () => {
  it.each(['input', 'output'] as const)(
    'projects the source %s schema verbatim, strict root keys included',
    (io) => {
      const input = z
        .object({
          query: z.string().min(1).describe('Search query.'),
          limit: z.number().int().default(10).describe('Maximum results.'),
        })
        .strict();

      expect(project(deferValidation(input), io)).toEqual(
        z.toJSONSchema(input, { target: 'draft-2020-12', io }),
      );
    },
  );

  it('carries an x-mcp-header designation through to the advertised schema', () => {
    const input = z
      .object({ region: headerParam(z.string().describe('Region.'), 'Region') })
      .strict();

    const properties = project(deferValidation(input)).properties as Record<
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

    expect(project(deferValidation(input))).toEqual(
      z.toJSONSchema(input, { target: 'draft-2020-12', io: 'input' }),
    );
  });

  it('projects a widened output schema verbatim, its anyOf refinement and parsed field types included', () => {
    const widened = advertisedOutputSchema(crossTypeTool);
    const projection = project(deferValidation(widened), 'output');

    expect(projection).toEqual(z.toJSONSchema(widened, { target: 'draft-2020-12', io: 'output' }));
    expect(projection.anyOf).toBeDefined();
    expect(projection.properties).toMatchObject({
      flag: { type: 'boolean' },
      len: { type: 'number' },
      n: { type: 'number' },
    });
  });

  it('passes arguments through untouched so the handler owns the rejection', () => {
    const input = z.object({ query: z.string().describe('Search query.') }).strict();
    const args = { query: 'ok', salt: true };

    // A schema failure here would become the SDK's text-only tool error; the
    // framework parses these same arguments one layer down instead.
    expect(deferValidation(input)['~standard'].validate(args)).toEqual({ value: args });
  });

  it('passes parsed structured content through that the source schema would refuse', () => {
    const widened = advertisedOutputSchema(crossTypeTool);
    const parsed = { flag: true, len: 5, n: 42, note: 'hi' };

    // The SDK re-validates `structuredContent` after the handler returns; the
    // source schema reads it against the fields' input side and refuses it.
    expect(widened['~standard'].validate(parsed)).toHaveProperty('issues');
    expect(deferValidation(widened)['~standard'].validate(parsed)).toEqual({ value: parsed });
  });
});

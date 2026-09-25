/**
 * @fileoverview Template cat fact tool — demonstrates an external JSON API call
 * with the `tool()` builder: `fetchWithTimeout`, a typed not-found contract for
 * an empty upstream answer, upstream payload validation, and an enrichment echo.
 * @module examples/mcp-server/tools/definitions/template-cat-fact.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, serializationError } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';

const CAT_FACT_API_URL = 'https://catfact.ninja/fact';
const CAT_FACT_API_TIMEOUT_MS = 5000;

/** Upstream payload. A `max_length` below every fact returns HTTP 200 with `{}` instead. */
const CatFactApiSchema = z.object({
  fact: z.string(),
  length: z.number(),
});

const InputSchema = z.object({
  maxLength: z
    .number()
    .int('Max length must be an integer.')
    .min(1, 'Max length must be at least 1.')
    .optional()
    .describe(
      'Only return a fact of at most this many characters. Omit to accept a fact of any length.',
    ),
});

const OutputSchema = z.object({
  fact: z.string().describe('The retrieved cat fact.'),
  characterCount: z.number().int().describe('Number of characters in the fact.'),
});

export const catFactTool = tool('template_cat_fact', {
  title: 'Random Cat Fact',
  description:
    'Fetch a random cat fact, optionally limited to facts of at most maxLength characters.',
  input: InputSchema,
  output: OutputSchema,
  enrichment: {
    requestedMaxLength: z
      .number()
      .int()
      .optional()
      .describe('The maxLength the fact was capped at, echoed from the input.'),
  },
  auth: ['tool:template_cat_fact:read'],
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
  errors: [
    {
      reason: 'no_fact_within_length',
      code: JsonRpcErrorCode.NotFound,
      when: 'No fact in the upstream catalog is maxLength characters or shorter.',
      recovery:
        'Call again with a larger maxLength, or omit maxLength to accept a fact of any length.',
      retryable: false,
    },
  ],

  async handler(input, ctx) {
    const url = new URL(CAT_FACT_API_URL);
    if (input.maxLength !== undefined) url.searchParams.set('max_length', String(input.maxLength));
    ctx.log.debug('Fetching cat fact', { url: url.toString() });

    // Non-2xx responses throw a status-mapped McpError inside fetchWithTimeout.
    const response = await fetchWithTimeout(url, CAT_FACT_API_TIMEOUT_MS, ctx, {
      signal: ctx.signal,
    });
    const body: unknown = await response.json().catch((cause: unknown) => {
      throw serializationError('Cat fact API returned a non-JSON body.', undefined, { cause });
    });

    const isEmptyObject =
      typeof body === 'object' && body !== null && Object.keys(body).length === 0;
    if (input.maxLength !== undefined && isEmptyObject) {
      throw ctx.fail(
        'no_fact_within_length',
        `No cat fact is ${input.maxLength} characters or shorter.`,
        { maxLength: input.maxLength, ...ctx.recoveryFor('no_fact_within_length') },
      );
    }

    const parsed = CatFactApiSchema.safeParse(body);
    if (!parsed.success) {
      throw serializationError(
        'Cat fact API returned an unexpected payload.',
        { issues: parsed.error.issues },
        { cause: parsed.error },
      );
    }

    if (input.maxLength !== undefined) ctx.enrich({ requestedMaxLength: input.maxLength });
    return { fact: parsed.data.fact, characterCount: parsed.data.length };
  },

  format(result) {
    return [
      {
        type: 'text',
        text: `**Fact:** ${result.fact}\n**Characters:** ${result.characterCount}`,
      },
    ];
  },
});

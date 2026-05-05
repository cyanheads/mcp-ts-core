/**
 * @fileoverview Template cat fact tool — demonstrates external API calls with the `tool()` builder.
 * Fetches a random cat fact from a public API with optional maximum length.
 * @module examples/mcp-server/tools/definitions/template-cat-fact.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';

const CAT_FACT_API_URL = 'https://catfact.ninja/fact';
const CAT_FACT_API_TIMEOUT_MS = 5000;

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
    .describe('Maximum character length of the returned fact.'),
});

const OutputSchema = z.object({
  fact: z.string().describe('The retrieved cat fact.'),
  length: z.number().int().describe('The character length of the cat fact.'),
  requestedMaxLength: z
    .number()
    .int()
    .optional()
    .describe('The maximum length that was requested for the fact.'),
  timestamp: z.iso
    .datetime()
    .describe('ISO 8601 timestamp of when the response was generated.'),
});

export const catFactTool = tool('template_cat_fact', {
  title: 'Random Cat Fact',
  description: 'Fetch a random cat fact from a public API. Optionally cap its character length.',
  input: InputSchema,
  output: OutputSchema,
  auth: ['tool:cat_fact:read'],
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },

  async handler(input, ctx) {
    ctx.log.debug('Processing template_cat_fact', { toolInput: input });

    const url =
      input.maxLength !== undefined
        ? `${CAT_FACT_API_URL}?max_length=${input.maxLength}`
        : CAT_FACT_API_URL;

    ctx.log.info(`Fetching random cat fact from: ${url}`);

    const reqCtx = { requestId: ctx.requestId, timestamp: ctx.timestamp };
    const response = await fetchWithTimeout(url, CAT_FACT_API_TIMEOUT_MS, reqCtx, {
      signal: ctx.signal,
    });

    if (!response.ok) {
      throw serviceUnavailable(`Cat fact API returned ${response.status}`, {
        url,
        status: response.status,
        recovery: { hint: 'The upstream cat fact API is unavailable. Wait briefly and retry.' },
      });
    }

    const data = CatFactApiSchema.parse(await response.json());

    ctx.log.notice('Random cat fact fetched successfully.', { factLength: data.length });

    return {
      fact: data.fact,
      length: data.length,
      requestedMaxLength: input.maxLength,
      timestamp: new Date().toISOString(),
    };
  },

  format(result) {
    const maxPart =
      typeof result.requestedMaxLength === 'number' ? `, max<=${result.requestedMaxLength}` : '';
    const header = `Cat Fact (length=${result.length}${maxPart})`;
    const preview = result.fact.length > 300 ? `${result.fact.slice(0, 297)}…` : result.fact;
    return [{ type: 'text', text: [header, preview, `timestamp=${result.timestamp}`].join('\n') }];
  },
});

/**
 * @fileoverview Envelope parity between `runToolContract` and the production
 * tool handler factory. Every case drives both paths with the same definition
 * and the same arguments and compares the two results to each other — never to
 * a hand-written literal, which is how the two drifted apart in the first
 * place.
 * @module tests/testing/run-tool-contract-parity.test
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AnyToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import {
  createToolHandler,
  type HandlerServices,
  type NotifierSources,
} from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { runToolContract } from '@/testing/index.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { makeServerContext } from '../../helpers/server-context.js';

const services = {} as HandlerServices;
const notifiers: NotifierSources = {};

/** Drives the production factory for a definition + raw arguments. */
async function viaFactory(
  definition: AnyToolDefinition,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const handler = createToolHandler(definition, services, notifiers);
  return (await handler(args, makeServerContext())) as CallToolResult;
}

/** The error envelope both paths publish, narrowed for assertions. */
function envelope(result: CallToolResult): {
  code: number;
  data?: Record<string, unknown>;
  message: string;
} {
  return (result.structuredContent as { error: ReturnType<typeof envelope> }).error;
}

const bounded = tool('parity_bounded', {
  description: 'Accepts an integer of at least 1000.',
  input: z.object({ n: z.number().int().min(1000).describe('A large integer') }),
  output: z.object({ n: z.number().describe('The echoed integer') }),
  handler: ({ n }) => ({ n }),
}) as AnyToolDefinition;

const typed = tool('parity_typed', {
  description: 'Requires a name.',
  input: z.object({
    name: z.string().describe('Caller name'),
    nested: z
      .object({ depth: z.number().describe('Depth') })
      .optional()
      .describe('Nested block'),
  }),
  output: z.object({ name: z.string().describe('The echoed name') }),
  handler: ({ name }) => ({ name }),
}) as AnyToolDefinition;

const multi = tool('parity_multi', {
  description: 'Two fields of different types.',
  input: z.object({ a: z.string().describe('A'), b: z.number().describe('B') }),
  output: z.object({ ok: z.boolean().describe('Success') }),
  handler: () => ({ ok: true }),
}) as AnyToolDefinition;

describe('runToolContract argument rejection', () => {
  const cases: Array<{
    args: Record<string, unknown>;
    definition: AnyToolDefinition;
    name: string;
  }> = [
    { name: 'a failed constraint', definition: bounded, args: { n: 5 } },
    { name: 'a wrong type', definition: typed, args: { name: 123 } },
    { name: 'a missing required field', definition: typed, args: {} },
    {
      name: 'an unrecognized root key against input.strict()',
      definition: typed,
      args: { name: 'ok', surprise: true },
    },
    { name: 'a multi-issue input', definition: multi, args: { a: 1, b: 'x' } },
    {
      name: 'a nested field two levels down',
      definition: typed,
      args: { name: 'ok', nested: { depth: 'deep' } },
    },
  ];

  for (const { args, definition, name } of cases) {
    it(`publishes the production envelope for ${name}`, async () => {
      const production = await viaFactory(definition, args);
      const helper = await runToolContract(definition, args as never);

      // The factory is the reference: it is what a client on the wire sees.
      expect(production.isError).toBe(true);
      expect(envelope(production).code).toBe(JsonRpcErrorCode.InvalidParams);

      // Every surface the helper publishes, compared to the reference rather
      // than to a literal.
      expect(helper.isError).toBe(production.isError);
      expect(envelope(helper).code).toBe(envelope(production).code);
      expect(envelope(helper).message).toBe(envelope(production).message);
      expect(envelope(helper).data).toEqual(envelope(production).data);
      expect(helper.content).toEqual(production.content);
    });
  }

  it('names the tool and every failing field in the shared message', async () => {
    const helper = await runToolContract(multi, { a: 1, b: 'x' } as never);
    const message = envelope(helper).message;

    expect(message).toContain('parity_multi');
    expect(message).toContain('a: ');
    expect(message).toContain('b: ');
  });
});

describe('runToolContract classification that must not move', () => {
  it('keeps a handler-thrown ZodError on ValidationError', async () => {
    const definition = tool('parity_handler_zod', {
      description: 'Validates inside the handler.',
      input: z.object({ raw: z.string().describe('Raw value') }),
      output: z.object({ parsed: z.number().describe('Parsed value') }),
      handler: ({ raw }) => ({ parsed: z.number().parse(raw) }),
    }) as AnyToolDefinition;

    const production = await viaFactory(definition, { raw: 'not-a-number' });
    const helper = await runToolContract(definition, { raw: 'not-a-number' } as never);

    expect(envelope(production).code).toBe(JsonRpcErrorCode.ValidationError);
    expect(envelope(helper).code).toBe(envelope(production).code);
    expect(envelope(helper).message).toBe(envelope(production).message);
    expect(envelope(helper).data).toEqual(envelope(production).data);
  });

  it('keeps an output-schema rejection on ValidationError', async () => {
    const definition = tool('parity_bad_output', {
      description: 'Returns output that does not match its schema.',
      input: z.object({}),
      output: z.object({ ok: z.boolean().describe('Success') }),
      handler: () => ({ ok: 'wrong' }) as never,
    }) as AnyToolDefinition;

    const production = await viaFactory(definition, {});
    const helper = await runToolContract(definition, {} as never);

    expect(envelope(production).code).toBe(JsonRpcErrorCode.ValidationError);
    expect(envelope(helper).code).toBe(envelope(production).code);
    expect(envelope(helper).message).toBe(envelope(production).message);
    expect(envelope(helper).data).toEqual(envelope(production).data);
  });
});

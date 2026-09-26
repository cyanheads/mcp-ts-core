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
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { withRetry } from '@/utils/network/retry.js';
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

const nestedStrict = tool('parity_nested_strict', {
  description: 'A strict options object beside an aliased key.',
  input: z.object({
    query: z.string().min(3).describe('Search query'),
    opts: z
      .object({ exact: z.boolean().describe('Exact match') })
      .strict()
      .optional()
      .describe('Options'),
  }),
  inputAliases: { q: 'query' },
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
    // A boolean: an integer for a string field is repaired before parsing (#487).
    { name: 'a wrong type', definition: typed, args: { name: true } },
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
    {
      name: 'an unknown key in a nested strict object',
      definition: nestedStrict,
      args: { query: 'abc', opts: { exact: true, fuzzy: true } },
    },
    {
      name: 'a rejection reporting an alias rewrite and a dropped key',
      definition: nestedStrict,
      args: { q: 'ab', _page: 2 },
    },
    {
      name: 'a stringified object and an integer the schema still refuses',
      definition: nestedStrict,
      args: { query: 12, opts: '{"exact":"yes"}' },
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
});

// Issue #480 — the framework's own output-contract parses fail as the server
// fault they are, in the helper exactly as in production.
describe('runToolContract output-contract violations', () => {
  it.each([
    [
      'an output-schema violation',
      tool('parity_bad_output', {
        description: 'Returns output that does not match its schema.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('Success') }),
        handler: () => ({ ok: 'wrong' }) as never,
      }) as AnyToolDefinition,
      'Tool parity_bad_output returned output that does not match its output schema: ok: ',
    ],
    [
      'an unpopulated required enrichment field',
      tool('parity_bad_enrichment', {
        description: 'Declares a required enrichment field it never populates.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('Success') }),
        enrichment: { total: z.number().describe('Required total') },
        handler: () => ({ ok: true }),
      }) as AnyToolDefinition,
      'Tool parity_bad_enrichment returned enrichment that does not match its enrichment schema: total: ',
    ],
  ])('publishes %s as the production InternalError', async (_label, definition, prefix) => {
    const production = await viaFactory(definition, {});
    const helper = await runToolContract(definition, {} as never);

    expect(envelope(production).code).toBe(JsonRpcErrorCode.InternalError);
    expect(envelope(production).message.startsWith(prefix)).toBe(true);
    expect(helper).toEqual(production);
  });
});

// Issue #513 — a cancellation settles as `RequestCancelled` in the helper the
// way `asRequestCancelled` settles it in the factory.
describe('runToolContract cancellation', () => {
  /** A tool that waits for its signal to fire, then rejects with `thrown(signal)`. */
  const waitingTool = (thrown: (signal: AbortSignal) => unknown) =>
    tool('parity_cancel', {
      description: 'Waits until the request is cancelled.',
      input: z.object({}),
      output: z.object({ ok: z.boolean().describe('Never returned.') }),
      handler: (_input, ctx) =>
        new Promise<{ ok: boolean }>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(thrown(ctx.signal)), { once: true });
        }),
    }) as AnyToolDefinition;

  /** Runs both paths with a signal aborted `abort` after the handler starts. */
  async function bothAborted(
    definition: AnyToolDefinition,
    abort: (controller: AbortController) => void,
  ): Promise<{ helper: CallToolResult; production: CallToolResult }> {
    const factoryController = new AbortController();
    const productionRun = createToolHandler(
      definition,
      services,
      notifiers,
    )({}, makeServerContext({ signal: factoryController.signal }));
    const helperController = new AbortController();
    const helperRun = runToolContract(definition, {} as never, {
      context: { signal: helperController.signal },
    });
    await Promise.resolve();
    abort(factoryController);
    abort(helperController);
    return {
      helper: await helperRun,
      production: (await productionRun) as CallToolResult,
    };
  }

  it.each([
    ['a DOMException AbortError', (c: AbortController) => c.abort(), (s: AbortSignal) => s.reason],
    [
      'the reason string',
      (c: AbortController) => c.abort('client disconnected'),
      (s: AbortSignal) => s.reason,
    ],
    ['an unrelated Error', (c: AbortController) => c.abort(), () => new Error('upstream gave up')],
    [
      'an McpError of its own',
      (c: AbortController) => c.abort(),
      () => new McpError(JsonRpcErrorCode.NotFound, 'gone'),
    ],
  ])('settles %s thrown after the abort as RequestCancelled', async (_label, abort, thrown) => {
    const { helper, production } = await bothAborted(waitingTool(thrown), abort);

    expect(envelope(production).code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(helper).toEqual(production);
  });

  it('settles a withRetry backoff aborted by ctx.signal as RequestCancelled', async () => {
    const definition = tool('parity_retry', {
      description: 'Retries a failing upstream until cancelled.',
      input: z.object({}),
      output: z.object({ ok: z.boolean().describe('Never returned.') }),
      handler: (_input, ctx) =>
        withRetry(
          () => {
            throw new McpError(JsonRpcErrorCode.ServiceUnavailable, 'upstream down');
          },
          { operation: 'parity_retry', context: ctx, signal: ctx.signal, baseDelayMs: 60_000 },
        ),
    }) as AnyToolDefinition;

    const controller = new AbortController();
    const run = runToolContract(definition, {} as never, {
      context: { signal: controller.signal },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    expect(envelope(await run).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });

  it.each([
    ['a DOMException AbortError', () => new DOMException('aborted', 'AbortError'), -32004],
    ['a thrown string', () => 'client disconnected', -32603],
  ])(
    'keeps %s thrown while the signal is live on its own classification',
    async (_label, thrown, code) => {
      const definition = tool('parity_live', {
        description: 'Fails without being cancelled.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('Never returned.') }),
        handler: () => {
          throw thrown();
        },
      }) as AnyToolDefinition;

      const production = await viaFactory(definition, {});
      const helper = await runToolContract(definition, {} as never, {
        context: { signal: new AbortController().signal },
      });

      expect(envelope(helper).code).toBe(code);
      expect(helper).toEqual(production);
    },
  );

  it('rejects schema-invalid arguments on a pre-aborted signal as InvalidParams', async () => {
    const controller = new AbortController();
    controller.abort();

    // A boolean stays schema-invalid; an integer for `name` would be repaired (#487).
    const production = (await createToolHandler(
      typed,
      services,
      notifiers,
    )({ name: true }, makeServerContext({ signal: controller.signal }))) as CallToolResult;
    const helper = await runToolContract(typed, { name: true } as never, {
      context: { signal: controller.signal },
    });

    expect(envelope(helper).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope(helper).data?.reason).toBe('invalid_arguments');
    expect(helper).toEqual(production);
  });
});

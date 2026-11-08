/**
 * @fileoverview Tests for tool registration system.
 * @module tests/mcp-server/tools/tool-registration.test
 */
import { Client } from '@modelcontextprotocol/client';
import { type CallToolResult, InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ZodRawShape, z } from 'zod';
import { ToolRegistry } from '@/mcp-server/tools/tool-registration.js';
import { disabledTool } from '@/mcp-server/tools/utils/disabled-tool.js';
import { type AnyToolDefinition, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import type { HandlerServices } from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { advertisedOutputSchema } from '@/mcp-server/tools/utils/toolOutputSchema.js';
import { runToolContract } from '@/testing/index.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { withoutRequestId } from '../../../helpers/tool-result.js';

/**
 * Both schemas reach `registerTool` through the validation-deferring wrapper
 * (#377, #846), so what they advertise is a JSON Schema projection rather than
 * a Zod `.shape` — this reads it the way the SDK does: `input` for
 * `inputSchema`, `output` for `outputSchema`.
 */
function advertised(schema: unknown, io: 'input' | 'output'): Record<string, unknown> {
  const standard = (
    schema as {
      '~standard': {
        jsonSchema: Record<'input' | 'output', (o: { target: string }) => Record<string, unknown>>;
      };
    }
  )['~standard'];
  return standard.jsonSchema[io]({ target: 'draft-2020-12' });
}

/** The result surfaces a caller reads, without the SDK client's parse artifacts. */
function surfaces(result: Pick<CallToolResult, 'content' | 'isError' | 'structuredContent'>) {
  return {
    content: result.content,
    isError: result.isError,
    structuredContent: result.structuredContent,
  };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    crit: vi.fn(),
    emerg: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('@/config/index.js', () => ({
  config: {
    environment: 'testing',
    mcpServerVersion: '1.0.0-test',
    mcpAuthMode: 'none',
    openTelemetry: { serviceName: 'test', serviceVersion: '0.0.0' },
  },
}));

vi.mock('@/utils/internal/logger.js', () => ({
  logger: mockLogger,
  Logger: { getInstance: () => mockLogger },
}));

vi.mock('@/utils/internal/requestContext.js', () => ({
  toCanonicalContext: (context: Record<string, unknown>) =>
    Object.fromEntries(
      [
        'auth',
        'extra',
        'operation',
        'requestId',
        'sessionId',
        'spanId',
        'tenantId',
        'timestamp',
        'traceId',
      ]
        .filter((k) => context[k] !== undefined)
        .map((k) => [k, context[k]]),
    ),
  withExtra: (ctx: { extra?: Record<string, unknown> }, fields: Record<string, unknown>) => ({
    ...ctx,
    extra: { ...ctx.extra, ...fields },
  }),
  requestContextService: {
    createRequestContext: vi.fn((opts: any) => ({
      requestId: 'test-req-id',
      timestamp: new Date().toISOString(),
      operation: opts?.operation ?? 'test',
    })),
  },
}));

vi.mock('@/utils/internal/performance.js', () => ({
  // Passes the span-bound context through, as the real implementation does —
  // the handler factory builds its `ctx` from that argument. The second
  // argument designates the payload the output-size metrics measure; this stub
  // records nothing.
  measureToolExecution: vi.fn(
    (
      fn: (spanContext: unknown, recordOutput: (payload: unknown) => void) => unknown,
      context: unknown,
    ) => fn(context, () => {}),
  ),
  recordToolRejection: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const mockStorage = {
  get: vi.fn(async () => null),
  set: vi.fn(async () => {}),
  delete: vi.fn(async () => {}),
  list: vi.fn(async () => ({ keys: [] })),
  getMany: vi.fn(async () => new Map()),
};

const services: HandlerServices = {
  logger: mockLogger as any,
  storage: mockStorage as any,
};

/** Registers `defs` on an in-memory `McpServer` and connects an SDK `Client` to it. */
async function serve(defs: AnyToolDefinition[]) {
  const server = new McpServer(
    { name: 'served-tools', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  await new ToolRegistry(defs, services).registerAll(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'served-tools-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe('ToolRegistry', () => {
  let mockServer: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = {
      registerTool: vi.fn(() => {}),
      sendPromptListChanged: vi.fn(() => {}),
      sendResourceListChanged: vi.fn(() => {}),
      sendToolListChanged: vi.fn(() => {}),
    };
  });

  describe('Tool Registration', () => {
    it('should register a single tool successfully', async () => {
      const testTool = tool('test_tool', {
        description: 'A test tool',
        input: z.object({ input: z.string().describe('input') }),
        output: z.object({ output: z.string().describe('output') }),
        handler: (input) => ({ output: input.input.toUpperCase() }),
      });

      const registry = new ToolRegistry([testTool], services);
      await registry.registerAll(mockServer);

      expect(mockServer.registerTool).toHaveBeenCalledTimes(1);
      const call = mockServer.registerTool.mock.calls[0];
      expect(call[0]).toBe('test_tool');
      expect(call[1].description).toBe('A test tool');
      expect(typeof call[2]).toBe('function');
    });
  });

  describe('Disabled Tools', () => {
    it('should skip MCP registration for tools wrapped with disabledTool()', async () => {
      const enabledDef = tool('enabled_tool', {
        description: 'Enabled tool',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
      });
      const disabledDef = disabledTool(
        tool('disabled_tool', {
          description: 'Disabled tool',
          input: z.object({}),
          output: z.object({}),
          handler: () => ({}),
        }),
        { reason: 'Writes are turned off in this deployment.' },
      );

      const registry = new ToolRegistry([enabledDef, disabledDef], services);
      await registry.registerAll(mockServer);

      expect(mockServer.registerTool).toHaveBeenCalledTimes(1);
      expect(mockServer.registerTool.mock.calls[0][0]).toBe('enabled_tool');
    });
  });

  describe('Title Derivation', () => {
    it('should use explicit title when provided', async () => {
      const testTool = tool('my_tool', {
        title: 'Custom Title',
        description: 'Test tool',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
      });

      const registry = new ToolRegistry([testTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1].title).toBe('Custom Title');
    });

    it('should use annotation title when no explicit title', async () => {
      const testTool = tool('my_tool', {
        description: 'Test tool',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
        annotations: { title: 'Annotation Title' },
      });

      const registry = new ToolRegistry([testTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1].title).toBe('Annotation Title');
    });

    it('should derive title from name when no title provided', async () => {
      const testTool = tool('echo_message_test', {
        description: 'Test tool',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
      });

      const registry = new ToolRegistry([testTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1].title).toBe('Echo Message Test');
    });

    it('should prefer explicit title over annotation title', async () => {
      const testTool = tool('my_tool', {
        title: 'Explicit Title',
        description: 'Test tool',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
        annotations: { title: 'Annotation Title' },
      });

      const registry = new ToolRegistry([testTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1].title).toBe('Explicit Title');
    });
  });

  describe('Schema Registration', () => {
    const typedTool = tool('typed_tool', {
      description: 'Tool with schemas',
      input: z.object({
        name: z.string().describe('name'),
        age: z.number().describe('age'),
      }),
      output: z.object({
        greeting: z.string().describe('greeting'),
      }),
      handler: (input) => ({ greeting: `Hello ${input.name}` }),
    });

    it('should register input and output schemas', async () => {
      const registry = new ToolRegistry([typedTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1].inputSchema).toBeDefined();
      expect(call[1].outputSchema).toBeDefined();
      expect(advertised(call[1].inputSchema, 'input').properties).toHaveProperty('name');
      expect(advertised(call[1].outputSchema, 'output').properties).toHaveProperty('greeting');
    });

    it('should advertise the widened output schema, not the strict parse schema', async () => {
      const registry = new ToolRegistry([typedTool], services);
      await registry.registerAll(mockServer);

      const registered = mockServer.registerTool.mock.calls[0][1].outputSchema;
      const projection = advertised(registered, 'output');
      // Registration advertises `advertisedOutputSchema` — success fields
      // optional plus a declared `error` envelope (#241) — byte for byte.
      expect(projection).toEqual(
        z.toJSONSchema(advertisedOutputSchema(typedTool as AnyToolDefinition), {
          target: 'draft-2020-12',
          io: 'output',
        }),
      );
      expect(projection.properties).toHaveProperty('error');
      expect(projection.required).toBeUndefined();
      expect(z.toJSONSchema(typedTool.output, { io: 'output' }).required).toEqual(['greeting']);
      // The SDK re-validates `structuredContent` through this schema after the
      // handler returns; it passes the value through, so the framework's strict
      // parse of `output` is the only output check (#846).
      const sent = { greeting: 42 };
      expect(registered['~standard'].validate(sent)).toEqual({ value: sent });
    });

    it.each([
      ['.passthrough()', z.object({ id: z.string().describe('ID') }).passthrough(), {}],
      [
        '.catchall(z.string())',
        z.object({ id: z.string().describe('ID') }).catchall(z.string()),
        { type: 'string' },
      ],
    ])(
      'keeps a %s output root open for a client that validates structuredContent',
      async (_label, output, additional) => {
        // The SDK client checks a success result's structuredContent against the
        // advertised outputSchema, so a root advertised closed would turn every
        // call returning an extra key into a client-side -32602.
        const openOutput = tool('open_output_tool', {
          description: 'Returns keys its output schema leaves open.',
          input: z.object({}),
          output: output as z.ZodObject<{ id: z.ZodString }>,
          handler: () => ({ id: 'a', extra: 'kept' }) as { id: string },
        });
        const { client, close } = await serve([openOutput as AnyToolDefinition]);
        try {
          const { tools } = await client.listTools();
          const result = await client.callTool({ name: 'open_output_tool', arguments: {} });

          expect(tools[0]?.outputSchema?.additionalProperties).toEqual(additional);
          expect(result.isError).toBeUndefined();
          expect(result.structuredContent).toEqual({ id: 'a', extra: 'kept' });
        } finally {
          await close();
        }
      },
    );
  });

  /**
   * Output fields whose parsed value is not valid input to the field itself: the
   * framework parses a handler's result once, and nothing downstream may parse
   * that output again (#846). Each row is the field, what the handler returns,
   * and the parsed value a caller receives.
   */
  describe('served tools/call output parsed once (#846)', () => {
    const fieldRows: Array<
      [string, ZodRawShape, Record<string, unknown>, Record<string, unknown>]
    > = [
      [
        'z.stringbool()',
        { flag: z.stringbool().describe('Flag') },
        { flag: 'true' },
        { flag: true },
      ],
      [
        'a cross-type .pipe()',
        {
          len: z
            .string()
            .transform((s) => s.length)
            .pipe(z.number())
            .describe('Length'),
        },
        { len: 'hello' },
        { len: 5 },
      ],
      [
        'z.codec()',
        {
          n: z.codec(z.string(), z.number(), { decode: Number, encode: String }).describe('Number'),
        },
        { n: '42' },
        { n: 42 },
      ],
      [
        'a z.stringbool() nested in an array of objects',
        {
          items: z.array(z.object({ flag: z.stringbool().describe('Flag') })).describe('Items'),
        },
        { items: [{ flag: 'yes' }, { flag: 'off' }] },
        { items: [{ flag: true }, { flag: false }] },
      ],
    ];

    /** A tool returning `returned` through `shape`, enriching `note` when `enriched`. */
    function fieldTool(
      name: string,
      shape: ZodRawShape,
      returned: Record<string, unknown>,
      enriched: boolean,
    ): AnyToolDefinition {
      return tool(name, {
        description: 'Returns one field whose parsed value is not valid input to the field.',
        input: z.object({}),
        output: z.object(shape),
        ...(enriched && { enrichment: { note: z.string().optional().describe('Note') } }),
        handler: (_input: unknown, ctx: any) => {
          if (enriched) ctx.enrich({ note: 'hi' });
          return returned;
        },
      } as any) as AnyToolDefinition;
    }

    const rows = fieldRows.flatMap(([label, shape, returned, parsed]) =>
      [false, true].map((enriched) => [label, enriched, shape, returned, parsed] as const),
    );

    it.each(rows)(
      'returns %s parsed (enrichment declared: %s) on both surfaces',
      async (_label, enriched, shape, returned, parsed) => {
        const def = fieldTool('field_tool', shape, returned, enriched);
        const { client, close } = await serve([def]);
        try {
          const result = await client.callTool({ name: 'field_tool', arguments: {} });

          expect(result.isError).toBeUndefined();
          expect(result.structuredContent).toEqual(enriched ? { ...parsed, note: 'hi' } : parsed);
          const content = result.content as Array<{ text: string; type: 'text' }>;
          expect(JSON.parse(content[0]?.text ?? '')).toEqual(parsed);
          expect(content.slice(1).map((block) => block.text)).toEqual(
            enriched ? ['\n\n**note:** `hi`'] : [],
          );
          // The served call and the test kit's contract runner agree.
          expect(surfaces(result)).toEqual(surfaces(await runToolContract(def, {})));
        } finally {
          await close();
        }
      },
    );

    it.each(rows)(
      'advertises the widened projection of %s unchanged (enrichment declared: %s)',
      async (_label, enriched, shape, returned) => {
        const def = fieldTool('field_tool', shape, returned, enriched);
        const { client, close } = await serve([def]);
        try {
          const { tools } = await client.listTools();

          expect(tools[0]?.outputSchema).toEqual(
            z.toJSONSchema(advertisedOutputSchema(def), { target: 'draft-2020-12', io: 'output' }),
          );
        } finally {
          await close();
        }
      },
    );

    it('still fails a result that breaks output as -32603 naming the output contract', async () => {
      const def = fieldTool(
        'flag_bad',
        { flag: z.stringbool().describe('Flag') },
        { flag: 'maybe' },
        false,
      );
      const { client, close } = await serve([def]);
      try {
        const result = (await client.callTool({
          name: 'flag_bad',
          arguments: {},
        })) as CallToolResult;
        const { error } = result.structuredContent as { error: { code: number; message: string } };
        const issue = z.stringbool().safeParse('maybe').error?.issues[0]?.message;

        expect(result.isError).toBe(true);
        expect(error.code).toBe(JsonRpcErrorCode.InternalError);
        expect(error.message).toBe(
          `Tool flag_bad returned output that does not match its output schema: flag: ${issue}`,
        );
        expect(surfaces(withoutRequestId(result))).toEqual(
          surfaces(await runToolContract(def, {})),
        );
      } finally {
        await close();
      }
    });

    it('still fails a required enrichment field never populated, naming the enrichment contract', async () => {
      const def = tool('flag_unenriched', {
        description: 'Declares a required enrichment field it never populates.',
        input: z.object({}),
        output: z.object({ flag: z.stringbool().describe('Flag') }),
        enrichment: { total: z.number().describe('Required total') },
        handler: () => ({ flag: 'true' }) as never,
      }) as AnyToolDefinition;
      const { client, close } = await serve([def]);
      try {
        const result = (await client.callTool({
          name: 'flag_unenriched',
          arguments: {},
        })) as CallToolResult;
        const { error } = result.structuredContent as { error: { code: number; message: string } };
        const issue = z.number().safeParse(undefined).error?.issues[0]?.message;

        expect(result.isError).toBe(true);
        expect(error.code).toBe(JsonRpcErrorCode.InternalError);
        expect(error.message).toBe(
          `Tool flag_unenriched returned enrichment that does not match its enrichment schema: total: ${issue}`,
        );
        expect(surfaces(withoutRequestId(result))).toEqual(
          surfaces(await runToolContract(def, {})),
        );
      } finally {
        await close();
      }
    });
  });

  /**
   * `structuredContent.error` is the failure envelope on the wire, so a success
   * carrying one reads as a failure. `tool()` refuses an `error` field declared
   * in `output` or `enrichment`; an open root can still return one undeclared.
   */
  describe('a successful result carrying a top-level error key', () => {
    const reserved =
      'error: Reserved for the failure envelope; a successful result cannot carry it';

    /** Calls `def` served and through `runToolContract`, asserting the two agree. */
    async function callBoth(def: AnyToolDefinition) {
      const { client, close } = await serve([def]);
      try {
        const result = (await client.callTool({ name: def.name, arguments: {} })) as CallToolResult;
        const contract = await runToolContract(def, {});
        return { contract, result };
      } finally {
        await close();
      }
    }

    it.each([
      [
        'a string under .passthrough()',
        z.object({ id: z.string().describe('ID') }).passthrough(),
        'x',
      ],
      [
        'an envelope-shaped object under .passthrough()',
        z.object({ id: z.string().describe('ID') }).passthrough(),
        { code: JsonRpcErrorCode.NotFound, message: 'looks like a failure' },
      ],
      [
        'null under .passthrough()',
        z.object({ id: z.string().describe('ID') }).passthrough(),
        null,
      ],
      [
        'a string under .catchall(z.string())',
        z.object({ id: z.string().describe('ID') }).catchall(z.string()),
        'boom',
      ],
    ])('fails %s as -32603 naming the output contract', async (_label, output, value) => {
      const def = tool('open_error_key', {
        description: 'Returns an undeclared error key its open root keeps.',
        input: z.object({}),
        output: output as z.ZodObject<{ id: z.ZodString }>,
        handler: () => ({ id: 'a', error: value }) as never,
      }) as AnyToolDefinition;

      const { contract, result } = await callBoth(def);
      const { error } = result.structuredContent as { error: { code: number; message: string } };

      expect(result.isError).toBe(true);
      expect(error.code).toBe(JsonRpcErrorCode.InternalError);
      expect(error.message).toBe(
        `Tool open_error_key returned output that does not match its output schema: ${reserved}`,
      );
      expect(surfaces(withoutRequestId(result))).toEqual(surfaces(contract));
    });

    it('fails an undeclared error key enriched under .passthrough(), naming the enrichment contract', async () => {
      const def = tool('open_error_enriched', {
        description: 'Enriches an undeclared error key from the service layer.',
        input: z.object({}),
        output: z.object({ id: z.string().describe('ID') }).passthrough(),
        enrichment: { totalCount: z.number().describe('Total') },
        handler: (_input, ctx) => {
          (ctx.enrich as (fields: Record<string, unknown>) => void)({ totalCount: 1, error: 'x' });
          return { id: 'a' };
        },
      }) as AnyToolDefinition;

      const { contract, result } = await callBoth(def);
      const { error } = result.structuredContent as { error: { code: number; message: string } };

      expect(result.isError).toBe(true);
      expect(error.code).toBe(JsonRpcErrorCode.InternalError);
      expect(error.message).toBe(
        `Tool open_error_enriched returned enrichment that does not match its enrichment schema: ${reserved}`,
      );
      expect(surfaces(withoutRequestId(result))).toEqual(surfaces(contract));
    });

    it('drops an undeclared error key under a default (stripping) root and succeeds', async () => {
      const def = tool('strip_error_key', {
        description: 'Returns an undeclared error key its root strips.',
        input: z.object({}),
        output: z.object({ id: z.string().describe('ID') }),
        handler: () => ({ id: 'a', error: 'x' }) as never,
      }) as AnyToolDefinition;

      const { contract, result } = await callBoth(def);

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ id: 'a' });
      expect(surfaces(result)).toEqual(surfaces(contract));
    });
  });

  describe('Annotations', () => {
    it('should register annotations when provided', async () => {
      const testTool = tool('annotated_tool', {
        description: 'Tool with annotations',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      });

      const registry = new ToolRegistry([testTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1].annotations).toBeDefined();
      expect(call[1].annotations.readOnlyHint).toBe(true);
      expect(call[1].annotations.idempotentHint).toBe(true);
      expect(call[1].annotations.openWorldHint).toBe(false);
    });

    it('should not include annotations field when none provided', async () => {
      const testTool = tool('plain_tool', {
        description: 'Tool without annotations',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
      });

      const registry = new ToolRegistry([testTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1].annotations).toBeUndefined();
    });
  });

  describe('Registration Order', () => {
    it('should register tools in the order they are provided', async () => {
      const tools = [
        tool('first', {
          description: 'First tool',
          input: z.object({}),
          output: z.object({}),
          handler: () => ({}),
        }),
        tool('second', {
          description: 'Second tool',
          input: z.object({}),
          output: z.object({}),
          handler: () => ({}),
        }),
        tool('third', {
          description: 'Third tool',
          input: z.object({}),
          output: z.object({}),
          handler: () => ({}),
        }),
      ];

      const registry = new ToolRegistry(tools, services);
      await registry.registerAll(mockServer);

      expect(mockServer.registerTool.mock.calls[0][0]).toBe('first');
      expect(mockServer.registerTool.mock.calls[1][0]).toBe('second');
      expect(mockServer.registerTool.mock.calls[2][0]).toBe('third');
    });
  });

  describe('_meta Passthrough', () => {
    it('should pass _meta to server.registerTool for standard tools', async () => {
      const testTool = tool('app_tool', {
        description: 'App tool with _meta',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
        _meta: {
          ui: { resourceUri: 'ui://my-app/app.html' },
          'ui/resourceUri': 'ui://my-app/app.html',
        },
      });

      const registry = new ToolRegistry([testTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1]._meta).toEqual({
        ui: { resourceUri: 'ui://my-app/app.html' },
        'ui/resourceUri': 'ui://my-app/app.html',
      });
    });

    it('should not include _meta when not provided', async () => {
      const testTool = tool('plain_tool', {
        description: 'Tool without _meta',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
      });

      const registry = new ToolRegistry([testTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1]._meta).toBeUndefined();
    });

    it('should not publish errors[] contract under _meta on standard tools', async () => {
      const errorContractTool = tool('contract_tool', {
        description: 'Tool with errors contract',
        input: z.object({}),
        output: z.object({}),
        errors: [
          {
            reason: 'no_match',
            code: JsonRpcErrorCode.NotFound,
            when: 'No match found.',
            recovery: 'Broaden the query and try again with looser filters.',
          },
        ],
        handler: () => ({}),
      });

      const registry = new ToolRegistry([errorContractTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1]._meta).toBeUndefined();
    });

    it('should not merge errors[] contract into custom _meta on standard tools', async () => {
      const mixedTool = tool('mixed_tool', {
        description: 'Tool with both errors and _meta',
        input: z.object({}),
        output: z.object({}),
        errors: [
          {
            reason: 'no_match',
            code: JsonRpcErrorCode.NotFound,
            when: 'No match found.',
            recovery: 'Broaden the query and try again with looser filters.',
          },
        ],
        _meta: { ui: { resourceUri: 'ui://mixed/app.html' } },
        handler: () => ({}),
      });

      const registry = new ToolRegistry([mixedTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1]._meta).toEqual({ ui: { resourceUri: 'ui://mixed/app.html' } });
      expect(call[1]._meta).not.toHaveProperty('mcp-ts-core/errors');
    });
  });
});

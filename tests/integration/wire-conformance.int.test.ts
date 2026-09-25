/**
 * @fileoverview Wire-level regressions for the decisions taken in the SDK v2
 * migration's wire-tightening review (#305 Phase 1). Each case pins a byte the
 * framework now puts on the wire, driven through a real MCP client so the
 * assertions are on what a caller actually receives.
 * @module tests/integration/wire-conformance.int.test
 */
import { Client, ProtocolErrorCode } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { config } from '@/config/index.js';
import { buildServerManifest } from '@/core/serverManifest.js';
import { PromptRegistry } from '@/mcp-server/prompts/prompt-registration.js';
import { prompt } from '@/mcp-server/prompts/utils/promptDefinition.js';
import { ResourceRegistry } from '@/mcp-server/resources/resource-registration.js';
import { installResourceSubscriptions } from '@/mcp-server/resources/resourceSubscriptions.js';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { ToolRegistry } from '@/mcp-server/tools/tool-registration.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { advertisedOutputSchema } from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { MODERN_PROTOCOL_REVISION } from '@/mcp-server/types.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { logger } from '@/utils/internal/logger.js';

/** Proves an argument rejection never reaches the handler (#377). */
let handlerCalls = 0;

const searchTool = tool('wire_search', {
  description: 'Searches for things.',
  input: z.object({
    query: z.string().min(1).describe('Search query.'),
    limit: z.number().int().min(1).max(50).default(10).describe('Maximum results.'),
  }),
  output: z.object({
    hits: z.array(z.string()).describe('Matching identifiers.'),
    total: z.number().int().describe('Total matches.'),
  }),
  errors: [
    {
      code: JsonRpcErrorCode.NotFound,
      reason: 'index_missing',
      when: 'The search index has not been built.',
      recovery: 'Build the index before searching again.',
    },
  ],
  handler(input, ctx) {
    handlerCalls++;
    if (input.query === 'boom') throw ctx.fail('index_missing');
    // Stands in for a service throwing below the handler — the SQL gate, a
    // parser — with a `data.reason` the tool's own contract never declared.
    if (input.query === 'gate') {
      throw new McpError(JsonRpcErrorCode.ValidationError, 'Function not permitted.', {
        reason: 'denied_function',
      });
    }
    ctx.log.info('searching', { query: input.query });
    return { hits: [input.query], total: 1 };
  },
});

/**
 * A required enum and an optional blank-or-enum union — the two argument shapes
 * whose rejection text the flat formatter rewrites (#378, #417).
 */
const facetTool = tool('wire_facet', {
  description: 'Reads one facet, optionally scoped to a court.',
  input: z.object({
    what: z.enum(['os', 'cpu', 'memory']).describe('Facet to read.'),
    court: z
      .union([z.literal(''), z.enum(['CJEU', 'GC'])])
      .optional()
      .describe('Court, or blank for any.'),
  }),
  output: z.object({ facet: z.string().describe('The facet that was read.') }),
  handler: (input) => ({ facet: input.what }),
});

const docResource = resource('wire://doc/{id}', {
  name: 'wire_doc',
  description: 'A document.',
  params: z.object({ id: z.string().describe('Document id.') }),
  output: z.object({ id: z.string().describe('Document id.') }),
  handler: (params) => ({ id: params.id }),
});

const greetPrompt = prompt('wire_greet', {
  description: 'Greets someone.',
  args: z.object({
    name: z.string().describe('Who to greet.'),
    style: z.string().default('friendly').describe('Greeting style.'),
  }),
  generate: (args) => [
    { role: 'user', content: { type: 'text', text: `Greet ${args.name} (${args.style})` } },
  ],
});

/** A service that wraps its work in `ErrorHandler.tryCatch`, as the api-errors skill documents (#519). */
const failingService = () =>
  ErrorHandler.tryCatch(
    () => {
      throw new Error('db read failed', { cause: new Error('EACCES') });
    },
    { operation: 'WireService.read' },
  );

const serviceTool = tool('wire_service', {
  description: 'Reads through a failing service, or fails directly.',
  input: z.object({
    direct: z
      .boolean()
      .default(false)
      .describe('Throw a plain Error instead of calling the service.'),
  }),
  output: z.object({ ok: z.boolean().describe('True on success.') }),
  async handler(input) {
    if (input.direct) throw new Error('direct failure');
    await failingService();
    return { ok: true };
  },
});

const serviceResource = resource('wire://service/{id}', {
  name: 'wire_service_doc',
  description: 'Reads through a failing service, or fails directly.',
  params: z.object({ id: z.string().describe('"direct" throws a plain Error.') }),
  async handler(params) {
    if (params.id === 'direct') throw new Error('direct failure');
    return await failingService();
  },
});

const failingPrompt = prompt('wire_failing', {
  description: 'Fails in the requested way.',
  args: z.object({
    mode: z.enum(['plain', 'cause', 'mcp', 'service']).describe('How generate() fails.'),
  }),
  async generate(args) {
    if (args.mode === 'plain') throw new Error('upstream lookup failed');
    if (args.mode === 'cause') {
      throw new Error('upstream lookup failed', { cause: new Error('socket hang up') });
    }
    if (args.mode === 'mcp') {
      throw new McpError(JsonRpcErrorCode.NotFound, 'no such topic', { topic: 'x' });
    }
    return await failingService();
  },
});

async function connect() {
  const server = new McpServer(
    { name: 'wire-conformance', version: '0.0.0' },
    {
      capabilities: {
        logging: {},
        prompts: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
        tools: { listChanged: true },
      },
    },
  );
  const subscriptions = installResourceSubscriptions(server);
  const services = { logger, storage: new StorageService(new InMemoryProvider()) };
  // `searchTool` stays first: the schema assertions below read `tools[0]`.
  await new ToolRegistry([searchTool, facetTool, serviceTool], services).registerAll(
    server,
    subscriptions,
  );
  await new ResourceRegistry([docResource, serviceResource], services).registerAll(
    server,
    subscriptions,
  );
  // `greetPrompt` stays first: the requiredness assertion reads `prompts[0]`.
  await new PromptRegistry([greetPrompt, failingPrompt], logger).registerAll(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'wire-conformance-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

/** Compiles the `outputSchema` a tool advertises in `tools/list`, as a strict client would. */
async function advertisedOutputValidator(client: Client, name: string) {
  const { tools } = await client.listTools();
  const outputSchema = tools.find((t) => t.name === name)?.outputSchema;
  if (!outputSchema) throw new Error(`${name} advertises no outputSchema`);
  const validator = new AjvJsonSchemaValidator();
  return validator.getValidator(outputSchema as Parameters<typeof validator.getValidator>[0]);
}

describe('Phase 1 wire conformance', () => {
  const open: Array<{ client: Client; server: McpServer }> = [];

  afterEach(async () => {
    while (open.length) {
      const pair = open.pop();
      await pair?.client.close().catch(() => undefined);
      await pair?.server.close().catch(() => undefined);
    }
  });

  const session = async () => {
    const pair = await connect();
    open.push(pair);
    return pair.client;
  };

  describe('advertised schemas emit JSON Schema 2020-12 (obsidian-mcp-server#109)', () => {
    it('stamps the 2020-12 $schema on inputSchema and outputSchema', async () => {
      const client = await session();
      const { tools } = await client.listTools();
      const advertised = tools[0] as {
        inputSchema: { $schema?: string };
        outputSchema?: { $schema?: string };
      };

      // A strict 2020-12 client rejects the v1 draft-07 dialect before it
      // dispatches any call.
      expect(advertised.inputSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(advertised.outputSchema?.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    });
  });

  describe('strict tool input (#232)', () => {
    it('advertises additionalProperties: false', async () => {
      const client = await session();
      const { tools } = await client.listTools();
      expect((tools[0] as { inputSchema: Record<string, unknown> }).inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
    });

    it('rejects an unrecognized argument key by name', async () => {
      const client = await session();
      const result = await client.callTool({
        name: 'wire_search',
        arguments: { query: 'ok', limt: 5 },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
      expect(text).toContain('Unrecognized key: "limt"');
    });
  });

  describe('argument-validation error envelope (#377)', () => {
    const rejections: Array<[label: string, args: Record<string, unknown>]> = [
      ['an unknown root key', { query: 'ok', salt: true }],
      ['a wrong argument type', { query: 123 }],
      ['a missing required field', {}],
      ['a failed constraint', { query: '' }],
    ];

    it.each(rejections)('carries a structured error for %s', async (_label, args) => {
      const client = await session();
      handlerCalls = 0;

      const result = await client.callTool({ name: 'wire_search', arguments: args });

      expect(result.isError).toBe(true);
      const error = (
        result.structuredContent as {
          error?: {
            code?: number;
            data?: { reason?: string; recovery?: { hint?: string } };
            message?: string;
          };
        }
      )?.error;
      expect(error?.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error?.message?.length ?? 0).toBeGreaterThan(0);
      // #445: an argument rejection is a declared failure mode with a next
      // step, the same as any handler error.
      expect(error?.data?.reason).toBe('invalid_arguments');
      expect(error?.data?.recovery?.hint?.length ?? 0).toBeGreaterThan(0);
      // The rejection is the schema's, not the handler's — it never ran.
      expect(handlerCalls).toBe(0);
    });

    it('keeps the readable diagnostic in content[] alongside the envelope', async () => {
      const client = await session();
      const result = await client.callTool({
        name: 'wire_search',
        arguments: { query: 'ok', salt: true },
      });

      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
      expect(text).toContain('Invalid arguments for tool wire_search');
      expect(text).toContain('salt');
      // The existing hint mirror carries the accepted-key list to format-only
      // clients with no extra work (#445).
      expect(text).toContain('Recovery: Unknown key salt. This tool accepts: query, limit.');
      // #458: the branchable reason rides the same text; the numeric code does not.
      expect(text.endsWith('\n\n(reason invalid_arguments)')).toBe(true);
      expect(text).not.toContain('-32602');
    });

    it('renders a declared reason on the text surface (#458)', async () => {
      // The contract entry declares no `retryable`, so no key is injected and
      // no retryable term renders.
      const client = await session();

      const result = await client.callTool({ name: 'wire_search', arguments: { query: 'boom' } });

      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
      expect(text).toBe('Error: The search index has not been built.\n\n(reason index_missing)');
    });

    it('emits an envelope the advertised outputSchema accepts', async () => {
      const client = await session();
      const { tools } = await client.listTools();
      const advertised = (tools[0] as { outputSchema?: Record<string, unknown> }).outputSchema;
      // `tools/list` publishes the JSON Schema projection of this very schema,
      // so parsing against the source is the same contract without pulling in
      // a JSON Schema validator. wire_search declares domain error reasons, so
      // this is the widened shape a contract-carrying tool advertises.
      expect(advertised?.properties).toHaveProperty('error');

      const result = await client.callTool({ name: 'wire_search', arguments: {} });
      expect(advertisedOutputSchema(searchTool).safeParse(result.structuredContent).success).toBe(
        true,
      );
    });

    it('still parses valid arguments and applies declared defaults', async () => {
      const client = await session();
      handlerCalls = 0;

      const result = await client.callTool({ name: 'wire_search', arguments: { query: 'ok' } });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ hits: ['ok'], total: 1 });
      expect(handlerCalls).toBe(1);
    });
  });

  describe('missing-vs-wrong and union rendering (#378, #417)', () => {
    /** The `content[]` diagnostic a client reads for a rejected call. */
    const rejectionText = async (args: Record<string, unknown>) => {
      const client = await session();
      const result = await client.callTool({ name: 'wire_facet', arguments: args });
      expect(result.isError).toBe(true);
      return (result.content as Array<{ text: string }>)[0]?.text ?? '';
    };

    it('renders an omitted required enum as missing, not as a wrong choice (#378)', async () => {
      expect(await rejectionText({})).toContain(
        'what: Missing required field. Expected one of "os"|"cpu"|"memory"',
      );
    });

    it('keeps the invalid-option sentence for a value outside the set (#378)', async () => {
      expect(await rejectionText({ what: 'bogus' })).toContain(
        'what: Invalid option: expected one of "os"|"cpu"|"memory"',
      );
    });

    it("renders a union's branch message rather than its placeholder (#417)", async () => {
      const text = await rejectionText({ what: 'os', court: 'bogus' });

      expect(text).toContain('court: Invalid option: expected one of "CJEU"|"GC"');
      expect(text).not.toContain('court: Invalid input');
    });

    it('emits an envelope the advertised outputSchema accepts', async () => {
      const client = await session();
      const result = await client.callTool({ name: 'wire_facet', arguments: {} });

      expect(advertisedOutputSchema(facetTool).safeParse(result.structuredContent).success).toBe(
        true,
      );
      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'invalid_arguments',
            recovery: { hint: 'Provide what.' },
          },
        },
      });
    });
  });

  describe('flat input-validation sentences (#66)', () => {
    it('formats a validation failure as `path: message`, not a serialized issue array', async () => {
      const client = await session();
      const result = await client.callTool({
        name: 'wire_search',
        arguments: { query: '' },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

      expect(text).toContain('Invalid arguments for tool wire_search');
      expect(text).toContain('query:');
      // The v1 blob and its wrapper prefix are both gone.
      expect(text).not.toContain('"code"');
      expect(text).not.toContain('"path"');
      expect(text).not.toMatch(/MCP error -32602:/);
    });
  });

  describe('widened advertised outputSchema (#241)', () => {
    it('keeps an object root and declares the error envelope', async () => {
      const client = await session();
      const { tools } = await client.listTools();
      const outputSchema = (tools[0] as { outputSchema?: Record<string, unknown> })
        .outputSchema as {
        anyOf?: unknown[];
        properties: Record<string, { properties?: Record<string, unknown> }>;
        required?: string[];
        type: string;
      };

      // A non-object root would be projected to `{ result: <natural> }` for
      // every 2025-era client, silently breaking the success path.
      expect(outputSchema.type).toBe('object');
      expect(outputSchema.required).toBeUndefined();
      expect(Object.keys(outputSchema.properties).sort()).toEqual(['error', 'hits', 'total']);
      expect(outputSchema.properties.error?.properties).toMatchObject({
        code: expect.anything(),
        message: expect.anything(),
      });
      // The refinement that recovers the dropped `required`.
      expect(outputSchema.anyOf).toEqual([
        { not: { required: ['error'] }, required: ['hits', 'total'] },
        { required: ['error'] },
      ]);
    });

    it('documents declared reasons on data.reason without constraining it', async () => {
      const client = await session();
      const { tools } = await client.listTools();
      const reason = (
        (tools[0] as { outputSchema?: Record<string, unknown> }).outputSchema as {
          properties: {
            error: {
              properties: {
                data: {
                  properties: {
                    reason: {
                      description?: string;
                      enum?: string[];
                      examples?: string[];
                      type?: string;
                    };
                  };
                };
              };
            };
          };
        }
      ).properties.error.properties.data.properties.reason;

      // An enum here would reject every failure raised below the handler —
      // the `-32602` this widened schema exists to prevent.
      expect(reason.enum).toBeUndefined();
      expect(reason.type).toBe('string');
      expect(reason.examples).toEqual(['index_missing']);
      expect(reason.description).toContain('index_missing');
    });

    it('returns an error envelope that satisfies the advertised schema', async () => {
      const client = await session();
      const validate = await advertisedOutputValidator(client, 'wire_search');
      // A strict client validates `structuredContent` against `outputSchema`;
      // this call is exactly the one that used to fail with `-32602`. The SDK
      // client skips that check on `isError` results, so it is run here.
      const result = await client.callTool({
        name: 'wire_search',
        arguments: { query: 'boom' },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'index_missing' } },
      });
      expect(validate(result.structuredContent)).toMatchObject({ valid: true });
    });

    it('accepts a reason raised below the handler', async () => {
      const client = await session();
      const validate = await advertisedOutputValidator(client, 'wire_search');
      const result = await client.callTool({
        name: 'wire_search',
        arguments: { query: 'gate' },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'denied_function' } },
      });
      expect(validate(result.structuredContent)).toMatchObject({ valid: true });
    });
  });

  describe('prompt argument requiredness (#258)', () => {
    it('advertises a defaulted argument as optional', async () => {
      const client = await session();
      const { prompts } = await client.listPrompts();

      expect(prompts[0]?.arguments).toEqual([
        { name: 'name', description: 'Who to greet.', required: true },
        { name: 'style', description: 'Greeting style.', required: false },
      ]);
    });
  });

  describe('capability truthfulness', () => {
    it('answers logging/setLevel and streams ctx.log to notifications/message', async () => {
      const client = await session();
      const messages: Array<{ data: unknown; level: string }> = [];
      client.setNotificationHandler('notifications/message', (notification) => {
        messages.push(notification.params as { data: unknown; level: string });
      });

      await expect(client.setLoggingLevel('debug')).resolves.toBeDefined();
      await client.callTool({ name: 'wire_search', arguments: { query: 'hello' } });

      expect(messages).toContainEqual(
        expect.objectContaining({
          level: 'info',
          data: expect.objectContaining({ message: 'searching', query: 'hello' }),
        }),
      );
    });
  });

  describe('resource and prompt execution', () => {
    it('reads the registered URI template with its validated output', async () => {
      const client = await session();
      const templates = await client.listResourceTemplates();
      expect(templates.resourceTemplates).toContainEqual(
        expect.objectContaining({ uriTemplate: 'wire://doc/{id}' }),
      );
      const result = await client.readResource({ uri: 'wire://doc/42' });
      expect(result.contents).toEqual([
        {
          uri: 'wire://doc/42',
          mimeType: 'application/json',
          text: JSON.stringify({ id: '42' }, null, 2),
        },
      ]);
      await expect(client.readResource({ uri: 'unknown://missing' })).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
      });
    });

    it('applies prompt defaults and rejects missing required arguments', async () => {
      const client = await session();
      const result = await client.getPrompt({ name: 'wire_greet', arguments: { name: 'Ada' } });
      expect(result.messages).toEqual([
        { role: 'user', content: { type: 'text', text: 'Greet Ada (friendly)' } },
      ]);
      await expect(client.getPrompt({ name: 'wire_greet', arguments: {} })).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
      });
    });
  });

  describe('error data carries no server stack (#519)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** A JSON-RPC error a client call rejected with. */
    type WireError = { code?: number; data?: Record<string, unknown>; message?: string };
    const rejectionOf = (call: Promise<unknown>) =>
      call.then(
        () => expect.unreachable('expected the call to reject'),
        (e: unknown) => e as WireError,
      );
    const expectStackFree = (data: unknown) =>
      expect(JSON.stringify(data ?? {})).not.toMatch(/stack|causeChain/i);

    it.each(['plain', 'cause'])(
      'prompts/get answers a %s generate() failure with the code and message only',
      async (mode) => {
        const client = await session();

        const error = await rejectionOf(
          client.getPrompt({ name: 'wire_failing', arguments: { mode } }),
        );

        expect(error.code).toBe(JsonRpcErrorCode.InternalError);
        expect(error.message).toContain('upstream lookup failed');
        expect(error.data).toBeUndefined();
      },
    );

    it("prompts/get answers a thrown McpError with exactly that error's data", async () => {
      const client = await session();

      const error = await rejectionOf(
        client.getPrompt({ name: 'wire_failing', arguments: { mode: 'mcp' } }),
      );

      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.message).toContain('no such topic');
      expect(error.data).toEqual({ topic: 'x' });
    });

    it('a tryCatch-wrapped service failure keeps its code and loses its stack on every path', async () => {
      const client = await session();
      const errorLog = vi.spyOn(logger, 'error');

      const promptError = await rejectionOf(
        client.getPrompt({ name: 'wire_failing', arguments: { mode: 'service' } }),
      );
      const toolResult = await client.callTool({ name: 'wire_service', arguments: {} });
      const toolError = (toolResult.structuredContent as { error?: WireError }).error;
      const resourceError = await rejectionOf(client.readResource({ uri: 'wire://service/1' }));

      for (const error of [promptError, toolError, resourceError]) {
        expect(error?.code).toBe(JsonRpcErrorCode.InternalError);
        expectStackFree(error?.data);
        expect(error?.data).toMatchObject({
          originalMessage: 'db read failed',
          rootCause: { name: 'Error', message: 'EACCES' },
        });
      }
      // A prompt's rejection carries none of the context its registry was built with.
      expect(promptError.data).not.toHaveProperty('requestId');
      expect(toolResult.isError).toBe(true);

      // The server log still carries the throw-site stack and the cause chain.
      const serviceRecords = errorLog.mock.calls
        .filter(([msg]) => String(msg).startsWith('Error in WireService.read'))
        .map(([, ctx]) => (ctx as Record<string, any>).extra.errorData);
      expect(serviceRecords).toHaveLength(3);
      for (const errorData of serviceRecords) {
        expect(errorData.originalStack).toContain('wire-conformance.int.test.ts');
        expect(errorData.causeChain).toHaveLength(2);
      }
    });

    it('leaves a plain Error thrown directly by a tool or resource with no data', async () => {
      const client = await session();

      const toolResult = await client.callTool({
        name: 'wire_service',
        arguments: { direct: true },
      });
      const resourceError = await rejectionOf(
        client.readResource({ uri: 'wire://service/direct' }),
      );

      expect(toolResult.structuredContent).toEqual({
        error: { code: JsonRpcErrorCode.InternalError, message: 'direct failure' },
      });
      expect(resourceError.code).toBe(JsonRpcErrorCode.InternalError);
      expect(resourceError.data).toBeUndefined();
    });
  });

  describe('advertised protocol revisions', () => {
    it('names 2026-07-28 first in the server manifest', () => {
      const manifest = buildServerManifest({
        config,
        tools: [searchTool],
        resources: [docResource],
        prompts: [greetPrompt],
      });

      // The SDK's SUPPORTED_PROTOCOL_VERSIONS covers only initialize-negotiated
      // revisions, so the per-request 2026 era has to be named explicitly.
      expect(manifest.protocol.supportedVersions[0]).toBe(MODERN_PROTOCOL_REVISION);
      expect(manifest.protocol.supportedVersions).toContain('2025-06-18');
    });
  });
});

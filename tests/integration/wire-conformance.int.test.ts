/**
 * @fileoverview Wire-level regressions for the decisions taken in the SDK v2
 * migration's wire-tightening review (#305 Phase 1). Each case pins a byte the
 * framework now puts on the wire, driven through a real MCP client so the
 * assertions are on what a caller actually receives. The `MCP_LOG_LEVEL` floor
 * on the `ctx.log` mirror (#621) is set at startup, so its cases run a built
 * fixture as a real process over stdio and both HTTP session modes.
 * @module tests/integration/wire-conformance.int.test
 */
import { resolve } from 'node:path';
import {
  Client,
  ProtocolErrorCode,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport, type JSONRPCMessage, McpServer } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { sanitization } from '@/utils/security/sanitization.js';
import { MCP_HEADERS, parseSSEEvents } from '../helpers/http-helpers.js';
import { exchange } from '../helpers/node-http.js';
import { type ServerHandle, startServerFromEntrypoint } from '../helpers/server-process.js';

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

/**
 * The call-site data `wire_log` logs. Module-level so a case can show the wire
 * mirror masks a copy and leaves the caller's object as it was (#630).
 * `accountNumber` matches no default sensitive field; the case registers it.
 */
const wireLogData = {
  apiKey: 'sk-wire-630',
  password: 'hunter2',
  accountNumber: '0000-630',
  region: 'us-east-1',
  upstream: { apiKey: 'sk-wire-630-nested', password: 'hunter3', status: 503 },
};

const logTool = tool('wire_log', {
  description: 'Logs an upstream call whose data carries credentials.',
  input: z.object({}),
  output: z.object({ ok: z.boolean().describe('Always true.') }),
  handler(_input, ctx) {
    ctx.log.info('upstream call', wireLogData);
    ctx.log.error('upstream call failed', new Error('upstream answered 503'), {
      token: 'tok-wire-630',
    });
    return { ok: true };
  },
});

/** The server every session talks to, with the definitions above registered. */
async function buildServer() {
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
  await new ToolRegistry([searchTool, facetTool, serviceTool, logTool], services).registerAll(
    server,
    subscriptions,
  );
  await new ResourceRegistry([docResource, serviceResource], services).registerAll(
    server,
    subscriptions,
  );
  // `greetPrompt` stays first: the requiredness assertion reads `prompts[0]`.
  await new PromptRegistry([greetPrompt, failingPrompt], logger).registerAll(server);
  return server;
}

async function connect() {
  const server = await buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'wire-conformance-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

/** A JSON-RPC response as {@link rawSession} receives it. */
type RawResponse = {
  error?: { code: number; data?: Record<string, unknown>; message: string };
  id: number | string;
  result?: Record<string, unknown>;
};

/**
 * A 2025-era session on the same server, driven as raw JSON-RPC: the SDK client
 * numbers its own requests, so a string id needs a client that sets it (#584).
 */
async function rawSession() {
  const server = await buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number | string, (response: RawResponse) => void>();
  clientTransport.onmessage = (message) => {
    const { id, method } = message as { id?: number | string; method?: string };
    if (id === undefined || method !== undefined) return;
    pending.get(id)?.(message as RawResponse);
    pending.delete(id);
  };
  await server.connect(serverTransport);
  await clientTransport.start();
  const request = (id: number | string, method: string, params: Record<string, unknown>) =>
    new Promise<RawResponse>((resolve) => {
      pending.set(id, resolve);
      void clientTransport.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
    });
  await request('init', 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'wire-conformance-raw', version: '0.0.0' },
  });
  await clientTransport.send({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  } as JSONRPCMessage);
  return { request, close: () => server.close() };
}

/** A framework-generated request id, whatever the type of the client's JSON-RPC id (#584). */
const REQUEST_ID_PATTERN = /^[A-Z0-9]{5}-[A-Z0-9]{5}$/;

/** The `data.requestId` a failed tool call's envelope carries. */
function requestIdOf(result: unknown): string | undefined {
  return (result as { structuredContent?: { error?: { data?: { requestId?: string } } } })
    .structuredContent?.error?.data?.requestId;
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
      // A boolean: an integer for `query` is repaired to its decimal string (#487).
      ['a wrong argument type', { query: true }],
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
      // #458: the branchable reason rides the same text; the numeric code does
      // not. #576: the request id closes the line.
      expect(text.endsWith(`\n\n(reason invalid_arguments · request ${requestIdOf(result)})`)).toBe(
        true,
      );
      expect(text).not.toContain('-32602');
    });

    it('renders a bare ctx.fail with its declared recovery and request id (#458, #576, #579)', async () => {
      // The contract entry declares no `retryable`, so no key is injected and
      // no retryable term renders. The throw site forwards no recovery; the
      // framework fills it from the declared entry.
      const client = await session();

      const result = await client.callTool({ name: 'wire_search', arguments: { query: 'boom' } });

      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
      const requestId = requestIdOf(result);
      expect(requestId).toMatch(REQUEST_ID_PATTERN);
      expect(text).toBe(
        'Error: The search index has not been built.\n\n' +
          'Recovery: Build the index before searching again.\n\n' +
          `(reason index_missing · request ${requestId})`,
      );
      expect(result.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message: 'The search index has not been built.',
          data: {
            reason: 'index_missing',
            recovery: { hint: 'Build the index before searching again.' },
            requestId,
          },
        },
      });
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

    it('masks sensitive fields in the records it mirrors, registered ones included (#630)', async () => {
      sanitization.setSensitiveFields(['accountNumber']);
      const asLogged = structuredClone(wireLogData);
      const client = await session();
      const messages: WireMessage[] = [];
      client.setNotificationHandler('notifications/message', (notification) => {
        messages.push(notification.params as WireMessage);
      });

      const result = await client.callTool({ name: 'wire_log', arguments: {} });

      expect(result.isError).not.toBe(true);
      expect(messages).toEqual([
        {
          level: 'info',
          data: {
            message: 'upstream call',
            apiKey: '[REDACTED]',
            password: '[REDACTED]',
            accountNumber: '[REDACTED]',
            region: 'us-east-1',
            upstream: { apiKey: '[REDACTED]', password: '[REDACTED]', status: 503 },
          },
        },
        {
          level: 'error',
          data: {
            message: 'upstream call failed',
            token: '[REDACTED]',
            error: 'upstream answered 503',
          },
        },
      ]);
      // The mirror masked a copy: the handler's own object still holds every value.
      expect(wireLogData).toEqual(asLogged);
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
        // The call's own request id is the one field added (#576).
        expect(error.data).toEqual({ requestId: expect.stringMatching(REQUEST_ID_PATTERN) });
      },
    );

    it("prompts/get answers a thrown McpError with that error's data and its request id", async () => {
      const client = await session();

      const error = await rejectionOf(
        client.getPrompt({ name: 'wire_failing', arguments: { mode: 'mcp' } }),
      );

      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.message).toContain('no such topic');
      expect(error.data).toEqual({
        topic: 'x',
        requestId: expect.stringMatching(REQUEST_ID_PATTERN),
      });
    });

    it('a tryCatch-wrapped service failure keeps its code and loses its stack and cause on every path', async () => {
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
        expect(error?.data).toMatchObject({ originalMessage: 'db read failed' });
        // Nothing derived from the cause reaches the wire (#644).
        expect(error?.data).not.toHaveProperty('rootCause');
        expect(JSON.stringify(error?.data)).not.toContain('EACCES');
      }
      // A prompt's rejection carries its own call's request id — the one its
      // `Error in prompt:` record logs — and none of the registry's context (#576).
      const promptRecord = errorLog.mock.calls.find(([msg]) =>
        String(msg).startsWith('Error in prompt:wire_failing'),
      )?.[1] as { operation?: string; requestId?: string } | undefined;
      expect(promptError.data?.requestId).toBe(promptRecord?.requestId);
      expect(promptRecord?.operation).not.toBe('PromptRegistry.registerAll');
      for (const error of [promptError, toolError, resourceError]) {
        expect(error?.data?.requestId).toEqual(expect.stringMatching(REQUEST_ID_PATTERN));
        expect(error?.data).not.toHaveProperty('operation');
      }
      expect(toolResult.isError).toBe(true);

      // The server log still carries the throw-site stack, once (#694), and the cause chain.
      const serviceRecords = errorLog.mock.calls
        .filter(([msg]) => String(msg).startsWith('Error in WireService.read'))
        .map(([, ctx]) => (ctx as Record<string, any>).extra);
      expect(serviceRecords).toHaveLength(3);
      for (const { stack, errorData } of serviceRecords) {
        expect(stack).toContain('wire-conformance.int.test.ts');
        expect(errorData).not.toHaveProperty('originalStack');
        expect(errorData.causeChain).toHaveLength(2);
        expect(errorData.rootCause).toEqual({ name: 'Error', message: 'EACCES' });
      }
    });

    it('gives a plain Error thrown directly by a tool or resource only the request id', async () => {
      const client = await session();

      const toolResult = await client.callTool({
        name: 'wire_service',
        arguments: { direct: true },
      });
      const resourceError = await rejectionOf(
        client.readResource({ uri: 'wire://service/direct' }),
      );

      expect(toolResult.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.InternalError,
          message: 'direct failure',
          data: { requestId: expect.stringMatching(REQUEST_ID_PATTERN) },
        },
      });
      expect((toolResult.content as Array<{ text: string }>)[0]?.text).toBe(
        `Error: direct failure\n\n(request ${requestIdOf(toolResult)})`,
      );
      expect(resourceError.code).toBe(JsonRpcErrorCode.InternalError);
      expect(resourceError.data).toEqual({ requestId: expect.stringMatching(REQUEST_ID_PATTERN) });
    });

    it('leaves the SDK resource-not-found shape exactly { uri }', async () => {
      const client = await session();

      const error = await rejectionOf(client.readResource({ uri: 'unknown://missing' }));

      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data).toEqual({ uri: 'unknown://missing' });
    });
  });

  describe("the client's JSON-RPC id rides each record as jsonRpcId (#584)", () => {
    const raw: Array<Awaited<ReturnType<typeof rawSession>>> = [];

    afterEach(async () => {
      while (raw.length)
        await raw
          .pop()
          ?.close()
          .catch(() => undefined);
      vi.restoreAllMocks();
    });

    const rawRequest = async () => {
      const opened = await rawSession();
      raw.push(opened);
      return opened.request;
    };

    type LoggedContext = { extra?: Record<string, unknown>; requestId?: string };

    /** The context of the last record `log` received whose message matches `pattern`. */
    const recordOf = (log: 'error' | 'info', pattern: RegExp) =>
      vi
        .mocked(logger[log])
        .mock.calls.findLast(([message]) => pattern.test(String(message)))?.[1] as
        | LoggedContext
        | undefined;

    const boom = { name: 'wire_search', arguments: { query: 'boom' } };

    it('runs a tools/call sent with a string id under a generated requestId', async () => {
      vi.spyOn(logger, 'error');
      const request = await rawRequest();

      const response = await request('client-string-id-19', 'tools/call', boom);

      expect(response.id).toBe('client-string-id-19');
      const requestId = requestIdOf(response.result);
      expect(requestId).toMatch(REQUEST_ID_PATTERN);
      const content = response.result?.content as Array<{ text: string }> | undefined;
      const text = content?.[0]?.text ?? '';
      expect(text.endsWith(`(reason index_missing · request ${requestId})`)).toBe(true);
      const record = recordOf('error', /^Error in tool:wire_search:/);
      expect(record?.requestId).toBe(requestId);
      expect(record?.extra).toMatchObject({ jsonRpcId: 'client-string-id-19' });
    });

    it('never takes a string id shaped like a generated token as the requestId', async () => {
      const request = await rawRequest();

      const response = await request('AAAAA-BBBBB', 'tools/call', boom);

      expect(requestIdOf(response.result)).toMatch(REQUEST_ID_PATTERN);
      expect(requestIdOf(response.result)).not.toBe('AAAAA-BBBBB');
    });

    it('gives two sessions that each send id "1" two requestIds', async () => {
      const first = await (await rawRequest())('1', 'tools/call', boom);
      const second = await (await rawRequest())('1', 'tools/call', boom);

      expect(requestIdOf(first.result)).toMatch(REQUEST_ID_PATTERN);
      expect(requestIdOf(second.result)).toMatch(REQUEST_ID_PATTERN);
      expect(requestIdOf(first.result)).not.toBe(requestIdOf(second.result));
    });

    it('logs a numeric id as a number', async () => {
      vi.spyOn(logger, 'error');
      const request = await rawRequest();

      const response = await request(10, 'tools/call', boom);

      const record = recordOf('error', /^Error in tool:wire_search:/);
      expect(record?.requestId).toBe(requestIdOf(response.result));
      expect(record?.extra?.jsonRpcId).toBe(10);
    });

    it('answers a failed resources/read and prompts/get with the requestId their records carry', async () => {
      vi.spyOn(logger, 'info');
      vi.spyOn(logger, 'error');
      const request = await rawRequest();

      const read = await request('res-str-1', 'resources/read', { uri: 'wire://service/direct' });
      const got = await request('prompt-str-1', 'prompts/get', {
        name: 'wire_failing',
        arguments: { mode: 'plain' },
      });

      const readRecord = recordOf('info', /^Resource read finished\.$/);
      const promptRecord = recordOf('error', /^Error in prompt:wire_failing:/);
      expect(read.error?.data?.requestId).toMatch(REQUEST_ID_PATTERN);
      expect(read.error?.data?.requestId).toBe(readRecord?.requestId);
      expect(readRecord?.extra).toMatchObject({ jsonRpcId: 'res-str-1' });
      expect(got.error?.data?.requestId).toMatch(REQUEST_ID_PATTERN);
      expect(got.error?.data?.requestId).toBe(promptRecord?.requestId);
      expect(promptRecord?.extra).toMatchObject({ jsonRpcId: 'prompt-str-1' });
    });

    it('logs a 999,000-character id cut to 1,024 with its length, and keeps it off the result', async () => {
      vi.spyOn(logger, 'error');
      const request = await rawRequest();
      const id = 'q'.repeat(999_000);

      const response = await request(id, 'tools/call', boom);

      expect(response.id).toBe(id);
      expect(requestIdOf(response.result)).toMatch(REQUEST_ID_PATTERN);
      expect(JSON.stringify(response.result)).not.toContain('q'.repeat(64));
      expect(recordOf('error', /^Error in tool:wire_search:/)?.extra).toMatchObject({
        jsonRpcId: id.slice(0, 1_024),
        jsonRpcIdLength: 999_000,
      });
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

/** A fixture whose `echo_logged` handler writes one `ctx.log.info` record. */
const LOG_FIXTURE = resolve(process.cwd(), 'tests/fixtures/stdio-log-server.js');

/** A transport a 2025-era client reaches the fixture over. */
type Leg = 'stateful HTTP' | 'stateless HTTP' | 'stdio';
type HttpMode = 'stateful' | 'stateless';

/** A `notifications/message` as the client received it. */
type WireMessage = { data: unknown; level: string };

/** One JSON-RPC message from a 2026-07-28 response stream. */
type StreamMessage = {
  id?: number;
  method?: string;
  params?: WireMessage;
  result?: { structuredContent?: unknown };
};

/** What `echo_logged` mirrors when its record passes every level. */
const ECHO_MESSAGE: WireMessage = {
  level: 'info',
  data: { message: 'echo_logged handler ran', echoed: 'ping' },
};

/**
 * Runs the log fixture at one `MCP_LOG_LEVEL` for the enclosing `describe`: an
 * HTTP server per session mode for the whole block, and a stdio process per
 * client. Each call reads its notifications once its result is in — the same
 * stream carries the result after any record the handler mirrored.
 */
function fixtureAt(floor: 'info' | 'warning') {
  const servers = new Map<HttpMode, ServerHandle>();
  const clients: Client[] = [];

  beforeAll(async () => {
    // One at a time: concurrent starts can be handed the same free port.
    for (const mode of ['stateful', 'stateless'] as const) {
      servers.set(
        mode,
        await startServerFromEntrypoint(LOG_FIXTURE, 'http', {
          MCP_LOG_LEVEL: floor,
          MCP_SESSION_MODE: mode,
        }),
      );
    }
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  });

  afterAll(async () => {
    await Promise.all([...servers.values()].map((server) => server.kill()));
  });

  const portOf = (mode: HttpMode): number => {
    const port = servers.get(mode)?.port;
    if (port === undefined) throw new Error(`The ${mode} fixture server is not running.`);
    return port;
  };

  /** Connects a 2025-era client over `leg` and returns a call that yields what it mirrored. */
  async function connect(leg: Leg) {
    const transport =
      leg === 'stdio'
        ? new StdioClientTransport({
            command: process.execPath,
            args: [LOG_FIXTURE],
            env: { ...process.env, MCP_LOG_LEVEL: floor, MCP_TRANSPORT_TYPE: 'stdio' },
            stderr: 'ignore',
          })
        : new StreamableHTTPClientTransport(
            new URL(
              `http://127.0.0.1:${portOf(leg === 'stateful HTTP' ? 'stateful' : 'stateless')}/mcp`,
            ),
          );
    const client = new Client({ name: 'wire-log-floor', version: '0.0.0' });
    const messages: WireMessage[] = [];
    client.setNotificationHandler('notifications/message', (notification) => {
      messages.push(notification.params as WireMessage);
    });
    clients.push(client);
    await client.connect(transport);

    const echo = async (): Promise<WireMessage[]> => {
      const seen = messages.length;
      const result = await client.callTool({ name: 'echo_logged', arguments: { message: 'ping' } });
      // The handler ran, so its `ctx.log.info` call was made.
      expect(result.structuredContent).toEqual({ message: 'ping' });
      return messages.slice(seen);
    };
    return { client, echo };
  }

  /**
   * POSTs one 2026-07-28 `echo_logged` call, with `logLevel` in its envelope
   * when given, and returns the `notifications/message` its response stream
   * carried. The stream closes on the result, so it is read whole.
   */
  async function modernEcho(mode: HttpMode, logLevel?: 'debug' | 'info'): Promise<WireMessage[]> {
    const response = await exchange(portOf(mode), {
      method: 'POST',
      path: '/mcp',
      headers: {
        ...MCP_HEADERS,
        'MCP-Protocol-Version': MODERN_PROTOCOL_REVISION,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'echo_logged',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'echo_logged',
          arguments: { message: 'ping' },
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_REVISION,
            'io.modelcontextprotocol/clientInfo': { name: 'wire-log-floor', version: '0.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
            ...(logLevel && { 'io.modelcontextprotocol/logLevel': logLevel }),
          },
        },
      }),
    });
    expect(response.status, response.body).toBe(200);
    const stream: StreamMessage[] = String(response.headers['content-type']).includes(
      'text/event-stream',
    )
      ? parseSSEEvents(response.body).map((event) => JSON.parse(event.data) as StreamMessage)
      : [JSON.parse(response.body) as StreamMessage];
    expect(stream.find((message) => message.id === 1)?.result?.structuredContent).toEqual({
      message: 'ping',
    });
    return stream.flatMap((message) =>
      message.method === 'notifications/message' && message.params ? [message.params] : [],
    );
  }

  return { connect, modernEcho };
}

describe('MCP_LOG_LEVEL floors the ctx.log wire mirror (#621)', () => {
  const legs: Leg[] = ['stdio', 'stateful HTTP', 'stateless HTTP'];
  const modes: HttpMode[] = ['stateful', 'stateless'];

  describe('under a warning floor', () => {
    const fixture = fixtureAt('warning');

    it.each(legs)(
      'mirrors no info record on %s, before or after logging/setLevel debug',
      async (leg) => {
        const { client, echo } = await fixture.connect(leg);

        expect(await echo()).toEqual([]);
        // A client level below the floor never widens it.
        await client.setLoggingLevel('debug');
        expect(await echo()).toEqual([]);
      },
    );

    it.each(modes)(
      'mirrors no info record to a %s-mode 2026-07-28 request asking for debug',
      async (mode) => {
        expect(await fixture.modernEcho(mode, 'debug')).toEqual([]);
      },
    );
  });

  describe('under an info floor', () => {
    const fixture = fixtureAt('info');

    it.each(legs)('mirrors the info record on %s with no client level', async (leg) => {
      const { echo } = await fixture.connect(leg);

      expect(await echo()).toEqual([ECHO_MESSAGE]);
    });

    it.each(['stdio', 'stateful HTTP'] as const)(
      'still narrows to logging/setLevel warning on %s',
      async (leg) => {
        const { client, echo } = await fixture.connect(leg);

        await client.setLoggingLevel('warning');
        expect(await echo()).toEqual([]);
      },
    );

    it.each(modes)('mirrors it to a %s-mode 2026-07-28 request asking for info', async (mode) => {
      expect(await fixture.modernEcho(mode, 'info')).toEqual([ECHO_MESSAGE]);
    });

    it.each(modes)(
      'mirrors nothing to a %s-mode 2026-07-28 request that names no level',
      async (mode) => {
        expect(await fixture.modernEcho(mode)).toEqual([]);
      },
    );
  });
});

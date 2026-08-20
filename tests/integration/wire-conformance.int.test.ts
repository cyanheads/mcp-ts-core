/**
 * @fileoverview Wire-level regressions for the decisions taken in the SDK v2
 * migration's wire-tightening review (#305 Phase 1). Each case pins a byte the
 * framework now puts on the wire, driven through a real MCP client so the
 * assertions are on what a caller actually receives.
 * @module tests/integration/wire-conformance.int.test
 */
import { Client, ProtocolErrorCode } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
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
import { MODERN_PROTOCOL_REVISION } from '@/mcp-server/types.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';

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
    if (input.query === 'boom') throw ctx.fail('index_missing');
    ctx.log.info('searching', { query: input.query });
    return { hits: [input.query], total: 1 };
  },
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
  await new ToolRegistry([searchTool], services).registerAll(server, subscriptions);
  await new ResourceRegistry([docResource], services).registerAll(server, subscriptions);
  await new PromptRegistry([greetPrompt], logger).registerAll(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'wire-conformance-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
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

    it('narrows data.reason to the definition’s declared reasons', async () => {
      const client = await session();
      const { tools } = await client.listTools();
      const reason = (
        (tools[0] as { outputSchema?: Record<string, unknown> }).outputSchema as {
          properties: {
            error: { properties: { data: { properties: { reason: { enum?: string[] } } } } };
          };
        }
      ).properties.error.properties.data.properties.reason;

      expect(reason.enum).toEqual(['index_missing']);
    });

    it('returns an error envelope that satisfies the advertised schema', async () => {
      const client = await session();
      // A strict client validates `structuredContent` against `outputSchema`;
      // this call is exactly the one that used to fail with `-32602`.
      const result = await client.callTool({
        name: 'wire_search',
        arguments: { query: 'boom' },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'index_missing' } },
      });
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
    it('advertises resources.subscribe and answers subscribe/unsubscribe (#354)', async () => {
      const client = await session();

      expect(client.getServerCapabilities()?.resources).toMatchObject({ subscribe: true });
      await expect(client.subscribeResource({ uri: 'wire://doc/1' })).resolves.toBeDefined();
      await expect(client.unsubscribeResource({ uri: 'wire://doc/1' })).resolves.toBeDefined();
    });

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

    it('advertises no experimental tasks capability', async () => {
      const client = await session();
      expect(client.getServerCapabilities()?.tasks).toBeUndefined();
    });
  });

  describe('unknown tool dispatch', () => {
    it('rejects with a protocol error rather than an isError result', async () => {
      const client = await session();

      await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
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

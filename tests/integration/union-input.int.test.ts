/**
 * @fileoverview Wire-level coverage for discriminated-union tool inputs (#142).
 * A multi-mode tool declares mutually exclusive argument sets with a literal
 * discriminator; the framework has to advertise the branches intact and enforce
 * them per variant, with identical bytes on both protocol eras — the legacy
 * projection inspects `outputSchema` alone, so nothing rewrites the input root.
 * @module tests/integration/union-input.int.test
 */
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type McpRequestContext, McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { config } from '@/config/index.js';
import { buildServerManifest } from '@/core/serverManifest.js';
import { ToolRegistry } from '@/mcp-server/tools/tool-registration.js';
import { type AnyToolDefinition, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { createHttpApp } from '@/mcp-server/transports/http/httpTransport.js';
import { MODERN_PROTOCOL_REVISION } from '@/mcp-server/types.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { defaultServerManifest } from '../helpers/fixtures.js';

const lookup = tool('multi_lookup', {
  description: 'Looks a record up by exactly one of the supported keys.',
  input: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('byId').describe('Look up by exact ID.'),
      id: z.string().min(1).describe('Record ID.'),
    }),
    z.object({
      mode: z.literal('byName').describe('Search by name.'),
      name: z.string().min(1).describe('Name fragment.'),
      fuzzy: z.boolean().default(false).describe('Whether to match loosely.'),
    }),
  ]),
  output: z.object({
    resolved: z.string().describe('The record the arguments resolved to.'),
    via: z.string().describe('Which mode resolved it.'),
  }),
  handler: (input) =>
    input.mode === 'byId'
      ? { resolved: input.id, via: 'byId' }
      : { resolved: `${input.name}${input.fuzzy ? '*' : ''}`, via: 'byName' },
});

type AdvertisedInput = {
  oneOf?: Array<{
    additionalProperties?: boolean;
    properties?: Record<string, { const?: unknown; description?: string }>;
    required?: string[];
  }>;
  type?: string;
};

async function connectLegacy() {
  const server = new McpServer(
    { name: 'union-input', version: '0.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  const services = { logger, storage: new StorageService(new InMemoryProvider()) };
  await new ToolRegistry([lookup as AnyToolDefinition], services).registerAll(server, undefined);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'union-input-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe('discriminated-union tool input (#142)', () => {
  const open: Array<{ client: Client; server: McpServer }> = [];

  afterEach(async () => {
    while (open.length) {
      const pair = open.pop();
      await pair?.client.close().catch(() => undefined);
      await pair?.server.close().catch(() => undefined);
    }
  });

  const session = async () => {
    const pair = await connectLegacy();
    open.push(pair);
    return pair.client;
  };

  const advertised = async (): Promise<AdvertisedInput> => {
    const client = await session();
    const { tools } = await client.listTools();
    return (tools[0] as { inputSchema: AdvertisedInput }).inputSchema;
  };

  describe('advertised schema', () => {
    it('keeps an object root with the branches intact', async () => {
      const inputSchema = await advertised();

      // Both eras' `Tool` schema require `inputSchema.type === "object"`; the
      // branches ride alongside as `oneOf` rather than replacing the root.
      expect(inputSchema.type).toBe('object');
      expect(inputSchema.oneOf).toHaveLength(2);
    });

    it('gives each branch its own required list', async () => {
      const inputSchema = await advertised();

      // v1 erased the branches to `{"type":"object","properties":{}}` — the
      // model saw a parameterless tool and every call failed validation.
      expect(inputSchema.oneOf?.[0]?.required).toEqual(['mode', 'id']);
      expect(inputSchema.oneOf?.[1]?.required).toEqual(['mode', 'name']);
    });

    it('tags each discriminator with its literal value and description', async () => {
      const inputSchema = await advertised();
      const discriminators = inputSchema.oneOf?.map((branch) => branch.properties?.mode);

      expect(discriminators?.[0]).toMatchObject({
        const: 'byId',
        description: 'Look up by exact ID.',
      });
      expect(discriminators?.[1]).toMatchObject({
        const: 'byName',
        description: 'Search by name.',
      });
    });

    it('carries strict input into every branch (#232)', async () => {
      const inputSchema = await advertised();

      for (const branch of inputSchema.oneOf ?? []) {
        expect(branch.additionalProperties).toBe(false);
      }
    });
  });

  describe('calls', () => {
    it('accepts each variant', async () => {
      const client = await session();

      const byId = await client.callTool({
        name: 'multi_lookup',
        arguments: { mode: 'byId', id: 'rec-1' },
      });
      const byName = await client.callTool({
        name: 'multi_lookup',
        arguments: { mode: 'byName', name: 'ada', fuzzy: true },
      });

      expect(byId.isError).toBeUndefined();
      expect(byId.structuredContent).toMatchObject({ resolved: 'rec-1', via: 'byId' });
      expect(byName.isError).toBeUndefined();
      expect(byName.structuredContent).toMatchObject({ resolved: 'ada*', via: 'byName' });
    });

    it("rejects a variant's field supplied under the other discriminator", async () => {
      const client = await session();
      const result = await client.callTool({
        name: 'multi_lookup',
        arguments: { mode: 'byId', name: 'ada' },
      });

      expect(result.isError).toBe(true);
    });

    it('rejects an unrecognized key by name inside a branch', async () => {
      const client = await session();
      const result = await client.callTool({
        name: 'multi_lookup',
        arguments: { mode: 'byId', id: 'rec-1', idd: 'typo' },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
      expect(text).toContain('Unrecognized key: "idd"');
    });

    it('rejects an unknown discriminator value', async () => {
      const client = await session();
      const result = await client.callTool({
        name: 'multi_lookup',
        arguments: { mode: 'byEmail', email: 'a@b.c' },
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('era parity', () => {
    it('advertises identical bytes on a 2026-07-28 connection', async () => {
      const legacy = await advertised();

      const services = { logger, storage: new StorageService(new InMemoryProvider()) };
      const factory = async (requestContext: McpRequestContext) => {
        const server = new McpServer(
          { name: `union-input-${requestContext.era}`, version: '0.0.0' },
          { capabilities: { tools: { listChanged: true } } },
        );
        await new ToolRegistry([lookup as AnyToolDefinition], services).registerAll(
          server,
          undefined,
        );
        return server;
      };

      const { app, close } = await createHttpApp(
        factory,
        requestContextService.createRequestContext({ operation: 'union-input-era-parity' }),
        defaultServerManifest,
      );

      try {
        const res = await app.request(
          new Request('http://localhost/mcp', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              'MCP-Protocol-Version': MODERN_PROTOCOL_REVISION,
              'Mcp-Method': 'tools/list',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/list',
              params: {
                _meta: {
                  'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_REVISION,
                  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
                  'io.modelcontextprotocol/clientCapabilities': {},
                },
              },
            }),
          }),
        );

        expect(res.status).toBe(200);
        const modern = extractToolsListResult(await res.text());
        expect(modern.tools?.[0]?.inputSchema).toEqual(legacy);
      } finally {
        await close();
      }
    });
  });

  describe('server manifest', () => {
    it('reports only the fields required on every branch', () => {
      const manifest = buildServerManifest({
        config,
        tools: [lookup as AnyToolDefinition],
        resources: [],
        prompts: [],
      });
      const entry = manifest.definitions.tools[0];

      // The union of every branch's required fields would claim a call needs
      // keys belonging to branches it is not making. Per-variant lists stay
      // reachable on the advertised schema.
      expect(entry?.requiredFields).toEqual(['mode']);
      expect((entry?.inputSchema as AdvertisedInput | undefined)?.oneOf).toHaveLength(2);
    });
  });
});

/** Pulls the JSON-RPC result out of a plain-JSON or SSE-framed response body. */
function extractToolsListResult(body: string): {
  tools?: Array<{ inputSchema?: unknown }>;
} {
  const payload = body.startsWith('{')
    ? body
    : (body
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('') ?? '');
  return (JSON.parse(payload) as { result: { tools?: Array<{ inputSchema?: unknown }> } }).result;
}

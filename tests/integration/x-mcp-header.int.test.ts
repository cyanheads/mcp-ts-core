/**
 * @fileoverview Wire-level coverage for `x-mcp-header` input designation (#360).
 *
 * Two things have to hold end to end. The annotation must survive Zod-to-JSON-
 * Schema emission and reach `tools/list` on the property, with nothing else
 * about the field changed. And the framework's definition-time verdict must be
 * the SDK's verdict — the SDK only `console.warn`s about an invalid declaration
 * and registers the tool anyway, so a disagreement would either reject a legal
 * tool at startup or let an illegal one ship to be silently dropped by
 * conforming Streamable HTTP clients. These tests drive the SDK's own scan and
 * compare it against the framework's, case by case.
 *
 * @module tests/integration/x-mcp-header.int.test
 */
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type McpRequestContext, McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { toJSONSchema } from 'zod/v4/core';

import { ToolRegistry } from '@/mcp-server/tools/tool-registration.js';
import { headerParam, scanHeaderDesignations } from '@/mcp-server/tools/utils/headerParam.js';
import { type AnyToolDefinition, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { createHttpApp } from '@/mcp-server/transports/http/httpTransport.js';
import { MODERN_PROTOCOL_REVISION } from '@/mcp-server/types.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { defaultServerManifest } from '../helpers/fixtures.js';

const PLAIN_INPUT = z.object({
  limit: z.number().optional().describe('Maximum rows to return.'),
  query: z.string().describe('Search query.'),
});

const plain = tool('plain_lookup', {
  description: 'Looks a record up with no header-designated arguments.',
  input: PLAIN_INPUT,
  output: z.object({ resolved: z.string().describe('The record found.') }),
  handler: (input) => ({ resolved: input.query }),
});

const designated = tool('routed_lookup', {
  description: 'Looks a record up, mirroring its routing arguments into request headers.',
  input: z.object({
    query: z.string().describe('Search query.'),
    routing: z
      .object({
        region: headerParam(z.string(), 'Region').describe('Deployment region.'),
        shard: headerParam(z.int(), 'Shard-Id').describe('Shard the record lives on.'),
      })
      .describe('Where to route the lookup.'),
  }),
  output: z.object({ resolved: z.string().describe('The record found.') }),
  handler: (input) => ({ resolved: `${input.routing.region}/${input.query}` }),
});

type AdvertisedInput = {
  properties?: Record<string, AdvertisedInput>;
  required?: string[];
  type?: string;
  'x-mcp-header'?: string;
};

const services = () => ({ logger, storage: new StorageService(new InMemoryProvider()) });

async function connect(tools: AnyToolDefinition[]) {
  const server = new McpServer(
    { name: 'x-mcp-header', version: '0.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  await new ToolRegistry(tools, services()).registerAll(server, undefined);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'x-mcp-header-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

/**
 * Registers a definition and reports whether the SDK's own `x-mcp-header` scan
 * rejected it. The SDK surfaces that verdict only as a `console.warn`, so the
 * warning is the observable.
 */
async function sdkRejects(definition: AnyToolDefinition): Promise<boolean> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const server = new McpServer(
      { name: 'sdk-scan', version: '0.0.0' },
      { capabilities: { tools: { listChanged: true } } },
    );
    await new ToolRegistry([definition], services()).registerAll(server, undefined);
    await server.close();
    return warn.mock.calls.some((args) => String(args[0]).includes('x-mcp-header'));
  } finally {
    warn.mockRestore();
  }
}

/** A definition assembled without `tool()`, so an illegal schema survives to the SDK. */
function unbuilt(name: string, input: z.ZodType): AnyToolDefinition {
  return {
    name,
    description: 'A definition assembled without the builder.',
    input,
    output: z.object({ ok: z.boolean().describe('Whether it worked.') }),
    handler: () => ({ ok: true }),
  } as unknown as AnyToolDefinition;
}

describe('x-mcp-header input designation (#360)', () => {
  const open: Array<{ client: Client; server: McpServer }> = [];

  afterEach(async () => {
    while (open.length) {
      const pair = open.pop();
      await pair?.client.close().catch(() => undefined);
      await pair?.server.close().catch(() => undefined);
    }
  });

  const advertised = async (definition: AnyToolDefinition): Promise<AdvertisedInput> => {
    const pair = await connect([definition]);
    open.push(pair);
    const { tools } = await pair.client.listTools();
    return (tools[0] as { inputSchema: AdvertisedInput }).inputSchema;
  };

  describe('advertised schema', () => {
    it('carries the annotation on the designated property', async () => {
      const routing = (await advertised(designated as AnyToolDefinition)).properties?.routing;

      expect(routing?.properties?.region).toMatchObject({
        description: 'Deployment region.',
        type: 'string',
        'x-mcp-header': 'Region',
      });
      expect(routing?.properties?.shard).toMatchObject({
        description: 'Shard the record lives on.',
        type: 'integer',
        'x-mcp-header': 'Shard-Id',
      });
    });

    it('leaves description, type, and requiredness of the designated field unchanged', async () => {
      const undesignated = z.object({
        query: z.string().describe('Search query.'),
        routing: z
          .object({
            region: z.string().describe('Deployment region.'),
            shard: z.int().describe('Shard the record lives on.'),
          })
          .describe('Where to route the lookup.'),
      });
      const routing = (await advertised(designated as AnyToolDefinition)).properties?.routing;
      const reference = toJSONSchema(undesignated, {
        io: 'input',
        target: 'draft-2020-12',
      }) as unknown as { properties: { routing: AdvertisedInput } };

      // Strip the annotation and the two schemas are the same object.
      const stripped = JSON.parse(
        JSON.stringify(routing, (key, value) => (key === 'x-mcp-header' ? undefined : value)),
      );
      expect(stripped).toEqual(reference.properties.routing);
    });

    it("leaves an undesignated tool's advertised inputSchema byte-identical", async () => {
      const inputSchema = await advertised(plain as AnyToolDefinition);

      // Exactly the SDK's own conversion of the declared schema plus the
      // strict-input marker the framework has always added — no new keys.
      expect(inputSchema).toEqual({
        ...(toJSONSchema(PLAIN_INPUT, { io: 'input', target: 'draft-2020-12' }) as object),
        additionalProperties: false,
        type: 'object',
      });
      expect(JSON.stringify(inputSchema)).not.toContain('x-mcp-header');
    });

    it('survives onto a 2026-07-28 connection byte for byte', async () => {
      const legacy = await advertised(designated as AnyToolDefinition);

      const shared = services();
      const factory = async (requestContext: McpRequestContext) => {
        const server = new McpServer(
          { name: `x-mcp-header-${requestContext.era}`, version: '0.0.0' },
          { capabilities: { tools: { listChanged: true } } },
        );
        await new ToolRegistry([designated as AnyToolDefinition], shared).registerAll(
          server,
          undefined,
        );
        return server;
      };

      const { app, close } = await createHttpApp(
        factory,
        requestContextService.createRequestContext({ operation: 'x-mcp-header-era-parity' }),
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
        expect(extractToolsListResult(await res.text()).tools?.[0]?.inputSchema).toEqual(legacy);
      } finally {
        await close();
      }
    });
  });

  describe('agreement with the SDK scan', () => {
    it('registers a designated tool without an SDK warning', async () => {
      expect(await sdkRejects(designated as AnyToolDefinition)).toBe(false);
    });

    it.each([
      [
        'nested object property',
        z.object({
          routing: z
            .object({ region: headerParam(z.string(), 'Region').describe('R.') })
            .describe('Routing.'),
        }),
        false,
      ],
      [
        'number-typed property the SDK admits',
        z.object({ ratio: headerParam(z.number(), 'Ratio').describe('Ratio.') }),
        false,
      ],
      [
        'array element',
        z.object({
          rows: z
            .array(z.object({ region: headerParam(z.string(), 'Region').describe('R.') }))
            .describe('Rows.'),
        }),
        true,
      ],
      [
        'record value',
        z.object({ map: z.record(z.string(), headerParam(z.string(), 'Region')).describe('M.') }),
        true,
      ],
      [
        'discriminated-union input root',
        z.discriminatedUnion('mode', [
          z.object({
            mode: z.literal('byId').describe('By ID.'),
            region: headerParam(z.string(), 'Region').describe('R.'),
          }),
          z.object({
            mode: z.literal('byName').describe('By name.'),
            name: z.string().describe('N.'),
          }),
        ]),
        true,
      ],
      [
        'non-token header name',
        z.object({ region: headerParam(z.string(), 'Bad Name').describe('R.') }),
        true,
      ],
      ['empty header name', z.object({ region: headerParam(z.string(), '').describe('R.') }), true],
      [
        'object-typed property',
        z.object({
          region: headerParam(z.object({ code: z.string().describe('Code.') }), 'Region').describe(
            'R.',
          ),
        }),
        true,
      ],
      [
        'case-insensitive duplicate',
        z.object({
          a: headerParam(z.string(), 'Region').describe('A.'),
          b: headerParam(z.string(), 'REGION').describe('B.'),
        }),
        true,
      ],
    ])('agrees with the SDK on a %s', async (label, input, expectedInvalid) => {
      const scan = scanHeaderDesignations(input);
      expect(scan, `${label}: schema should be convertible`).toBeDefined();
      expect(scan?.valid === false, `${label}: framework verdict`).toBe(expectedInvalid);
      expect(
        await sdkRejects(unbuilt(`agreement_${label.replace(/\W+/g, '_')}`, input)),
        `${label}: SDK verdict`,
      ).toBe(expectedInvalid);
    });
  });

  describe('calls', () => {
    it('still reads the designated value from the body', async () => {
      const pair = await connect([designated as AnyToolDefinition]);
      open.push(pair);

      const result = await pair.client.callTool({
        name: 'routed_lookup',
        arguments: { query: 'rec-1', routing: { region: 'us-west-2', shard: 3 } },
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ resolved: 'us-west-2/rec-1' });
    });

    it('still validates the designated field', async () => {
      const pair = await connect([designated as AnyToolDefinition]);
      open.push(pair);

      const result = await pair.client.callTool({
        name: 'routed_lookup',
        arguments: { query: 'rec-1', routing: { region: 'us-west-2', shard: 'three' } },
      });

      expect(result.isError).toBe(true);
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

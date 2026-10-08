/**
 * @fileoverview Wire-level coverage for the tool-argument pre-validation step
 * (#453, #452, #234, #707, #602, #616, #599, #639). The step rescues a call the strict `input` schema would
 * otherwise reject, and the whole point is that it costs nothing on the wire:
 * `tools/list` and the server manifest advertise the same bytes they did
 * before, `inputAliases` included, and a call that is still rejected is
 * rejected identically.
 * @module tests/integration/input-prevalidation.int.test
 */
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { config } from '@/config/index.js';
import { buildServerManifest } from '@/core/serverManifest.js';
import { ToolRegistry } from '@/mcp-server/tools/tool-registration.js';
import { type AnyToolDefinition, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { logger } from '@/utils/internal/logger.js';

/** The shape both definitions below declare, down to the byte. */
const sharedInput = () =>
  z.object({
    drug: z.string().describe('Drug name.'),
    maxResults: z.number().int().optional().describe('Maximum results.'),
    statusFilter: z.array(z.string()).optional().describe('Statuses to include.'),
  });

const sharedOutput = z.object({
  drug: z.string().describe('The drug the call resolved to.'),
  maxResults: z.number().describe('The effective maximum.'),
  statuses: z.array(z.string()).describe('The statuses that arrived.'),
});

type Args = { drug: string; maxResults?: number; statusFilter?: string[] };

const handler = (input: Args) => ({
  drug: input.drug,
  maxResults: input.maxResults ?? 0,
  statuses: input.statusFilter ?? [],
});

/** Declares aliases. */
const aliased = tool('prevalidation_aliased', {
  description: 'Looks a drug up.',
  input: sharedInput(),
  inputAliases: { drug_name: 'drug', substance: 'drug' },
  output: sharedOutput,
  handler,
  format: (result) => [
    {
      type: 'text',
      text: `**${(result as { drug: string }).drug}** — ${(result as { maxResults: number }).maxResults} max, statuses: ${(result as { statuses: string[] }).statuses.join(', ')}`,
    },
  ],
});

/** The same tool with no `inputAliases` — the reference bytes. */
const plain = tool('prevalidation_plain', {
  description: 'Looks a drug up.',
  input: sharedInput(),
  output: sharedOutput,
  handler,
});

/** Takes one item or several, a lone object wrapped as a list by a preprocess (#599). */
const wrapped = tool('prevalidation_wrapped', {
  description: 'Lists items.',
  input: z.object({
    items: z
      .preprocess(
        (value) =>
          typeof value === 'object' && value !== null && !Array.isArray(value) ? [value] : value,
        z.array(
          z.object({
            name: z.string().describe('Name.'),
            year: z.string().optional().describe('Year.'),
          }),
        ),
      )
      .describe('One item or several.'),
  }),
  output: z.object({ years: z.array(z.string()).describe('The years that arrived.') }),
  handler: (input) => ({ years: input.items.map((item) => item.year ?? '') }),
  format: (result) => [{ type: 'text', text: `years: ${result.years.join(', ')}` }],
});

async function connect(defs: AnyToolDefinition[]) {
  const server = new McpServer(
    { name: 'input-prevalidation', version: '0.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  const services = { logger, storage: new StorageService(new InMemoryProvider()) };
  await new ToolRegistry(defs, services).registerAll(server, undefined);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'input-prevalidation-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe('tool argument pre-validation (#453, #452, #234, #707, #602, #616, #599)', () => {
  const open: Array<{ client: Client; server: McpServer }> = [];

  afterEach(async () => {
    while (open.length) {
      const pair = open.pop();
      await pair?.client.close().catch(() => undefined);
      await pair?.server.close().catch(() => undefined);
    }
  });

  const session = async (defs: AnyToolDefinition[] = [aliased as AnyToolDefinition]) => {
    const pair = await connect(defs);
    open.push(pair);
    return pair.client;
  };

  describe('advertised schema', () => {
    it('advertises identical inputSchema bytes with and without inputAliases', async () => {
      const client = await session([aliased as AnyToolDefinition, plain as AnyToolDefinition]);
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((entry) => [entry.name, entry]));

      expect(byName.get('prevalidation_aliased')?.inputSchema).toEqual(
        byName.get('prevalidation_plain')?.inputSchema,
      );
    });

    it('never advertises an alias as a property, and keeps additionalProperties false', async () => {
      const client = await session();
      const { tools } = await client.listTools();
      const inputSchema = tools[0]?.inputSchema as {
        additionalProperties?: boolean;
        properties?: Record<string, unknown>;
        required?: string[];
      };

      expect(Object.keys(inputSchema.properties ?? {})).toEqual([
        'drug',
        'maxResults',
        'statusFilter',
      ]);
      expect(inputSchema.additionalProperties).toBe(false);
      expect(inputSchema.required).toEqual(['drug']);
    });

    it('keeps the tool entry free of any alias key', async () => {
      const client = await session();
      const { tools } = await client.listTools();

      expect(JSON.stringify(tools[0])).not.toContain('drug_name');
      expect(JSON.stringify(tools[0])).not.toContain('inputAliases');
    });

    it('reports identical manifest bytes with and without inputAliases', () => {
      const manifest = buildServerManifest({
        config,
        tools: [aliased as AnyToolDefinition, plain as AnyToolDefinition],
        resources: [],
        prompts: [],
      });
      const [withAliases, without] = manifest.definitions.tools;

      expect(withAliases?.inputSchema).toEqual(without?.inputSchema);
      expect(withAliases?.requiredFields).toEqual(without?.requiredFields);
      expect(JSON.stringify(manifest)).not.toContain('drug_name');
    });
  });

  describe('calls', () => {
    it('rescues one call carrying a client key, an alias, and a stringified array', async () => {
      const client = await session();
      const result = await client.callTool({
        name: 'prevalidation_aliased',
        arguments: {
          drug_name: 'aspirin',
          max_results: 5,
          statusFilter: '["RECRUITING","ACTIVE"]',
          _meta: { origin: 'client' },
          tool_call_description: 'look up aspirin',
        } as never,
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({
        drug: 'aspirin',
        maxResults: 5,
        statuses: ['RECRUITING', 'ACTIVE'],
      });
      expect(result.content).toEqual([
        { type: 'text', text: '**aspirin** — 5 max, statuses: RECRUITING, ACTIVE' },
      ]);
    });

    it('rescues a quoted number, a lone string for a list, and nulls for optional fields (#707, #602, #616)', async () => {
      const client = await session();
      const quoted = await client.callTool({
        name: 'prevalidation_aliased',
        arguments: { drug: 'aspirin', maxResults: '5', statusFilter: 'RECRUITING' } as never,
      });
      const nulls = await client.callTool({
        name: 'prevalidation_aliased',
        arguments: { drug: 'aspirin', maxResults: null, statusFilter: null } as never,
      });

      expect(quoted.isError).toBeUndefined();
      expect(quoted.structuredContent).toEqual({
        drug: 'aspirin',
        maxResults: 5,
        statuses: ['RECRUITING'],
      });
      expect(quoted.content).toEqual([
        { type: 'text', text: '**aspirin** — 5 max, statuses: RECRUITING' },
      ]);
      expect(nulls.isError).toBeUndefined();
      expect(nulls.structuredContent).toEqual({ drug: 'aspirin', maxResults: 0, statuses: [] });
      expect(nulls.content).toEqual([{ type: 'text', text: '**aspirin** — 0 max, statuses: ' }]);
    });

    it('rescues an integer inside the list a preprocess made of a lone object (#599)', async () => {
      const client = await session([wrapped as AnyToolDefinition]);
      const result = await client.callTool({
        name: 'prevalidation_wrapped',
        arguments: { items: { name: 'abc', year: 2020 } } as never,
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ years: ['2020'] });
      expect(result.content).toEqual([{ type: 'text', text: 'years: 2020' }]);
    });

    it('accepts an unchanged canonical call exactly as before', async () => {
      const client = await session();
      const result = await client.callTool({
        name: 'prevalidation_aliased',
        arguments: { drug: 'aspirin', maxResults: 2, statusFilter: ['A'] },
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({
        drug: 'aspirin',
        maxResults: 2,
        statuses: ['A'],
      });
    });

    it('rejects a key matching no alias with the same envelope either tool produces', async () => {
      const client = await session([aliased as AnyToolDefinition, plain as AnyToolDefinition]);
      const [withAliases, without] = await Promise.all([
        client.callTool({
          name: 'prevalidation_aliased',
          arguments: { drug: 'aspirin', querry: 'x' } as never,
        }),
        client.callTool({
          name: 'prevalidation_plain',
          arguments: { drug: 'aspirin', querry: 'x' } as never,
        }),
      ]);

      const detail = (result: typeof withAliases) =>
        (result.structuredContent as { error: { data?: Record<string, unknown>; message: string } })
          .error;
      /** The envelope's `data` minus the per-call request id each carries (#576). */
      const dataOf = (result: typeof withAliases) => {
        const { requestId, ...data } = detail(result).data ?? {};
        expect(requestId).toEqual(expect.any(String));
        return data;
      };

      expect(withAliases.isError).toBe(true);
      expect(detail(withAliases).message).toContain('Unrecognized key: "querry"');
      expect(dataOf(withAliases)).toEqual(dataOf(without));
      expect(detail(withAliases).message.replace('_aliased', '_plain')).toBe(
        detail(without).message,
      );
    });

    it('names an alias sent beside its target on both surfaces, issues unchanged (#639)', async () => {
      const client = await session([aliased as AnyToolDefinition, plain as AnyToolDefinition]);
      const args = { drug: 'aspirin', drug_name: 'tylenol' };
      const [withAliases, without] = await Promise.all([
        client.callTool({ name: 'prevalidation_aliased', arguments: args as never }),
        client.callTool({ name: 'prevalidation_plain', arguments: args as never }),
      ]);

      const detail = (result: typeof withAliases) =>
        (
          result.structuredContent as {
            error: { data?: { issues?: unknown; recovery?: { hint?: string } }; message: string };
          }
        ).error;
      const hint = 'drug_name is an alias of drug; send one of them, not both.';

      expect(withAliases.isError).toBe(true);
      expect(detail(withAliases).data?.recovery?.hint).toBe(hint);
      expect((withAliases.content as Array<{ text: string }>)[0]?.text).toContain(
        `\n\nRecovery: ${hint}\n\n`,
      );
      // Only the hint differs from the tool that declares no alias.
      expect(detail(without).data?.recovery?.hint).toBe(
        'Unknown key drug_name. This tool accepts: drug, maxResults, statusFilter.',
      );
      expect(detail(withAliases).data?.issues).toEqual(detail(without).data?.issues);
      expect(detail(withAliases).message.replace('_aliased', '_plain')).toBe(
        detail(without).message,
      );
    });
  });
});

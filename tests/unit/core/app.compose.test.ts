/**
 * @fileoverview `composeServices` against the real config module and real
 * registries: the `createApp` name/version overrides beating the environment,
 * and the `input` option reaching the argument pre-validation a live client
 * call runs through. Each case connects a real `Client` over an in-memory pair,
 * so what is asserted is what a client and the server card would see.
 * @module tests/unit/core/app.compose.test
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { config, resetConfig } from '@/config/index.js';
import { type CreateAppOptions, composeServices } from '@/core/app.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';

const originalEnv = { ...process.env };

/** Teardown for every client/server pair and rate limiter a case opened. */
const cleanups: Array<() => Promise<void> | void> = [];

/** Composes services and connects a 2025-era client to one server instance. */
async function composeAndConnect(options: CreateAppOptions = {}) {
  const composed = await composeServices(options);
  cleanups.push(() => composed.coreServices.rateLimiter.dispose());
  const server = await composed.createServer({ era: 'legacy' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'compose-test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, manifest: composed.manifest };
}

const search = tool('compose_search', {
  description: 'Searches.',
  input: z.object({
    query: z.string().describe('Search query.'),
    maxResults: z.number().optional().describe('Maximum results.'),
  }),
  output: z.object({ query: z.string().describe('The query that ran.') }),
  handler: (input) => ({ query: input.query }),
});

describe('composeServices with the real config', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.MCP_TRANSPORT_TYPE = 'stdio';
    resetConfig();
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    process.env = { ...originalEnv };
    resetConfig();
  });

  describe('identity precedence', () => {
    it('lets the createApp name and version win over MCP_SERVER_NAME and MCP_SERVER_VERSION', async () => {
      process.env.MCP_SERVER_NAME = 'env-named-server';
      process.env.MCP_SERVER_VERSION = '9.9.9-env';
      resetConfig();

      const { client, manifest } = await composeAndConnect({
        name: 'option-named-server',
        version: '1.2.3-option',
      });

      expect(config.mcpServerName).toBe('option-named-server');
      expect(config.mcpServerVersion).toBe('1.2.3-option');
      expect(manifest.server).toMatchObject({
        name: 'option-named-server',
        version: '1.2.3-option',
      });
      expect(client.getServerVersion()).toMatchObject({
        name: 'option-named-server',
        version: '1.2.3-option',
      });
    });
  });

  describe('input option', () => {
    /** Calls the search tool with a snake_case spelling of a declared camelCase key. */
    const callWithSnakeCaseKey = (client: Client) =>
      client.callTool({ name: 'compose_search', arguments: { query: 'x', max_results: 5 } });

    it('rewrites a case-style variant of a declared key when nothing is configured', async () => {
      const { client } = await composeAndConnect({ tools: [search] });

      const result = await callWithSnakeCaseKey(client);

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ query: 'x' });
    });

    it('reaches the call path, so caseStyleAliases: false rejects that variant by name', async () => {
      const { client } = await composeAndConnect({
        tools: [search],
        input: { caseStyleAliases: false },
      });

      const result = await callWithSnakeCaseKey(client);

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.structuredContent)).toContain(
        'Unrecognized key: \\"max_results\\"',
      );
    });
  });
});

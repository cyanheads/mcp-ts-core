/**
 * @fileoverview Integration tests for the completions wire path. Connects a
 * real MCP SDK Client to a framework-registered McpServer over a linked
 * in-memory transport pair and exercises the full round-trip for:
 * (a) prompt with completable() args — SDK advertises `completions` capability,
 *     client.complete() returns the callback's suggestions
 * (b) resource template with a `complete` map — client.complete() with
 *     ref/resource returns suggestions
 * (c) prompt `title` visible in prompts/list
 * @module tests/integration/completions.int.test
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PromptRegistry } from '@/mcp-server/prompts/prompt-registration.js';
import { prompt } from '@/mcp-server/prompts/utils/promptDefinition.js';
import { ResourceRegistry } from '@/mcp-server/resources/resource-registration.js';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
import type { ResourceHandlerFactoryServices } from '@/mcp-server/resources/utils/resourceHandlerFactory.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { logger } from '@/utils/internal/logger.js';

// ---------------------------------------------------------------------------
// Fixture prompt — completable language arg
// ---------------------------------------------------------------------------

const LANGUAGES = ['typescript', 'python', 'rust', 'go', 'java'];

const codeReviewPrompt = prompt('code_review', {
  description: 'Review code for security and best practices.',
  title: 'Code Review',
  args: z.object({
    language: completable(z.string().describe('Programming language'), async (partial) =>
      LANGUAGES.filter((l) => l.startsWith(partial)),
    ),
    code: z.string().describe('Code snippet to review'),
  }),
  generate: (args) => [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `Review this ${args.language} code:\n${args.code}`,
      },
    },
  ],
});

// ---------------------------------------------------------------------------
// Fixture resource — completable URI variable
// ---------------------------------------------------------------------------

const ITEM_IDS = ['item-001', 'item-002', 'item-003', 'item-abc'];

const itemResource = resource('items://{itemId}', {
  name: 'item-resource',
  description: 'Retrieve an item by ID.',
  params: z.object({ itemId: z.string().describe('Item identifier') }),
  handler: (params) => ({ id: params.itemId, name: `Item ${params.itemId}` }),
  list: () => ({ resources: ITEM_IDS.map((id) => ({ uri: `items://${id}`, name: id })) }),
  complete: {
    itemId: async (partial) => ITEM_IDS.filter((id) => id.startsWith(partial)),
  },
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function connectPair() {
  const server = new McpServer(
    { name: 'completions-int-test', version: '0.0.0' },
    { capabilities: { prompts: { listChanged: true }, resources: { listChanged: true } } },
  );

  const services: ResourceHandlerFactoryServices = {
    logger,
    storage: new StorageService(new InMemoryProvider()),
  };

  const promptRegistry = new PromptRegistry([codeReviewPrompt], logger);
  await promptRegistry.registerAll(server);

  const resourceRegistry = new ResourceRegistry([itemResource], services);
  await resourceRegistry.registerAll(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'completions-int-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe('Completions wire integration', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      try {
        await cleanups.pop()?.();
      } catch {
        // Pair may already be closed.
      }
    }
  });

  // -------------------------------------------------------------------------
  // (a) Prompt completable args
  // -------------------------------------------------------------------------

  it('server advertises completions capability when a prompt has completable args', async () => {
    const { client, server } = await connectPair();
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    const caps = client.getServerCapabilities();
    expect(caps).toHaveProperty('completions');
  });

  it('round-trips prompt arg completion: "ty" → ["typescript"]', async () => {
    const { client, server } = await connectPair();
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.complete({
      ref: { type: 'ref/prompt', name: 'code_review' },
      argument: { name: 'language', value: 'ty' },
    });

    expect(result.completion.values).toEqual(['typescript']);
  });

  it('round-trips prompt arg completion: "" → all languages', async () => {
    const { client, server } = await connectPair();
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.complete({
      ref: { type: 'ref/prompt', name: 'code_review' },
      argument: { name: 'language', value: '' },
    });

    // All languages match an empty prefix
    expect(result.completion.values).toEqual(LANGUAGES);
  });

  it('round-trips prompt arg completion: "x" → [] (no match)', async () => {
    const { client, server } = await connectPair();
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.complete({
      ref: { type: 'ref/prompt', name: 'code_review' },
      argument: { name: 'language', value: 'x' },
    });

    expect(result.completion.values).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // (b) Resource template complete map
  // -------------------------------------------------------------------------

  it('round-trips resource template completion: "item-0" → ["item-001","item-002","item-003"]', async () => {
    const { client, server } = await connectPair();
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.complete({
      ref: { type: 'ref/resource', uri: 'items://{itemId}' },
      argument: { name: 'itemId', value: 'item-0' },
    });

    expect(result.completion.values).toEqual(['item-001', 'item-002', 'item-003']);
  });

  it('round-trips resource template completion: "item-a" → ["item-abc"]', async () => {
    const { client, server } = await connectPair();
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.complete({
      ref: { type: 'ref/resource', uri: 'items://{itemId}' },
      argument: { name: 'itemId', value: 'item-a' },
    });

    expect(result.completion.values).toEqual(['item-abc']);
  });

  // -------------------------------------------------------------------------
  // (c) Prompt title visible in prompts/list
  // -------------------------------------------------------------------------

  it('prompt title is returned in prompts/list', async () => {
    const { client, server } = await connectPair();
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    const list = await client.listPrompts();
    const codeReview = list.prompts.find((p) => p.name === 'code_review');
    expect(codeReview).toBeDefined();
    expect(codeReview?.title).toBe('Code Review');
  });
});

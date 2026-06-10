/**
 * @fileoverview Integration tests for the elicitation wire path. Connects a
 * real MCP SDK Client to a framework-registered McpServer over a linked
 * in-memory transport pair and exercises the full round-trip: tool handler →
 * ctx.elicit → server.elicitInput → client elicitation handler → ElicitResult.
 * Covers form mode, URL mode, the capability presence gate, and the
 * fail-closed pattern for elicit-gated writes.
 * @module tests/integration/elicitation.int.test
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ToolRegistry } from '@/mcp-server/tools/tool-registration.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { forbidden, JsonRpcErrorCode } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';

// ---------------------------------------------------------------------------
// Fixture tools — registered through the framework's real registration path
// ---------------------------------------------------------------------------

const formProbe = tool('elicit_form_probe', {
  description: 'Probes form-mode elicitation availability and round-trip.',
  input: z.object({}),
  output: z.object({
    available: z.boolean().describe('Whether ctx.elicit was defined'),
    action: z.string().nullable().describe('ElicitResult action, null when unavailable'),
    color: z.string().nullable().describe('Color the client answered with, null when absent'),
  }),
  async handler(_input, ctx) {
    if (!ctx.elicit) return { available: false, action: null, color: null };
    const result = await ctx.elicit(
      'Pick a color',
      z.object({ color: z.string().describe('Preferred color') }),
    );
    const color = result.content?.color;
    return {
      available: true,
      action: result.action,
      color: typeof color === 'string' ? color : null,
    };
  },
});

const urlProbe = tool('elicit_url_probe', {
  description: 'Probes URL-mode elicitation round-trip.',
  input: z.object({}),
  output: z.object({
    available: z.boolean().describe('Whether ctx.elicit was defined'),
    action: z.string().nullable().describe('ElicitResult action, null when unavailable'),
  }),
  async handler(_input, ctx) {
    if (!ctx.elicit) return { available: false, action: null };
    const result = await ctx.elicit.url('Authorize via the link', 'https://example.com/authorize');
    return { available: true, action: result.action };
  },
});

const gatedWrite = tool('elicit_gated_write', {
  description: 'Write operation that fails closed without elicitation support.',
  input: z.object({}),
  output: z.object({
    confirmed: z.boolean().describe('Whether the user confirmed the write'),
  }),
  async handler(_input, ctx) {
    if (!ctx.elicit) {
      throw forbidden('Confirmation required: connect with a client that supports elicitation.');
    }
    const result = await ctx.elicit(
      'Apply the write?',
      z.object({ confirm: z.boolean().describe('Confirm the write') }),
    );
    return { confirmed: result.action === 'accept' };
  },
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type ClientOptions = ConstructorParameters<typeof Client>[1];

async function connectPair(clientOptions?: ClientOptions) {
  const server = new McpServer(
    { name: 'elicitation-int-test', version: '0.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  const registry = new ToolRegistry([formProbe, urlProbe, gatedWrite], {
    logger,
    storage: new StorageService(new InMemoryProvider()),
  });
  await registry.registerAll(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'elicitation-int-client', version: '0.0.0' }, clientOptions);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe('Elicitation wire integration', () => {
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

  it('round-trips form-mode elicitation when the client advertises the capability', async () => {
    const received: Record<string, unknown>[] = [];
    const { client, server } = await connectPair({
      capabilities: { elicitation: { form: {}, url: {} } },
    });
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    client.setRequestHandler(ElicitRequestSchema, (request) => {
      received.push(request.params as Record<string, unknown>);
      return { action: 'accept', content: { color: 'teal' } };
    });

    const result = await client.callTool({ name: 'elicit_form_probe', arguments: {} });
    expect(result.structuredContent).toMatchObject({
      available: true,
      action: 'accept',
      color: 'teal',
    });

    // Regression for the wire shape: requestedSchema must arrive as plain
    // JSON Schema (the restricted flat form), never a serialized ZodObject.
    expect(received).toHaveLength(1);
    const params = received[0] as {
      message: string;
      requestedSchema: { properties: Record<string, { type?: string }>; type: string };
    };
    expect(params.message).toBe('Pick a color');
    expect(params.requestedSchema.type).toBe('object');
    expect(params.requestedSchema.properties.color).toMatchObject({ type: 'string' });
  });

  it('round-trips URL-mode elicitation via ctx.elicit.url', async () => {
    const received: Record<string, unknown>[] = [];
    const { client, server } = await connectPair({
      capabilities: { elicitation: { form: {}, url: {} } },
    });
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    client.setRequestHandler(ElicitRequestSchema, (request) => {
      received.push(request.params as Record<string, unknown>);
      return { action: 'accept' };
    });

    const result = await client.callTool({ name: 'elicit_url_probe', arguments: {} });
    expect(result.structuredContent).toMatchObject({ available: true, action: 'accept' });

    expect(received).toHaveLength(1);
    const params = received[0] as {
      elicitationId: string;
      message: string;
      mode: string;
      url: string;
    };
    expect(params.mode).toBe('url');
    expect(params.message).toBe('Authorize via the link');
    expect(params.url).toBe('https://example.com/authorize');
    expect(params.elicitationId).toEqual(expect.any(String));
    expect(params.elicitationId.length).toBeGreaterThan(0);
  });

  it('leaves ctx.elicit undefined when the client does not advertise the capability', async () => {
    const { client, server } = await connectPair();
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({ name: 'elicit_form_probe', arguments: {} });
    expect(result.structuredContent).toMatchObject({
      available: false,
      action: null,
      color: null,
    });
  });

  it('surfaces the declared error from an elicit-gated write when the capability is absent', async () => {
    const { client, server } = await connectPair();
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({ name: 'elicit_gated_write', arguments: {} });
    const structured = result.structuredContent as {
      error?: { code: number; message: string };
    };
    expect(structured.error).toBeDefined();
    expect(structured.error?.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(structured.error?.message).toContain('Confirmation required');
  });
});

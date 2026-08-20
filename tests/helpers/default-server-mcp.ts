/**
 * @fileoverview Shared MCP protocol assertions for the default empty test server.
 * @module tests/integration/helpers/default-server-mcp
 */

import { type Client, ProtocolErrorCode } from '@modelcontextprotocol/client';
import { expect } from 'vitest';

export function expectDefaultServerCapabilities(client: Client): void {
  const capabilities = client.getServerCapabilities();
  expect(capabilities).toMatchObject({
    logging: {},
    prompts: { listChanged: true },
    resources: { listChanged: true, subscribe: true },
    tools: { listChanged: true },
  });
  // The experimental tasks surface was removed from the SDK in v2.
  expect(capabilities?.tasks).toBeUndefined();
}

export async function expectDefaultServerDiscoverySurface(client: Client): Promise<void> {
  const [tools, resources, resourceTemplates, prompts] = await Promise.all([
    client.listTools(),
    client.listResources(),
    client.listResourceTemplates(),
    client.listPrompts(),
  ]);

  expect(tools.tools).toEqual([]);
  expect(resources.resources).toEqual([]);
  expect(resourceTemplates.resourceTemplates).toEqual([]);
  expect(prompts.prompts).toEqual([]);
}

export async function expectDefaultServerProtocolErrors(client: Client): Promise<void> {
  // An unknown tool is a protocol error in v2, not an `isError: true` result.
  await expect(client.callTool({ name: 'missing_tool', arguments: {} })).rejects.toMatchObject({
    code: ProtocolErrorCode.InvalidParams,
    message: expect.stringContaining('Tool missing_tool not found'),
  });

  await expect(
    client.readResource({
      uri: 'missing://resource/item',
    }),
  ).rejects.toMatchObject({
    code: ProtocolErrorCode.InvalidParams,
    message: expect.stringContaining('missing://resource/item'),
  });

  await expect(
    client.getPrompt({
      name: 'missing_prompt',
    }),
  ).rejects.toMatchObject({
    code: ProtocolErrorCode.InvalidParams,
    message: expect.stringContaining('Prompt missing_prompt not found'),
  });
}

/**
 * The `logging` capability is declared, so `logging/setLevel` must resolve —
 * the SDK installs the handler from the declaration with no framework code.
 */
export async function expectDefaultServerLoggingSurface(client: Client): Promise<void> {
  await expect(client.setLoggingLevel('debug')).resolves.toBeDefined();
}

/**
 * `resources: { subscribe: true }` is declared, so subscribe/unsubscribe must
 * resolve rather than answering `-32601` (#354).
 */
export async function expectDefaultServerSubscriptionSurface(client: Client): Promise<void> {
  await expect(client.subscribeResource({ uri: 'thing://1' })).resolves.toBeDefined();
  await expect(client.unsubscribeResource({ uri: 'thing://1' })).resolves.toBeDefined();
}

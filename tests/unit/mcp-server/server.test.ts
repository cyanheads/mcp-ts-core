/**
 * @fileoverview Test suite for createMcpServerInstance — server initialization,
 * registry wiring, declared capabilities, identity fields, and error handling.
 * Identity and capability assertions run against a real `McpServer` connected
 * to a real `Client` over a linked in-memory transport pair, so they read what
 * `initialize` actually advertises rather than constructor arguments.
 * @module tests/mcp-server/server.test
 */

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock logger and requestContextService
vi.mock('@/utils/internal/logger.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    },
  };
});

vi.mock('@/utils/internal/requestContext.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    requestContextService: {
      createRequestContext: vi.fn(() => ({
        requestId: 'test-req-id',
        timestamp: new Date().toISOString(),
        operation: 'createMcpServerInstance',
      })),
    },
  };
});

import type { ResourceSubscriptionRegistry } from '@/mcp-server/resources/resourceSubscriptions.js';
import { installResourceSubscriptions } from '@/mcp-server/resources/resourceSubscriptions.js';
import { createMcpServerInstance, type McpServerDeps } from '@/mcp-server/server.js';
import { logger } from '@/utils/internal/logger.js';

/** Teardown for every connected client/server pair a test opened. */
const cleanups: Array<() => Promise<void>> = [];

/**
 * Connects a real `Client` to `server` over a linked in-memory pair and
 * registers teardown. Returns the initialized client, so
 * `getServerCapabilities()` / `getServerVersion()` read what the server
 * actually advertised on `initialize`.
 */
async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'server-test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe('createMcpServerInstance', () => {
  let mockToolRegistry: { registerAll: ReturnType<typeof vi.fn> };
  let mockResourceRegistry: { registerAll: ReturnType<typeof vi.fn> };
  let mockPromptRegistry: { registerAll: ReturnType<typeof vi.fn> };
  let deps: McpServerDeps;

  beforeEach(() => {
    vi.clearAllMocks();

    mockToolRegistry = { registerAll: vi.fn().mockResolvedValue(undefined) };
    mockResourceRegistry = { registerAll: vi.fn().mockResolvedValue(undefined) };
    mockPromptRegistry = { registerAll: vi.fn() };

    deps = {
      config: {
        mcpServerName: 'test-server',
        mcpServerVersion: '1.0.0',
      } as McpServerDeps['config'],
      toolRegistry: mockToolRegistry as unknown as McpServerDeps['toolRegistry'],
      resourceRegistry: mockResourceRegistry as unknown as McpServerDeps['resourceRegistry'],
      promptRegistry: mockPromptRegistry as unknown as McpServerDeps['promptRegistry'],
    };
  });

  afterEach(async () => {
    while (cleanups.length) {
      try {
        await cleanups.pop()?.();
      } catch {
        // Pair may already be closed.
      }
    }
  });

  it('should return an McpServer instance', async () => {
    const server = await createMcpServerInstance(deps);
    expect(server).toBeInstanceOf(McpServer);
  });

  it('should call ToolRegistry.registerAll with the server and the subscription registry', async () => {
    const server = await createMcpServerInstance(deps);
    expect(mockToolRegistry.registerAll).toHaveBeenCalledTimes(1);
    expect(mockToolRegistry.registerAll).toHaveBeenCalledWith(
      server,
      expect.objectContaining({ has: expect.any(Function) }),
    );
  });

  it('should call ResourceRegistry.registerAll with the server and the subscription registry', async () => {
    const server = await createMcpServerInstance(deps);
    expect(mockResourceRegistry.registerAll).toHaveBeenCalledTimes(1);
    expect(mockResourceRegistry.registerAll).toHaveBeenCalledWith(
      server,
      expect.objectContaining({ has: expect.any(Function) }),
    );
  });

  describe('resource-subscription mechanism by era (#354)', () => {
    it('installs the 2025 registry for a legacy instance', async () => {
      const server = await createMcpServerInstance({ ...deps, era: 'legacy' });
      expect(mockToolRegistry.registerAll).toHaveBeenCalledWith(
        server,
        expect.objectContaining({ has: expect.any(Function) }),
      );
    });

    it('passes no registry for a modern instance, so updates are not gated on it', async () => {
      // `resources/subscribe` does not exist on 2026-07-28 — the client opts in
      // through `subscriptions/listen`. Handing a modern instance the 2025
      // registry leaves it permanently empty, and every
      // `ctx.notifyResourceUpdated(uri)` is silently dropped.
      const server = await createMcpServerInstance({ ...deps, era: 'modern' });
      expect(mockToolRegistry.registerAll).toHaveBeenCalledWith(server, undefined);
      expect(mockResourceRegistry.registerAll).toHaveBeenCalledWith(server, undefined);
    });

    it('defaults to the legacy registry when no era is supplied', async () => {
      const server = await createMcpServerInstance(deps);
      expect(mockToolRegistry.registerAll).toHaveBeenCalledWith(
        server,
        expect.objectContaining({ has: expect.any(Function) }),
      );
    });
  });

  it('should call PromptRegistry.registerAll', async () => {
    await createMcpServerInstance(deps);
    expect(mockPromptRegistry.registerAll).toHaveBeenCalledTimes(1);
  });

  it('should log initialization and success messages', async () => {
    await createMcpServerInstance(deps);
    expect(logger.debug).toHaveBeenCalledWith(
      'Initializing MCP server instance',
      expect.any(Object),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'All MCP capabilities registered successfully',
      expect.any(Object),
    );
  });

  it('should rethrow and log when tool registration fails', async () => {
    const regError = new Error('tool registration failed');
    mockToolRegistry.registerAll.mockRejectedValue(regError);

    await expect(createMcpServerInstance(deps)).rejects.toThrow('tool registration failed');
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to register MCP capabilities',
      expect.objectContaining({ message: 'tool registration failed' }),
      expect.any(Object),
    );
  });

  it('should rethrow and log when resource registration fails', async () => {
    const regError = new Error('resource registration failed');
    mockResourceRegistry.registerAll.mockRejectedValue(regError);

    await expect(createMcpServerInstance(deps)).rejects.toThrow('resource registration failed');
    expect(logger.error).toHaveBeenCalled();
  });

  it('should handle non-Error throws during registration', async () => {
    mockToolRegistry.registerAll.mockRejectedValue('string error');

    await expect(createMcpServerInstance(deps)).rejects.toBe('string error');
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to register MCP capabilities',
      expect.objectContaining({ message: 'string error' }),
      expect.any(Object),
    );
  });

  // -------------------------------------------------------------------------
  // Declared capabilities
  // -------------------------------------------------------------------------

  describe('declared capabilities', () => {
    it('advertises logging, subscribable resources, and list-changed for every primitive', async () => {
      const client = await connect(await createMcpServerInstance(deps));

      expect(client.getServerCapabilities()).toMatchObject({
        logging: {},
        resources: { listChanged: true, subscribe: true },
        tools: { listChanged: true },
        prompts: { listChanged: true },
      });
    });

    it('advertises no tasks capability', async () => {
      const client = await connect(await createMcpServerInstance(deps));

      expect(client.getServerCapabilities()).not.toHaveProperty('tasks');
    });

    it('forwards declared extensions into server capabilities', async () => {
      const client = await connect(
        await createMcpServerInstance({ ...deps, extensions: { 'io.example/thing': {} } }),
      );

      expect(client.getServerCapabilities()?.extensions).toEqual({ 'io.example/thing': {} });
    });
  });

  // -------------------------------------------------------------------------
  // Resource subscriptions (#354)
  // -------------------------------------------------------------------------

  describe('resource subscriptions (#354)', () => {
    /** A bare server carrying only the subscribe capability under test. */
    function subscribableServer(name: string): {
      server: McpServer;
      subscriptions: ResourceSubscriptionRegistry;
    } {
      const server = new McpServer(
        { name, version: '0.0.0' },
        { capabilities: { resources: { listChanged: true, subscribe: true } } },
      );
      return { server, subscriptions: installResourceSubscriptions(server) };
    }

    it('answers resources/subscribe and resources/unsubscribe with an empty result', async () => {
      const client = await connect(await createMcpServerInstance(deps));

      await expect(client.subscribeResource({ uri: 'items://1' })).resolves.toEqual({});
      await expect(client.unsubscribeResource({ uri: 'items://1' })).resolves.toEqual({});
    });

    it('tracks exactly the subscribed URIs in the returned registry', async () => {
      const { server, subscriptions } = subscribableServer('subs');
      const client = await connect(server);

      await client.subscribeResource({ uri: 'items://1' });
      await client.subscribeResource({ uri: 'items://2' });

      expect(subscriptions.has('items://1')).toBe(true);
      expect(subscriptions.has('items://2')).toBe(true);
      expect(subscriptions.has('items://3')).toBe(false);
      expect(subscriptions.size).toBe(2);

      await client.unsubscribeResource({ uri: 'items://1' });

      expect(subscriptions.has('items://1')).toBe(false);
      expect(subscriptions.has('items://2')).toBe(true);
      expect(subscriptions.size).toBe(1);
    });

    it('treats a repeat subscribe and an unknown unsubscribe as no-op successes', async () => {
      const { server, subscriptions } = subscribableServer('subs-idempotent');
      const client = await connect(server);

      await client.subscribeResource({ uri: 'items://1' });
      await expect(client.subscribeResource({ uri: 'items://1' })).resolves.toEqual({});
      expect(subscriptions.size).toBe(1);

      await expect(client.unsubscribeResource({ uri: 'items://never' })).resolves.toEqual({});
      expect(subscriptions.size).toBe(1);
      expect(subscriptions.has('items://1')).toBe(true);
    });

    it('scopes the subscription set to one McpServer instance', async () => {
      const first = subscribableServer('subs-a');
      const second = subscribableServer('subs-b');
      const firstClient = await connect(first.server);
      await connect(second.server);

      await firstClient.subscribeResource({ uri: 'items://1' });

      expect(first.subscriptions.has('items://1')).toBe(true);
      expect(second.subscriptions.has('items://1')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Server identity and instructions
  // -------------------------------------------------------------------------

  describe('instructions option (#91)', () => {
    it('threads instructions into the initialize result when provided', async () => {
      const client = await connect(
        await createMcpServerInstance({
          ...deps,
          instructions: 'Use shortcut alpha for the most common case.',
        }),
      );

      expect(client.getInstructions()).toBe('Use shortcut alpha for the most common case.');
    });

    it('omits instructions when the option is unset', async () => {
      const client = await connect(await createMcpServerInstance(deps));

      expect(client.getInstructions()).toBeUndefined();
    });

    it('does not pass through an empty string (falsy guard)', async () => {
      const client = await connect(await createMcpServerInstance({ ...deps, instructions: '' }));

      expect(client.getInstructions()).toBeUndefined();
    });
  });

  describe('server identity fields (#213)', () => {
    it('forwards title to serverInfo when provided', async () => {
      const client = await connect(await createMcpServerInstance({ ...deps, title: 'My Server' }));

      expect(client.getServerVersion()?.title).toBe('My Server');
    });

    it('omits title from serverInfo when not provided', async () => {
      const client = await connect(await createMcpServerInstance(deps));

      expect(client.getServerVersion()).not.toHaveProperty('title');
    });

    it('forwards websiteUrl to serverInfo when provided', async () => {
      const client = await connect(
        await createMcpServerInstance({
          ...deps,
          websiteUrl: 'https://github.com/owner/my-server',
        }),
      );

      expect(client.getServerVersion()?.websiteUrl).toBe('https://github.com/owner/my-server');
    });

    it('omits websiteUrl from serverInfo when not provided', async () => {
      const client = await connect(await createMcpServerInstance(deps));

      expect(client.getServerVersion()).not.toHaveProperty('websiteUrl');
    });

    it('forwards description to serverInfo when provided', async () => {
      const client = await connect(
        await createMcpServerInstance({ ...deps, description: 'My server description.' }),
      );

      expect(client.getServerVersion()?.description).toBe('My server description.');
    });

    it('omits description from serverInfo when not provided', async () => {
      const client = await connect(await createMcpServerInstance(deps));

      expect(client.getServerVersion()).not.toHaveProperty('description');
    });

    it('forwards icons to serverInfo when provided', async () => {
      const icons = [{ src: 'https://example.com/icon.png', mimeType: 'image/png' }];
      const client = await connect(await createMcpServerInstance({ ...deps, icons }));

      expect(client.getServerVersion()?.icons).toEqual(icons);
    });

    it('omits icons from serverInfo when not provided', async () => {
      const client = await connect(await createMcpServerInstance(deps));

      expect(client.getServerVersion()).not.toHaveProperty('icons');
    });

    it('always includes name and version in serverInfo', async () => {
      const client = await connect(
        await createMcpServerInstance({ ...deps, title: 'T', websiteUrl: 'https://x.com' }),
      );

      expect(client.getServerVersion()).toMatchObject({
        name: 'test-server',
        version: '1.0.0',
      });
    });
  });
});

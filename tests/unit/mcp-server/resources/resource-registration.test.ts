/**
 * @fileoverview Tests for resource registration system.
 * @module tests/mcp-server/resources/resource-registration.test
 */
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ResourceRegistry } from '@/mcp-server/resources/resource-registration.js';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
import type { ResourceHandlerFactoryServices } from '@/mcp-server/resources/utils/resourceHandlerFactory.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    crit: vi.fn(),
    emerg: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('@/config/index.js', () => ({
  config: {
    environment: 'testing',
    mcpServerVersion: '1.0.0-test',
    mcpAuthMode: 'none',
    openTelemetry: { serviceName: 'test', serviceVersion: '0.0.0' },
  },
}));

vi.mock('@/utils/internal/logger.js', () => ({
  logger: mockLogger,
  Logger: { getInstance: () => mockLogger },
}));

vi.mock('@/utils/internal/requestContext.js', () => ({
  requestContextService: {
    createRequestContext: vi.fn((opts: any) => ({
      requestId: 'test-req-id',
      timestamp: new Date().toISOString(),
      operation: opts?.operation ?? 'test',
    })),
  },
}));

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const mockStorage = {
  get: vi.fn(async () => null),
  set: vi.fn(async () => {}),
  delete: vi.fn(async () => {}),
  list: vi.fn(async () => ({ keys: [] })),
  getMany: vi.fn(async () => new Map()),
};

const services: ResourceHandlerFactoryServices = {
  logger: mockLogger as any,
  storage: mockStorage as any,
};

describe('ResourceRegistry', () => {
  let mockServer: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = {
      resource: vi.fn(() => {}),
      setResourceRequestHandlers: vi.fn(),
      sendPromptListChanged: vi.fn(),
      sendResourceListChanged: vi.fn(),
      sendToolListChanged: vi.fn(),
      server: {
        sendResourceUpdated: vi.fn(),
        elicitInput: vi.fn(),
        getClientCapabilities: vi.fn(() => undefined),
      },
    };
  });

  describe('Resource Registration', () => {
    it('should register a single resource successfully', async () => {
      const testResource = resource('test://{id}', {
        description: 'A test resource',
        params: z.object({ id: z.string().describe('id') }),
        handler: (params) => ({ id: params.id }),
      });

      const registry = new ResourceRegistry([testResource], services);
      await registry.registerAll(mockServer);

      expect(mockServer.resource).toHaveBeenCalledTimes(1);
    });

    it('should register multiple resources', async () => {
      const r1 = resource('one://{id}', {
        description: 'First',
        handler: () => ({}),
      });
      const r2 = resource('two://{id}', {
        description: 'Second',
        handler: () => ({}),
      });

      const registry = new ResourceRegistry([r1, r2], services);
      await registry.registerAll(mockServer);

      expect(mockServer.resource).toHaveBeenCalledTimes(2);
    });

    it('should handle empty resource list', async () => {
      const registry = new ResourceRegistry([], services);
      await registry.registerAll(mockServer);

      expect(mockServer.resource).toHaveBeenCalledTimes(0);
      expect(mockServer.setResourceRequestHandlers).toHaveBeenCalledOnce();
    });

    it('should reject duplicate resource names before registering the second resource', async () => {
      const resources = [
        resource('first://{id}', {
          name: 'duplicate',
          description: 'First',
          handler: () => ({}),
        }),
        resource('second://{id}', {
          name: 'duplicate',
          description: 'Second',
          handler: () => ({}),
        }),
      ];

      const registry = new ResourceRegistry(resources, services);

      await expect(registry.registerAll(mockServer)).rejects.toThrow(/Duplicate resource name/);
      expect(mockServer.resource).toHaveBeenCalledTimes(1);
    });

    it('should register resources with correct metadata', async () => {
      const testResource = resource('echo://{msg}', {
        name: 'echo-resource',
        title: 'Echo Resource',
        description: 'Echoes a message',
        mimeType: 'text/plain',
        handler: () => ({}),
      });

      const registry = new ResourceRegistry([testResource], services);
      await registry.registerAll(mockServer);

      const call = mockServer.resource.mock.calls[0];
      expect(call[0]).toBe('echo-resource');
      expect(call[2]).toMatchObject({
        title: 'Echo Resource',
        description: 'Echoes a message',
        mimeType: 'text/plain',
      });
    });

    it('should use uriTemplate as fallback name', async () => {
      const testResource = resource('scheme://{id}', {
        description: 'No name',
        handler: () => ({}),
      });

      const registry = new ResourceRegistry([testResource], services);
      await registry.registerAll(mockServer);

      const call = mockServer.resource.mock.calls[0];
      expect(call[0]).toBe('scheme://{id}');
    });

    it('registers static URIs through the SDK string overload', async () => {
      const testResource = resource('ui://app/app.html', {
        name: 'app-ui',
        description: 'Static app UI',
        handler: () => '<html></html>',
        list: () => ({
          resources: [{ uri: 'ui://app/app.html', name: 'App UI' }],
        }),
      });

      const registry = new ResourceRegistry([testResource], services);
      await registry.registerAll(mockServer);

      const call = mockServer.resource.mock.calls[0];
      expect(call[0]).toBe('app-ui');
      expect(call[1]).toBe('ui://app/app.html');
    });

    it('registers templated URIs through ResourceTemplate', async () => {
      const testResource = resource('items://{id}', {
        name: 'item-resource',
        description: 'Templated resource',
        params: z.object({ id: z.string().describe('id') }),
        handler: () => ({ ok: true }),
        list: () => ({
          resources: [{ uri: 'items://123', name: 'Item 123' }],
        }),
      });

      const registry = new ResourceRegistry([testResource], services);
      await registry.registerAll(mockServer);

      const call = mockServer.resource.mock.calls[0];
      expect(call[0]).toBe('item-resource');
      expect(call[1]).toBeInstanceOf(ResourceTemplate);
      expect(call[1]).not.toBe('items://{id}');
    });

    it('wires per-server notifier closures into resource handler context', async () => {
      const testResource = resource('notify://{id}', {
        name: 'notify-resource',
        description: 'Notifies from handler',
        params: z.object({ id: z.string().describe('id') }),
        handler: (_params, ctx) => {
          ctx.notifyPromptListChanged?.();
          ctx.notifyResourceListChanged?.();
          ctx.notifyResourceUpdated?.('notify://updated');
          ctx.notifyToolListChanged?.();
          return { ok: true };
        },
      });

      const registry = new ResourceRegistry([testResource], services);
      await registry.registerAll(mockServer);

      const handler = mockServer.resource.mock.calls[0][3];
      await handler(new URL('notify://123'), { id: '123' }, new Request('https://example.com'));

      expect(mockServer.sendPromptListChanged).toHaveBeenCalledOnce();
      expect(mockServer.sendResourceListChanged).toHaveBeenCalledOnce();
      expect(mockServer.server.sendResourceUpdated).toHaveBeenCalledWith({
        uri: 'notify://updated',
      });
      expect(mockServer.sendToolListChanged).toHaveBeenCalledOnce();
    });
  });

  describe('ResourceTemplate complete map forwarding', () => {
    it('registers a resource with a complete map and produces a ResourceTemplate', async () => {
      const completer = async (value: string) =>
        ['alpha', 'beta', 'gamma'].filter((v) => v.startsWith(value));

      const testResource = resource('items://{id}', {
        name: 'completable-resource',
        description: 'Resource with URI template completions',
        params: z.object({ id: z.string().describe('Item ID') }),
        handler: () => ({ ok: true }),
        list: () => ({ resources: [] }),
        complete: { id: completer },
      });

      const registry = new ResourceRegistry([testResource], services);
      await registry.registerAll(mockServer);

      // The registration path constructs a ResourceTemplate and passes it as the
      // second argument to server.resource(). Verify the template was created.
      const call = mockServer.resource.mock.calls[0];
      const template = call[1];
      expect(template).toBeInstanceOf(ResourceTemplate);
    });

    it('ResourceDefinition.complete field carries the callback map', () => {
      // Verify the definition type accepts and retains the complete map.
      // Full wire-path forwarding is covered by tests/integration/completions.int.test.ts.
      const completer = async (value: string) => ['alpha'].filter((v) => v.startsWith(value));
      const defWithComplete = resource('things://{id}', {
        name: 'things-complete',
        description: 'Has complete',
        handler: () => ({ ok: true }),
        complete: { id: completer },
      });

      const defWithoutComplete = resource('widgets://{id}', {
        name: 'widgets-no-complete',
        description: 'No complete',
        handler: () => ({ ok: true }),
      });

      expect(defWithComplete.complete).toBeDefined();
      expect(defWithComplete.complete!.id).toBe(completer);
      expect(defWithoutComplete.complete).toBeUndefined();
    });
  });

  describe('Registration Order', () => {
    it('should register resources in the order they are provided', async () => {
      const resources = [
        resource('first://{id}', { name: 'first', description: 'First', handler: () => ({}) }),
        resource('second://{id}', { name: 'second', description: 'Second', handler: () => ({}) }),
        resource('third://{id}', { name: 'third', description: 'Third', handler: () => ({}) }),
      ];

      const registry = new ResourceRegistry(resources, services);
      await registry.registerAll(mockServer);

      expect(mockServer.resource.mock.calls[0][0]).toBe('first');
      expect(mockServer.resource.mock.calls[1][0]).toBe('second');
      expect(mockServer.resource.mock.calls[2][0]).toBe('third');
    });
  });

  describe('Annotations and Examples', () => {
    it('should pass annotations to server.resource', async () => {
      const testResource = resource('ann://{id}', {
        description: 'Annotated',
        handler: () => ({}),
        annotations: { audience: ['user'], priority: 0.8 },
      });

      const registry = new ResourceRegistry([testResource], services);
      await registry.registerAll(mockServer);

      const call = mockServer.resource.mock.calls[0];
      expect(call[2].annotations).toEqual({ audience: ['user'], priority: 0.8 });
    });

    it('should pass _meta to server.resource', async () => {
      const testResource = resource('ui://app/app.html', {
        name: 'app-ui',
        description: 'App UI resource',
        mimeType: 'text/html;profile=mcp-app',
        handler: () => '<html></html>',
        _meta: {
          ui: {
            csp: { resourceDomains: ['https://cdn.example.com'] },
            permissions: { microphone: {} },
          },
        },
      });

      const registry = new ResourceRegistry([testResource], services);
      await registry.registerAll(mockServer);

      const call = mockServer.resource.mock.calls[0];
      expect(call[2]._meta).toEqual({
        ui: {
          csp: { resourceDomains: ['https://cdn.example.com'] },
          permissions: { microphone: {} },
        },
      });
    });

    it('should not include _meta when not provided', async () => {
      const testResource = resource('plain://{id}', {
        description: 'No meta',
        handler: () => ({}),
      });

      const registry = new ResourceRegistry([testResource], services);
      await registry.registerAll(mockServer);

      const call = mockServer.resource.mock.calls[0];
      expect(call[2]._meta).toBeUndefined();
    });

    it('should not publish errors[] contract under _meta', async () => {
      const errorContractResource = resource('contract://{id}', {
        description: 'Resource with errors contract',
        errors: [
          {
            reason: 'no_match',
            code: JsonRpcErrorCode.NotFound,
            when: 'No match found.',
            recovery: 'Try a different identifier and retry the call.',
          },
        ],
        handler: () => ({}),
      });

      const registry = new ResourceRegistry([errorContractResource], services);
      await registry.registerAll(mockServer);

      const call = mockServer.resource.mock.calls[0];
      expect(call[2]._meta).toBeUndefined();
    });

    it('should not merge errors[] contract into custom _meta', async () => {
      const mixedResource = resource('mixed://{id}', {
        description: 'Resource with both errors and _meta',
        errors: [
          {
            reason: 'no_match',
            code: JsonRpcErrorCode.NotFound,
            when: 'No match found.',
            recovery: 'Try a different identifier and retry the call.',
          },
        ],
        _meta: { ui: { resourceUri: 'ui://mixed/app.html' } },
        handler: () => ({}),
      });

      const registry = new ResourceRegistry([mixedResource], services);
      await registry.registerAll(mockServer);

      const call = mockServer.resource.mock.calls[0];
      expect(call[2]._meta).toEqual({ ui: { resourceUri: 'ui://mixed/app.html' } });
      expect(call[2]._meta).not.toHaveProperty('mcp-ts-core/errors');
    });

    it('should pass examples to server.resource', async () => {
      const testResource = resource('ex://{id}', {
        description: 'With examples',
        handler: () => ({}),
        examples: [{ name: 'Ex1', uri: 'ex://1' }],
      });

      const registry = new ResourceRegistry([testResource], services);
      await registry.registerAll(mockServer);

      const call = mockServer.resource.mock.calls[0];
      expect(call[2].examples).toEqual([{ name: 'Ex1', uri: 'ex://1' }]);
    });
  });
});

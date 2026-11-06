/**
 * @fileoverview Tests for resource registration system.
 * @module tests/mcp-server/resources/resource-registration.test
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ResourceRegistry } from '@/mcp-server/resources/resource-registration.js';
import {
  type AnyResourceDefinition,
  resource,
} from '@/mcp-server/resources/utils/resourceDefinition.js';
import type { HandlerServices } from '@/mcp-server/resources/utils/resourceHandlerFactory.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { makeSenderlessServerContext, makeServerContext } from '../../../helpers/server-context.js';

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
  toCanonicalContext: (context: Record<string, unknown>) =>
    Object.fromEntries(
      [
        'auth',
        'extra',
        'operation',
        'requestId',
        'sessionId',
        'spanId',
        'tenantId',
        'timestamp',
        'traceId',
      ]
        .filter((k) => context[k] !== undefined)
        .map((k) => [k, context[k]]),
    ),
  withExtra: (ctx: { extra?: Record<string, unknown> }, fields: Record<string, unknown>) => ({
    ...ctx,
    extra: { ...ctx.extra, ...fields },
  }),
  withActiveSpan: <T>(ctx: T): T => ctx,
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

const services: HandlerServices = {
  logger: mockLogger as any,
  storage: mockStorage as any,
};

/** Fires every list-changed / resource-updated notifier from its handler. */
const notifyingResource = resource('notify://{id}', {
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

describe('ResourceRegistry', () => {
  let mockServer: any;

  beforeEach(() => {
    vi.clearAllMocks();
    // v2 installs `resources/list` / `resources/read` from the declared
    // `resources` capability, so registration only ever calls
    // `registerResource`.
    mockServer = {
      registerResource: vi.fn(() => {}),
      sendPromptListChanged: vi.fn(),
      sendResourceListChanged: vi.fn(),
      sendToolListChanged: vi.fn(),
    };
  });

  describe('Resource Registration', () => {
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
      expect(mockServer.registerResource).toHaveBeenCalledTimes(1);
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

      const call = mockServer.registerResource.mock.calls[0];
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

      const call = mockServer.registerResource.mock.calls[0];
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

      const call = mockServer.registerResource.mock.calls[0];
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

      const call = mockServer.registerResource.mock.calls[0];
      expect(call[0]).toBe('item-resource');
      expect(call[1]).toBeInstanceOf(ResourceTemplate);
      expect(call[1]).not.toBe('items://{id}');
    });

    it('falls back to the per-server notifier closures when the request scope has no sender', async () => {
      const registry = new ResourceRegistry([notifyingResource], services);
      await registry.registerAll(mockServer);

      const handler = mockServer.registerResource.mock.calls[0][3];
      await handler(new URL('notify://123'), { id: '123' }, makeSenderlessServerContext());

      expect(mockServer.sendPromptListChanged).toHaveBeenCalledOnce();
      expect(mockServer.sendResourceListChanged).toHaveBeenCalledOnce();
      expect(mockServer.sendToolListChanged).toHaveBeenCalledOnce();
    });

    it('gates resources/updated on the connection subscription registry (#354)', async () => {
      const notify = vi.fn(async () => {});
      const has = vi.fn(() => false);
      const registry = new ResourceRegistry([notifyingResource], services);
      await registry.registerAll(mockServer, { has });

      const handler = mockServer.registerResource.mock.calls[0][3];
      await handler(new URL('notify://123'), { id: '123' }, makeServerContext({ notify }));

      expect(has).toHaveBeenCalledWith('notify://updated');
      expect(notify).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: 'notifications/resources/updated' }),
      );
      expect(notify).toHaveBeenCalledWith({ method: 'notifications/tools/list_changed' });
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
      // second argument to server.registerResource(), carrying the complete map.
      const template = mockServer.registerResource.mock.calls[0][1] as ResourceTemplate;
      expect(template).toBeInstanceOf(ResourceTemplate);
      expect(template.completeCallback('id')).toBe(completer);
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

      expect(mockServer.registerResource.mock.calls[0][0]).toBe('first');
      expect(mockServer.registerResource.mock.calls[1][0]).toBe('second');
      expect(mockServer.registerResource.mock.calls[2][0]).toBe('third');
    });
  });

  describe('Annotations and Examples', () => {
    it('should pass annotations to server.registerResource', async () => {
      const testResource = resource('ann://{id}', {
        description: 'Annotated',
        handler: () => ({}),
        annotations: { audience: ['user'], priority: 0.8 },
      });

      const registry = new ResourceRegistry([testResource], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerResource.mock.calls[0];
      expect(call[2].annotations).toEqual({ audience: ['user'], priority: 0.8 });
    });

    it('should pass _meta to server.registerResource', async () => {
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

      const call = mockServer.registerResource.mock.calls[0];
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

      const call = mockServer.registerResource.mock.calls[0];
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

      const call = mockServer.registerResource.mock.calls[0];
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

      const call = mockServer.registerResource.mock.calls[0];
      expect(call[2]._meta).toEqual({ ui: { resourceUri: 'ui://mixed/app.html' } });
      expect(call[2]._meta).not.toHaveProperty('mcp-ts-core/errors');
    });

    it('should pass examples to server.registerResource', async () => {
      const testResource = resource('ex://{id}', {
        description: 'With examples',
        handler: () => ({}),
        examples: [{ name: 'Ex1', uri: 'ex://1' }],
      });

      const registry = new ResourceRegistry([testResource], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerResource.mock.calls[0];
      expect(call[2].examples).toEqual([{ name: 'Ex1', uri: 'ex://1' }]);
    });
  });

  describe('resources/list entries of a template (#690)', () => {
    /**
     * Registers `defs` on a real `McpServer`, connects a client, and returns
     * the `resources/list` and `resources/templates/list` results as the server
     * wrote them: JSON round-tripped, so a key sent as `undefined` is absent,
     * as on every real transport.
     */
    async function listedOnTheWire(defs: AnyResourceDefinition[]) {
      const server = new McpServer(
        { name: 'resource-list-wire', version: '0.0.0' },
        { capabilities: { resources: {} } },
      );
      await new ResourceRegistry(defs, services).registerAll(server);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const written: Array<{ result?: Record<string, unknown> }> = [];
      const send = serverTransport.send.bind(serverTransport);
      serverTransport.send = (message, options) => {
        written.push(JSON.parse(JSON.stringify(message)));
        return send(message, options);
      };
      const client = new Client({ name: 'resource-list-client', version: '0.0.0' });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        await client.listResources();
        await client.listResourceTemplates();
        const result = (key: string) => written.find((m) => m.result && key in m.result)?.result;
        return {
          resources: result('resources')?.resources,
          resourceTemplates: result('resourceTemplates')?.resourceTemplates,
        };
      } finally {
        await client.close();
        await server.close();
      }
    }

    /** The `ResourceTemplate` the registry builds for `def`. */
    async function registeredTemplate(def: AnyResourceDefinition): Promise<ResourceTemplate> {
      await new ResourceRegistry([def], services).registerAll(mockServer);
      return mockServer.registerResource.mock.calls[0][1] as ResourceTemplate;
    }

    const ECHO_DESCRIPTION =
      'Echo a message from the URI. Replace this with your first real resource.';

    it("lists the scaffold's entry without the registration name, which resources/templates/list keeps as the title", async () => {
      const echo = resource('echo://{message}', {
        name: 'template-echo-resource',
        description: ECHO_DESCRIPTION,
        mimeType: 'application/json',
        params: z.object({ message: z.string().describe('The message to echo back.') }),
        handler: (params) => ({ message: params.message }),
        list: () => ({ resources: [{ uri: 'echo://hello', name: 'Echo Hello' }] }),
      });

      const { resources, resourceTemplates } = await listedOnTheWire([echo]);

      expect(resources).toStrictEqual([
        {
          uri: 'echo://hello',
          name: 'Echo Hello',
          description: ECHO_DESCRIPTION,
          mimeType: 'application/json',
        },
      ]);
      expect(resourceTemplates).toStrictEqual([
        {
          name: 'template-echo-resource',
          uriTemplate: 'echo://{message}',
          title: 'template-echo-resource',
          description: ECHO_DESCRIPTION,
          mimeType: 'application/json',
        },
      ]);
    });

    it('lists entries with every template field but its declared title, which resources/templates/list advertises', async () => {
      const annotations = {
        audience: ['user' as const],
        priority: 0.4,
        lastModified: '2026-01-02T03:04:05Z',
      };
      const titled = resource('titled://{id}', {
        name: 'titled-template',
        title: 'Titled Template',
        description: 'Reads one titled item.',
        mimeType: 'text/markdown',
        size: 42,
        examples: [{ name: 'First', uri: 'titled://1' }],
        annotations,
        _meta: { 'vendor/owner': 'catalog' },
        handler: () => '',
        list: () => ({ resources: [{ uri: 'titled://1', name: 'One' }] }),
      });

      const { resources, resourceTemplates } = await listedOnTheWire([titled]);

      expect(resources).toStrictEqual([
        {
          uri: 'titled://1',
          name: 'One',
          description: 'Reads one titled item.',
          mimeType: 'text/markdown',
          size: 42,
          examples: [{ name: 'First', uri: 'titled://1' }],
          annotations,
          _meta: { 'vendor/owner': 'catalog' },
        },
      ]);
      expect(resourceTemplates).toStrictEqual([
        {
          name: 'titled-template',
          uriTemplate: 'titled://{id}',
          title: 'Titled Template',
          description: 'Reads one titled item.',
          mimeType: 'text/markdown',
          size: 42,
          examples: [{ name: 'First', uri: 'titled://1' }],
          annotations,
          _meta: { 'vendor/owner': 'catalog' },
        },
      ]);
    });

    it('keeps the title, description, and mimeType an entry sets itself', async () => {
      const def = resource('own://{id}', {
        name: 'own-fields',
        title: 'Template Title',
        description: 'Template description.',
        mimeType: 'application/json',
        handler: () => ({}),
        list: () => ({
          resources: [
            {
              uri: 'own://1',
              name: 'One',
              title: 'Entry Title',
              description: 'Entry description.',
              mimeType: 'text/plain',
            },
            { uri: 'own://2', name: 'Two' },
          ],
        }),
      });

      const { resources } = await listedOnTheWire([def]);

      expect(resources).toStrictEqual([
        {
          uri: 'own://1',
          name: 'One',
          title: 'Entry Title',
          description: 'Entry description.',
          mimeType: 'text/plain',
        },
        {
          uri: 'own://2',
          name: 'Two',
          description: 'Template description.',
          mimeType: 'application/json',
        },
      ]);
    });

    it('leaves a static resource’s entry as it was, its title included', async () => {
      const page = resource('ui://app/page.html', {
        name: 'app-page',
        title: 'App Page',
        description: 'A static page.',
        mimeType: 'text/html',
        handler: () => '<html></html>',
      });

      const { resources } = await listedOnTheWire([page]);

      expect(resources).toStrictEqual([
        {
          uri: 'ui://app/page.html',
          name: 'app-page',
          title: 'App Page',
          description: 'A static page.',
          mimeType: 'text/html',
        },
      ]);
    });

    it('passes an async list’s result through, pagination fields included, each entry carrying its own title key', async () => {
      const template = await registeredTemplate(
        resource('paged://{id}', {
          name: 'paged',
          title: 'Paged Template',
          description: 'Paged items.',
          handler: () => ({}),
          list: async () => ({
            resources: [
              { uri: 'paged://1', name: 'One' },
              { uri: 'paged://2', name: 'Two', title: 'Second' },
            ],
            nextCursor: 'page-2',
            _meta: { 'vendor/total': 40 },
          }),
        }),
      );

      const listed = await template.listCallback?.(makeServerContext());

      expect(listed).toStrictEqual({
        resources: [
          { title: undefined, uri: 'paged://1', name: 'One' },
          { uri: 'paged://2', name: 'Two', title: 'Second' },
        ],
        nextCursor: 'page-2',
        _meta: { 'vendor/total': 40 },
      });
    });

    it.each([
      [
        'throws',
        (failure: Error) => (): never => {
          throw failure;
        },
      ],
      [
        'rejects',
        (failure: Error) => async (): Promise<never> => {
          throw failure;
        },
      ],
    ])('rethrows the very error a list that %s raises', async (_label, makeList) => {
      const failure = new Error('Catalog offline.');
      const template = await registeredTemplate(
        resource('failing://{id}', {
          name: 'failing',
          description: 'Fails to list.',
          handler: () => ({}),
          list: makeList(failure),
        }),
      );

      await expect(
        Promise.resolve().then(() => template.listCallback?.(makeServerContext())),
      ).rejects.toBe(failure);
    });

    it('registers no list callback for a template without list()', async () => {
      const template = await registeredTemplate(
        resource('unlisted://{id}', { description: 'Not listed.', handler: () => ({}) }),
      );

      expect(template.listCallback).toBeUndefined();
    });
  });
});

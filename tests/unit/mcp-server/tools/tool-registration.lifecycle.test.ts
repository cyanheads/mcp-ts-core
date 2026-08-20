/**
 * @fileoverview Unit tests for the registration-time wiring `ToolRegistry` owns:
 * the per-server notifier closures handed to each handler factory, the
 * `resources/subscribe` registry forwarded alongside them, `_meta` passthrough,
 * duplicate-name detection, and the missing-services guard.
 * @module tests/unit/mcp-server/tools/tool-registration.lifecycle.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { mockCreateToolHandler, mockErrorHandler, mockLogger, mockRequestContextService } =
  vi.hoisted(() => ({
    mockCreateToolHandler: vi.fn(),
    mockErrorHandler: {
      tryCatch: vi.fn(async (fn: () => unknown) => await fn()),
    },
    mockLogger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      notice: vi.fn(),
      warning: vi.fn(),
    },
    mockRequestContextService: {
      createRequestContext: vi.fn((params?: Record<string, unknown>) => ({
        requestId: 'tool-registry-request',
        timestamp: '2026-03-30T00:00:00.000Z',
        ...params,
      })),
    },
  }));

vi.mock('@/mcp-server/tools/utils/toolHandlerFactory.js', async () => {
  const actual = await vi.importActual<
    typeof import('@/mcp-server/tools/utils/toolHandlerFactory.js')
  >('@/mcp-server/tools/utils/toolHandlerFactory.js');
  return {
    ...actual,
    createToolHandler: mockCreateToolHandler,
  };
});

vi.mock('@/utils/internal/error-handler/errorHandler.js', () => ({
  ErrorHandler: mockErrorHandler,
}));

vi.mock('@/utils/internal/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('@/utils/internal/requestContext.js', () => ({
  withExtra: (ctx: { extra?: Record<string, unknown> }, fields: Record<string, unknown>) => ({
    ...ctx,
    extra: { ...ctx.extra, ...fields },
  }),
  requestContextService: mockRequestContextService,
}));

import type { ResourceSubscriptions } from '@/mcp-server/notifications.js';
import { ToolRegistry } from '@/mcp-server/tools/tool-registration.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import type {
  HandlerFactoryServices,
  HandlerNotifiers,
} from '@/mcp-server/tools/utils/toolHandlerFactory.js';

describe('ToolRegistry registration wiring', () => {
  let services: HandlerFactoryServices;
  let mockServer: {
    registerTool: ReturnType<typeof vi.fn>;
    sendPromptListChanged: ReturnType<typeof vi.fn>;
    sendResourceListChanged: ReturnType<typeof vi.fn>;
    sendToolListChanged: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    services = {
      logger: mockLogger as never,
      storage: {
        delete: vi.fn(),
        get: vi.fn(),
        getMany: vi.fn(),
        list: vi.fn(),
        set: vi.fn(),
      } as never,
    };

    mockServer = {
      registerTool: vi.fn(),
      sendPromptListChanged: vi.fn(),
      sendResourceListChanged: vi.fn(),
      sendToolListChanged: vi.fn(),
    };

    mockCreateToolHandler.mockReturnValue(vi.fn());
  });

  /** The `HandlerNotifiers` the registry passed to the handler factory. */
  function notifiersFromFactory(): HandlerNotifiers {
    const call = mockCreateToolHandler.mock.calls[0];
    expect(call).toBeDefined();
    return call![2] as HandlerNotifiers;
  }

  it('binds per-server notifiers for each registration and forwards _meta during tool registration', async () => {
    const standardTool = tool('meta_tool', {
      _meta: { 'x-test': true },
      annotations: { readOnlyHint: true },
      description: 'Regular tool with metadata',
      input: z.object({ query: z.string().describe('Query') }),
      output: z.object({ result: z.string().describe('Result') }),
      handler: ({ query }) => ({ result: query.toUpperCase() }),
    });

    const registry = new ToolRegistry([standardTool], services);
    await registry.registerAll(mockServer as never);

    const registration = mockServer.registerTool.mock.calls[0];
    expect(registration).toBeDefined();
    expect(registration![1]).toMatchObject({
      _meta: { 'x-test': true },
      annotations: { readOnlyHint: true },
    });

    // The shared `services` object must not be mutated — that would race under
    // concurrent HTTP requests. Notifiers are passed as a separate argument.
    expect(
      (services as unknown as Record<string, unknown>).notifyResourceListChanged,
    ).toBeUndefined();
    expect((services as unknown as Record<string, unknown>).notifyToolListChanged).toBeUndefined();

    const notifiers = notifiersFromFactory();
    notifiers.notifyToolListChanged?.();
    notifiers.notifyResourceListChanged?.();
    notifiers.notifyPromptListChanged?.();

    expect(mockServer.sendToolListChanged).toHaveBeenCalledTimes(1);
    expect(mockServer.sendResourceListChanged).toHaveBeenCalledTimes(1);
    expect(mockServer.sendPromptListChanged).toHaveBeenCalledTimes(1);
  });

  it('forwards the resources/subscribe registry to the handler factory', async () => {
    const subscriptions: ResourceSubscriptions = { has: vi.fn(() => true) };
    const standardTool = tool('subscribing_tool', {
      description: 'Tool whose handler may announce resource updates',
      input: z.object({}),
      output: z.object({ ok: z.boolean().describe('Whether it worked') }),
      handler: () => ({ ok: true }),
    });

    const registry = new ToolRegistry([standardTool], services);
    await registry.registerAll(mockServer as never, subscriptions);

    // The gate itself lives in `buildRequestScopedNotifiers`; the registry's
    // job is getting the per-connection registry down to it.
    expect(notifiersFromFactory().subscriptions).toBe(subscriptions);
  });

  it('omits subscriptions when the connection tracks none', async () => {
    const standardTool = tool('unsubscribing_tool', {
      description: 'Tool registered without subscription tracking',
      input: z.object({}),
      output: z.object({ ok: z.boolean().describe('Whether it worked') }),
      handler: () => ({ ok: true }),
    });

    const registry = new ToolRegistry([standardTool], services);
    await registry.registerAll(mockServer as never);

    expect(notifiersFromFactory().subscriptions).toBeUndefined();
  });

  it('rejects duplicate tool names', async () => {
    const first = tool('shared_name', {
      description: 'First tool',
      input: z.object({}),
      output: z.object({ ok: z.boolean().describe('Whether it worked') }),
      handler: () => ({ ok: true }),
    });
    const second = tool('shared_name', {
      description: 'Second tool with the same name',
      input: z.object({ input: z.string().describe('Input') }),
      output: z.object({ done: z.boolean().describe('Whether it completed') }),
      handler: () => ({ done: true }),
    });

    const registry = new ToolRegistry([first, second], services);

    await expect(registry.registerAll(mockServer as never)).rejects.toThrow(
      "Duplicate tool name 'shared_name'",
    );
  });

  it('clears name tracking between registerAll calls so a shared registry can re-register', async () => {
    // Registries are shared across the per-request McpServer instances HTTP
    // serving builds, so a second pass must not read as a duplicate.
    const standardTool = tool('reused_tool', {
      description: 'Registered onto more than one server instance',
      input: z.object({}),
      output: z.object({ ok: z.boolean().describe('Whether it worked') }),
      handler: () => ({ ok: true }),
    });

    const registry = new ToolRegistry([standardTool], services);
    await registry.registerAll(mockServer as never);
    await registry.registerAll(mockServer as never);

    expect(mockServer.registerTool).toHaveBeenCalledTimes(2);
  });

  it('throws when registering a tool without handler factory services', async () => {
    const standardTool = tool('missing_services_tool', {
      description: 'No services',
      input: z.object({}),
      output: z.object({ ok: z.boolean().describe('Whether it worked') }),
      handler: () => ({ ok: true }),
    });

    const registry = new ToolRegistry([standardTool]);

    await expect(registry.registerAll(mockServer as never)).rejects.toThrow(
      "Cannot register tool 'missing_services_tool': HandlerFactoryServices not provided",
    );
  });
});

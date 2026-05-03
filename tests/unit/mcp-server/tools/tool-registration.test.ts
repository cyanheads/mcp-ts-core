/**
 * @fileoverview Tests for tool registration system.
 * @module tests/mcp-server/tools/tool-registration.test
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '@/mcp-server/tools/tool-registration.js';
import { disabledTool } from '@/mcp-server/tools/utils/disabled-tool.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import type { HandlerFactoryServices } from '@/mcp-server/tools/utils/toolHandlerFactory.js';
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
    tasks: {
      defaultTtlMs: 60_000,
    },
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

vi.mock('@/utils/internal/performance.js', () => ({
  measureToolExecution: vi.fn((fn: () => unknown) => fn()),
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

const services: HandlerFactoryServices = {
  logger: mockLogger as any,
  storage: mockStorage as any,
};

describe('ToolRegistry', () => {
  let mockServer: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = {
      registerTool: vi.fn(() => {}),
      setToolRequestHandlers: vi.fn(() => {}),
      experimental: {
        tasks: {
          registerToolTask: vi.fn(() => {}),
        },
      },
    };
  });

  describe('Tool Registration', () => {
    it('should register a single tool successfully', async () => {
      const testTool = tool('test_tool', {
        description: 'A test tool',
        input: z.object({ input: z.string().describe('input') }),
        output: z.object({ output: z.string().describe('output') }),
        handler: (input) => ({ output: input.input.toUpperCase() }),
      });

      const registry = new ToolRegistry([testTool], services);
      await registry.registerAll(mockServer);

      expect(mockServer.registerTool).toHaveBeenCalledTimes(1);
      const call = mockServer.registerTool.mock.calls[0];
      expect(call[0]).toBe('test_tool');
      expect(call[1].description).toBe('A test tool');
      expect(typeof call[2]).toBe('function');
    });

    it('should register multiple tools', async () => {
      const tool1 = tool('tool_one', {
        description: 'First tool',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
      });

      const tool2 = tool('tool_two', {
        description: 'Second tool',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
      });

      const registry = new ToolRegistry([tool1, tool2], services);
      await registry.registerAll(mockServer);

      expect(mockServer.registerTool).toHaveBeenCalledTimes(2);
    });

    it('should handle empty tool list', async () => {
      const registry = new ToolRegistry([], services);
      await registry.registerAll(mockServer);

      expect(mockServer.registerTool).toHaveBeenCalledTimes(0);
      expect(mockServer.setToolRequestHandlers).toHaveBeenCalledTimes(1);
    });

    it('should initialize MCP tool handlers for task-only tool registries', async () => {
      const taskOnlyTool = tool('task_only_tool', {
        description: 'Task-only tool',
        input: z.object({ query: z.string().describe('query') }),
        output: z.object({ result: z.string().describe('result') }),
        task: true,
        handler: async (input) => ({ result: input.query.toUpperCase() }),
      });

      const registry = new ToolRegistry([taskOnlyTool], services);
      await registry.registerAll(mockServer);

      expect(mockServer.setToolRequestHandlers).toHaveBeenCalledTimes(1);
      expect(mockServer.experimental.tasks.registerToolTask).toHaveBeenCalledTimes(1);
      expect(mockServer.registerTool).not.toHaveBeenCalled();
    });
  });

  describe('Disabled Tools', () => {
    it('should skip MCP registration for tools wrapped with disabledTool()', async () => {
      const enabledDef = tool('enabled_tool', {
        description: 'Enabled tool',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
      });
      const disabledDef = disabledTool(
        tool('disabled_tool', {
          description: 'Disabled tool',
          input: z.object({}),
          output: z.object({}),
          handler: () => ({}),
        }),
        { reason: 'Writes are turned off in this deployment.' },
      );

      const registry = new ToolRegistry([enabledDef, disabledDef], services);
      await registry.registerAll(mockServer);

      expect(mockServer.registerTool).toHaveBeenCalledTimes(1);
      expect(mockServer.registerTool.mock.calls[0][0]).toBe('enabled_tool');
    });

    it('should skip disabled task tools too', async () => {
      const disabledTaskDef = disabledTool(
        tool('disabled_task', {
          description: 'Disabled task tool',
          input: z.object({}),
          output: z.object({}),
          task: true,
          handler: async () => ({}),
        }),
        { reason: 'Background analytics are disabled in this deployment.' },
      );

      const registry = new ToolRegistry([disabledTaskDef], services);
      await registry.registerAll(mockServer);

      expect(mockServer.experimental.tasks.registerToolTask).not.toHaveBeenCalled();
      expect(mockServer.registerTool).not.toHaveBeenCalled();
      // SDK tools/list + tools/call handlers are still installed even when
      // every tool is disabled — clients get a truthful empty list.
      expect(mockServer.setToolRequestHandlers).toHaveBeenCalledTimes(1);
    });

    it('should preserve all original definition fields when wrapped', () => {
      const original = tool('preserved', {
        description: 'Original description',
        input: z.object({ q: z.string().describe('q') }),
        output: z.object({ r: z.string().describe('r') }),
        auth: ['tool:preserved:read'],
        handler: () => ({ r: 'ok' }),
      });
      const wrapped = disabledTool(original, {
        reason: 'Disabled until config flag is enabled.',
        hint: 'PRESERVED_FLAG=true',
      });

      expect(wrapped.name).toBe('preserved');
      expect(wrapped.description).toBe('Original description');
      expect(wrapped.auth).toEqual(['tool:preserved:read']);
      expect(wrapped.handler).toBe(original.handler);
    });
  });

  describe('Title Derivation', () => {
    it('should use explicit title when provided', async () => {
      const testTool = tool('my_tool', {
        title: 'Custom Title',
        description: 'Test tool',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
      });

      const registry = new ToolRegistry([testTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1].title).toBe('Custom Title');
    });

    it('should use annotation title when no explicit title', async () => {
      const testTool = tool('my_tool', {
        description: 'Test tool',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
        annotations: { title: 'Annotation Title' },
      });

      const registry = new ToolRegistry([testTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1].title).toBe('Annotation Title');
    });

    it('should derive title from name when no title provided', async () => {
      const testTool = tool('echo_message_test', {
        description: 'Test tool',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
      });

      const registry = new ToolRegistry([testTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1].title).toBe('Echo Message Test');
    });

    it('should prefer explicit title over annotation title', async () => {
      const testTool = tool('my_tool', {
        title: 'Explicit Title',
        description: 'Test tool',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
        annotations: { title: 'Annotation Title' },
      });

      const registry = new ToolRegistry([testTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1].title).toBe('Explicit Title');
    });
  });

  describe('Schema Registration', () => {
    it('should register input and output schemas', async () => {
      const testTool = tool('typed_tool', {
        description: 'Tool with schemas',
        input: z.object({
          name: z.string().describe('name'),
          age: z.number().describe('age'),
        }),
        output: z.object({
          greeting: z.string().describe('greeting'),
        }),
        handler: (input) => ({ greeting: `Hello ${input.name}` }),
      });

      const registry = new ToolRegistry([testTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1].inputSchema).toBeDefined();
      expect(call[1].outputSchema).toBeDefined();
      expect(call[1].inputSchema.shape.name).toBeDefined();
      expect(call[1].outputSchema.shape.greeting).toBeDefined();
    });
  });

  describe('Annotations', () => {
    it('should register annotations when provided', async () => {
      const testTool = tool('annotated_tool', {
        description: 'Tool with annotations',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      });

      const registry = new ToolRegistry([testTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1].annotations).toBeDefined();
      expect(call[1].annotations.readOnlyHint).toBe(true);
      expect(call[1].annotations.idempotentHint).toBe(true);
      expect(call[1].annotations.openWorldHint).toBe(false);
    });

    it('should not include annotations field when none provided', async () => {
      const testTool = tool('plain_tool', {
        description: 'Tool without annotations',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
      });

      const registry = new ToolRegistry([testTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1].annotations).toBeUndefined();
    });
  });

  describe('Handler Creation', () => {
    it('should create handler with custom format', async () => {
      const testTool = tool('formatted_tool', {
        description: 'Tool with formatter',
        input: z.object({}),
        output: z.object({ data: z.string().describe('data') }),
        handler: () => ({ data: 'test' }),
        format: (result) => [{ type: 'text', text: `Custom: ${result.data}` }],
      });

      const registry = new ToolRegistry([testTool], services);
      await registry.registerAll(mockServer);

      expect(mockServer.registerTool).toHaveBeenCalledTimes(1);
      const handler = mockServer.registerTool.mock.calls[0][2];
      expect(typeof handler).toBe('function');
    });

    it('should create handler without format when not provided', async () => {
      const testTool = tool('plain_tool', {
        description: 'Tool without formatter',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
      });

      const registry = new ToolRegistry([testTool], services);
      await registry.registerAll(mockServer);

      const handler = mockServer.registerTool.mock.calls[0][2];
      expect(typeof handler).toBe('function');
    });
  });

  describe('Registration Order', () => {
    it('should register tools in the order they are provided', async () => {
      const tools = [
        tool('first', {
          description: 'First tool',
          input: z.object({}),
          output: z.object({}),
          handler: () => ({}),
        }),
        tool('second', {
          description: 'Second tool',
          input: z.object({}),
          output: z.object({}),
          handler: () => ({}),
        }),
        tool('third', {
          description: 'Third tool',
          input: z.object({}),
          output: z.object({}),
          handler: () => ({}),
        }),
      ];

      const registry = new ToolRegistry(tools, services);
      await registry.registerAll(mockServer);

      expect(mockServer.registerTool.mock.calls[0][0]).toBe('first');
      expect(mockServer.registerTool.mock.calls[1][0]).toBe('second');
      expect(mockServer.registerTool.mock.calls[2][0]).toBe('third');
    });
  });

  describe('_meta Passthrough', () => {
    it('should pass _meta to server.registerTool for standard tools', async () => {
      const testTool = tool('app_tool', {
        description: 'App tool with _meta',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
        _meta: {
          ui: { resourceUri: 'ui://my-app/app.html' },
          'ui/resourceUri': 'ui://my-app/app.html',
        },
      });

      const registry = new ToolRegistry([testTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1]._meta).toEqual({
        ui: { resourceUri: 'ui://my-app/app.html' },
        'ui/resourceUri': 'ui://my-app/app.html',
      });
    });

    it('should not include _meta when not provided', async () => {
      const testTool = tool('plain_tool', {
        description: 'Tool without _meta',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
      });

      const registry = new ToolRegistry([testTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1]._meta).toBeUndefined();
    });

    it('should pass _meta to registerToolTask for auto-task tools', async () => {
      const taskTool = tool('task_app_tool', {
        description: 'Task app tool',
        input: z.object({}),
        output: z.object({}),
        task: true,
        handler: async () => ({}),
        _meta: {
          ui: { resourceUri: 'ui://task-app/app.html' },
          'ui/resourceUri': 'ui://task-app/app.html',
        },
      });

      const registry = new ToolRegistry([taskTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.experimental.tasks.registerToolTask.mock.calls[0];
      expect(call[1]._meta).toEqual({
        ui: { resourceUri: 'ui://task-app/app.html' },
        'ui/resourceUri': 'ui://task-app/app.html',
      });
    });

    it('should not publish errors[] contract under _meta on standard tools', async () => {
      const errorContractTool = tool('contract_tool', {
        description: 'Tool with errors contract',
        input: z.object({}),
        output: z.object({}),
        errors: [
          {
            reason: 'no_match',
            code: JsonRpcErrorCode.NotFound,
            when: 'No match found.',
            recovery: 'Broaden the query and try again with looser filters.',
          },
        ],
        handler: () => ({}),
      });

      const registry = new ToolRegistry([errorContractTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1]._meta).toBeUndefined();
    });

    it('should not merge errors[] contract into custom _meta on standard tools', async () => {
      const mixedTool = tool('mixed_tool', {
        description: 'Tool with both errors and _meta',
        input: z.object({}),
        output: z.object({}),
        errors: [
          {
            reason: 'no_match',
            code: JsonRpcErrorCode.NotFound,
            when: 'No match found.',
            recovery: 'Broaden the query and try again with looser filters.',
          },
        ],
        _meta: { ui: { resourceUri: 'ui://mixed/app.html' } },
        handler: () => ({}),
      });

      const registry = new ToolRegistry([mixedTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1]._meta).toEqual({ ui: { resourceUri: 'ui://mixed/app.html' } });
      expect(call[1]._meta).not.toHaveProperty('mcp-ts-core/errors');
    });

    it('should not publish errors[] contract under _meta on auto-task tools', async () => {
      const taskContractTool = tool('task_contract_tool', {
        description: 'Auto-task tool with errors contract',
        input: z.object({}),
        output: z.object({}),
        task: true,
        errors: [
          {
            reason: 'queue_full',
            code: JsonRpcErrorCode.RateLimited,
            when: 'Queue full.',
            recovery: 'Wait a few seconds before retrying.',
          },
        ],
        handler: async () => ({}),
      });

      const registry = new ToolRegistry([taskContractTool], services);
      await registry.registerAll(mockServer);

      const call = mockServer.experimental.tasks.registerToolTask.mock.calls[0];
      expect(call[1]._meta).toBeUndefined();
    });
  });

  describe('Complex Tools', () => {
    it('should handle tool with complex nested schemas', async () => {
      const complexTool = tool('complex_tool', {
        description: 'Complex tool with nested schemas',
        input: z.object({
          user: z
            .object({
              name: z.string().describe('name'),
              email: z.email().describe('email'),
            })
            .describe('user'),
          settings: z
            .object({
              theme: z.enum(['light', 'dark']).describe('theme'),
              notifications: z.boolean().describe('notifications'),
            })
            .describe('settings'),
        }),
        output: z.object({
          success: z.boolean().describe('success'),
          message: z.string().describe('message'),
        }),
        handler: (input) => ({
          success: true,
          message: `Processed settings for ${input.user.name}`,
        }),
      });

      const registry = new ToolRegistry([complexTool], services);
      await registry.registerAll(mockServer);

      expect(mockServer.registerTool).toHaveBeenCalledTimes(1);
      const call = mockServer.registerTool.mock.calls[0];
      expect(call[1].inputSchema.shape.user).toBeDefined();
      expect(call[1].inputSchema.shape.settings).toBeDefined();
    });
  });
});

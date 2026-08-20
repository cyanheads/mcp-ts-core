/**
 * @fileoverview Tests for prompt registration system.
 * @module tests/mcp-server/prompts/prompt-registration.test
 */

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { completable, isCompletable, McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { PromptRegistry } from '@/mcp-server/prompts/prompt-registration.js';
import { prompt } from '@/mcp-server/prompts/utils/promptDefinition.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';

const testPrompt = prompt('test_prompt', {
  description: 'A test prompt for unit tests.',
  args: z.object({
    topic: z.string().optional().describe('Topic to discuss.'),
  }),
  generate: (args) => [
    {
      role: 'user' as const,
      content: {
        type: 'text' as const,
        text: `Discuss: ${args.topic ?? 'anything'}`,
      },
    },
  ],
});

const noArgsPrompt = prompt('no_args_prompt', {
  description: 'A prompt with no arguments.',
  generate: () => [
    {
      role: 'user' as const,
      content: { type: 'text' as const, text: 'Hello, world!' },
    },
  ],
});

const testDefinitions = [testPrompt, noArgsPrompt];

describe('PromptRegistry', () => {
  let mockServer: any;
  let registry: PromptRegistry;

  beforeEach(() => {
    // v2 installs `prompts/list` / `prompts/get` from the declared `prompts`
    // capability, so registration only ever calls `registerPrompt`.
    mockServer = {
      registerPrompt: vi.fn(() => {}),
    };
    registry = new PromptRegistry(testDefinitions, logger);
  });

  describe('Prompt Registration', () => {
    it('should have registerAll method', () => {
      expect(typeof registry.registerAll).toBe('function');
    });

    it('should call server.registerPrompt for each prompt', async () => {
      await registry.registerAll(mockServer);
      expect(mockServer.registerPrompt).toHaveBeenCalledTimes(2);
    });

    it('should register prompts with correct structure', async () => {
      await registry.registerAll(mockServer);

      const firstCall = mockServer.registerPrompt.mock.calls[0];
      expect(typeof firstCall[0]).toBe('string');
      expect(typeof firstCall[1]).toBe('object');
      expect(firstCall[1]).toHaveProperty('description');
      expect(typeof firstCall[2]).toBe('function');
    });

    it('should pass prompt options correctly', async () => {
      await registry.registerAll(mockServer);

      for (const call of mockServer.registerPrompt.mock.calls) {
        const options = call[1];
        expect(options.description).toBeDefined();
        expect(typeof options.description).toBe('string');
      }
    });

    it('should create async handler function', async () => {
      await registry.registerAll(mockServer);

      const handler = mockServer.registerPrompt.mock.calls[0][2];
      const result = handler({});
      expect(result).toBeInstanceOf(Promise);

      const resolved = await result;
      expect(resolved).toHaveProperty('messages');
      expect(Array.isArray(resolved.messages)).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should not throw when registering with valid server', async () => {
      await expect(registry.registerAll(mockServer)).resolves.toBeUndefined();
    });

    it('should handle empty prompts list', async () => {
      const emptyRegistry = new PromptRegistry([], logger);
      await expect(emptyRegistry.registerAll(mockServer)).resolves.toBeUndefined();
    });

    it('should reject duplicate prompt names during registration', async () => {
      const duplicateRegistry = new PromptRegistry([testPrompt, testPrompt], logger);

      await expect(duplicateRegistry.registerAll(mockServer)).rejects.toThrow(
        "Duplicate prompt name 'test_prompt'",
      );
    });

    it('should wrap prompt generation failures as McpError instances', async () => {
      const failingPrompt = prompt('failing_prompt', {
        description: 'A prompt that throws during generation.',
        generate: () => {
          throw new Error('boom');
        },
      });
      const failingRegistry = new PromptRegistry([failingPrompt], logger);

      await failingRegistry.registerAll(mockServer);

      const handler = mockServer.registerPrompt.mock.calls[0][2] as (
        args: Record<string, unknown>,
      ) => Promise<unknown>;

      await expect(handler({})).rejects.toBeInstanceOf(McpError);
      await expect(handler({})).rejects.toMatchObject({
        code: JsonRpcErrorCode.InternalError,
        message: 'boom',
      });
    });
  });

  describe('Registration Order', () => {
    it('should maintain consistent registration order', async () => {
      await registry.registerAll(mockServer);
      const firstRun = mockServer.registerPrompt.mock.calls.map((call: any[]) => call[0]);

      mockServer.registerPrompt.mockClear();
      // Create a fresh registry — duplicate name detection prevents re-registration on the same instance
      const freshRegistry = new PromptRegistry(testDefinitions, logger);
      await freshRegistry.registerAll(mockServer);
      const secondRun = mockServer.registerPrompt.mock.calls.map((call: any[]) => call[0]);

      expect(firstRun).toEqual(secondRun);
    });
  });

  describe('Prompt Handler Execution', () => {
    it('should execute handlers and return messages', async () => {
      await registry.registerAll(mockServer);

      const handler = mockServer.registerPrompt.mock.calls[0][2];
      const result = await handler({});

      expect(result).toBeDefined();
      expect(result.messages).toBeDefined();
      expect(Array.isArray(result.messages)).toBe(true);
    });

    it('should pass arguments to prompt generator', async () => {
      await registry.registerAll(mockServer);

      const handler = mockServer.registerPrompt.mock.calls[0][2];
      const result = await handler({ topic: 'testing' });

      expect(result.messages).toBeDefined();
      expect(Array.isArray(result.messages)).toBe(true);
    });
  });

  describe('Prompt Metadata', () => {
    it('should register prompts with descriptions', async () => {
      await registry.registerAll(mockServer);

      mockServer.registerPrompt.mock.calls.forEach((call: any[]) => {
        const metadata = call[1];
        expect(metadata.description).toBeDefined();
        expect(metadata.description.length).toBeGreaterThan(0);
      });
    });

    it('forwards title to registerPrompt config when provided', async () => {
      const titledPrompt = prompt('titled_prompt', {
        description: 'A titled prompt.',
        title: 'My Titled Prompt',
        generate: () => [{ role: 'user' as const, content: { type: 'text' as const, text: 'Hi' } }],
      });
      const titledRegistry = new PromptRegistry([titledPrompt], logger);
      await titledRegistry.registerAll(mockServer);

      const call = mockServer.registerPrompt.mock.calls[0];
      expect(call[1].title).toBe('My Titled Prompt');
    });

    it('omits title from registerPrompt config when not provided', async () => {
      await registry.registerAll(mockServer);

      // testPrompt has no title — key should be absent (not undefined)
      const call = mockServer.registerPrompt.mock.calls[0];
      expect(call[1]).not.toHaveProperty('title');
    });

    it('forwards completable args shape to registerPrompt argsSchema', async () => {
      const argsWithCompletion = z.object({
        language: completable(z.string().describe('Programming language'), async (partial) =>
          ['typescript', 'python', 'rust'].filter((l) => l.startsWith(partial)),
        ),
      });
      const completablePrompt = prompt('completable_prompt', {
        description: 'Prompt with completable args.',
        args: argsWithCompletion,
        generate: (args) => [
          { role: 'user' as const, content: { type: 'text' as const, text: args.language } },
        ],
      });

      const completableRegistry = new PromptRegistry([completablePrompt], logger);
      await completableRegistry.registerAll(mockServer);

      const call = mockServer.registerPrompt.mock.calls[0];
      // argsSchema is the ZodObject itself, not its `.shape` — the raw-shape
      // overload rebuilds a fresh non-strict object and loses object-level
      // refinements, and requiredness is derived from the emitted JSON Schema (#258).
      expect(call[1].argsSchema).toBe(argsWithCompletion);
      // The completable wrapper is preserved on the object's field
      expect(isCompletable(call[1].argsSchema.shape.language)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Advertised argument requiredness (#258)
// ---------------------------------------------------------------------------

describe('advertised prompt arguments (#258)', () => {
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

  it('advertises a .default()ed argument as optional and a bare one as required', async () => {
    const defaultedPrompt = prompt('defaulted_prompt', {
      description: 'A prompt with one required and one defaulted argument.',
      args: z.object({
        topic: z.string().describe('Topic to discuss.'),
        tone: z.string().default('neutral').describe('Tone to use.'),
      }),
      generate: (args) => [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: `${args.topic} (${args.tone})` },
        },
      ],
    });

    const server = new McpServer(
      { name: 'prompt-args-test', version: '0.0.0' },
      { capabilities: { prompts: { listChanged: true } } },
    );
    await new PromptRegistry([defaultedPrompt], logger).registerAll(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'prompt-args-client', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    const { prompts } = await client.listPrompts();
    const advertised = prompts.find((p) => p.name === 'defaulted_prompt');

    expect(advertised?.arguments).toEqual([
      { name: 'topic', description: 'Topic to discuss.', required: true },
      { name: 'tone', description: 'Tone to use.', required: false },
    ]);
  });
});

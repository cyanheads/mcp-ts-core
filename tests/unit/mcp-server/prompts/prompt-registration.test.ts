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
    it('should call server.registerPrompt for each prompt', async () => {
      await registry.registerAll(mockServer);
      expect(mockServer.registerPrompt).toHaveBeenCalledTimes(2);
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
    it('should reject duplicate prompt names during registration', async () => {
      const duplicateRegistry = new PromptRegistry([testPrompt, testPrompt], logger);

      await expect(duplicateRegistry.registerAll(mockServer)).rejects.toThrow(
        "Duplicate prompt name 'test_prompt'",
      );
    });
  });

  describe('generate() failures on the wire (#519)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** Registers one prompt and returns its `prompts/get` callback. */
    const callbackFor = async (generate: () => never) => {
      const failing = prompt('failing_prompt', { description: 'Throws.', generate });
      await new PromptRegistry([failing], logger).registerAll(mockServer);
      return mockServer.registerPrompt.mock.calls[0][2] as (
        args: Record<string, unknown>,
      ) => Promise<unknown>;
    };

    it.each([
      ['a plain Error', () => new Error('upstream lookup failed'), undefined],
      [
        'an Error with a cause',
        () => new Error('upstream lookup failed', { cause: new Error('socket hang up') }),
        2,
      ],
    ])('answers %s with the code and message only', async (_label, make, chainLength) => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const thrown = make();
      const handler = await callbackFor(() => {
        throw thrown;
      });

      const rejection = (await handler({}).catch((e: unknown) => e)) as McpError;

      expect(rejection).toBeInstanceOf(McpError);
      expect(rejection.code).toBe(JsonRpcErrorCode.InternalError);
      expect(rejection.message).toBe('upstream lookup failed');
      expect(rejection.data).toBeUndefined();

      // The stack and cause chain still reach the server log.
      const logged = errorSpy.mock.calls.findLast(([msg]) =>
        String(msg).startsWith('Error in prompt:failing_prompt'),
      )?.[1] as Record<string, any> | undefined;
      expect(logged?.extra.errorData.originalStack).toBe(thrown.stack);
      expect(logged?.extra.errorData.causeChain?.length).toBe(chainLength);
    });

    it('answers a thrown McpError with its code, message, and exactly its own data', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      const handler = await callbackFor(() => {
        throw new McpError(JsonRpcErrorCode.NotFound, 'no such topic', { topic: 'x' });
      });

      const rejection = (await handler({}).catch((e: unknown) => e)) as McpError;

      expect(rejection.code).toBe(JsonRpcErrorCode.NotFound);
      expect(rejection.message).toBe('no such topic');
      expect(rejection.data).toEqual({ topic: 'x' });
    });
  });

  describe('Registration Order', () => {
    it('should register prompts in definition order', async () => {
      await registry.registerAll(mockServer);

      expect(mockServer.registerPrompt.mock.calls.map((call: any[]) => call[0])).toEqual([
        'test_prompt',
        'no_args_prompt',
      ]);
    });
  });

  describe('Prompt Handler Execution', () => {
    it('should pass arguments to prompt generator', async () => {
      await registry.registerAll(mockServer);

      const handler = mockServer.registerPrompt.mock.calls[0][2];
      const result = await handler({ topic: 'testing' });

      expect(result.messages[0].content.text).toBe('Discuss: testing');
    });
  });

  describe('Prompt Metadata', () => {
    it('should register prompts with their exact descriptions', async () => {
      await registry.registerAll(mockServer);

      expect(
        mockServer.registerPrompt.mock.calls.map((call: any[]) => [call[0], call[1].description]),
      ).toEqual([
        ['test_prompt', 'A test prompt for unit tests.'],
        ['no_args_prompt', 'A prompt with no arguments.'],
      ]);
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

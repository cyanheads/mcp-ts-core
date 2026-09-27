/**
 * @fileoverview Tests for prompt registration system.
 * @module tests/mcp-server/prompts/prompt-registration.test
 */

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import {
  completable,
  inputRequired,
  isCompletable,
  McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createRequestStateSealer, InputRequiredSignal } from '@/mcp-server/inputRequired.js';
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

    /**
     * Registers one argless prompt and returns its `prompts/get` callback, which
     * the SDK calls with its `ServerContext` alone.
     */
    const callbackFor = async (generate: () => never) => {
      const failing = prompt('failing_prompt', { description: 'Throws.', generate });
      await new PromptRegistry([failing], logger).registerAll(mockServer);
      return mockServer.registerPrompt.mock.calls[0][2] as (ctx: unknown) => Promise<unknown>;
    };

    /** The `requestId` of the call's `Error in prompt:` record. */
    const loggedRequestId = (errorSpy: { mock: { calls: unknown[][] } }) =>
      (
        errorSpy.mock.calls.findLast(([msg]) =>
          String(msg).startsWith('Error in prompt:failing_prompt'),
        )?.[1] as { requestId?: string } | undefined
      )?.requestId;

    it.each([
      ['a plain Error', () => new Error('upstream lookup failed'), undefined],
      [
        'an Error with a cause',
        () => new Error('upstream lookup failed', { cause: new Error('socket hang up') }),
        2,
      ],
    ])(
      'answers %s with the code, message, and request id only',
      async (_label, make, chainLength) => {
        const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
        const thrown = make();
        const handler = await callbackFor(() => {
          throw thrown;
        });

        const rejection = (await handler({}).catch((e: unknown) => e)) as McpError;

        expect(rejection).toBeInstanceOf(McpError);
        expect(rejection.code).toBe(JsonRpcErrorCode.InternalError);
        expect(rejection.message).toBe('upstream lookup failed');
        expect(rejection.data).toEqual({ requestId: loggedRequestId(errorSpy) });

        // The stack and cause chain still reach the server log.
        const logged = errorSpy.mock.calls.findLast(([msg]) =>
          String(msg).startsWith('Error in prompt:failing_prompt'),
        )?.[1] as Record<string, any> | undefined;
        expect(logged?.extra.errorData.originalStack).toBe(thrown.stack);
        expect(logged?.extra.errorData.causeChain?.length).toBe(chainLength);
      },
    );

    it('answers a thrown McpError with its code, message, own data, and request id', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const handler = await callbackFor(() => {
        throw new McpError(JsonRpcErrorCode.NotFound, 'no such topic', {
          topic: 'x',
          requestId: 'upstream-7',
        });
      });

      const rejection = (await handler({}).catch((e: unknown) => e)) as McpError;

      expect(rejection.code).toBe(JsonRpcErrorCode.NotFound);
      expect(rejection.message).toBe('no such topic');
      // The call's own id replaces a thrown one (#576).
      expect(rejection.data).toEqual({ topic: 'x', requestId: loggedRequestId(errorSpy) });
      expect(rejection.data?.requestId).not.toBe('upstream-7');
    });
  });

  describe('per-call request context (#576)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** Registers one failing args prompt and calls it under `serverContext`. */
    const failUnder = async (serverContext: unknown) => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const failing = prompt('failing_args_prompt', {
        description: 'Throws.',
        args: z.object({ topic: z.string().optional().describe('Topic.') }),
        generate: () => {
          throw new Error('nope');
        },
      });
      await new PromptRegistry([failing], logger).registerAll(mockServer);
      const handler = mockServer.registerPrompt.mock.calls[0][2] as (
        args: unknown,
        ctx: unknown,
      ) => Promise<unknown>;
      const rejection = (await handler({}, serverContext).catch((e: unknown) => e)) as McpError;
      const logged = errorSpy.mock.calls.findLast(([msg]) =>
        String(msg).startsWith('Error in prompt:failing_args_prompt'),
      )?.[1] as { requestId?: string; sessionId?: string } | undefined;
      return { logged, rejection };
    };

    it("logs and answers under the client's string request id and the session", async () => {
      const { logged, rejection } = await failUnder({
        mcpReq: { id: 'client-7' },
        sessionId: 'session-1',
      });

      expect(logged?.requestId).toBe('client-7');
      expect(logged?.sessionId).toBe('session-1');
      expect(rejection.data).toEqual({ requestId: 'client-7' });
    });

    it('generates a request id when the client sent a numeric one', async () => {
      const { logged, rejection } = await failUnder({ mcpReq: { id: 7 } });

      expect(logged?.requestId).toEqual(expect.any(String));
      expect(logged?.requestId).not.toBe('7');
      expect(rejection.data).toEqual({ requestId: logged?.requestId });
    });
  });

  describe('input_required from generate()', () => {
    const asking = prompt('asking_prompt', {
      description: 'Asks for more before generating.',
      args: z.object({ topic: z.string().optional().describe('Topic.') }),
      generate: () => {
        throw new InputRequiredSignal(
          inputRequired({
            inputRequests: { roots: inputRequired.listRoots() },
            requestState: 'r1',
          }),
        );
      },
    });

    const callbackUnder = async (registered: PromptRegistry) => {
      await registered.registerAll(mockServer);
      return mockServer.registerPrompt.mock.calls[0][2] as (
        args: unknown,
        ctx: unknown,
      ) => Promise<Record<string, unknown>>;
    };

    it('returns the input_required result untouched when no key is configured', async () => {
      const handler = await callbackUnder(new PromptRegistry([asking], logger));

      await expect(handler({}, { mcpReq: { id: 'p-1' } })).resolves.toEqual({
        resultType: 'input_required',
        inputRequests: { roots: { method: 'roots/list' } },
        requestState: 'r1',
      });
    });

    it('seals the requestState when a key is configured', async () => {
      const sealer = createRequestStateSealer('k'.repeat(32));
      const handler = await callbackUnder(new PromptRegistry([asking], logger, sealer));
      const serverContext = { mcpReq: { id: 'p-1' } } as unknown as ServerContext;

      const result = await handler({}, serverContext);

      expect(result.inputRequests).toEqual({ roots: { method: 'roots/list' } });
      expect(result.requestState).toMatch(/^v1\./);
      await expect(sealer?.verify(result.requestState as string, serverContext)).resolves.toBe(
        'r1',
      );
    });

    it('fails the call as a classified InternalError, logged once, when sealing fails', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      // The real codec's mint() rejects when there is no request to bind the state to.
      const handler = await callbackUnder(
        new PromptRegistry([asking], logger, createRequestStateSealer('k'.repeat(32))),
      );

      const rejection = (await handler({}, undefined).catch((e: unknown) => e)) as McpError;

      const records = errorSpy.mock.calls.filter(([msg]) =>
        String(msg).startsWith('Error in prompt:asking_prompt'),
      );
      expect(rejection).toBeInstanceOf(McpError);
      expect(rejection.code).toBe(JsonRpcErrorCode.InternalError);
      expect(rejection.data).toEqual({ requestId: expect.any(String) });
      expect(JSON.stringify({ message: rejection.message, data: rejection.data })).not.toContain(
        'k'.repeat(32),
      );
      expect(records).toHaveLength(1);
      errorSpy.mockRestore();
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
// prompts/get through the real SDK dispatch (#576, #581, #582)
// ---------------------------------------------------------------------------

describe('prompts/get through the SDK dispatch', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanups.length) {
      try {
        await cleanups.pop()?.();
      } catch {
        // Pair may already be closed.
      }
    }
  });

  /** An argless prompt that reports what `generate` received as its `args`. */
  const reportsArgs = prompt('reports_args', {
    description: 'Reports what it received as args.',
    generate: (args) => [
      {
        role: 'user' as const,
        content: { type: 'text' as const, text: `args: ${JSON.stringify(args)}` },
      },
    ],
  });

  /** A prompt with arguments that always fails. */
  const failing = prompt('always_fails', {
    description: 'Always fails.',
    args: z.object({ topic: z.string().describe('Topic.') }),
    generate: (args) => {
      throw new McpError(JsonRpcErrorCode.NotFound, `No template for ${args.topic}`, {
        reason: 'no_template',
      });
    },
  });

  async function connect(defs: ConstructorParameters<typeof PromptRegistry>[0]) {
    const server = new McpServer(
      { name: 'prompt-dispatch-test', version: '0.0.0' },
      { capabilities: { prompts: { listChanged: true } } },
    );
    await new PromptRegistry(defs, logger).registerAll(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'prompt-dispatch-client', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }

  /** The `[message, context]` log calls a spied level received, filtered by message. */
  function records(spy: { mock: { calls: unknown[][] } }, pattern: RegExp) {
    return spy.mock.calls
      .filter(([message]) => pattern.test(String(message)))
      .map(([message, context]) => [String(message), context as Record<string, any>] as const);
  }

  it('hands an argless prompt {} as its args and measures 0 input bytes (#581)', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    const client = await connect([reportsArgs]);

    const result = await client.getPrompt({ name: 'reports_args' });

    expect(result.messages).toEqual([
      { role: 'user', content: { type: 'text', text: 'args: {}' } },
    ]);
    const [finished] = records(infoSpy, /^Prompt generation finished\.$/);
    expect(finished?.[1].extra.metrics).toMatchObject({ isSuccess: true, inputBytes: 0 });
  });

  it('still hands a prompt with args its parsed arguments', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    const client = await connect([testPrompt]);

    const result = await client.getPrompt({ name: 'test_prompt', arguments: { topic: 'x' } });

    expect(result.messages[0]?.content).toEqual({ type: 'text', text: 'Discuss: x' });
    const [finished] = records(infoSpy, /^Prompt generation finished\.$/);
    expect(finished?.[1].extra.metrics.inputBytes).toBe(JSON.stringify({ topic: 'x' }).length);
  });

  it('logs one error record and one info completion record per failed call (#582)', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const infoSpy = vi.spyOn(logger, 'info');
    const client = await connect([failing]);

    await client.getPrompt({ name: 'always_fails', arguments: { topic: 'a' } }).catch(() => {});

    expect(errorSpy.mock.calls.map(([message]) => String(message))).toEqual([
      'Error in prompt:always_fails: No template for a',
    ]);
    const [finished] = records(infoSpy, /^Prompt generation (finished|failed)\.$/);
    expect(finished?.[0]).toBe('Prompt generation finished.');
    expect(finished?.[1].extra.metrics).toMatchObject({
      isSuccess: false,
      errorCode: String(JsonRpcErrorCode.NotFound),
    });
  });

  it('gives each failed call its own request id, on the wire and in its records (#576, #582)', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const infoSpy = vi.spyOn(logger, 'info');
    const client = await connect([failing]);

    const rejections = [];
    for (const topic of ['a', 'b']) {
      rejections.push(
        (await client
          .getPrompt({ name: 'always_fails', arguments: { topic } })
          .then(() => expect.unreachable('expected prompts/get to reject'))
          .catch((error: unknown) => error)) as { data?: Record<string, unknown> },
      );
    }

    const errorRecords = records(errorSpy, /^Error in prompt:always_fails:/);
    const finished = records(infoSpy, /^Prompt generation finished\.$/);
    expect(errorRecords).toHaveLength(2);
    const [first, second] = rejections.map((rejection) => rejection.data?.requestId);
    expect(first).toEqual(expect.any(String));
    expect(first).not.toBe(second);
    expect(rejections.map((rejection) => rejection.data)).toEqual([
      { reason: 'no_template', requestId: first },
      { reason: 'no_template', requestId: second },
    ]);
    expect(errorRecords.map(([, context]) => context.requestId)).toEqual([first, second]);
    expect(finished.map(([, context]) => context.requestId)).toEqual([first, second]);
    for (const [, context] of errorRecords) {
      expect(context.operation).not.toBe('PromptRegistry.registerAll');
    }
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

/**
 * @fileoverview An `McpError` whose `data` holds a value the wire cannot carry
 * — a getter or a revoked Proxy that throws on read, a BigInt, a cycle, a
 * `toJSON` that throws — thrown by a tool (directly and through
 * `ErrorHandler.tryCatch`), a resource, and a prompt. The production registries
 * serve them to a real SDK client over an in-memory pair whose server side
 * serializes every message as the stdio transport does, so a response that
 * cannot be serialized is never sent. Every call answers with its error
 * envelope and `requestId`, each field the wire cannot carry written as
 * `'[Unreadable]'`, one that takes more than 1,000,000 JSON values to write (a
 * shared object, written once per reference) as `'[Truncated]'`, and readable
 * data unchanged.
 * @module tests/unit/mcp-server/unserializableErrorData.wire.test
 */

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { type CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PromptRegistry } from '@/mcp-server/prompts/prompt-registration.js';
import { prompt } from '@/mcp-server/prompts/utils/promptDefinition.js';
import { ResourceRegistry } from '@/mcp-server/resources/resource-registration.js';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { ToolRegistry } from '@/mcp-server/tools/tool-registration.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { logger } from '@/utils/internal/logger.js';

/** How long a call may wait for its answer; a response that was never sent fails here. */
const ANSWER_WITHIN = { timeout: 1_500 };

/** The framework-generated request id every envelope carries. */
const REQUEST_ID = expect.stringMatching(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);

/** A Proxy revoked before it is thrown, so every read of it throws. */
function revoked(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/**
 * `data` for each variant, by a slug a resource URI carries as it is: `id`, which every variant
 * keeps, and `bad`, a field the wire cannot carry.
 */
const UNSERIALIZABLE: Record<string, { label: string; data: () => Record<string, unknown> }> = {
  getter: {
    label: 'a getter that throws, one level down',
    data: () => ({
      id: 1,
      bad: {
        get hint(): string {
          throw new Error('hint getter');
        },
      },
    }),
  },
  revoked: { label: 'a revoked Proxy', data: () => ({ id: 1, bad: revoked() }) },
  bigint: { label: 'a BigInt', data: () => ({ id: 1, bad: 10n }) },
  cycle: {
    label: 'a cycle back to the data',
    data: () => {
      const data: Record<string, unknown> = { id: 1 };
      data.bad = data;
      return data;
    },
  },
  tojson: {
    label: 'a toJSON that throws',
    data: () => ({
      id: 1,
      bad: {
        toJSON() {
          throw new Error('toJSON trap');
        },
      },
    }),
  },
  shared: {
    label: 'a shared object written 43 million times',
    data: () => {
      let node: Record<string, unknown> = { leaf: true };
      for (let i = 0; i < 16; i++) node = { a: node, b: node, c: node };
      return { id: 1, bad: node };
    },
  },
};

/** Readable data: a nested value and a `toJSON` one, each written as thrown. */
const readable = () => ({ id: 1, when: new Date(0), nested: { list: [1, 'x', null] } });

/** The error the handlers throw for `variant`. */
function thrown(variant: string): McpError {
  const data = variant === 'readable' ? readable() : UNSERIALIZABLE[variant]?.data();
  if (!data) throw new Error(`unknown variant ${variant}`);
  return new McpError(JsonRpcErrorCode.NotFound, 'gone', data);
}

const throwsData = tool('throws_data', {
  description: 'Throws an McpError carrying the named data.',
  input: z.object({
    variant: z.string().describe('Which data the error carries.'),
    via: z.enum(['handler', 'tryCatch']).describe('Thrown by the handler or through tryCatch.'),
  }),
  output: z.object({ ok: z.boolean().describe('Never returned.') }),
  async handler({ variant, via }) {
    if (via === 'tryCatch') {
      await ErrorHandler.tryCatch(
        () => {
          throw thrown(variant);
        },
        { operation: 'throwsDataService' },
      );
    }
    throw thrown(variant);
  },
});

const throwsDataResource = resource('errdata://{variant}', {
  description: 'Throws an McpError carrying the named data.',
  params: z.object({ variant: z.string().describe('Which data the error carries.') }),
  handler(params) {
    throw thrown(params.variant);
  },
});

const throwsDataPrompt = prompt('throws_data_prompt', {
  description: 'Throws an McpError carrying the named data.',
  args: z.object({ variant: z.string().describe('Which data the error carries.') }),
  generate(args) {
    throw thrown(args.variant);
  },
});

let client: Client;
let server: McpServer;

beforeAll(async () => {
  const services = { logger, storage: new StorageService(new InMemoryProvider()) };
  server = new McpServer(
    { name: 'error-data-wire-test', version: '0.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  await new ToolRegistry([throwsData], services).registerAll(server);
  await new ResourceRegistry([throwsDataResource], services).registerAll(server);
  await new PromptRegistry([throwsDataPrompt], logger).registerAll(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // Serialized as stdio and HTTP serialize it: a message JSON cannot carry fails its own send.
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) =>
    send(JSON.parse(JSON.stringify(message)), options);
  client = new Client({ name: 'error-data-wire-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await server.close();
});

/** The `data` each surface answers with for `variant`, beyond what the surface adds itself. */
function expectedData(variant: string): Record<string, unknown> {
  if (variant === 'readable') {
    return { id: 1, when: '1970-01-01T00:00:00.000Z', nested: { list: [1, 'x', null] } };
  }
  return { id: 1, bad: variant === 'shared' ? '[Truncated]' : '[Unreadable]' };
}

/** What `call` rejects with. */
async function rejection(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (error: unknown) => error,
  );
}

/** Each variant as `[label, slug]`, readable data first. */
const VARIANTS = [
  ['readable data', 'readable'],
  ...Object.entries(UNSERIALIZABLE).map(([slug, { label }]) => [label, slug]),
];

describe('an McpError whose data the wire cannot carry, on every surface', () => {
  it.each(VARIANTS)(
    'a tool handler throwing it answers with its envelope: %s',
    async (_label, variant) => {
      const result = (await client.callTool(
        { name: 'throws_data', arguments: { variant, via: 'handler' } },
        ANSWER_WITHIN,
      )) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message: 'gone',
          data: { ...expectedData(variant), requestId: REQUEST_ID },
        },
      });
      const [text] = result.content as [{ text: string; type: 'text' }];
      expect(text.text).toMatch(/^Error: gone\n\n\(request [A-Z0-9]{5}-[A-Z0-9]{5}\)$/);
    },
  );

  it.each(VARIANTS)(
    'a tool throwing it through tryCatch answers with its envelope: %s',
    async (_label, variant) => {
      const result = (await client.callTool(
        { name: 'throws_data', arguments: { variant, via: 'tryCatch' } },
        ANSWER_WITHIN,
      )) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message: 'gone',
          data: {
            ...expectedData(variant),
            originalErrorName: 'McpError',
            originalMessage: 'gone',
            requestId: REQUEST_ID,
          },
        },
      });
    },
  );

  it.each(VARIANTS)(
    'a resource throwing it answers with a JSON-RPC error: %s',
    async (_label, variant) => {
      const error = await rejection(
        client.readResource({ uri: `errdata://${variant}` }, ANSWER_WITHIN),
      );

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message: expect.stringContaining('gone'),
      });
      expect((error as { data?: unknown }).data).toEqual({
        ...expectedData(variant),
        requestId: REQUEST_ID,
      });
    },
  );

  it.each(VARIANTS)(
    'a prompt throwing it answers with a JSON-RPC error, never leaving the call waiting: %s',
    async (_label, variant) => {
      const error = await rejection(
        client.getPrompt({ name: 'throws_data_prompt', arguments: { variant } }, ANSWER_WITHIN),
      );

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message: expect.stringContaining('gone'),
      });
      expect((error as { data?: unknown }).data).toEqual({
        ...expectedData(variant),
        requestId: REQUEST_ID,
      });
    },
  );
});

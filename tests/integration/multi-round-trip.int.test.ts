/**
 * @fileoverview Integration tests for the multi-round-trip input path
 * (MCP 2026-07-28). Connects a real MCP client to a framework-registered
 * `McpServer` over a linked in-memory transport pair and exercises the full
 * loop: handler → `ctx.requestInput(...)` → `input_required` → the SDK's legacy
 * shim issues `elicitation/create` → client answers → handler re-entry with
 * `ctx.inputs` populated.
 *
 * The pair negotiates a 2025-era connection, so every case here runs through
 * the legacy shim — the arm that has to keep working for existing clients.
 * Handlers are written once and serve both eras.
 * @module tests/integration/multi-round-trip.int.test
 */
import { Client, type ElicitResult } from '@modelcontextprotocol/client';
import { InMemoryTransport, inputRequired, McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ResourceRegistry } from '@/mcp-server/resources/resource-registration.js';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { ToolRegistry } from '@/mcp-server/tools/tool-registration.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { JsonRpcErrorCode, validationError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';

// ---------------------------------------------------------------------------
// Fixtures — registered through the framework's real registration path
// ---------------------------------------------------------------------------

const ColorAnswer = z.object({ color: z.string().min(1).describe('Preferred color') });

const pickColor = tool('pick_color', {
  description: 'Pick a color, asking the caller when it was not supplied.',
  input: z.object({}),
  output: z.object({
    color: z.string().describe('The chosen color.'),
    reentered: z.boolean().describe('Whether this was a re-entry round.'),
  }),
  handler(_input, ctx) {
    const answer = ctx.inputs.accepted('color', ColorAnswer);
    if (!answer) {
      return ctx.requestInput({
        inputRequests: {
          color: inputRequired.elicit({ message: 'Pick a color', requestedSchema: ColorAnswer }),
        },
        requestState: 'awaiting-color',
      });
    }
    return { color: answer.color, reentered: ctx.inputs.state() === 'awaiting-color' };
  },
});

const confirmOrGiveUp = tool('confirm_or_give_up', {
  description: 'Fails with a declared error when the caller declines.',
  input: z.object({}),
  output: z.object({ confirmed: z.boolean().describe('Whether the caller confirmed.') }),
  handler(_input, ctx) {
    const view = ctx.inputs.view('confirm');
    if (view.kind === 'elicit' && view.action !== 'accept') {
      throw validationError(`User ${view.action} the confirmation.`, { action: view.action });
    }
    const answer = ctx.inputs.accepted('confirm', z.object({ ok: z.boolean() }));
    if (!answer) {
      return ctx.requestInput({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: 'Apply the write?',
            requestedSchema: z.object({ ok: z.boolean().describe('Confirm the write') }),
          }),
        },
      });
    }
    return { confirmed: answer.ok };
  },
});

/** Counts handler entries so a re-issue loop is observable from the test. */
const strictAnswer = vi.fn();

const strictColor = tool('strict_color', {
  description: 'Re-issues the request when the accepted content fails its schema.',
  input: z.object({}),
  output: z.object({ color: z.string().describe('The chosen color.') }),
  handler(_input, ctx) {
    strictAnswer(ctx.inputs.responses);
    const answer = ctx.inputs.accepted('color', ColorAnswer);
    if (!answer) {
      return ctx.requestInput({
        inputRequests: {
          color: inputRequired.elicit({ message: 'Pick a color', requestedSchema: ColorAnswer }),
        },
      });
    }
    return { color: answer.color };
  },
});

const gatedDoc = resource('gated://doc', {
  name: 'gated_doc',
  description: 'A document that asks for a passphrase before it is read.',
  output: z.object({ body: z.string().describe('Document body.') }),
  handler(_params, ctx) {
    const answer = ctx.inputs.accepted('passphrase', z.object({ value: z.string() }));
    if (!answer) {
      return ctx.requestInput({
        inputRequests: {
          passphrase: inputRequired.elicit({
            message: 'Passphrase?',
            requestedSchema: z.object({ value: z.string().describe('The passphrase') }),
          }),
        },
      });
    }
    return { body: `unlocked with ${answer.value}` };
  },
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type ElicitHandler = (params: {
  message: string;
  requestedSchema?: Record<string, unknown>;
}) => ElicitResult;

async function connectPair(options: { advertiseElicitation?: boolean; onElicit?: ElicitHandler }) {
  const server = new McpServer(
    { name: 'mrtr-int-test', version: '0.0.0' },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
      },
      inputRequired: { legacyShim: true },
    },
  );
  const services = { logger, storage: new StorageService(new InMemoryProvider()) };
  await new ToolRegistry([pickColor, confirmOrGiveUp, strictColor], services).registerAll(server);
  await new ResourceRegistry([gatedDoc], services).registerAll(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'mrtr-int-client', version: '0.0.0' },
    options.advertiseElicitation === false
      ? undefined
      : { capabilities: { elicitation: { form: {}, url: {} } } },
  );

  const received: { message: string; requestedSchema?: Record<string, unknown> }[] = [];
  const onElicit = options.onElicit;
  if (onElicit) {
    client.setRequestHandler('elicitation/create', (request) => {
      const params = request.params as unknown as {
        message: string;
        requestedSchema?: Record<string, unknown>;
      };
      received.push(params);
      return onElicit(params) as ElicitResult;
    });
  }

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, received, server };
}

describe('Multi-round-trip input integration', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    strictAnswer.mockClear();
    while (cleanups.length) {
      try {
        await cleanups.pop()?.();
      } catch {
        // Pair may already be closed.
      }
    }
  });

  const track = <T extends { client: Client; server: McpServer }>(pair: T): T => {
    cleanups.push(async () => {
      await pair.client.close();
      await pair.server.close();
    });
    return pair;
  };

  it('completes the round trip: input_required → elicitation/create → handler re-entry', async () => {
    const { client, received } = track(
      await connectPair({ onElicit: () => ({ action: 'accept', content: { color: 'teal' } }) }),
    );

    const result = await client.callTool({ name: 'pick_color', arguments: {} });

    expect(result.structuredContent).toMatchObject({ color: 'teal', reentered: true });
    expect(received).toHaveLength(1);
    expect(received[0]?.message).toBe('Pick a color');
  });

  it('sends requestedSchema as plain JSON Schema, never a serialized Zod object', async () => {
    const { client, received } = track(
      await connectPair({ onElicit: () => ({ action: 'accept', content: { color: 'teal' } }) }),
    );

    await client.callTool({ name: 'pick_color', arguments: {} });

    const schema = received[0]?.requestedSchema as {
      properties: Record<string, { description?: string; type?: string }>;
      required: string[];
      type: string;
    };
    expect(schema.type).toBe('object');
    expect(schema.properties.color).toMatchObject({
      type: 'string',
      description: 'Preferred color',
    });
    expect(schema.required).toEqual(['color']);
  });

  it('round-trips requestState verbatim to the re-entered handler', async () => {
    const { client } = track(
      await connectPair({ onElicit: () => ({ action: 'accept', content: { color: 'teal' } }) }),
    );

    // `reentered` is derived from `ctx.inputs.state()`, so it can only be true
    // if the state the first round minted came back on the second.
    const result = await client.callTool({ name: 'pick_color', arguments: {} });
    expect((result.structuredContent as { reentered: boolean }).reentered).toBe(true);
  });

  it('surfaces a declared error when the caller declines', async () => {
    const { client } = track(await connectPair({ onElicit: () => ({ action: 'decline' }) }));

    const result = await client.callTool({ name: 'confirm_or_give_up', arguments: {} });

    expect(result.isError).toBe(true);
    const structured = result.structuredContent as { error?: { code: number; message: string } };
    expect(structured.error?.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(structured.error?.message).toContain('decline');
  });

  it('treats a cancelled prompt the same way as a decline', async () => {
    const { client } = track(await connectPair({ onElicit: () => ({ action: 'cancel' }) }));

    const result = await client.callTool({ name: 'confirm_or_give_up', arguments: {} });

    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error?: { message: string } }).error?.message).toContain(
      'cancel',
    );
  });

  it('re-issues the request when accepted content fails the schema it advertised', async () => {
    // The SDK never re-validates accepted content against `requestedSchema` on
    // either era — `ctx.inputs.accepted(key, schema)` is what closes that gap.
    let call = 0;
    const { client, received } = track(
      await connectPair({
        onElicit: () => {
          call++;
          return call === 1
            ? { action: 'accept', content: { color: 42 as unknown as string } }
            : { action: 'accept', content: { color: 'teal' } };
        },
      }),
    );

    const result = await client.callTool({ name: 'strict_color', arguments: {} });

    expect(result.structuredContent).toMatchObject({ color: 'teal' });
    expect(received).toHaveLength(2);
    expect(strictAnswer).toHaveBeenCalledTimes(3);
  });

  it('honors input_required from a resource handler', async () => {
    const { client, received } = track(
      await connectPair({
        onElicit: () => ({ action: 'accept', content: { value: 'open-sesame' } }),
      }),
    );

    const result = await client.readResource({ uri: 'gated://doc' });

    expect(received).toHaveLength(1);
    expect(received[0]?.message).toBe('Passphrase?');
    expect(result.contents[0]).toMatchObject({
      uri: 'gated://doc',
      text: expect.stringContaining('open-sesame'),
    });
  });

  it('fails the call cleanly when the client cannot fulfil the request', async () => {
    // No elicitation capability and no handler: the shim has nowhere to send
    // the embedded request, so the call fails rather than hanging.
    const { client } = track(await connectPair({ advertiseElicitation: false }));

    const result = await client.callTool({ name: 'pick_color', arguments: {} });

    expect(result.isError).toBe(true);
  });
});

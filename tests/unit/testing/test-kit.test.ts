/**
 * @fileoverview Behavioral coverage for the public HTTP, session, and tool-contract test kit.
 * @module tests/testing/test-kit.test
 */

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { createFetchMock, createMockSession, runToolContract } from '@/testing/index.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';

const installedHarnesses: Array<ReturnType<typeof createFetchMock>> = [];

afterEach(() => {
  for (const harness of installedHarnesses) harness.restore();
  installedHarnesses.length = 0;
});

describe('createFetchMock', () => {
  it('matches exact URL and method routes, clones static responses, and captures requests', async () => {
    const harness = createFetchMock([
      {
        match: 'https://api.example.test/items/42',
        method: 'get',
        respond: Response.json({ id: '42' }),
      },
    ]);

    const first = await harness.fetch('https://api.example.test/items/42');
    const second = await harness.fetch('https://api.example.test/items/42');

    await expect(first.json()).resolves.toEqual({ id: '42' });
    await expect(second.json()).resolves.toEqual({ id: '42' });
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[0]?.request.method).toBe('GET');
    expect(harness.calls[0]?.route.method).toBe('get');
  });

  it('supports regex and predicate routes, once semantics, and dynamic responders', async () => {
    const harness = createFetchMock()
      .route({
        match: /\/items\/\d+$/g,
        once: true,
        respond: new Response('first'),
      })
      .route({
        match: (request) => request.method === 'POST',
        respond: async (request) => Response.json({ body: await request.json() }),
      });

    await expect(
      harness.fetch('https://api.example.test/items/1').then((r) => r.text()),
    ).resolves.toBe('first');
    await expect(harness.fetch('https://api.example.test/items/1')).rejects.toThrow(
      'Unhandled fetch request: GET https://api.example.test/items/1',
    );
    const response = await harness.fetch('https://api.example.test/items', {
      method: 'POST',
      body: JSON.stringify({ name: 'example' }),
    });
    await expect(response.json()).resolves.toEqual({ body: { name: 'example' } });
  });

  it('uses an explicit fallback for unmatched requests', async () => {
    const harness = createFetchMock([], {
      onUnhandled: (request) => new Response(`fallback:${request.method}`),
    });

    await expect(
      harness.fetch('https://api.example.test/miss').then((r) => r.text()),
    ).resolves.toBe('fallback:GET');
    expect(harness.calls).toHaveLength(0);
  });

  it('installs and restores global fetch idempotently and reset clears routes and calls', async () => {
    const originalFetch = globalThis.fetch;
    const harness = createFetchMock([
      { match: 'https://api.example.test/ok', respond: new Response('ok') },
    ]);
    installedHarnesses.push(harness);

    harness.install();
    harness.install();
    expect(globalThis.fetch).toBe(harness.fetch);
    await globalThis.fetch('https://api.example.test/ok');
    expect(harness.calls).toHaveLength(1);

    harness.reset();
    expect(harness.calls).toHaveLength(0);
    await expect(globalThis.fetch('https://api.example.test/ok')).rejects.toThrow(
      'Unhandled fetch request',
    );

    harness.restore();
    harness.restore();
    expect(globalThis.fetch).toBe(originalFetch);
  });
});

describe('createMockSession', () => {
  it('binds a deterministic session ID to a handler context', () => {
    const session = createMockSession();

    expect(session.sessionId).toBe('test-session-id');
    expect(session.ctx.sessionId).toBe('test-session-id');
    expect(session.tenantId).toBeUndefined();
  });

  it('passes context options and tenant identity through', async () => {
    const session = createMockSession({
      requestId: 'session-request',
      sessionId: 'session-42',
      tenantId: 'tenant-a',
    });

    await session.ctx.state.set('key', 'value');
    expect(await session.ctx.state.get('key')).toBe('value');
    expect(session).toMatchObject({ sessionId: 'session-42', tenantId: 'tenant-a' });
    expect(session.ctx.requestId).toBe('session-request');
  });
});

describe('runToolContract', () => {
  it('validates schemas and applies the default content formatter', async () => {
    const definition = tool('contract_default', {
      description: 'Default formatter contract.',
      input: z.object({ value: z.string().describe('Value') }),
      output: z.object({ echoed: z.string().describe('Echoed value') }),
      handler: (input) => ({ echoed: input.value }),
    });

    const result = await runToolContract(definition, { value: 'hello' });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ echoed: 'hello' });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ echoed: 'hello' }, null, 2) },
    ]);
  });

  it('preserves custom formatting, enrichment, and collected media', async () => {
    const definition = tool('contract_rich', {
      description: 'Rich response contract.',
      input: z.object({ value: z.string().describe('Value') }),
      output: z.object({ echoed: z.string().describe('Echoed value') }),
      enrichment: {
        totalCount: z.number().describe('Total values'),
      },
      handler(input, ctx) {
        ctx.content.image('aW1hZ2U=', 'image/png');
        ctx.enrich.total(1);
        return { echoed: input.value };
      },
      format: (output) => [{ type: 'text', text: output.echoed }],
    });

    const result = await runToolContract(definition, { value: 'hello' });

    expect(result.structuredContent).toEqual({ echoed: 'hello', totalCount: 1 });
    expect(result.content).toEqual([
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      { type: 'text', text: 'hello' },
      { type: 'text', text: '\n\n**1 total**' },
    ]);
  });

  it('returns the production error envelope for declared handler failures', async () => {
    const definition = tool('contract_error', {
      description: 'Error contract.',
      errors: [
        {
          reason: 'missing_item',
          code: JsonRpcErrorCode.NotFound,
          when: 'The item is missing.',
          recovery: 'Request a known item identifier and retry.',
        },
      ],
      input: z.object({ id: z.string().describe('Item ID') }),
      output: z.object({ id: z.string().describe('Item ID') }),
      handler(_input, ctx) {
        throw ctx.fail('missing_item');
      },
    });

    const result = await runToolContract(definition, { id: 'missing' });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Error: The item is missing.' }],
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.NotFound,
          message: 'The item is missing.',
          data: { reason: 'missing_item' },
        },
      },
    });
  });

  it('turns output-schema and formatter failures into error envelopes', async () => {
    const badOutput = tool('contract_bad_output', {
      description: 'Invalid output contract.',
      input: z.object({}),
      output: z.object({ ok: z.boolean().describe('Success') }),
      handler: () => ({ ok: 'wrong' }) as never,
    });
    const badFormat = tool('contract_bad_format', {
      description: 'Invalid formatter contract.',
      input: z.object({}),
      output: z.object({ ok: z.boolean().describe('Success') }),
      handler: () => ({ ok: true }),
      format: () => {
        throw 'formatter exploded';
      },
    });

    const schemaResult = await runToolContract(badOutput, {});
    const formatResult = await runToolContract(badFormat, {});

    expect(schemaResult).toMatchObject({ isError: true });
    expect(formatResult).toMatchObject({
      isError: true,
      structuredContent: {
        error: { message: 'Output formatting failed: formatter exploded' },
      },
    });
  });
});

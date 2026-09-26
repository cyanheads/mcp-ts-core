/**
 * @fileoverview Behavioral coverage for the public HTTP, session, and tool-contract test kit.
 * @module tests/testing/test-kit.test
 */

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { createFetchMock, createMockSession, runToolContract } from '@/testing/index.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { fetchWithTimeout } from '@/utils/network/fetchWithTimeout.js';
import { httpErrorFromResponse } from '@/utils/network/httpError.js';

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
    await expect(
      globalThis.fetch('https://api.example.test/ok').then((response) => response.text()),
    ).resolves.toBe('ok');
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

  // Issue #503 — a static route must not serve a tee branch: on Node, a
  // cancelled branch settles only once its sibling is drained, and the
  // registered original never is. Only the Node lane can observe the hang.
  describe('static responses survive a cancelled body (#503)', () => {
    /** Rejects instead of hanging when `promise` never settles. */
    function settles<T>(promise: Promise<T>, label: string): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} never settled`)), 1_000);
      });
      return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
    }

    const url = 'https://api.example.test/e';

    it('resolves body.cancel() on a served response', async () => {
      const harness = createFetchMock([{ match: url, respond: Response.json({ a: 1 }) }]);

      const response = await harness.fetch(url);

      await expect(settles(response.body?.cancel() ?? Promise.resolve(), 'cancel')).resolves.toBe(
        undefined,
      );
    });

    it('settles httpErrorFromResponse past its body limit', async () => {
      const harness = createFetchMock([
        { match: url, respond: new Response('x'.repeat(501), { status: 502 }) },
      ]);

      const response = await harness.fetch(url);
      const error = await settles(
        httpErrorFromResponse(response, { service: 'example' }),
        'httpErrorFromResponse',
      );

      expect(error).toBeInstanceOf(McpError);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });

    it('settles fetchWithTimeout past its error-body scan limit', async () => {
      const harness = createFetchMock([
        { match: url, respond: new Response('x'.repeat(16_385), { status: 404 }) },
      ]);
      installedHarnesses.push(harness);
      harness.install();

      const failure = await settles(
        fetchWithTimeout(url, 5_000, {
          requestId: 'fetch-mock-503',
          timestamp: new Date().toISOString(),
        }).then(
          () => {
            throw new Error('expected fetchWithTimeout to reject');
          },
          (error: unknown) => error,
        ),
        'fetchWithTimeout',
      );

      expect(failure).toBeInstanceOf(McpError);
      expect((failure as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    });

    it('serves identical responses on repeat and concurrent first calls', async () => {
      const routes = [
        {
          match: `${url}/json`,
          respond: Response.json({ id: '42' }, { status: 201, statusText: 'Created' }),
        },
        {
          match: `${url}/text`,
          respond: new Response('plain body', {
            status: 418,
            statusText: 'Teapot',
            headers: { 'x-trace': 'abc' },
          }),
        },
      ];
      const harness = createFetchMock(routes);

      /** Everything a caller can observe about a served response. */
      const snapshot = async (response: Response) => ({
        body: await response.text(),
        headers: [...response.headers.entries()],
        status: response.status,
        statusText: response.statusText,
      });

      for (const path of ['json', 'text']) {
        const [first, second] = await Promise.all([
          harness.fetch(`${url}/${path}`),
          harness.fetch(`${url}/${path}`),
        ]);
        const third = await harness.fetch(`${url}/${path}`);
        const expected = await snapshot(first);

        expect(await snapshot(second)).toEqual(expected);
        expect(await snapshot(third)).toEqual(expected);
      }

      const json = await harness.fetch(`${url}/json`);
      expect(json.headers.get('content-type')).toMatch(/^application\/json/);
      expect(json.status).toBe(201);
      expect(json.statusText).toBe('Created');
      await expect(json.json()).resolves.toEqual({ id: '42' });

      const text = await harness.fetch(`${url}/text`);
      expect(text.headers.get('x-trace')).toBe('abc');
      await expect(text.text()).resolves.toBe('plain body');
    });

    it('still serves null-body and network-error static responses', async () => {
      const harness = createFetchMock([
        { match: `${url}/empty`, respond: new Response(null, { status: 204 }) },
        { match: `${url}/error`, respond: Response.error() },
      ]);

      for (let call = 0; call < 2; call++) {
        const empty = await settles(harness.fetch(`${url}/empty`), 'null-body route');
        expect(empty.status).toBe(204);
        expect(empty.body).toBeNull();

        const failed = await settles(harness.fetch(`${url}/error`), 'error route');
        expect(failed.type).toBe('error');
        expect(failed.status).toBe(0);
      }
    });
  });
});

describe('createMockSession', () => {
  it('binds a deterministic session ID to a handler context', () => {
    const session = createMockSession();

    expect(session.sessionId).toBe('test-session-id');
    expect(session.ctx.sessionId).toBe('test-session-id');
    expect(session.tenantId).toBe('default');
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
      content: [{ type: 'text', text: 'Error: The item is missing.\n\n(reason missing_item)' }],
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

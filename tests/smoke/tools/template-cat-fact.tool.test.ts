/**
 * @fileoverview Tests for the cat fact tool, with the upstream API mocked.
 * @module tests/smoke/tools/template-cat-fact.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { type FetchMockHarness, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { mcpTest } from '@cyanheads/mcp-ts-core/testing/vitest';
import { describe, expect } from 'vitest';
import { catFactTool } from '../../../examples/mcp-server/tools/definitions/template-cat-fact.tool.js';

const CAT_FACT_ORIGIN = 'https://catfact.ninja';

/** Routes `GET https://catfact.ninja/fact` to a fresh response on every call. */
function routeCatFact(fetchMock: FetchMockHarness, respond: () => Response) {
  fetchMock.route({
    method: 'GET',
    match: (req) => {
      const url = new URL(req.url);
      return url.origin === CAT_FACT_ORIGIN && url.pathname === '/fact';
    },
    respond,
  });
}

/** The `structuredContent.error` envelope of a failed call. */
function errorOf(result: Awaited<ReturnType<typeof runToolContract>>) {
  return (result.structuredContent as { error: { code: number; data?: { reason?: string } } })
    .error;
}

const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

describe('catFactTool', () => {
  mcpTest('returns a fact without echoing a length cap', async ({ fetchMock }) => {
    routeCatFact(fetchMock, () => Response.json({ fact: 'Cats sleep a lot.', length: 17 }));

    const result = await runToolContract(catFactTool, {});

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ fact: 'Cats sleep a lot.', characterCount: 17 });
    expect(new URL(fetchMock.calls[0]!.request.url).searchParams.has('max_length')).toBe(false);
  });

  mcpTest('sends maxLength upstream and echoes it on both surfaces', async ({ fetchMock }) => {
    routeCatFact(fetchMock, () => Response.json({ fact: 'Cats purr.', length: 10 }));

    const result = await runToolContract(catFactTool, { maxLength: 40 });

    expect(result.structuredContent).toMatchObject({
      fact: 'Cats purr.',
      characterCount: 10,
      requestedMaxLength: 40,
    });
    expect(textOf(result)).toContain('**requestedMaxLength:** 40');
    expect(new URL(fetchMock.calls[0]!.request.url).searchParams.get('max_length')).toBe('40');
  });

  mcpTest('reports no_fact_within_length when upstream answers {}', async ({ fetchMock }) => {
    routeCatFact(fetchMock, () => Response.json({}));

    const result = await runToolContract(catFactTool, { maxLength: 5 });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_fact_within_length' },
    });
    expect(textOf(result)).toContain('Recovery:');
  });

  mcpTest(
    'classifies a malformed upstream payload as SerializationError',
    async ({ fetchMock }) => {
      routeCatFact(fetchMock, () => Response.json({ fact: 1 }));

      const result = await runToolContract(catFactTool, {});

      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.SerializationError);
    },
  );

  mcpTest('classifies a non-JSON upstream body as SerializationError', async ({ fetchMock }) => {
    routeCatFact(
      fetchMock,
      () => new Response('<html>maintenance</html>', { headers: { 'content-type': 'text/html' } }),
    );

    const result = await runToolContract(catFactTool, {});

    expect(errorOf(result).code).toBe(JsonRpcErrorCode.SerializationError);
  });

  mcpTest('surfaces an upstream 503 as ServiceUnavailable', async ({ fetchMock }) => {
    routeCatFact(fetchMock, () => new Response('unavailable', { status: 503 }));

    const result = await runToolContract(catFactTool, {});

    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  mcpTest('renders a long fact untruncated', async ({ fetchMock }) => {
    const fact = `Cats ${'really '.repeat(80)}like boxes.`;
    routeCatFact(fetchMock, () => Response.json({ fact, length: fact.length }));

    const result = await runToolContract(catFactTool, {});

    expect(textOf(result)).toContain(fact);
  });
});

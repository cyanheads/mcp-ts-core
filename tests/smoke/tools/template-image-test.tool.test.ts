/**
 * @fileoverview Tests for the image test tool, with the upstream image API mocked.
 * @module tests/smoke/tools/template-image-test.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  type FetchMockHarness,
  getContentBlocks,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { mcpTest } from '@cyanheads/mcp-ts-core/testing/vitest';
import { arrayBufferToBase64 } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect } from 'vitest';
import { imageTestTool } from '../../../examples/mcp-server/tools/definitions/template-image-test.tool.js';

const CAT_ORIGIN = 'https://cataas.com';
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BASE64 = arrayBufferToBase64(PNG_BYTES.buffer);

/** Routes `GET https://cataas.com/cat` to a fresh response on every call. */
function routeCat(fetchMock: FetchMockHarness, respond: () => Response) {
  fetchMock.route({
    method: 'GET',
    match: (req) => {
      const url = new URL(req.url);
      return url.origin === CAT_ORIGIN && url.pathname === '/cat';
    },
    respond,
  });
}

const pngResponse = () =>
  new Response(PNG_BYTES, { headers: { 'content-type': 'image/png; charset=binary' } });

describe('imageTestTool', () => {
  mcpTest(
    'emits the image as a content block, never in structuredContent',
    async ({ fetchMock }) => {
      routeCat(fetchMock, pngResponse);

      const result = await runToolContract(imageTestTool, {});

      expect(result.isError).not.toBe(true);
      expect(result.content[0]).toEqual({ type: 'image', mimeType: 'image/png', data: PNG_BASE64 });
      expect(result.structuredContent).toEqual({
        mimeType: 'image/png',
        sizeInBytes: PNG_BYTES.byteLength,
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain(PNG_BASE64);
    },
  );

  mcpTest('collects the block on a direct handler call', async ({ ctx, fetchMock }) => {
    routeCat(fetchMock, pngResponse);

    await imageTestTool.handler(imageTestTool.input.parse({}), ctx);

    expect(getContentBlocks(ctx)).toEqual([
      { type: 'image', mimeType: 'image/png', data: PNG_BASE64 },
    ]);
  });

  mcpTest('rejects a non-image response as ServiceUnavailable', async ({ fetchMock }) => {
    routeCat(
      fetchMock,
      () => new Response('<html>oops</html>', { headers: { 'content-type': 'text/html' } }),
    );

    const result = await runToolContract(imageTestTool, {});

    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
      JsonRpcErrorCode.ServiceUnavailable,
    );
  });

  mcpTest('rejects an empty image body as ServiceUnavailable', async ({ fetchMock }) => {
    routeCat(
      fetchMock,
      () => new Response(new Uint8Array(), { headers: { 'content-type': 'image/png' } }),
    );

    const result = await runToolContract(imageTestTool, {});

    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
      JsonRpcErrorCode.ServiceUnavailable,
    );
  });
});

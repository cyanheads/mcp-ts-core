/**
 * @fileoverview Template image test tool — demonstrates binary response handling.
 * Fetches a random cat image and emits it through `ctx.content.image`, so the
 * bytes reach `content[]` once while `structuredContent` carries only metadata.
 * @module examples/mcp-server/tools/definitions/template-image-test.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { arrayBufferToBase64, fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';

const CAT_API_URL = 'https://cataas.com/cat';
const API_TIMEOUT_MS = 5000;

const OutputSchema = z.object({
  mimeType: z.string().describe('MIME type of the returned image, e.g. image/jpeg.'),
  sizeInBytes: z.number().int().describe('Size of the image payload in bytes.'),
});

export const imageTestTool = tool('template_image_test', {
  title: 'Random Cat Image',
  description:
    'Fetch a random cat photo and return it as an image content block, with its MIME type and size as structured data.',
  input: z.object({}),
  output: OutputSchema,
  auth: ['tool:template_image_test:read'],
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },

  async handler(_input, ctx) {
    // Non-2xx responses throw a status-mapped McpError inside fetchWithTimeout.
    const response = await fetchWithTimeout(CAT_API_URL, API_TIMEOUT_MS, ctx, {
      signal: ctx.signal,
    });
    const buffer = await response.arrayBuffer();

    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim();
    if (!mimeType?.startsWith('image/')) {
      throw serviceUnavailable('Image API returned a non-image response.', {
        contentType: mimeType ?? null,
        recovery: {
          hint: 'The upstream image service answered with something other than an image. Retry shortly.',
        },
      });
    }
    if (buffer.byteLength === 0) {
      throw serviceUnavailable('Image API returned an empty payload.', {
        recovery: { hint: 'The upstream image service returned no body. Retry the request.' },
      });
    }

    ctx.content.image(arrayBufferToBase64(buffer), mimeType);
    ctx.log.debug('Image fetched', { mimeType, sizeInBytes: buffer.byteLength });

    return { mimeType, sizeInBytes: buffer.byteLength };
  },

  format(result) {
    return [
      {
        type: 'text',
        text: `**MIME type:** ${result.mimeType} | **Size:** ${result.sizeInBytes} bytes`,
      },
    ];
  },
});

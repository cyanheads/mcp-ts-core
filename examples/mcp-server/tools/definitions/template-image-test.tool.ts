/**
 * @fileoverview Template image test tool — demonstrates binary response handling.
 * Fetches a random cat image and returns it base64-encoded with the MIME type.
 * @module examples/mcp-server/tools/definitions/template-image-test.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { arrayBufferToBase64, fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';

const CAT_API_URL = 'https://cataas.com/cat';
const API_TIMEOUT_MS = 5000;

const InputSchema = z.object({
  trigger: z
    .boolean()
    .optional()
    .default(true)
    .describe('Set true to fetch a new image. Exists because some clients require a non-empty input schema.'),
});

const OutputSchema = z.object({
  data: z.string().describe('Base64 encoded image data.'),
  mimeType: z.string().describe("The MIME type of the image (e.g., 'image/jpeg')."),
});

export const imageTestTool = tool('template_image_test', {
  title: 'Random Cat Image',
  description:
    'Fetch a random cat image and return it base64-encoded with its MIME type.',
  input: InputSchema,
  output: OutputSchema,
  auth: ['tool:image_test:read'],
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },

  async handler(input, ctx) {
    ctx.log.debug('Processing template_image_test', { toolInput: input });

    const reqCtx = { requestId: ctx.requestId, timestamp: ctx.timestamp };
    const response = await fetchWithTimeout(CAT_API_URL, API_TIMEOUT_MS, reqCtx, {
      signal: ctx.signal,
    });

    const arrayBuf = await response.arrayBuffer();
    if (arrayBuf.byteLength === 0) {
      throw serviceUnavailable('Image API returned an empty payload.', {
        recovery: { hint: 'The upstream image service returned no body. Retry the request.' },
      });
    }

    const mimeType = response.headers.get('content-type') || 'image/jpeg';

    ctx.log.notice('Image fetched and encoded successfully.', {
      mimeType,
      byteLength: arrayBuf.byteLength,
    });

    return { data: arrayBufferToBase64(arrayBuf), mimeType };
  },

  format(result) {
    return [{ type: 'image', data: result.data, mimeType: result.mimeType }];
  },
});

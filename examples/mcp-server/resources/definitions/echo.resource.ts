/**
 * @fileoverview Echo resource definition using the `resource()` builder.
 * Returns a simple echo of the message from the URI template parameter.
 * @module examples/mcp-server/resources/definitions/echo.resource
 */
import { resource, z } from '@cyanheads/mcp-ts-core';

const ParamsSchema = z.object({
  message: z
    .string()
    .optional()
    .describe(
      'Message to echo back. If omitted, the message is taken from the URI hostname (or path component when the hostname is empty).',
    ),
});

const OutputSchema = z.object({
  message: z.string().describe('The echoed message.'),
  timestamp: z.iso.datetime().describe('ISO 8601 timestamp when the response was generated.'),
  requestUri: z.url().describe('The request URI used to fetch this resource.'),
});

export const echoResourceDefinition = resource('echo://{message}', {
  name: 'echo-resource',
  title: 'Echo Message Resource',
  description: 'Echo the message component of the URI back as JSON with a timestamp.',
  params: ParamsSchema,
  output: OutputSchema,
  mimeType: 'application/json',
  examples: [{ name: 'Basic echo', uri: 'echo://hello' }],
  annotations: { audience: ['user', 'assistant'] },
  auth: ['resource:echo:read'],

  handler(params, ctx) {
    // biome-ignore lint/style/noNonNullAssertion: uri is always present in resource handlers
    const uri = ctx.uri!;
    const messageFromPath = uri.hostname || uri.pathname.replace(/^\/+/, '');
    const messageToEcho = params.message || messageFromPath || 'Default echo message';

    ctx.log.debug('Processing echo resource.', {
      resourceUri: uri.href,
      extractedMessage: messageToEcho,
    });

    return {
      message: messageToEcho,
      timestamp: new Date().toISOString(),
      requestUri: uri.href,
    };
  },

  list: () => ({
    resources: [
      {
        uri: 'echo://hello',
        name: 'Default Echo Message',
        description: 'A simple echo resource example.',
      },
    ],
  }),
});

/**
 * @fileoverview Echo resource definition using the `resource()` builder.
 * Returns the message bound from the URI template parameter, with a timestamp.
 * @module examples/mcp-server/resources/definitions/echo.resource
 */
import { resource, z } from '@cyanheads/mcp-ts-core';

const ParamsSchema = z.object({
  message: z.string().describe('The message to echo back, taken from the URI.'),
});

const OutputSchema = z.object({
  message: z.string().describe('The echoed message.'),
  timestamp: z.iso.datetime().describe('ISO 8601 timestamp when the response was generated.'),
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
  auth: ['resource:echo-resource:read'],

  handler(params) {
    return {
      message: params.message,
      timestamp: new Date().toISOString(),
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

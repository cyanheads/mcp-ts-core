/**
 * @fileoverview Pins the responses a client gets from the shipped template
 * definitions: the echo tool's success (enrichment trailer included), its
 * declared failure and an argument rejection, the echo prompt, and both
 * resource reads. The app view's HTML is left out of the pin; the `_meta.ui`
 * mirrored onto its contents stays in.
 * @module tests/contract/calls.test
 */
import { describe, it } from 'vitest';

import { TEMPLATES } from './fixtures.js';
import { expectPin, openLegacySession, type WireResponse } from './harness.js';

const CALLS: ReadonlyArray<[label: string, method: string, params: Record<string, unknown>]> = [
  [
    'echo tool, success',
    'tools/call',
    { name: 'template_echo_message', arguments: { message: 'hello' } },
  ],
  [
    'echo tool, declared failure',
    'tools/call',
    { name: 'template_echo_message', arguments: { message: '   ' } },
  ],
  ['echo tool, missing argument', 'tools/call', { name: 'template_echo_message', arguments: {} }],
  [
    'echo prompt',
    'prompts/get',
    { name: 'template_echo_message', arguments: { message: 'hello' } },
  ],
  ['echo prompt, missing argument', 'prompts/get', { name: 'template_echo_message' }],
  ['echo resource', 'resources/read', { uri: 'echo://hello' }],
  ['echo app view', 'resources/read', { uri: 'ui://template-echo-app/app.html' }],
];

/** Drops the HTML body of a `text/html` read: cosmetic template edits are not a contract change. */
function withoutHtml(response: WireResponse): WireResponse {
  const contents = response.result?.contents;
  if (!Array.isArray(contents)) return response;
  return {
    result: {
      ...response.result,
      contents: contents.map((content: { mimeType?: string; text?: string }) =>
        content.mimeType?.startsWith('text/html')
          ? { ...content, text: '<html omitted>' }
          : content,
      ),
    },
  };
}

describe('template calls', () => {
  it('pins the response to each call', async () => {
    const session = await openLegacySession(TEMPLATES);
    const responses: Record<string, WireResponse> = {};
    try {
      for (const [label, method, params] of CALLS) {
        responses[label] = withoutHtml(await session.request(method, params));
      }
    } finally {
      await session.close();
    }

    await expectPin('calls.templates.json5', responses);
  });
});

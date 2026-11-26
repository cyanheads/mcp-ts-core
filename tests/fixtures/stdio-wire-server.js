#!/usr/bin/env node
/**
 * @fileoverview Fixture for what reaches stdout. `setup()` writes through
 * `console.log` and `console.info` before any transport exists;
 * `log_and_extract` writes through every console method that prints to stdout
 * outside the stdio transport, around an `htmlExtractor.extract` call with
 * Defuddle's debug log on; `echo_text` returns its text unchanged on both
 * result surfaces; and one `console.log` runs once the transport is up. A
 * black-box test reads stdout for anything that is not a JSON-RPC message and
 * for line separators left raw on the wire.
 * @module tests/fixtures/stdio-wire-server
 */

import { createApp, tool, z } from '@cyanheads/mcp-ts-core';
import { htmlExtractor } from '@cyanheads/mcp-ts-core/utils';

const ARTICLE =
  '<html><head><title>Fixture</title></head><body><article><h1>Fixture</h1><p>Enough words in this paragraph to keep it as the article content.</p></article></body></html>';

/** Resolvers of the calls waiting in {@link rendezvous}. */
const waiting = [];

/** Resolves once `count` calls are waiting, so they are all in flight before any writes. */
function rendezvous(count) {
  return new Promise((resolve) => {
    waiting.push(resolve);
    if (waiting.length >= count) for (const release of waiting.splice(0)) release();
  });
}

/** Writes `label` through each console method that prints to stdout on Bun or Node.js. */
function writeThroughConsole(label) {
  console.log(`console.log ${label}`);
  console.info(`console.info ${label}`);
  console.debug(`console.debug ${label}`);
  console.dir({ dir: label });
  console.dirxml(`console.dirxml ${label}`);
  console.table([{ table: label }]);
  console.trace(`console.trace ${label}`);
  console.count(`console.count ${label}`);
  console.group(`console.group ${label}`);
  console.groupCollapsed(`console.groupCollapsed ${label}`);
  console.groupEnd();
  console.groupEnd();
  console.time(label);
  console.timeLog(label, 'console.timeLog');
  console.timeEnd(label);
  // Bun only.
  console.write?.(`console.write ${label}\n`);
}

await createApp({
  name: 'stdio-wire-fixture',
  version: '0.0.0-test',
  setup() {
    console.log('stdio-wire-fixture: console.log in setup()');
    console.info('stdio-wire-fixture: console.info in setup()');
  },
  tools: [
    tool('log_and_extract', {
      description:
        'Writes through the console, extracts an article with debug on, then writes again.',
      input: z.object({
        label: z.string().describe('Tag carried by every console line the call writes.'),
        peers: z
          .number()
          .int()
          .min(1)
          .describe('How many calls must be in flight before any of them writes.'),
      }),
      output: z.object({
        label: z.string().describe('The label the call was given.'),
        title: z.string().describe('The extracted article title.'),
      }),
      async handler({ label, peers }) {
        await rendezvous(peers);
        writeThroughConsole(`${label} before`);
        const article = await htmlExtractor.extract(ARTICLE, { debug: true });
        writeThroughConsole(`${label} after`);
        return { label, title: article.title ?? '' };
      },
    }),
    tool('echo_text', {
      description: 'Echo text back unchanged.',
      input: z.object({ text: z.string().describe('Text to echo.') }),
      output: z.object({ text: z.string().describe('The text, unchanged.') }),
      handler: ({ text }) => ({ text }),
      format: ({ text }) => [{ type: 'text', text }],
    }),
  ],
});

console.log('stdio-wire-fixture: console.log once the transport is up');

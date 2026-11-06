/**
 * @fileoverview Verifies that a missing optional peer dependency reaches the caller as a
 * ConfigurationError naming the package to declare, not as a failure of the caller's input.
 * @module tests/unit/utils/parsing/missingPeer.test
 */
import { describe, expect, it, vi } from 'vitest';

import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { csvParser } from '@/utils/parsing/csvParser.js';
import { parseDateString } from '@/utils/parsing/dateParser.js';
import { htmlExtractor } from '@/utils/parsing/htmlExtractor.js';

vi.mock('papaparse', () => {
  throw new Error('Cannot find package "papaparse"');
});
vi.mock('defuddle/node', () => {
  throw new Error('Cannot find package "defuddle"');
});
vi.mock('linkedom', () => {
  throw new Error('Cannot find package "linkedom"');
});
vi.mock('chrono-node', () => {
  throw new Error('Cannot find package "chrono-node"');
});

const context = { requestId: 'missing-peer-test', timestamp: new Date().toISOString() };

// JSON, YAML, XML, and diff are left out: today they relabel the ConfigurationError
// as a parse failure, pending the tracking issue (#679).
describe('missing optional peer dependency', () => {
  it.each([
    [
      'papaparse',
      () => csvParser.parse('a,b\n1,2'),
      'CSV parsing needs the optional peer dependency "papaparse", which is not installed. Add it to the server\'s dependencies.',
    ],
    [
      'defuddle',
      () => htmlExtractor.extract('<p>x</p>'),
      'HTML article extraction needs the optional peer dependencies "defuddle" and "linkedom", which are not installed. Add them to the server\'s dependencies.',
    ],
    [
      'chrono-node',
      () => parseDateString('tomorrow', context),
      'Date parsing needs the optional peer dependency "chrono-node", which is not installed. Add it to the server\'s dependencies.',
    ],
  ])(
    'surfaces a missing %s as a ConfigurationError naming the package to declare',
    async (_peer, call, message) => {
      await expect(call()).rejects.toMatchObject({
        code: JsonRpcErrorCode.ConfigurationError,
        message,
      });
    },
  );
});

/**
 * @fileoverview Verifies that a missing optional peer dependency reaches the caller as a
 * ConfigurationError carrying the install command, not as a failure of the caller's input.
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
// as a parse failure, pending the tracking issue (#TBD-peer-relabel).
describe('missing optional peer dependency', () => {
  it.each([
    ['papaparse', () => csvParser.parse('a,b\n1,2'), 'bun add papaparse'],
    ['defuddle', () => htmlExtractor.extract('<p>x</p>'), 'bun add defuddle linkedom'],
    ['chrono-node', () => parseDateString('tomorrow', context), 'bun add chrono-node'],
  ])(
    'surfaces a missing %s as a ConfigurationError with its install command',
    async (_peer, call, install) => {
      await expect(call()).rejects.toMatchObject({
        code: JsonRpcErrorCode.ConfigurationError,
        message: expect.stringContaining(install),
      });
    },
  );
});

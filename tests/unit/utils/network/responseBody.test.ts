/**
 * @fileoverview Unit tests for the bounded response-body reader behind error-body capture.
 * @module tests/utils/network/responseBody.test
 */
import { describe, expect, it } from 'vitest';

import { readBoundedResponseText } from '@/utils/network/responseBody.js';

describe('readBoundedResponseText', () => {
  /**
   * A 500-byte budget keeps 200 bytes of head and 300 of tail. Each body puts a
   * cut inside a 3-byte `€`, so a slice taken at the raw byte offset would decode
   * a split code point to U+FFFD. The capture moves the cut to the nearest
   * character boundary instead, keeping the body bytes under budget.
   */
  it.each([
    [
      'the tail',
      // 1301 bytes; the last 300 start two bytes into a `€`.
      `${'x'.repeat(1000)}${'€'.repeat(100)}z`,
      `${'x'.repeat(200)}…[801 bytes elided]…${'€'.repeat(99)}z`,
    ],
    [
      'the head',
      // 1102 bytes; the first 200 end one byte into a `€`.
      `x${'€'.repeat(67)}${'y'.repeat(900)}`,
      `x${'€'.repeat(66)}…[602 bytes elided]…${'y'.repeat(300)}`,
    ],
  ])(
    'moves a cut that splits a multi-byte character in %s to a character boundary',
    async (_label, body, expected) => {
      const text = await readBoundedResponseText(new Response(body), 500, { scanBytes: 16_384 });

      expect(text).toBe(expected);
      expect(text).not.toContain('\uFFFD');
    },
  );
});

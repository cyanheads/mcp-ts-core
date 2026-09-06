/**
 * @fileoverview Characterizes the flat-enum format-parity gap tracked in #326.
 * @module tests/unit/linter/format-parity-enum.test
 */
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { lintFormatParity } from '@/linter/rules/format-parity-rules.js';

it('currently samples only the first flat enum member (#326)', () => {
  const output = z.object({ mode: z.enum(['summary', 'detail']), detail: z.string() });
  const format = vi.fn((result: z.infer<typeof output>) => [
    {
      type: 'text' as const,
      text: result.mode === 'summary' ? `${result.mode}: ${result.detail}` : result.mode,
    },
  ]);
  // #326 remains open: the detail branch drops a declared field, but flat enums
  // are sampled once. Changing the linter is outside this test-only audit.
  expect(lintFormatParity({ output, format }, 'enum_gap')).toEqual([]);
  expect(format.mock.calls.map(([result]) => result.mode)).toEqual(['summary']);
  expect(format({ mode: 'detail', detail: 'must be visible' })[0]?.text).not.toContain(
    'must be visible',
  );
});

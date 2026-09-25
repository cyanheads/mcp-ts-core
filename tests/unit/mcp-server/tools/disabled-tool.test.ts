/**
 * @fileoverview Unit tests for the `disabledTool()` wrapper and the internal
 * `getDisabledMetadata` accessor used by the registry and manifest builder.
 * @module tests/unit/mcp-server/tools/disabled-tool.test
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { disabledTool, getDisabledMetadata } from '@/mcp-server/tools/utils/disabled-tool.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';

const baseDef = tool('sample', {
  description: 'A sample tool',
  input: z.object({ q: z.string().describe('q') }),
  output: z.object({ r: z.string().describe('r') }),
  handler: (input) => ({ r: input.q.toUpperCase() }),
});

describe('disabledTool()', () => {
  it('attaches disabled metadata accessible via getDisabledMetadata', () => {
    const wrapped = disabledTool(baseDef, {
      reason: 'Writes are turned off in this deployment.',
      hint: 'BRAPI_ENABLE_WRITES=true',
    });

    const meta = getDisabledMetadata(wrapped);
    expect(meta).toEqual({
      reason: 'Writes are turned off in this deployment.',
      hint: 'BRAPI_ENABLE_WRITES=true',
    });
  });

  it('returns undefined for unwrapped tools', () => {
    expect(getDisabledMetadata(baseDef)).toBeUndefined();
  });

  it('preserves the original handler reference', () => {
    const wrapped = disabledTool(baseDef, { reason: 'Some reason here for now.' });
    expect(wrapped.handler).toBe(baseDef.handler);
  });

  it('does not mutate the original definition', () => {
    disabledTool(baseDef, { reason: 'Some reason here for now.' });
    expect(getDisabledMetadata(baseDef)).toBeUndefined();
  });
});

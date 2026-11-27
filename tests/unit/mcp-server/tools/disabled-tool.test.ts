/**
 * @fileoverview Unit tests for the `disabledTool()` wrapper and the internal
 * `getDisabledMetadata` accessor used by the registry and manifest builder,
 * including the non-enumerable strictening record the copy carries over (#688).
 * @module tests/unit/mcp-server/tools/disabled-tool.test
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { disabledTool, getDisabledMetadata } from '@/mcp-server/tools/utils/disabled-tool.js';
import { readStrictenDiscard } from '@/mcp-server/tools/utils/strictenRecord.js';
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

  it('keeps the latest metadata when wrapped twice', () => {
    const once = disabledTool(baseDef, { reason: 'First reason given here.' });
    const twice = disabledTool(once, { reason: 'Second reason given here.' });

    expect(getDisabledMetadata(twice)).toEqual({ reason: 'Second reason given here.' });
    expect(getDisabledMetadata(once)).toEqual({ reason: 'First reason given here.' });
  });
});

describe('disabledTool() and the strictening record (#688)', () => {
  const describedDef = tool('described_root', {
    description: 'A tool whose input root carried a description.',
    input: z.object({ q: z.string().describe('q') }).describe('Root.'),
    output: z.object({ ok: z.boolean().describe('ok') }),
    handler: () => ({ ok: true }),
  });
  const meta = { reason: 'Off in this deployment.' };

  it('carries the record the source definition holds', () => {
    const record = readStrictenDiscard(describedDef);
    expect(record).toEqual([{ keys: ['description'], scope: 'input' }]);

    expect(readStrictenDiscard(disabledTool(describedDef, meta))).toBe(record);
  });

  it('keeps the copied record non-enumerable, leaving keys and JSON as a spread leaves them', () => {
    const wrapped = disabledTool(describedDef, meta);
    const spread = { ...describedDef, __mcpDisabled: meta };
    // The record is the only symbol-keyed property a definition carries.
    const symbols = Object.getOwnPropertySymbols(wrapped);

    expect(symbols).toEqual(Object.getOwnPropertySymbols(describedDef));
    expect(symbols).toHaveLength(1);
    expect(Object.getOwnPropertyDescriptor(wrapped, symbols[0] as symbol)?.enumerable).toBe(false);
    expect(Object.keys(wrapped)).toEqual(Object.keys(spread));
    expect(JSON.stringify(wrapped)).toBe(JSON.stringify(spread));
  });

  it('leaves the source definition unmarked and its record unchanged', () => {
    const before = readStrictenDiscard(describedDef);
    const keysBefore = Reflect.ownKeys(describedDef);

    disabledTool(describedDef, meta);

    expect(getDisabledMetadata(describedDef)).toBeUndefined();
    expect(readStrictenDiscard(describedDef)).toBe(before);
    expect(Reflect.ownKeys(describedDef)).toEqual(keysBefore);
  });

  it('adds no record to a definition that discarded nothing', () => {
    expect(readStrictenDiscard(baseDef)).toBeUndefined();
    expect(readStrictenDiscard(disabledTool(baseDef, meta))).toBeUndefined();
    expect(Object.getOwnPropertySymbols(disabledTool(baseDef, meta))).toHaveLength(0);
  });
});

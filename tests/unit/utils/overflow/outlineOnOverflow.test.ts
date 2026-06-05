/**
 * @fileoverview Unit tests for outline-on-overflow (issue #204).
 * @module tests/utils/overflow/outlineOnOverflow.test
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_OUTLINE_BUDGET_BYTES,
  formatOutline,
  OUTLINE_VARIANT,
  outlineOnOverflow,
  type SectionMeta,
  selectSections,
} from '@/utils/overflow/outlineOnOverflow.js';

describe('outlineOnOverflow', () => {
  it('returns the full document when under budget', () => {
    const doc = { a: 1, b: 'two' };
    const result = outlineOnOverflow(doc, { budget: 1000 });
    expect(result).toEqual({ a: 1, b: 'two', kind: 'full' });
  });

  it('returns an outline when over budget with >= 2 sections', () => {
    const doc = { small: 'x', big: 'y'.repeat(200) };
    const result = outlineOnOverflow(doc, { budget: 50 });
    expect(result.kind).toBe('outline');
    if (result.kind !== 'outline') throw new Error('expected outline');
    expect(result.sections.map((s) => s.name)).toEqual(['big', 'small']); // largest first
    expect(result.sections[0]!.bytes).toBeGreaterThan(result.sections[1]!.bytes);
    expect(result.notice).toContain('sections:[...]');
    expect(result.notice).toContain('big'); // names the largest section
  });

  it('short-circuits to full when over budget but fewer than 2 sections', () => {
    const doc = { only: 'z'.repeat(500) };
    const result = outlineOnOverflow(doc, { budget: 50 });
    expect(result.kind).toBe('full');
    expect(result).toEqual({ only: 'z'.repeat(500), kind: 'full' });
  });

  it('honors the default budget constant when no budget is given', () => {
    const underDefault = outlineOnOverflow({ a: 'x'.repeat(100), b: 'y' });
    expect(underDefault.kind).toBe('full');

    const half = 'x'.repeat(DEFAULT_OUTLINE_BUDGET_BYTES);
    const overDefault = outlineOnOverflow({ a: half, b: half });
    expect(overDefault.kind).toBe('outline');
  });

  it('forces kind:"full" even when the document carries its own kind key', () => {
    const doc = { kind: 'something-else', value: 1 } as Record<string, unknown>;
    const result = outlineOnOverflow(doc, { budget: 1000 });
    expect(result.kind).toBe('full');
  });

  it('uses a custom extractor', () => {
    const extract = (): SectionMeta[] => [
      { name: 'alpha', bytes: 10 },
      { name: 'beta', bytes: 99 },
    ];
    const result = outlineOnOverflow({ raw: 'z'.repeat(500) }, { budget: 50, extract });
    if (result.kind !== 'outline') throw new Error('expected outline');
    expect(result.sections.map((s) => s.name)).toEqual(['beta', 'alpha']); // re-sorted by bytes
  });

  it('uses a custom notice builder', () => {
    const result = outlineOnOverflow(
      { a: 'x'.repeat(200), b: 'y'.repeat(200) },
      { budget: 50, notice: (s) => `pick from ${s.length}` },
    );
    if (result.kind !== 'outline') throw new Error('expected outline');
    expect(result.notice).toBe('pick from 2');
  });
});

describe('selectSections', () => {
  const doc = { a: 1, b: 2, c: 3, id: 'x', set_id: 'y' };

  it('projects only the requested sections', () => {
    expect(selectSections(doc, ['a', 'c'])).toEqual({ a: 1, c: 3 });
  });

  it('retains alwaysKeep metadata regardless of request', () => {
    expect(selectSections(doc, ['a'], { alwaysKeep: ['id', 'set_id'] })).toEqual({
      a: 1,
      id: 'x',
      set_id: 'y',
    });
  });

  it('ignores requested keys that are absent', () => {
    expect(selectSections(doc, ['a', 'missing'])).toEqual({ a: 1 });
  });
});

describe('formatOutline', () => {
  it('renders every section and the notice into one text block (parity twin)', () => {
    const outline = {
      kind: 'outline' as const,
      sections: [
        { name: 'warnings', bytes: 4000 },
        { name: 'dosage', bytes: 120 },
      ],
      notice: 'Re-call with sections:[...].',
    };
    const blocks = formatOutline(outline);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('text');
    const text = blocks[0]!.type === 'text' ? blocks[0]!.text : '';
    expect(text).toContain('warnings');
    expect(text).toContain('4000');
    expect(text).toContain('dosage');
    expect(text).toContain('Re-call with sections:[...].');
  });
});

describe('OUTLINE_VARIANT in a discriminated-union output', () => {
  const FullLabel = z.object({ id: z.string(), body: z.string() });
  const output = z.discriminatedUnion('kind', [
    FullLabel.extend({ kind: z.literal('full') }),
    OUTLINE_VARIANT,
  ]);

  it('validates a full result produced by the helper', () => {
    const result = outlineOnOverflow({ id: 'a', body: 'hello' }, { budget: 1000 });
    expect(() => output.parse(result)).not.toThrow();
  });

  it('validates an outline result produced by the helper', () => {
    const result = outlineOnOverflow({ id: 'a', body: 'z'.repeat(500) }, { budget: 20 });
    expect(() => output.parse(result)).not.toThrow();
  });
});

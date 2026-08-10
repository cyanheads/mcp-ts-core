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
    expect(result.notice).toContain('small'); // names the largest section that fits
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

  it('passes the effective budget to a custom notice builder', () => {
    const explicit = outlineOnOverflow(
      { a: 'x'.repeat(200), b: 'y'.repeat(200) },
      { budget: 50, notice: (_s, budget) => `budget ${budget}` },
    );
    const defaulted = outlineOnOverflow(
      { a: 'x'.repeat(30_000), b: 'y'.repeat(30_000) },
      { notice: (_s, budget) => `budget ${budget}` },
    );

    if (explicit.kind !== 'outline' || defaulted.kind !== 'outline') {
      throw new Error('expected outlines');
    }
    expect(explicit.notice).toBe('budget 50');
    expect(defaulted.notice).toBe(`budget ${DEFAULT_OUTLINE_BUDGET_BYTES}`);
  });
});

describe('the default notice offers a worked example that fits the budget (#328)', () => {
  /**
   * Pulls the section names out of any `sections:["a","b"]` example in the
   * notice. The instructional `sections:[...]` placeholder carries no quoted
   * names, so only a real worked example contributes.
   */
  function exampleSections(notice: string): string[] {
    return [...notice.matchAll(/sections:\[([^\]]*)\]/g)].flatMap((group) =>
      [...(group[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1] as string),
    );
  }

  /**
   * Runs the notice's own worked example down the selection path the tool would
   * take, and returns the serialized size the agent would actually receive.
   */
  function replayExample(doc: Record<string, unknown>, notice: string): number {
    const want = exampleSections(notice);
    expect(want.length).toBeGreaterThan(0);
    return JSON.stringify(selectSections(doc, want)).length;
  }

  it('names the only section that fits, and that example fits when replayed', () => {
    const budget = 2_000;
    const doc = {
      warnings: 'w'.repeat(9_000),
      adverse_reactions: 'a'.repeat(5_000),
      dosage: 'd'.repeat(1_500),
    };
    const result = outlineOnOverflow(doc, { budget });
    if (result.kind !== 'outline') throw new Error('expected outline');

    expect(exampleSections(result.notice)).toEqual(['dosage']);
    expect(result.notice).toContain('1502 bytes'); // the section's own size, inline
    expect(replayExample(doc, result.notice)).toBeLessThanOrEqual(budget);
  });

  it('picks the largest fitting section when several fit', () => {
    const budget = 6_000;
    const doc = {
      warnings: 'w'.repeat(9_000),
      adverse_reactions: 'a'.repeat(5_000),
      dosage: 'd'.repeat(1_500),
      id: 'x',
    };
    const result = outlineOnOverflow(doc, { budget });
    if (result.kind !== 'outline') throw new Error('expected outline');

    expect(exampleSections(result.notice)).toEqual(['adverse_reactions']);
    expect(replayExample(doc, result.notice)).toBeLessThanOrEqual(budget);
    // Never the largest section — the one the outline just refused to inline.
    expect(result.notice).not.toContain('"warnings"');
  });

  it('names no section when nothing fits, and points at narrowing the request', () => {
    const budget = 1_000;
    const doc = { warnings: 'w'.repeat(9_000), adverse_reactions: 'a'.repeat(5_000) };
    const result = outlineOnOverflow(doc, { budget });
    if (result.kind !== 'outline') throw new Error('expected outline');

    expect(exampleSections(result.notice)).toEqual([]);
    expect(result.notice).toContain('no single section fits');
    expect(result.notice).toContain('5002 bytes'); // the smallest section's size
    expect(result.notice).toContain('Narrow the request');
    // The whole point: no name is offered that an agent could replay into an overflow.
    for (const name of Object.keys(doc)) expect(result.notice).not.toContain(`"${name}"`);
  });

  it('handles an outline of exactly two sections', () => {
    const budget = 500;
    const doc = { body: 'b'.repeat(2_000), summary: 's'.repeat(200) };
    const result = outlineOnOverflow(doc, { budget });
    if (result.kind !== 'outline') throw new Error('expected outline');

    expect(exampleSections(result.notice)).toEqual(['summary']);
    expect(replayExample(doc, result.notice)).toBeLessThanOrEqual(budget);
  });

  it('offers the largest metadata key when metadata is all that fits', () => {
    // One fat section plus id-shaped metadata: the metadata keys are the only
    // things under budget, so they are what the example can honestly name.
    const budget = 1_000;
    const doc = { body: 'b'.repeat(9_000), set_id: 'set-abcdef', id: 'x' };
    const result = outlineOnOverflow(doc, { budget });
    if (result.kind !== 'outline') throw new Error('expected outline');

    expect(exampleSections(result.notice)).toEqual(['set_id']);
    expect(replayExample(doc, result.notice)).toBeLessThanOrEqual(budget);
  });

  it('replays within budget against the default budget constant', () => {
    const doc = {
      warnings: 'w'.repeat(DEFAULT_OUTLINE_BUDGET_BYTES * 2),
      dosage: 'd'.repeat(DEFAULT_OUTLINE_BUDGET_BYTES - 5_000),
    };
    const result = outlineOnOverflow(doc);
    if (result.kind !== 'outline') throw new Error('expected outline');

    expect(replayExample(doc, result.notice)).toBeLessThanOrEqual(DEFAULT_OUTLINE_BUDGET_BYTES);
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

describe('outlineOnOverflow results validate against a kind-discriminated union', () => {
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

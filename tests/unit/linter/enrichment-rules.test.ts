/**
 * @fileoverview Tests for the `enrichment` block lint rules: shape validation,
 * the output-key collision guard, and the advisory nudge for meta-looking output
 * fields when no enrichment block is declared.
 * @module tests/unit/linter/enrichment-rules.test
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { lintEnrichmentContract } from '@/linter/rules/enrichment-rules.js';

const output = z.object({ items: z.array(z.string()).describe('items') });

describe('lintEnrichmentContract', () => {
  describe('no enrichment block', () => {
    it('returns no diagnostics for ordinary output', () => {
      expect(lintEnrichmentContract({ output }, 'tool', 'x')).toEqual([]);
    });

    it('advises moving a meta-looking output field into enrichment', () => {
      const withNotice = z.object({
        items: z.array(z.string()).describe('items'),
        notice: z.string().describe('empty-result notice'),
      });
      const d = lintEnrichmentContract({ output: withNotice }, 'tool', 'search');
      expect(d).toHaveLength(1);
      expect(d[0]?.rule).toBe('enrichment-prefer-block');
      expect(d[0]?.severity).toBe('warning');
      expect(d[0]?.message).toContain('notice');
    });

    it('advises on effectiveQuery too', () => {
      const withEcho = z.object({
        items: z.array(z.string()).describe('items'),
        effectiveQuery: z.string().describe('parsed query'),
      });
      const d = lintEnrichmentContract({ output: withEcho }, 'tool', 'search');
      expect(d.map((x) => x.rule)).toContain('enrichment-prefer-block');
    });

    it('does not flag legitimate domain fields like totalCount', () => {
      const withTotal = z.object({
        items: z.array(z.string()).describe('items'),
        totalCount: z.number().describe('total'),
      });
      expect(lintEnrichmentContract({ output: withTotal }, 'tool', 'x')).toEqual([]);
    });
  });

  describe('enrichment block present', () => {
    it('accepts a well-formed, disjoint block', () => {
      const d = lintEnrichmentContract(
        {
          output,
          enrichment: {
            effectiveQuery: z.string().describe('parsed'),
            totalCount: z.number().describe('total'),
            notice: z.string().optional().describe('notice'),
          },
        },
        'tool',
        'search',
      );
      expect(d).toEqual([]);
    });

    it('does not run the advisory when a block is declared', () => {
      // `notice` in output would normally be advised — but a declared block means
      // the author opted in; suppress the nudge.
      const withNotice = z.object({
        items: z.array(z.string()).describe('items'),
        notice: z.string().describe('domain notice'),
      });
      const d = lintEnrichmentContract(
        { output: withNotice, enrichment: { totalCount: z.number().describe('total') } },
        'tool',
        'search',
      );
      expect(d.map((x) => x.rule)).not.toContain('enrichment-prefer-block');
    });

    it('errors when enrichment is not an object', () => {
      const d = lintEnrichmentContract({ output, enrichment: [] }, 'tool', 'x');
      expect(d).toHaveLength(1);
      expect(d[0]?.rule).toBe('enrichment-type');
      expect(d[0]?.severity).toBe('error');
    });

    it('warns on an empty enrichment block', () => {
      const d = lintEnrichmentContract({ output, enrichment: {} }, 'tool', 'x');
      expect(d).toHaveLength(1);
      expect(d[0]?.rule).toBe('enrichment-empty');
      expect(d[0]?.severity).toBe('warning');
    });

    it('errors when a field value is not a Zod schema', () => {
      const d = lintEnrichmentContract(
        { output, enrichment: { totalCount: 'not a schema' } },
        'tool',
        'x',
      );
      expect(d.map((x) => x.rule)).toContain('enrichment-field-type');
      expect(d.find((x) => x.rule === 'enrichment-field-type')?.severity).toBe('error');
    });

    it('errors when an enrichment key collides with an output key', () => {
      const d = lintEnrichmentContract(
        { output, enrichment: { items: z.array(z.string()).describe('dupe') } },
        'tool',
        'search',
      );
      const collision = d.find((x) => x.rule === 'enrichment-output-collision');
      expect(collision).toBeDefined();
      expect(collision?.severity).toBe('error');
      expect(collision?.message).toContain('items');
    });
  });

  describe('enrichmentTrailer + non-scalar render rule', () => {
    it('errors on an object enrichment field with no renderer', () => {
      const d = lintEnrichmentContract(
        { output, enrichment: { appliedFilters: z.object({ a: z.string() }).describe('f') } },
        'tool',
        'search',
      );
      const err = d.find((x) => x.rule === 'enrichment-trailer-render');
      expect(err).toBeDefined();
      expect(err?.severity).toBe('error');
      expect(err?.message).toContain('appliedFilters');
    });

    it('errors on an array enrichment field with no renderer', () => {
      const d = lintEnrichmentContract(
        { output, enrichment: { appliedSources: z.array(z.string()).describe('s') } },
        'tool',
        'search',
      );
      expect(d.map((x) => x.rule)).toContain('enrichment-trailer-render');
    });

    it('accepts a non-scalar field when a render function is supplied', () => {
      const d = lintEnrichmentContract(
        {
          output,
          enrichment: { appliedFilters: z.object({ a: z.string() }).describe('f') },
          enrichmentTrailer: { appliedFilters: { render: (v: unknown) => String(v) } },
        },
        'tool',
        'search',
      );
      expect(d.map((x) => x.rule)).not.toContain('enrichment-trailer-render');
    });

    it('a label without a render does NOT satisfy the non-scalar rule', () => {
      const d = lintEnrichmentContract(
        {
          output,
          enrichment: { appliedFilters: z.object({ a: z.string() }).describe('f') },
          enrichmentTrailer: { appliedFilters: { label: 'Filters' } },
        },
        'tool',
        'search',
      );
      expect(d.map((x) => x.rule)).toContain('enrichment-trailer-render');
    });

    it('does not flag scalar fields', () => {
      const d = lintEnrichmentContract(
        {
          output,
          enrichment: {
            totalFound: z.number().describe('t'),
            effectiveQuery: z.string().describe('q'),
          },
        },
        'tool',
        'search',
      );
      expect(d).toEqual([]);
    });

    it('exempts the delta shape ({ before, after }) — rendered natively by enrich.delta', () => {
      const d = lintEnrichmentContract(
        {
          output,
          enrichment: {
            sizeInBytes: z.object({ before: z.number(), after: z.number() }).describe('size delta'),
          },
        },
        'tool',
        'write',
      );
      expect(d.map((x) => x.rule)).not.toContain('enrichment-trailer-render');
    });

    it('errors when enrichmentTrailer is declared without an enrichment block', () => {
      const d = lintEnrichmentContract(
        { output, enrichmentTrailer: { foo: { label: 'Foo' } } },
        'tool',
        'x',
      );
      const err = d.find((x) => x.rule === 'enrichment-trailer-orphan');
      expect(err?.severity).toBe('error');
    });

    it('errors when enrichmentTrailer references an unknown enrichment field', () => {
      const d = lintEnrichmentContract(
        {
          output,
          enrichment: { totalFound: z.number().describe('t') },
          enrichmentTrailer: { notAField: { label: 'X' } },
        },
        'tool',
        'x',
      );
      const err = d.find((x) => x.rule === 'enrichment-trailer-unknown-field');
      expect(err?.severity).toBe('error');
      expect(err?.message).toContain('notAField');
    });
  });
});

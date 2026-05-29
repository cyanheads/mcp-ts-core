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
});

/**
 * @fileoverview Tests for the `enrichment` block lint rules: shape validation,
 * the output-key collision guard, and the advisory nudge for meta-looking output
 * fields when no enrichment block is declared.
 * @module tests/unit/linter/enrichment-rules.test
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  lintCappedListTruncation,
  lintEnrichmentContract,
} from '@/linter/rules/enrichment-rules.js';

const output = z.object({ items: z.array(z.string()).describe('items') });

// ---------------------------------------------------------------------------
// Helpers for capped-list tests
// ---------------------------------------------------------------------------

function cappedDef(
  overrides: {
    inputExtra?: Record<string, unknown>;
    outputExtra?: Record<string, unknown>;
    enrichment?: Record<string, unknown>;
    name?: string;
  } = {},
) {
  return {
    name: overrides.name ?? 'search_results',
    input: z.object({
      limit: z.number().describe('max items'),
      ...(overrides.inputExtra ?? {}),
    }),
    output: z.object({
      items: z.array(z.string()).describe('items'),
      ...(overrides.outputExtra ?? {}),
    }),
    ...(overrides.enrichment !== undefined ? { enrichment: overrides.enrichment } : {}),
  };
}

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

// ---------------------------------------------------------------------------
// lintCappedListTruncation
// ---------------------------------------------------------------------------

describe('lintCappedListTruncation', () => {
  describe('fires on the silent-cap shape', () => {
    it('warns when input has limit + output has array + no disclosure', () => {
      const d = lintCappedListTruncation(cappedDef());
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({
        rule: 'capped-list-no-truncation',
        severity: 'warning',
        definitionName: 'search_results',
      });
    });

    it('warns for each cap-like field name variant', () => {
      for (const capField of ['limit', 'per_page', 'page_size', 'max_results', 'max_items']) {
        const def = {
          name: 'tool',
          input: z.object({ [capField]: z.number().describe('cap') }),
          output: z.object({ items: z.array(z.string()).describe('items') }),
        };
        const d = lintCappedListTruncation(def);
        expect(d.map((x) => x.rule)).toContain('capped-list-no-truncation');
      }
    });

    it('cap field match is case-insensitive', () => {
      const def = {
        name: 'tool',
        input: z.object({ Limit: z.number().describe('cap') }),
        output: z.object({ items: z.array(z.string()).describe('items') }),
      };
      const d = lintCappedListTruncation(def);
      expect(d).toHaveLength(1);
    });
  });

  describe('silent when disclosure is present', () => {
    it('passes when enrichment has truncated key', () => {
      const d = lintCappedListTruncation(
        cappedDef({ enrichment: { truncated: z.boolean().describe('truncated') } }),
      );
      expect(d).toHaveLength(0);
    });

    it('passes when enrichment has totalCount key (enrich.total() convention)', () => {
      const d = lintCappedListTruncation(
        cappedDef({ enrichment: { totalCount: z.number().describe('total') } }),
      );
      expect(d).toHaveLength(0);
    });

    it('passes when output has truncated key', () => {
      const d = lintCappedListTruncation(
        cappedDef({ outputExtra: { truncated: z.boolean().describe('truncated') } }),
      );
      expect(d).toHaveLength(0);
    });

    it('passes when output has totalCount key', () => {
      const d = lintCappedListTruncation(
        cappedDef({ outputExtra: { totalCount: z.number().describe('total') } }),
      );
      expect(d).toHaveLength(0);
    });
  });

  describe('suppression knobs', () => {
    it('truncationAllowlist by name suppresses the rule', () => {
      const d = lintCappedListTruncation(cappedDef({ name: 'search_results' }), {
        truncationAllowlist: ['search_results'],
      });
      expect(d).toHaveLength(0);
    });

    it('false disables the rule entirely', () => {
      const d = lintCappedListTruncation(cappedDef(), { truncationAllowlist: false });
      expect(d).toHaveLength(0);
    });

    it('allowlist does not suppress other tool names', () => {
      const d = lintCappedListTruncation(cappedDef({ name: 'other_tool' }), {
        truncationAllowlist: ['search_results'],
      });
      expect(d).toHaveLength(1);
    });
  });

  describe('does not fire when shape does not match', () => {
    it('no cap-like input field → silent', () => {
      const def = {
        name: 'plain',
        input: z.object({ query: z.string().describe('q') }),
        output: z.object({ items: z.array(z.string()).describe('items') }),
      };
      expect(lintCappedListTruncation(def)).toHaveLength(0);
    });

    it('cap-like field but no array output → silent', () => {
      const def = {
        name: 'counter',
        input: z.object({ limit: z.number().describe('limit') }),
        output: z.object({ count: z.number().describe('count') }),
      };
      expect(lintCappedListTruncation(def)).toHaveLength(0);
    });
  });
});

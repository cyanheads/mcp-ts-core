/**
 * @fileoverview Tests for the format-parity lint rule.
 * @module tests/unit/linter/format-parity-rules.test
 */

import type { ContentBlock } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { lintFormatParity } from '@/linter/rules/format-parity-rules.js';
import { lintToolDefinition } from '@/linter/rules/tool-rules.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tool(opts: {
  name?: string;
  output: z.ZodObject<z.ZodRawShape>;
  format?: (result: unknown) => ContentBlock[];
}) {
  return {
    name: opts.name ?? 'test_tool',
    description: 'A test tool',
    input: z.object({ q: z.string().describe('q') }),
    output: opts.output,
    handler: async () => ({}),
    format: opts.format,
  };
}

function parityErrors(def: unknown) {
  return lintFormatParity(def, (def as { name: string }).name).filter(
    (d) => d.severity === 'error',
  );
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('lintFormatParity — happy path', () => {
  it('passes when format renders every top-level field', () => {
    const def = tool({
      output: z.object({
        query: z.string().describe('Query'),
        count: z.number().describe('Count'),
      }),
      format: (r) => {
        const result = r as { query: string; count: number };
        return [{ type: 'text', text: `Query: ${result.query}\nCount: ${result.count}` }];
      },
    });
    expect(parityErrors(def)).toHaveLength(0);
  });

  it('passes when format renders every nested field in an array of objects', () => {
    const def = tool({
      output: z.object({
        items: z
          .array(
            z.object({
              id: z.string().describe('ID'),
              title: z.string().describe('Title'),
              active: z.boolean().describe('Active'),
            }),
          )
          .describe('Items'),
      }),
      format: (r) => {
        const result = r as { items: Array<{ id: string; title: string; active: boolean }> };
        const lines = result.items.map(
          (item) => `- ${item.id}: ${item.title} (active=${item.active})`,
        );
        return [{ type: 'text', text: lines.join('\n') }];
      },
    });
    expect(parityErrors(def)).toHaveLength(0);
  });

  it('passes when format renders record values', () => {
    const def = tool({
      output: z.object({
        scores: z.record(z.string(), z.number()).describe('Scores by item ID'),
      }),
      format: (r) => {
        const result = r as { scores: Record<string, number> };
        return [{ type: 'text', text: `Scores: ${Object.values(result.scores).join(', ')}` }];
      },
    });
    expect(parityErrors(def)).toHaveLength(0);
  });

  it('passes when format renders tuple items', () => {
    const def = tool({
      output: z.object({
        bounds: z.tuple([z.string(), z.number()]).describe('Label and count'),
      }),
      format: (r) => {
        const result = r as { bounds: [string, number] };
        return [{ type: 'text', text: `Bounds: ${result.bounds[0]} (${result.bounds[1]})` }];
      },
    });
    expect(parityErrors(def)).toHaveLength(0);
  });

  it('skips when format is absent (default JSON formatter covers everything)', () => {
    const def = tool({
      output: z.object({ x: z.string().describe('x') }),
    });
    expect(parityErrors(def)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Numeric separator normalization (toLocaleString / Intl.NumberFormat)
// ---------------------------------------------------------------------------

describe('lintFormatParity — numeric separator normalization', () => {
  it('passes when numeric field is rendered with en-US toLocaleString (comma)', () => {
    const def = tool({
      output: z.object({ total: z.number().describe('Total') }),
      format: (r) => [
        {
          type: 'text',
          text: `Total: ${(r as { total: number }).total.toLocaleString('en-US')}`,
        },
      ],
    });
    expect(parityErrors(def)).toHaveLength(0);
  });

  it('passes when numeric field is rendered with de-DE toLocaleString (period)', () => {
    const def = tool({
      output: z.object({ total: z.number().describe('Total') }),
      format: (r) => [
        {
          type: 'text',
          text: `Gesamt: ${(r as { total: number }).total.toLocaleString('de-DE')}`,
        },
      ],
    });
    expect(parityErrors(def)).toHaveLength(0);
  });

  it('passes when numeric field is rendered with fr-FR Intl.NumberFormat (narrow no-break space)', () => {
    const fmt = new Intl.NumberFormat('fr-FR');
    const def = tool({
      output: z.object({ total: z.number().describe('Total') }),
      format: (r) => [
        { type: 'text', text: `Total: ${fmt.format((r as { total: number }).total)}` },
      ],
    });
    expect(parityErrors(def)).toHaveLength(0);
  });

  it('still flags compact notation (1.5K) — lossy transform', () => {
    const def = tool({
      output: z.object({ total: z.number().describe('Total') }),
      format: (r) => {
        const t = (r as { total: number }).total;
        // Compact style collapses digits — information is lost, parity should fail
        return [
          {
            type: 'text',
            text: `Total: ${new Intl.NumberFormat('en-US', { notation: 'compact' }).format(t)}`,
          },
        ];
      },
    });
    expect(parityErrors(def).length).toBeGreaterThan(0);
  });

  it('flags divide-by-10 lossy transform (sentinel digits shifted across decimal mark)', () => {
    // Sentinel = 900_000_001. (sentinel / 10).toLocaleString('en-US') → "90,000,000.1".
    // A global strip of `,` and `.` would collapse this to "900000001" and falsely
    // match. Context-aware normalization keeps the decimal mark intact, so parity
    // correctly fails.
    const def = tool({
      output: z.object({ total: z.number().describe('Total') }),
      format: (r) => [
        {
          type: 'text',
          text: `Total: ${((r as { total: number }).total / 10).toLocaleString('en-US')}`,
        },
      ],
    });
    expect(parityErrors(def).length).toBeGreaterThan(0);
  });

  it('flags divide-by-100 lossy transform (cents-style decimal)', () => {
    // Sentinel = 900_000_001. (sentinel / 100).toFixed(2) → "9000000.01".
    // Two digits past the decimal — also a digit shift, must fail parity.
    const def = tool({
      output: z.object({ total: z.number().describe('Total') }),
      format: (r) => [
        {
          type: 'text',
          text: `Total: ${((r as { total: number }).total / 100).toFixed(2)}`,
        },
      ],
    });
    expect(parityErrors(def).length).toBeGreaterThan(0);
  });

  it('still passes when numeric field is rendered as a raw integer', () => {
    const def = tool({
      output: z.object({ total: z.number().describe('Total') }),
      format: (r) => [{ type: 'text', text: `Total: ${(r as { total: number }).total}` }],
    });
    expect(parityErrors(def)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Missing field detection
// ---------------------------------------------------------------------------

describe('lintFormatParity — missing fields', () => {
  it('flags a top-level field that format ignores', () => {
    const def = tool({
      output: z.object({
        query: z.string().describe('Query'),
        totalCount: z.number().describe('Total count'),
      }),
      format: (r) => {
        const result = r as { query: string };
        return [{ type: 'text', text: `Query: ${result.query}` }];
      },
    });
    const errors = parityErrors(def);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("'totalCount'");
  });

  it('flags a nested field deep in an array', () => {
    const def = tool({
      output: z.object({
        items: z
          .array(
            z.object({
              id: z.string().describe('ID'),
              description: z.string().describe('Description'),
            }),
          )
          .describe('Items'),
      }),
      format: (r) => {
        const result = r as { items: Array<{ id: string }> };
        return [
          {
            type: 'text',
            text: `IDs: ${result.items.map((i) => i.id).join(', ')}`,
          },
        ];
      },
    });
    const errors = parityErrors(def);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('items[].description');
  });

  it('flags each missing field separately', () => {
    const def = tool({
      output: z.object({
        a: z.string().describe('A'),
        b: z.string().describe('B'),
        c: z.string().describe('C'),
      }),
      format: (r) => {
        const result = r as { a: string };
        return [{ type: 'text', text: `Only A: ${result.a}` }];
      },
    });
    const errors = parityErrors(def);
    expect(errors).toHaveLength(2);
    const paths = errors.map((e) => e.message);
    expect(paths.some((m) => m.includes("'b'"))).toBe(true);
    expect(paths.some((m) => m.includes("'c'"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Union variants — every branch gets its own synthetic sample
// ---------------------------------------------------------------------------

describe('lintFormatParity — union variants', () => {
  it('flags fields that are missing only from a non-first discriminated union branch', () => {
    const def = tool({
      output: z.object({
        result: z
          .discriminatedUnion('kind', [
            z.object({
              kind: z.literal('list').describe('Result kind'),
              ids: z.array(z.string().describe('ID')).describe('Result IDs'),
            }),
            z.object({
              kind: z.literal('detail').describe('Result kind'),
              id: z.string().describe('Result ID'),
              summary: z.string().describe('Detail summary'),
            }),
          ])
          .describe('Result variant'),
      }),
      format: (r) => {
        const result = (
          r as {
            result:
              | { kind: 'list'; ids: string[] }
              | { kind: 'detail'; id: string; summary: string };
          }
        ).result;
        if (result.kind === 'list') {
          return [{ type: 'text', text: `Kind: ${result.kind}\nIDs: ${result.ids.join(', ')}` }];
        }
        return [{ type: 'text', text: `Kind: ${result.kind}\nDetail: ${result.id}` }];
      },
    });

    const errors = parityErrors(def);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("'result.summary'");
  });

  it('passes when format renders every discriminated union branch completely', () => {
    const def = tool({
      output: z.object({
        result: z
          .discriminatedUnion('kind', [
            z.object({
              kind: z.literal('list').describe('Result kind'),
              ids: z.array(z.string().describe('ID')).describe('Result IDs'),
            }),
            z.object({
              kind: z.literal('detail').describe('Result kind'),
              id: z.string().describe('Result ID'),
              summary: z.string().describe('Detail summary'),
            }),
          ])
          .describe('Result variant'),
      }),
      format: (r) => {
        const result = (
          r as {
            result:
              | { kind: 'list'; ids: string[] }
              | { kind: 'detail'; id: string; summary: string };
          }
        ).result;
        if (result.kind === 'list') {
          return [{ type: 'text', text: `Kind: ${result.kind}\nIDs: ${result.ids.join(', ')}` }];
        }
        return [
          {
            type: 'text',
            text: `Kind: ${result.kind}\nDetail: ${result.id}\nSummary: ${result.summary}`,
          },
        ];
      },
    });

    expect(parityErrors(def)).toHaveLength(0);
  });

  it('flags fields missing from a non-first union branch inside an array', () => {
    const def = tool({
      output: z.object({
        rows: z
          .array(
            z.discriminatedUnion('kind', [
              z.object({
                kind: z.literal('summary').describe('Row kind'),
                count: z.number().describe('Summary count'),
              }),
              z.object({
                kind: z.literal('detail').describe('Row kind'),
                id: z.string().describe('Detail ID'),
                note: z.string().describe('Detail note'),
              }),
            ]),
          )
          .describe('Rows'),
      }),
      format: (r) => {
        const row = (
          r as {
            rows: Array<
              { kind: 'summary'; count: number } | { kind: 'detail'; id: string; note: string }
            >;
          }
        ).rows[0];
        if (!row) {
          return [{ type: 'text', text: 'No rows' }];
        }
        if (row.kind === 'summary') {
          return [{ type: 'text', text: `Kind: ${row.kind}\nCount: ${row.count}` }];
        }
        return [{ type: 'text', text: `Kind: ${row.kind}\nID: ${row.id}` }];
      },
    });

    const errors = parityErrors(def);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("'rows[].note'");
  });

  it('warns when format throws only for a later union branch sample', () => {
    const def = tool({
      output: z.object({
        result: z
          .discriminatedUnion('kind', [
            z.object({
              kind: z.literal('ok').describe('Result kind'),
              value: z.string().describe('Value'),
            }),
            z.object({
              kind: z.literal('error').describe('Result kind'),
              message: z.string().describe('Error message'),
            }),
          ])
          .describe('Result variant'),
      }),
      format: (r) => {
        const result = (
          r as {
            result: { kind: 'ok'; value: string } | { kind: 'error'; message: string };
          }
        ).result;
        if (result.kind === 'error') {
          throw new Error('error branch formatter is not total');
        }
        return [{ type: 'text', text: `Kind: ${result.kind}\nValue: ${result.value}` }];
      },
    });

    const diagnostics = lintFormatParity(def, def.name);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      rule: 'format-parity-threw',
      severity: 'warning',
    });
    expect(diagnostics[0]?.message).toContain('error branch formatter is not total');
  });
});

// ---------------------------------------------------------------------------
// Optional / nullable / default — always populated
// ---------------------------------------------------------------------------

describe('lintFormatParity — wrappers', () => {
  it('treats optional fields as present and flags if not rendered', () => {
    const def = tool({
      output: z.object({
        notice: z.string().optional().describe('Notice'),
      }),
      format: () => [{ type: 'text', text: 'no notice here' }],
    });
    expect(parityErrors(def)).toHaveLength(1);
  });

  it('accepts optional fields when format renders them', () => {
    const def = tool({
      output: z.object({
        notice: z.string().optional().describe('Notice'),
      }),
      format: (r) => {
        const result = r as { notice?: string };
        return [{ type: 'text', text: `notice: ${result.notice ?? ''}` }];
      },
    });
    expect(parityErrors(def)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Permissive types (boolean / enum) — key-name fallback
// ---------------------------------------------------------------------------

describe('lintFormatParity — permissive matching', () => {
  it('accepts a boolean rendered only by its key name label', () => {
    const def = tool({
      output: z.object({
        wasCancelled: z.boolean().describe('Was cancelled'),
      }),
      format: (r) => {
        const result = r as { wasCancelled: boolean };
        // Key name as label, value substring "true" also covers the fallback.
        return [{ type: 'text', text: `**Cancelled:** ${String(result.wasCancelled)}` }];
      },
    });
    expect(parityErrors(def)).toHaveLength(0);
  });

  it('flags a boolean that never appears anywhere', () => {
    const def = tool({
      output: z.object({
        somethingBoolean: z.boolean().describe('Boolean field'),
      }),
      format: () => [{ type: 'text', text: 'no mention of that field at all' }],
    });
    expect(parityErrors(def)).toHaveLength(1);
  });

  it('accepts an enum rendered by first variant', () => {
    const def = tool({
      output: z.object({
        status: z.enum(['active', 'inactive']).describe('Status'),
      }),
      format: (r) => {
        const result = r as { status: string };
        return [{ type: 'text', text: `status is ${result.status}` }];
      },
    });
    expect(parityErrors(def)).toHaveLength(0);
  });

  it('accepts a literal rendered by key-name fallback', () => {
    const def = tool({
      output: z.object({
        kind: z.literal('summary').describe('Result kind'),
      }),
      format: () => [{ type: 'text', text: 'Kind: rendered without the literal value' }],
    });
    expect(parityErrors(def)).toHaveLength(0);
  });

  it('accepts an unsupported permissive leaf when its key name is rendered', () => {
    const def = tool({
      output: z.object({
        payload: z.any().describe('Dynamic payload'),
      }),
      format: () => [{ type: 'text', text: 'payload is present' }],
    });
    expect(parityErrors(def)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation
// ---------------------------------------------------------------------------

describe('lintFormatParity — non-text content blocks', () => {
  it('accepts an image block when output fields are rendered as data/mimeType', () => {
    const def = tool({
      output: z.object({
        data: z.string().describe('Base64 data'),
        mimeType: z.string().describe('Image MIME type'),
      }),
      format: (r) => {
        const result = r as { data: string; mimeType: string };
        return [{ type: 'image', data: result.data, mimeType: result.mimeType }];
      },
    });
    expect(parityErrors(def)).toHaveLength(0);
  });

  it('accepts a resource block when output fields appear in uri/text', () => {
    const def = tool({
      output: z.object({
        uri: z.string().describe('Resource URI'),
        body: z.string().describe('Resource body'),
      }),
      format: (r) => {
        const result = r as { uri: string; body: string };
        return [
          {
            type: 'resource',
            resource: { uri: result.uri, mimeType: 'text/plain', text: result.body },
          },
        ];
      },
    });
    expect(parityErrors(def)).toHaveLength(0);
  });
});

describe('lintFormatParity — graceful degradation', () => {
  it('emits a warning when format throws on synthetic', () => {
    const def = tool({
      output: z.object({ x: z.string().describe('x') }),
      format: (r) => {
        const result = r as { x: string };
        if (result.x.startsWith('MCPPARITY')) {
          throw new Error('format assumes real data');
        }
        return [{ type: 'text', text: result.x }];
      },
    });
    const diagnostics = lintFormatParity(def, def.name);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe('warning');
    expect(diagnostics[0]?.rule).toBe('format-parity-threw');
  });

  it('skips when output is not a ZodObject', () => {
    const def = {
      name: 'weird',
      description: 'weird',
      input: z.object({}),
      output: z.string(),
      handler: async () => '',
      format: () => [{ type: 'text', text: '' }],
    };
    expect(lintFormatParity(def, 'weird')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Wiring: exercised through lintToolDefinition (the public entry point)
// ---------------------------------------------------------------------------

describe('lintToolDefinition — format-parity integration', () => {
  it('surfaces format-parity errors via the main rule entry point', () => {
    const def = {
      name: 'integration_tool',
      description: 'integration',
      input: z.object({ q: z.string().describe('q') }),
      output: z.object({
        shown: z.string().describe('shown'),
        hidden: z.string().describe('hidden'),
      }),
      handler: async () => ({ shown: '', hidden: '' }),
      format: (r: unknown) => [{ type: 'text', text: (r as { shown: string }).shown }],
    };
    const diagnostics = lintToolDefinition(def);
    const parity = diagnostics.filter((d) => d.rule === 'format-parity');
    expect(parity).toHaveLength(1);
    expect(parity[0]?.message).toContain("'hidden'");
  });
});

// ---------------------------------------------------------------------------
// Content-block traversal and matching edge cases
// ---------------------------------------------------------------------------

describe('lintFormatParity — content traversal', () => {
  it('flags every field when format returns a non-array (renders nothing)', () => {
    const def = tool({
      output: z.object({ name: z.string().describe('Name') }),
      // A format() that returns a bare value instead of ContentBlock[] renders
      // nothing to content[] — parity must flag it rather than crash.
      format: (() => 'not an array') as unknown as (r: unknown) => ContentBlock[],
    });
    expect(parityErrors(def).length).toBeGreaterThan(0);
  });

  it('finds a field rendered inside a nested array/object within a block', () => {
    const def = tool({
      output: z.object({ tags: z.array(z.string().describe('Tag')).describe('Tags') }),
      format: (r) => {
        const result = r as { tags: string[] };
        // Sentinel lives inside a nested array; a null sibling must be tolerated.
        return [
          { type: 'text', text: 'Tags below', _extra: { values: result.tags, note: null } },
        ] as unknown as ContentBlock[];
      },
    });
    expect(parityErrors(def)).toHaveLength(0);
  });

  it('treats an empty output object as nothing to verify', () => {
    const def = tool({
      output: z.object({}),
      format: () => [{ type: 'text', text: 'nothing to render' }],
    });
    expect(parityErrors(def)).toHaveLength(0);
  });

  it('handles integer fields like numbers', () => {
    const def = tool({
      output: z.object({ count: z.int().describe('Count') }),
      format: (r) => [{ type: 'text', text: `Count: ${(r as { count: number }).count}` }],
    });
    expect(parityErrors(def)).toHaveLength(0);
  });
});

describe('lintFormatParity — key-name matching edge cases', () => {
  it('accepts a literal("") field rendered only by its key name', () => {
    const def = tool({
      output: z.object({ mode: z.literal('').describe('Mode') }),
      format: () => [{ type: 'text', text: 'Mode: default' }],
    });
    expect(parityErrors(def)).toHaveLength(0);
  });

  it('flags a short-keyed (<3 char) boolean that renders neither its value nor key', () => {
    const def = tool({
      output: z.object({ ok: z.boolean().describe('OK flag') }),
      format: () => [{ type: 'text', text: 'no relevant content here' }],
    });
    // "ok" is too short for whole-word matching, so the boolean value must render.
    expect(parityErrors(def)).toHaveLength(1);
  });

  it('accepts a boolean matched by a camelCase key segment', () => {
    const def = tool({
      output: z.object({ wasArchived: z.boolean().describe('Archived') }),
      // No "true" and no whole "wasArchived" — only the "archived" segment.
      format: () => [{ type: 'text', text: 'Archived: yes' }],
    });
    expect(parityErrors(def)).toHaveLength(0);
  });
});

describe('lintFormatParity — deduplication', () => {
  it('reports a field shared across union branches only once', () => {
    const def = tool({
      output: z.object({
        result: z
          .discriminatedUnion('kind', [
            z.object({
              kind: z.literal('a').describe('Kind'),
              shared: z.string().describe('Shared'),
            }),
            z.object({
              kind: z.literal('b').describe('Kind'),
              shared: z.string().describe('Shared'),
            }),
          ])
          .describe('Result'),
      }),
      format: (r) => {
        const result = (r as { result: { kind: string } }).result;
        return [{ type: 'text', text: `Kind: ${result.kind}` }];
      },
    });
    const errors = parityErrors(def);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("'result.shared'");
  });
});

// ---------------------------------------------------------------------------
// Recursion-depth guard
// ---------------------------------------------------------------------------

/** Chain of `depth` nested objects (key `child`) terminating in a string leaf. */
function nestedObject(depth: number): z.ZodTypeAny {
  if (depth === 0) return z.string().describe('Deep leaf value');
  return z.object({ child: nestedObject(depth - 1) }).describe(`Level ${depth}`);
}

describe('lintFormatParity — recursion depth guard', () => {
  it('stops verifying fields nested beyond depth 8 but reports the gap', () => {
    const def = tool({
      output: z.object({ root: nestedObject(12) }),
      // Formatter ignores the deeply nested value entirely. Past the guard the
      // walker cannot evaluate it — that must surface as "not evaluated", not
      // as a silent pass.
      format: () => [{ type: 'text', text: 'summary only, no deep fields rendered' }],
    });
    expect(parityErrors(def)).toHaveLength(0);

    const warnings = lintFormatParity(def, def.name).filter((d) => d.severity === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.rule).toBe('format-parity-depth-limit');
    expect(warnings[0]?.message).toContain('root.child.child.child.child.child.child.child.child');
  });

  it('evaluates a leaf sitting exactly at the depth limit', () => {
    // nestedObject(7) under `root` puts the string leaf at walker depth 8 — the
    // last depth the walker still evaluates.
    const def = tool({
      output: z.object({ root: nestedObject(7) }),
      format: () => [{ type: 'text', text: 'summary only, no deep fields rendered' }],
    });
    const diagnostics = lintFormatParity(def, def.name);
    expect(diagnostics.filter((d) => d.rule === 'format-parity-depth-limit')).toHaveLength(0);
    expect(parityErrors(def)).toHaveLength(1);
  });

  it('reports the first unevaluated path when the leaf sits one level past the limit', () => {
    const def = tool({
      output: z.object({ root: nestedObject(8) }),
      format: () => [{ type: 'text', text: 'summary only, no deep fields rendered' }],
    });
    const diagnostics = lintFormatParity(def, def.name);
    const depthLimit = diagnostics.filter((d) => d.rule === 'format-parity-depth-limit');
    expect(depthLimit).toHaveLength(1);
    expect(depthLimit[0]?.severity).toBe('warning');
    expect(depthLimit[0]?.message).toContain(
      'root.child.child.child.child.child.child.child.child',
    );
    expect(parityErrors(def)).toHaveLength(0);
  });

  it('reports the depth gap even when no leaf was reachable at all', () => {
    // Everything the walker can see is past the limit, so there are no leaves to
    // verify — the diagnostic must still be emitted rather than short-circuited.
    const def = tool({
      output: z.object({ root: nestedObject(9) }),
      format: () => [{ type: 'text', text: 'nothing rendered' }],
    });
    const diagnostics = lintFormatParity(def, def.name);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.rule).toBe('format-parity-depth-limit');
  });
});

// ---------------------------------------------------------------------------
// Multi-value literals (Zod 4 closed sets)
// ---------------------------------------------------------------------------

describe('lintFormatParity — multi-value literals', () => {
  it('walks a multi-value z.literal instead of failing the whole tool', () => {
    const def = tool({
      output: z.object({
        priority: z.literal([1, 2, 3, 4, 5]).describe('Closed numeric set as one schema node.'),
      }),
      format: (r) => [{ type: 'text', text: `priority ${(r as { priority: number }).priority}` }],
    });
    expect(lintFormatParity(def, def.name)).toHaveLength(0);
  });

  it('flags an unrendered multi-value literal instead of disabling the rule', () => {
    const def = tool({
      output: z.object({
        priority: z.literal([1, 2, 3, 4, 5]).describe('Priority'),
        label: z.string().describe('Label'),
      }),
      format: (r) => [{ type: 'text', text: `label ${(r as { label: string }).label}` }],
    });
    const diagnostics = lintFormatParity(def, def.name);
    expect(diagnostics.filter((d) => d.rule === 'format-parity-walk-failed')).toHaveLength(0);
    const errors = parityErrors(def);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("'priority'");
  });

  it('still walks a single-value literal unchanged', () => {
    const def = tool({
      output: z.object({ kind: z.literal('summary').describe('Result kind') }),
      format: (r) => [{ type: 'text', text: `kind ${(r as { kind: string }).kind}` }],
    });
    expect(lintFormatParity(def, def.name)).toHaveLength(0);
  });

  it('falls back to the key name for an empty enum, whose value set has no member', () => {
    // z.enum([]) — and a numeric array handed to z.enum(), which serializes to
    // the same `{"type":"string","enum":[]}` — yields no sampleable member. The
    // walker must not crash, and must not silently pass on an absent sentinel.
    const empty = z.enum([] as unknown as [string, ...string[]]);
    const rendered = tool({
      output: z.object({ status: empty.describe('Status') }),
      format: () => [{ type: 'text', text: 'Status: unknown' }],
    });
    expect(lintFormatParity(rendered, rendered.name)).toHaveLength(0);

    const absent = tool({
      output: z.object({ status: empty.describe('Status') }),
      format: () => [{ type: 'text', text: 'nothing relevant here' }],
    });
    expect(parityErrors(absent)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Sentinel inertness under render-boundary escaping
// ---------------------------------------------------------------------------

/** Escapes the characters a Markdown renderer must neutralize in upstream text. */
function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+\-.!<>])/g, '\\$1');
}

describe('lintFormatParity — escaping formatters', () => {
  it('passes a format() that Markdown-escapes every rendered value', () => {
    const def = tool({
      output: z.object({
        title: z.string().describe('Title'),
        body: z.string().describe('Body'),
      }),
      format: (r) => {
        const result = r as { title: string; body: string };
        return [
          {
            type: 'text',
            text: `# ${escapeMarkdown(result.title)}\n${escapeMarkdown(result.body)}`,
          },
        ];
      },
    });
    expect(lintFormatParity(def, def.name)).toHaveLength(0);
  });

  it('still flags a field a Markdown-escaping format() drops', () => {
    const def = tool({
      output: z.object({
        title: z.string().describe('Title'),
        body: z.string().describe('Body'),
      }),
      format: (r) => [
        { type: 'text', text: `# ${escapeMarkdown((r as { title: string }).title)}` },
      ],
    });
    const errors = parityErrors(def);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("'body'");
  });

  it('passes a format() that HTML-escapes or URL-encodes its values', () => {
    const def = tool({
      output: z.object({
        label: z.string().describe('Label'),
        href: z.string().describe('Link target'),
      }),
      format: (r) => {
        const result = r as { label: string; href: string };
        return [
          {
            type: 'text',
            text: `<a href="https://example.com/${encodeURIComponent(result.href)}">${result.label.replace(
              /[&<>"']/g,
              (c) => `&#${c.charCodeAt(0)};`,
            )}</a>`,
          },
        ];
      },
    });
    expect(lintFormatParity(def, def.name)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Permissive-leaf collision resistance
// ---------------------------------------------------------------------------

describe('lintFormatParity — permissive collision resistance', () => {
  it('flags an unrendered enum whose value is a substring of a sibling field', () => {
    const def = tool({
      output: z.object({
        kind: z.enum(['full', 'outline']).describe('Result kind'),
        case_name_full: z.string().describe('Full case name'),
      }),
      // Renders the sibling only. The enum's value ('full') appears inside the
      // sibling's rendered text as an incidental substring, which must not count.
      format: (r) => [
        { type: 'text', text: `Name: ${(r as { case_name_full: string }).case_name_full}` },
      ],
    });
    const errors = parityErrors(def);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("'kind'");
  });

  it('flags an enum whose value only appears inside a longer word', () => {
    const def = tool({
      output: z.object({ state: z.enum(['active', 'archived']).describe('State') }),
      // "inactive" contains "active"; the field is not actually rendered, and the
      // key name "state" never appears either.
      format: () => [{ type: 'text', text: 'Currently inactive' }],
    });
    expect(parityErrors(def)).toHaveLength(1);
  });

  it('flags a boolean whose value only appears inside a longer token', () => {
    const def = tool({
      output: z.object({ verified: z.boolean().describe('Verified') }),
      // "construed" contains no boundary-delimited "true"; nothing renders the field.
      format: () => [{ type: 'text', text: 'nothing construed from this' }],
    });
    expect(parityErrors(def)).toHaveLength(1);
  });

  it('flags a literal whose value only appears inside a longer token', () => {
    const def = tool({
      output: z.object({
        mode: z.literal('list').describe('Mode'),
        headline: z.string().describe('Headline'),
      }),
      // "listing" contains "list"; neither the literal nor the key name renders.
      format: (r) => [
        { type: 'text', text: `A listing of ${(r as { headline: string }).headline}` },
      ],
    });
    const errors = parityErrors(def);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("'mode'");
  });

  it('still accepts a permissive value rendered as a delimited token', () => {
    const def = tool({
      output: z.object({
        state: z.enum(['active', 'archived']).describe('State'),
        flag: z.boolean().describe('Flag'),
      }),
      format: (r) => {
        const result = r as { state: string; flag: boolean };
        return [{ type: 'text', text: `State: **${result.state}** | Flag: ${result.flag}` }];
      },
    });
    expect(parityErrors(def)).toHaveLength(0);
  });

  it('still normalizes digit grouping for a numeric multi-value literal', () => {
    const def = tool({
      output: z.object({ tier: z.literal([1000, 2000]).describe('Tier') }),
      format: (r) => [
        {
          type: 'text',
          text: `Tier: ${(r as { tier: number }).tier.toLocaleString('en-US')}`,
        },
      ],
    });
    expect(parityErrors(def)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Additional leaf-type coverage
// ---------------------------------------------------------------------------

describe('lintFormatParity — additional leaf types', () => {
  it('handles an empty tuple with nothing to verify', () => {
    const def = tool({
      output: z.object({ pair: z.tuple([]).describe('Empty tuple') }),
      format: () => [{ type: 'text', text: 'nothing to render' }],
    });
    expect(parityErrors(def)).toHaveLength(0);
  });

  it('handles bigint fields like numbers', () => {
    const def = tool({
      output: z.object({ big: z.bigint().describe('Big count') }),
      format: (r) => [{ type: 'text', text: `Big: ${(r as { big: bigint }).big}` }],
    });
    expect(parityErrors(def)).toHaveLength(0);
  });

  it('flags an untyped (z.any()) field whose key name never appears', () => {
    const def = tool({
      output: z.object({ payload: z.any().describe('Dynamic payload') }),
      format: () => [{ type: 'text', text: 'nothing relevant here' }],
    });
    expect(parityErrors(def)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Locale grouping — documented limitation
// ---------------------------------------------------------------------------

describe('lintFormatParity — locale grouping limitation', () => {
  it('does not normalize hi-IN lakh/crore grouping (documented tradeoff)', () => {
    const def = tool({
      output: z.object({ total: z.number().describe('Total') }),
      format: (r) => [
        {
          type: 'text',
          text: `Total: ${(r as { total: number }).total.toLocaleString('hi-IN')}`,
        },
      ],
    });
    // hi-IN groups in 2-digit runs after the initial 3 digits (e.g. 90,00,00,001);
    // THOUSANDS_GROUP_PATTERN only recognizes \d{3} groups, so this legitimately
    // fails parity — matching the "Known weakness" documented on the pattern.
    expect(parityErrors(def).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Additional wrapper coverage
// ---------------------------------------------------------------------------

describe('lintFormatParity — additional wrappers', () => {
  it('treats a nullable field as present and flags if not rendered', () => {
    const def = tool({
      output: z.object({ tag: z.string().nullable().describe('Tag') }),
      format: () => [{ type: 'text', text: 'no tag mention' }],
    });
    expect(parityErrors(def)).toHaveLength(1);
  });

  it('treats a defaulted field as present and flags if not rendered', () => {
    const def = tool({
      output: z.object({ mode: z.string().default('auto').describe('Mode') }),
      format: () => [{ type: 'text', text: 'no mode mention' }],
    });
    expect(parityErrors(def)).toHaveLength(1);
  });

  it('unwraps multiple stacked optional/nullable layers', () => {
    const def = tool({
      output: z.object({ note: z.string().nullable().optional().describe('Note') }),
      format: () => [{ type: 'text', text: 'no mention of the note field' }],
    });
    expect(parityErrors(def)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Key-splitting on literal underscores (not just camelCase-derived ones)
// ---------------------------------------------------------------------------

describe('lintFormatParity — snake_case key segment matching', () => {
  it('matches a snake_case key by its underscore-delimited segment', () => {
    const def = tool({
      output: z.object({ was_archived: z.boolean().describe('Archived flag') }),
      // No "true"/"false" literal and no whole "was_archived" — only "archived".
      format: () => [{ type: 'text', text: 'Archived: yes' }],
    });
    expect(parityErrors(def)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Schema metadata compatibility and hostile metadata
// ---------------------------------------------------------------------------

describe('lintFormatParity — schema metadata compatibility', () => {
  it('accepts complete formatters across legacy Zod metadata layouts', () => {
    const legacyString = { _def: { type: 'string' } };
    const legacyNumber = { _def: { type: 'number' } };
    const output = {
      _def: { type: 'object' },
      shape: {
        wrapped: { _def: { type: 'optional', innerType: legacyString } },
        status: { _def: { type: 'enum', values: ['ready'] } },
        kind: { _def: { type: 'literal', value: 'summary' } },
        rows: { _def: { type: 'array', element: legacyString } },
        choice: { _def: { type: 'union', options: [legacyString, legacyNumber] } },
        scores: { _def: { type: 'record', valueType: legacyNumber } },
        pair: { _def: { type: 'tuple', items: [legacyString, legacyNumber] } },
      },
    };

    const diagnostics = lintFormatParity(
      {
        output,
        format: (result: unknown) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      'legacy_layout_tool',
    );

    expect(diagnostics).toHaveLength(0);
  });

  it('accepts complete formatters across nested _zod.def metadata layouts', () => {
    const zodString = { _zod: { def: { type: 'string' } } };
    const zodNumber = { _zod: { def: { type: 'number' } } };
    const output = {
      _zod: { def: { type: 'object' } },
      shape: {
        status: { _zod: { def: { type: 'enum', entries: { ready: 'ready' } } } },
        kind: { _zod: { def: { type: 'literal', values: ['summary'] } } },
        rows: { _zod: { def: { type: 'array', element: zodString } } },
        choice: { _zod: { def: { type: 'union', options: [zodString, zodNumber] } } },
        scores: { _zod: { def: { type: 'record', valueType: zodNumber } } },
        pair: { _zod: { def: { type: 'tuple', items: [zodString, zodNumber] } } },
      },
    };

    const diagnostics = lintFormatParity(
      {
        output,
        format: (result: unknown) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      'zod_metadata_tool',
    );

    expect(diagnostics).toHaveLength(0);
  });

  it('degrades safely when wrapper and collection metadata is incomplete', () => {
    const output = {
      _def: { type: 'object' },
      shape: {
        brokenWrapper: { _def: { type: 'optional' } },
        missingUnionOptions: { _def: { type: 'union' } },
        missingRecordValue: { _def: { type: 'record' } },
        missingTupleItems: { _def: { type: 'tuple' } },
        missingObjectShape: { _def: { type: 'object' } },
      },
    };

    const diagnostics = lintFormatParity(
      {
        output,
        format: () => [{ type: 'text', text: 'brokenWrapper is present' }],
      },
      'incomplete_metadata_tool',
    );

    expect(diagnostics).toHaveLength(0);
  });

  it.each([new Error('shape getter failed'), 'shape getter failed'])(
    'warns instead of throwing when schema traversal fails with %s',
    (thrown) => {
      const output = {
        _def: { type: 'object' },
        get shape(): never {
          throw thrown;
        },
      };

      const diagnostics = lintFormatParity(
        { output, format: () => [{ type: 'text', text: '' }] },
        'hostile_schema_tool',
      );

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        rule: 'format-parity-walk-failed',
        severity: 'warning',
      });
      expect(diagnostics[0]?.message).toContain('shape getter failed');
    },
  );

  it('reports a non-Error formatter throw without leaking the thrown value', () => {
    const diagnostics = lintFormatParity(
      {
        output: z.object({ value: z.string().describe('Value') }),
        format: () => {
          throw 'formatter rejected synthetic input';
        },
      },
      'non_error_throw_tool',
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ rule: 'format-parity-threw', severity: 'warning' });
    expect(diagnostics[0]?.message).toContain('formatter rejected synthetic input');
  });

  it('ignores non-serializable block metadata while still finding rendered fields', () => {
    const def = tool({
      output: z.object({ name: z.string().describe('Name') }),
      format: (result) =>
        [
          {
            type: 'text',
            text: (result as { name: string }).name,
            metadata: { callback: () => 'ignored', marker: Symbol('ignored') },
          },
        ] as unknown as ContentBlock[],
    });

    expect(parityErrors(def)).toHaveLength(0);
  });

  it('skips null and primitive output metadata', () => {
    const format = () => [{ type: 'text', text: 'unused' }];

    expect(lintFormatParity({ output: null, format }, 'null_output')).toHaveLength(0);
    expect(lintFormatParity({ output: 'object', format }, 'primitive_output')).toHaveLength(0);
  });
});

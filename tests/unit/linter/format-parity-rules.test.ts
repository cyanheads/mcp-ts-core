/**
 * @fileoverview Tests for the format-parity lint rule.
 * @module tests/unit/linter/format-parity-rules.test
 */

import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
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
        if (result.x.startsWith('__MCP_PARITY_')) {
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

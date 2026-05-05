/**
 * @fileoverview Tests for the source-agnostic `spillover()` helper. Exercises
 * fit/spill/cap/abort/schema-sniff/auto-name paths against a stub canvas
 * provider so the suite runs without `@duckdb/node-api`.
 * @module tests/unit/canvas/spillover.test
 */

import { describe, expect, it, vi } from 'vitest';

import type { CanvasInstance } from '@/services/canvas/core/CanvasInstance.js';
import {
  CanvasRegistry,
  type CanvasRegistryOptions,
} from '@/services/canvas/core/CanvasRegistry.js';
import { DataCanvas } from '@/services/canvas/core/DataCanvas.js';
import type { IDataCanvasProvider } from '@/services/canvas/core/IDataCanvasProvider.js';
import { spillover } from '@/services/canvas/spillover.js';
import type {
  ColumnSchema,
  RegisterRows,
  RegisterTableOptions,
  RegisterTableResult,
} from '@/services/canvas/types.js';
import { McpError } from '@/types-global/errors.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

type Row = Record<string, unknown>;

type CapturedRegistration = {
  rows: Row[];
  schema?: ColumnSchema[];
  tableName: string;
};

interface ProviderHarness {
  capture: { last?: CapturedRegistration };
  drops: string[];
  provider: IDataCanvasProvider;
}

/**
 * Build a stub provider whose registerTable drains the iterable so tests can
 * assert on the rows that flowed through.
 */
function makeProviderHarness(
  overrides: Partial<{
    registerTable: (rows: Row[], options?: RegisterTableOptions) => Promise<RegisterTableResult>;
  }> = {},
): ProviderHarness {
  const capture: { last?: CapturedRegistration } = {};
  const drops: string[] = [];

  const drainRows = async (rows: RegisterRows): Promise<Row[]> => {
    const drained: Row[] = [];
    if (typeof (rows as AsyncIterable<Row>)[Symbol.asyncIterator] === 'function') {
      for await (const row of rows as AsyncIterable<Row>) drained.push(row);
    } else {
      for (const row of rows as Iterable<Row>) drained.push(row);
    }
    return drained;
  };

  const provider = {
    name: 'stub',
    initCanvas: vi.fn(async () => undefined),
    destroyCanvas: vi.fn(async () => undefined),
    registerTable: vi.fn(
      async (
        _canvasId: string,
        name: string,
        rows: RegisterRows,
        _ctx: RequestContext,
        options?: RegisterTableOptions,
      ): Promise<RegisterTableResult> => {
        const drained = await drainRows(rows);
        capture.last = {
          tableName: name,
          rows: drained,
          ...(options?.schema !== undefined && { schema: options.schema }),
        };
        if (overrides.registerTable) return overrides.registerTable(drained, options);
        return {
          tableName: name,
          rowCount: drained.length,
          columns: drained[0] ? Object.keys(drained[0]) : [],
        };
      },
    ),
    registerView: vi.fn(async () => ({ viewName: 'v', columns: [] })),
    importFrom: vi.fn(async () => ({ tableName: 'imported', rowCount: 0, columns: [] })),
    query: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0 })),
    export: vi.fn(async () => ({ format: 'csv' as const, rowCount: 0, sizeBytes: 0 })),
    describe: vi.fn(async () => []),
    drop: vi.fn(async (_canvasId: string, name: string) => {
      drops.push(name);
      return true;
    }),
    clear: vi.fn(async () => 0),
    healthCheck: vi.fn(async () => true),
    shutdown: vi.fn(async () => undefined),
  } as unknown as IDataCanvasProvider;

  return { provider, capture, drops };
}

const TTL = 24 * 60 * 60 * 1000;

function makeOptions(): CanvasRegistryOptions {
  return {
    ttlMs: TTL,
    absoluteCapMs: 7 * 24 * 60 * 60 * 1000,
    maxCanvasesPerTenant: 100,
    sweeperIntervalMs: 0,
  };
}

const ctxWithTenant: RequestContext = {
  requestId: 'test-req',
  timestamp: '2026-01-01T00:00:00.000Z',
  tenantId: 'tenant-a',
};

async function freshCanvas(harness?: ProviderHarness): Promise<{
  canvas: CanvasInstance;
  harness: ProviderHarness;
  shutdown: () => Promise<void>;
}> {
  const h = harness ?? makeProviderHarness();
  const registry = new CanvasRegistry(h.provider, makeOptions());
  const data = new DataCanvas(h.provider, registry);
  const canvas = await data.acquire(undefined, ctxWithTenant);
  return {
    canvas,
    harness: h,
    shutdown: async () => {
      await registry.shutdown(ctxWithTenant);
    },
  };
}

// ---------------------------------------------------------------------
// Fit path — source under budget, no canvas call
// ---------------------------------------------------------------------

describe('spillover · fit path', () => {
  it('returns spilled:false when sync source fits in budget', async () => {
    const { canvas, harness, shutdown } = await freshCanvas();
    const result = await spillover({
      canvas,
      source: [{ a: 1 }, { a: 2 }, { a: 3 }],
      previewChars: 1_000,
    });
    expect(result.spilled).toBe(false);
    expect(result.previewRows).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(harness.provider.registerTable).not.toHaveBeenCalled();
    await shutdown();
  });

  it('returns spilled:false when async source fits in budget', async () => {
    const { canvas, harness, shutdown } = await freshCanvas();
    async function* gen(): AsyncIterable<Row> {
      yield { a: 1 };
      yield { a: 2 };
    }
    const result = await spillover({
      canvas,
      source: gen(),
      previewChars: 1_000,
    });
    expect(result.spilled).toBe(false);
    expect(result.previewRows).toEqual([{ a: 1 }, { a: 2 }]);
    expect(harness.provider.registerTable).not.toHaveBeenCalled();
    await shutdown();
  });

  it('returns spilled:false with empty previewRows for an empty source', async () => {
    const { canvas, shutdown } = await freshCanvas();
    const result = await spillover({ canvas, source: [], previewChars: 100 });
    expect(result).toEqual({ spilled: false, previewRows: [] });
    await shutdown();
  });
});

// ---------------------------------------------------------------------
// Spill path — source exceeds budget, canvas registers full set
// ---------------------------------------------------------------------

describe('spillover · spill path', () => {
  it('spills sync source that exceeds budget; preview = rows that fit, register = all rows', async () => {
    const { canvas, harness, shutdown } = await freshCanvas();
    // Each row JSON ≈ 9 chars (`{"a":N}` for small N). Budget=20 → 2 rows fit, 3rd overflows.
    const source = [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }, { a: 5 }];
    const result = await spillover({ canvas, source, previewChars: 20 });

    expect(result.spilled).toBe(true);
    if (!result.spilled) throw new Error('unreachable');
    expect(result.previewRows.length).toBeLessThan(source.length);
    expect(result.previewRows.every((r, i) => r.a === source[i]?.a)).toBe(true);
    expect(result.truncated).toBe(false);
    expect(harness.capture.last?.rows).toEqual(source);
    expect(result.handle.tableName).toBe(harness.capture.last?.tableName);
    expect(result.handle.rowCount).toBe(source.length);
    await shutdown();
  });

  it('spills async source that exceeds budget; rows flow in original order', async () => {
    const { canvas, harness, shutdown } = await freshCanvas();
    async function* gen(): AsyncIterable<Row> {
      for (let i = 0; i < 20; i++) yield { i };
    }
    const result = await spillover({ canvas, source: gen(), previewChars: 30 });

    expect(result.spilled).toBe(true);
    if (!result.spilled) throw new Error('unreachable');
    expect(harness.capture.last?.rows.map((r) => r.i)).toEqual(
      Array.from({ length: 20 }, (_v, i) => i),
    );
    await shutdown();
  });

  it('spills a single oversized row when first row exceeds budget', async () => {
    const { canvas, harness, shutdown } = await freshCanvas();
    const big = { payload: 'x'.repeat(500) };
    const result = await spillover({ canvas, source: [big], previewChars: 50 });

    expect(result.spilled).toBe(true);
    if (!result.spilled) throw new Error('unreachable');
    expect(result.previewRows).toEqual([]);
    expect(harness.capture.last?.rows).toEqual([big]);
    await shutdown();
  });
});

// ---------------------------------------------------------------------
// Cap truncation
// ---------------------------------------------------------------------

describe('spillover · caps.maxRows', () => {
  it('reports truncated:true when cap is hit before source exhausts', async () => {
    const { canvas, harness, shutdown } = await freshCanvas();
    const source = Array.from({ length: 100 }, (_, i) => ({ i }));
    const result = await spillover({
      canvas,
      source,
      previewChars: 10,
      caps: { maxRows: 5 },
    });

    expect(result.spilled).toBe(true);
    if (!result.spilled) throw new Error('unreachable');
    expect(result.truncated).toBe(true);
    expect(harness.capture.last?.rows).toHaveLength(5);
    expect(result.handle.rowCount).toBe(5);
    await shutdown();
  });

  it('reports truncated:false when cap is high enough to absorb the full source', async () => {
    const { canvas, harness, shutdown } = await freshCanvas();
    const source = Array.from({ length: 10 }, (_, i) => ({ i }));
    const result = await spillover({
      canvas,
      source,
      previewChars: 10,
      caps: { maxRows: 1_000 },
    });

    expect(result.spilled).toBe(true);
    if (!result.spilled) throw new Error('unreachable');
    expect(result.truncated).toBe(false);
    expect(harness.capture.last?.rows).toHaveLength(10);
    await shutdown();
  });

  it('rejects caps.maxRows=0', async () => {
    const { canvas, shutdown } = await freshCanvas();
    await expect(
      spillover({ canvas, source: [{ a: 1 }], previewChars: 10, caps: { maxRows: 0 } }),
    ).rejects.toThrow(/maxRows must be an integer/);
    await shutdown();
  });
});

// ---------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------

describe('spillover · signal.abort()', () => {
  it('throws on abort during preview drain and never registers', async () => {
    const { canvas, harness, shutdown } = await freshCanvas();
    const ctrl = new AbortController();
    async function* gen(): AsyncIterable<Row> {
      yield { i: 0 };
      ctrl.abort();
      yield { i: 1 };
    }
    await expect(
      spillover({ canvas, source: gen(), previewChars: 1_000_000, signal: ctrl.signal }),
    ).rejects.toThrow();
    expect(harness.provider.registerTable).not.toHaveBeenCalled();
    await shutdown();
  });

  it('drops the partial table when registration throws', async () => {
    const failingHarness = makeProviderHarness({
      registerTable: async () => {
        throw new Error('register-failed');
      },
    });
    const { canvas, harness, shutdown } = await freshCanvas(failingHarness);

    const source = Array.from({ length: 10 }, (_, i) => ({ i }));
    await expect(
      spillover({ canvas, source, previewChars: 5, tableName: 'will_be_dropped' }),
    ).rejects.toThrow(/register-failed/);
    expect(harness.drops).toContain('will_be_dropped');
    await shutdown();
  });

  it('rejects an already-aborted signal up-front', async () => {
    const { canvas, harness, shutdown } = await freshCanvas();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      spillover({ canvas, source: [{ a: 1 }], previewChars: 100, signal: ctrl.signal }),
    ).rejects.toThrow();
    expect(harness.provider.registerTable).not.toHaveBeenCalled();
    await shutdown();
  });
});

// ---------------------------------------------------------------------
// Schema handling
// ---------------------------------------------------------------------

describe('spillover · schema', () => {
  it('auto-derives schema from preview buffer for async sources', async () => {
    const { canvas, harness, shutdown } = await freshCanvas();
    async function* gen(): AsyncIterable<Row> {
      for (let i = 0; i < 50; i++) yield { id: i, name: `row-${i}` };
    }
    const result = await spillover({ canvas, source: gen(), previewChars: 30 });

    expect(result.spilled).toBe(true);
    expect(harness.capture.last?.schema).toBeDefined();
    const schema = harness.capture.last?.schema ?? [];
    expect(schema.map((c) => c.name).sort()).toEqual(['id', 'name']);
    expect(schema.find((c) => c.name === 'id')?.type).toBe('BIGINT');
    expect(schema.find((c) => c.name === 'name')?.type).toBe('VARCHAR');
    await shutdown();
  });

  it('passes through caller-supplied schema unchanged', async () => {
    const { canvas, harness, shutdown } = await freshCanvas();
    const explicit: ColumnSchema[] = [
      { name: 'id', type: 'BIGINT', nullable: false },
      { name: 'note', type: 'VARCHAR', nullable: true },
    ];
    async function* gen(): AsyncIterable<Row> {
      for (let i = 0; i < 10; i++) yield { id: i, note: 'x' };
    }
    await spillover({ canvas, source: gen(), previewChars: 5, schema: explicit });
    expect(harness.capture.last?.schema).toBe(explicit);
    await shutdown();
  });

  it('infers schema for sync sources too (uniform behavior)', async () => {
    const { canvas, harness, shutdown } = await freshCanvas();
    const source = Array.from({ length: 20 }, (_, i) => ({ k: i }));
    await spillover({ canvas, source, previewChars: 5 });
    expect(harness.capture.last?.schema).toBeDefined();
    expect(harness.capture.last?.schema?.[0]?.name).toBe('k');
    await shutdown();
  });
});

// ---------------------------------------------------------------------
// Table name
// ---------------------------------------------------------------------

describe('spillover · tableName', () => {
  it('auto-generates a canvas-valid name when omitted', async () => {
    const { canvas, harness, shutdown } = await freshCanvas();
    const source = Array.from({ length: 10 }, () => ({ a: 1 }));
    const result = await spillover({ canvas, source, previewChars: 5 });
    expect(result.spilled).toBe(true);
    if (!result.spilled) throw new Error('unreachable');
    expect(result.handle.tableName).toMatch(/^spilled_[0-9a-f]{8}$/);
    expect(harness.capture.last?.tableName).toBe(result.handle.tableName);
    await shutdown();
  });

  it('uses caller-supplied name verbatim', async () => {
    const { canvas, harness, shutdown } = await freshCanvas();
    const source = Array.from({ length: 10 }, () => ({ a: 1 }));
    const result = await spillover({
      canvas,
      source,
      previewChars: 5,
      tableName: 'my_results',
    });
    expect(result.spilled).toBe(true);
    if (!result.spilled) throw new Error('unreachable');
    expect(result.handle.tableName).toBe('my_results');
    expect(harness.capture.last?.tableName).toBe('my_results');
    await shutdown();
  });

  it('rejects an invalid caller-supplied name before draining', async () => {
    const { canvas, harness, shutdown } = await freshCanvas();
    let pulled = 0;
    function* gen(): Iterable<Row> {
      for (let i = 0; i < 5; i++) {
        pulled += 1;
        yield { i };
      }
    }
    await expect(
      spillover({ canvas, source: gen(), previewChars: 100, tableName: '1bad-name' }),
    ).rejects.toThrow();
    expect(pulled).toBe(0);
    expect(harness.provider.registerTable).not.toHaveBeenCalled();
    await shutdown();
  });
});

// ---------------------------------------------------------------------
// previewChars validation
// ---------------------------------------------------------------------

describe('spillover · previewChars validation', () => {
  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects previewChars=%s', async (value) => {
    const { canvas, shutdown } = await freshCanvas();
    await expect(spillover({ canvas, source: [{ a: 1 }], previewChars: value })).rejects.toThrow(
      /previewChars/,
    );
    await shutdown();
  });

  it('throws an McpError validation error for invalid previewChars', async () => {
    const { canvas, shutdown } = await freshCanvas();
    let caught: unknown;
    try {
      await spillover({ canvas, source: [{ a: 1 }], previewChars: 0 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    await shutdown();
  });
});

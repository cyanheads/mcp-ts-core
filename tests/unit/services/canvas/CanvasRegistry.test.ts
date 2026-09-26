/**
 * @fileoverview Tests for the CanvasRegistry — id minting, sliding TTL,
 * 7-day absolute cap, per-tenant cap, and sweeper. The provider is mocked so
 * tests run synchronously without DuckDB.
 * @module tests/unit/canvas/CanvasRegistry.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { validateDefinitions } from '@/linter/validate.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import {
  CanvasIdSchema,
  CanvasRegistry,
  type CanvasRegistryOptions,
} from '@/services/canvas/core/CanvasRegistry.js';
import type { IDataCanvasProvider } from '@/services/canvas/core/IDataCanvasProvider.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { IdGenerator } from '@/utils/security/idGenerator.js';

/** Stub provider — only the lifecycle methods that CanvasRegistry calls are real. */
function makeStubProvider(): IDataCanvasProvider & {
  initCalls: string[];
  destroyCalls: string[];
} {
  const initCalls: string[] = [];
  const destroyCalls: string[] = [];
  return {
    name: 'stub',
    initCalls,
    destroyCalls,
    initCanvas: vi.fn(async (id: string) => {
      initCalls.push(id);
    }),
    destroyCanvas: vi.fn(async (id: string) => {
      destroyCalls.push(id);
    }),
    registerTable: vi.fn(),
    query: vi.fn(),
    export: vi.fn(),
    describe: vi.fn(),
    drop: vi.fn(),
    clear: vi.fn(),
    healthCheck: vi.fn(async () => true),
    shutdown: vi.fn(async () => {}),
  } as unknown as IDataCanvasProvider & {
    initCalls: string[];
    destroyCalls: string[];
  };
}

const baseContext: RequestContext = {
  requestId: 'test-req',
  timestamp: '2026-01-01T00:00:00.000Z',
  tenantId: 'tenant-a',
};

const TTL = 24 * 60 * 60 * 1000;
const ABSOLUTE_CAP = 7 * 24 * 60 * 60 * 1000;

function makeOptions(overrides: Partial<CanvasRegistryOptions> = {}): CanvasRegistryOptions {
  return {
    ttlMs: TTL,
    absoluteCapMs: ABSOLUTE_CAP,
    maxCanvasesPerTenant: 100,
    sweeperIntervalMs: 0, // disable interval; tests call sweep() directly
    ...overrides,
  };
}

describe('CanvasRegistry · acquire (new)', () => {
  it('mints a 10-char URL-safe canvas ID and calls initCanvas on the provider', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), () => 1_000_000);
    const result = await registry.acquire(undefined, 'tenant-a', baseContext);
    expect(result.canvasId).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(result.isNew).toBe(true);
    expect(result.tenantId).toBe('tenant-a');
    expect(provider.initCalls).toEqual([result.canvasId]);
    expect(new Date(result.expiresAt).getTime()).toBe(1_000_000 + TTL);
    await registry.shutdown(baseContext);
  });

  it('rolls back registry and provider state when initialization fails', async () => {
    const provider = makeStubProvider();
    vi.mocked(provider.initCanvas)
      .mockRejectedValueOnce(new Error('init failed'))
      .mockResolvedValueOnce(undefined);
    const registry = new CanvasRegistry(provider, makeOptions({ maxCanvasesPerTenant: 1 }));

    await expect(registry.acquire(undefined, 'tenant-a', baseContext)).rejects.toThrow(
      'init failed',
    );
    expect(registry.countForTenant('tenant-a')).toBe(0);
    expect(provider.destroyCalls).toHaveLength(1);

    await expect(registry.acquire(undefined, 'tenant-a', baseContext)).resolves.toMatchObject({
      isNew: true,
      tenantId: 'tenant-a',
    });
    await registry.shutdown(baseContext);
  });

  it('rolls back an initialization that is cancelled while the provider is pending', async () => {
    const provider = makeStubProvider();
    let releaseInit: (() => void) | undefined;
    vi.mocked(provider.initCanvas).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseInit = resolve;
        }),
    );
    const registry = new CanvasRegistry(provider, makeOptions());
    const controller = new AbortController();

    const acquiring = registry.acquire(undefined, 'tenant-a', baseContext, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(releaseInit).toBeTypeOf('function'));
    controller.abort(new DOMException('cancelled', 'AbortError'));
    releaseInit?.();

    await expect(acquiring).rejects.toMatchObject({ name: 'AbortError' });
    expect(registry.countForTenant('tenant-a')).toBe(0);
    expect(provider.destroyCalls).toHaveLength(1);
    await registry.shutdown(baseContext);
  });
});

describe('CanvasRegistry · acquire (existing)', () => {
  it('returns the same canvas with isNew=false and extends TTL', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const first = await registry.acquire(undefined, 'tenant-a', baseContext);

    clock.mockReturnValue(2_000_000);
    const second = await registry.acquire(first.canvasId, 'tenant-a', baseContext);

    expect(second.canvasId).toBe(first.canvasId);
    expect(second.isNew).toBe(false);
    expect(new Date(second.expiresAt).getTime()).toBe(2_000_000 + TTL);
    expect(provider.initCalls).toEqual([first.canvasId]); // initCanvas not re-invoked
    await registry.shutdown(baseContext);
  });
});

// Issue #327 — a value that cannot be an id is an input error; only a
// well-formed id that is absent is a lookup miss. "Re-run the tool that
// produced this canvas_id" is unfollowable advice for an id no tool minted.
describe('CanvasRegistry · malformed vs missing ids (#327)', () => {
  /** Ids that fail the 10-char URL-safe format check. */
  const MALFORMED = ['x', 'not a real id', 'AAAAAAAAAAA', 'AAAAAAAA!!', ''] as const;

  /** Pins the structured malformed-input contract. */
  function expectMalformedShape(caught: unknown, canvasId: string): void {
    expect(caught).toBeInstanceOf(McpError);
    const err = caught as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.message).not.toMatch(/not found or expired/i);
    const data = err.data as {
      canvasId?: string;
      reason?: string;
      recovery?: { hint?: string };
    };
    expect(data.reason).toBe('canvas_id_malformed');
    expect(data.canvasId).toBe(canvasId);
    // The hint has to name the format, since re-running the producing tool
    // cannot correct a value that tool never produced.
    expect(data.recovery?.hint).toMatch(/10/);
  }

  it.each(MALFORMED)('acquire() rejects %o before any registry lookup', async (canvasId) => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    let caught: unknown;
    try {
      await registry.acquire(canvasId, 'tenant-a', baseContext);
    } catch (err) {
      caught = err;
    }
    expectMalformedShape(caught, canvasId);
    // The mint path never ran — no canvas was created for the bad id.
    expect(provider.initCalls).toEqual([]);
    expect(registry.countForTenant('tenant-a')).toBe(0);
    await registry.shutdown(baseContext);
  });

  it.each(MALFORMED)('drop() throws on %o instead of returning false', async (canvasId) => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    let caught: unknown;
    try {
      await registry.drop(canvasId, 'tenant-a', baseContext);
    } catch (err) {
      caught = err;
    }
    expectMalformedShape(caught, canvasId);
    await registry.shutdown(baseContext);
  });

  it('drop() still returns false for a well-formed id that is simply absent', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    await expect(registry.drop('AAAAAAAAAA', 'tenant-a', baseContext)).resolves.toBe(false);
    await registry.shutdown(baseContext);
  });

  it.each([
    ['missing', 'AAAAAAAAAA'],
    ['expired', 'expired'],
    ['cross-tenant', 'cross-tenant'],
  ])('acquire() keeps canvas_not_found for a well-formed but %s id', async (kind, seed) => {
    const provider = makeStubProvider();
    const clock = vi.fn(() => 1_000_000);
    const registry = new CanvasRegistry(provider, makeOptions(), clock);

    let canvasId = seed;
    let tenant = 'tenant-a';
    if (kind === 'expired') {
      canvasId = (await registry.acquire(undefined, 'tenant-a', baseContext)).canvasId;
      clock.mockReturnValue(1_000_000 + TTL + 1);
    } else if (kind === 'cross-tenant') {
      canvasId = (await registry.acquire(undefined, 'tenant-a', baseContext)).canvasId;
      tenant = 'tenant-b';
    }

    let caught: unknown;
    try {
      await registry.acquire(canvasId, tenant, baseContext);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    const err = caught as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.message).toMatch(/not found or expired/i);
    expect((err.data as { reason?: string }).reason).toBe('canvas_not_found');
    await registry.shutdown(baseContext);
  });
});

describe('CanvasIdSchema (#327)', () => {
  it('accepts every id mintId() produces and rejects malformed values', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    for (let i = 0; i < 50; i += 1) {
      const { canvasId } = await registry.acquire(undefined, `tenant-${i}`, baseContext);
      expect(CanvasIdSchema.safeParse(canvasId).success).toBe(true);
    }
    for (const bad of ['x', 'AAAAAAAAAAA', 'AAAAAAAA!!', '']) {
      expect(CanvasIdSchema.safeParse(bad).success).toBe(false);
    }
    await registry.shutdown(baseContext);
  });

  it('emits the advertised string pattern through toJSONSchema', () => {
    expect(z.toJSONSchema(CanvasIdSchema)).toMatchObject({
      type: 'string',
      pattern: '^[A-Za-z0-9_-]{10}$',
    });
    // The pattern alone reads as noise to a model; the description is what
    // makes a schema-level rejection actionable.
    expect(z.toJSONSchema(CanvasIdSchema).description).toEqual(expect.any(String));
  });

  it('passes schema-serializable inside a tool input', () => {
    const consumer = tool('canvas_consumer', {
      description: 'Accepts a canvas id shaped by the exported schema.',
      input: z.object({ canvas_id: CanvasIdSchema.optional() }),
      output: z.object({ ok: z.boolean().describe('Always true.') }),
      handler: () => ({ ok: true }),
    });

    const report = validateDefinitions({ tools: [consumer] });
    expect(
      [...report.errors, ...report.warnings].filter((d) => d.rule === 'schema-serializable'),
    ).toEqual([]);
    expect(report.passed).toBe(true);
  });
});

// Issue #261 — every registry not-found throw must carry a structured
// `reason: 'canvas_not_found'` and a default `recovery.hint`, so consumer
// tools that declare a `canvas_not_found` error contract surface reason and
// recovery on the wire (the throw happens inside the framework, before any
// handler code can rewrap it).
describe('CanvasRegistry · not-found error shape (#261)', () => {
  /** Pins the structured not-found contract: reason, canvasId, recovery hint. */
  function expectCanvasNotFoundShape(caught: unknown, canvasId: string): void {
    expect(caught).toBeInstanceOf(McpError);
    const err = caught as McpError;
    expect(err.message).toMatch(/not found or expired/i);
    // The default guidance must not steer agents toward omitting canvas_id —
    // omission mints a fresh empty canvas, and a tool that requires the id
    // would reject the retry, looping the agent.
    expect(err.message).not.toMatch(/omit/i);
    const data = err.data as {
      canvasId?: string;
      reason?: string;
      recovery?: { hint?: string };
    };
    expect(data.reason).toBe('canvas_not_found');
    expect(data.canvasId).toBe(canvasId);
    expect(typeof data.recovery?.hint).toBe('string');
    expect((data.recovery?.hint ?? '').length).toBeGreaterThan(0);
    expect(data.recovery?.hint).not.toMatch(/omit/i);
  }

  it('acquire() with an unknown id carries reason + recovery', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    let caught: unknown;
    try {
      await registry.acquire('AAAAAAAAAA', 'tenant-a', baseContext);
    } catch (err) {
      caught = err;
    }
    expectCanvasNotFoundShape(caught, 'AAAAAAAAAA');
    await registry.shutdown(baseContext);
  });

  it('touchOrThrow() carries reason + recovery', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    let caught: unknown;
    try {
      registry.touchOrThrow('AAAAAAAAAA', 'tenant-a');
    } catch (err) {
      caught = err;
    }
    expectCanvasNotFoundShape(caught, 'AAAAAAAAAA');
    await registry.shutdown(baseContext);
  });

  it('touchWithTable() carries reason + recovery', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    let caught: unknown;
    try {
      registry.touchWithTable('AAAAAAAAAA', 'tenant-a', 'my_table');
    } catch (err) {
      caught = err;
    }
    expectCanvasNotFoundShape(caught, 'AAAAAAAAAA');
    await registry.shutdown(baseContext);
  });

  it('touchWithSqlTables() carries reason + recovery', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    let caught: unknown;
    try {
      registry.touchWithSqlTables('AAAAAAAAAA', 'tenant-a', undefined, 'SELECT 1 FROM t');
    } catch (err) {
      caught = err;
    }
    expectCanvasNotFoundShape(caught, 'AAAAAAAAAA');
    await registry.shutdown(baseContext);
  });

  it('an expired canvas surfaces the same structured shape', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const first = await registry.acquire(undefined, 'tenant-a', baseContext);

    clock.mockReturnValue(1_000_000 + TTL + 1);
    let caught: unknown;
    try {
      registry.touchOrThrow(first.canvasId, 'tenant-a');
    } catch (err) {
      caught = err;
    }
    expectCanvasNotFoundShape(caught, first.canvasId);
    await registry.shutdown(baseContext);
  });
});

describe('CanvasRegistry · sliding TTL and absolute cap', () => {
  it('enforces 7-day absolute cap even with continuous touches', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const first = await registry.acquire(undefined, 'tenant-a', baseContext);

    // Walk forward in 1-hour steps for 8 days, touching each step.
    for (let elapsed = 0; elapsed < ABSOLUTE_CAP; elapsed += 60 * 60 * 1000) {
      clock.mockReturnValue(1_000_000 + elapsed);
      const r = await registry.acquire(first.canvasId, 'tenant-a', baseContext);
      expect(r.canvasId).toBe(first.canvasId);
    }

    // One step past the absolute cap — must reject.
    clock.mockReturnValue(1_000_000 + ABSOLUTE_CAP + 1);
    await expect(registry.acquire(first.canvasId, 'tenant-a', baseContext)).rejects.toThrow(
      /not found or expired/i,
    );
    await registry.shutdown(baseContext);
  });

  it('clamps expiresAt to the absolute cap when sliding extension would exceed it', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const first = await registry.acquire(undefined, 'tenant-a', baseContext);

    // Walk forward in 1-hour steps to keep the canvas alive, until we're
    // within the sliding window of the absolute cap.
    const oneHour = 60 * 60 * 1000;
    let elapsed = oneHour;
    while (elapsed < ABSOLUTE_CAP - oneHour) {
      clock.mockReturnValue(1_000_000 + elapsed);
      const r = await registry.acquire(first.canvasId, 'tenant-a', baseContext);
      // Until we're inside the last 24h before the cap, sliding wins.
      if (1_000_000 + elapsed + TTL <= 1_000_000 + ABSOLUTE_CAP) {
        expect(new Date(r.expiresAt).getTime()).toBe(1_000_000 + elapsed + TTL);
      } else {
        expect(new Date(r.expiresAt).getTime()).toBe(1_000_000 + ABSOLUTE_CAP);
      }
      elapsed += oneHour;
    }
    // Touch in the last 24h before the cap — sliding would exceed the cap,
    // so expiresAt is clamped to absolute.
    clock.mockReturnValue(1_000_000 + ABSOLUTE_CAP - oneHour);
    const last = await registry.acquire(first.canvasId, 'tenant-a', baseContext);
    expect(new Date(last.expiresAt).getTime()).toBe(1_000_000 + ABSOLUTE_CAP);
    await registry.shutdown(baseContext);
  });
});

describe('CanvasRegistry · per-tenant cap', () => {
  it('throws RateLimited when the tenant exceeds the cap', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions({ maxCanvasesPerTenant: 2 }));
    await registry.acquire(undefined, 'tenant-a', baseContext);
    await registry.acquire(undefined, 'tenant-a', baseContext);
    await expect(registry.acquire(undefined, 'tenant-a', baseContext)).rejects.toThrow(
      /active canvas cap/i,
    );
    // Other tenants are unaffected.
    await expect(registry.acquire(undefined, 'tenant-b', baseContext)).resolves.toBeTruthy();
    await registry.shutdown(baseContext);
  });

  it('countForTenant tracks active count', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    expect(registry.countForTenant('tenant-a')).toBe(0);
    await registry.acquire(undefined, 'tenant-a', baseContext);
    await registry.acquire(undefined, 'tenant-a', baseContext);
    expect(registry.countForTenant('tenant-a')).toBe(2);
    expect(registry.totalActive()).toBe(2);
    await registry.shutdown(baseContext);
  });

  // Issue #275 — the cap is a local capacity decision that shares -32003 with
  // upstream throttling. `data.reason` is what separates the two, on the wire
  // and in `mcp.tool.error_category`.
  describe('capacity refusal shape (#275)', () => {
    /** The cap refusal thrown after `maxCanvasesPerTenant` is reached. */
    async function refusal(): Promise<McpError> {
      const provider = makeStubProvider();
      const registry = new CanvasRegistry(provider, makeOptions({ maxCanvasesPerTenant: 2 }));
      await registry.acquire(undefined, 'tenant-a', baseContext);
      await registry.acquire(undefined, 'tenant-a', baseContext);
      let caught: unknown;
      try {
        await registry.acquire(undefined, 'tenant-a', baseContext);
      } catch (err) {
        caught = err;
      }
      await registry.shutdown(baseContext);
      expect(caught).toBeInstanceOf(McpError);
      return caught as McpError;
    }

    it('keeps RateLimited and carries reason, retryable, and the occupancy counts', async () => {
      const err = await refusal();

      expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(err.data).toMatchObject({
        reason: 'canvas_capacity_exhausted',
        retryable: true,
        tenantId: 'tenant-a',
        activeCount: 2,
        cap: 2,
      });
    });

    it('recovers through reuse, which is the one path open under MCP_AUTH_MODE=none', async () => {
      const hint = (await refusal()).data?.recovery as { hint?: string } | undefined;

      // Under the collapsed `default` tenant the occupied slots may belong to
      // other callers and a consumer's drop tool is off by default, so the hint
      // has to lead with passing back an id the caller already holds.
      expect(hint?.hint).toBe(
        "Pass a canvas_id you already hold instead of omitting it to create another, free a slot with this server's canvas-drop tool if it exposes one, or retry once idle canvases pass their TTL.",
      );
    });

    it('carries no advice in the message that the hint contradicts', async () => {
      const err = await refusal();

      expect(err.message).toBe('Tenant has reached the active canvas cap (2).');
      expect(err.message).not.toMatch(/drop unused canvases/i);
    });
  });
});

describe('CanvasRegistry · drop and sweep', () => {
  it('drop() destroys the canvas and decrements counts', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    const first = await registry.acquire(undefined, 'tenant-a', baseContext);
    const ok = await registry.drop(first.canvasId, 'tenant-a', baseContext);
    expect(ok).toBe(true);
    expect(provider.destroyCalls).toContain(first.canvasId);
    expect(registry.countForTenant('tenant-a')).toBe(0);
    await registry.shutdown(baseContext);
  });

  it('drop() returns false for cross-tenant canvases (no destruction leak)', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    const first = await registry.acquire(undefined, 'tenant-a', baseContext);
    const ok = await registry.drop(first.canvasId, 'tenant-b', baseContext);
    expect(ok).toBe(false);
    expect(provider.destroyCalls).not.toContain(first.canvasId);
    await registry.shutdown(baseContext);
  });

  it('sweep() destroys all expired canvases', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const a = await registry.acquire(undefined, 'tenant-a', baseContext);
    const b = await registry.acquire(undefined, 'tenant-b', baseContext);

    clock.mockReturnValue(1_000_000 + TTL + 1);
    await registry.sweep();
    expect(provider.destroyCalls.sort()).toEqual([a.canvasId, b.canvasId].sort());
    expect(registry.totalActive()).toBe(0);
    await registry.shutdown(baseContext);
  });
});

describe('CanvasRegistry · per-table TTL', () => {
  it('registerTableTtl sets expiresAt that appears in annotateDescribeResult', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const r = await registry.acquire(undefined, 'tenant-a', baseContext);

    const TABLE_TTL = 5 * 60 * 1000; // 5 min
    registry.registerTableTtl(r.canvasId, 'tenant-a', 'my_table', TABLE_TTL);

    const raw = [
      { name: 'my_table', kind: 'table' as const, rowCount: 10, columns: [] },
      { name: 'other_table', kind: 'table' as const, rowCount: 5, columns: [] },
    ];
    const annotated = registry.annotateDescribeResult(r.canvasId, 'tenant-a', raw);

    expect(annotated[0]?.expiresAt).toBe(new Date(1_000_000 + TABLE_TTL).toISOString());
    expect(annotated[1]?.expiresAt).toBeUndefined();
    await registry.shutdown(baseContext);
  });

  it('touchWithTable slides per-table expiry on registerTable', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const r = await registry.acquire(undefined, 'tenant-a', baseContext);

    const TABLE_TTL = 5 * 60 * 1000;
    registry.registerTableTtl(r.canvasId, 'tenant-a', 'my_table', TABLE_TTL);

    // Advance time and touch the table
    clock.mockReturnValue(2_000_000);
    registry.touchWithTable(r.canvasId, 'tenant-a', 'my_table');

    const raw = [{ name: 'my_table', kind: 'table' as const, rowCount: 0, columns: [] }];
    const annotated = registry.annotateDescribeResult(r.canvasId, 'tenant-a', raw);
    expect(annotated[0]?.expiresAt).toBe(new Date(2_000_000 + TABLE_TTL).toISOString());
    await registry.shutdown(baseContext);
  });

  it('touchWithSqlTables slides tables referenced in SQL text', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const r = await registry.acquire(undefined, 'tenant-a', baseContext);

    const TABLE_TTL = 5 * 60 * 1000;
    registry.registerTableTtl(r.canvasId, 'tenant-a', 'orders', TABLE_TTL);
    registry.registerTableTtl(r.canvasId, 'tenant-a', 'customers', TABLE_TTL);

    clock.mockReturnValue(2_000_000);
    registry.touchWithSqlTables(
      r.canvasId,
      'tenant-a',
      undefined,
      'SELECT * FROM orders JOIN customers ON orders.cid = customers.id',
    );

    const raw = [
      { name: 'orders', kind: 'table' as const, rowCount: 0, columns: [] },
      { name: 'customers', kind: 'table' as const, rowCount: 0, columns: [] },
    ];
    const annotated = registry.annotateDescribeResult(r.canvasId, 'tenant-a', raw);
    expect(annotated[0]?.expiresAt).toBe(new Date(2_000_000 + TABLE_TTL).toISOString());
    expect(annotated[1]?.expiresAt).toBe(new Date(2_000_000 + TABLE_TTL).toISOString());
    await registry.shutdown(baseContext);
  });

  it('sweep() drops expired table but leaves the canvas alive with remaining tables', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const r = await registry.acquire(undefined, 'tenant-a', baseContext);

    const TABLE_TTL = 10 * 60 * 1000; // 10 min
    registry.registerTableTtl(r.canvasId, 'tenant-a', 'old_table', TABLE_TTL);
    registry.registerTableTtl(r.canvasId, 'tenant-a', 'fresh_table', TABLE_TTL * 10);

    // Advance past old_table TTL but well within canvas TTL and fresh_table TTL
    clock.mockReturnValue(1_000_000 + TABLE_TTL + 1);
    await registry.sweep();

    // old_table should have been dropped via provider.drop
    expect(provider.drop).toHaveBeenCalledWith(r.canvasId, 'old_table', expect.any(Object));
    // Canvas itself is still alive (not destroyed)
    expect(provider.destroyCalls).not.toContain(r.canvasId);
    expect(registry.totalActive()).toBe(1);

    // Annotate — old_table is gone from bookkeeping, fresh_table still has expiresAt
    const raw = [
      { name: 'old_table', kind: 'table' as const, rowCount: 0, columns: [] },
      { name: 'fresh_table', kind: 'table' as const, rowCount: 0, columns: [] },
    ];
    const annotated = registry.annotateDescribeResult(r.canvasId, 'tenant-a', raw);
    expect(annotated[0]?.expiresAt).toBeUndefined(); // bookkeeping cleared
    expect(annotated[1]?.expiresAt).toBeDefined();

    await registry.shutdown(baseContext);
  });

  it('sweep ordering: table drop pass runs before canvas-level expiry check', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const r = await registry.acquire(undefined, 'tenant-a', baseContext);

    const TABLE_TTL = 10 * 60 * 1000; // 10 min
    registry.registerTableTtl(r.canvasId, 'tenant-a', 'expiring_table', TABLE_TTL);

    // Advance past both the table TTL and the canvas TTL in one step — if the
    // canvas pass ran first, the table pass would find no record and skip the drop.
    clock.mockReturnValue(1_000_000 + TTL + 1);
    await registry.sweep();

    expect(provider.drop).toHaveBeenCalledWith(r.canvasId, 'expiring_table', expect.any(Object));
    expect(provider.destroyCalls).toEqual([r.canvasId]);
    const [dropOrder] = vi.mocked(provider.drop).mock.invocationCallOrder;
    const [destroyOrder] = vi.mocked(provider.destroyCanvas).mock.invocationCallOrder;
    expect(dropOrder).toBeLessThan(destroyOrder as number);
    await registry.shutdown(baseContext);
  });

  it('dropTableBookkeeping removes the entry so annotate returns no expiresAt', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const r = await registry.acquire(undefined, 'tenant-a', baseContext);

    registry.registerTableTtl(r.canvasId, 'tenant-a', 'gone_table', 60_000);
    registry.dropTableBookkeeping(r.canvasId, 'tenant-a', 'gone_table');

    const raw = [{ name: 'gone_table', kind: 'table' as const, rowCount: 0, columns: [] }];
    const annotated = registry.annotateDescribeResult(r.canvasId, 'tenant-a', raw);
    expect(annotated[0]?.expiresAt).toBeUndefined();
    await registry.shutdown(baseContext);
  });

  it('sweep() keeps bookkeeping when provider.drop throws and retries next pass', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const r = await registry.acquire(undefined, 'tenant-a', baseContext);

    const TABLE_TTL = 10 * 60 * 1000;
    registry.registerTableTtl(r.canvasId, 'tenant-a', 'stuck_table', TABLE_TTL);

    clock.mockReturnValue(1_000_000 + TABLE_TTL + 1);
    (provider.drop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('transient'));
    await registry.sweep();

    // Drop failed — bookkeeping survives so the table is still tracked as expired.
    const raw = [{ name: 'stuck_table', kind: 'table' as const, rowCount: 0, columns: [] }];
    expect(
      registry.annotateDescribeResult(r.canvasId, 'tenant-a', raw)[0]?.expiresAt,
    ).toBeDefined();

    // Next sweep: drop succeeds, bookkeeping cleared.
    await registry.sweep();
    expect(provider.drop).toHaveBeenCalledTimes(2);
    expect(
      registry.annotateDescribeResult(r.canvasId, 'tenant-a', raw)[0]?.expiresAt,
    ).toBeUndefined();
    await registry.shutdown(baseContext);
  });
});

describe('CanvasRegistry · shutdown', () => {
  let registry: CanvasRegistry | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  beforeEach(() => {
    timer = undefined;
    registry = undefined;
  });
  afterEach(async () => {
    if (registry) await registry.shutdown(baseContext);
    if (timer) clearInterval(timer);
  });

  it('destroys all canvases and tears down the provider', async () => {
    const provider = makeStubProvider();
    registry = new CanvasRegistry(provider, makeOptions());
    await registry.acquire(undefined, 'tenant-a', baseContext);
    await registry.acquire(undefined, 'tenant-a', baseContext);
    await registry.shutdown(baseContext);
    expect(provider.destroyCalls.length).toBe(2);
    expect(provider.shutdown).toHaveBeenCalled();
    registry = undefined;
  });

  it('rejects acquire() after shutdown with a registry-shutting-down error', async () => {
    const provider = makeStubProvider();
    registry = new CanvasRegistry(provider, makeOptions());
    await registry.shutdown(baseContext);
    await expect(registry.acquire(undefined, 'tenant-a', baseContext)).rejects.toThrow(
      /shutting down/i,
    );
    // #548 — the request's tenant is log context, not client-visible data.
    await expect(registry.acquire(undefined, 'tenant-a', baseContext)).rejects.toMatchObject({
      data: undefined,
    });
    registry = undefined;
  });

  it('[Symbol.asyncDispose] shuts down the registry using a synthetic context', async () => {
    const provider = makeStubProvider();
    registry = new CanvasRegistry(provider, makeOptions());
    await registry.acquire(undefined, 'tenant-a', baseContext);

    await expect(
      (registry as unknown as { [Symbol.asyncDispose](): Promise<void> })[Symbol.asyncDispose](),
    ).resolves.toBeUndefined();

    expect(provider.destroyCalls.length).toBe(1);
    expect(provider.shutdown).toHaveBeenCalled();
    registry = undefined;
  });

  it('a second shutdown() call does not re-invoke provider.shutdown()', async () => {
    const provider = makeStubProvider();
    registry = new CanvasRegistry(provider, makeOptions());
    await registry.acquire(undefined, 'tenant-a', baseContext);

    await registry.shutdown(baseContext);
    expect(provider.shutdown).toHaveBeenCalledTimes(1);

    // Idempotent — the isShuttingDown guard short-circuits before re-tearing
    // down the provider or re-destroying (already-empty) canvases.
    await registry.shutdown(baseContext);
    expect(provider.shutdown).toHaveBeenCalledTimes(1);
    expect(provider.destroyCalls.length).toBe(1);
  });
});

describe('CanvasRegistry · mintId collision handling', () => {
  it('throws Conflict after 5 failed attempts to mint a unique canvas ID', async () => {
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions());
    // Force every mint attempt to collide by pinning the generator's output.
    const spy = vi
      .spyOn(IdGenerator.prototype, 'generateRandomString')
      .mockReturnValue('AAAAAAAAAA');
    try {
      const first = await registry.acquire(undefined, 'tenant-a', baseContext);
      expect(first.canvasId).toBe('AAAAAAAAAA');
      // Every subsequent mint attempt collides with the id already claimed above.
      await expect(registry.acquire(undefined, 'tenant-a', baseContext)).rejects.toThrow(
        /unique canvas ID/i,
      );
    } finally {
      spy.mockRestore();
      await registry.shutdown(baseContext);
    }
  });
});

describe('CanvasRegistry · sweep() after shutdown', () => {
  it('sweep() is a no-op once the registry is shutting down', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    await registry.acquire(undefined, 'tenant-a', baseContext);
    await registry.shutdown(baseContext);
    const destroyCountAfterShutdown = provider.destroyCalls.length;

    // Even with the clock walked far past every expiry, a post-shutdown sweep
    // must not touch the (already-empty) canvas map or the provider again.
    clock.mockReturnValue(1_000_000 + TTL + ABSOLUTE_CAP);
    await registry.sweep();
    expect(provider.destroyCalls.length).toBe(destroyCountAfterShutdown);
  });
});

describe('CanvasRegistry · wordBoundaryMatch correctness', () => {
  it('does not slide a table whose name is a substring of another word in the SQL', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const r = await registry.acquire(undefined, 'tenant-a', baseContext);

    const TABLE_TTL = 5 * 60 * 1000;
    // 'order' is a substring of 'orders' — a naive substring match would
    // falsely slide it; the word-boundary regex must not.
    registry.registerTableTtl(r.canvasId, 'tenant-a', 'order', TABLE_TTL);

    clock.mockReturnValue(2_000_000);
    registry.touchWithSqlTables(r.canvasId, 'tenant-a', undefined, 'SELECT * FROM orders');

    const raw = [{ name: 'order', kind: 'table' as const, rowCount: 0, columns: [] }];
    const annotated = registry.annotateDescribeResult(r.canvasId, 'tenant-a', raw);
    // Still the ORIGINAL expiry set by registerTableTtl (clock was 1_000_000
    // at that call) — touchWithSqlTables must not have slid it.
    expect(annotated[0]?.expiresAt).toBe(new Date(1_000_000 + TABLE_TTL).toISOString());
    await registry.shutdown(baseContext);
  });

  it('leaves a registered table untouched when it never appears in the SQL text', async () => {
    const clock = vi.fn(() => 1_000_000);
    const provider = makeStubProvider();
    const registry = new CanvasRegistry(provider, makeOptions(), clock);
    const r = await registry.acquire(undefined, 'tenant-a', baseContext);

    const TABLE_TTL = 5 * 60 * 1000;
    registry.registerTableTtl(r.canvasId, 'tenant-a', 'unrelated_table', TABLE_TTL);

    clock.mockReturnValue(2_000_000);
    registry.touchWithSqlTables(r.canvasId, 'tenant-a', undefined, 'SELECT * FROM orders');

    const raw = [{ name: 'unrelated_table', kind: 'table' as const, rowCount: 0, columns: [] }];
    const annotated = registry.annotateDescribeResult(r.canvasId, 'tenant-a', raw);
    expect(annotated[0]?.expiresAt).toBe(new Date(1_000_000 + TABLE_TTL).toISOString());
    await registry.shutdown(baseContext);
  });
});

/**
 * @fileoverview Behavioral tests for the `mcpTest` fixture-based Vitest test.
 * Verifies per-test freshness of `ctx` and `storage` fixtures, storage fixture
 * correctness, and the `.extend` override pattern using the function form.
 * @module tests/testing/vitest.test
 */
import { describe, expect } from 'vitest';
import { StorageService } from '@/storage/core/StorageService.js';
import type { MockContextLogger } from '@/testing/index.js';
import { createMockContext } from '@/testing/index.js';
import { mcpTest } from '@/testing/vitest.js';

// ---------------------------------------------------------------------------
// Fixture freshness — ctx
// ---------------------------------------------------------------------------

describe('mcpTest ctx fixture freshness', () => {
  // Capture log calls from each test to assert cross-test isolation
  const logCallCounts: number[] = [];

  mcpTest('first: logs a message and captures count', async ({ ctx }) => {
    ctx.log.info('first test message');
    const calls = (ctx.log as MockContextLogger).calls;
    logCallCounts.push(calls.length);
    expect(calls).toHaveLength(1);
  });

  mcpTest('second: ctx is a fresh instance — no prior logs', async ({ ctx }) => {
    // A shared ctx would have the log call from the first test above
    const calls = (ctx.log as MockContextLogger).calls;
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fixture freshness — storage
// ---------------------------------------------------------------------------

describe('mcpTest storage fixture freshness', () => {
  const rctx = (tenantId: string) => ({
    requestId: 'vitest-test',
    timestamp: new Date().toISOString(),
    tenantId,
  });

  mcpTest('first: writes a value to storage', async ({ storage }) => {
    await storage.set('canary', { written: true }, rctx('t1'));
    const val = await storage.get('canary', rctx('t1'));
    expect(val).toEqual({ written: true });
  });

  mcpTest('second: storage is a fresh instance — canary key absent', async ({ storage }) => {
    // A shared storage would still have the 'canary' key from the first test
    const val = await storage.get('canary', rctx('t1'));
    expect(val).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Storage fixture — basic StorageService contract
// ---------------------------------------------------------------------------

mcpTest('storage fixture is a real StorageService', ({ storage }) => {
  expect(storage).toBeInstanceOf(StorageService);
});

// ---------------------------------------------------------------------------
// extend — function-form override preserves per-test freshness
// ---------------------------------------------------------------------------

describe('mcpTest.extend with function-form override', () => {
  const tenantTest = mcpTest.extend<{ ctx: Awaited<ReturnType<typeof createMockContext>> }>({
    // biome-ignore lint/correctness/noEmptyPattern: vitest's fixture API requires a destructuring pattern as the first parameter
    ctx: async ({}: object, use) => {
      await use(createMockContext({ tenantId: 'override-tenant' }));
    },
  });

  tenantTest('ctx.tenantId reflects override', ({ ctx }) => {
    expect(ctx.tenantId).toBe('override-tenant');
  });

  tenantTest('each override test still gets a fresh ctx', async ({ ctx }) => {
    ctx.log.info('override test log');
    const calls = (ctx.log as MockContextLogger).calls;
    expect(calls).toHaveLength(1);
  });

  tenantTest('another override test has zero prior logs', ({ ctx }) => {
    // Fresh ctx — no logs from the previous override test
    const calls = (ctx.log as MockContextLogger).calls;
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ctx fixture — basic Context contract
// ---------------------------------------------------------------------------

mcpTest('ctx fixture has expected Context shape', ({ ctx }) => {
  expect(ctx.requestId).toBe('test-request-id');
  expect(ctx.log).toBeDefined();
  expect(ctx.state).toBeDefined();
  expect(ctx.signal).toBeDefined();
  expect(typeof ctx.enrich).toBe('function');
});

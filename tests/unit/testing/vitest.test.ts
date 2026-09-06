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
  mcpTest.for([1, 2])('ctx starts empty and remains local to case %s', async (_case, { ctx }) => {
    const calls = (ctx.log as MockContextLogger).calls;
    expect(calls).toHaveLength(0);
    expect(await ctx.state.get('canary')).toBeNull();
    ctx.log.info('local message');
    await ctx.state.set('canary', { written: true });
    expect(calls).toHaveLength(1);
    expect(await ctx.state.get('canary')).toEqual({ written: true });
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

  mcpTest.for([1, 2])(
    'storage starts empty and remains local to case %s',
    async (_case, { storage }) => {
      expect(await storage.get('canary', rctx('t1'))).toBeNull();
      await storage.set('canary', { written: true }, rctx('t1'));
      expect(await storage.get('canary', rctx('t1'))).toEqual({ written: true });
    },
  );
});

// ---------------------------------------------------------------------------
// Storage fixture — basic StorageService contract
// ---------------------------------------------------------------------------

mcpTest('storage fixture is a real StorageService', ({ storage }) => {
  expect(storage).toBeInstanceOf(StorageService);
});

mcpTest('session fixture carries a fresh HTTP session context', ({ session }) => {
  expect(session.sessionId).toBe('test-session-id');
  expect(session.ctx.sessionId).toBe(session.sessionId);
});

mcpTest('fetchMock fixture installs a strict upstream HTTP fake', async ({ fetchMock }) => {
  fetchMock.route({
    match: 'https://api.example.test/fixture',
    respond: Response.json({ ok: true }),
  });

  const response = await fetch('https://api.example.test/fixture');
  await expect(response.json()).resolves.toEqual({ ok: true });
  expect(fetchMock.calls).toHaveLength(1);
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
    const calls = (ctx.log as MockContextLogger).calls;
    expect(calls).toHaveLength(0);
    ctx.log.info('override test log');
    expect(calls).toHaveLength(1);
  });

  tenantTest('another override test has zero prior logs', ({ ctx }) => {
    const calls = (ctx.log as MockContextLogger).calls;
    expect(calls).toHaveLength(0);
    ctx.log.info('another local message');
    expect(calls).toHaveLength(1);
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

/**
 * @fileoverview Tests for createContext — the internal factory that builds the
 * unified Context every tool/resource handler receives.
 * Covers: field assembly, tenant defaulting, ctx.log correlation, ctx.state
 * scoping, ctx.progress lifecycle, and optional capability wiring.
 * @module tests/context.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — `vi.mock` factories are hoisted above imports, so `mockLogger` must
// be created inside `vi.hoisted` to beat the import evaluation order.
// ---------------------------------------------------------------------------

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    crit: vi.fn(),
    emerg: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('@/config/index.js', () => ({
  config: {
    environment: 'testing',
    mcpServerVersion: '1.0.0-test',
    mcpAuthMode: 'none',
  },
}));

vi.mock('@/utils/internal/logger.js', () => ({
  logger: mockLogger,
  Logger: { getInstance: () => mockLogger },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { z } from 'zod';

import type { ContextDeps } from '@/core/context.js';
import { attachTypedFail, createContext } from '@/core/context.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import type { Logger } from '@/utils/internal/logger.js';
import { createFakeStorage, makeRequestContext } from '../helpers/index.js';

// Local wrapper uses this file's mockLogger so assertions on log calls work.
function makeDeps(overrides: Partial<ContextDeps> = {}): ContextDeps {
  return {
    appContext: makeRequestContext(),
    logger: mockLogger as unknown as Logger,
    storage: createFakeStorage() as unknown as ContextDeps['storage'],
    signal: new AbortController().signal,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Identity & tracing fields
  // -----------------------------------------------------------------------

  describe('Identity and tracing fields', () => {
    it('should carry requestId and timestamp from RequestContext', () => {
      const ctx = createContext(makeDeps());

      expect(ctx.requestId).toBe('req-001');
      expect(ctx.timestamp).toBe('2026-01-01T00:00:00.000Z');
    });

    it('should carry traceId and spanId from RequestContext', () => {
      const ctx = createContext(
        makeDeps({
          appContext: makeRequestContext({
            traceId: 'trace-abc',
            spanId: 'span-def',
          }),
        }),
      );

      expect(ctx.traceId).toBe('trace-abc');
      expect(ctx.spanId).toBe('span-def');
    });

    it('should leave traceId/spanId undefined when not present on RequestContext', () => {
      const ctx = createContext(makeDeps());

      expect(ctx.traceId).toBeUndefined();
      expect(ctx.spanId).toBeUndefined();
    });

    it('should carry auth from RequestContext', () => {
      const auth = { clientId: 'client-1', scopes: ['read'], sub: 'user-1', token: 'tok' };
      const ctx = createContext(
        makeDeps({
          appContext: makeRequestContext({ auth }),
        }),
      );

      expect(ctx.auth).toEqual(auth);
    });

    it('should forward sessionId from deps when provided', () => {
      const ctx = createContext(makeDeps({ sessionId: 'sess-abc-123' }));

      expect(ctx.sessionId).toBe('sess-abc-123');
    });

    it('should leave sessionId undefined when not provided in deps', () => {
      const ctx = createContext(makeDeps());

      expect(ctx.sessionId).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Tenant defaulting
  // -----------------------------------------------------------------------

  describe('Tenant defaulting', () => {
    it('should preserve explicit tenantId from RequestContext', () => {
      const ctx = createContext(
        makeDeps({
          appContext: makeRequestContext({ tenantId: 'tenant-42' }),
        }),
      );

      expect(ctx.tenantId).toBe('tenant-42');
    });

    it('should default tenantId to "default" when not set (stdio mode)', () => {
      // Omit tenantId entirely to simulate stdio mode
      const appContext = makeRequestContext();
      delete (appContext as any).tenantId;
      const ctx = createContext(makeDeps({ appContext }));

      expect(ctx.tenantId).toBe('default');
    });

    it('should default tenantId to "default" when HTTP + MCP_AUTH_MODE=none (issue #87)', () => {
      vi.stubEnv('MCP_TRANSPORT_TYPE', 'http');
      vi.stubEnv('MCP_AUTH_MODE', 'none');
      try {
        const appContext = makeRequestContext();
        delete (appContext as any).tenantId;
        const ctx = createContext(makeDeps({ appContext }));

        expect(ctx.tenantId).toBe('default');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('should leave tenantId undefined when HTTP + MCP_AUTH_MODE=jwt and tid is missing (fail-closed)', async () => {
      vi.stubEnv('MCP_TRANSPORT_TYPE', 'http');
      vi.stubEnv('MCP_AUTH_MODE', 'jwt');
      try {
        const appContext = makeRequestContext();
        delete (appContext as any).tenantId;
        const ctx = createContext(makeDeps({ appContext }));

        expect(ctx.tenantId).toBeUndefined();
        // ctx.state must throw rather than silently share state across authenticated callers.
        await expect(ctx.state.set('k', 'v')).rejects.toThrow(/tenantId required/);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('should leave tenantId undefined when HTTP + MCP_AUTH_MODE=oauth and tid is missing (fail-closed)', async () => {
      vi.stubEnv('MCP_TRANSPORT_TYPE', 'http');
      vi.stubEnv('MCP_AUTH_MODE', 'oauth');
      try {
        const appContext = makeRequestContext();
        delete (appContext as any).tenantId;
        const ctx = createContext(makeDeps({ appContext }));

        expect(ctx.tenantId).toBeUndefined();
        await expect(ctx.state.set('k', 'v')).rejects.toThrow(/tenantId required/);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  // -----------------------------------------------------------------------
  // ctx.log — correlation
  // -----------------------------------------------------------------------

  describe('ctx.log correlation', () => {
    it('should produce a logger with all 5 level methods', () => {
      const ctx = createContext(makeDeps());

      expect(typeof ctx.log.debug).toBe('function');
      expect(typeof ctx.log.info).toBe('function');
      expect(typeof ctx.log.notice).toBe('function');
      expect(typeof ctx.log.warning).toBe('function');
      expect(typeof ctx.log.error).toBe('function');
    });

    it('should pass RequestContext fields with every log call', () => {
      const appContext = makeRequestContext({
        tenantId: 'tenant-x',
        traceId: 'trace-123',
      });
      const ctx = createContext(makeDeps({ appContext }));

      ctx.log.info('test message', { extra: 'data' });

      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      const [msg, passedContext] = mockLogger.info.mock.calls[0]!;
      expect(msg).toBe('test message');
      // The enriched context should spread RequestContext + extra data
      expect(passedContext).toMatchObject({
        requestId: 'req-001',
        tenantId: 'tenant-x',
        traceId: 'trace-123',
        extra: 'data',
      });
    });

    it('should pass RequestContext without extra data when data is omitted', () => {
      const ctx = createContext(makeDeps());

      ctx.log.debug('bare message');

      const [, passedContext] = mockLogger.debug.mock.calls[0]!;
      expect(passedContext.requestId).toBe('req-001');
    });

    it('should pass error object to logger.error when provided', () => {
      const ctx = createContext(makeDeps());
      const err = new Error('boom');

      ctx.log.error('something failed', err, { detail: 'info' });

      expect(mockLogger.error).toHaveBeenCalledTimes(1);
      const [msg, errorArg, contextArg] = mockLogger.error.mock.calls[0]!;
      expect(msg).toBe('something failed');
      expect(errorArg).toBe(err);
      expect(contextArg).toMatchObject({ requestId: 'req-001', detail: 'info' });
    });

    it('should call logger.error with enriched context when no Error is provided', () => {
      const ctx = createContext(makeDeps());

      ctx.log.error('bad thing happened');

      expect(mockLogger.error).toHaveBeenCalledTimes(1);
      const args = mockLogger.error.mock.calls[0]!;
      // When no Error object: logger.error(msg, enrichedContext)
      expect(args[0]).toBe('bad thing happened');
      expect(args[1]).toMatchObject({ requestId: 'req-001' });
      // Should NOT have a third argument
      expect(args).toHaveLength(2);
    });

    it('ctx.log should use the defaulted tenantId, not the original undefined', () => {
      const appContext = makeRequestContext();
      delete (appContext as any).tenantId;
      const ctx = createContext(makeDeps({ appContext }));

      ctx.log.info('check tenant');

      const [, passedContext] = mockLogger.info.mock.calls[0]!;
      expect(passedContext.tenantId).toBe('default');
    });
  });

  // -----------------------------------------------------------------------
  // ctx.state — tenant-scoped storage
  // -----------------------------------------------------------------------

  describe('ctx.state', () => {
    it('should delegate set/get/delete to StorageService with tenant context', async () => {
      const storage = createFakeStorage();
      const ctx = createContext(
        makeDeps({
          appContext: makeRequestContext({ tenantId: 'tenant-a' }),
          storage: storage as any,
        }),
      );

      await ctx.state.set('key1', 'value1');
      const val = await ctx.state.get('key1');

      expect(val).toBe('value1');
      expect(storage.set).toHaveBeenCalledWith(
        'key1',
        'value1',
        expect.objectContaining({ tenantId: 'tenant-a' }),
        undefined,
      );
    });

    it('should isolate state between tenants', async () => {
      const storage = createFakeStorage();

      const ctxA = createContext(
        makeDeps({
          appContext: makeRequestContext({ tenantId: 'tenant-a', requestId: 'r1' }),
          storage: storage as any,
        }),
      );
      const ctxB = createContext(
        makeDeps({
          appContext: makeRequestContext({ tenantId: 'tenant-b', requestId: 'r2' }),
          storage: storage as any,
        }),
      );

      await ctxA.state.set('shared-key', 'a-value');
      await ctxB.state.set('shared-key', 'b-value');

      expect(await ctxA.state.get('shared-key')).toBe('a-value');
      expect(await ctxB.state.get('shared-key')).toBe('b-value');
    });

    it('should accept and return non-string values (generic get/set)', async () => {
      const storage = createFakeStorage();
      const ctx = createContext(
        makeDeps({
          appContext: makeRequestContext({ tenantId: 'tenant-a' }),
          storage: storage as any,
        }),
      );

      const data = { count: 42, tags: ['a', 'b'] };
      await ctx.state.set('obj', data);
      const result = await ctx.state.get('obj');
      expect(result).toEqual(data);
    });

    it('should support getMany for batch reads', async () => {
      const storage = createFakeStorage();
      const ctx = createContext(
        makeDeps({
          appContext: makeRequestContext({ tenantId: 'tenant-a' }),
          storage: storage as any,
        }),
      );

      await ctx.state.set('k1', 'v1');
      await ctx.state.set('k2', 'v2');
      const results = await ctx.state.getMany(['k1', 'k2', 'k3']);
      expect(results.get('k1')).toBe('v1');
      expect(results.get('k2')).toBe('v2');
      expect(results.has('k3')).toBe(false);
    });

    it('should support setMany for batch writes', async () => {
      const storage = createFakeStorage();
      const ctx = createContext(
        makeDeps({
          appContext: makeRequestContext({ tenantId: 'tenant-a' }),
          storage: storage as any,
        }),
      );

      await ctx.state.setMany(
        new Map([
          ['a', 1],
          ['b', 2],
        ]),
      );
      expect(await ctx.state.get('a')).toBe(1);
      expect(await ctx.state.get('b')).toBe(2);
    });

    it('should support deleteMany for batch deletes', async () => {
      const storage = createFakeStorage();
      const ctx = createContext(
        makeDeps({
          appContext: makeRequestContext({ tenantId: 'tenant-a' }),
          storage: storage as any,
        }),
      );

      await ctx.state.set('x', 1);
      await ctx.state.set('y', 2);
      const count = await ctx.state.deleteMany(['x', 'y', 'z']);
      expect(count).toBe(2);
      expect(await ctx.state.get('x')).toBeNull();
    });

    it('should work with defaulted tenantId ("default") in stdio mode', async () => {
      const storage = createFakeStorage();
      const appContext = makeRequestContext();
      delete (appContext as any).tenantId;
      const ctx = createContext(
        makeDeps({
          appContext,
          storage: storage as any,
        }),
      );

      // Should not throw — tenantId defaults to 'default'
      await ctx.state.set('key', 'val');
      const result = await ctx.state.get('key');
      expect(result).toBe('val');
    });

    it('should validate with Zod schema on get when schema is provided', async () => {
      const storage = createFakeStorage();
      const ctx = createContext(
        makeDeps({
          appContext: makeRequestContext({ tenantId: 'tenant-a' }),
          storage: storage as any,
        }),
      );

      const ItemSchema = z.object({ name: z.string(), count: z.number() });

      await ctx.state.set('item', { name: 'Widget', count: 5 });
      const result = await ctx.state.get('item', ItemSchema);
      expect(result).toEqual({ name: 'Widget', count: 5 });
    });

    it('should throw ZodError when schema validation fails on get', async () => {
      const storage = createFakeStorage();
      const ctx = createContext(
        makeDeps({
          appContext: makeRequestContext({ tenantId: 'tenant-a' }),
          storage: storage as any,
        }),
      );

      const ItemSchema = z.object({ name: z.string(), count: z.number() });

      await ctx.state.set('item', { name: 123, count: 'not a number' });
      await expect(ctx.state.get('item', ItemSchema)).rejects.toThrow();
    });

    it('should return null when key missing even with schema', async () => {
      const storage = createFakeStorage();
      const ctx = createContext(
        makeDeps({
          appContext: makeRequestContext({ tenantId: 'tenant-a' }),
          storage: storage as any,
        }),
      );

      const result = await ctx.state.get('nonexistent', z.object({ x: z.number() }));
      expect(result).toBeNull();
    });

    it('should pass TTL option through to storage on set', async () => {
      const storage = createFakeStorage();
      const ctx = createContext(
        makeDeps({
          appContext: makeRequestContext({ tenantId: 'tenant-a' }),
          storage: storage as any,
        }),
      );

      await ctx.state.set('ephemeral', 'data', { ttl: 3600 });

      expect(storage.set).toHaveBeenCalledWith(
        'ephemeral',
        'data',
        expect.objectContaining({ tenantId: 'tenant-a' }),
        { ttl: 3600 },
      );
    });

    it('should pass TTL option through to storage on setMany', async () => {
      const storage = createFakeStorage();
      const ctx = createContext(
        makeDeps({
          appContext: makeRequestContext({ tenantId: 'tenant-a' }),
          storage: storage as any,
        }),
      );

      const entries = new Map([
        ['a', 1],
        ['b', 2],
      ]);
      await ctx.state.setMany(entries, { ttl: 600 });

      expect(storage.setMany).toHaveBeenCalledWith(
        entries,
        expect.objectContaining({ tenantId: 'tenant-a' }),
        { ttl: 600 },
      );
    });

    it('should list keys with hydrated values', async () => {
      const storage = createFakeStorage();
      const ctx = createContext(
        makeDeps({
          appContext: makeRequestContext({ tenantId: 'tenant-a' }),
          storage: storage as any,
        }),
      );

      await ctx.state.set('item:1', { name: 'A' });
      await ctx.state.set('item:2', { name: 'B' });
      await ctx.state.set('other:1', { name: 'C' });

      const page = await ctx.state.list('item:');
      expect(page.items).toEqual([
        { key: 'item:1', value: { name: 'A' } },
        { key: 'item:2', value: { name: 'B' } },
      ]);
      expect(page.cursor).toBeUndefined();
    });

    it('should return empty items when no keys match prefix', async () => {
      const storage = createFakeStorage();
      const ctx = createContext(
        makeDeps({
          appContext: makeRequestContext({ tenantId: 'tenant-a' }),
          storage: storage as any,
        }),
      );

      const page = await ctx.state.list('nonexistent:');
      expect(page.items).toEqual([]);
      expect(page.cursor).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // ctx.signal
  // -----------------------------------------------------------------------

  describe('ctx.signal', () => {
    it('should carry the provided AbortSignal', () => {
      const controller = new AbortController();
      const ctx = createContext(makeDeps({ signal: controller.signal }));

      expect(ctx.signal).toBe(controller.signal);
      expect(ctx.signal.aborted).toBe(false);

      controller.abort();
      expect(ctx.signal.aborted).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Optional capabilities
  // -----------------------------------------------------------------------

  describe('Optional capabilities', () => {
    it('should include elicit when provided', () => {
      const elicit = vi.fn();
      const ctx = createContext(makeDeps({ elicit: elicit as any }));

      expect(ctx.elicit).toBe(elicit);
    });

    it('should leave elicit undefined when not provided', () => {
      const ctx = createContext(makeDeps());

      expect(ctx.elicit).toBeUndefined();
    });

    it('should include sample when provided', () => {
      const sample = vi.fn();
      const ctx = createContext(makeDeps({ sample: sample as any }));

      expect(ctx.sample).toBe(sample);
    });

    it('should include uri when provided', () => {
      const uri = new URL('myscheme://item/123');
      const ctx = createContext(makeDeps({ uri }));

      expect(ctx.uri).toBe(uri);
    });

    it('should include notifyResourceUpdated when provided', () => {
      const notifyResourceUpdated = vi.fn();
      const ctx = createContext(makeDeps({ notifyResourceUpdated }));

      expect(ctx.notifyResourceUpdated).toBe(notifyResourceUpdated);
    });

    it('should include notifyResourceListChanged when provided', () => {
      const notifyResourceListChanged = vi.fn();
      const ctx = createContext(makeDeps({ notifyResourceListChanged }));

      expect(ctx.notifyResourceListChanged).toBe(notifyResourceListChanged);
    });

    it('should leave notification methods undefined when not provided', () => {
      const ctx = createContext(makeDeps());

      expect(ctx.notifyResourceUpdated).toBeUndefined();
      expect(ctx.notifyResourceListChanged).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // ctx.progress
  // -----------------------------------------------------------------------

  describe('ctx.progress', () => {
    it('should be undefined when no taskCtx is provided', () => {
      const ctx = createContext(makeDeps());

      expect(ctx.progress).toBeUndefined();
    });

    it('should create ContextProgress when taskCtx is provided', async () => {
      const mockStore = {
        updateTaskStatus: vi.fn(),
      };

      const ctx = createContext(
        makeDeps({
          taskCtx: { store: mockStore as any, taskId: 'task-001' },
        }),
      );

      expect(ctx.progress).toBeDefined();

      await ctx.progress!.setTotal(10);
      await ctx.progress!.increment();
      await ctx.progress!.update('halfway there');

      expect(mockStore.updateTaskStatus).toHaveBeenCalledWith(
        'task-001',
        'working',
        '10% complete',
      );
      expect(mockStore.updateTaskStatus).toHaveBeenCalledWith(
        'task-001',
        'working',
        'halfway there',
      );
    });

    it('should track percentage correctly through increment', async () => {
      const mockStore = { updateTaskStatus: vi.fn() };

      const ctx = createContext(
        makeDeps({
          taskCtx: { store: mockStore as any, taskId: 'task-002' },
        }),
      );

      await ctx.progress!.setTotal(4);
      await ctx.progress!.increment(); // 25%
      await ctx.progress!.increment(); // 50%
      await ctx.progress!.increment(2); // 100%

      const calls = mockStore.updateTaskStatus.mock.calls;
      expect(calls[0]).toEqual(['task-002', 'working', '25% complete']);
      expect(calls[1]).toEqual(['task-002', 'working', '50% complete']);
      expect(calls[2]).toEqual(['task-002', 'working', '100% complete']);
    });

    it('should pass undefined message when incrementing without setTotal', async () => {
      const mockStore = { updateTaskStatus: vi.fn() };

      const ctx = createContext(
        makeDeps({
          taskCtx: { store: mockStore as any, taskId: 'task-003' },
        }),
      );

      // No setTotal — total stays 0
      await ctx.progress!.increment();
      await ctx.progress!.increment(3);

      const calls = mockStore.updateTaskStatus.mock.calls;
      // percentage is undefined when total is 0
      expect(calls[0]).toEqual(['task-003', 'working', undefined]);
      expect(calls[1]).toEqual(['task-003', 'working', undefined]);
    });
  });

  // -----------------------------------------------------------------------
  // ctx.recoveryFor — opt-in contract resolution helper (#88 / #89)
  // -----------------------------------------------------------------------

  describe('ctx.recoveryFor', () => {
    it('exists as a no-op resolver on bare Context (no contract attached)', () => {
      const ctx = createContext(makeDeps());

      expect(typeof ctx.recoveryFor).toBe('function');
      // Spread-safe: returns {} for any reason when no contract is attached.
      expect(ctx.recoveryFor('anything')).toEqual({});
    });

    it('resolves declared reasons after attachTypedFail wires a contract', () => {
      const ctx = attachTypedFail(createContext(makeDeps()), [
        {
          reason: 'no_match',
          code: JsonRpcErrorCode.NotFound,
          when: 'No items matched',
          recovery: 'Try a different identifier and retry the call.',
        },
      ]);

      expect(ctx.recoveryFor('no_match')).toEqual({
        recovery: { hint: 'Try a different identifier and retry the call.' },
      });
    });

    it('returns {} for an unknown reason on a contract-attached context', () => {
      const ctx = attachTypedFail(createContext(makeDeps()), [
        {
          reason: 'no_match',
          code: JsonRpcErrorCode.NotFound,
          when: 'No items matched',
          recovery: 'Try a different identifier and retry the call.',
        },
      ]);

      // Unknown reason — TS prevents this for typed callers; runtime is loose.
      expect(ctx.recoveryFor('typo_reason')).toEqual({});
    });

    it('integrates with ctx.fail via spread without overriding caller fields', () => {
      const ctx = attachTypedFail(createContext(makeDeps()), [
        {
          reason: 'rate_limited',
          code: JsonRpcErrorCode.RateLimited,
          when: 'Upstream throttled',
          retryable: true,
          recovery: 'Wait a few seconds before retrying.',
        },
      ]);

      const err = (ctx as any).fail('rate_limited', 'Upstream slowed down', {
        attempt: 3,
        ...ctx.recoveryFor('rate_limited'),
      });

      expect(err.data).toEqual({
        reason: 'rate_limited',
        attempt: 3,
        recovery: { hint: 'Wait a few seconds before retrying.' },
      });
    });
  });
});

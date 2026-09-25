/**
 * @fileoverview Shared test helpers for building mock RequestContexts and
 * storage fakes. Consolidates patterns that would otherwise be duplicated
 * across unit tests.
 * @module tests/helpers/context-helpers
 */
import { vi } from 'vitest';
import type { RequestContext } from '@/utils/internal/requestContext.js';

/** Minimal in-memory `StorageService` fake, scoped per tenant, for `createContext` tests. */
export function createFakeStorage() {
  const store = new Map<string, Map<string, unknown>>();

  const tenantStore = (tenantId: string) => {
    let ts = store.get(tenantId);
    if (!ts) {
      ts = new Map();
      store.set(tenantId, ts);
    }
    return ts;
  };

  return {
    _store: store,
    get: vi.fn(async <T>(key: string, ctx: RequestContext): Promise<T | null> => {
      const ts = tenantStore(ctx.tenantId!);
      return (ts.get(key) as T) ?? null;
    }),
    set: vi.fn(async (key: string, value: unknown, ctx: RequestContext) => {
      tenantStore(ctx.tenantId!).set(key, value);
    }),
    delete: vi.fn(async (key: string, ctx: RequestContext) => {
      tenantStore(ctx.tenantId!).delete(key);
    }),
    list: vi.fn(
      async (prefix: string, ctx: RequestContext, _opts?: { cursor?: string; limit?: number }) => {
        const ts = tenantStore(ctx.tenantId!);
        const keys = [...ts.keys()].filter((k) => !prefix || k.startsWith(prefix));
        return { keys, nextCursor: undefined };
      },
    ),
    getMany: vi.fn(async <T>(keys: string[], ctx: RequestContext) => {
      const ts = tenantStore(ctx.tenantId!);
      const result = new Map<string, T>();
      for (const key of keys) if (ts.has(key)) result.set(key, ts.get(key) as T);
      return result;
    }),
    setMany: vi.fn(async (entries: Map<string, unknown>, ctx: RequestContext) => {
      const ts = tenantStore(ctx.tenantId!);
      for (const [key, value] of entries) ts.set(key, value);
    }),
    deleteMany: vi.fn(async (keys: string[], ctx: RequestContext) => {
      const ts = tenantStore(ctx.tenantId!);
      let count = 0;
      for (const key of keys) if (ts.delete(key)) count++;
      return count;
    }),
  };
}

/** Build a `RequestContext` with sane defaults for tests. */
export function makeRequestContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: 'req-001',
    timestamp: '2026-01-01T00:00:00.000Z',
    operation: 'test',
    ...overrides,
  };
}

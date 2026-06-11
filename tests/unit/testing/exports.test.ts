/**
 * @fileoverview Verifies the public test helpers exported from `@/testing`
 * and the `@/testing/vitest` subpath. Covers `createMockLogger`,
 * `createInMemoryStorage`, and the `mcpTest` fixture.
 * @module tests/testing/exports.test
 */
import { describe, expect, it } from 'vitest';
import { StorageService } from '@/storage/core/StorageService.js';
import { createInMemoryStorage, createMockLogger } from '@/testing/index.js';
import { mcpTest } from '@/testing/vitest.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

function rctx(tenantId: string): RequestContext {
  return { requestId: 'exports-test', timestamp: new Date().toISOString(), tenantId };
}

describe('./testing/vitest subpath', () => {
  it('exports mcpTest as a function', () => {
    expect(typeof mcpTest).toBe('function');
  });

  it('mcpTest has an extend method', () => {
    expect(typeof mcpTest.extend).toBe('function');
  });
});

describe('createMockLogger', () => {
  it('records calls across every level', () => {
    const log = createMockLogger();

    log.debug('d', { a: 1 });
    log.info('i');
    log.notice('n');
    log.warning('w');
    log.error('e', new Error('boom'), { x: 2 });

    expect(log.calls).toEqual([
      { level: 'debug', msg: 'd', data: { a: 1 } },
      { level: 'info', msg: 'i', data: undefined },
      { level: 'notice', msg: 'n', data: undefined },
      { level: 'warning', msg: 'w', data: undefined },
      { level: 'error', msg: 'e', data: { x: 2 } },
    ]);
  });

  it('each call is isolated to its own logger instance', () => {
    const a = createMockLogger();
    const b = createMockLogger();

    a.info('only a');
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
  });
});

describe('createInMemoryStorage', () => {
  it('returns a real StorageService instance', () => {
    const storage = createInMemoryStorage();
    expect(storage).toBeInstanceOf(StorageService);
  });

  it('round-trips values through the StorageService façade with tenant isolation', async () => {
    const storage = createInMemoryStorage();
    const ctxA = rctx('tenant-a');
    const ctxB = rctx('tenant-b');

    await storage.set('key', { v: 1 }, ctxA);
    await storage.set('key', { v: 2 }, ctxB);

    expect(await storage.get('key', ctxA)).toEqual({ v: 1 });
    expect(await storage.get('key', ctxB)).toEqual({ v: 2 });
  });

  it('respects the maxEntries option', async () => {
    const storage = createInMemoryStorage({ maxEntries: 2 });
    const ctx = rctx('cap');

    await storage.set('a', 1, ctx);
    await storage.set('b', 2, ctx);
    await expect(storage.set('c', 3, ctx)).rejects.toThrow();
  });

  it('lists keys by prefix', async () => {
    const storage = createInMemoryStorage();
    const ctx = rctx('listing');

    await storage.set('prefix-1', 'x', ctx);
    await storage.set('prefix-2', 'y', ctx);
    await storage.set('other-1', 'z', ctx);

    const result = await storage.list('prefix-', ctx);
    expect(result.keys.sort()).toEqual(['prefix-1', 'prefix-2']);
  });
});

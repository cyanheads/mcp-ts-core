/**
 * @fileoverview Verifies the public test helpers exported from `@/testing`:
 * `createMockLogger` and `createInMemoryStorage`.
 * @module tests/testing/exports.test
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryStorage, createMockLogger } from '@/testing/index.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

function rctx(tenantId: string): RequestContext {
  return { requestId: 'exports-test', timestamp: new Date().toISOString(), tenantId };
}

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
  it('respects the maxEntries option', async () => {
    const storage = createInMemoryStorage({ maxEntries: 2 });
    const ctx = rctx('cap');

    await storage.set('a', 1, ctx);
    await storage.set('b', 2, ctx);
    await expect(storage.set('c', 3, ctx)).rejects.toThrow();
  });
});

/**
 * @fileoverview Focused unit tests for uncovered mock context helper behavior.
 * @module tests/testing/mockContext.test
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createMockContext } from '@/testing/index.js';

describe('createMockContext helpers', () => {
  it('records all logger levels, including error calls', () => {
    const ctx = createMockContext();
    const log = ctx.log as unknown as {
      calls: Array<{ level: string; msg: string; data?: unknown }>;
    };

    ctx.log.debug('debug message', { phase: 'start' });
    ctx.log.info('info message');
    ctx.log.notice('notice message');
    ctx.log.warning('warning message', { scope: 'testing' });
    ctx.log.error('error message', new Error('boom'), { reason: 'failure' });

    expect(log.calls).toEqual([
      { level: 'debug', msg: 'debug message', data: { phase: 'start' } },
      { level: 'info', msg: 'info message', data: undefined },
      { level: 'notice', msg: 'notice message', data: undefined },
      { level: 'warning', msg: 'warning message', data: { scope: 'testing' } },
      { level: 'error', msg: 'error message', data: { reason: 'failure' } },
    ]);
  });

  it('supports schema-aware state reads and batch state operations', async () => {
    const ctx = createMockContext({ tenantId: 'tenant-1' });

    await ctx.state.set('profile:1', { name: 'Casey', active: true });
    await ctx.state.setMany(
      new Map<string, unknown>([
        ['profile:2', { name: 'Morgan', active: false }],
        ['misc:1', { kind: 'other' }],
      ]),
    );

    await expect(
      ctx.state.get(
        'profile:1',
        z.object({
          name: z.string(),
          active: z.boolean(),
        }),
      ),
    ).resolves.toEqual({ name: 'Casey', active: true });

    await expect(ctx.state.getMany(['profile:1', 'profile:2', 'missing'])).resolves.toEqual(
      new Map([
        ['profile:1', { name: 'Casey', active: true }],
        ['profile:2', { name: 'Morgan', active: false }],
      ]),
    );

    await expect(ctx.state.list('profile:')).resolves.toEqual({
      items: [
        { key: 'profile:1', value: { name: 'Casey', active: true } },
        { key: 'profile:2', value: { name: 'Morgan', active: false } },
      ],
    });

    await expect(ctx.state.deleteMany(['profile:2', 'missing'])).resolves.toBe(1);
    await expect(ctx.state.get('profile:2')).resolves.toBeNull();
  });

  it('throws for state operations when no tenant is configured', async () => {
    const ctx = createMockContext();

    expect(() => ctx.state.set('key', 'value')).toThrow('tenantId required for state operations');
    expect(() => ctx.state.deleteMany(['a', 'b'])).toThrow(
      'tenantId required for state operations',
    );
    expect(() => ctx.state.getMany(['a'])).toThrow('tenantId required for state operations');
    expect(() => ctx.state.setMany(new Map<string, unknown>([['a', 1]]))).toThrow(
      'tenantId required for state operations',
    );
    expect(() => ctx.state.list('prefix')).toThrow('tenantId required for state operations');
  });

  it('tracks progress totals, clamps increments, and stores update messages', async () => {
    const ctx = createMockContext({ progress: true });
    const progress = ctx.progress as {
      _completed: number;
      _messages: string[];
      _total: number;
      increment: (amount?: number) => Promise<void>;
      setTotal: (n: number) => Promise<void>;
      update: (message: string) => Promise<void>;
    };

    await progress.setTotal(3);
    await progress.increment();
    await progress.increment(5);
    await progress.update('step one');
    await progress.update('step two');

    expect(progress._total).toBe(3);
    expect(progress._completed).toBe(3);
    expect(progress._messages).toEqual(['step one', 'step two']);
  });

  it('increments without a total when progress is unbounded', async () => {
    const ctx = createMockContext({ progress: true });
    const progress = ctx.progress as unknown as {
      _completed: number;
      _total: number;
      increment: (amount?: number) => Promise<void>;
    };

    await progress.increment(2);

    expect(progress._total).toBe(0);
    expect(progress._completed).toBe(2);
  });

  it('applies requestId defaults and passes through optional handlers', () => {
    const notifyResourceListChanged = () => {};
    const notifyResourceUpdated = (_uri: string) => {};
    const uri = new URL('test://resource/1');

    const defaultCtx = createMockContext();
    const customCtx = createMockContext({
      notifyResourceListChanged,
      notifyResourceUpdated,
      requestId: 'custom-request-id',
      uri,
    });

    expect(defaultCtx.requestId).toBe('test-request-id');
    expect(customCtx.requestId).toBe('custom-request-id');
    expect(customCtx.notifyResourceListChanged).toBe(notifyResourceListChanged);
    expect(customCtx.notifyResourceUpdated).toBe(notifyResourceUpdated);
    expect(customCtx.uri).toBe(uri);
  });

  it('forwards sessionId when provided, leaves undefined by default', () => {
    const withSession = createMockContext({ sessionId: 'sess-xyz' });
    const withoutSession = createMockContext();

    expect(withSession.sessionId).toBe('sess-xyz');
    expect(withoutSession.sessionId).toBeUndefined();
  });
});

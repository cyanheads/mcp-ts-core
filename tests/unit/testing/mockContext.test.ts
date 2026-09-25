/**
 * @fileoverview Focused unit tests for uncovered mock context helper behavior.
 * @module tests/testing/mockContext.test
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createMockContext } from '@/testing/index.js';

describe('createMockContext helpers', () => {
  it('supports schema-aware state reads and batch state operations', async () => {
    const ctx = createMockContext({ tenantId: 'tenant-1' });

    await ctx.state.set('profile/1', { name: 'Casey', active: true });
    await ctx.state.setMany(
      new Map<string, unknown>([
        ['profile/2', { name: 'Morgan', active: false }],
        ['misc/1', { kind: 'other' }],
      ]),
    );

    await expect(
      ctx.state.get(
        'profile/1',
        z.object({
          name: z.string(),
          active: z.boolean(),
        }),
      ),
    ).resolves.toEqual({ name: 'Casey', active: true });

    await expect(ctx.state.getMany(['profile/1', 'profile/2', 'missing'])).resolves.toEqual(
      new Map([
        ['profile/1', { name: 'Casey', active: true }],
        ['profile/2', { name: 'Morgan', active: false }],
      ]),
    );

    await expect(ctx.state.list('profile/')).resolves.toEqual({
      items: [
        { key: 'profile/1', value: { name: 'Casey', active: true } },
        { key: 'profile/2', value: { name: 'Morgan', active: false } },
      ],
    });

    await expect(ctx.state.deleteMany(['profile/2', 'missing'])).resolves.toBe(1);
    await expect(ctx.state.get('profile/2')).resolves.toBeNull();
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

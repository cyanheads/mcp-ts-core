/**
 * @fileoverview Focused unit tests for uncovered mock context helper behavior.
 * @module tests/testing/mockContext.test
 */

import { inputRequired } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isInputRequiredSignal } from '@/mcp-server/inputRequired.js';
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

  it('seeds ctx.inputs from inputResponses and requestState for a second-round handler', () => {
    const ctx = createMockContext({
      inputResponses: {
        confirm: { action: 'accept', content: { ok: true } },
        cancelled: { action: 'cancel' },
      },
      requestState: { attempt: 2 },
    });

    expect(ctx.inputs.accepted('confirm', z.object({ ok: z.boolean() }))).toEqual({ ok: true });
    expect(ctx.inputs.accepted('cancelled')).toBeUndefined();
    expect(ctx.inputs.view('cancelled')).toEqual({ kind: 'elicit', action: 'cancel' });
    expect(ctx.inputs.view('never-asked')).toEqual({ kind: 'missing' });
    expect(ctx.inputs.state<{ attempt: number }>()).toEqual({ attempt: 2 });
  });

  it('leaves ctx.inputs empty on the first round', () => {
    const ctx = createMockContext();

    expect(ctx.inputs.responses).toBeUndefined();
    expect(ctx.inputs.dropped).toEqual([]);
    expect(ctx.inputs.state()).toBeUndefined();
    expect(ctx.inputs.accepted('confirm')).toBeUndefined();
  });

  it('drives ctx.requestInput through the same input_required signal the server throws', () => {
    const ctx = createMockContext();

    let thrown: unknown;
    try {
      ctx.requestInput({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: 'Proceed?',
            requestedSchema: z.object({ ok: z.boolean() }),
          }),
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(isInputRequiredSignal(thrown)).toBe(true);
    const { result } = thrown as { result: { resultType: string; inputRequests?: unknown } };
    expect(result.resultType).toBe('input_required');
    expect(result.inputRequests).toMatchObject({
      confirm: { method: 'elicitation/create', params: { message: 'Proceed?' } },
    });
  });
});

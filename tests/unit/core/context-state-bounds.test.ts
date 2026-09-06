/**
 * @fileoverview Bound storage work per Context list operation, including cancellation between I/O steps.
 * @module tests/unit/core/context-state-bounds.test
 */
import { describe, expect, it, vi } from 'vitest';
import { createContextState } from '@/core/context.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

function fixture() {
  const provider = new InMemoryProvider();
  const storage = new StorageService(provider);
  const controller = new AbortController();
  const context = requestContextService.createRequestContext({
    additionalContext: { tenantId: 'bounded' },
  });
  const state = createContextState(storage, context, controller.signal);
  return { provider, storage, controller, context, state };
}

describe('Context state list work bounds', () => {
  it.each([0, 1, 100])(
    'reads a %i-key page with at most one batch and no individual service reads',
    async (size) => {
      const { storage, context, state } = fixture();
      const entries = new Map(
        Array.from({ length: size }, (_, i) => [`row-${String(i).padStart(3, '0')}`, i]),
      );
      await storage.setMany(entries, context);
      const list = vi.spyOn(storage, 'list');
      const getMany = vi.spyOn(storage, 'getMany');
      const get = vi.spyOn(storage, 'get');
      const page = await state.list('row-', { limit: 100 });
      expect(page).toEqual({ items: [...entries].map(([key, value]) => ({ key, value })) });
      expect(list).toHaveBeenCalledExactlyOnceWith('row-', context, { limit: 100 });
      expect(getMany).toHaveBeenCalledTimes(size === 0 ? 0 : 1);
      if (size > 0) expect(getMany).toHaveBeenCalledWith([...entries.keys()], context);
      expect(get).not.toHaveBeenCalled();
    },
  );

  it('does no follow-up reads when a provider returns partial prefetched values', async () => {
    const { provider, storage, state } = fixture();
    vi.spyOn(provider, 'list').mockResolvedValue({
      keys: ['row-a', 'row-removed', 'row-b'],
      values: new Map<string, unknown>([
        ['row-a', false],
        ['row-b', 0],
      ]),
      nextCursor: 'provider-cursor',
    });
    const getMany = vi.spyOn(storage, 'getMany');
    const get = vi.spyOn(storage, 'get');
    expect(await state.list('row-')).toEqual({
      items: [
        { key: 'row-a', value: false },
        { key: 'row-b', value: 0 },
      ],
      cursor: 'provider-cursor',
    });
    expect(getMany).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('stops before batch hydration when cancellation arrives during the key listing', async () => {
    const { provider, storage, controller, state } = fixture();
    const reason = new Error('caller cancelled');
    vi.spyOn(provider, 'list').mockImplementation(async () => {
      await Promise.resolve();
      controller.abort(reason);
      return { keys: ['row-a'], nextCursor: undefined };
    });
    const getMany = vi.spyOn(storage, 'getMany');
    await expect(state.list()).rejects.toBe(reason);
    expect(getMany).not.toHaveBeenCalled();
  });
});

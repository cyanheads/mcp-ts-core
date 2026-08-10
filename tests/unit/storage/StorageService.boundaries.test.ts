/**
 * @fileoverview Adversarial input and resource-bound tests for StorageService.
 * @module tests/unit/storage/StorageService.boundaries.test
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

const LARGE_BATCH_SIZE = 10_001;

describe('StorageService batch and pagination boundaries', () => {
  let context: RequestContext;
  let provider: InMemoryProvider;
  let storage: StorageService;

  beforeEach(() => {
    context = requestContextService.createRequestContext({
      additionalContext: { tenantId: 'tenant-a' },
      operation: 'storage-boundary-test',
    });
    provider = new InMemoryProvider();
    storage = new StorageService(provider);
  });

  it('rejects malformed runtime batch containers before provider dispatch', async () => {
    const getMany = vi.spyOn(provider, 'getMany');
    const setMany = vi.spyOn(provider, 'setMany');
    const deleteMany = vi.spyOn(provider, 'deleteMany');

    await expect(storage.getMany(null as never, context)).rejects.toThrow(/must be an array/i);
    await expect(storage.deleteMany({ length: 0 } as never, context)).rejects.toThrow(
      /must be an array/i,
    );
    await expect(storage.setMany({ size: 0 } as never, context)).rejects.toThrow(/must be a Map/i);

    expect(getMany).not.toHaveBeenCalled();
    expect(setMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('dispatches batches larger than the former ten-thousand-key cap', async () => {
    const largeKeys = Array.from({ length: LARGE_BATCH_SIZE }, () => 'same-key');
    const largeEntries = new Map<string, unknown>(
      Array.from({ length: LARGE_BATCH_SIZE }, (_, index) => [`key-${index}`, index]),
    );
    const getMany = vi.spyOn(provider, 'getMany').mockResolvedValue(new Map());
    const setMany = vi.spyOn(provider, 'setMany').mockResolvedValue();
    const deleteMany = vi.spyOn(provider, 'deleteMany').mockResolvedValue(0);

    await expect(storage.getMany(largeKeys, context)).resolves.toEqual(new Map());
    await expect(storage.setMany(largeEntries, context)).resolves.toBeUndefined();
    await expect(storage.deleteMany(largeKeys, context)).resolves.toBe(0);

    expect(getMany).toHaveBeenCalledOnce();
    expect(setMany).toHaveBeenCalledOnce();
    expect(deleteMany).toHaveBeenCalledOnce();
  });

  it('rejects malformed batch keys atomically before provider dispatch', async () => {
    const setMany = vi.spyOn(provider, 'setMany');
    const entries = new Map<unknown, unknown>([
      ['valid-key', 'value'],
      [null, 'invalid'],
    ]);

    await expect(storage.setMany(entries as never, context)).rejects.toThrow();
    expect(setMany).not.toHaveBeenCalled();
    await expect(storage.get('valid-key', context)).resolves.toBeNull();
  });

  it('rejects malformed, fractional, zero, and oversized list controls', async () => {
    await expect(storage.list('', context, { cursor: 'not-a-cursor' })).rejects.toThrow();
    await expect(storage.list('', context, { cursor: 'YWJj.ZGVm' })).rejects.toThrow();
    await expect(storage.list('', context, { limit: 0 })).rejects.toThrow();
    await expect(storage.list('', context, { limit: 1.5 })).rejects.toThrow();
    await expect(storage.list('', context, { limit: 10_001 })).rejects.toThrow();
  });
});

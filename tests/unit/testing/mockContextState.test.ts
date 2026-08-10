/**
 * @fileoverview Verifies that `createMockContext().state` enforces the same key
 * validation, TTL expiry, and batch semantics as a real `StorageService`, by
 * driving the same inputs through both surfaces and comparing the outcomes.
 * @module tests/testing/mockContextState.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StorageService } from '@/storage/core/StorageService.js';
import { createInMemoryStorage, createMockContext } from '@/testing/index.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { makeRequestContext } from '../../helpers/index.js';

const INVALID_KEY = 'cache:v1:abc';
const TRAVERSAL_KEY = 'cache/../secrets';
const VALID_KEY = 'cache/v1/abc';

/** A real `StorageService` plus the request context needed to drive it. */
function realStorage(): {
  storage: StorageService;
  context: ReturnType<typeof makeRequestContext>;
} {
  return {
    storage: createInMemoryStorage(),
    context: makeRequestContext({ tenantId: 'default' }),
  };
}

/** Captures the rejection of a promise as an `McpError`, or fails the test. */
async function rejection(operation: Promise<unknown>): Promise<McpError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(McpError);
    return error as McpError;
  }
  throw new Error('expected the operation to reject');
}

describe('createMockContext state — storage parity', () => {
  it('has working state with no options, scoped to the stdio default tenant', async () => {
    const ctx = createMockContext();

    expect(ctx.tenantId).toBe('default');
    await ctx.state.set(VALID_KEY, { count: 1 });
    await expect(ctx.state.get(VALID_KEY)).resolves.toEqual({ count: 1 });
  });

  it('round-trips valid keys through set/get/delete', async () => {
    const ctx = createMockContext({ tenantId: 'tenant-1' });

    await ctx.state.set(VALID_KEY, 'value');
    await expect(ctx.state.get(VALID_KEY)).resolves.toBe('value');

    await ctx.state.delete(VALID_KEY);
    await expect(ctx.state.get(VALID_KEY)).resolves.toBeNull();
  });

  it('rejects a colon-separated key on set, get, and delete — same error as StorageService', async () => {
    const ctx = createMockContext({ tenantId: 'default' });
    const { storage, context } = realStorage();

    const mockSet = await rejection(ctx.state.set(INVALID_KEY, { value: 1 }));
    const realSet = await rejection(storage.set(INVALID_KEY, { value: 1 }, context));
    expect(mockSet.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(mockSet.code).toBe(realSet.code);
    expect(mockSet.message).toBe(realSet.message);

    const mockGet = await rejection(ctx.state.get(INVALID_KEY));
    const realGet = await rejection(storage.get(INVALID_KEY, context));
    expect(mockGet.message).toBe(realGet.message);

    const mockDelete = await rejection(ctx.state.delete(INVALID_KEY));
    const realDelete = await rejection(storage.delete(INVALID_KEY, context));
    expect(mockDelete.message).toBe(realDelete.message);
  });

  it('rejects a path-traversal key', async () => {
    const ctx = createMockContext({ tenantId: 'default' });
    const { storage, context } = realStorage();

    const mock = await rejection(ctx.state.set(TRAVERSAL_KEY, 'value'));
    const real = await rejection(storage.set(TRAVERSAL_KEY, 'value', context));
    expect(mock.message).toBe(real.message);
    expect(mock.message).toMatch(/path traversal/);
  });

  it('rejects invalid keys inside getMany, setMany, and deleteMany', async () => {
    const ctx = createMockContext({ tenantId: 'default' });
    const { storage, context } = realStorage();

    const mockGetMany = await rejection(ctx.state.getMany([VALID_KEY, INVALID_KEY]));
    const realGetMany = await rejection(storage.getMany([VALID_KEY, INVALID_KEY], context));
    expect(mockGetMany.message).toBe(realGetMany.message);

    await expect(
      ctx.state.setMany(new Map<string, unknown>([[INVALID_KEY, 'value']])),
    ).rejects.toThrow(McpError);
    await expect(ctx.state.deleteMany([INVALID_KEY])).rejects.toThrow(McpError);
  });

  it('rejects an invalid list prefix', async () => {
    const ctx = createMockContext({ tenantId: 'default' });
    const { storage, context } = realStorage();

    const mock = await rejection(ctx.state.list('cache:'));
    const real = await rejection(storage.list('cache:', context));
    expect(mock.message).toBe(real.message);
  });

  it('rejects a negative TTL', async () => {
    const ctx = createMockContext({ tenantId: 'default' });
    const { storage, context } = realStorage();

    const mock = await rejection(ctx.state.set(VALID_KEY, 'value', { ttl: -1 }));
    const real = await rejection(storage.set(VALID_KEY, 'value', context, { ttl: -1 }));
    expect(mock.message).toBe(real.message);
  });

  it('lists and pages the same way as StorageService', async () => {
    const ctx = createMockContext({ tenantId: 'default' });
    const { storage, context } = realStorage();

    for (const key of ['item/1', 'item/2', 'other/1']) {
      await ctx.state.set(key, key);
      await storage.set(key, key, context);
    }

    const mockPage = await ctx.state.list('item/');
    const realPage = await storage.list('item/', context);

    expect(mockPage.items.map((entry) => entry.key)).toEqual(realPage.keys);
    expect(mockPage.items).toEqual([
      { key: 'item/1', value: 'item/1' },
      { key: 'item/2', value: 'item/2' },
    ]);
  });

  it('rejects state operations once the request signal aborts', async () => {
    const controller = new AbortController();
    const ctx = createMockContext({ tenantId: 'default', signal: controller.signal });

    await ctx.state.set(VALID_KEY, 'value');
    controller.abort();

    await expect(ctx.state.get(VALID_KEY)).rejects.toThrow();
  });
});

describe('createMockContext state — TTL expiry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('expires an entry once its TTL elapses', async () => {
    vi.useFakeTimers();
    const ctx = createMockContext({ tenantId: 'default' });

    await ctx.state.set(VALID_KEY, 'value', { ttl: 60 });
    await expect(ctx.state.get(VALID_KEY)).resolves.toBe('value');

    vi.advanceTimersByTime(61_000);
    await expect(ctx.state.get(VALID_KEY)).resolves.toBeNull();
  });

  it('keeps an entry with no TTL', async () => {
    vi.useFakeTimers();
    const ctx = createMockContext({ tenantId: 'default' });

    await ctx.state.set(VALID_KEY, 'value');

    vi.advanceTimersByTime(86_400_000);
    await expect(ctx.state.get(VALID_KEY)).resolves.toBe('value');
  });

  it('expires a ttl:0 entry as soon as the clock moves past the write', async () => {
    vi.useFakeTimers();
    const ctx = createMockContext({ tenantId: 'default' });

    await ctx.state.set(VALID_KEY, 'value', { ttl: 0 });
    await expect(ctx.state.get(VALID_KEY)).resolves.toBe('value');

    vi.advanceTimersByTime(1);
    await expect(ctx.state.get(VALID_KEY)).resolves.toBeNull();
  });

  it('drops expired entries from list and getMany', async () => {
    vi.useFakeTimers();
    const ctx = createMockContext({ tenantId: 'default' });

    await ctx.state.set('item/keep', 'keep');
    await ctx.state.set('item/expire', 'expire', { ttl: 30 });

    vi.advanceTimersByTime(31_000);

    await expect(ctx.state.list('item/')).resolves.toEqual({
      items: [{ key: 'item/keep', value: 'keep' }],
    });
    await expect(ctx.state.getMany(['item/keep', 'item/expire'])).resolves.toEqual(
      new Map([['item/keep', 'keep']]),
    );
  });
});

/**
 * @fileoverview Unit tests for the Supabase storage provider.
 * @module tests/storage/providers/supabase/supabaseProvider.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeCursor } from '@/storage/core/storageValidation.js';
import { SupabaseProvider } from '@/storage/providers/supabase/supabaseProvider.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

type QueryResponse = {
  count?: number | null;
  data?: unknown;
  error?: { code?: string; message: string } | null;
};

type MockQueryBuilder = {
  delete: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  gt: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  like: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  or: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  then: Promise<QueryResponse>['then'];
  upsert: ReturnType<typeof vi.fn>;
};

function createQueryBuilder(response: QueryResponse): MockQueryBuilder {
  const builder = {} as MockQueryBuilder;
  const chained = () => builder;

  Object.assign(builder, {
    delete: vi.fn(chained),
    eq: vi.fn(chained),
    gt: vi.fn(chained),
    in: vi.fn(chained),
    like: vi.fn(chained),
    limit: vi.fn(chained),
    or: vi.fn(chained),
    order: vi.fn(chained),
    select: vi.fn(chained),
    single: vi.fn(async () => response),
    upsert: vi.fn(async () => response),
    // biome-ignore lint/suspicious/noThenProperty: Supabase query builders are awaitable thenables.
    then: Promise.resolve(response).then.bind(Promise.resolve(response)),
  });

  return builder;
}

function createClient(builder: MockQueryBuilder) {
  return {
    from: vi.fn(() => builder),
  };
}

describe('SupabaseProvider', () => {
  let context: RequestContext;

  beforeEach(() => {
    context = requestContextService.createRequestContext({
      operation: 'supabase-provider-test',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns null for PostgREST not-found responses', async () => {
    const builder = createQueryBuilder({
      data: null,
      error: { code: 'PGRST116', message: 'none' },
    });
    const provider = new SupabaseProvider(createClient(builder) as never);

    await expect(provider.get('tenant-1', 'missing', context)).resolves.toBeNull();

    expect(builder.select).toHaveBeenCalledWith('value, expires_at');
    expect(builder.eq).toHaveBeenCalledWith('tenant_id', 'tenant-1');
    expect(builder.eq).toHaveBeenCalledWith('key', 'missing');
    expect(builder.single).toHaveBeenCalledOnce();
  });

  it('returns stored values and lazily deletes expired rows', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const builder = createQueryBuilder({
      data: {
        value: { stale: true },
        expires_at: '2025-12-31T23:59:59.000Z',
      },
      error: null,
    });
    const provider = new SupabaseProvider(createClient(builder) as never);
    const deleteSpy = vi.spyOn(provider, 'delete').mockResolvedValue(true);

    await expect(provider.get('tenant-1', 'expired', context)).resolves.toBeNull();

    expect(deleteSpy).toHaveBeenCalledWith('tenant-1', 'expired', context);
  });

  it('stores ttl=0 as an immediate expires_at value instead of omitting TTL', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const builder = createQueryBuilder({ error: null });
    const provider = new SupabaseProvider(createClient(builder) as never);

    await provider.set('tenant-1', 'key-1', { value: 1 }, context, { ttl: 0 });

    expect(builder.upsert).toHaveBeenCalledWith({
      tenant_id: 'tenant-1',
      key: 'key-1',
      value: { value: 1 },
      expires_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('reports whether delete removed a row', async () => {
    const builder = createQueryBuilder({ count: 0, error: null });
    const provider = new SupabaseProvider(createClient(builder) as never);

    await expect(provider.delete('tenant-1', 'absent', context)).resolves.toBe(false);

    expect(builder.delete).toHaveBeenCalledWith({ count: 'exact' });
    expect(builder.eq).toHaveBeenCalledWith('tenant_id', 'tenant-1');
    expect(builder.eq).toHaveBeenCalledWith('key', 'absent');
  });

  it('lists keys with escaped LIKE prefixes and opaque tenant-bound cursors', async () => {
    const builder = createQueryBuilder({
      data: [{ key: 'prefix_%:1' }, { key: 'prefix_%:2' }, { key: 'prefix_%:3' }],
      error: null,
    });
    const provider = new SupabaseProvider(createClient(builder) as never);
    const cursor = encodeCursor('prefix_%:0', 'tenant-1');

    const result = await provider.list('tenant-1', 'prefix_%:', context, {
      cursor,
      limit: 2,
    });

    expect(result.keys).toEqual(['prefix_%:1', 'prefix_%:2']);
    expect(result.nextCursor).toBe(encodeCursor('prefix_%:2', 'tenant-1'));
    expect(builder.like).toHaveBeenCalledWith('key', 'prefix\\_\\%:%');
    expect(builder.limit).toHaveBeenCalledWith(3);
    expect(builder.gt).toHaveBeenCalledWith('key', 'prefix_%:0');
  });

  it('getMany omits missing and expired rows while cleaning expired keys', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const builder = createQueryBuilder({
      data: [
        { key: 'fresh', value: 'ok', expires_at: null },
        { key: 'expired', value: 'stale', expires_at: '2025-12-31T23:59:59.000Z' },
      ],
      error: null,
    });
    const provider = new SupabaseProvider(createClient(builder) as never);
    const deleteSpy = vi.spyOn(provider, 'delete').mockResolvedValue(true);

    const result = await provider.getMany<string>('tenant-1', ['fresh', 'expired'], context);

    expect(result).toEqual(new Map([['fresh', 'ok']]));
    expect(deleteSpy).toHaveBeenCalledWith('tenant-1', 'expired', context);
    expect(builder.in).toHaveBeenCalledWith('key', ['fresh', 'expired']);
  });

  it('batch methods no-op on empty inputs', async () => {
    const builder = createQueryBuilder({ error: null });
    const provider = new SupabaseProvider(createClient(builder) as never);

    await expect(provider.getMany('tenant-1', [], context)).resolves.toEqual(new Map());
    await expect(provider.setMany('tenant-1', new Map(), context)).resolves.toBeUndefined();
    await expect(provider.deleteMany('tenant-1', [], context)).resolves.toBe(0);

    expect(builder.select).not.toHaveBeenCalled();
    expect(builder.upsert).not.toHaveBeenCalled();
    expect(builder.delete).not.toHaveBeenCalled();
  });

  it('setMany upserts rows with a shared TTL', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const builder = createQueryBuilder({ error: null });
    const provider = new SupabaseProvider(createClient(builder) as never);

    await provider.setMany(
      'tenant-1',
      new Map<string, unknown>([
        ['a', { n: 1 }],
        ['b', { n: 2 }],
      ]),
      context,
      { ttl: 60 },
    );

    expect(builder.upsert).toHaveBeenCalledWith([
      {
        tenant_id: 'tenant-1',
        key: 'a',
        value: { n: 1 },
        expires_at: '2026-01-01T00:01:00.000Z',
      },
      {
        tenant_id: 'tenant-1',
        key: 'b',
        value: { n: 2 },
        expires_at: '2026-01-01T00:01:00.000Z',
      },
    ]);
  });

  it('deleteMany and clear return affected row counts', async () => {
    const deleteManyBuilder = createQueryBuilder({ count: 2, error: null });
    const deleteManyProvider = new SupabaseProvider(createClient(deleteManyBuilder) as never);

    await expect(deleteManyProvider.deleteMany('tenant-1', ['a', 'b', 'c'], context)).resolves.toBe(
      2,
    );
    expect(deleteManyBuilder.in).toHaveBeenCalledWith('key', ['a', 'b', 'c']);

    const clearBuilder = createQueryBuilder({ count: 7, error: null });
    const clearProvider = new SupabaseProvider(createClient(clearBuilder) as never);

    await expect(clearProvider.clear('tenant-1', context)).resolves.toBe(7);
    expect(clearBuilder.eq).toHaveBeenCalledWith('tenant_id', 'tenant-1');
  });
});

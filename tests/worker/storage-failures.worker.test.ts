/**
 * @fileoverview Corrupt-data recovery contracts with real Worker storage.
 * @module tests/worker/storage-failures.worker.test
 */
import { reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { D1Provider } from '@/storage/providers/cloudflare/d1Provider.js';
import { KvProvider } from '@/storage/providers/cloudflare/kvProvider.js';
import { R2Provider } from '@/storage/providers/cloudflare/r2Provider.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { defaultIsTransient } from '@/utils/network/retry.js';

const context = {
  tenantId: 'failure-test',
  requestId: 'worker-storage-failure',
  timestamp: '2026-09-04T00:00:00Z',
};
afterEach(() => reset());

/** The binding with every method call it receives recorded by name. */
function counting<T extends object>(target: T): { binding: T; calls: string[] } {
  const calls: string[] = [];
  const binding = new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        return value.apply(object, args);
      };
    },
  });
  return { binding, calls };
}

/** A tenant ID of the longest length `StorageService` accepts, 128 characters. */
const LONGEST_TENANT = `T${'x'.repeat(126)}Z`;

/**
 * Every single-key and batch method against one key, on the real binding:
 * resolves when the stored name fits, and otherwise rejects before any call.
 */
async function everyMethod(
  provider: KvProvider | R2Provider,
  tenantId: string,
  key: string,
): Promise<unknown[]> {
  const ctx = { ...context, tenantId };
  const outcomes: unknown[] = [];
  for (const run of [
    () => provider.set(tenantId, key, 'stored', ctx),
    () => provider.get(tenantId, key, ctx),
    () => provider.getMany(tenantId, [key], ctx),
    () => provider.delete(tenantId, key, ctx),
    () => provider.setMany(tenantId, new Map([[key, 'batch']]), ctx),
    () => provider.getMany(tenantId, [key], ctx),
    () => provider.deleteMany(tenantId, [key], ctx),
    () => provider.get(tenantId, key, ctx),
  ]) {
    outcomes.push(await run().catch((error: unknown) => error));
  }
  return outcomes;
}

describe('stored names at the backend limit', () => {
  it.each([
    { backend: 'KV', tenant: '2-character', tenantId: 't1', length: 509 },
    { backend: 'KV', tenant: '128-character', tenantId: LONGEST_TENANT, length: 383 },
    { backend: 'R2', tenant: '2-character', tenantId: 't1', length: 1_021 },
    { backend: 'R2', tenant: '128-character', tenantId: LONGEST_TENANT, length: 895 },
  ])(
    '$backend stores and reads back $length-character keys for a $tenant tenant, and rejects one more before the backend',
    async ({ backend, tenantId, length }) => {
      const kv = counting(env.KV_NAMESPACE);
      const r2 = counting(env.R2_BUCKET);
      const provider = backend === 'KV' ? new KvProvider(kv.binding) : new R2Provider(r2.binding);
      const calls = backend === 'KV' ? kv.calls : r2.calls;

      await expect(everyMethod(provider, tenantId, 'k'.repeat(length))).resolves.toEqual([
        undefined,
        'stored',
        new Map([['k'.repeat(length), 'stored']]),
        true,
        undefined,
        new Map([['k'.repeat(length), 'batch']]),
        1,
        null,
      ]);
      const callsAtLimit = calls.length;

      const rejected = await everyMethod(provider, tenantId, 'k'.repeat(length + 1));
      for (const outcome of rejected) {
        expect(outcome).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining(
            `The longest key this tenant can use is ${length} bytes.`,
          ),
        });
      }
      expect(calls).toHaveLength(callsAtLimit);
    },
  );

  it.each(['KV', 'R2'])(
    '%s writes and deletes nothing from a batch holding one key past the limit',
    async (backend) => {
      const provider =
        backend === 'KV' ? new KvProvider(env.KV_NAMESPACE) : new R2Provider(env.R2_BUCKET);
      const overLong = 'k'.repeat(backend === 'KV' ? 510 : 1_022);
      const batch = ['ok-first', overLong, 'ok-last'];

      await expect(
        provider.setMany('t1', new Map(batch.map((key, index) => [key, index])), context),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      await expect(provider.getMany('t1', ['ok-first', 'ok-last'], context)).resolves.toEqual(
        new Map(),
      );

      await provider.setMany(
        't1',
        new Map([
          ['ok-first', 1],
          ['ok-last', 3],
        ]),
        context,
      );
      await expect(provider.deleteMany('t1', batch, context)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
      });
      await expect(provider.getMany('t1', ['ok-first', 'ok-last'], context)).resolves.toEqual(
        new Map([
          ['ok-first', 1],
          ['ok-last', 3],
        ]),
      );
    },
  );

  it('KV lists nothing for a prefix past the limit, and still rejects another tenant’s cursor', async () => {
    const provider = new KvProvider(env.KV_NAMESPACE);
    const prefix = 'k'.repeat(510);
    await provider.set('t1', 'k'.repeat(509), 'at the limit', context);

    await expect(provider.list('t1', prefix, context)).resolves.toEqual({ keys: [] });
    await expect(provider.list('t1', 'k'.repeat(509), context)).resolves.toMatchObject({
      keys: ['k'.repeat(509)],
    });

    await Promise.all(
      ['a', 'b'].map((key) => provider.set('other', key, key, { ...context, tenantId: 'other' })),
    );
    const otherPage = await provider.list(
      'other',
      '',
      { ...context, tenantId: 'other' },
      {
        limit: 1,
      },
    );
    expect(otherPage.nextCursor).toEqual(expect.any(String));
    await expect(
      provider.list('t1', prefix, context, { cursor: otherPage.nextCursor as string }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
  });

  it('KV pages a list whose limit passes 1,000 keys through the native cursor', async () => {
    const provider = new KvProvider(env.KV_NAMESPACE);
    const keys = Array.from(
      { length: 1_001 },
      (_, index) => `page/${String(index).padStart(4, '0')}`,
    );
    await provider.setMany('t1', new Map(keys.map((key) => [key, 1])), context);

    const first = await provider.list('t1', 'page/', context, { limit: 5_000 });
    expect(first.keys).toHaveLength(1_000);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await provider.list('t1', 'page/', context, {
      cursor: first.nextCursor as string,
      limit: 5_000,
    });
    expect([...first.keys, ...second.keys]).toEqual(keys);
    expect(second.nextCursor).toBeUndefined();
  });

  it('R2 deletes a batch of more than 1,000 keys', async () => {
    const provider = new R2Provider(env.R2_BUCKET);
    const keys = Array.from({ length: 1_001 }, (_, index) => `bulk/${index}`);
    await provider.setMany('t1', new Map(keys.map((key) => [key, 1])), context);

    await expect(provider.deleteMany('t1', keys, context)).resolves.toBe(1_001);
    await expect(env.R2_BUCKET.list({ prefix: 't1:' })).resolves.toMatchObject({ objects: [] });
  });
});

describe('Worker storage failures', () => {
  it('classifies corrupt D1 JSON and accepts a replacement without losing other rows', async () => {
    await env.DB.exec(
      'CREATE TABLE kv_store (tenant_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER, PRIMARY KEY (tenant_id, key))',
    );
    const provider = new D1Provider(env.DB);
    await provider.set(context.tenantId, 'stable', 'sentinel', context);
    await env.DB.prepare('INSERT INTO kv_store (tenant_id,key,value) VALUES (?,?,?)')
      .bind(context.tenantId, 'bad', '{invalid')
      .run();
    await expect(provider.get(context.tenantId, 'bad', context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
    });
    await provider.set(context.tenantId, 'bad', 'recovered', context);
    await expect(provider.getMany(context.tenantId, ['bad', 'stable'], context)).resolves.toEqual(
      new Map([
        ['bad', 'recovered'],
        ['stable', 'sentinel'],
      ]),
    );
  });

  it('classifies corrupt KV JSON and clamps a short TTL to the backend minimum', async () => {
    const provider = new KvProvider(env.KV_NAMESPACE);
    await env.KV_NAMESPACE.put(`${context.tenantId}:bad`, '{invalid');
    await expect(provider.get(context.tenantId, 'bad', context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
    });
    const before = Math.floor(Date.now() / 1000);
    await provider.set(context.tenantId, 'bad', 'recovered', context, { ttl: 1 });
    const listed = await env.KV_NAMESPACE.list({ prefix: `${context.tenantId}:` });
    expect(listed.keys).toHaveLength(1);
    expect(listed.keys[0]?.expiration).toBeGreaterThanOrEqual(before + 60);
    await expect(provider.get(context.tenantId, 'bad', context)).resolves.toBe('recovered');
  });

  it('rejects a KV key past the backend name limit before the backend, as a ValidationError', async () => {
    const { binding, calls } = counting(env.KV_NAMESPACE);
    const provider = new KvProvider(binding);
    // `failure-test:` plus 510 characters is over KV's 512-byte name limit.
    const overLong = 'k'.repeat(510);

    const getError = await provider
      .get(context.tenantId, overLong, context)
      .catch((error: unknown) => error);
    const getManyError = await provider
      .getMany(context.tenantId, [overLong], context)
      .catch((error: unknown) => error);

    expect(getError).toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    expect(defaultIsTransient(getError)).toBe(false);
    expect(getManyError).toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    expect(calls).toEqual([]);
    await expect(provider.get(context.tenantId, 'absent', context)).resolves.toBeNull();
  });

  it('reports a KV outage on get and getMany as ServiceUnavailable, which retries treat as transient', async () => {
    const unavailable = new Proxy(env.KV_NAMESPACE, {
      get(target, property, receiver) {
        if (property === 'get') {
          return () => Promise.reject(new Error('KV GET failed: 503 Service Unavailable'));
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const provider = new KvProvider(unavailable);

    const getError = await provider
      .get(context.tenantId, 'key', context)
      .catch((error: unknown) => error);
    const getManyError = await provider
      .getMany(context.tenantId, ['key'], context)
      .catch((error: unknown) => error);

    expect(getError).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect(defaultIsTransient(getError)).toBe(true);
    expect(getManyError).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
  });

  it('reads legacy R2 values, reports corrupt JSON, and recovers after replacement', async () => {
    const provider = new R2Provider(env.R2_BUCKET);
    await env.R2_BUCKET.put(`${context.tenantId}:legacy`, JSON.stringify({ legacy: true }));
    await expect(provider.get(context.tenantId, 'legacy', context)).resolves.toEqual({
      legacy: true,
    });
    await env.R2_BUCKET.put(`${context.tenantId}:bad`, '{invalid');
    await expect(provider.get(context.tenantId, 'bad', context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
    });
    await provider.set(context.tenantId, 'bad', 'recovered', context);
    await expect(provider.get(context.tenantId, 'bad', context)).resolves.toBe('recovered');
    await expect(provider.clear(context.tenantId, context)).resolves.toBe(2);
    await expect(provider.clear(context.tenantId, context)).resolves.toBe(0);
  });
});

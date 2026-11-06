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

  it('reports a KV read the backend rejects by its own classification, not as corrupt data', async () => {
    const provider = new KvProvider(env.KV_NAMESPACE);
    // `failure-test:` plus 510 characters is over KV's 512-byte key limit, so the real binding rejects.
    const overLong = 'k'.repeat(510);

    const getError = await provider
      .get(context.tenantId, overLong, context)
      .catch((error: unknown) => error);
    const getManyError = await provider
      .getMany(context.tenantId, [overLong], context)
      .catch((error: unknown) => error);

    expect(getError).toMatchObject({ code: expect.any(Number) });
    expect((getError as { code: number }).code).not.toBe(JsonRpcErrorCode.SerializationError);
    expect(defaultIsTransient(getError)).toBe(false);
    expect((getManyError as { code: number }).code).toBe((getError as { code: number }).code);
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

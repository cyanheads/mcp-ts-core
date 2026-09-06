/**
 * @fileoverview Corrupt-data recovery and binding configuration contracts with real Worker storage.
 * @module tests/worker/storage-failures.worker.test
 */
import { reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { D1Provider } from '@/storage/providers/cloudflare/d1Provider.js';
import { KvProvider } from '@/storage/providers/cloudflare/kvProvider.js';
import { R2Provider } from '@/storage/providers/cloudflare/r2Provider.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';

const context = {
  tenantId: 'failure-test',
  requestId: 'worker-storage-failure',
  timestamp: '2026-09-04T00:00:00Z',
};
afterEach(() => reset());

describe('Worker storage failures', () => {
  it('rejects missing bindings and unsafe SQL identifiers before I/O', () => {
    expect(() => new D1Provider(undefined as unknown as D1Database)).toThrow('valid D1Database');
    expect(() => new KvProvider(undefined as unknown as KVNamespace)).toThrow('valid KVNamespace');
    expect(() => new R2Provider(undefined as unknown as R2Bucket)).toThrow('valid R2Bucket');
    expect(() => new D1Provider(env.DB, 'invalid-table-name')).toThrow('valid SQL identifier');
  });

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

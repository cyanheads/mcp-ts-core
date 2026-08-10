/**
 * @fileoverview Real Miniflare binding compliance for Cloudflare storage providers.
 * @module tests/worker/storage-provider-compliance.worker.test
 */

import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

import { D1Provider } from '@/storage/providers/cloudflare/d1Provider.js';
import { KvProvider } from '@/storage/providers/cloudflare/kvProvider.js';
import { R2Provider } from '@/storage/providers/cloudflare/r2Provider.js';

import { storageProviderTests } from '../compliance/storage-provider.js';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      KV_NAMESPACE: KVNamespace;
      R2_BUCKET: R2Bucket;
    }
  }
}

const KV_STORE_MIGRATION = `
CREATE TABLE IF NOT EXISTS kv_store (
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (tenant_id, key)
)
`;

storageProviderTests({
  capabilities: {
    rejectsUnserializableValues: true,
    setManyIsAtomic: true,
  },
  create: () => new D1Provider(env.DB),
  name: 'cloudflare-d1 (real Miniflare D1)',
  async setup() {
    await reset();
    await applyD1Migrations(env.DB, [
      { name: '0001_create_kv_store', queries: [KV_STORE_MIGRATION] },
    ]);
  },
});

storageProviderTests({
  capabilities: {
    deterministicTtl: false,
    listFiltersExpired: false,
    preciseDeleteCounts: false,
    rejectsUnserializableValues: true,
  },
  create: () => new KvProvider(env.KV_NAMESPACE),
  name: 'cloudflare-kv (real Miniflare KV)',
  async setup() {
    await reset();
  },
});

storageProviderTests({
  capabilities: {
    listFiltersExpired: false,
    preciseDeleteCounts: false,
    rejectsUnserializableValues: true,
  },
  create: () => new R2Provider(env.R2_BUCKET),
  name: 'cloudflare-r2 (real Miniflare R2)',
  async setup() {
    await reset();
  },
});

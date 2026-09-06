/**
 * @fileoverview Start a built Worker outside the test pool's request context.
 * @module tests/helpers/standalone-worker
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertBuildFresh } from './server-process.js';

/** Start local Workerd with isolated temporary storage and explicit test bindings. */
export async function startStandaloneWorker(secret: string) {
  assertBuildFresh();
  // Wrangler is pinned by the installed Cloudflare test pool; never download a CLI.
  const poolRequire = createRequire(import.meta.resolve('@cloudflare/vitest-pool-workers'));
  const { createTestHarness } = poolRequire('wrangler') as Pick<
    typeof import('wrangler'),
    'createTestHarness'
  >;
  const wranglerVersion = (poolRequire('wrangler/package.json') as { version: string }).version;
  const root = await mkdtemp(join(tmpdir(), 'mcp-worker-test-'));
  const server = createTestHarness({
    root,
    workers: [
      {
        config: {
          name: 'load-fixture',
          main: resolve('tests/fixtures/load-worker.js'),
          compatibility_date: '2026-02-13',
          compatibility_flags: ['nodejs_compat'],
          alias: { '@duckdb/node-api': resolve('examples/duckdb-stub.ts') },
          vars: {
            ENVIRONMENT: 'test',
            LOG_LEVEL: 'emerg',
            MCP_AUTH_MODE: 'jwt',
            MCP_AUTH_SECRET_KEY: secret,
            MCP_ALLOWED_ORIGINS: 'http://example.com',
            STORAGE_PROVIDER_TYPE: 'cloudflare-kv',
          },
          kv_namespaces: [{ binding: 'KV_NAMESPACE', id: 'local-test-kv' }],
        },
      },
    ],
  });
  async function close() {
    try {
      await server.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  try {
    const { url } = await server.listen();
    return { url: new URL('/mcp', url).href, wranglerVersion, close };
  } catch (error) {
    await close();
    throw error;
  }
}

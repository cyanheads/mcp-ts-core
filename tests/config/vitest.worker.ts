/**
 * @fileoverview Worker lane: the framework under real workerd via @cloudflare/vitest-pool-workers.
 * @module tests/config/vitest.worker
 */
import { resolve } from 'node:path';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const repoRoot = resolve(import.meta.dirname, '../..');

if (typeof process !== 'undefined' && process.stderr?.write) {
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: any, ...args: any[]) => {
    if (
      typeof chunk === 'string' &&
      chunk.includes('@modelcontextprotocol/sdk') &&
      chunk.includes('Sourcemap')
    ) {
      return true;
    }
    return originalWrite(chunk, ...args);
  }) as any;
}

export default defineConfig({
  root: repoRoot,
  // This lane's sources are checked by tsconfig.worker.json (#397), where `@/`
  // resolves to the built declarations — so the runtime alias to `src/` is
  // stated here rather than inherited from whichever tsconfig includes them.
  resolve: { alias: { '@/': `${repoRoot}/src/` }, tsconfigPaths: true },
  plugins: [
    cloudflareTest({
      main: './tests/fixtures/worker-runtime.fixture.ts',
      miniflare: {
        bindings: {
          CUSTOM_API_KEY: 'worker-secret',
          ENVIRONMENT: 'test',
          LOG_LEVEL: 'error',
          MCP_ALLOWED_ORIGINS: 'http://example.com',
          STORAGE_PROVIDER_TYPE: 'cloudflare-kv',
        },
        compatibilityDate: '2026-02-13',
        compatibilityFlags: ['nodejs_compat'],
        kvNamespaces: ['KV_NAMESPACE', 'CUSTOM_KV'],
        r2Buckets: ['R2_BUCKET'],
        d1Databases: ['DB'],
      },
    }),
  ],
  test: {
    expect: {
      requireAssertions: true,
    },
    include: ['tests/worker/**/*.test.ts'],
    coverage: {
      enabled: true,
      provider: 'istanbul',
      reportsDirectory: 'reports/coverage-worker',
      reporter: ['text', 'json', 'html'],
      include: ['src/core/worker.ts', 'src/storage/providers/cloudflare/*.ts'],
      thresholds: { lines: 94, functions: 94, statements: 94, branches: 87 },
    },
    testTimeout: 30_000,
  },
});

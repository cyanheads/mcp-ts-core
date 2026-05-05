import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

if (typeof process !== 'undefined' && process.stderr?.write) {
  const originalWrite = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: stderr.write overload union
  process.stderr.write = ((chunk: any, ...args: any[]) => {
    if (
      typeof chunk === 'string' &&
      chunk.includes('@modelcontextprotocol/sdk') &&
      chunk.includes('Sourcemap')
    ) {
      return true;
    }
    return originalWrite(chunk, ...args);
    // biome-ignore lint/suspicious/noExplicitAny: matches Node's WriteStream signature
  }) as any;
}

export default defineConfig({
  resolve: { tsconfigPaths: true },
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
      },
    }),
  ],
  test: {
    include: ['tests/worker/**/*.test.ts'],
    testTimeout: 30_000,
  },
});

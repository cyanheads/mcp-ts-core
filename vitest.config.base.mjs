/**
 * @fileoverview Base Vitest configuration for consumer servers.
 * Shipped as `.mjs` (not `.ts`) so Node ≥22.7 does not attempt to strip
 * types under `node_modules/` — `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.
 *
 * Extend this in your server's `vitest.config.ts`:
 *
 * ```ts
 * import { defineConfig, mergeConfig } from 'vitest/config';
 * import coreConfig from '@cyanheads/mcp-ts-core/vitest.config';
 *
 * export default mergeConfig(coreConfig, defineConfig({
 *   resolve: {
 *     alias: { '@/': new URL('./src/', import.meta.url).pathname },
 *   },
 * }));
 * ```
 *
 * @module vitest.config.base
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  ssr: {
    noExternal: ['zod'],
  },
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    isolate: true,
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      thresholds: {
        lines: 94,
        functions: 94,
        branches: 87,
        statements: 94,
      },
    },
  },
});

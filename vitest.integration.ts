import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  ssr: {
    noExternal: ['zod'],
  },
  test: {
    expect: {
      requireAssertions: true,
    },
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts', 'tests/integration/**/*.int.test.ts'],
    exclude: [
      'tests/integration/package-consumer.int.test.ts',
      // Source-barrel contract test — owned by the Package lane (vitest.package.ts).
      'tests/integration/public-api-contract.int.test.ts',
    ],
    setupFiles: ['./tests/integration/setup.ts'],
    pool: 'forks',
    maxWorkers: 1, // Sequential — shared server processes
    isolate: true,
    testTimeout: 30_000, // Longer timeout for subprocess startup
    hookTimeout: 30_000, // Server subprocess needs time to start
  },
});

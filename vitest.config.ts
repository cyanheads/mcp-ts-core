/**
 * @fileoverview Root Vitest config. Uses Vitest 4 `projects` so unit, smoke,
 * compliance, fuzz, and integration suites live in a single config and can be
 * run individually by filter (`--project unit`) or all at once.
 * @module vitest.config
 */
import { defineConfig } from 'vitest/config';

// node-cron ships dist/ but not src/, so its sourceMappingURL points at a
// non-existent path. Vite's `logger.warnOnce` reaches stderr via
// `process.stderr.write`; patch it in the parent process (where Vite's
// SSR transform runs) to drop just that one harmless line.
if (typeof process !== 'undefined' && process.stderr?.write) {
  const originalWrite = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: stderr.write overload union
  process.stderr.write = ((chunk: any, ...args: any[]) => {
    if (
      typeof chunk === 'string' &&
      chunk.includes('node-cron') &&
      chunk.includes('Sourcemap')
    ) {
      return true;
    }
    return originalWrite(chunk, ...args);
    // biome-ignore lint/suspicious/noExplicitAny: matches Node's WriteStream signature
  }) as any;
}

const sharedUnit = {
  globals: true,
  environment: 'node' as const,
  setupFiles: ['./tests/setup.ts'],
  pool: 'forks' as const,
  maxWorkers: 4,
  isolate: true,
  silent: 'passed-only' as const,
};

export default defineConfig({
  resolve: { tsconfigPaths: true },
  // Inline zod to fix Vite SSR transform issues with Zod 4.
  ssr: {
    noExternal: ['zod'],
  },
  test: {
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      thresholds: {
        lines: 80,
        functions: 75,
        branches: 70,
        statements: 80,
      },
    },
    projects: [
      {
        extends: true,
        test: {
          ...sharedUnit,
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          exclude: ['node_modules/**'],
        },
      },
      {
        extends: true,
        test: {
          ...sharedUnit,
          name: 'compliance',
          include: ['tests/compliance/**/*.test.ts'],
          exclude: ['node_modules/**'],
        },
      },
      {
        extends: true,
        test: {
          ...sharedUnit,
          name: 'smoke',
          include: ['tests/smoke/**/*.test.ts'],
          exclude: ['node_modules/**'],
        },
      },
      {
        extends: true,
        test: {
          ...sharedUnit,
          name: 'fuzz',
          include: ['tests/fuzz/**/*.test.ts'],
          exclude: ['node_modules/**'],
          testTimeout: 15_000,
        },
      },
    ],
  },
});

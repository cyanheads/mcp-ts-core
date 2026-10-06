/**
 * @fileoverview Root Vitest config. Uses Vitest 4 `projects` so unit, smoke,
 * contract, compliance, fuzz, leak-gate, and typecheck suites live in a single
 * config and can be run individually by filter (`--project unit`) or all at once.
 * @module vitest.config
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Maps `@cyanheads/mcp-ts-core` and each subpath export onto its `src/` module.
 * Unaliased, the package name resolves through its own `exports` to `dist/`, so
 * definitions written against the published name (`examples/`, `templates/`)
 * would build on whatever was last compiled, or fail to import before a build.
 */
const selfSourceAliases = Object.entries(
  (
    JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, string | { import: string }>;
    }
  ).exports,
).flatMap(([subpath, target]) =>
  typeof target === 'object'
    ? [
        {
          find: new RegExp(`^@cyanheads/mcp-ts-core${subpath.slice(1)}$`),
          replacement: fileURLToPath(
            new URL(
              target.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'),
              import.meta.url,
            ),
          ),
        },
      ]
    : [],
);

// node-cron ships dist/ but not src/, so its sourceMappingURL points at a
// non-existent path. Vite's `logger.warnOnce` reaches stderr via
// `process.stderr.write`; patch it in the parent process (where Vite's
// SSR transform runs) to drop just that one harmless line.
if (typeof process !== 'undefined' && process.stderr?.write) {
  const originalWrite = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: stderr.write overload union
  process.stderr.write = ((chunk: any, ...args: any[]) => {
    if (typeof chunk === 'string' && chunk.includes('node-cron') && chunk.includes('Sourcemap')) {
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
    /**
     * Never write a snapshot implicitly. Vitest's local default (`new`) writes a
     * missing one and passes, which would let a deleted contract pin regenerate
     * unreviewed; `-u` still writes.
     */
    update: 'none',
    expect: {
      requireAssertions: true,
    },
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
        'src/linter/rules/server-json-rules.ts': {
          lines: 100,
          functions: 100,
          branches: 90,
          statements: 100,
        },
        'src/storage/providers/supabase/supabaseProvider.ts': {
          lines: 100,
          functions: 100,
          branches: 95,
          statements: 100,
        },
      },
    },
    projects: [
      {
        extends: true,
        test: {
          ...sharedUnit,
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          exclude: ['node_modules/**', 'tests/unit/testing/leak-gate.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          ...sharedUnit,
          /**
           * Each case spawns a full Vitest run, so this stays out of the unit
           * lane and out of the leak gate's own project list.
           */
          name: 'leak-gate',
          include: ['tests/unit/testing/leak-gate.test.ts'],
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
        resolve: { alias: selfSourceAliases },
        test: {
          ...sharedUnit,
          name: 'smoke',
          include: ['tests/smoke/**/*.test.ts'],
          exclude: ['node_modules/**'],
        },
      },
      {
        extends: true,
        resolve: { alias: selfSourceAliases },
        test: {
          ...sharedUnit,
          /**
           * Pins what an MCP client receives — advertised lists and argument
           * outcomes — as committed files. See tests/contract/README.md.
           */
          name: 'contract',
          include: ['tests/contract/**/*.test.ts'],
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
      {
        extends: true,
        test: {
          /**
           * `expectTypeOf` is evaluated by the typechecker and does not count as
           * a runtime assertion in Vitest's assertion counter.
           */
          expect: {
            requireAssertions: false,
          },
          name: 'typecheck',
          /**
           * Must match the runtime projects — vitest rejects differing
           * maxWorkers within the same sequence group.
           */
          maxWorkers: 4,
          include: ['tests/types/**/*.test-d.ts'],
          typecheck: {
            enabled: true,
            checker: 'tsc',
            include: ['tests/types/**/*.test-d.ts'],
            ignoreSourceErrors: true,
          },
        },
      },
    ],
  },
});

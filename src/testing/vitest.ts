/**
 * @fileoverview Vitest fixture-based test helpers for MCP handler testing.
 * Exports `mcpTest` — a `test.extend`-based Vitest test with per-test `ctx`
 * and `storage` fixtures — so every test gets fresh, isolated instances.
 *
 * Import from `@cyanheads/mcp-ts-core/testing/vitest`. Vitest is required as
 * a peer dependency when using this subpath.
 *
 * @example
 * ```ts
 * import { mcpTest } from '@cyanheads/mcp-ts-core/testing/vitest';
 *
 * mcpTest('echoes the message', async ({ ctx }) => {
 *   const result = await echoTool.handler(echoTool.input.parse({ message: 'hi' }), ctx);
 *   expect(result.message).toBe('hi');
 * });
 *
 * // Override with the function form to keep fresh-context-per-test:
 * const tenantTest = mcpTest.extend({
 *   ctx: async ({}, use) => { await use(createMockContext({ tenantId: 'test-tenant' })); },
 * });
 * ```
 *
 * @module src/testing/vitest
 */

import { test } from 'vitest';
import type { Context } from '@/core/context.js';
import type { StorageService } from '@/storage/core/StorageService.js';
import type { MockContextOptions } from './index.js';
import { createInMemoryStorage, createMockContext } from './index.js';

// ---------------------------------------------------------------------------
// Fixture interface
// ---------------------------------------------------------------------------

/**
 * Fixture shape provided to each `mcpTest` test body.
 *
 * - `ctx` — a fresh `Context` from `createMockContext()` for each test
 * - `storage` — a fresh `StorageService` backed by `InMemoryProvider` for each test
 */
export interface McpTestFixtures {
  /** Fresh mock context per test. Cast `ctx.log` to `MockContextLogger` to inspect log calls. */
  ctx: Context;
  /** Fresh in-memory `StorageService` per test, for services that accept a `StorageService` dep. */
  storage: StorageService;
}

// ---------------------------------------------------------------------------
// Extended test
// ---------------------------------------------------------------------------

/**
 * Vitest extended test with `ctx` and `storage` fixtures.
 *
 * Each test receives a fresh `createMockContext()` and `createInMemoryStorage()`,
 * ensuring log captures, enrichment stores, and in-memory state never bleed
 * between tests.
 *
 * Override fixtures using the **function form** to preserve per-test freshness:
 * ```ts
 * const tenantTest = mcpTest.extend<{ ctx: Context }>({
 *   ctx: async ({}, use) => { await use(createMockContext({ tenantId: 'test-tenant' })); },
 * });
 * ```
 *
 * @example
 * ```ts
 * import { mcpTest } from '@cyanheads/mcp-ts-core/testing/vitest';
 *
 * mcpTest('handler returns expected output', async ({ ctx }) => {
 *   const result = await myTool.handler(myTool.input.parse({ query: 'x' }), ctx);
 *   expect(result.items).toBeDefined();
 * });
 * ```
 */
export const mcpTest = test.extend<McpTestFixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: vitest's fixture API requires a destructuring pattern as the first parameter
  ctx: async ({}: object, use: (value: Context) => Promise<void>) => {
    await use(createMockContext());
  },
  // biome-ignore lint/correctness/noEmptyPattern: vitest's fixture API requires a destructuring pattern as the first parameter
  storage: async ({}: object, use: (value: StorageService) => Promise<void>) => {
    await use(createInMemoryStorage());
  },
});

// ---------------------------------------------------------------------------
// Re-exports for consumers extending the fixture
// ---------------------------------------------------------------------------

export type { MockContextOptions };
/**
 * Re-exported so consumers can import `createMockContext` alongside `mcpTest`
 * from a single subpath when writing fixture overrides.
 */
export { createInMemoryStorage, createMockContext };

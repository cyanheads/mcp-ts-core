/**
 * @fileoverview Vitest fixture-based test helpers for MCP handler testing.
 * Exports `mcpTest` — a `test.extend`-based Vitest test with per-test `ctx`,
 * `session`, `fetchMock`, and `storage` fixtures — plus `toolContractSuite`.
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

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, test } from 'vitest';
import type { z } from 'zod';
import type { Context } from '@/core/context.js';
import type { AnyToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import type { StorageService } from '@/storage/core/StorageService.js';
import type { FetchMockHarness, MockContextOptions, MockSession } from './index.js';
import {
  createFetchMock,
  createInMemoryStorage,
  createMockContext,
  createMockSession,
  runToolContract,
} from './index.js';

// ---------------------------------------------------------------------------
// Fixture interface
// ---------------------------------------------------------------------------

/**
 * Fixture shape provided to each `mcpTest` test body.
 *
 * - `ctx` — a fresh `Context` from `createMockContext()` for each test
 * - `session` — a fresh session-bound context from `createMockSession()`
 * - `fetchMock` — a strict global fetch fake restored after each requesting test
 * - `storage` — a fresh `StorageService` backed by `InMemoryProvider` for each test
 */
export interface McpTestFixtures {
  /** Fresh mock context per test. Cast `ctx.log` to `MockContextLogger` to inspect log calls. */
  ctx: Context;
  /** Strict fetch fake installed only for tests that request this fixture. */
  fetchMock: FetchMockHarness;
  /** Fresh HTTP-session-bound context per test. */
  session: MockSession;
  /** Fresh in-memory `StorageService` per test, for services that accept a `StorageService` dep. */
  storage: StorageService;
}

// ---------------------------------------------------------------------------
// Extended test
// ---------------------------------------------------------------------------

/**
 * Vitest extended test with handler, HTTP, session, and storage fixtures.
 *
 * Each fixture is created per test, ensuring log captures, enrichment stores,
 * upstream routes, session identity, and in-memory state never bleed between tests.
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
  fetchMock: async ({}: object, use: (value: FetchMockHarness) => Promise<void>) => {
    const harness = createFetchMock();
    harness.install();
    try {
      await use(harness);
    } finally {
      harness.restore();
    }
  },
  // biome-ignore lint/correctness/noEmptyPattern: vitest's fixture API requires a destructuring pattern as the first parameter
  session: async ({}: object, use: (value: MockSession) => Promise<void>) => {
    await use(createMockSession());
  },
  // biome-ignore lint/correctness/noEmptyPattern: vitest's fixture API requires a destructuring pattern as the first parameter
  storage: async ({}: object, use: (value: StorageService) => Promise<void>) => {
    await use(createInMemoryStorage());
  },
});

// ---------------------------------------------------------------------------
// Tool contract conformance suite
// ---------------------------------------------------------------------------

/** One schema-valid success case for {@link toolContractSuite}. */
export interface ToolContractSuccessCase<TDefinition extends AnyToolDefinition> {
  /** Optional behavior-specific assertions after contract checks pass. */
  assert?: (result: CallToolResult) => Promise<void> | void;
  /** Per-case context overrides. */
  context?: MockContextOptions;
  /** Schema-valid tool input. */
  input: z.input<TDefinition['input']>;
  /** Test name. */
  name: string;
}

/** One expected failure case for {@link toolContractSuite}. */
export interface ToolContractErrorCase<TDefinition extends AnyToolDefinition> {
  /** Expected JSON-RPC error code. */
  code: number;
  /** Per-case context overrides. */
  context?: MockContextOptions;
  /** Schema-valid input that makes the handler fail. */
  input: z.input<TDefinition['input']>;
  /** Test name. */
  name: string;
  /** Optional expected `structuredContent.error.data.reason`. */
  reason?: string;
}

/** Cases and shared context for {@link toolContractSuite}. */
export interface ToolContractSuiteOptions<TDefinition extends AnyToolDefinition> {
  /** Context defaults merged into every case. */
  context?: MockContextOptions;
  /** Expected handler failures and their public error envelopes. */
  errors?: readonly ToolContractErrorCase<TDefinition>[];
  /** Schema-valid successful invocations. At least one is recommended. */
  success: readonly ToolContractSuccessCase<TDefinition>[];
}

function mergeContextOptions(
  shared: MockContextOptions | undefined,
  specific: MockContextOptions | undefined,
): MockContextOptions | undefined {
  if (!shared && !specific) return;
  return { ...shared, ...specific };
}

/**
 * Registers a reusable Vitest conformance suite for a tool definition.
 *
 * Successful cases must survive input parsing, handler invocation, output
 * parsing, and content formatting. Error cases must return the framework's
 * dual-surface error envelope (`content[]` plus `structuredContent.error`) with
 * the expected code and optional contract reason.
 *
 * @example
 * ```ts
 * toolContractSuite(searchTool, {
 *   success: [{ name: 'returns matches', input: { query: 'mcp' } }],
 *   errors: [{
 *     name: 'reports an empty query',
 *     input: { query: '' },
 *     code: JsonRpcErrorCode.InvalidParams,
 *     reason: 'empty_query',
 *   }],
 * });
 * ```
 */
export function toolContractSuite<TDefinition extends AnyToolDefinition>(
  definition: TDefinition,
  options: ToolContractSuiteOptions<TDefinition>,
): void {
  describe(`${definition.name} tool contract`, () => {
    for (const successCase of options.success) {
      test(successCase.name, async () => {
        const context = mergeContextOptions(options.context, successCase.context);
        const result = await runToolContract(definition, successCase.input, {
          ...(context && { context }),
        });

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual(expect.schemaMatching(definition.output));
        expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({})]));
        await successCase.assert?.(result);
      });
    }

    for (const errorCase of options.errors ?? []) {
      test(errorCase.name, async () => {
        const context = mergeContextOptions(options.context, errorCase.context);
        const result = await runToolContract(definition, errorCase.input, {
          ...(context && { context }),
        });
        const error = (
          result.structuredContent as {
            error?: { code?: unknown; data?: { reason?: unknown }; message?: unknown };
          }
        ).error;

        expect(result.isError).toBe(true);
        expect(result.content?.[0]).toMatchObject({
          type: 'text',
          text: expect.stringMatching(/^Error:/),
        });
        expect(error).toMatchObject({
          code: errorCase.code,
          message: expect.any(String),
        });
        if (errorCase.reason !== undefined) {
          expect(error?.data?.reason).toBe(errorCase.reason);
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Re-exports for consumers extending the fixture
// ---------------------------------------------------------------------------

export type { FetchMockHarness, MockContextOptions, MockSession };
/**
 * Re-exported so consumers can import fixture-building helpers alongside
 * `mcpTest` from one subpath when writing overrides.
 */
export {
  createFetchMock,
  createInMemoryStorage,
  createMockContext,
  createMockSession,
  runToolContract,
};

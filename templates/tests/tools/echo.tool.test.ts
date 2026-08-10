/**
 * @fileoverview Tests for the echo tool.
 * @module tests/tools/echo.tool.test
 */

import type { HandlerContext, ReasonOf } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { mcpTest } from '@cyanheads/mcp-ts-core/testing/vitest';
import { echoTool } from '@/mcp-server/tools/definitions/echo.tool.js';

/**
 * A tool that declares `errors[]` types its handler's `ctx` against that
 * contract, so tests hand it a context built the same way — `createMockContext`
 * narrows its return type from the `errors` it is given. Drop this if your tool
 * declares no error contract; a bare `createMockContext()` is enough then.
 */
type EchoContext = HandlerContext<ReasonOf<typeof echoTool.errors>>;

const echoContext = () => createMockContext({ errors: echoTool.errors });

// ---------------------------------------------------------------------------
// Fixture-based tests (mcpTest) — fresh ctx per test, no manual construction
// ---------------------------------------------------------------------------

/** Function form, not a bare value — every test gets its own context. */
const echoTest = mcpTest.extend<{ ctx: EchoContext }>({
  // biome-ignore lint/correctness/noEmptyPattern: vitest's fixture API requires a destructuring pattern as the first parameter
  ctx: async ({}, use) => {
    await use(echoContext());
  },
});

echoTest('echoTool: echoes the message back (fixture)', async ({ ctx }) => {
  const input = echoTool.input.parse({ message: 'hello world' });
  const result = await echoTool.handler(input, ctx);
  expect(result).toEqual({ message: 'hello world' });
});

echoTest('echoTool: output conforms to declared schema (fixture)', async ({ ctx }) => {
  const input = echoTool.input.parse({ message: 'hello world' });
  const result = await echoTool.handler(input, ctx);
  expect(result).toEqual(expect.schemaMatching(echoTool.output));
});

// ---------------------------------------------------------------------------
// Classic describe/it tests (createMockContext) — shown for comparison
// ---------------------------------------------------------------------------

describe('echoTool', () => {
  it('echoes the message back', async () => {
    const ctx = echoContext();
    const input = echoTool.input.parse({ message: 'hello world' });
    const result = await echoTool.handler(input, ctx);
    expect(result).toEqual({ message: 'hello world' });
  });

  it('output conforms to the declared output schema', async () => {
    const ctx = echoContext();
    const input = echoTool.input.parse({ message: 'hello world' });
    const result = await echoTool.handler(input, ctx);
    expect(result).toEqual(expect.schemaMatching(echoTool.output));
  });

  it('formats output as text content', () => {
    const blocks = echoTool.format!({ message: 'hello world' });
    expect(blocks).toEqual([{ type: 'text', text: 'hello world' }]);
  });
});

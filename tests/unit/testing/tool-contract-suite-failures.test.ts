/**
 * @fileoverview Proves `toolContractSuite` registers cases that fail when a definition
 * breaks the contract they state. The suite's `test` registrations are captured
 * through a `vitest` mock and run directly, so each broken definition is shown to
 * fail the check meant to catch it. A self-test against correct definitions alone
 * stays green with every assertion in the suite removed.
 * @module tests/unit/testing/tool-contract-suite-failures.test
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/** Every case the suite registered, by name. */
const registered = vi.hoisted(() => new Map<string, () => Promise<void> | void>());

vi.mock('vitest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vitest')>();
  // Captures the suite's cases instead of scheduling them. `extend` stays real
  // because `mcpTest` is built from it when the module loads.
  const test = Object.assign(
    (name: string, fn: () => Promise<void> | void) => {
      registered.set(name, fn);
    },
    { extend: actual.test.extend.bind(actual.test) },
  );
  // Runs the suite's own block inline, so its cases register while this file
  // collects; every other block is an ordinary `describe`.
  const describe = (name: string, fn: () => void) =>
    name.endsWith(' tool contract') ? fn() : actual.describe(name, fn);
  return { ...actual, describe, test };
});

import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { toolContractSuite } from '@/testing/vitest.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';

/** Runs the case registered as `name`, resolving with what it threw (undefined when it passed). */
async function failureOf(name: string): Promise<unknown> {
  const run = registered.get(name);
  if (!run) throw new Error(`toolContractSuite registered no case named "${name}"`);
  try {
    await run();
  } catch (error) {
    return error;
  }
  return;
}

const echo = tool('suite_failure_echo', {
  description: 'Echoes a value, or fails with a declared reason when it is empty.',
  errors: [
    {
      reason: 'empty_value',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The value is empty.',
      recovery: 'Provide a non-empty value and retry.',
    },
  ],
  input: z.object({ value: z.string().describe('Value') }),
  output: z.object({ value: z.string().describe('Echoed value') }),
  handler(input, ctx) {
    if (!input.value) throw ctx.fail('empty_value');
    return { value: input.value };
  },
  format: (output) => [{ type: 'text', text: output.value }],
});

toolContractSuite(echo, {
  success: [
    {
      name: 'echo: success the definition meets',
      input: { value: 'ok' },
      expected: { value: 'ok' },
    },
    {
      name: 'echo: expected output it does not return',
      input: { value: 'ok' },
      expected: { value: 'other' },
    },
    {
      name: 'echo: assert hook that rejects the result',
      input: { value: 'ok' },
      assert: () => {
        throw new Error('assert hook rejected the result');
      },
    },
    { name: 'echo: success the handler fails', input: { value: '' } },
  ],
  errors: [
    {
      name: 'echo: error the definition meets',
      input: { value: '' },
      code: JsonRpcErrorCode.InvalidParams,
      reason: 'empty_value',
    },
    {
      name: 'echo: error the handler never raises',
      input: { value: 'ok' },
      code: JsonRpcErrorCode.InvalidParams,
    },
    {
      name: 'echo: error with another code',
      input: { value: '' },
      code: JsonRpcErrorCode.NotFound,
    },
    {
      name: 'echo: error with another reason',
      input: { value: '' },
      code: JsonRpcErrorCode.InvalidParams,
      reason: 'not_the_reason',
    },
  ],
});

toolContractSuite(
  tool('suite_failure_silent', {
    description: 'Returns valid output but renders no content.',
    input: z.object({}),
    output: z.object({ ok: z.boolean().describe('Success') }),
    handler: () => ({ ok: true }),
    format: () => [],
  }),
  { success: [{ name: 'silent: success with no content', input: {} }] },
);

toolContractSuite(
  tool('suite_failure_context', {
    description: 'Reports the request and tenant identity it ran under.',
    input: z.object({}),
    output: z.object({
      requestId: z.string().describe('Request ID the handler saw'),
      tenantId: z.string().describe('Tenant ID the handler saw'),
    }),
    handler: (_input, ctx) => ({ requestId: ctx.requestId, tenantId: ctx.tenantId ?? '' }),
  }),
  {
    context: { requestId: 'shared-request' },
    success: [
      {
        name: 'context: shared context alone',
        input: {},
        expected: { requestId: 'shared-request', tenantId: 'default' },
      },
      {
        name: 'context: shared context merged with the case context',
        input: {},
        context: { tenantId: 'case-tenant' },
        expected: { requestId: 'shared-request', tenantId: 'case-tenant' },
      },
    ],
  },
);

describe('toolContractSuite success cases', () => {
  it('pass when the definition meets them', async () => {
    expect(await failureOf('echo: success the definition meets')).toBeUndefined();
  });

  it('fail when the structured output differs from the expected subset', async () => {
    expect(await failureOf('echo: expected output it does not return')).toMatchObject({
      message: expect.stringContaining('other'),
    });
  });

  it('fail when the case assert hook rejects the result', async () => {
    expect(await failureOf('echo: assert hook that rejects the result')).toMatchObject({
      message: 'assert hook rejected the result',
    });
  });

  it('fail when the handler fails', async () => {
    expect(await failureOf('echo: success the handler fails')).toBeInstanceOf(Error);
  });

  it('fail when the result carries no content', async () => {
    expect(await failureOf('silent: success with no content')).toMatchObject({
      message: expect.stringContaining('ArrayContaining'),
    });
  });

  it('run under the shared context, merged with the case context', async () => {
    expect(await failureOf('context: shared context alone')).toBeUndefined();
    expect(await failureOf('context: shared context merged with the case context')).toBeUndefined();
  });
});

describe('toolContractSuite error cases', () => {
  it('pass when the definition meets them', async () => {
    expect(await failureOf('echo: error the definition meets')).toBeUndefined();
  });

  it('fail when the handler succeeds', async () => {
    expect(await failureOf('echo: error the handler never raises')).toBeInstanceOf(Error);
  });

  it('fail when the envelope carries another code', async () => {
    expect(await failureOf('echo: error with another code')).toMatchObject({
      message: expect.stringContaining(String(JsonRpcErrorCode.NotFound)),
    });
  });

  it('fail when the envelope carries another reason', async () => {
    expect(await failureOf('echo: error with another reason')).toMatchObject({
      message: expect.stringContaining('not_the_reason'),
    });
  });
});

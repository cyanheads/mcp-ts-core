/**
 * @fileoverview Branch and failure-contract tests for the public fuzz test kit.
 * @module tests/unit/testing/fuzz-branches.test
 */

import fc from 'fast-check';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { prompt } from '@/mcp-server/prompts/utils/promptDefinition.js';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { fuzzPrompt, fuzzResource, fuzzTool, loadFc, zodToArbitrary } from '@/testing/fuzz.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

beforeAll(() => loadFc());

describe('zodToArbitrary public contract', () => {
  it('requires explicit loading for standalone use', async () => {
    vi.resetModules();
    const isolated = await import('@/testing/fuzz.js');

    expect(() => isolated.zodToArbitrary(z.string())).toThrow(
      'fast-check not loaded. Call fuzzTool/fuzzResource/fuzzPrompt first',
    );

    await isolated.loadFc();
  });

  it('honors array minimums larger than the default maximum', () => {
    const schema = z.array(z.string()).min(7);
    const values = fc.sample(zodToArbitrary(schema), 20);

    expect(values).toHaveLength(20);
    for (const value of values) {
      expect(schema.safeParse(value).success).toBe(true);
      expect(value).toHaveLength(7);
    }
  });

  it.each([
    ['max', z.array(z.string()).max(3)],
    ['length', z.array(z.string()).length(4)],
    ['nonempty', z.array(z.string()).nonempty()],
    ['min and max', z.array(z.string()).min(2).max(3)],
  ])('honors the %s array length constraint', (_label, schema) => {
    const values = fc.sample(zodToArbitrary(schema), 20);

    expect(values.every((value) => schema.safeParse(value).success)).toBe(true);
  });

  it('generates unconstrained arrays without inventing bounds', () => {
    const schema = z.array(z.string());
    const values = fc.sample(zodToArbitrary(schema), 40) as string[][];

    expect(values.every((value) => value.length <= 5)).toBe(true);
    expect(values.some((value) => value.length > 0)).toBe(true);
  });

  it('falls back to JSON-safe primitives for unsupported schema metadata', () => {
    const values = fc.sample(zodToArbitrary({}), 40);

    expect(values).toHaveLength(40);
    for (const value of values) {
      expect(
        value === null ||
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean',
      ).toBe(true);
    }
  });

  it('generates schema-valid samples for finite object nesting beyond depth six', () => {
    let schema: z.ZodType = z.string();
    for (let depth = 0; depth < 8; depth++) {
      schema = z.object({ child: schema });
    }

    const values = fc.sample(zodToArbitrary(schema), 20);
    expect(values.every((value) => schema.safeParse(value).success)).toBe(true);
  });

  it('generates schema-valid samples for finite array nesting beyond depth six', () => {
    let schema: z.ZodType = z.string();
    for (let depth = 0; depth < 8; depth++) {
      schema = z.array(schema);
    }

    const values = fc.sample(zodToArbitrary(schema), 10);
    expect(values.every((value) => schema.safeParse(value).success)).toBe(true);
  });

  it('terminates a self-referential schema with an empty array', () => {
    const category: z.ZodType = z.object({
      name: z.string().describe('Name'),
      get children() {
        return z.array(category);
      },
    });

    const values = fc.sample(zodToArbitrary(category), 10);

    expect(values.every((value) => category.safeParse(value).success)).toBe(true);
    expect(values.every((value) => (value as { children: unknown[] }).children.length === 0)).toBe(
      true,
    );
  });

  it('terminates mutually recursive schemas', () => {
    const author: z.ZodType = z.object({
      name: z.string().describe('Name'),
      get books() {
        return z.array(book);
      },
    });
    const book: z.ZodType = z.object({
      title: z.string().describe('Title'),
      get authors() {
        return z.array(author);
      },
    });

    const values = fc.sample(zodToArbitrary(author), 10);
    expect(values.every((value) => author.safeParse(value).success)).toBe(true);
  });

  it('treats a node reused in sibling positions as finite, not recursive', () => {
    const shared = z.string().min(2);
    const schema = z.object({ left: shared, right: z.object({ nested: shared }) });

    const values = fc.sample(zodToArbitrary(schema), 20);
    expect(values.every((value) => schema.safeParse(value).success)).toBe(true);
  });

  it('yields a finite arbitrary for an unsatisfiable required self-reference', () => {
    const unsatisfiable: z.ZodType = z.object({
      get self() {
        return unsatisfiable;
      },
    });

    expect(() => fc.sample(zodToArbitrary(unsatisfiable), 3)).not.toThrow();
  });

  it('omits a recursive optional field rather than nesting forever', () => {
    const node: z.ZodType = z.object({
      id: z.string().describe('Identifier'),
      get parent() {
        return (node as z.ZodObject).optional();
      },
    });

    const values = fc.sample(zodToArbitrary(node), 10) as Array<{ parent?: unknown }>;

    expect(values.every((value) => node.safeParse(value).success)).toBe(true);
    expect(values.every((value) => value.parent === undefined)).toBe(true);
  });

  it('nulls a recursive nullable field rather than nesting forever', () => {
    const node: z.ZodType = z.object({
      id: z.string().describe('Identifier'),
      get parent() {
        return (node as z.ZodObject).nullable();
      },
    });

    const values = fc.sample(zodToArbitrary(node), 10) as Array<{ parent: unknown }>;

    expect(values.every((value) => node.safeParse(value).success)).toBe(true);
    expect(values.every((value) => value.parent === null)).toBe(true);
  });

  it('drops a recursive defaulted field so the schema resolves its default', () => {
    const node: z.ZodType = z.object({
      id: z.string().describe('Identifier'),
      get parent() {
        return (node as z.ZodObject).default({ id: 'root' });
      },
    });

    const values = fc.sample(zodToArbitrary(node), 10) as Array<{ parent: unknown }>;

    expect(values.every((value) => value.parent === undefined)).toBe(true);
    expect(node.safeParse(values[0]).success).toBe(true);
  });

  it('drops union members that cannot terminate and keeps the ones that can', () => {
    const branching: z.ZodType = z.object({
      id: z.string().describe('Identifier'),
      get next() {
        return z.union([branching, z.string()]);
      },
    });

    const values = fc.sample(zodToArbitrary(branching), 10) as Array<{ next: unknown }>;

    expect(values.every((value) => branching.safeParse(value).success)).toBe(true);
    expect(values.every((value) => typeof value.next === 'string')).toBe(true);
  });

  it('stops expanding a schema whose getters mint a fresh node on every access', () => {
    const makeFresh = (): z.ZodType =>
      z.object({
        get child() {
          return makeFresh();
        },
      });

    expect(() => fc.sample(zodToArbitrary(makeFresh()), 1)).not.toThrow();
  });

  it('resolves the tightest bound when array constraints are declared twice', () => {
    const schema = z.array(z.string()).min(2).min(4).max(9).max(6);
    const values = fc.sample(zodToArbitrary(schema), 20) as string[][];

    expect(values.every((value) => value.length >= 4 && value.length <= 6)).toBe(true);
    expect(values.every((value) => schema.safeParse(value).success)).toBe(true);
  });

  it('yields an arbitrary for an array whose bounds cannot be satisfied', () => {
    const schema = z.array(z.string()).min(6).max(2);

    expect(() => fc.sample(zodToArbitrary(schema), 3)).not.toThrow();
  });
});

describe('fuzzTool failure accounting', () => {
  it('records ordinary handler errors as crashes', async () => {
    const definition = tool('fuzz_crash_accounting', {
      description: 'Throws an ordinary error.',
      input: z.object({ value: z.string().describe('Value') }),
      output: z.object({ ok: z.boolean().describe('Success') }),
      handler() {
        throw new Error('ordinary handler crash');
      },
    });

    const report = await fuzzTool(definition, { numRuns: 1, numAdversarial: 0, seed: 41 });

    expect(report.crashes).toHaveLength(1);
    expect(report.crashes[0]?.error).toMatchObject({ message: 'ordinary handler crash' });
  });

  it('records leaked internals from handled MCP errors', async () => {
    const definition = tool('fuzz_mcp_leak_accounting', {
      description: 'Throws an MCP error with an unsafe message.',
      input: z.object({ value: z.string().describe('Value') }),
      output: z.object({ ok: z.boolean().describe('Success') }),
      handler() {
        throw new McpError(
          JsonRpcErrorCode.InternalError,
          'at handler (/Users/example/private/server.ts:1:1)',
        );
      },
    });

    const report = await fuzzTool(definition, { numRuns: 1, numAdversarial: 0, seed: 42 });

    expect(report.crashes).toHaveLength(0);
    expect(report.leaks).toHaveLength(1);
    expect(report.leaks[0]?.errorText).toContain('/Users/example/private');
  });

  it('scans client-visible McpError data for leaked internals', async () => {
    const definition = tool('fuzz_mcp_data_leak_accounting', {
      description: 'Throws an MCP error with unsafe public data.',
      input: z.object({ value: z.string().describe('Value') }),
      output: z.object({ ok: z.boolean().describe('Success') }),
      handler() {
        throw new McpError(JsonRpcErrorCode.InternalError, 'Safe message', {
          rawError: 'Error: sentinel\n    at parser (/Users/example/private/parser.ts:1:1)',
        });
      },
    });

    const report = await fuzzTool(definition, { numRuns: 1, numAdversarial: 0, seed: 421 });

    expect(report.crashes).toHaveLength(0);
    expect(report.leaks).toHaveLength(1);
    expect(report.leaks[0]?.errorText).toContain('/Users/example/private/parser.ts');
  });

  it('detects and removes Object.prototype pollution introduced by a handler', async () => {
    const definition = tool('fuzz_prototype_pollution_accounting', {
      description: 'Pollutes Object.prototype for guard verification.',
      input: z.object({}),
      output: z.object({ ok: z.boolean().describe('Success') }),
      handler() {
        Object.defineProperty(Object.prototype, 'fuzzPolluted', {
          configurable: true,
          enumerable: true,
          value: true,
        });
        return { ok: true };
      },
    });

    try {
      const report = await fuzzTool(definition, {
        numRuns: 1,
        numAdversarial: 0,
        seed: 43,
      });

      expect(report.prototypePollution).toBe(true);
      expect(Object.hasOwn(Object.prototype, 'fuzzPolluted')).toBe(false);
    } finally {
      Reflect.deleteProperty(Object.prototype, 'fuzzPolluted');
    }
  });

  it('checks non-Error adversarial failures for internal-path leaks', async () => {
    const definition = tool('fuzz_adversarial_leak_accounting', {
      description: 'Throws a non-Error value for every accepted payload.',
      input: z.object({ payload: z.any().describe('Payload') }),
      output: z.object({ ok: z.boolean().describe('Success') }),
      handler() {
        throw '/home/example/private/server.ts';
      },
    });

    const report = await fuzzTool(definition, { numRuns: 1, numAdversarial: 2, seed: 44 });

    expect(report.crashes.length).toBeGreaterThan(0);
    expect(report.leaks.length).toBeGreaterThan(0);
    expect(report.leaks.every((leak) => leak.errorText.includes('/home/example/private'))).toBe(
      true,
    );
  });

  it('runs raw object payloads that an empty passthrough schema accepts', async () => {
    const handler = vi.fn(() => ({ ok: true }));
    const definition = tool('fuzz_raw_object_acceptance', {
      description: 'Accepts arbitrary object keys.',
      input: z.object({}).passthrough(),
      output: z.object({ ok: z.boolean().describe('Success') }),
      handler,
    });

    const report = await fuzzTool(definition, { numRuns: 1, numAdversarial: 0, seed: 45 });

    expect(report.crashes).toHaveLength(0);
    expect(handler).toHaveBeenCalledTimes(3);
    const calls = handler.mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(calls.some(([input]) => Object.hasOwn(input, 'constructor'))).toBe(true);
  });

  it('applies public defaults when options are omitted', async () => {
    const definition = tool('fuzz_default_options', {
      description: 'Exercises default fuzz counts.',
      input: z.object({}),
      output: z.object({ ok: z.boolean().describe('Success') }),
      handler: () => ({ ok: true }),
    });

    const report = await fuzzTool(definition);

    expect(report.totalRuns).toBe(89);
    expect(report.crashes).toHaveLength(0);
  });
});

describe('fuzzResource failure accounting', () => {
  it('records crashes and leaks for accepted resource params', async () => {
    const crashing = resource('fuzz://crash/{value}', {
      description: 'Throws an ordinary error.',
      params: z.object({ value: z.string().describe('Value') }),
      handler() {
        throw new Error('resource crash');
      },
    });
    const leaking = resource('fuzz://leak/{payload}', {
      description: 'Throws a non-Error path leak.',
      params: z.object({ payload: z.any().describe('Payload') }),
      handler() {
        throw 'C:\\private\\resource.ts';
      },
    });

    const crashReport = await fuzzResource(crashing, {
      numRuns: 1,
      numAdversarial: 0,
      seed: 46,
    });
    const leakReport = await fuzzResource(leaking, {
      numRuns: 1,
      numAdversarial: 2,
      seed: 47,
    });

    expect(crashReport.crashes).toHaveLength(1);
    expect(leakReport.leaks.length).toBeGreaterThan(0);
  });

  it('skips generated params rejected by additional schema constraints', async () => {
    const handler = vi.fn(() => ({ ok: true }));
    const definition = resource('fuzz://constrained/{value}', {
      description: 'Accepts one exact constrained value.',
      params: z.object({
        value: z
          .string()
          .regex(/^only$/)
          .describe('Exact value'),
      }),
      handler,
    });

    const report = await fuzzResource(definition, {
      numRuns: 3,
      numAdversarial: 0,
      seed: 48,
    });

    expect(report.crashes).toHaveLength(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it('applies public defaults to no-param resources when options are omitted', async () => {
    const definition = resource('fuzz://default-options', {
      description: 'No-parameter resource.',
      handler: () => ({ ok: true }),
    });

    const report = await fuzzResource(definition);

    expect(report.totalRuns).toBe(1);
    expect(report.crashes).toHaveLength(0);
  });
});

describe('fuzzPrompt failure accounting', () => {
  it('runs adversarial values accepted by permissive prompt args', async () => {
    const generate = vi.fn(() => [
      { role: 'user' as const, content: { type: 'text' as const, text: 'ok' } },
    ]);
    const definition = prompt('fuzz_prompt_permissive_args', {
      description: 'Accepts arbitrary prompt payloads.',
      args: z.object({ payload: z.any().describe('Payload') }),
      generate,
    });

    const report = await fuzzPrompt(definition, { numRuns: 1, numAdversarial: 2, seed: 49 });

    expect(report.crashes).toHaveLength(0);
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('skips generated args rejected by additional schema constraints', async () => {
    const generate = vi.fn(() => [
      { role: 'user' as const, content: { type: 'text' as const, text: 'ok' } },
    ]);
    const definition = prompt('fuzz_prompt_constrained_args', {
      description: 'Accepts one exact constrained value.',
      args: z.object({
        value: z
          .string()
          .regex(/^only$/)
          .describe('Exact value'),
      }),
      generate,
    });

    const report = await fuzzPrompt(definition, { numRuns: 3, numAdversarial: 0, seed: 50 });

    expect(report.crashes).toHaveLength(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it('records a thrown no-args prompt error and applies default options', async () => {
    const definition = prompt('fuzz_prompt_default_options', {
      description: 'Throws without prompt args.',
      generate() {
        throw 'prompt generation failed';
      },
    });

    const report = await fuzzPrompt(definition);

    expect(report.totalRuns).toBe(1);
    expect(report.crashes).toEqual([{ input: {}, error: 'prompt generation failed' }]);
  });
});

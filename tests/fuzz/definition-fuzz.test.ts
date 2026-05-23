/**
 * @fileoverview Fuzz tests for MCP definition handlers using the fuzzTool/fuzzResource/fuzzPrompt
 * test utilities. Exercises handler functions directly (not through the SDK handler factory)
 * with schema-generated valid inputs and adversarial payloads.
 * @module tests/fuzz/definition-fuzz.test
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { prompt } from '@/mcp-server/prompts/utils/promptDefinition.js';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import {
  adversarialObjectArbitrary,
  type FuzzReport,
  fuzzPrompt,
  fuzzResource,
  fuzzTool,
  zodToArbitrary,
} from '@/testing/fuzz.js';

// ---------------------------------------------------------------------------
// Test definitions — representative schema shapes
// ---------------------------------------------------------------------------

const echoTool = tool('fuzz_echo', {
  description: 'Echoes input.',
  input: z.object({ message: z.string().describe('Message') }),
  output: z.object({ echo: z.string().describe('Echo') }),
  handler: (input) => ({ echo: input.message }),
});

const mathTool = tool('fuzz_math', {
  description: 'Adds two numbers.',
  input: z.object({
    a: z.number().describe('First number'),
    b: z.number().describe('Second number'),
  }),
  output: z.object({ sum: z.number().describe('Sum') }),
  handler: (input) => ({ sum: input.a + input.b }),
});

const complexTool = tool('fuzz_complex_def', {
  description: 'Complex schema with arrays, enums, optionals.',
  input: z.object({
    query: z.string().min(1).describe('Search query'),
    limit: z.number().int().min(1).max(100).default(10).describe('Result limit'),
    filters: z.array(z.string().describe('Filter value')).max(5).optional().describe('Filters'),
    sort: z.enum(['asc', 'desc']).default('asc').describe('Sort order'),
  }),
  output: z.object({
    results: z
      .array(
        z.object({
          id: z.string().describe('Result ID'),
          score: z.number().describe('Relevance score'),
        }),
      )
      .describe('Search results'),
    total: z.number().int().describe('Total count'),
  }),
  handler: () => ({
    results: [{ id: 'fuzz-1', score: 0.99 }],
    total: 1,
  }),
});

const statefulTool = tool('fuzz_stateful', {
  description: 'Uses ctx.state and ctx.log.',
  input: z.object({ key: z.string().describe('Storage key') }),
  output: z.object({ found: z.boolean().describe('Whether key exists') }),
  async handler(input, ctx) {
    ctx.log.info('Looking up key', { key: input.key });
    const value = await ctx.state.get(input.key);
    return { found: value !== null };
  },
});

const echoResource = resource('fuzz://{itemId}', {
  description: 'Fuzz resource with param.',
  params: z.object({ itemId: z.string().describe('Item ID') }),
  output: z.object({ id: z.string().describe('Item ID'), status: z.string().describe('Status') }),
  handler: (params) => ({ id: params.itemId, status: 'active' }),
});

const noParamsResource = resource('fuzz://static', {
  description: 'Static resource with no params.',
  handler: () => ({ data: 'static' }),
});

const echoPrompt = prompt('fuzz_echo_prompt', {
  description: 'Echo prompt.',
  args: z.object({
    message: z.string().describe('Message to echo'),
    tone: z.enum(['formal', 'casual']).optional().describe('Tone'),
  }),
  generate: (args) => [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `${args.tone === 'formal' ? 'Please echo: ' : 'Echo: '}${args.message}`,
      },
    },
  ],
});

const noArgsPrompt = prompt('fuzz_no_args', {
  description: 'Prompt with no args.',
  generate: () => [{ role: 'user', content: { type: 'text', text: 'Hello' } }],
});

// ---------------------------------------------------------------------------
// Fuzz helper
// ---------------------------------------------------------------------------

function expectCleanReport(report: FuzzReport) {
  expect(report.crashes).toHaveLength(0);
  expect(report.leaks).toHaveLength(0);
  expect(report.prototypePollution).toBe(false);
  expect(report.totalRuns).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fuzzTool', () => {
  it('echoTool survives fuzz testing', async () => {
    const report = await fuzzTool(echoTool as any, { numRuns: 30, numAdversarial: 20 });
    expectCleanReport(report);
  });

  it('mathTool survives fuzz testing', async () => {
    const report = await fuzzTool(mathTool as any, { numRuns: 30, numAdversarial: 20 });
    expectCleanReport(report);
  });

  it('complexTool survives fuzz testing', async () => {
    const report = await fuzzTool(complexTool as any, { numRuns: 30, numAdversarial: 20 });
    expectCleanReport(report);
  });

  it('statefulTool survives fuzz testing (with tenant)', async () => {
    const report = await fuzzTool(statefulTool as any, {
      numRuns: 30,
      numAdversarial: 20,
      ctx: { tenantId: 'fuzz-tenant' },
    });
    expectCleanReport(report);
  });

  it('reports are reproducible with seed', async () => {
    const report1 = await fuzzTool(echoTool as any, { numRuns: 20, seed: 12345 });
    const report2 = await fuzzTool(echoTool as any, { numRuns: 20, seed: 12345 });
    expect(report1.totalRuns).toBe(report2.totalRuns);
    expect(report1.crashes.length).toBe(report2.crashes.length);
  });
});

describe('fuzzResource', () => {
  it('echoResource survives fuzz testing', async () => {
    const report = await fuzzResource(echoResource as any, { numRuns: 30, numAdversarial: 20 });
    expectCleanReport(report);
  });

  it('noParamsResource survives fuzz testing', async () => {
    const report = await fuzzResource(noParamsResource as any, { numRuns: 5 });
    expectCleanReport(report);
  });
});

describe('fuzzPrompt', () => {
  it('echoPrompt survives fuzz testing', async () => {
    const report = await fuzzPrompt(echoPrompt as any, { numRuns: 30, numAdversarial: 20 });
    expectCleanReport(report);
  });

  it('noArgsPrompt survives fuzz testing', async () => {
    const report = await fuzzPrompt(noArgsPrompt as any, { numRuns: 5 });
    expectCleanReport(report);
  });

  it('reports a crash when generate() returns a non-array for valid args', async () => {
    const badPrompt = prompt('fuzz_bad_prompt', {
      description: 'Invalid prompt result.',
      args: z.object({ message: z.string().describe('Message') }),
      generate: ((args: { message: string }) => ({
        role: 'user',
        content: { type: 'text', text: args.message },
      })) as any,
    });

    const report = await fuzzPrompt(badPrompt as any, {
      numRuns: 3,
      numAdversarial: 0,
      seed: 101,
    });

    expect(report.crashes.length).toBeGreaterThan(0);
    expect(report.crashes[0]?.error).toBeInstanceOf(Error);
    expect((report.crashes[0]?.error as Error).message).toContain('did not return array');
  });

  it('reports a crash when a no-args generate() returns a non-array', async () => {
    const badPrompt = prompt('fuzz_bad_no_args', {
      description: 'Invalid no-args prompt result.',
      generate: (() => ({ role: 'user', content: { type: 'text', text: 'Hello' } })) as any,
    });

    const report = await fuzzPrompt(badPrompt as any, { numRuns: 1 });

    expect(report.crashes).toHaveLength(1);
    expect((report.crashes[0]?.error as Error).message).toContain('did not return array');
  });
});

describe('zodToArbitrary', () => {
  it('generates valid values for string schemas', () => {
    const arb = zodToArbitrary(z.string());
    const values: unknown[] = [];
    for (let i = 0; i < 20; i++) {
      fc.assert(
        fc.property(arb, (v) => {
          values.push(v);
        }),
        { numRuns: 1 },
      );
    }
    expect(values.every((v) => typeof v === 'string')).toBe(true);
  });

  it('generates valid values for number schemas', () => {
    const schema = z.number().int().min(0).max(100);
    const arb = zodToArbitrary(schema);
    fc.assert(
      fc.property(arb, (v) => {
        expect(schema.safeParse(v).success).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it('generates valid values for enum schemas', () => {
    const schema = z.enum(['a', 'b', 'c']);
    const arb = zodToArbitrary(schema);
    fc.assert(
      fc.property(arb, (v) => {
        expect(schema.safeParse(v).success).toBe(true);
      }),
      { numRuns: 20 },
    );
  });

  it('generates valid values for object schemas', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().int(),
      active: z.boolean(),
    });
    const arb = zodToArbitrary(schema);
    fc.assert(
      fc.property(arb, (v) => {
        expect(schema.safeParse(v).success).toBe(true);
      }),
      { numRuns: 30 },
    );
  });

  it('generates valid values for nested object schemas', () => {
    const schema = z.object({
      user: z.object({
        name: z.string(),
        email: z.string().email(),
      }),
      tags: z.array(z.string()),
    });
    const arb = zodToArbitrary(schema);
    fc.assert(
      fc.property(arb, (v) => {
        expect(schema.safeParse(v).success).toBe(true);
      }),
      { numRuns: 30 },
    );
  });

  it('handles optional and nullable fields', () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
      nullable: z.string().nullable(),
      defaulted: z.number().default(0),
    });
    const arb = zodToArbitrary(schema);
    fc.assert(
      fc.property(arb, (v) => {
        expect(schema.safeParse(v).success).toBe(true);
      }),
      { numRuns: 30 },
    );
  });

  it('generates valid values for allowlisted string formats, literal, and union schemas', () => {
    const schema = z.object({
      contact: z.email(),
      id: z.uuid(),
      kind: z.literal('fixed'),
      value: z.union([z.string().min(1), z.number().int().min(0).max(10)]),
    });
    const arb = zodToArbitrary(schema);

    fc.assert(
      fc.property(arb, (v) => {
        expect(schema.safeParse(v).success).toBe(true);
      }),
      { numRuns: 30 },
    );
  });

  it('can generate valid URL values even though format: "uri" is not portable by default', () => {
    const schema = z.object({
      link: z.url(),
    });
    const arb = zodToArbitrary(schema);

    fc.assert(
      fc.property(arb, (v) => {
        expect(schema.safeParse(v).success).toBe(true);
      }),
      { numRuns: 10 },
    );
  });

  it('generates an empty object for empty object schemas', () => {
    const schema = z.object({});
    const arb = zodToArbitrary(schema);

    fc.assert(
      fc.property(arb, (v) => {
        expect(v).toEqual({});
        expect(schema.safeParse(v).success).toBe(true);
      }),
      { numRuns: 5 },
    );
  });
});

describe('adversarialObjectArbitrary', () => {
  it('generates key-shaped adversarial objects for non-empty schemas', () => {
    const schema = z.object({
      query: z.string(),
      limit: z.number(),
    });
    const values = fc.sample(adversarialObjectArbitrary(schema), 10);

    expect(values).toHaveLength(10);
    for (const value of values) {
      expect(Object.keys(value).sort()).toEqual(['limit', 'query']);
    }
  });

  it('generates adversarial top-level values for empty object schemas', () => {
    const values = fc.sample(adversarialObjectArbitrary(z.object({})), 20);

    expect(values.length).toBeGreaterThan(0);
    expect(values.some((value) => value === null || typeof value !== 'object')).toBe(true);
  });
});

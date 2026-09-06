/**
 * @fileoverview Regression tests proving fuzz runners execute constrained handlers and release deadlines.
 * @module tests/unit/testing/fuzz-contract-regressions.test
 */
import fc from 'fast-check';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { prompt } from '@/mcp-server/prompts/utils/promptDefinition.js';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { fuzzPrompt, fuzzResource, fuzzTool, loadFc, zodToArbitrary } from '@/testing/fuzz.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';

beforeAll(() => loadFc());
afterEach(() => vi.useRealTimers());

const options = { numRuns: 4, numAdversarial: 0, seed: 385, timeout: 20 };
const output = z.object({ ok: z.boolean().describe('Success') });
const errors = [
  {
    reason: 'missing',
    code: JsonRpcErrorCode.NotFound,
    when: 'Item is absent.',
    recovery: 'Choose another item.',
  },
] as const;

describe('schema-aware fuzz execution', () => {
  it.each([
    z.string().regex(/^item-[a-z]{2,6}$/),
    z
      .string()
      .regex(/^[a-z]{2,8}$/)
      .min(4)
      .max(6)
      .regex(/^[a-m]+$/),
    z.string().regex(/^ONLY$/i),
  ])('generates strings satisfying every declared regex and length check', (schema) => {
    const samples = fc.sample(zodToArbitrary(schema), { numRuns: 30, seed: options.seed });
    expect(samples).toHaveLength(30);
    for (const sample of samples) expect(schema.safeParse(sample).success).toBe(true);
  });

  it.each([z.string().regex(/^a$/).regex(/^b$/), z.string().regex(/^a$/).min(2)])(
    'fails boundedly when regex and length constraints cannot produce a sample',
    (schema) => {
      expect(() => fc.sample(zodToArbitrary(schema), { numRuns: 1, seed: options.seed })).toThrow(
        'after 1000 rejected candidates',
      );
    },
  );

  it('reaches tool, resource, and prompt handlers with regex-constrained input', async () => {
    const input = z.object({
      id: z
        .string()
        .regex(/^item-[a-z]{3}$/)
        .describe('Item ID'),
    });
    const handler = vi.fn(() => ({ ok: true }));
    const generate = vi.fn(() => [
      { role: 'user' as const, content: { type: 'text' as const, text: 'ok' } },
    ]);
    const toolReport = await fuzzTool(
      tool('fuzz_regex', { description: 'Regex tool.', input, output, handler }),
      options,
    );
    expect(handler).toHaveBeenCalledTimes(options.numRuns + 1);
    const resourceReport = await fuzzResource(
      resource('fuzz://regex/{id}', { description: 'Regex resource.', params: input, handler }),
      options,
    );
    expect(handler).toHaveBeenCalledTimes(2 * options.numRuns + 1);
    const promptReport = await fuzzPrompt(
      prompt('fuzz_regex', { description: 'Regex prompt.', args: input, generate }),
      options,
    );
    expect(generate).toHaveBeenCalledTimes(options.numRuns);
    expect([toolReport.crashes, resourceReport.crashes, promptReport.crashes]).toEqual([
      [],
      [],
      [],
    ]);
  });

  it.each(['valid', 'adversarial', 'no-params'] as const)(
    'supplies resource error contracts in the %s phase',
    async (phase) => {
      const handler = vi.fn((_params, ctx) => {
        throw ctx.fail('missing');
      });
      const definition = resource('fuzz://errors', {
        description: 'Resource with declared failures.',
        ...(phase !== 'no-params' && { params: z.object({ value: z.any().describe('Value') }) }),
        errors,
        handler,
      });
      const report = await fuzzResource(definition, {
        ...options,
        numRuns: phase === 'adversarial' ? 0 : 1,
        numAdversarial: phase === 'adversarial' ? 3 : 0,
      });
      expect(handler).toHaveBeenCalledTimes(phase === 'adversarial' ? 3 : 1);
      expect(report.crashes).toEqual([]);
      expect(report.leaks).toEqual([]);
    },
  );

  it('replays the cancelled call with the configured seed and an aborted signal', async () => {
    const calls: Array<{ value: string; aborted: boolean }> = [];
    const definition = tool('fuzz_abort', {
      description: 'Observe cancellation.',
      input: z.object({ value: z.string().describe('Value') }),
      output,
      handler(input, ctx) {
        calls.push({ value: input.value, aborted: ctx.signal.aborted });
        ctx.signal.throwIfAborted();
        return { ok: true };
      },
    });
    const first = await fuzzTool(definition, options);
    const firstCalls = calls.splice(0);
    const second = await fuzzTool(definition, options);
    expect(firstCalls).toHaveLength(options.numRuns + 1);
    expect(firstCalls.at(-1)?.aborted).toBe(true);
    expect(firstCalls.slice(0, -1).every((call) => !call.aborted)).toBe(true);
    expect(calls).toEqual(firstCalls);
    expect([first.crashes, second.crashes]).toEqual([[], []]);
  });

  it('reports a handler that hangs only after cancellation', async () => {
    const pending = Promise.withResolvers<{ ok: boolean }>();
    const definition = tool('fuzz_abort_hang', {
      description: 'Hang after cancellation.',
      input: z.object({ value: z.string().describe('Value') }),
      output,
      handler(_input, ctx) {
        return ctx.signal.aborted ? pending.promise : { ok: true };
      },
    });
    const report = await fuzzTool(definition, options);
    expect(report.crashes).toHaveLength(1);
    expect(report.crashes[0]?.error).toMatchObject({ message: 'Fuzz timeout after 20ms' });
    pending.resolve({ ok: true });
    await pending.promise;
  });
});

describe('fuzz deadline cleanup', () => {
  it.each(['success', 'rejection'] as const)(
    'leaves no pending timers after %s in every runner',
    async (outcome) => {
      vi.useFakeTimers();
      const handler = () => {
        if (outcome === 'rejection') throw new Error('handler failed');
        return { ok: true };
      };
      const asyncHandler = async () => handler();
      await fuzzTool(
        tool('fuzz_timer', {
          description: 'Deadline tool.',
          input: z.object({ value: z.string().describe('Value') }),
          output,
          handler: asyncHandler,
        }),
        options,
      );
      expect(vi.getTimerCount()).toBe(0);
      await fuzzResource(
        resource('fuzz://timer', { description: 'Deadline resource.', handler: asyncHandler }),
        options,
      );
      expect(vi.getTimerCount()).toBe(0);
      await fuzzPrompt(
        prompt('fuzz_timer', {
          description: 'Deadline prompt.',
          async generate() {
            handler();
            return [{ role: 'user', content: { type: 'text', text: 'ok' } }];
          },
        }),
        options,
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe('fuzz output contracts', () => {
  it.each(['missing', 'invalid', 'valid'] as const)(
    'checks %s enrichment after the handler returns domain output',
    async (mode) => {
      const definition = tool('fuzz_enrichment', {
        description: 'Required result context.',
        input: z.object({ value: z.any().describe('Value') }),
        output,
        enrichment: { count: z.number().describe('Result count') },
        handler(_input, ctx) {
          if (mode === 'valid') ctx.enrich({ count: 1 });
          // @ts-expect-error Deliberately corrupt enrichment to test runtime validation.
          if (mode === 'invalid') ctx.enrich({ count: 'invalid' });
          return { ok: true };
        },
      });
      const report = await fuzzTool(definition, { ...options, numRuns: 1, numAdversarial: 1 });
      expect(report.crashes.length).toBe(mode === 'valid' ? 0 : 2);
    },
  );

  it.each(['valid', 'adversarial', 'no-params'] as const)(
    'validates declared resource output in the %s phase',
    async (phase) => {
      const definition = resource('fuzz://invalid-output', {
        description: 'Invalid resource output.',
        ...(phase !== 'no-params' && { params: z.object({ value: z.any().describe('Value') }) }),
        output,
        handler: () => JSON.parse('{"ok":"invalid"}'),
      });
      const report = await fuzzResource(definition, {
        ...options,
        numRuns: phase === 'adversarial' ? 0 : 1,
        numAdversarial: phase === 'adversarial' ? 1 : 0,
      });
      expect(report.crashes).toHaveLength(1);
      expect(report.crashes[0]?.error).toBeInstanceOf(z.ZodError);
    },
  );

  it.each(['valid', 'adversarial', 'no-args'] as const)(
    'rejects malformed prompt messages in the %s phase',
    async (phase) => {
      const definition = prompt('fuzz_invalid_message', {
        description: 'Malformed message content.',
        ...(phase !== 'no-args' && { args: z.object({ value: z.any().describe('Value') }) }),
        generate: () => JSON.parse('[{"role":"user","content":{"type":"text","text":42}}]'),
      });
      const report = await fuzzPrompt(definition, {
        ...options,
        numRuns: phase === 'adversarial' ? 0 : 1,
        numAdversarial: phase === 'adversarial' ? 1 : 0,
      });
      expect(report.crashes).toHaveLength(1);
    },
  );
});

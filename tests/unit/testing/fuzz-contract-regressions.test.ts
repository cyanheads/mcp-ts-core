/**
 * @fileoverview Regression tests proving fuzz runners execute constrained handlers and release deadlines.
 * @module tests/unit/testing/fuzz-contract-regressions.test
 */
import fc from 'fast-check';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { isOutputContractViolation } from '@/mcp-server/outputContract.js';
import { prompt } from '@/mcp-server/prompts/utils/promptDefinition.js';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { fuzzPrompt, fuzzResource, fuzzTool, loadFc, zodToArbitrary } from '@/testing/fuzz.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

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

describe('fuzz per-call deadlines', () => {
  it.each([
    ['tool', 'valid'],
    ['tool', 'adversarial'],
    ['resource', 'valid'],
    ['resource', 'adversarial'],
    ['prompt', 'valid'],
    ['prompt', 'adversarial'],
  ] as const)('reports a %s handler that never settles in the %s phase', async (kind, phase) => {
    // Settles a second after the first call, well past the 20 ms deadline, so a
    // phase that waits instead of timing out leaves every later call settled too.
    const settle = Promise.withResolvers<{ ok: boolean }>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hang = () => {
      timer ??= setTimeout(() => settle.resolve({ ok: true }), 1_000);
      return settle.promise;
    };
    const params = z.object({ value: z.any().describe('Value') });
    const phaseOptions = {
      ...options,
      numRuns: phase === 'valid' ? 1 : 0,
      numAdversarial: phase === 'adversarial' ? 1 : 0,
    };

    try {
      const report =
        kind === 'tool'
          ? await fuzzTool(
              tool('fuzz_hang', {
                description: 'Never settles.',
                input: params,
                output,
                handler: hang,
              }),
              phaseOptions,
            )
          : kind === 'resource'
            ? await fuzzResource(
                resource('fuzz://hang/{value}', {
                  description: 'Never settles.',
                  params,
                  handler: hang,
                }),
                phaseOptions,
              )
            : await fuzzPrompt(
                prompt('fuzz_hang', {
                  description: 'Never settles.',
                  args: params,
                  generate: () => hang().then(() => []),
                }),
                phaseOptions,
              );

      expect(report.crashes.length).toBeGreaterThan(0);
      expect(report.crashes[0]?.error).toMatchObject({ message: 'Fuzz timeout after 20ms' });
    } finally {
      clearTimeout(timer);
      settle.resolve({ ok: true });
    }
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

  it('reports a tool output-schema violation as a crash', async () => {
    const definition = tool('fuzz_bad_output', {
      description: 'Returns output that violates its schema.',
      input: z.object({ value: z.any().describe('Value') }),
      output,
      handler: () => JSON.parse('{"ok":"invalid"}'),
    });
    const report = await fuzzTool(definition, { ...options, numRuns: 1, numAdversarial: 1 });
    expect(report.crashes).toHaveLength(2);
  });

  it('keeps a declared handler McpError out of the crash list', async () => {
    const definition = tool('fuzz_declared_failure', {
      description: 'Fails with an InternalError of its own.',
      input: z.object({ value: z.any().describe('Value') }),
      output,
      handler: () => {
        throw new McpError(JsonRpcErrorCode.InternalError, 'handled');
      },
    });
    const report = await fuzzTool(definition, { ...options, numRuns: 1, numAdversarial: 1 });
    expect(report.crashes).toEqual([]);
  });

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

/**
 * The input schema and run counts that route a tool's handler through one
 * `fuzzTool` phase. A required `value` of any type admits nearly every
 * generated and adversarial record but none of the raw top-level payloads; an
 * open empty object admits only those. Every run also ends with one aborted
 * replay, which parses no output and records no crash.
 */
const toolPhases = {
  valid: { numRuns: 2, numAdversarial: 0 },
  adversarial: { numRuns: 0, numAdversarial: 3 },
  raw: { numRuns: 0, numAdversarial: 0 },
} as const;
const phaseInput = (phase: keyof typeof toolPhases) =>
  phase === 'raw'
    ? z.object({}).passthrough()
    : z.object({ value: z.any().nonoptional().describe('Value') });

// Issue #667 — a handler's input-required signal is a completed call, never a crash.
describe('fuzz input-required rounds', () => {
  it.each(['valid', 'adversarial', 'raw'] as const)(
    'counts a tool handler that requests input as a completed call in the %s phase',
    async (phase) => {
      let calls = 0;
      const definition = tool('fuzz_ask', {
        description: 'Asks for input on every call.',
        input: phaseInput(phase),
        output,
        handler(_input, ctx) {
          calls++;
          return ctx.requestInput({ requestState: 'r1' });
        },
      });
      const report = await fuzzTool(definition, { ...options, ...toolPhases[phase] });
      expect(calls).toBeGreaterThan(1);
      expect(report.crashes).toEqual([]);
      expect(report.leaks).toEqual([]);
    },
  );

  it.each(['valid', 'adversarial', 'no-params'] as const)(
    'counts a resource handler that requests input as a completed call in the %s phase',
    async (phase) => {
      let calls = 0;
      const definition = resource('fuzz://ask', {
        description: 'Asks for input on every read.',
        ...(phase !== 'no-params' && { params: z.object({ value: z.any().describe('Value') }) }),
        handler(_params, ctx) {
          calls++;
          return ctx.requestInput({ requestState: 'r1' });
        },
      });
      const report = await fuzzResource(definition, {
        ...options,
        numRuns: phase === 'adversarial' ? 0 : 1,
        numAdversarial: phase === 'adversarial' ? 3 : 0,
      });
      expect(calls).toBe(phase === 'adversarial' ? 3 : 1);
      expect(report.crashes).toEqual([]);
      expect(report.leaks).toEqual([]);
    },
  );
});

// Issue #667 — `fuzzTool` parses a handler's return as production does, so a
// success carrying the reserved top-level `error` key is the definition's bug.
describe('fuzz reserved output keys', () => {
  it.each(['valid', 'adversarial', 'raw'] as const)(
    'records an open-root output carrying a top-level error key as a crash in the %s phase',
    async (phase) => {
      let calls = 0;
      const definition = tool('fuzz_error_key', {
        description: 'Returns a success carrying the reserved error key.',
        input: phaseInput(phase),
        output: output.passthrough(),
        handler() {
          calls++;
          return { ok: true, error: 'boom' };
        },
      });
      const report = await fuzzTool(definition, { ...options, ...toolPhases[phase] });
      expect(calls).toBeGreaterThan(1);
      expect(report.crashes).toHaveLength(calls - 1);
      for (const { error } of report.crashes) {
        expect(isOutputContractViolation(error)).toBe(true);
        expect(error).toMatchObject({
          message: expect.stringContaining('Reserved for the failure envelope'),
        });
      }
    },
  );
});

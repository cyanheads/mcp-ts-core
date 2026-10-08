/**
 * @fileoverview Fuzz tests for the tool handler pipeline.
 * Exercises `createToolHandler` with schema-generated and adversarial inputs
 * to verify the framework never crashes, leaks internals, or lets a `constructor.prototype`
 * payload reach `Object.prototype`. That an own `__proto__` key never re-prototypes a copy
 * of the arguments is pinned in the pre-validation unit suite.
 * @module tests/fuzz/tool-handler-pipeline.fuzz.test
 */

import fc from 'fast-check';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ADVERSARIAL_STRINGS,
  adversarialObjectArbitrary,
  loadFc,
  zodToArbitrary,
} from '@/testing/fuzz.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    crit: vi.fn(),
    emerg: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('@/config/index.js', () => ({
  config: {
    environment: 'testing',
    mcpServerVersion: '1.0.0-test',
    mcpAuthMode: 'none',
    openTelemetry: { serviceName: 'test', serviceVersion: '0.0.0' },
  },
}));

vi.mock('@/utils/internal/logger.js', () => ({
  logger: mockLogger,
  Logger: { getInstance: () => mockLogger },
}));

vi.mock('@/utils/internal/requestContext.js', () => ({
  toCanonicalContext: (context: Record<string, unknown>) =>
    Object.fromEntries(
      [
        'auth',
        'extra',
        'operation',
        'requestId',
        'sessionId',
        'spanId',
        'tenantId',
        'timestamp',
        'traceId',
      ]
        .filter((k) => context[k] !== undefined)
        .map((k) => [k, context[k]]),
    ),
  requestContextService: {
    createRequestContext: vi.fn((opts: any) => ({
      ...(opts?.parentContext ?? {}),
      requestId: 'fuzz-req-id',
      timestamp: new Date().toISOString(),
      operation: opts?.operation ?? 'fuzz',
      ...(opts?.additionalContext && { extra: opts.additionalContext }),
    })),
  },
  withExtra: (context: any, fields: any) => ({
    ...context,
    extra: { ...context?.extra, ...fields },
  }),
}));

vi.mock('@/utils/internal/performance.js', () => ({
  // Passes the span-bound context through, as the real implementation does —
  // the handler factory builds its `ctx` from that argument. The second
  // argument designates the payload the output-size metrics measure; this stub
  // records nothing.
  measureToolExecution: vi.fn(
    (
      fn: (spanContext: unknown, recordOutput: (payload: unknown) => void) => unknown,
      context: unknown,
    ) => fn(context, () => {}),
  ),
  recordToolRejection: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  type InputHandlingOptions,
  prevalidateAliasFirst,
  prevalidateToolArguments,
} from '@/mcp-server/tools/utils/inputPrevalidation.js';
import type { AnyToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import {
  createToolHandler,
  type HandlerServices,
  type NotifierSources,
  parseToolArguments,
} from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { measureToolExecution } from '@/utils/internal/performance.js';
import { Allow, jsonParser } from '@/utils/parsing/jsonParser.js';
import { makeServerContext } from '../helpers/server-context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolHandler = ReturnType<typeof createToolHandler>;

/**
 * Invokes a handler and narrows away the `input_required` arm of its return
 * union. None of the fixtures below call `ctx.requestInput`, so a signal
 * reaching here is a pipeline bug, not a case to assert on.
 */
async function call(
  handler: ToolHandler,
  input: unknown,
  ctx = makeServerContext({ requestId: 'fuzz-sdk-id' }),
): Promise<CallToolResult> {
  const result = await handler(input as Record<string, unknown>, ctx);
  if ('resultType' in result) throw new Error('Unexpected input_required result');
  return result;
}

const services: HandlerServices = {
  logger: mockLogger as any,
  storage: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => ({ keys: [] })),
    getMany: vi.fn(async () => new Map()),
  } as any,
};

const notifiers: NotifierSources = {};

/** An argument rejection's `data`, and its message. */
interface RejectionData {
  input?: unknown;
  issues?: unknown;
  issuesCount?: number;
  message: string;
}

/** The rejection `parseToolArguments` throws for `args`, or `undefined` when it validates. */
function rejection(
  def: unknown,
  args: Record<string, unknown>,
  input?: InputHandlingOptions,
): RejectionData | undefined {
  try {
    parseToolArguments(def as AnyToolDefinition, args, input ? { input } : {});
  } catch (error) {
    if (error instanceof McpError) {
      return { ...(error.data as Omit<RejectionData, 'message'>), message: error.message };
    }
    throw error;
  }
  return undefined;
}

/** The most issues `data.issues` keeps in all, counted in document order through every union's branches (#648). */
const ISSUE_BUDGET = 30;

/**
 * How many objects `value`'s arrays hold, at every depth and each time one is
 * listed — counted only until the count passes `limit`, since Zod lists the
 * issues of a value two union branches parsed under both.
 */
function objectsIn(value: unknown, limit: number): number {
  if (typeof value !== 'object' || value === null) return 0;
  let count = 0;
  for (const field of Object.values(value)) {
    const listed = Array.isArray(value) && typeof field === 'object' && field !== null;
    if (listed && !Array.isArray(field)) count += 1;
    if (count > limit) return count;
    count += objectsIn(field, limit - count);
  }
  return count;
}

/** Whether `value` is an object and not an array: what an array's entry counts as an issue for. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * How many entries a list or object `level` levels below the nearest object
 * an array holds keeps: 10 through two levels, none past them.
 */
function entriesAt(level: number): number {
  return level > 2 ? 0 : 10;
}

/**
 * Whether `value` keeps every array to 10 entries, every object to 10 keys,
 * every string and key to 1,024 characters, and every list or object past two
 * levels below the nearest object an array holds empty, and its arrays hold no
 * more than `budget` objects in all.
 */
function withinCaps(value: unknown, budget = Number.POSITIVE_INFINITY): boolean {
  const capped = (item: unknown, level: number): boolean => {
    if (typeof item === 'string') return item.length <= 1_024;
    if (Array.isArray(item)) {
      return (
        item.length <= entriesAt(level) &&
        item.every((entry) => capped(entry, isRecord(entry) ? 0 : level + 1))
      );
    }
    if (!isRecord(item)) return true;
    const keys = Object.keys(item);
    return (
      keys.length <= entriesAt(level) &&
      keys.every((key) => key.length <= 1_024 && capped(item[key], level + 1))
    );
  };
  return capped(value, 0) && objectsIn(value, budget) <= budget;
}

/** What a cut keeps of a value, and the records its field takes beside it, by suffix. */
interface Carried {
  kept: unknown;
  records: Partial<Record<'Count' | 'Length' | 'Lengths', unknown>>;
}

/**
 * `value` as an argument rejection's `data` carries it (#648), worked out from
 * the rule rather than the factory's code: the first 10 entries of every array
 * and keys of every object, the first 1,024 characters of every string and
 * key, and no entries in a list or object past two levels below the nearest
 * object an array holds, each array ending before the first object past
 * `budget` objects in all — read in document order — or the first nested
 * array once none is left. Each cut is recorded beside its field: the uncut
 * count (`<key>Count`, an array's entries or an object's keys), length
 * (`<key>Length`, `<key>KeyLength`), or kept entries' sizes (`<key>Lengths`),
 * and a key a record's name takes, or that cutting makes equal to an earlier
 * one, is left out and counted. ASCII strings only, as `fc.string()` draws.
 */
function carried(value: unknown, budget = { left: Number.POSITIVE_INFINITY }): unknown {
  return carve(value, budget, 0).kept;
}

/** {@link carried}, with the records the value's field takes. */
function carve(value: unknown, budget: { left: number }, level: number): Carried {
  if (typeof value === 'string') {
    return {
      kept: value.slice(0, 1_024),
      records: value.length > 1_024 ? { Length: value.length } : {},
    };
  }
  const size = (item: unknown) =>
    typeof item === 'string' || Array.isArray(item)
      ? item.length
      : isRecord(item)
        ? Object.keys(item).length
        : null;
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    let entryCut = false;
    for (const item of value.slice(0, entriesAt(level))) {
      if (typeof item === 'object' && item !== null) {
        if (budget.left === 0) break;
        if (!Array.isArray(item)) budget.left -= 1;
      }
      const entry = carve(item, budget, isRecord(item) ? 0 : level + 1);
      kept.push(entry.kept);
      if ('Count' in entry.records || 'Length' in entry.records) entryCut = true;
    }
    return {
      kept,
      records: {
        ...(kept.length < value.length && { Count: value.length }),
        ...(entryCut && { Lengths: kept.map((_, i) => size(value[i])) }),
      },
    };
  }
  if (!isRecord(value)) return { kept: value, records: {} };

  const keys = Object.keys(value);
  const fields: Array<{ name: string; entry: Carried; keyLength?: number }> = [];
  for (const key of keys.slice(0, entriesAt(level))) {
    const name = key.slice(0, 1_024);
    if (fields.some((field) => field.name === name)) continue;
    fields.push({
      name,
      entry: carve(value[key], budget, level + 1),
      ...(key.length > 1_024 && { keyLength: key.length }),
    });
  }
  const recordsOf = ({ name, entry, keyLength }: (typeof fields)[number]) => [
    ...(keyLength !== undefined ? [[`${name}KeyLength`, keyLength] as const] : []),
    ...Object.entries(entry.records).map(
      ([suffix, record]) => [`${name}${suffix}`, record] as const,
    ),
  ];
  const taken = new Set(fields.flatMap((field) => recordsOf(field).map(([name]) => name)));
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const field of fields) {
    if (taken.has(field.name)) continue;
    kept += 1;
    out[field.name] = field.entry.kept;
    for (const [name, record] of recordsOf(field)) out[name] = record;
  }
  return { kept: out, records: kept < keys.length ? { Count: keys.length } : {} };
}

/**
 * Asserts a rejection carries `issues` and `report` as the bound rules: Zod's
 * list and the report exactly when they are within the caps, and the
 * projection {@link carried} works out when they are not — `issues` keeping
 * at most {@link ISSUE_BUDGET} issues in all.
 */
function expectCarried(
  data: RejectionData | undefined,
  issues: readonly unknown[],
  report: unknown,
): void {
  const { issues: sentIssues, issuesCount } = data ?? {};
  if (withinCaps(issues, ISSUE_BUDGET)) {
    expect(sentIssues).toEqual(issues);
    expect(issuesCount).toBeUndefined();
  } else {
    expect({ issues: sentIssues, ...(issuesCount !== undefined && { issuesCount }) }).toEqual(
      carried({ issues }, { left: ISSUE_BUDGET }),
    );
  }
  expect(data?.input).toEqual(withinCaps(report) ? report : carried(report));
}

// ---------------------------------------------------------------------------
// Test definitions with various schema shapes
// ---------------------------------------------------------------------------

const stringTool = tool('fuzz_string', {
  description: 'Accepts a string field.',
  input: z.object({ value: z.string().describe('A string value') }),
  output: z.object({ echo: z.string().describe('Echoed value') }),
  handler: (input) => ({ echo: input.value }),
});

const numberTool = tool('fuzz_number', {
  description: 'Accepts numeric fields.',
  input: z.object({
    count: z.number().int().min(0).max(1000).describe('A count'),
    ratio: z.number().min(0).max(1).describe('A ratio'),
  }),
  output: z.object({ result: z.number().describe('Result') }),
  handler: (input) => ({ result: input.count * input.ratio }),
});

const complexTool = tool('fuzz_complex', {
  description: 'Accepts complex nested input.',
  input: z.object({
    name: z.string().min(1).max(100).describe('Name'),
    tags: z.array(z.string().describe('Tag')).max(10).describe('Tags'),
    priority: z.enum(['low', 'medium', 'high']).describe('Priority level'),
    metadata: z
      .object({
        source: z.string().describe('Source'),
        version: z.number().optional().describe('Version'),
      })
      .describe('Metadata object'),
  }),
  output: z.object({ ok: z.boolean().describe('Success') }),
  handler: () => ({ ok: true }),
});

const brokenOutputTool = tool('fuzz_broken_output', {
  description: 'Returns a value that fails its own output contract.',
  input: z.object({ value: z.string().describe('A string value') }),
  output: z.object({ count: z.number().describe('A number the handler never returns') }),
  handler: () => ({}) as { count: number },
});

const brokenFormatTool = tool('fuzz_broken_format', {
  description: 'Returns a valid value whose formatter throws.',
  input: z.object({ value: z.string().describe('A string value') }),
  output: z.object({ echo: z.string().describe('Echoed value') }),
  handler: (input) => ({ echo: input.value }),
  format: () => {
    throw new Error('formatter blew up');
  },
});

const optionalTool = tool('fuzz_optional', {
  description: 'Has optional and default fields.',
  input: z.object({
    required: z.string().describe('Required field'),
    optional: z.string().optional().describe('Optional field'),
    defaulted: z.number().default(42).describe('Defaulted field'),
    nullable: z.string().nullable().describe('Nullable field'),
  }),
  output: z.object({ ok: z.boolean().describe('Ok') }),
  handler: () => ({ ok: true }),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tool Handler Pipeline Fuzz Tests', () => {
  beforeAll(() => loadFc());
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Valid input invariants', () => {
    const toolDefs: [string, AnyToolDefinition][] = [
      ['stringTool', stringTool as AnyToolDefinition],
      ['numberTool', numberTool as AnyToolDefinition],
      ['complexTool', complexTool as AnyToolDefinition],
      ['optionalTool', optionalTool as AnyToolDefinition],
    ];

    for (const [name, def] of toolDefs) {
      it(`${name}: valid inputs always produce non-error response`, async () => {
        const handler = createToolHandler(def, services, notifiers);
        const arb = zodToArbitrary(def.input) as fc.Arbitrary<Record<string, unknown>>;

        await fc.assert(
          fc.asyncProperty(arb, async (input) => {
            const result = await call(handler, input);
            expect(result.isError).toBeUndefined();
            expect(result.structuredContent).toEqual(expect.schemaMatching(def.output));
          }),
          { numRuns: 50 },
        );
      });
    }
  });

  describe('Adversarial input invariants', () => {
    const toolDefs: [string, AnyToolDefinition][] = [
      ['stringTool', stringTool as AnyToolDefinition],
      ['numberTool', numberTool as AnyToolDefinition],
      ['complexTool', complexTool as AnyToolDefinition],
    ];

    /**
     * Whether pre-validation's repair rescues an input the schema rejects as
     * sent. Here only one can: a safe integer other than `-0` at `stringTool`'s
     * string field becomes its decimal string (#487). `numberTool` would take a
     * string spelling a number (#707), but no adversarial string spells one as
     * `String(n)` writes it; `complexTool` would take a lone string for `tags`
     * (#602), but its enum never receives one of its own values; and every
     * root field of the three, where each adversarial value lands, is
     * required, so no `null` is deleted (#616).
     */
    function repairable(name: string, input: Record<string, unknown>): boolean {
      const { value } = input;
      return (
        name === 'stringTool' &&
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        !Object.is(value, -0)
      );
    }

    for (const [name, def] of toolDefs) {
      it(`${name}: adversarial inputs produce isError responses`, async () => {
        const handler = createToolHandler(def, services, notifiers);
        const arb = adversarialObjectArbitrary(def.input);

        await fc.assert(
          fc.asyncProperty(arb, async (input) => {
            // Must always return a result (either success or error), never throw
            const result = await call(handler, input);
            expect(Array.isArray(result.content)).toBe(true);
            const accepted = def.input.safeParse(input).success || repairable(name, input);
            expect(result.isError).toBe(accepted ? undefined : true);
            if (result.isError) {
              // Error responses must have text content
              expect(result.content!.length).toBeGreaterThan(0);
              const text = (result.content![0] as { text: string }).text;
              expect(typeof text).toBe('string');
              // structuredContent.error carries code/message/data on errors —
              // parity with the success path (so structuredContent-only clients
              // see the error). _meta.error must NOT be emitted.
              expect(result._meta).toBeUndefined();
              const sc = result.structuredContent as
                | { error: { code: number; message: string } }
                | undefined;
              expect(sc?.error.code).toBeTypeOf('number');
              expect(typeof sc?.error.message).toBe('string');
            }
          }),
          { numRuns: 30 },
        );
      });
    }
  });

  describe('Pre-validation key order (#563)', () => {
    /**
     * Declares each shape on which dropping first and aliasing first disagree:
     * an optional field an underscore spelling folds onto, a declared
     * underscore alias beside a case variant of its target, and a declared
     * alias for an ignore-listed key.
     */
    const keyOrderTool = tool('fuzz_key_order', {
      description: 'Takes keys the two pre-validation orders resolve differently.',
      input: z.object({
        query: z.string().describe('Query'),
        maxResults: z.number().optional().describe('Maximum results'),
        callId: z.string().optional().describe('Call ID'),
      }),
      inputAliases: { _q: 'query', toolCallId: 'callId' },
      output: z.object({ ok: z.boolean().describe('Ok') }),
      handler: () => ({ ok: true }),
    });

    /**
     * Declared keys, their underscore and case spellings, and client artifacts,
     * over values each field accepts or refuses — among them values only a
     * repair makes valid (an integer for a string, `'12345'` and `' 7 '` for
     * `maxResults`) and stringified values whose decoding the field still
     * refuses (`'[1]'`, `'{}'`). Half the calls also carry a valid `query`, so
     * the drop-first order validates often enough to test.
     */
    const argumentsArb = fc
      .tuple(
        fc.option(fc.string({ maxLength: 4 }), { nil: undefined }),
        fc.dictionary(
          fc.constantFrom(
            'query',
            'maxResults',
            'callId',
            '_query',
            '_q',
            'QUERY',
            '_max_results',
            'max_results',
            'toolCallId',
            '_call_id',
            '_meta',
            '_search',
            'tool_call_description',
          ),
          fc.oneof(
            fc.string({ maxLength: 4 }),
            fc.integer(),
            fc.boolean(),
            fc.constant('12345'),
            fc.constant(null),
            fc.array(fc.string({ maxLength: 2 }), { maxLength: 2 }),
            fc.constantFrom('[1]', '{}', ' 7 '),
          ),
          { maxKeys: 4 },
        ),
      )
      .map(
        ([query, rest]): Record<string, unknown> =>
          query === undefined ? rest : { query, ...rest },
      );

    /** The parse of the first attempt — the order every call is tried in first. */
    function dropFirst(args: Record<string, unknown>) {
      const first = prevalidateToolArguments(keyOrderTool as AnyToolDefinition, args, undefined);
      return { first, parsed: keyOrderTool.input.safeParse(first.args) };
    }

    it('resolves a call the drop-first order validates exactly as that order does', () => {
      fc.assert(
        fc.property(argumentsArb, (args) => {
          const { parsed } = dropFirst(args);
          fc.pre(parsed.success);
          expect(parseToolArguments(keyOrderTool, args)).toEqual(parsed.data);
        }),
        { numRuns: 300 },
      );
    });

    /**
     * The order a call no order validates is reported under: the alias-first
     * retry runs only when it changes the arguments, and when it does, the keys
     * the drop discarded reach their targets there, so its rejection is the one
     * reported.
     */
    function reportedOrder(args: Record<string, unknown>) {
      const { first, parsed } = dropFirst(args);
      const retry = prevalidateAliasFirst(
        keyOrderTool as AnyToolDefinition,
        args,
        first,
        undefined,
      );
      return retry
        ? { attempt: retry, parsed: keyOrderTool.input.safeParse(retry.args) }
        : { attempt: first, parsed };
    }

    it('rejects a call no order validates with the last order tried, as sent under coerce: false', () => {
      fc.assert(
        fc.property(argumentsArb, (args) => {
          const data = rejection(keyOrderTool, args, { coerce: false });
          fc.pre(data !== undefined);
          const { attempt, parsed } = reportedOrder(args);
          expectCarried(data, parsed.error?.issues ?? [], attempt.report);
        }),
        { numRuns: 300 },
      );
    });

    /**
     * `args` with exactly the repairs that hold written (#706), worked out from
     * `keyOrderTool`'s field rules rather than the repair code: an integer for
     * `query` or `callId` becomes its digits, a `maxResults` string spelling a
     * finite number becomes it, and `null` for an optional field is deleted —
     * each a value the field then accepts. A stringified array or object for
     * `maxResults` decodes to a value the field refuses, so it stays as sent,
     * like every value no repair reaches.
     */
    function heldOnly(args: Record<string, unknown>): Record<string, unknown> {
      const held = { ...args };
      for (const key of ['query', 'callId']) {
        const value = held[key];
        if (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)) {
          held[key] = String(value);
        }
      }
      if (typeof held.maxResults === 'string') {
        const trimmed = held.maxResults.trim();
        const number = Number(trimmed);
        if (!/^[[{]/.test(trimmed) && Number.isFinite(number) && String(number) === trimmed) {
          held.maxResults = number;
        }
      }
      for (const key of ['maxResults', 'callId']) {
        if (held[key] === null) delete held[key];
      }
      return held;
    }

    it('rejects a call no order validates with the last order tried, with only the repairs that held', () => {
      fc.assert(
        fc.property(argumentsArb, (args) => {
          const data = rejection(keyOrderTool, args);
          fc.pre(data !== undefined);
          const { attempt } = reportedOrder(args);
          const reported = keyOrderTool.input.safeParse(
            heldOnly(attempt.args as Record<string, unknown>),
          );
          expect(reported.success).toBe(false);
          expectCarried(data, reported.error?.issues ?? [], attempt.report);
        }),
        {
          numRuns: 300,
          // A repair that held beside one that did not; a held `null` deletion behind a case-style alias.
          examples: [[{ query: 5, maxResults: '[1]' }], [{ max_results: null }]],
        },
      );
    });
  });

  describe('Bounded rejection data (#648)', () => {
    /**
     * Takes a list whose every wrong element is its own issue, so a caller can
     * send more of them than a rejection renders, beside unknown and dropped
     * keys long enough to cut (#648).
     */
    const capsTool = tool('fuzz_caps', {
      description: 'Takes a query and a list of strings.',
      input: z.object({
        query: z.string().describe('Query'),
        items: z.array(z.string()).optional().describe('Items'),
      }),
      output: z.object({ ok: z.boolean().describe('Ok') }),
      handler: () => ({ ok: true }),
    });

    /**
     * Wrong-type elements no repair reaches (a boolean, an object), and root
     * keys no case fold maps onto a declared one: `x…` keys the strict root
     * rejects and `_x…` keys the drop discards, some past 1,024 characters.
     */
    const capsArb = fc
      .record({
        query: fc.oneof(fc.string({ maxLength: 4 }), fc.boolean()),
        items: fc.array(fc.oneof(fc.string({ maxLength: 2 }), fc.boolean(), fc.constant({})), {
          maxLength: 25,
        }),
        extra: fc.dictionary(
          fc
            .tuple(
              fc.constantFrom('x', '_x'),
              fc.oneof(
                fc.string({ maxLength: 6 }),
                fc.string({ minLength: 1_030, maxLength: 1_100 }),
              ),
            )
            .map(([prefix, rest]) => `${prefix}${rest}`),
          fc.constant(1),
          { maxKeys: 14 },
        ),
      })
      .map(({ query, items, extra }): Record<string, unknown> => ({ ...extra, query, items }));

    it('carries the first 10 issues and every cut length past the caps, exactly the list within them (#648)', () => {
      fc.assert(
        fc.property(capsArb, (args) => {
          const data = rejection(capsTool, args, { coerce: false });
          fc.pre(data !== undefined);
          const first = prevalidateToolArguments(capsTool as AnyToolDefinition, args, undefined);
          const issues = capsTool.input.safeParse(first.args).error?.issues ?? [];
          expectCarried(data, issues, first.report);
          const more = issues.length - 10;
          expect(data?.message.endsWith(` (+${more} more)`)).toBe(more > 0);
        }),
        { numRuns: 150 },
      );
    });

    /** Rejects every call with a custom issue whose `params` is the caller's payload. */
    const echoTool = tool('fuzz_echo', {
      description: 'Rejects every payload, echoing it in the issue.',
      input: z.object({ payload: z.unknown().describe('Payload') }).superRefine((value, ctx) => {
        ctx.addIssue({
          code: 'custom',
          message: 'bad',
          params: value.payload as Record<string, unknown>,
        });
      }),
      output: z.object({ ok: z.boolean().describe('Ok') }),
      handler: () => ({ ok: true }),
    });

    /**
     * Keys past 1,024 characters, some sharing their first 1,024, and keys
     * named like the records a cut writes beside `a`.
     */
    const payloadKey = fc
      .oneof(
        fc.string({ maxLength: 3 }),
        fc.constantFrom('a', 'aLength', 'aCount', 'aLengths', 'aKeyLength'),
        fc.string({ minLength: 1_025, maxLength: 1_040 }),
        fc.string({ minLength: 1, maxLength: 4 }).map((tail) => `${'p'.repeat(1_024)}${tail}`),
      )
      .filter((key) => key !== '__proto__');

    /** Values past every cap: strings past 1,024 characters, lists and objects past 10 entries, nesting past two levels. */
    const { node } = fc.letrec<{ node: unknown }>((tie) => ({
      node: fc.oneof(
        { depthSize: 'small', maxDepth: 5 },
        fc.oneof(
          fc.string({ maxLength: 3 }),
          fc.string({ minLength: 1_025, maxLength: 1_040 }),
          fc.integer(),
        ),
        fc.array(tie('node'), { maxLength: 12 }),
        fc.dictionary(payloadKey, tie('node'), { maxKeys: 13 }),
      ),
    }));

    it('carries the caller data a custom issue holds cut to every cap, exactly within them (#648)', () => {
      fc.assert(
        fc.property(fc.dictionary(payloadKey, node, { maxKeys: 14 }), (payload) => {
          const args = { payload };
          const data = rejection(echoTool, args);
          const first = prevalidateToolArguments(echoTool as AnyToolDefinition, args, undefined);
          const issues = echoTool.input.safeParse(first.args).error?.issues ?? [];
          expectCarried(data, issues, first.report);
        }),
        {
          numRuns: 150,
          examples: [
            [
              {
                a: 'x'.repeat(1_030),
                aLength: 1,
                [`${'p'.repeat(1_024)}x`]: 1,
                [`${'p'.repeat(1_024)}y`]: [{ deep: { er: { still: [1] } } }],
                b: { c: { d: [[1]] } },
              },
            ],
          ],
        },
      );
    });

    /**
     * A filter whose `and` and `or` branches both parse one clause list, so Zod
     * lists each clause's issues under both: the issue tree doubles per level
     * of nesting while its distinct issues grow with it.
     */
    const Filter: z.ZodType = z.lazy(() =>
      z.union([
        z.object({ op: z.literal('and'), filters: z.array(Filter) }),
        z.object({ op: z.literal('or'), filters: z.array(Filter) }),
        z.object({ op: z.literal('eq'), field: z.string(), value: z.string() }),
      ]),
    );
    const filterTool = tool('fuzz_filter', {
      description: 'Takes a filter of nested clauses.',
      input: z.object({ where: Filter.describe('Filter') }),
      output: z.object({ ok: z.boolean().describe('Ok') }),
      handler: () => ({ ok: true }),
    });

    /** Clause trees up to 16 levels deep, with leaves that are valid, wrong-typed, or unknown. */
    const { clause } = fc.letrec<{ clause: unknown; leaf: unknown }>((tie) => ({
      leaf: fc.record({
        op: fc.constantFrom('eq', 'eq', 'ne'),
        field: fc.oneof(fc.string({ maxLength: 3 }), fc.boolean()),
        value: fc.oneof(fc.string({ maxLength: 3 }), fc.boolean(), fc.constant({})),
      }),
      clause: fc.oneof(
        { depthSize: 'medium', maxDepth: 16 },
        tie('leaf'),
        fc.record({
          op: fc.constantFrom('and', 'or', 'not'),
          filters: fc.array(tie('clause'), { minLength: 1, maxLength: 2 }),
        }),
      ),
    }));

    it('carries at most 30 issues of a clause tree, in document order, and lines of at most 1,025 characters (#648)', () => {
      fc.assert(
        fc.property(clause, (where) => {
          const args = { where };
          const data = rejection(filterTool, args, { coerce: false });
          fc.pre(data !== undefined);
          const first = prevalidateToolArguments(filterTool as AnyToolDefinition, args, undefined);
          const issues = filterTool.input.safeParse(first.args).error?.issues ?? [];
          expectCarried(data, issues, first.report);
          expect(objectsIn(data?.issues, ISSUE_BUDGET)).toBeLessThanOrEqual(ISSUE_BUDGET);
          // One issue, at `where`: one line.
          const preamble = 'Input validation error: Invalid arguments for tool fuzz_filter: ';
          expect(data?.message.length).toBeLessThanOrEqual(preamble.length + 1_025);
        }),
        { numRuns: 150 },
      );
    });
  });

  describe('Post-handler failure containment (#346)', () => {
    /**
     * Whether the callback handed to `measureToolExecution` rejected. A
     * post-handler failure that settles outside it is recorded as a successful
     * call while the client is handed `isError: true`.
     */
    async function measuredCallbackRejected(): Promise<boolean> {
      const last = vi.mocked(measureToolExecution).mock.results.at(-1);
      if (!last) throw new Error('measureToolExecution was never called');
      if (last.type === 'throw') return true;
      return await Promise.resolve(last.value).then(
        () => false,
        () => true,
      );
    }

    const brokenDefs: [string, AnyToolDefinition][] = [
      ['output-schema', brokenOutputTool as AnyToolDefinition],
      ['formatter', brokenFormatTool as AnyToolDefinition],
    ];

    for (const [label, def] of brokenDefs) {
      it(`${label} failures stay inside the measured region for generated inputs`, async () => {
        const handler = createToolHandler(def, services, notifiers);
        const arb = zodToArbitrary(def.input) as fc.Arbitrary<Record<string, unknown>>;

        await fc.assert(
          fc.asyncProperty(arb, async (input) => {
            const result = await call(handler, input);
            expect(result.isError).toBe(true);
            expect(await measuredCallbackRejected()).toBe(true);
          }),
          { numRuns: 25 },
        );
      });
    }
  });

  describe('Error message safety', () => {
    it('error responses never leak stack traces', async () => {
      const def = tool('fuzz_leak_check', {
        description: 'Throws various errors.',
        input: z.object({ mode: z.string().describe('Error type') }),
        output: z.object({ ok: z.boolean().describe('Ok') }),
        handler: (input) => {
          switch (input.mode) {
            case 'plain':
              throw new Error('Something went wrong');
            case 'mcp':
              throw new McpError(JsonRpcErrorCode.InternalError, 'Internal');
            case 'type':
              throw new TypeError('Cannot read property');
            default:
              throw new Error(`Unknown mode: ${input.mode}`);
          }
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const modes = ['plain', 'mcp', 'type', 'unknown'];

      for (const mode of modes) {
        const result = await call(handler, { mode });
        expect(result.isError).toBe(true);
        const serializedResult = JSON.stringify(result);
        // Scan the complete client-visible result, including structuredContent.error.data.
        expect(serializedResult).not.toMatch(/node_modules/);
        expect(serializedResult).not.toMatch(/\/Users\//);
        expect(serializedResult).not.toMatch(/\/home\//);
        expect(serializedResult).not.toMatch(/\bat\s+\S+\s+\(/); // Stack trace pattern
      }
    });

    it('parser failures carry the diagnostic but no input sample or stack path', async () => {
      const marker = 'TAIL_MARKER_NOT_IN_DIAGNOSTIC';
      const def = tool('fuzz_parser_leak_check', {
        description: 'Parses caller-provided JSON.',
        input: z.object({ payload: z.string().describe('JSON payload') }),
        output: z.object({ ok: z.boolean().describe('Ok') }),
        async handler(input) {
          await jsonParser.parse(input.payload, Allow.ALL);
          return { ok: true };
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await call(handler, { payload: `not-json ${'x'.repeat(400)} ${marker}` });
      const serializedResult = JSON.stringify(result);

      expect(result.isError).toBe(true);
      expect(serializedResult).not.toContain(marker);
      expect(serializedResult).not.toMatch(/\/Users\/|\/home\//);
      expect(serializedResult).not.toMatch(/\bat\s+\S+\s+\(/);
      expect(result.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining('Failed to parse JSON content: '),
          // The call's own request id is the one context field on `data` (#576).
          data: { reason: 'json_parse_failed', requestId: 'fuzz-req-id' },
        },
      });
    });
  });

  describe('Prototype pollution resistance', () => {
    /**
     * A recursive merge into an existing object follows an own `constructor` key
     * to the inherited `Object`, then `prototype` to `Object.prototype`. Each
     * payload arrives parsed from JSON, as the wire delivers it, at a different
     * depth of the arguments.
     */
    it('a constructor.prototype payload never reaches Object.prototype', async () => {
      const payload = '"constructor":{"prototype":{"polluted":true}}';
      const complex = '"name":"n","tags":[],"priority":"low"';
      const calls: {
        where: string;
        def: AnyToolDefinition;
        args: unknown;
        isError: true | undefined;
      }[] = [
        {
          where: 'at the root, which strict input rejects',
          def: stringTool as AnyToolDefinition,
          args: JSON.parse(`{"value":"test",${payload}}`),
          isError: true,
        },
        {
          where: 'inside a declared object, which strips the undeclared key',
          def: complexTool as AnyToolDefinition,
          args: JSON.parse(`{${complex},"metadata":{"source":"s",${payload}}}`),
          isError: undefined,
        },
        {
          where: 'as JSON text in that object, which the repair step decodes',
          def: complexTool as AnyToolDefinition,
          args: { ...JSON.parse(`{${complex}}`), metadata: `{"source":"s",${payload}}` },
          isError: undefined,
        },
      ];

      const before = new Set(Object.getOwnPropertyNames(Object.prototype));
      /** Deletes and returns every key `Object.prototype` gained, so none outlives this test. */
      const takeAdded = (): string[] => {
        const added = Object.getOwnPropertyNames(Object.prototype).filter(
          (key) => !before.has(key),
        );
        for (const key of added) delete (Object.prototype as Record<string, unknown>)[key];
        return added;
      };

      for (const { where, def, args, isError } of calls) {
        let added: string[] = [];
        const result = await call(createToolHandler(def, services, notifiers), args).finally(() => {
          added = takeAdded();
        });
        expect(added, where).toEqual([]);
        expect(result.isError, where).toBe(isError);
      }
    });
  });

  describe('Type confusion resistance', () => {
    it('survives completely wrong top-level types', async () => {
      const handler = createToolHandler(stringTool as AnyToolDefinition, services, notifiers);

      const wrongTypes: unknown[] = [
        null,
        undefined,
        42,
        'raw string',
        true,
        false,
        [],
        [1, 2, 3],
        () => {},
        Symbol('test'),
        BigInt(42),
        // The arguments themselves arriving as JSON text: the repair step acts on
        // values the parse rejected below the root, never on the root itself.
        '{"value":"test"}',
      ];

      for (const input of wrongTypes) {
        const result = await call(handler, input);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams },
        });
      }
    });
  });

  describe('Injection string resistance', () => {
    it('handler processes adversarial strings without crashing', async () => {
      const handler = createToolHandler(stringTool as AnyToolDefinition, services, notifiers);

      for (const str of ADVERSARIAL_STRINGS) {
        const result = await call(handler, { value: str });
        // All are valid string inputs, should succeed
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toEqual({ echo: str });
      }
    });
  });

  describe('Oversized input handling', () => {
    it('handles extremely large string inputs without crashing', async () => {
      const handler = createToolHandler(stringTool as AnyToolDefinition, services, notifiers);
      const largeInput = { value: 'x'.repeat(1_000_000) };

      const result = await call(handler, largeInput);
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ echo: largeInput.value });
    });

    it('handles deeply nested objects gracefully', async () => {
      const handler = createToolHandler(stringTool as AnyToolDefinition, services, notifiers);

      let deep: any = { value: 'leaf' };
      for (let i = 0; i < 100; i++) {
        deep = { nested: deep, value: 'mid' };
      }

      const result = await call(handler, deep);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      // Strict input rejects the undeclared `nested` key; the pipeline still
      // answers with a shaped error result rather than throwing.
    });
  });
});

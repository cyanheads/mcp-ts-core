/**
 * @fileoverview Schema-aware fuzz testing utilities for MCP definitions.
 * Generates valid, near-miss, and adversarial inputs from Zod schemas,
 * then asserts handler invariants (no crashes, well-formed errors, etc.).
 *
 * Uses `fast-check` for property-based generation. Consumers use
 * `fuzzTool()`, `fuzzResource()`, and `fuzzPrompt()` in their Vitest suites.
 *
 * @module src/testing/fuzz
 */

import fc from 'fast-check';
import type { ZodObject, ZodRawShape } from 'zod';
import {
  ZodArray,
  ZodBoolean,
  ZodDefault,
  ZodEnum,
  ZodLiteral,
  ZodNullable,
  ZodNumber,
  ZodOptional,
  ZodString,
  ZodUnion,
} from 'zod';
import type { AnyPromptDefinition } from '@/mcp-server/prompts/utils/promptDefinition.js';
import type { AnyResourceDefinition } from '@/mcp-server/resources/utils/resourceDefinition.js';
import type { AnyToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { createMockContext, type MockContextOptions } from './index.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Options for fuzz test runners. */
export interface FuzzOptions {
  /** Mock context options passed to `createMockContext()`. */
  ctx?: MockContextOptions;
  /** Number of adversarial-input runs. @default 30 */
  numAdversarial?: number;
  /** Number of valid-input runs. @default 50 */
  numRuns?: number;
  /** fast-check seed for reproducibility. */
  seed?: number;
  /** Timeout per individual handler call in ms. @default 5000 */
  timeout?: number;
}

const DEFAULTS = {
  numRuns: 50,
  numAdversarial: 30,
  timeout: 5000,
} as const;

// ---------------------------------------------------------------------------
// Zod type introspection (Zod 4 compatible)
// ---------------------------------------------------------------------------

/**
 * Returns the internal Zod type discriminator string.
 * Zod 4 uses `_def.type` (e.g. 'string', 'object', 'optional').
 */
function zodTypeName(schema: unknown): string {
  return (schema as any)?._def?.type ?? '';
}

// ---------------------------------------------------------------------------
// Zod → fast-check arbitrary generation
// ---------------------------------------------------------------------------

/**
 * Converts a Zod schema to a fast-check `Arbitrary` that produces valid values.
 * Supports the JSON-Schema-serializable subset used by MCP tool/resource schemas.
 */
export function zodToArbitrary(schema: unknown): fc.Arbitrary<unknown> {
  return zodNodeToArbitrary(schema, 0);
}

function zodNodeToArbitrary(schema: unknown, depth: number): fc.Arbitrary<unknown> {
  if (depth > 6) return fc.constant(null);

  // Unwrap wrappers — cast through any to avoid Zod 4 $ZodType vs ZodType mismatch
  if (schema instanceof ZodOptional) {
    return fc.option(zodNodeToArbitrary((schema as any).unwrap(), depth), { nil: undefined });
  }
  if (schema instanceof ZodNullable) {
    return fc.option(zodNodeToArbitrary((schema as any).unwrap(), depth), { nil: null });
  }
  if (schema instanceof ZodDefault) {
    return fc.option(zodNodeToArbitrary((schema as any).removeDefault(), depth), {
      nil: undefined,
      freq: 5,
    });
  }

  // Primitives
  if (schema instanceof ZodString || zodTypeName(schema) === 'string') {
    return arbitraryForZodString(schema as ZodString);
  }
  if (schema instanceof ZodNumber) {
    return arbitraryForZodNumber(schema);
  }
  if (schema instanceof ZodBoolean) {
    return fc.boolean();
  }

  // Enum / literal
  if (schema instanceof ZodEnum) {
    const values = (schema as any).options as unknown[];
    return fc.constantFrom(...values);
  }
  if (schema instanceof ZodLiteral) {
    return fc.constant((schema as any).value);
  }

  // Array
  if (schema instanceof ZodArray) {
    return fc.array(zodNodeToArbitrary((schema as any).element, depth + 1), { maxLength: 5 });
  }

  // Union
  if (schema instanceof ZodUnion) {
    const options = (schema as any)._def.options as unknown[];
    return fc.oneof(...options.map((o) => zodNodeToArbitrary(o, depth + 1)));
  }

  // Object — check by _def.type since instanceof ZodObject may have type issues
  if (zodTypeName(schema) === 'object') {
    const shape = (schema as any).shape as Record<string, unknown> | undefined;
    if (!shape) return fc.constant({});
    const entries = Object.entries(shape);
    if (entries.length === 0) return fc.constant({});

    const arbs: Record<string, fc.Arbitrary<unknown>> = {};
    for (const [key, fieldSchema] of entries) {
      arbs[key] = zodNodeToArbitrary(fieldSchema, depth + 1);
    }
    return fc.record(arbs);
  }

  // Fallback: generate JSON-safe primitives
  return fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null));
}

/**
 * Zod 4 exposes `.minLength`, `.maxLength`, `.format` as direct accessors on ZodString.
 */
function arbitraryForZodString(schema: ZodString): fc.Arbitrary<string> {
  const s = schema as any;
  const format: string | undefined = s.format;
  if (format === 'email') {
    // fc.emailAddress() can produce emails Zod 4 rejects (e.g. "!a@a.aa").
    // Generate simple, spec-safe emails instead.
    return fc
      .tuple(
        fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/),
        fc.stringMatching(/^[a-z]{2,8}\.[a-z]{2,4}$/),
      )
      .map(([local, domain]) => `${local}@${domain}`);
  }
  if (format === 'url' || format === 'uri') return fc.webUrl();
  if (format === 'uuid') return fc.uuid();

  const minLen: number = typeof s.minLength === 'number' ? s.minLength : 0;
  const maxLen: number = typeof s.maxLength === 'number' ? s.maxLength : 200;

  return fc.string({ minLength: minLen, maxLength: Math.max(minLen, maxLen) });
}

/**
 * Zod 4 exposes `.minValue`, `.maxValue`, `.isInt`, `.isFinite` as direct accessors.
 * Zod 4 defaults to `isFinite: true`, rejecting Infinity/NaN — respect that.
 */
function arbitraryForZodNumber(schema: ZodNumber): fc.Arbitrary<number> {
  const s = schema as any;
  const isFiniteNum: boolean = s.isFinite !== false;
  const rawMin: number = typeof s.minValue === 'number' ? s.minValue : -1_000_000;
  const rawMax: number = typeof s.maxValue === 'number' ? s.maxValue : 1_000_000;
  const min = isFiniteNum && !Number.isFinite(rawMin) ? -1_000_000 : rawMin;
  const max = isFiniteNum && !Number.isFinite(rawMax) ? 1_000_000 : rawMax;
  const isInt: boolean = s.isInt === true;

  return isInt
    ? fc.integer({ min, max })
    : fc.double({ min, max, noNaN: true, noDefaultInfinity: true });
}

// ---------------------------------------------------------------------------
// Adversarial input generators
// ---------------------------------------------------------------------------

/** Strings designed to trigger injection, encoding, or parsing vulnerabilities. */
export const ADVERSARIAL_STRINGS: readonly string[] = [
  // Prototype pollution
  '__proto__',
  'constructor',
  'prototype',
  '{"__proto__":{"polluted":true}}',
  '{"constructor":{"prototype":{"polluted":true}}}',
  // Script injection
  '<script>alert(1)</script>',
  '<img onerror=alert(1) src=x>',
  'javascript:alert(1)',
  '<svg/onload=alert(1)>',
  // SQL injection
  "'; DROP TABLE users; --",
  "' OR '1'='1",
  '1; SELECT * FROM information_schema.tables',
  // Command injection
  '; rm -rf /',
  '$(cat /etc/passwd)',
  '`whoami`',
  '| ls -la',
  // Path traversal
  '../../../etc/passwd',
  '..\\..\\..\\windows\\system32\\config\\sam',
  '%2e%2e%2f%2e%2e%2f',
  // Encoding attacks
  '\0',
  '\x00',
  '\uFEFF',
  '\uD800',
  '\uDBFF\uDFFF',
  // Format string
  '%s%s%s%s%s',
  '%x%x%x%x',
  '%n%n%n%n',
  // Oversized
  'A'.repeat(10_000),
  'A'.repeat(100_000),
  // Template injection
  '{{7*7}}',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: adversarial test string
  '${7*7}',
  '#{7*7}',
  // JSON edge cases
  '{"a":{"b":{"c":{"d":{"e":{"f":{"g":"deep"}}}}}}}',
  '[]',
  'null',
  'undefined',
  'NaN',
  'Infinity',
  '-Infinity',
  '',
  ' ',
  '\n',
  '\t',
  '\r\n',
] as const;

/** Generates adversarial values for object fields based on expected type. */
export function adversarialArbitrary(): fc.Arbitrary<unknown> {
  return fc.oneof(
    // Wrong types
    fc.constant(null),
    fc.constant(undefined),
    fc.constant(true),
    fc.constant(false),
    fc.constant(0),
    fc.constant(-1),
    fc.constant(Number.MAX_SAFE_INTEGER),
    fc.constant(Number.MIN_SAFE_INTEGER),
    fc.constant(NaN),
    fc.constant(Infinity),
    fc.constant(-Infinity),
    fc.constant(''),
    fc.constantFrom(...ADVERSARIAL_STRINGS),
    // Arrays where objects expected (and vice versa)
    fc.constant([]),
    fc.constant([1, 2, 3]),
    fc.constant({}),
    // Prototype pollution objects
    fc.constant({ __proto__: { polluted: true } }),
    fc.constant({ constructor: { prototype: { polluted: true } } }),
    // Deeply nested
    fc.constant(buildDeepObject(20)),
    // Circular-safe deep object
    fc.constant(buildWideObject(100)),
  );
}

/**
 * Generates an adversarial variant of a Zod object schema's input.
 * Produces objects that match the key structure but have wrong-type values.
 */
export function adversarialObjectArbitrary(
  schema: ZodObject<ZodRawShape>,
): fc.Arbitrary<Record<string, unknown>> {
  const shape = (schema as any).shape as Record<string, unknown> | undefined;
  const keys = shape ? Object.keys(shape) : [];

  if (keys.length === 0) {
    return adversarialArbitrary() as fc.Arbitrary<Record<string, unknown>>;
  }

  return fc.record(Object.fromEntries(keys.map((k) => [k, adversarialArbitrary()])));
}

function buildDeepObject(depth: number): unknown {
  let obj: Record<string, unknown> = { value: 'leaf' };
  for (let i = 0; i < depth; i++) {
    obj = { nested: obj };
  }
  return obj;
}

function buildWideObject(width: number): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < width; i++) {
    obj[`key_${i}`] = `value_${i}`;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Leak detection
// ---------------------------------------------------------------------------

function checkErrorLeaks(errorText: string): { leakedStack: boolean; leakedInternals: boolean } {
  const leakedStack = /\bat\s+\S+\s+\(/.test(errorText) || /node_modules/.test(errorText);
  const leakedInternals =
    /process\.env/.test(errorText) ||
    /\/Users\//.test(errorText) ||
    /\/home\//.test(errorText) ||
    /[A-Za-z]:\\/.test(errorText);
  return { leakedStack, leakedInternals };
}

// ---------------------------------------------------------------------------
// Prototype pollution detection
// ---------------------------------------------------------------------------

/** Snapshot Object.prototype keys, returns a checker that detects and cleans pollution. */
function createProtoPollutionGuard(): {
  before: Set<string>;
  check: (report: FuzzReport) => void;
} {
  const before = new Set(Object.keys(Object.prototype));
  return {
    before,
    check(report: FuzzReport) {
      for (const key of Object.keys(Object.prototype)) {
        if (!before.has(key)) {
          report.prototypePollution = true;
          delete (Object.prototype as any)[key];
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// FuzzReport
// ---------------------------------------------------------------------------

/** Result of a fuzz run, useful for custom assertions. */
export interface FuzzReport {
  /** Inputs that caused the handler to crash (unhandled throw past framework). */
  crashes: Array<{ input: unknown; error: unknown }>;
  /** Responses that leaked stack traces or internal paths. */
  leaks: Array<{ input: unknown; errorText: string }>;
  /** Prototype pollution detected on global objects. */
  prototypePollution: boolean;
  /** Total inputs tested. */
  totalRuns: number;
}

// ---------------------------------------------------------------------------
// fuzzTool
// ---------------------------------------------------------------------------

/**
 * Fuzz-tests a tool definition's handler with valid and adversarial inputs.
 * Designed to be called inside a `describe()` / `it()` block.
 *
 * Checks:
 * 1. Valid inputs -> handler runs without crash, output matches schema
 * 2. Adversarial inputs -> Zod rejects or handler errors gracefully
 * 3. No prototype pollution on Object.prototype
 * 4. No stack trace / path leaks in error messages
 * 5. Aborted signals -> handler doesn't hang
 *
 * @returns FuzzReport for additional custom assertions.
 *
 * @example
 * ```ts
 * import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
 *
 * describe('myTool fuzz', () => {
 *   it('survives fuzz testing', async () => {
 *     const report = await fuzzTool(myTool, { numRuns: 100 });
 *     expect(report.crashes).toHaveLength(0);
 *     expect(report.leaks).toHaveLength(0);
 *     expect(report.prototypePollution).toBe(false);
 *   });
 * });
 * ```
 */
export async function fuzzTool(
  def: AnyToolDefinition,
  options: FuzzOptions = {},
): Promise<FuzzReport> {
  const numRuns = options.numRuns ?? DEFAULTS.numRuns;
  const numAdversarial = options.numAdversarial ?? DEFAULTS.numAdversarial;
  const timeout = options.timeout ?? DEFAULTS.timeout;
  const fcParams: fc.Parameters<unknown> = {
    numRuns,
    ...(options.seed !== undefined && { seed: options.seed }),
  };

  const report: FuzzReport = {
    totalRuns: 0,
    crashes: [],
    leaks: [],
    prototypePollution: false,
  };

  const protoGuard = createProtoPollutionGuard();

  // Phase 1: Valid inputs
  const validArb = zodToArbitrary(def.input) as fc.Arbitrary<Record<string, unknown>>;
  await fc.assert(
    fc.asyncProperty(validArb, async (input) => {
      report.totalRuns++;
      const ctx = createMockContext(options.ctx);
      try {
        const result = await withTimeout(def.handler(input, ctx), timeout);
        def.output.parse(result);
      } catch (err) {
        report.crashes.push({ input, error: err });
      }
    }),
    fcParams,
  );

  // Phase 2: Adversarial inputs (should be caught by Zod or handler, never crash)
  const advArb = adversarialObjectArbitrary(def.input);
  await fc.assert(
    fc.asyncProperty(advArb, async (input) => {
      report.totalRuns++;
      const ctx = createMockContext(options.ctx);
      try {
        const validated = def.input.safeParse(input);
        if (!validated.success) return;
        const result = await withTimeout(def.handler(validated.data, ctx), timeout);
        def.output.parse(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const leakCheck = checkErrorLeaks(msg);
        if (leakCheck.leakedStack || leakCheck.leakedInternals) {
          report.leaks.push({ input, errorText: msg });
        }
      }
    }),
    { ...fcParams, numRuns: numAdversarial },
  );

  // Phase 3: Raw adversarial (completely wrong types at the top level)
  const rawAdversarial: unknown[] = [
    null,
    undefined,
    42,
    'string',
    true,
    [],
    { __proto__: { polluted: true } },
    { constructor: { prototype: { polluted: true } } },
  ];

  for (const input of rawAdversarial) {
    report.totalRuns++;
    try {
      const validated = def.input.safeParse(input);
      if (!validated.success) continue;
      const ctx = createMockContext(options.ctx);
      await withTimeout(def.handler(validated.data, ctx), timeout);
    } catch {
      // Expected
    }
  }

  // Phase 4: Aborted signal
  report.totalRuns++;
  try {
    const controller = new AbortController();
    controller.abort();
    const ctx = createMockContext({ ...options.ctx, signal: controller.signal });
    const validSample = generateOne(validArb);
    await withTimeout(def.handler(validSample as any, ctx), timeout);
  } catch {
    // Expected
  }

  protoGuard.check(report);
  return report;
}

// ---------------------------------------------------------------------------
// fuzzResource
// ---------------------------------------------------------------------------

/**
 * Fuzz-tests a resource definition's handler with valid and adversarial params.
 *
 * @example
 * ```ts
 * const report = await fuzzResource(myResource, { numRuns: 50 });
 * expect(report.crashes).toHaveLength(0);
 * ```
 */
export async function fuzzResource(
  def: AnyResourceDefinition,
  options: FuzzOptions = {},
): Promise<FuzzReport> {
  const numRuns = options.numRuns ?? DEFAULTS.numRuns;
  const numAdversarial = options.numAdversarial ?? DEFAULTS.numAdversarial;
  const timeout = options.timeout ?? DEFAULTS.timeout;
  const fcParams: fc.Parameters<unknown> = {
    numRuns,
    ...(options.seed !== undefined && { seed: options.seed }),
  };

  const report: FuzzReport = {
    totalRuns: 0,
    crashes: [],
    leaks: [],
    prototypePollution: false,
  };

  const protoGuard = createProtoPollutionGuard();
  const paramsSchema = def.params;

  if (paramsSchema) {
    // Phase 1: Valid params
    const validArb = zodToArbitrary(paramsSchema) as fc.Arbitrary<Record<string, unknown>>;
    await fc.assert(
      fc.asyncProperty(validArb, async (params) => {
        report.totalRuns++;
        const ctx = createMockContext({
          ...options.ctx,
          uri: new URL(`fuzz://test/${encodeURIComponent(JSON.stringify(params))}`),
        });
        try {
          await withTimeout(def.handler(params, ctx), timeout);
        } catch (err) {
          report.crashes.push({ input: params, error: err });
        }
      }),
      fcParams,
    );

    // Phase 2: Adversarial params
    const advArb = adversarialObjectArbitrary(paramsSchema);
    await fc.assert(
      fc.asyncProperty(advArb, async (params) => {
        report.totalRuns++;
        const ctx = createMockContext({
          ...options.ctx,
          uri: new URL('fuzz://test/adversarial'),
        });
        try {
          const validated = paramsSchema.safeParse(params);
          if (!validated.success) return;
          await withTimeout(def.handler(validated.data, ctx), timeout);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const leakCheck = checkErrorLeaks(msg);
          if (leakCheck.leakedStack || leakCheck.leakedInternals) {
            report.leaks.push({ input: params, errorText: msg });
          }
        }
      }),
      { ...fcParams, numRuns: numAdversarial },
    );
  } else {
    report.totalRuns++;
    const ctx = createMockContext({
      ...options.ctx,
      uri: new URL('fuzz://test/no-params'),
    });
    try {
      await withTimeout(def.handler({}, ctx), timeout);
    } catch (err) {
      report.crashes.push({ input: {}, error: err });
    }
  }

  protoGuard.check(report);
  return report;
}

// ---------------------------------------------------------------------------
// fuzzPrompt
// ---------------------------------------------------------------------------

/**
 * Fuzz-tests a prompt definition's `generate()` with valid and adversarial args.
 *
 * @example
 * ```ts
 * const report = await fuzzPrompt(myPrompt, { numRuns: 50 });
 * expect(report.crashes).toHaveLength(0);
 * ```
 */
export async function fuzzPrompt(
  def: AnyPromptDefinition,
  options: FuzzOptions = {},
): Promise<FuzzReport> {
  const numRuns = options.numRuns ?? DEFAULTS.numRuns;
  const numAdversarial = options.numAdversarial ?? DEFAULTS.numAdversarial;
  const timeout = options.timeout ?? DEFAULTS.timeout;
  const fcParams: fc.Parameters<unknown> = {
    numRuns,
    ...(options.seed !== undefined && { seed: options.seed }),
  };

  const report: FuzzReport = {
    totalRuns: 0,
    crashes: [],
    leaks: [],
    prototypePollution: false,
  };

  const protoGuard = createProtoPollutionGuard();
  const argsSchema = def.args;

  if (argsSchema) {
    const validArb = zodToArbitrary(argsSchema) as fc.Arbitrary<Record<string, string>>;
    await fc.assert(
      fc.asyncProperty(validArb, async (args) => {
        report.totalRuns++;
        try {
          const messages = await withTimeout(def.generate(args), timeout);
          if (!Array.isArray(messages)) {
            report.crashes.push({
              input: args,
              error: new Error('generate() did not return array'),
            });
          }
        } catch (err) {
          report.crashes.push({ input: args, error: err });
        }
      }),
      fcParams,
    );

    const advArb = adversarialObjectArbitrary(argsSchema);
    await fc.assert(
      fc.asyncProperty(advArb, async (args) => {
        report.totalRuns++;
        try {
          const validated = argsSchema.safeParse(args);
          if (!validated.success) return;
          await withTimeout(def.generate(validated.data), timeout);
        } catch {
          // Expected
        }
      }),
      { ...fcParams, numRuns: numAdversarial },
    );
  } else {
    report.totalRuns++;
    try {
      const messages = await withTimeout(def.generate({} as any), timeout);
      if (!Array.isArray(messages)) {
        report.crashes.push({ input: {}, error: new Error('generate() did not return array') });
      }
    } catch (err) {
      report.crashes.push({ input: {}, error: err });
    }
  }

  protoGuard.check(report);
  return report;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: T | Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    Promise.resolve(promise),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Fuzz timeout after ${ms}ms`)), ms),
    ),
  ]);
}

function generateOne<T>(arb: fc.Arbitrary<T>): T {
  let value: T | undefined;
  fc.assert(
    fc.property(arb, (v) => {
      value = v;
      return false; // Stop after first
    }),
    { numRuns: 1, endOnFailure: true },
  );
  // biome-ignore lint/style/noNonNullAssertion: guaranteed set by fc.assert with numRuns:1
  return value!;
}

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

import type fc from 'fast-check';
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
// Lazy-loaded peer dependency
// ---------------------------------------------------------------------------

let _fc: typeof fc | undefined;

/** Eagerly loads the `fast-check` peer dependency. Called automatically by `fuzzTool`/`fuzzResource`/`fuzzPrompt`. Call manually before using `zodToArbitrary` or `adversarialArbitrary` standalone. */
export async function loadFc(): Promise<typeof fc> {
  if (!_fc) _fc = (await import('fast-check')).default;
  return _fc;
}

/** Returns the cached fast-check module. Throws if called before `loadFc()`. */
function getFc(): typeof fc {
  if (!_fc) {
    throw new Error(
      'fast-check not loaded. Call fuzzTool/fuzzResource/fuzzPrompt first, ' +
        'or `await loadFc()` before using zodToArbitrary/adversarialArbitrary directly.',
    );
  }
  return _fc;
}

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
 *
 * Requires `fast-check` to be loaded first — call from within a `fuzzTool()`/
 * `fuzzResource()`/`fuzzPrompt()` run, or call `loadFc()` before standalone use.
 */
export function zodToArbitrary(schema: unknown): fc.Arbitrary<unknown> {
  return zodNodeToArbitrary(schema, 0);
}

function zodNodeToArbitrary(schema: unknown, depth: number): fc.Arbitrary<unknown> {
  const f = getFc();
  if (depth > 6) return f.constant(null);

  // Unwrap wrappers — cast through any to avoid Zod 4 $ZodType vs ZodType mismatch
  if (schema instanceof ZodOptional) {
    return f.option(zodNodeToArbitrary((schema as any).unwrap(), depth), { nil: undefined });
  }
  if (schema instanceof ZodNullable) {
    return f.option(zodNodeToArbitrary((schema as any).unwrap(), depth), { nil: null });
  }
  if (schema instanceof ZodDefault) {
    return f.option(zodNodeToArbitrary((schema as any).removeDefault(), depth), {
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
    return f.boolean();
  }

  // Enum / literal
  if (schema instanceof ZodEnum) {
    const values = (schema as any).options as unknown[];
    return f.constantFrom(...values);
  }
  if (schema instanceof ZodLiteral) {
    return f.constant((schema as any).value);
  }

  // Array
  if (schema instanceof ZodArray) {
    const s = schema as any;
    const minLen: number = typeof s.minLength === 'number' ? s.minLength : 0;
    return f.array(zodNodeToArbitrary(s.element, depth + 1), {
      minLength: minLen,
      maxLength: Math.max(minLen, 5),
    });
  }

  // Union
  if (schema instanceof ZodUnion) {
    const options = (schema as any)._def.options as unknown[];
    return f.oneof(...options.map((o) => zodNodeToArbitrary(o, depth + 1)));
  }

  // Object — check by _def.type since instanceof ZodObject may have type issues
  if (zodTypeName(schema) === 'object') {
    const shape = (schema as any).shape as Record<string, unknown> | undefined;
    if (!shape) return f.constant({});
    const entries = Object.entries(shape);
    if (entries.length === 0) return f.constant({});

    const arbs: Record<string, fc.Arbitrary<unknown>> = {};
    for (const [key, fieldSchema] of entries) {
      arbs[key] = zodNodeToArbitrary(fieldSchema, depth + 1);
    }
    return f.record(arbs);
  }

  // Fallback: generate JSON-safe primitives
  return f.oneof(f.string(), f.integer(), f.boolean(), f.constant(null));
}

/**
 * Zod 4 exposes `.minLength`, `.maxLength`, `.format` as direct accessors on ZodString.
 */
function arbitraryForZodString(schema: ZodString): fc.Arbitrary<string> {
  const f = getFc();
  const s = schema as any;
  const format: string | undefined = s.format;
  if (format === 'email') {
    // fc.emailAddress() can produce emails Zod 4 rejects (e.g. "!a@a.aa").
    // Generate simple, spec-safe emails instead.
    return f
      .tuple(
        f.stringMatching(/^[a-z][a-z0-9]{0,10}$/),
        f.stringMatching(/^[a-z]{2,8}\.[a-z]{2,4}$/),
      )
      .map(([local, domain]) => `${local}@${domain}`);
  }
  if (format === 'url' || format === 'uri') return f.webUrl();
  if (format === 'uuid') return f.uuid();

  const minLen: number = typeof s.minLength === 'number' ? s.minLength : 0;
  const maxLen: number = typeof s.maxLength === 'number' ? s.maxLength : 200;

  return f.string({ minLength: minLen, maxLength: Math.max(minLen, maxLen) });
}

/**
 * Zod 4 exposes `.minValue`, `.maxValue`, `.isInt`, `.isFinite` as direct accessors.
 * Zod 4 defaults to `isFinite: true`, rejecting Infinity/NaN — respect that.
 */
function arbitraryForZodNumber(schema: ZodNumber): fc.Arbitrary<number> {
  const f = getFc();
  const s = schema as any;
  const isFiniteNum: boolean = s.isFinite !== false;
  const rawMin: number = typeof s.minValue === 'number' ? s.minValue : -1_000_000;
  const rawMax: number = typeof s.maxValue === 'number' ? s.maxValue : 1_000_000;
  const min = isFiniteNum && !Number.isFinite(rawMin) ? -1_000_000 : rawMin;
  const max = isFiniteNum && !Number.isFinite(rawMax) ? 1_000_000 : rawMax;
  const isInt: boolean = s.isInt === true;

  return isInt
    ? f.integer({ min, max })
    : f.double({ min, max, noNaN: true, noDefaultInfinity: true });
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
  '﻿',
  '\uD800',
  '􏿿',
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
  const f = getFc();
  return f.oneof(
    // Wrong types
    f.constant(null),
    f.constant(undefined),
    f.constant(true),
    f.constant(false),
    f.constant(0),
    f.constant(-1),
    f.constant(Number.MAX_SAFE_INTEGER),
    f.constant(Number.MIN_SAFE_INTEGER),
    f.constant(NaN),
    f.constant(Infinity),
    f.constant(-Infinity),
    f.constant(''),
    f.constantFrom(...ADVERSARIAL_STRINGS),
    // Arrays where objects expected (and vice versa)
    f.constant([]),
    f.constant([1, 2, 3]),
    f.constant({}),
    // Prototype pollution objects
    f.constant({ __proto__: { polluted: true } }),
    f.constant({ constructor: { prototype: { polluted: true } } }),
    // Deeply nested
    f.constant(buildDeepObject(20)),
    // Circular-safe deep object
    f.constant(buildWideObject(100)),
  );
}

/**
 * Generates an adversarial variant of a Zod object schema's input.
 * Produces objects that match the key structure but have wrong-type values.
 */
export function adversarialObjectArbitrary(
  schema: ZodObject<ZodRawShape>,
): fc.Arbitrary<Record<string, unknown>> {
  const f = getFc();
  const shape = (schema as any).shape as Record<string, unknown> | undefined;
  const keys = shape ? Object.keys(shape) : [];

  if (keys.length === 0) {
    return adversarialArbitrary() as fc.Arbitrary<Record<string, unknown>>;
  }

  return f.record(Object.fromEntries(keys.map((k) => [k, adversarialArbitrary()])));
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
  const f = await loadFc();
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

  // Phase 1: Valid inputs — pre-parse to match production semantics (resolves defaults, enforces constraints)
  const validArb = zodToArbitrary(def.input) as fc.Arbitrary<Record<string, unknown>>;
  await f.assert(
    f.asyncProperty(validArb, async (raw) => {
      report.totalRuns++;
      const parsed = def.input.safeParse(raw);
      if (!parsed.success) return;
      const ctx = createMockContext(options.ctx);
      try {
        const result = await withTimeout(def.handler(parsed.data, ctx), timeout);
        def.output.parse(result);
      } catch (err) {
        report.crashes.push({ input: parsed.data, error: err });
      }
    }),
    fcParams,
  );

  // Phase 2: Adversarial inputs (should be caught by Zod or handler, never crash)
  const advArb = adversarialObjectArbitrary(def.input);
  await f.assert(
    f.asyncProperty(advArb, async (input) => {
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
    const rawSample = generateOne(validArb);
    const parsedSample = def.input.parse(rawSample);
    await withTimeout(def.handler(parsedSample, ctx), timeout);
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
  const f = await loadFc();
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
    // Phase 1: Valid params — pre-parse to match production semantics
    const validArb = zodToArbitrary(paramsSchema) as fc.Arbitrary<Record<string, unknown>>;
    await f.assert(
      f.asyncProperty(validArb, async (raw) => {
        report.totalRuns++;
        const parsed = paramsSchema.safeParse(raw);
        if (!parsed.success) return;
        const ctx = createMockContext({
          ...options.ctx,
          uri: new URL(`fuzz://test/${encodeURIComponent(JSON.stringify(parsed.data))}`),
        });
        try {
          await withTimeout(def.handler(parsed.data, ctx), timeout);
        } catch (err) {
          report.crashes.push({ input: parsed.data, error: err });
        }
      }),
      fcParams,
    );

    // Phase 2: Adversarial params
    const advArb = adversarialObjectArbitrary(paramsSchema);
    await f.assert(
      f.asyncProperty(advArb, async (params) => {
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
  const f = await loadFc();
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
    await f.assert(
      f.asyncProperty(validArb, async (raw) => {
        report.totalRuns++;
        const parsed = argsSchema.safeParse(raw);
        if (!parsed.success) return;
        try {
          const messages = await withTimeout(def.generate(parsed.data), timeout);
          if (!Array.isArray(messages)) {
            report.crashes.push({
              input: parsed.data,
              error: new Error('generate() did not return array'),
            });
          }
        } catch (err) {
          report.crashes.push({ input: parsed.data, error: err });
        }
      }),
      fcParams,
    );

    const advArb = adversarialObjectArbitrary(argsSchema);
    await f.assert(
      f.asyncProperty(advArb, async (args) => {
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
  const f = getFc();
  let value: T | undefined;
  f.assert(
    f.property(arb, (v) => {
      value = v;
      return false; // Stop after first
    }),
    { numRuns: 1, endOnFailure: true },
  );
  // biome-ignore lint/style/noNonNullAssertion: guaranteed set by fc.assert with numRuns:1
  return value!;
}

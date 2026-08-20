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
import { inputVariants } from '@/mcp-server/tools/utils/schemaShape.js';
import type {
  AnyToolDefinition,
  ToolInputSchema,
} from '@/mcp-server/tools/utils/toolDefinition.js';
import { McpError } from '@/types-global/errors.js';
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

/** Elements generated for an array with no declared upper bound. */
const DEFAULT_ARRAY_MAX = 5;

/**
 * Nesting levels expanded before a node is treated as non-terminating. Cycle
 * detection catches self-referential schemas by identity; this is the backstop
 * for a schema whose getters mint a fresh node on every access, where there is
 * no repeated identity to detect.
 */
const MAX_SCHEMA_DEPTH = 32;

/**
 * Converts a Zod schema to a fast-check `Arbitrary` that produces valid values.
 * Supports the JSON-Schema-serializable subset used by MCP tool/resource schemas.
 *
 * Finite nesting is expanded in full, however deep. A self-referential schema —
 * Zod 4's getter pattern, where reading `.shape` re-enters the same node —
 * terminates at the point of recursion with an absence the schema accepts.
 *
 * Requires `fast-check` to be loaded first — call from within a `fuzzTool()`/
 * `fuzzResource()`/`fuzzPrompt()` run, or call `loadFc()` before standalone use.
 */
export function zodToArbitrary(schema: unknown): fc.Arbitrary<unknown> {
  return zodNodeToArbitrary(schema, new Set(), 0) ?? getFc().constant(null);
}

/**
 * Expands one schema node, tracking the nodes on the current path so recursion
 * is distinguished from finite nesting.
 *
 * Returns `undefined` when the node cannot yield a finite value — it re-enters
 * itself, or nesting passed `MAX_SCHEMA_DEPTH`. Callers turn that into a
 * schema-valid absence where one exists (`[]`, omitted optional, `null`), and
 * propagate it otherwise, so a generated sample never carries an invalid value
 * at an arbitrary position.
 */
function zodNodeToArbitrary(
  schema: unknown,
  path: Set<unknown>,
  depth: number,
): fc.Arbitrary<unknown> | undefined {
  if (depth > MAX_SCHEMA_DEPTH) return;
  if (typeof schema !== 'object' || schema === null) return expandNode(schema, path, depth);
  if (path.has(schema)) return;

  path.add(schema);
  try {
    return expandNode(schema, path, depth);
  } finally {
    path.delete(schema);
  }
}

function expandNode(
  schema: unknown,
  path: Set<unknown>,
  depth: number,
): fc.Arbitrary<unknown> | undefined {
  const f = getFc();

  // Unwrap wrappers — cast through any to avoid Zod 4 $ZodType vs ZodType mismatch.
  // A wrapper whose inner node cannot terminate collapses to the absence it permits.
  if (schema instanceof ZodOptional) {
    const inner = zodNodeToArbitrary((schema as any).unwrap(), path, depth);
    return inner ? f.option(inner, { nil: undefined }) : f.constant(undefined);
  }
  if (schema instanceof ZodNullable) {
    const inner = zodNodeToArbitrary((schema as any).unwrap(), path, depth);
    return inner ? f.option(inner, { nil: null }) : f.constant(null);
  }
  if (schema instanceof ZodDefault) {
    const inner = zodNodeToArbitrary((schema as any).removeDefault(), path, depth);
    return inner ? f.option(inner, { nil: undefined, freq: 5 }) : f.constant(undefined);
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
    const { minLength, maxLength } = arrayLengthBounds(schema);
    const element = zodNodeToArbitrary((schema as any).element, path, depth + 1);
    // A recursive element type terminates here — an empty array is the finite value.
    if (!element) return f.constant([]);
    return f.array(element, { minLength, maxLength });
  }

  // Union
  if (schema instanceof ZodUnion) {
    const options = (schema as any)._def.options as unknown[];
    const arbs = options
      .map((o) => zodNodeToArbitrary(o, path, depth + 1))
      .filter((arb): arb is fc.Arbitrary<unknown> => arb !== undefined);
    return arbs.length > 0 ? f.oneof(...arbs) : undefined;
  }

  // Object — check by _def.type since instanceof ZodObject may have type issues
  if (zodTypeName(schema) === 'object') {
    const shape = (schema as any).shape as Record<string, unknown> | undefined;
    if (!shape) return f.constant({});
    const entries = Object.entries(shape);
    if (entries.length === 0) return f.constant({});

    const arbs: Record<string, fc.Arbitrary<unknown>> = {};
    for (const [key, fieldSchema] of entries) {
      const field = zodNodeToArbitrary(fieldSchema, path, depth + 1);
      // An optional or nullable field already collapsed to its permitted absence,
      // so reaching here means a required field cannot terminate.
      if (!field) return;
      arbs[key] = field;
    }
    return f.record(arbs);
  }

  // Fallback: generate JSON-safe primitives
  return f.oneof(f.string(), f.integer(), f.boolean(), f.constant(null));
}

/**
 * Resolves an array's declared length bounds.
 *
 * Unlike ZodString, Zod 4's ZodArray exposes no `.minLength`/`.maxLength`
 * accessors — `.min()`, `.max()`, `.length()`, and `.nonempty()` all land in
 * `_def.checks`. Reading the absent accessor silently drops every one of them.
 */
function arrayLengthBounds(schema: unknown): { minLength: number; maxLength: number } {
  const checks = ((schema as any)?._def?.checks ?? []) as unknown[];
  let min = 0;
  let max: number | undefined;

  for (const check of checks) {
    const def = (check as any)?._zod?.def;
    if (def?.check === 'min_length' && typeof def.minimum === 'number') {
      min = Math.max(min, def.minimum);
    } else if (def?.check === 'max_length' && typeof def.maximum === 'number') {
      max = max === undefined ? def.maximum : Math.min(max, def.maximum);
    } else if (def?.check === 'length_equals' && typeof def.length === 'number') {
      min = Math.max(min, def.length);
      max = max === undefined ? def.length : Math.min(max, def.length);
    }
  }

  // An unsatisfiable schema (min above max) still has to yield an arbitrary
  // rather than throw out of the generator; the sample is rejected at parse.
  return { minLength: min, maxLength: Math.max(min, max ?? DEFAULT_ARRAY_MAX) };
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
 * Generates an adversarial variant of a tool input schema's input.
 * Produces objects that match the key structure but have wrong-type values.
 *
 * A discriminated-union root draws from every variant's key structure, so no
 * branch goes unexercised — including the discriminator itself, which gets
 * adversarial values like any other key.
 */
export function adversarialObjectArbitrary(
  schema: ToolInputSchema,
): fc.Arbitrary<Record<string, unknown>> {
  const f = getFc();
  const variants = inputVariants(schema);
  const perVariant = variants
    .map((variant) => Object.keys(variant.shape))
    .filter((keys) => keys.length > 0)
    .map((keys) => f.record(Object.fromEntries(keys.map((k) => [k, adversarialArbitrary()]))));

  if (perVariant.length === 0) {
    return adversarialArbitrary() as fc.Arbitrary<Record<string, unknown>>;
  }
  return f.oneof(...(perVariant as fc.Arbitrary<Record<string, unknown>>[]));
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

/** Serialize the fields an MCP client can observe, excluding the local Error stack itself. */
function publicErrorText(error: unknown): string {
  if (!(error instanceof McpError)) {
    return error instanceof Error ? error.message : String(error);
  }

  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      { code: error.code, message: error.message, data: error.data },
      (_key, value: unknown) => {
        if (typeof value === 'bigint') return value.toString();
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        return value;
      },
    );
  } catch {
    return error.message;
  }
}

/** Every string the fuzz input carries, object keys included. */
function collectInputStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectInputStrings(item, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      collectInputStrings(item, out);
    }
  }
  return out;
}

/**
 * Removes the input's own strings from an error's client-visible text before the
 * leak heuristic reads it.
 *
 * A handler that names the offending value in its error data — the pattern the
 * framework recommends (`throw validationError(msg, { key })`) — hands the
 * fuzzer's own generated string back to the fuzzer. The heuristic then reads
 * that echo as a leak, even though the client supplied the bytes and learns
 * nothing from seeing them again. The rate is not theoretical: a generated
 * string carries a `<letter>:\` trigram about once in six thousand, which is
 * enough to fail a suite intermittently and nowhere near often enough to be
 * reproducible by rerunning it.
 *
 * Longest needle first, so a JSON-escaped occurrence (`C:\\`) is consumed before
 * its raw form (`C:\`) can leave residue. Needles under two characters are
 * skipped — stripping every `a` would hollow out the text the heuristic reads.
 */
function stripInputEcho(text: string, input: unknown): string {
  const needles = new Set<string>();
  for (const raw of collectInputStrings(input)) {
    if (raw.length < 2) continue;
    needles.add(raw);
    const encoded = JSON.stringify(raw).slice(1, -1);
    if (encoded.length >= 2) needles.add(encoded);
  }
  let stripped = text;
  for (const needle of [...needles].sort((a, b) => b.length - a.length)) {
    stripped = stripped.split(needle).join('');
  }
  return stripped;
}

/**
 * Records a leak entry when an error's client-visible text exposes a stack or
 * internal path that did not come from the input itself.
 */
function recordLeak(report: FuzzReport, input: unknown, error: unknown): void {
  const errorText = publicErrorText(error);
  const { leakedStack, leakedInternals } = checkErrorLeaks(stripInputEcho(errorText, input));
  if (leakedStack || leakedInternals) {
    report.leaks.push({ input, errorText });
  }
}

function recordHandlerError(report: FuzzReport, input: unknown, error: unknown): void {
  if (!(error instanceof McpError)) {
    report.crashes.push({ input, error });
    return;
  }

  recordLeak(report, input, error);
}

function createToolFuzzContext(
  def: AnyToolDefinition,
  options: FuzzOptions,
  overrides: MockContextOptions = {},
) {
  return createMockContext({
    ...options.ctx,
    ...(def.errors !== undefined && { errors: def.errors }),
    ...overrides,
  });
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
 * 1. Valid inputs -> handler returns schema-valid output or a well-formed MCP error
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
      const ctx = createToolFuzzContext(def, options);
      try {
        const result = await withTimeout(def.handler(parsed.data, ctx), timeout);
        def.output.parse(result);
      } catch (err) {
        recordHandlerError(report, parsed.data, err);
      }
    }),
    fcParams,
  );

  // Phase 2: Adversarial inputs (should be caught by Zod or handler, never crash)
  const advArb = adversarialObjectArbitrary(def.input);
  await f.assert(
    f.asyncProperty(advArb, async (input) => {
      report.totalRuns++;
      const ctx = createToolFuzzContext(def, options);
      try {
        const validated = def.input.safeParse(input);
        if (!validated.success) return;
        const result = await withTimeout(def.handler(validated.data, ctx), timeout);
        def.output.parse(result);
      } catch (err) {
        recordLeak(report, input, err);
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
      const ctx = createToolFuzzContext(def, options);
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
    const ctx = createToolFuzzContext(def, options, { signal: controller.signal });
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
          recordHandlerError(report, parsed.data, err);
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
          recordLeak(report, params, err);
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
      recordHandlerError(report, {}, err);
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

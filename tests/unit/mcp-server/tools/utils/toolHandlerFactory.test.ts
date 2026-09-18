/**
 * @fileoverview Tests for createToolHandler — the production handler factory
 * for all `tool()` builder definitions. Verifies the full plumbing chain:
 * input validation, context creation, auth checking, error classification,
 * response formatting, and capability wrapping.
 * @module tests/mcp-server/tools/utils/toolHandlerFactory.test
 */

import type {
  CallToolResult,
  ClientCapabilities,
  ContentBlock,
} from '@modelcontextprotocol/server';
import { inputRequired, SdkError, SdkErrorCode } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import type { ServerContextOverrides } from '../../../../helpers/server-context.js';
import {
  makeSenderlessServerContext,
  makeServerContext,
} from '../../../../helpers/server-context.js';

// ---------------------------------------------------------------------------
// Module mocks — vi.hoisted ensures variables are available during vi.mock hoisting
// ---------------------------------------------------------------------------

const { mockConfig, mockLogger } = vi.hoisted(() => ({
  mockConfig: {
    environment: 'testing',
    mcpServerVersion: '1.0.0-test',
    mcpAuthMode: 'none',
    mcpSessionMode: 'auto' as 'auto' | 'stateful' | 'stateless',
    openTelemetry: { serviceName: 'test', serviceVersion: '0.0.0' },
  },
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
  config: mockConfig,
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
  withExtra: (ctx: { extra?: Record<string, unknown> }, fields: Record<string, unknown>) => ({
    ...ctx,
    extra: { ...ctx.extra, ...fields },
  }),
  withActiveSpan: <T>(ctx: T): T => ctx,
  requestContextService: {
    createRequestContext: vi.fn((opts: any) => ({
      requestId: 'test-req-id',
      timestamp: new Date().toISOString(),
      operation: opts?.operation ?? 'test',
      ...(opts?.additionalContext ?? {}),
    })),
  },
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
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createInputRequiredGate } from '@/mcp-server/inputRequired.js';
import type { AnyToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import {
  advertisedOutputSchema,
  buildToolErrorResult,
  createToolHandler,
  effectiveOutputSchema,
  type HandlerServices,
  type NotifierSources,
} from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { measureToolExecution } from '@/utils/internal/performance.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** What `createToolHandler` resolves with: a tool result, or `input_required`. */
type HandlerResult = Awaited<ReturnType<ReturnType<typeof createToolHandler>>>;

/**
 * First `content[]` block of a completed tool result. Narrows off the
 * `input_required` branch of the union, which carries no `content`.
 */
function firstBlock(result: HandlerResult): ContentBlock {
  return (result as CallToolResult).content![0]!;
}

/** The error envelope a failed call put on `structuredContent`. */
function envelope(result: HandlerResult): {
  code: number;
  data?: { issues?: unknown[]; reason?: string; recovery?: { hint?: string } };
  message: string;
} {
  return ((result as CallToolResult).structuredContent as { error: ReturnType<typeof envelope> })
    .error;
}

/**
 * A `ctx.mcpReq.log` sink typed with the SDK's real signature, so the
 * `toHaveBeenCalledWith(level, data)` assertions are arity-checked.
 */
function makeWireLog(
  impl: NonNullable<ServerContextOverrides['log']> = async () => {},
): ReturnType<typeof vi.fn<NonNullable<ServerContextOverrides['log']>>> {
  return vi.fn(impl);
}

const mockStorage = {
  get: vi.fn(async () => null),
  set: vi.fn(async () => {}),
  delete: vi.fn(async () => {}),
  list: vi.fn(async () => ({ keys: [] })),
  getMany: vi.fn(async () => new Map()),
};

const services: HandlerServices = {
  logger: mockLogger as any,
  storage: mockStorage as any,
};

const notifiers: NotifierSources = {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createToolHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset session mode between tests so the durability gate isn't sticky.
    // 'auto' is the production default and resolves to stateful for HTTP.
    mockConfig.mcpSessionMode = 'auto';
  });

  // -----------------------------------------------------------------------
  // Basic execution
  // -----------------------------------------------------------------------

  describe('Basic execution', () => {
    it('should validate input, call handler with Context, and return formatted response', async () => {
      let capturedCtx: any;

      const def = tool('echo_tool', {
        description: 'Echoes input.',
        input: z.object({ message: z.string().describe('msg') }),
        output: z.object({ echo: z.string().describe('echo') }),
        async handler(input, ctx) {
          capturedCtx = ctx;
          return { echo: input.message };
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({ message: 'hello' }, makeServerContext());

      // Response structure
      expect(result.structuredContent).toEqual({ echo: 'hello' });
      expect(result.content).toHaveLength(1);
      expect(firstBlock(result).type).toBe('text');
      expect(result.isError).toBeUndefined();

      // Context was created with correct fields
      expect(capturedCtx).toBeDefined();
      expect(capturedCtx.requestId).toBe('test-req-id');
      expect(typeof capturedCtx.log.info).toBe('function');
      expect(typeof capturedCtx.state.get).toBe('function');
      expect(capturedCtx.signal).toBeDefined();
    });

    it('should use custom format function when provided', async () => {
      const def = tool('formatted_tool', {
        description: 'Returns custom format.',
        input: z.object({ n: z.number().describe('num') }),
        output: z.object({ doubled: z.number().describe('result') }),
        handler: (input) => ({ doubled: input.n * 2 }),
        format: (result) => [{ type: 'text', text: `Result: ${result.doubled}` }],
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({ n: 5 }, makeServerContext());

      expect((firstBlock(result) as { text: string }).text).toBe('Result: 10');
    });

    it('should default to JSON stringify when no format is provided', async () => {
      const def = tool('json_tool', {
        description: 'Returns JSON.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: () => ({ ok: true }),
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, makeServerContext());

      const text = (firstBlock(result) as { text: string }).text;
      expect(JSON.parse(text)).toEqual({ ok: true });
    });

    it.each([
      [
        'Error',
        () => {
          throw new Error('formatter error');
        },
        'formatter error',
      ],
      [
        'non-Error',
        () => {
          throw 'formatter string';
        },
        'formatter string',
      ],
    ])('should classify %s formatter failures as tool errors', async (_kind, format, message) => {
      const def = tool('bad_formatter_tool', {
        description: 'Formatter failure.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: () => ({ ok: true }),
        format,
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, makeServerContext());

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { message: `Output formatting failed: ${message}` },
      });
    });

    it('should prepend handler-collected media to formatted content', async () => {
      const def = tool('media_tool', {
        description: 'Collects media.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: (_input, ctx) => {
          ctx.content.image('aW1hZ2U=', 'image/png');
          return { ok: true };
        },
        format: () => [{ type: 'text', text: 'done' }],
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, makeServerContext());

      expect(result.content).toEqual([
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
        { type: 'text', text: 'done' },
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // Input validation
  // -----------------------------------------------------------------------

  describe('Input validation', () => {
    it('should reject invalid input with isError: true', async () => {
      const def = tool('strict_tool', {
        description: 'Requires a string.',
        input: z.object({ name: z.string().describe('name') }),
        output: z.object({ ok: z.boolean() }),
        handler: () => ({ ok: true }),
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({ name: 123 } as any, makeServerContext());

      expect(result.isError).toBe(true);
      // Input validation errors flow through the same error-shaping path:
      // structuredContent.error carries the code, message, and ZodError issues.
      // Argument rejection classifies as InvalidParams — the framework runs the
      // check the SDK used to, and keeps the SDK's classification (#377).
      const sc = result.structuredContent as {
        error: { code: number; data?: { issues?: unknown[] }; message: string };
      };
      expect(sc.error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(sc.error.message).toContain('Invalid arguments for tool');
      expect(sc.error.data?.issues).toBeDefined();
    });

    it('should not call handler when input validation fails', async () => {
      const handlerFn = vi.fn(() => ({ ok: true }));
      const def = tool('guarded_tool', {
        description: 'Guarded.',
        input: z.object({ required: z.string().describe('r') }),
        output: z.object({ ok: z.boolean() }),
        handler: handlerFn,
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({} as any, makeServerContext());

      expect(handlerFn).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Argument-rejection rendering (#378, #417, #445)
  // -----------------------------------------------------------------------

  describe('argument-rejection rendering (#378, #417, #445)', () => {
    const ok = z.object({ ok: z.boolean().describe('ok') });
    const pass = () => ({ ok: true });

    const facet = tool('facet_tool', {
      description: 'Reads one system facet.',
      input: z.object({ what: z.enum(['os', 'cpu', 'memory']).describe('Facet.') }),
      output: ok,
      handler: pass,
    });

    const nestedFacet = tool('nested_facet_tool', {
      description: 'Reads a nested facet.',
      input: z.object({
        outer: z.object({ inner: z.enum(['a', 'b']).describe('Inner facet.') }).describe('Outer.'),
      }),
      output: ok,
      handler: pass,
    });

    const literalTool = tool('literal_tool', {
      description: 'Requires a fixed literal.',
      input: z.object({ k: z.literal('fixed').describe('The only accepted value.') }),
      output: ok,
      handler: pass,
    });

    const optionalCourt = tool('optional_court_tool', {
      description: 'Optional blank-or-enum court filter.',
      input: z.object({
        court: z
          .union([z.literal(''), z.enum(['CJEU', 'GC'])])
          .optional()
          .describe('Court, or blank for any.'),
      }),
      output: ok,
      handler: pass,
    });

    const requiredCourt = tool('required_court_tool', {
      description: 'Required blank-or-enum court filter.',
      input: z.object({
        court: z.union([z.literal(''), z.enum(['CJEU', 'GC'])]).describe('Court, or blank.'),
      }),
      output: ok,
      handler: pass,
    });

    const threeBranch = tool('three_branch_tool', {
      description: 'Blank, enum, or integer.',
      input: z.object({
        v: z.union([z.literal(''), z.enum(['a', 'b']), z.number().int()]).describe('Value.'),
      }),
      output: ok,
      handler: pass,
    });

    const singleValueBranches = tool('single_value_union_tool', {
      description: 'Blank or a one-value enum — every branch is single-valued.',
      input: z.object({ v: z.union([z.literal(''), z.enum(['only'])]).describe('Value.') }),
      output: ok,
      handler: pass,
    });

    const regexUnion = tool('regex_union_tool', {
      description: 'Blank or an ECLI identifier.',
      input: z.object({
        e: z
          .union([z.literal(''), z.string().regex(/^ECLI:/, 'Must start with ECLI:')])
          .describe('ECLI, or blank.'),
      }),
      output: ok,
      handler: pass,
    });

    const search = tool('search_tool', {
      description: 'Searches.',
      input: z.object({
        query: z.string().min(1).describe('Search query.'),
        limit: z.number().optional().describe('Maximum results.'),
      }),
      output: ok,
      handler: pass,
    });

    const point = tool('point_tool', {
      description: 'Takes a coordinate.',
      input: z.object({
        lat: z.number().describe('Latitude.'),
        lon: z.number().describe('Longitude.'),
      }),
      output: ok,
      handler: pass,
    });

    const unionRoot = tool('union_root_tool', {
      description: 'Looks a record up by exactly one key.',
      input: z.discriminatedUnion('mode', [
        z.object({
          mode: z.literal('byId').describe('By ID.'),
          id: z.string().describe('Record ID.'),
        }),
        z.object({
          mode: z.literal('byName').describe('By name.'),
          name: z.string().describe('Name.'),
        }),
      ]),
      output: ok,
      handler: pass,
    });

    const catchallRoot = tool('catchall_root_tool', {
      description: 'Open root validating unknown keys against a catchall.',
      input: z.object({ a: z.string().describe('A.') }).catchall(z.number()),
      output: ok,
      handler: pass,
    });

    const passthroughRoot = tool('passthrough_root_tool', {
      description: 'Open root accepting unknown keys outright.',
      input: z.object({ a: z.string().describe('A.') }).passthrough(),
      output: ok,
      handler: pass,
    });

    const objUnion = tool('obj_union_tool', {
      description: 'Two-object union.',
      input: z.object({
        spec: z
          .union([
            z.object({ kind: z.enum(['x', 'y']).describe('Kind.'), n: z.number().describe('N.') }),
            z.object({ other: z.string().describe('Other.') }),
          ])
          .describe('Spec.'),
      }),
      output: ok,
      handler: pass,
    });

    const mixedUnion = tool('mixed_union_tool', {
      description: 'A scalar branch beside an object branch.',
      input: z.object({
        spec: z
          .union([
            z.enum(['x', 'y']).describe('A bare choice.'),
            z.object({ other: z.string().describe('Other.') }),
          ])
          .describe('Spec.'),
      }),
      output: ok,
      handler: pass,
    });

    const nestedBranchUnion = tool('nested_branch_union_tool', {
      description: 'A union branch whose issue sits two segments deep.',
      input: z.object({
        spec: z
          .union([
            z.object({
              inner: z.object({ deep: z.number().describe('Deep.') }).describe('Inner.'),
            }),
            z.object({ other: z.string().describe('Other.') }),
          ])
          .describe('Spec.'),
      }),
      output: ok,
      handler: pass,
    });

    const dupUnion = tool('dup_union_tool', {
      description: 'Two branches, same message, different field.',
      input: z.object({
        spec: z
          .union([
            z.object({ a: z.number().describe('A.') }),
            z.object({ b: z.number().describe('B.') }),
          ])
          .describe('Spec.'),
      }),
      output: ok,
      handler: pass,
    });

    const sameLineUnion = tool('same_line_union_tool', {
      description: 'Two branches whose rendered line is identical once the path is included.',
      input: z.object({
        spec: z
          .union([
            z.object({ a: z.number().describe('A.') }),
            z.object({ a: z.number().min(2).describe('A, at least two.') }),
          ])
          .describe('Spec.'),
      }),
      output: ok,
      handler: pass,
    });

    /** Drives a definition through the production factory with raw arguments. */
    async function reject(def: unknown, args: Record<string, unknown>) {
      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      return await handler(args, makeServerContext());
    }

    /** The rendered detail — everything after the `Invalid arguments` preamble. */
    function detail(result: HandlerResult, toolName: string): string {
      return envelope(result).message.replace(
        `Input validation error: Invalid arguments for tool ${toolName}: `,
        '',
      );
    }

    function hint(result: HandlerResult): string | undefined {
      return envelope(result).data?.recovery?.hint;
    }

    // ---------------------------------------------------------------------
    // Characterization — rendering that must not move
    // ---------------------------------------------------------------------

    describe('rendering that must not move', () => {
      it('keeps a missing required non-enum field on the Zod invalid_type sentence', async () => {
        const result = await reject(search, {});

        expect(detail(result, 'search_tool')).toBe(
          'query: Invalid input: expected string, received undefined',
        );
      });

      it('keeps the unrecognized-key diagnostic as the first line', async () => {
        const result = await reject(search, { query: 'ok', salt: true });

        expect(envelope(result).message).toBe(
          'Input validation error: Invalid arguments for tool search_tool: Unrecognized key: "salt"',
        );
      });

      it('joins several issues with a comma, one `path: message` each', async () => {
        const result = await reject(point, { lat: 'x', lon: 'y' });

        expect(detail(result, 'point_tool')).toBe(
          'lat: Invalid input: expected number, received string, ' +
            'lon: Invalid input: expected number, received string',
        );
      });

      it('keeps a failed constraint on its own Zod message', async () => {
        const result = await reject(search, { query: '' });

        expect(detail(result, 'search_tool')).toBe(
          'query: Too small: expected string to have >=1 characters',
        );
      });

      it('keeps the discriminator sentence for a union root', async () => {
        const result = await reject(unionRoot, { mode: 'byEmail' });

        expect(detail(result, 'union_root_tool')).toBe(
          "mode: Invalid discriminator value. Expected 'byId' | 'byName'",
        );
      });

      it('keeps a catchall root on the unknown key’s own invalid_type sentence', async () => {
        const result = await reject(catchallRoot, { a: 'x', extra: 'not-a-number' });

        expect(detail(result, 'catchall_root_tool')).toBe(
          'extra: Invalid input: expected number, received string',
        );
      });

      it('accepts an unknown key outright on a passthrough root', async () => {
        const result = await reject(passthroughRoot, { a: 'x', extra: 'anything' });

        expect((result as CallToolResult).isError).toBeUndefined();
      });

      it('keeps a union branch that already reports specifically', async () => {
        // Exactly one branch matched the base type and failed only a check, so
        // Zod returns that branch's issues directly — never `Invalid input`.
        const result = await reject(regexUnion, { e: 'abc' });

        expect(detail(result, 'regex_union_tool')).toBe('e: Must start with ECLI:');
      });
    });

    // ---------------------------------------------------------------------
    // #378 — missing renders as missing, not as a wrong choice
    // ---------------------------------------------------------------------

    describe('missing vs. wrong rendering (#378)', () => {
      it('renders an omitted required enum as missing, keeping the expected set', async () => {
        const result = await reject(facet, {});

        expect(detail(result, 'facet_tool')).toBe(
          'what: Missing required field. Expected one of "os"|"cpu"|"memory"',
        );
      });

      it('keeps the invalid-option sentence for a value outside the set', async () => {
        const result = await reject(facet, { what: 'bogus' });

        expect(detail(result, 'facet_tool')).toBe(
          'what: Invalid option: expected one of "os"|"cpu"|"memory"',
        );
      });

      it('treats an explicit null as present with a wrong value', async () => {
        const result = await reject(facet, { what: null });

        expect(detail(result, 'facet_tool')).toBe(
          'what: Invalid option: expected one of "os"|"cpu"|"memory"',
        );
      });

      it('resolves absence along a nested path', async () => {
        const missing = await reject(nestedFacet, { outer: {} });
        const wrong = await reject(nestedFacet, { outer: { inner: 'z' } });

        expect(detail(missing, 'nested_facet_tool')).toBe(
          'outer.inner: Missing required field. Expected one of "a"|"b"',
        );
        expect(detail(wrong, 'nested_facet_tool')).toBe(
          'outer.inner: Invalid option: expected one of "a"|"b"',
        );
      });

      it('renders a single accepted value without the "one of" phrasing', async () => {
        const result = await reject(literalTool, {});

        expect(detail(result, 'literal_tool')).toBe('k: Missing required field. Expected "fixed"');
      });
    });

    // ---------------------------------------------------------------------
    // #417 — a union renders its branch message, not the placeholder
    // ---------------------------------------------------------------------

    describe('union branch rendering (#417)', () => {
      it('renders the enum branch rather than the union placeholder', async () => {
        const result = await reject(optionalCourt, { court: 'bogus' });

        expect(detail(result, 'optional_court_tool')).toBe(
          'court: Invalid option: expected one of "CJEU"|"GC"',
        );
      });

      it('joins the remaining branches of a three-branch union with " or "', async () => {
        const result = await reject(threeBranch, { v: true });

        expect(detail(result, 'three_branch_tool')).toBe(
          'v: Invalid option: expected one of "a"|"b" or ' +
            'Invalid input: expected number, received boolean',
        );
      });

      it("falls back to the union's own message when every branch is filtered out", async () => {
        const result = await reject(singleValueBranches, { v: 'bogus' });

        expect(detail(result, 'single_value_union_tool')).toBe('v: Invalid input');
      });

      it('selects the branch first, then renders an omitted required union as missing', async () => {
        const omitted = await reject(requiredCourt, {});
        const wrong = await reject(requiredCourt, { court: 'bogus' });

        expect(detail(omitted, 'required_court_tool')).toBe(
          'court: Missing required field. Expected one of "CJEU"|"GC"',
        );
        expect(detail(wrong, 'required_court_tool')).toBe(
          'court: Invalid option: expected one of "CJEU"|"GC"',
        );
      });
    });

    // ---------------------------------------------------------------------
    // #447 — an object branch names the field its issue is about
    // ---------------------------------------------------------------------

    describe('union branch paths (#447)', () => {
      it('prefixes each branch issue with its own path, joining within a branch differently', async () => {
        const result = await reject(objUnion, { spec: {} });

        expect(detail(result, 'obj_union_tool')).toBe(
          'spec: kind: Invalid option: expected one of "x"|"y"; ' +
            'n: Invalid input: expected number, received undefined or ' +
            'other: Invalid input: expected string, received undefined',
        );
      });

      it('leaves a scalar branch unprefixed beside a prefixed object branch', async () => {
        const result = await reject(mixedUnion, { spec: {} });

        expect(detail(result, 'mixed_union_tool')).toBe(
          'spec: Invalid option: expected one of "x"|"y" or ' +
            'other: Invalid input: expected string, received undefined',
        );
      });

      it('renders every segment of a multi-segment branch path', async () => {
        const result = await reject(nestedBranchUnion, { spec: { inner: { deep: 'x' } } });

        expect(detail(result, 'nested_branch_union_tool')).toBe(
          'spec: inner.deep: Invalid input: expected number, received string or ' +
            'other: Invalid input: expected string, received undefined',
        );
      });

      it('keeps both alternatives when they differ only by the field they name', async () => {
        const result = await reject(dupUnion, { spec: {} });

        expect(detail(result, 'dup_union_tool')).toBe(
          'spec: a: Invalid input: expected number, received undefined or ' +
            'b: Invalid input: expected number, received undefined',
        );
      });

      it('still collapses two branches whose rendered line is identical with the path', async () => {
        const result = await reject(sameLineUnion, { spec: {} });

        expect(detail(result, 'same_line_union_tool')).toBe(
          'spec: a: Invalid input: expected number, received undefined',
        );
      });

      it('carries the prefixed text into data.recovery.hint', async () => {
        const result = await reject(objUnion, { spec: {} });

        expect(hint(result)).toBe(
          'kind: Invalid option: expected one of "x"|"y"; ' +
            'n: Invalid input: expected number, received undefined or ' +
            'other: Invalid input: expected string, received undefined',
        );
      });

      it('leaves data.issues the raw nested Zod issues', async () => {
        const result = await reject(objUnion, { spec: {} });
        const issues = envelope(result).data?.issues as Array<{
          code: string;
          errors: Array<Array<{ path: string[] }>>;
        }>;

        expect(issues[0]?.code).toBe('invalid_union');
        expect(issues[0]?.errors[0]?.[0]?.path).toEqual(['kind']);
      });

      it('reports an omitted union field as a plain invalid_type at the outer path', async () => {
        const result = await reject(objUnion, {});

        expect(detail(result, 'obj_union_tool')).toBe(
          'spec: Invalid input: expected object, received undefined',
        );
      });
    });

    // ---------------------------------------------------------------------
    // #445 — reason + synthesized recovery hint
    // ---------------------------------------------------------------------

    describe('reason and recovery hint (#445)', () => {
      it.each([
        ['an unknown root key', search, { query: 'ok', salt: true }],
        ['a wrong argument type', point, { lat: '1', lon: 2 }],
        ['a missing required field', point, {}],
        ['a failed constraint', search, { query: '' }],
      ])('carries reason and a nonempty hint for %s', async (_label, def, args) => {
        const result = await reject(def, args);

        expect(envelope(result).code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(envelope(result).data?.reason).toBe('invalid_arguments');
        expect(hint(result)?.length ?? 0).toBeGreaterThan(0);
        // The Zod issues still ship verbatim; nothing carries the rejected value.
        expect(envelope(result).data?.issues).toBeDefined();
        expect(JSON.stringify(envelope(result).data?.issues)).not.toContain('"input"');
      });

      it('names the unknown key and every accepted root property, in schema order', async () => {
        const result = await reject(search, { query: 'ok', salt: true });

        expect(hint(result)).toBe('Unknown key salt. This tool accepts: query, limit.');
      });

      it('pluralizes and lists several unknown keys', async () => {
        const result = await reject(search, { query: 'ok', bbox: 1, extra: 2 });

        expect(hint(result)).toBe('Unknown keys bbox, extra. This tool accepts: query, limit.');
      });

      it('omits the accepted list on a discriminated-union root', async () => {
        const result = await reject(unionRoot, { mode: 'byId', id: 'x', idd: 'typo' });

        expect(hint(result)).toBe('Unknown key idd.');
      });

      it('names the arriving type on a wrong-type argument', async () => {
        const result = await reject(point, { lat: '1', lon: 2 });

        expect(hint(result)).toBe('Send lat as a number, not a string.');
      });

      it('names the arguments themselves when the root is not an object', async () => {
        const result = await reject(point, 'lat=1' as unknown as Record<string, unknown>);

        expect(hint(result)).toBe('Send the arguments as an object, not a string.');
      });

      it('asks for the arguments when the call carries none', async () => {
        const result = await reject(point, undefined as unknown as Record<string, unknown>);

        expect(hint(result)).toBe('Send the arguments as an object.');
      });

      it('asks for every missing field in one sentence', async () => {
        const result = await reject(point, {});

        expect(hint(result)).toBe('Provide lat and lon.');
      });

      it('leaves a constraint failure on the issue message', async () => {
        const result = await reject(search, { query: '' });

        expect(hint(result)).toBe('Too small: expected string to have >=1 characters');
      });

      it('joins several issues into one hint, one sentence per issue', async () => {
        const result = await reject(point, { lat: 'x' });

        expect(hint(result)).toBe('Send lat as a number, not a string. Provide lon.');
      });

      it('reaches the catchall root through invalid_type, never the accepted-key branch', async () => {
        const result = await reject(catchallRoot, { a: 'x', extra: 'not-a-number' });

        expect(hint(result)).toBe('Send extra as a number, not a string.');
        expect(hint(result)).not.toContain('This tool accepts');
      });

      it('carries a selected union branch into the hint', async () => {
        const result = await reject(optionalCourt, { court: 'bogus' });

        expect(hint(result)).toBe('Invalid option: expected one of "CJEU"|"GC"');
      });

      it('mirrors the hint into content[] after the diagnostic line', async () => {
        const result = await reject(search, { query: 'ok', salt: true });

        expect((firstBlock(result) as { text: string }).text).toBe(
          'Error: Input validation error: Invalid arguments for tool search_tool: ' +
            'Unrecognized key: "salt"\n\nRecovery: Unknown key salt. ' +
            'This tool accepts: query, limit.\n\n(reason invalid_arguments)',
        );
      });
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe('Error handling', () => {
    it('should catch plain Error and emit structuredContent.error with code + message', async () => {
      const def = tool('failing_tool', {
        description: 'Throws.',
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          throw new Error('something broke');
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, makeServerContext());

      expect(result.isError).toBe(true);
      expect((firstBlock(result) as { text: string }).text).toContain('something broke');
      // _meta.error is no longer emitted — error data lives on structuredContent.error
      expect(result._meta).toBeUndefined();
      // Plain errors get classified as InternalError, no data
      expect(result.structuredContent).toEqual({
        error: { code: JsonRpcErrorCode.InternalError, message: 'something broke' },
      });
    });

    it('should catch McpError and surface code + message + data via structuredContent.error', async () => {
      const def = tool('mcp_error_tool', {
        description: 'Throws McpError.',
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          throw new McpError(JsonRpcErrorCode.NotFound, 'Item not found', { id: '123' });
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, makeServerContext());

      expect(result.isError).toBe(true);
      expect((firstBlock(result) as { text: string }).text).toContain('Item not found');
      expect(result._meta).toBeUndefined();
      expect(result.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message: 'Item not found',
          data: { id: '123' },
        },
      });
    });

    it('should handle ZodError from handler (not input validation) as error', async () => {
      const def = tool('zod_throw_tool', {
        description: 'Internal Zod parse fails.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler: () => {
          // Simulate handler internally parsing bad data
          z.object({ required: z.string() }).parse({});
          return { ok: true };
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, makeServerContext());

      expect(result.isError).toBe(true);
      // ZodError data.issues should appear in structuredContent.error
      const sc = result.structuredContent as { error: { data?: { issues?: unknown[] } } };
      expect(sc.error.data?.issues).toBeDefined();
    });

    it('should propagate McpError code, message, and data via structuredContent.error', async () => {
      const errorData = { field: 'email', constraint: 'format' };

      const def = tool('meta_error_tool', {
        description: 'McpError with data.',
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          throw new McpError(JsonRpcErrorCode.ValidationError, 'Validation failed', errorData);
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, makeServerContext());

      expect(result.isError).toBe(true);
      expect(result._meta).toBeUndefined();
      expect(result.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message: 'Validation failed',
          data: errorData,
        },
      });
      const text = (firstBlock(result) as { text: string }).text;
      expect(text).toContain('Validation failed');
    });

    it('should handle non-Error throws (string)', async () => {
      const def = tool('string_throw_tool', {
        description: 'Throws a string.',
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          throw 'raw string error';
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, makeServerContext());

      expect(result.isError).toBe(true);
      expect(result._meta).toBeUndefined();
      const sc = result.structuredContent as { error: { code: number; message: string } };
      expect(sc.error.code).toBeDefined();
    });

    it('should mirror data.recovery.hint into content[] text when present', async () => {
      const def = tool('recovery_tool', {
        description: 'Throws with recovery hint.',
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          throw new McpError(JsonRpcErrorCode.NotFound, 'No items returned', {
            reason: 'no_match',
            recovery: { hint: 'Try the search tool with broader terms.' },
          });
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, makeServerContext());

      expect(result.isError).toBe(true);
      const text = (firstBlock(result) as { text: string }).text;
      // content[] text carries the recovery hint for format()-only clients (Claude Desktop)
      expect(text).toContain('No items returned');
      expect(text).toContain('Recovery: Try the search tool with broader terms.');
      // structuredContent.error.data.recovery.hint carries the hint for structuredContent-only clients (Claude Code)
      const sc = result.structuredContent as {
        error: { data?: { recovery?: { hint?: string } } };
      };
      expect(sc.error.data?.recovery?.hint).toBe('Try the search tool with broader terms.');
    });

    it('should not append recovery section when data.recovery.hint is missing', async () => {
      const def = tool('no_recovery_tool', {
        description: 'Throws without recovery hint.',
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          throw new McpError(JsonRpcErrorCode.InternalError, 'Boom', { reason: 'boom' });
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, makeServerContext());

      const text = (firstBlock(result) as { text: string }).text;
      // The declared reason still renders its own line (#458); only the
      // `Recovery:` line is absent.
      expect(text).toBe('Error: Boom\n\n(reason boom)');
      expect(text).not.toContain('Recovery:');
    });

    it('should ignore non-string recovery.hint', async () => {
      const def = tool('bad_recovery_tool', {
        description: 'Throws with malformed recovery.',
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          throw new McpError(JsonRpcErrorCode.InternalError, 'Boom', {
            recovery: { hint: 42 },
          });
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, makeServerContext());

      const text = (firstBlock(result) as { text: string }).text;
      expect(text).toBe('Error: Boom');
    });
  });

  // -----------------------------------------------------------------------
  // content[] error text — branchable terms (#458) and hint repeats (#459)
  // -----------------------------------------------------------------------

  describe('content[] error text (#458, #459)', () => {
    /** The rendered `content[]` text of an error result. */
    const rendered = (result: CallToolResult): string =>
      ((result.content as ContentBlock[])[0] as { text: string }).text;

    /** Drives a handler that throws `thrown` through the production factory. */
    async function throwing(thrown: unknown): Promise<HandlerResult> {
      const def = tool('text_probe', {
        description: 'Throws a supplied value.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: () => {
          throw thrown;
        },
      });
      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      return await handler({}, makeServerContext());
    }

    describe('branchable terms (#458)', () => {
      it('renders reason and retryable after the message and the Recovery line', () => {
        const text = rendered(
          buildToolErrorResult(
            JsonRpcErrorCode.ValidationError,
            'Invalid id element "12,34" — send one identifier per element.',
            {
              reason: 'malformed_id',
              retryable: false,
              recovery: { hint: 'Submit one identifier per `ids` element.' },
            },
          ),
        );

        expect(text).toBe(
          'Error: Invalid id element "12,34" — send one identifier per element.\n\n' +
            'Recovery: Submit one identifier per `ids` element.\n\n' +
            '(reason malformed_id · not retryable)',
        );
      });

      it('renders a retryable contract entry as `retryable`', () => {
        const text = rendered(
          buildToolErrorResult(JsonRpcErrorCode.RateLimited, 'Queue at capacity.', {
            reason: 'queue_full',
            retryable: true,
          }),
        );

        expect(text).toBe('Error: Queue at capacity.\n\n(reason queue_full · retryable)');
      });

      it.each([
        ['a reason with no retryable', { reason: 'no_match' }, '(reason no_match)'],
        ['a bare retryable true', { retryable: true }, '(retryable)'],
        ['a bare retryable false', { retryable: false }, '(not retryable)'],
      ])('renders %s', (_label, data, expected) => {
        expect(rendered(buildToolErrorResult(JsonRpcErrorCode.NotFound, 'Boom', data))).toBe(
          `Error: Boom\n\n${expected}`,
        );
      });

      it.each([
        ['no data at all', undefined],
        ['data carrying neither field', { itemId: '123' }],
        ['a non-boolean retryable', { retryable: 'yes' }],
        ['an empty-string reason', { reason: '' }],
      ])('appends no line for %s', async (_label, data) => {
        expect(
          rendered(
            buildToolErrorResult(
              JsonRpcErrorCode.InternalError,
              'Boom',
              data as Record<string, unknown> | undefined,
            ),
          ),
        ).toBe('Error: Boom');
      });

      it('appends no line for a classified plain Error', async () => {
        const result = await throwing(new Error('something broke'));

        expect(rendered(result as CallToolResult)).toBe('Error: something broke');
        expect((result as CallToolResult).structuredContent).toEqual({
          error: { code: JsonRpcErrorCode.InternalError, message: 'something broke' },
        });
      });

      it('renders the framework reason on an argument rejection, with no retryable term', async () => {
        const def = tool('reason_reject_tool', {
          description: 'Rejects unknown keys.',
          input: z.object({ query: z.string().describe('Search query.') }),
          output: z.object({ ok: z.boolean().describe('ok') }),
          handler: () => ({ ok: true }),
        });
        const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);

        const result = await handler({ query: 'ok', salt: true }, makeServerContext());
        const text = rendered(result as CallToolResult);

        expect(text.endsWith('\n\n(reason invalid_arguments)')).toBe(true);
        expect(text).not.toContain('retryable');
      });

      it('keeps the numeric code and data.issues out of content[]', async () => {
        const def = tool('code_free_tool', {
          description: 'Rejects a wrong type.',
          input: z.object({ lat: z.number().describe('Latitude.') }),
          output: z.object({ ok: z.boolean().describe('ok') }),
          handler: () => ({ ok: true }),
        });
        const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);

        const result = await handler({ lat: 'x' }, makeServerContext());
        const text = rendered(result as CallToolResult);

        expect(text).not.toContain('-32602');
        expect(text).not.toContain('"code"');
        expect(text).not.toContain('invalid_type');
        expect(envelope(result).code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(envelope(result).data?.issues).toBeDefined();
      });

      it('leaves structuredContent byte-identical to the thrown envelope', async () => {
        const data = { reason: 'no_match', retryable: false, recovery: { hint: 'Broaden it.' } };
        const result = await throwing(new McpError(JsonRpcErrorCode.NotFound, 'Nothing.', data));

        expect((result as CallToolResult).structuredContent).toEqual({
          error: { code: JsonRpcErrorCode.NotFound, message: 'Nothing.', data },
        });
      });
    });

    describe('hint repeats (#459)', () => {
      const ok = z.object({ ok: z.boolean().describe('ok') });

      const exclusiveProbe = tool('exclusive_probe', {
        description: 'Accepts exactly one identifier list.',
        input: z
          .object({
            pmcids: z.array(z.string()).optional().describe('PMC identifiers.'),
            pmids: z.array(z.string()).optional().describe('PubMed identifiers.'),
          })
          .refine(
            (value) => [value.pmcids, value.pmids].filter(Boolean).length === 1,
            'Provide exactly one of `pmcids` or `pmids` (not zero, not more).',
          ),
        output: ok,
        handler: () => ({ ok: true }),
      });

      const tokenProbe = tool('token_probe', {
        description: 'Accepts a single-token query.',
        input: z.object({
          query: z
            .string()
            .refine((v) => !v.includes(' '), 'Use a single token; spaces are not supported.')
            .describe('Search query.'),
        }),
        output: ok,
        handler: () => ({ ok: true }),
      });

      async function reject(def: unknown, args: Record<string, unknown>): Promise<HandlerResult> {
        const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
        return await handler(args, makeServerContext());
      }

      it('drops the line when a root refinement hint repeats its own message', async () => {
        const result = await reject(exclusiveProbe, { pmcids: ['a'], pmids: ['b'] });

        expect(rendered(result as CallToolResult)).toBe(
          'Error: Input validation error: Invalid arguments for tool exclusive_probe: ' +
            'Provide exactly one of `pmcids` or `pmids` (not zero, not more).\n\n' +
            '(reason invalid_arguments)',
        );
        expect(envelope(result).data?.recovery?.hint).toBe(
          'Provide exactly one of `pmcids` or `pmids` (not zero, not more).',
        );
      });

      it('drops the line when the message only adds the field path the hint lacks', async () => {
        const result = await reject(tokenProbe, { query: 'two words' });

        expect(rendered(result as CallToolResult)).not.toContain('Recovery:');
        expect(envelope(result).message).toContain(
          'query: Use a single token; spaces are not supported.',
        );
        expect(envelope(result).data?.recovery?.hint).toBe(
          'Use a single token; spaces are not supported.',
        );
      });

      it('drops the line when a handler hint restates its message', async () => {
        const result = await throwing(
          new McpError(JsonRpcErrorCode.NotFound, 'No such record.', {
            recovery: { hint: 'No such record.' },
          }),
        );

        expect(rendered(result as CallToolResult)).toBe('Error: No such record.');
        expect((result as CallToolResult).structuredContent).toEqual({
          error: {
            code: JsonRpcErrorCode.NotFound,
            message: 'No such record.',
            data: { recovery: { hint: 'No such record.' } },
          },
        });
      });

      it('keeps a hint the message matches only case-insensitively', async () => {
        const result = await throwing(
          new McpError(JsonRpcErrorCode.NotFound, 'No such record.', {
            recovery: { hint: 'no such record.' },
          }),
        );

        expect(rendered(result as CallToolResult)).toBe(
          'Error: No such record.\n\nRecovery: no such record.',
        );
      });

      it.each([
        [
          'an unknown key',
          { query: 'ok', salt: true },
          'Unknown key salt. This tool accepts: query, limit.',
        ],
        ['a missing required field', {}, 'Provide query.'],
        ['a wrong type', { query: 1 }, 'Send query as a string, not a number.'],
      ])('keeps the line for %s', async (_label, args, hint) => {
        const keeper = tool('keeper_tool', {
          description: 'Searches.',
          input: z.object({
            query: z.string().describe('Search query.'),
            limit: z.number().optional().describe('Maximum results.'),
          }),
          output: ok,
          handler: () => ({ ok: true }),
        });

        const result = await reject(keeper, args as Record<string, unknown>);

        expect(rendered(result as CallToolResult)).toContain(`\n\nRecovery: ${hint}\n\n`);
      });

      it('keeps the line for a multi-issue rejection, whose hint joins with spaces', async () => {
        const point = tool('multi_issue_tool', {
          description: 'Takes a coordinate.',
          input: z.object({
            lat: z.number().describe('Latitude.'),
            lon: z.number().describe('Longitude.'),
          }),
          output: ok,
          handler: () => ({ ok: true }),
        });

        const result = await reject(point, { lat: 'x' });

        expect(rendered(result as CallToolResult)).toContain(
          '\n\nRecovery: Send lat as a number, not a string. Provide lon.\n\n',
        );
      });

      it('drops the line for a union-branch rejection, whose hint is the message minus the path', async () => {
        // Same shape as the field-level refinement above: the hint is the
        // branch sentence, the message is that sentence behind `court: `.
        const courts = tool('union_branch_tool', {
          description: 'Blank or a court code.',
          input: z.object({
            court: z
              .union([z.literal(''), z.enum(['CJEU', 'GC'])])
              .optional()
              .describe('Court, or blank for any.'),
          }),
          output: ok,
          handler: () => ({ ok: true }),
        });

        const result = await reject(courts, { court: 'bogus' });

        expect(rendered(result as CallToolResult)).toBe(
          'Error: Input validation error: Invalid arguments for tool union_branch_tool: ' +
            'court: Invalid option: expected one of "CJEU"|"GC"\n\n(reason invalid_arguments)',
        );
        expect(envelope(result).data?.recovery?.hint).toBe(
          'Invalid option: expected one of "CJEU"|"GC"',
        );
      });

      it('keeps the line when a union branch is one of several issues', async () => {
        const courts = tool('union_multi_tool', {
          description: 'A required facet plus an optional court code.',
          input: z.object({
            what: z.enum(['os', 'cpu']).describe('Facet to read.'),
            court: z
              .union([z.literal(''), z.enum(['CJEU', 'GC'])])
              .optional()
              .describe('Court, or blank for any.'),
          }),
          output: ok,
          handler: () => ({ ok: true }),
        });

        const result = await reject(courts, { court: 'bogus' });

        expect(rendered(result as CallToolResult)).toContain(
          '\n\nRecovery: Provide what. Invalid option: expected one of "CJEU"|"GC"\n\n',
        );
      });
    });
  });

  // -----------------------------------------------------------------------
  // Declared error severity (#380)
  // -----------------------------------------------------------------------

  describe('declared error severity (#380)', () => {
    const consentContract = [
      {
        reason: 'consent_declined',
        code: JsonRpcErrorCode.InvalidRequest,
        when: 'The caller declined the confirmation prompt.',
        severity: 'notice',
        recovery: 'Re-run the tool and confirm the prompt to proceed with the change.',
      },
      {
        reason: 'target_missing',
        code: JsonRpcErrorCode.NotFound,
        when: 'The named target does not exist.',
        recovery: 'List the available targets and call again with one of them.',
      },
    ] as const;

    /** Runs a tool whose handler throws `thrown`, optionally under a contract. */
    async function run(
      name: string,
      thrown: unknown,
      errors?: readonly unknown[],
    ): Promise<HandlerResult> {
      const def = tool(name, {
        description: 'Throws a supplied value.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('ok') }),
        ...(errors && { errors: errors as never }),
        handler: () => {
          throw thrown;
        },
      });
      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      return await handler({}, makeServerContext());
    }

    /** The `Error in tool:…` record, whichever level it was emitted at. */
    function failureRecord(): { level: string; message: string } {
      for (const level of ['debug', 'info', 'notice', 'warning', 'error'] as const) {
        const call = vi
          .mocked(mockLogger[level])
          .mock.calls.findLast(([message]) => String(message).startsWith('Error in tool:'));
        if (call) return { level, message: String(call[0]) };
      }
      throw new Error('No tool failure record was emitted');
    }

    it('logs a declared severity at that level, keeping the message', async () => {
      await run(
        'severity_declared',
        new McpError(JsonRpcErrorCode.InvalidRequest, 'The delete of /tmp/x was not confirmed.', {
          reason: 'consent_declined',
        }),
        consentContract,
      );

      expect(failureRecord()).toEqual({
        level: 'notice',
        message: 'Error in tool:severity_declared: The delete of /tmp/x was not confirmed.',
      });
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it.each([
      [
        'a contract entry that declares no severity',
        new McpError(JsonRpcErrorCode.NotFound, 'Boom.', { reason: 'target_missing' }),
        consentContract,
      ],
      [
        'a reason the contract never declared',
        new McpError(JsonRpcErrorCode.NotFound, 'Boom.', { reason: 'undeclared_below_handler' }),
        consentContract,
      ],
      [
        'an McpError carrying no reason at all',
        new McpError(JsonRpcErrorCode.NotFound, 'Boom.'),
        consentContract,
      ],
      ['a non-McpError throw', new Error('Boom.'), consentContract],
      [
        'a tool with no errors[] at all',
        new McpError(JsonRpcErrorCode.InvalidRequest, 'Boom.', { reason: 'consent_declined' }),
        undefined,
      ],
    ])('keeps the error level for %s', async (_label, thrown, errors) => {
      await run('severity_default', thrown, errors);

      expect(failureRecord().level).toBe('error');
    });

    it('leaves both client surfaces byte-identical to the undeclared case', async () => {
      const data = { reason: 'consent_declined', recovery: { hint: 'Confirm the prompt.' } };
      const thrown = new McpError(JsonRpcErrorCode.InvalidRequest, 'Declined.', data);

      const declared = await run('severity_wire_a', thrown, consentContract);
      const undeclared = await run('severity_wire_b', thrown, [
        { ...consentContract[1] },
        { ...consentContract[0], severity: undefined },
      ]);

      expect((declared as CallToolResult).isError).toBe(true);
      expect((declared as CallToolResult).content).toEqual((undeclared as CallToolResult).content);
      expect((declared as CallToolResult).structuredContent).toEqual(
        (undeclared as CallToolResult).structuredContent,
      );
      expect(envelope(declared)).toEqual({
        code: JsonRpcErrorCode.InvalidRequest,
        message: 'Declined.',
        data,
      });
    });

    it('keeps the cancellation path at info whatever the contract declares', async () => {
      // `asRequestCancelled` replaces the thrown value once the signal has
      // fired, so no declared reason survives to resolve a severity against.
      const controller = new AbortController();
      const def = tool('severity_cancelled', {
        description: 'Declines after the caller went away.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('ok') }),
        errors: consentContract as never,
        handler: () => {
          controller.abort();
          throw new McpError(JsonRpcErrorCode.InvalidRequest, 'Declined.', {
            reason: 'consent_declined',
          });
        },
      });
      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);

      await handler({}, makeServerContext({ signal: controller.signal }));

      expect(mockLogger.notice).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(mockLogger.info)
          .mock.calls.some(([message]) => String(message).startsWith('Cancelled tool:')),
      ).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Cancellation precedence (#421)
  // -----------------------------------------------------------------------

  describe('cancellation precedence (#421)', () => {
    /** Drives a handler that throws `thrown`, with `signal` as the request's. */
    async function runThrowing(
      name: string,
      thrown: unknown,
      signal?: AbortSignal,
    ): Promise<HandlerResult> {
      const def = tool(name, {
        description: 'Throws, so the catch path can be observed.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('Never returned.') }),
        handler: () => {
          throw thrown;
        },
      });
      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      return await handler({}, makeServerContext(signal ? { signal } : {}));
    }

    /** The reason a `notifications/cancelled` carrying no `reason` leaves on the signal. */
    const abortException = () => new DOMException('The operation was aborted.', 'AbortError');

    describe('signal not aborted — the existing ladder, unchanged', () => {
      it('classifies a thrown string as InternalError', async () => {
        const result = await runThrowing('live_string_tool', 'probe');

        expect(envelope(result).code).toBe(JsonRpcErrorCode.InternalError);
      });

      it('classifies a plain Error as InternalError', async () => {
        const result = await runThrowing('live_error_tool', new Error('something broke'));

        expect(envelope(result).code).toBe(JsonRpcErrorCode.InternalError);
      });

      it('classifies a DOMException named AbortError as Timeout', async () => {
        const result = await runThrowing('live_abort_tool', abortException());

        expect(envelope(result).code).toBe(JsonRpcErrorCode.Timeout);
      });

      it("keeps an McpError's own code", async () => {
        const result = await runThrowing(
          'live_mcp_error_tool',
          new McpError(JsonRpcErrorCode.NotFound, 'Item not found'),
        );

        expect(envelope(result).code).toBe(JsonRpcErrorCode.NotFound);
      });
    });

    describe('signal aborted — the cancellation outranks the thrown value', () => {
      it('classifies a rethrown cancellation reason string as RequestCancelled', async () => {
        const result = await runThrowing(
          'cancelled_string_tool',
          'probe',
          AbortSignal.abort('probe'),
        );

        expect(envelope(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
      });

      it('classifies a plain Error as RequestCancelled', async () => {
        const result = await runThrowing(
          'cancelled_error_tool',
          new Error('something broke'),
          AbortSignal.abort('probe'),
        );

        expect(envelope(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
      });

      it('classifies a DOMException named AbortError as RequestCancelled, not Timeout', async () => {
        const reason = abortException();
        const result = await runThrowing('cancelled_abort_tool', reason, AbortSignal.abort(reason));

        expect(envelope(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
      });

      it("overrides an explicit McpError's own code", async () => {
        const result = await runThrowing(
          'cancelled_mcp_error_tool',
          new McpError(JsonRpcErrorCode.InternalError, 'Overpass request failed'),
          AbortSignal.abort('probe'),
        );

        expect(envelope(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
      });

      it("classifies the SDK's own abort shape as RequestCancelled", async () => {
        const reason = new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed');
        const result = await runThrowing('cancelled_sdk_tool', reason, AbortSignal.abort(reason));

        expect(envelope(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
      });

      it('keeps the thrown value’s message for triage', async () => {
        const result = await runThrowing(
          'cancelled_message_tool',
          'probe',
          AbortSignal.abort('probe'),
        );

        expect(envelope(result).message).toBe('probe');
      });

      it('logs at info with no stack instead of error', async () => {
        await runThrowing('cancelled_log_tool', new Error('probe'), AbortSignal.abort('probe'));

        expect(mockLogger.error).not.toHaveBeenCalled();
        const logged = mockLogger.info.mock.calls.findLast((call) =>
          String(call[0]).startsWith('Cancelled tool:cancelled_log_tool'),
        );
        expect(logged).toBeDefined();
        const record = logged?.[1] as { extra: Record<string, unknown> };
        expect(record.extra.errorCode).toBe(JsonRpcErrorCode.RequestCancelled);
        expect(record.extra).not.toHaveProperty('stack');
        // The classification chains the original throw as `cause`; no stack of
        // it reaches the record through the cause chain either.
        expect(JSON.stringify(record.extra)).not.toContain('stack');
      });

      it('leaves a handler that completed after the abort a success', async () => {
        const def = tool('cancelled_success_tool', {
          description: 'Returns normally even though the request was cancelled.',
          input: z.object({}),
          output: z.object({ ok: z.boolean().describe('Always true.') }),
          handler: () => ({ ok: true }),
        });
        const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);

        const result = await handler({}, makeServerContext({ signal: AbortSignal.abort('probe') }));

        expect(result.isError).toBeUndefined();
        expect((result as CallToolResult).structuredContent).toEqual({ ok: true });
      });

      it('leaves an input_required signal raised after the abort as control flow', async () => {
        const def = tool('cancelled_input_tool', {
          description: 'Asks for input even though the request was cancelled.',
          input: z.object({}),
          output: z.object({ ok: z.boolean().describe('Never returned.') }),
          handler: (_input, ctx) =>
            ctx.requestInput({
              inputRequests: {
                confirm: inputRequired.elicit({
                  message: 'Confirm?',
                  requestedSchema: z.object({ confirm: z.boolean().describe('confirm') }),
                }),
              },
            }),
        });
        const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);

        const result = await handler({}, makeServerContext({ signal: AbortSignal.abort('probe') }));

        expect(result).toHaveProperty('inputRequests');
        expect(result).not.toHaveProperty('isError');
      });
    });
  });

  // -----------------------------------------------------------------------
  // Context construction
  // -----------------------------------------------------------------------

  describe('Context construction', () => {
    it('should create Context with tenantId defaulted to "default" (no auth)', async () => {
      let capturedCtx: any;

      const def = tool('ctx_tool', {
        description: 'Captures context.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler: (_input, ctx) => {
          capturedCtx = ctx;
          return { ok: true };
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({}, makeServerContext());

      // Without auth, tenantId should be defaulted to 'default' by createContext
      expect(capturedCtx.tenantId).toBe('default');
    });

    it('should wire ctx.signal from SDK context', async () => {
      let capturedSignal: AbortSignal | undefined;
      const controller = new AbortController();

      const def = tool('signal_tool', {
        description: 'Checks signal.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler: (_input, ctx) => {
          capturedSignal = ctx.signal;
          return { ok: true };
        },
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({}, makeServerContext({ signal: controller.signal }));

      expect(capturedSignal).toBe(controller.signal);
    });
  });

  // -----------------------------------------------------------------------
  // Session extraction & durability gate
  // -----------------------------------------------------------------------

  describe('Session extraction', () => {
    /**
     * Builds a tool whose handler captures `ctx.sessionId` for assertion.
     * Returned `getSessionId()` reads it after the handler ran.
     */
    function makeSessionCapturingTool() {
      let captured: string | undefined;
      const def = tool('session_capture_tool', {
        description: 'Captures ctx.sessionId.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler: (_input, ctx) => {
          captured = ctx.sessionId;
          return { ok: true };
        },
      });
      return { def, getSessionId: () => captured };
    }

    it('always forwards sessionId into RequestContext for log correlation', async () => {
      // Even with the strictest gate (stateless + no opt-in), the raw SDK
      // sessionId still flows into the RequestContext for tracing — so logs
      // can correlate against the SDK's per-request token regardless of
      // whether the handler sees it on `ctx.sessionId`.
      mockConfig.mcpSessionMode = 'stateless';
      const { requestContextService } = await import('@/utils/internal/requestContext.js');

      const def = tool('session_log_tool', {
        description: 'Log correlation test.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler: () => ({ ok: true }),
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({}, makeServerContext({ sessionId: 'sess-abc' }));

      expect(requestContextService.createRequestContext).toHaveBeenCalledWith(
        expect.objectContaining({
          parentContext: expect.objectContaining({ sessionId: 'sess-abc' }),
        }),
      );
    });

    it('surfaces ctx.sessionId in stateful HTTP mode', async () => {
      mockConfig.mcpSessionMode = 'stateful';
      const { def, getSessionId } = makeSessionCapturingTool();

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({}, makeServerContext({ sessionId: 'sess-stateful' }));

      expect(getSessionId()).toBe('sess-stateful');
    });

    it('surfaces ctx.sessionId in auto mode (resolves to stateful for HTTP)', async () => {
      mockConfig.mcpSessionMode = 'auto';
      const { def, getSessionId } = makeSessionCapturingTool();

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({}, makeServerContext({ sessionId: 'sess-auto' }));

      expect(getSessionId()).toBe('sess-auto');
    });

    it('hides ctx.sessionId in stateless mode by default (fail-closed)', async () => {
      mockConfig.mcpSessionMode = 'stateless';
      const { def, getSessionId } = makeSessionCapturingTool();

      // Default services — no exposeStatelessSessionId opt-in.
      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({}, makeServerContext({ sessionId: 'sess-stateless' }));

      expect(getSessionId()).toBeUndefined();
    });

    it('surfaces ctx.sessionId in stateless mode when exposeStatelessSessionId is true', async () => {
      mockConfig.mcpSessionMode = 'stateless';
      const optInServices: HandlerServices = {
        ...services,
        exposeStatelessSessionId: true,
      };
      const { def, getSessionId } = makeSessionCapturingTool();

      const handler = createToolHandler(def as AnyToolDefinition, optInServices, notifiers);
      await handler({}, makeServerContext({ sessionId: 'sess-opt-in' }));

      expect(getSessionId()).toBe('sess-opt-in');
    });

    it('leaves ctx.sessionId undefined when SDK provides none, in any mode', async () => {
      const { def, getSessionId } = makeSessionCapturingTool();
      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);

      for (const mode of ['stateful', 'auto', 'stateless'] as const) {
        mockConfig.mcpSessionMode = mode;
        // No sessionId on the SDK extra (e.g. stdio).
        await handler({}, makeServerContext());
        expect(getSessionId()).toBeUndefined();
      }
    });
  });

  describe('log payload redaction', () => {
    it('does not attach raw input to the RequestContext', async () => {
      const { requestContextService } = await import('@/utils/internal/requestContext.js');

      const def = tool('redact_tool', {
        description: 'Input redaction test.',
        input: z.object({ secret: z.string().describe('secret') }),
        output: z.object({ ok: z.boolean() }),
        handler: () => ({ ok: true }),
      });

      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      await handler({ secret: 'super-sensitive-value' }, makeServerContext());

      const call = vi
        .mocked(requestContextService.createRequestContext)
        .mock.calls.find((args) => (args[0] as any)?.additionalContext?.toolName === 'redact_tool');

      expect(call).toBeDefined();
      const additionalContext = (call![0] as any).additionalContext as Record<string, unknown>;
      expect(additionalContext).not.toHaveProperty('input');
      expect(JSON.stringify(additionalContext)).not.toContain('super-sensitive-value');
    });
  });

  // -----------------------------------------------------------------------
  // List-changed notification routing (#135)
  // -----------------------------------------------------------------------

  describe('list-changed notification routing (#135)', () => {
    const notifyingTool = tool('notify_tool', {
      description: 'Fires every list-changed notification.',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handler: (_input, ctx) => {
        ctx.notifyToolListChanged?.();
        ctx.notifyResourceListChanged?.();
        ctx.notifyPromptListChanged?.();
        ctx.notifyResourceUpdated?.('items://42');
        return { ok: true };
      },
    });

    it('routes handler-time notifications through the request-scoped sender (relatedRequestId path)', async () => {
      const notify = vi.fn(async () => {});
      const handler = createToolHandler(notifyingTool as AnyToolDefinition, services, notifiers);
      await handler({}, makeServerContext({ notify }));

      // Routing through ctx.mcpReq.notify is what stamps relatedRequestId, so
      // the message lands on this request's own response stream (#135).
      expect(notify).toHaveBeenCalledWith({ method: 'notifications/tools/list_changed' });
      expect(notify).toHaveBeenCalledWith({ method: 'notifications/resources/list_changed' });
      expect(notify).toHaveBeenCalledWith({ method: 'notifications/prompts/list_changed' });
      expect(notify).toHaveBeenCalledWith({
        method: 'notifications/resources/updated',
        params: { uri: 'items://42' },
      });
    });

    it('falls back to the server-level notifiers when the request scope exposes no sender', async () => {
      const serverNotifiers: NotifierSources = {
        notifyToolListChanged: vi.fn(),
        notifyResourceListChanged: vi.fn(),
        notifyPromptListChanged: vi.fn(),
        notifyResourceUpdated: vi.fn(),
      };
      const handler = createToolHandler(
        notifyingTool as AnyToolDefinition,
        services,
        serverNotifiers,
      );
      await handler({}, makeSenderlessServerContext());

      expect(serverNotifiers.notifyToolListChanged).toHaveBeenCalledOnce();
      expect(serverNotifiers.notifyResourceListChanged).toHaveBeenCalledOnce();
      expect(serverNotifiers.notifyPromptListChanged).toHaveBeenCalledOnce();
      expect(serverNotifiers.notifyResourceUpdated).toHaveBeenCalledWith('items://42');
    });

    it('does not let a failed notification flush reject the handler', async () => {
      const notify = vi.fn(() => Promise.reject(new Error('stream closed')));
      const handler = createToolHandler(notifyingTool as AnyToolDefinition, services, notifiers);

      const result = await handler({}, makeServerContext({ notify }));

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ ok: true });
    });
  });

  // -----------------------------------------------------------------------
  // Subscription-scoped resource updates (#354)
  // -----------------------------------------------------------------------

  describe('notifyResourceUpdated subscription gate (#354)', () => {
    const updatingTool = tool('update_tool', {
      description: 'Announces a resource update.',
      input: z.object({ uri: z.string().describe('uri') }),
      output: z.object({ ok: z.boolean() }),
      handler: (input, ctx) => {
        ctx.notifyResourceUpdated?.(input.uri);
        return { ok: true };
      },
    });

    /** A `resources/subscribe` registry holding exactly the listed URIs. */
    function subscriptionsFor(...uris: string[]) {
      return { has: vi.fn((uri: string) => uris.includes(uri)) };
    }

    it('suppresses the notification for a URI the client never subscribed to', async () => {
      const notify = vi.fn(async () => {});
      const subscriptions = subscriptionsFor('items://subscribed');
      const handler = createToolHandler(updatingTool as AnyToolDefinition, services, {
        subscriptions,
      });

      await handler({ uri: 'items://other' }, makeServerContext({ notify }));

      expect(subscriptions.has).toHaveBeenCalledWith('items://other');
      expect(notify).not.toHaveBeenCalled();
    });

    it('emits the notification for a subscribed URI', async () => {
      const notify = vi.fn(async () => {});
      const handler = createToolHandler(updatingTool as AnyToolDefinition, services, {
        subscriptions: subscriptionsFor('items://subscribed'),
      });

      await handler({ uri: 'items://subscribed' }, makeServerContext({ notify }));

      expect(notify).toHaveBeenCalledWith({
        method: 'notifications/resources/updated',
        params: { uri: 'items://subscribed' },
      });
    });

    it('emits every URI when no subscription registry is available', async () => {
      // No `subscriptions` means no per-connection tracking to consult — the
      // gate is skipped rather than defaulting to "nothing is subscribed".
      const notify = vi.fn(async () => {});
      const handler = createToolHandler(updatingTool as AnyToolDefinition, services, notifiers);

      await handler({ uri: 'items://untracked' }, makeServerContext({ notify }));

      expect(notify).toHaveBeenCalledWith({
        method: 'notifications/resources/updated',
        params: { uri: 'items://untracked' },
      });
    });
  });

  // -----------------------------------------------------------------------
  // Multi-round-trip input (ctx.requestInput / ctx.inputs)
  // -----------------------------------------------------------------------

  describe('ctx.requestInput', () => {
    const confirmSchema = z.object({ confirm: z.boolean().describe('confirm') });

    /** Asks for confirmation on the first round; echoes it back on the retry. */
    const confirmingTool = tool('confirming_tool', {
      description: 'Requests confirmation before acting.',
      input: z.object({ path: z.string().describe('path') }),
      output: z.object({ confirmed: z.boolean().describe('confirmed') }),
      handler: (input, ctx) => {
        const accepted = ctx.inputs.accepted('confirm', confirmSchema);
        if (!accepted) {
          ctx.requestInput({
            inputRequests: {
              confirm: inputRequired.elicit({
                message: `Delete ${input.path}?`,
                requestedSchema: confirmSchema,
              }),
            },
            requestState: 'round-1',
          });
        }
        // `requestInput` never returns — past the guard the value is present.
        return { confirmed: (accepted as { confirm: boolean }).confirm };
      },
    });

    it('returns the SDK input_required result rather than an isError envelope', async () => {
      const handleError = vi.spyOn(ErrorHandler, 'handleError');
      const handler = createToolHandler(confirmingTool as AnyToolDefinition, services, notifiers);

      const result = (await handler({ path: '/tmp/x' }, makeServerContext())) as Record<
        string,
        any
      >;

      // Protocol control flow, not a failure: no isError, no error envelope,
      // and the classifier/telemetry path is never entered.
      expect(result.resultType).toBe('input_required');
      expect(result.requestState).toBe('round-1');
      expect(result.inputRequests.confirm.method).toBe('elicitation/create');
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toBeUndefined();
      expect(handleError).not.toHaveBeenCalled();
      handleError.mockRestore();
    });

    it('completes normally once the retry carries the accepted response', async () => {
      const handler = createToolHandler(confirmingTool as AnyToolDefinition, services, notifiers);

      const result = await handler(
        { path: '/tmp/x' },
        makeServerContext({
          inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
          requestState: 'round-1',
        }),
      );

      expect(result.structuredContent).toEqual({ confirmed: true });
      expect(result.isError).toBeUndefined();
    });

    // ---------------------------------------------------------------------
    // Client-capability gate (#379)
    // ---------------------------------------------------------------------

    describe('client-capability gate (#379)', () => {
      /** Drives `confirmingTool` behind a gate over the given declared capabilities. */
      async function gated(declared: ClientCapabilities | undefined): Promise<HandlerResult> {
        const handler = createToolHandler(
          confirmingTool as AnyToolDefinition,
          services,
          notifiers,
          createInputRequiredGate(() => declared),
        );
        return await handler({ path: '/tmp/x' }, makeServerContext());
      }

      it('shapes the refusal as a tool error carrying the reserved reason', async () => {
        const result = await gated({});

        expect((result as CallToolResult).isError).toBe(true);
        expect(envelope(result).code).toBe(JsonRpcErrorCode.InvalidRequest);
        expect(envelope(result).data?.reason).toBe('client_capability_missing');
        expect(envelope(result).data?.recovery?.hint).toContain('`elicitation.form`');
        expect((firstBlock(result) as { text: string }).text).toBe(
          `Error: ${envelope(result).message}\n\nRecovery: ${envelope(result).data?.recovery?.hint}` +
            '\n\n(reason client_capability_missing)',
        );
      });

      it('distinguishes the per-request case with no capability view at all', async () => {
        const result = await gated(undefined);

        expect(envelope(result).code).toBe(JsonRpcErrorCode.InvalidRequest);
        expect(envelope(result).data?.reason).toBe('client_capability_missing');
        expect(envelope(result).message).toContain('served per-request');
        expect(envelope(result).data?.recovery?.hint).toContain('stateful session');
      });

      it.each([
        ['a declared form mode', { elicitation: { form: {} } }],
        ['a bare pre-mode declaration', { elicitation: {} }],
      ])('lets the signal through for %s', async (_label, declared) => {
        const result = await gated(declared as ClientCapabilities);

        expect(result as Record<string, unknown>).toMatchObject({
          resultType: 'input_required',
          requestState: 'round-1',
        });
      });

      it('refuses a form-mode request when only url mode is declared', async () => {
        const result = await gated({ elicitation: { url: {} } } as ClientCapabilities);

        expect(envelope(result).data?.reason).toBe('client_capability_missing');
        expect(envelope(result).message).toContain('`elicitation.form`');
      });

      it.each([
        [
          'a sampling request',
          { ask: inputRequired.createMessage({ maxTokens: 8, messages: [] }) },
          '`sampling`',
        ],
        ['a roots request', { ask: inputRequired.listRoots() }, '`roots`'],
      ])('gates %s on its own capability', async (_label, inputRequests, path) => {
        const def = tool('kind_probe', {
          description: 'Asks for a non-elicitation input.',
          input: z.object({}),
          output: z.object({ ok: z.boolean().describe('ok') }),
          handler: (_input, ctx) => ctx.requestInput({ inputRequests }),
        });
        const handler = createToolHandler(
          def as AnyToolDefinition,
          services,
          notifiers,
          createInputRequiredGate(() => ({ elicitation: { form: {} } }) as ClientCapabilities),
        );

        const result = await handler({}, makeServerContext());

        expect(envelope(result).data?.reason).toBe('client_capability_missing');
        expect(envelope(result).message).toContain(path);
      });

      it('leaves a requestState-only return untouched', async () => {
        const def = tool('state_only_tool', {
          description: 'Carries state without asking for anything.',
          input: z.object({}),
          output: z.object({ ok: z.boolean().describe('ok') }),
          handler: (_input, ctx) => ctx.requestInput({ requestState: 'round-1' }),
        });
        const handler = createToolHandler(
          def as AnyToolDefinition,
          services,
          notifiers,
          createInputRequiredGate(() => undefined),
        );

        const result = await handler({}, makeServerContext());

        expect(result as Record<string, unknown>).toMatchObject({
          resultType: 'input_required',
          requestState: 'round-1',
        });
      });

      it('gates round two of a multi-round handler on its own capability', async () => {
        const def = tool('two_round_tool', {
          description: 'Elicits first, then samples.',
          input: z.object({}),
          output: z.object({ ok: z.boolean().describe('ok') }),
          handler: (_input, ctx) =>
            ctx.inputs.accepted('confirm', confirmSchema)
              ? ctx.requestInput({
                  inputRequests: {
                    summary: inputRequired.createMessage({ maxTokens: 8, messages: [] }),
                  },
                })
              : ctx.requestInput({
                  inputRequests: {
                    confirm: inputRequired.elicit({
                      message: 'Go ahead?',
                      requestedSchema: confirmSchema,
                    }),
                  },
                }),
        });
        const handler = createToolHandler(
          def as AnyToolDefinition,
          services,
          notifiers,
          createInputRequiredGate(() => ({ elicitation: { form: {} } }) as ClientCapabilities),
        );

        // Round one is servable and passes through untouched.
        const first = await handler({}, makeServerContext());
        expect(first as Record<string, unknown>).toMatchObject({ resultType: 'input_required' });

        // Round two asks for a capability the client never declared.
        const second = await handler(
          {},
          makeServerContext({
            inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
          }),
        );

        expect(envelope(second).data?.reason).toBe('client_capability_missing');
        expect(envelope(second).message).toContain('`sampling`');
      });
    });
  });

  describe('ctx.inputs', () => {
    const confirmSchema = z.object({ confirm: z.boolean().describe('confirm') });

    /** Runs a probe handler against a request scope and returns what it read. */
    async function readInputs(
      overrides: Parameters<typeof makeServerContext>[0],
      read: (ctx: any) => unknown,
    ): Promise<unknown> {
      let captured: unknown;
      const def = tool('inputs_probe', {
        description: 'Reads ctx.inputs.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler: (_input, ctx) => {
          captured = read(ctx);
          return { ok: true };
        },
      });
      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, makeServerContext(overrides));
      expect(result.isError).toBeUndefined();
      return captured;
    }

    it('returns the validated content of an accepted response', async () => {
      const accepted = await readInputs(
        { inputResponses: { confirm: { action: 'accept', content: { confirm: true } } } },
        (ctx) => ctx.inputs.accepted('confirm', confirmSchema),
      );

      expect(accepted).toEqual({ confirm: true });
    });

    it.each([
      ['declined', { confirm: { action: 'decline' } }],
      ['cancelled', { confirm: { action: 'cancel' } }],
      ['missing', { other: { action: 'accept', content: { confirm: true } } }],
      ['schema-invalid', { confirm: { action: 'accept', content: { confirm: 'yes' } } }],
    ])('returns undefined for a %s entry', async (_kind, inputResponses) => {
      // Every `undefined` reads the same to a handler: re-issue, or give up.
      const accepted = await readInputs({ inputResponses }, (ctx) =>
        ctx.inputs.accepted('confirm', confirmSchema),
      );

      expect(accepted).toBeUndefined();
    });

    it('returns undefined when the request carried no responses at all', async () => {
      const accepted = await readInputs({}, (ctx) => ctx.inputs.accepted('confirm', confirmSchema));

      expect(accepted).toBeUndefined();
    });

    it.each([
      [
        'elicit',
        { confirm: { action: 'accept', content: { confirm: true } } },
        { kind: 'elicit', action: 'accept', content: { confirm: true } },
      ],
      [
        'sampling',
        { confirm: { role: 'assistant', content: { type: 'text', text: 'hi' }, model: 'test' } },
        {
          kind: 'sampling',
          result: { role: 'assistant', content: { type: 'text', text: 'hi' }, model: 'test' },
        },
      ],
      [
        'roots',
        { confirm: { roots: [{ uri: 'file:///work' }] } },
        { kind: 'roots', roots: [{ uri: 'file:///work' }] },
      ],
    ])('discriminates a %s response via view()', async (_kind, inputResponses, expected) => {
      const view = await readInputs({ inputResponses }, (ctx) => ctx.inputs.view('confirm'));

      expect(view).toEqual(expected);
    });

    it('reads a missing key as { kind: "missing" }', async () => {
      const view = await readInputs({}, (ctx) => ctx.inputs.view('confirm'));

      expect(view).toEqual({ kind: 'missing' });
    });

    it('surfaces the SDK-dropped keys and the round-trip request state', async () => {
      const seen = await readInputs(
        { droppedInputResponseKeys: ['confirm'], requestState: 'round-2' },
        (ctx) => ({ dropped: [...ctx.inputs.dropped], state: ctx.inputs.state() }),
      );

      expect(seen).toEqual({ dropped: ['confirm'], state: 'round-2' });
    });
  });

  // -----------------------------------------------------------------------
  // ctx.log → notifications/message mirroring
  // -----------------------------------------------------------------------

  describe('ctx.log wire mirroring', () => {
    /** Runs a tool whose handler logs once against the supplied wire sink. */
    async function logOnce(emit: (ctx: any) => void, log = makeWireLog()) {
      const def = tool('logging_tool', {
        description: 'Logs from the handler.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler: (_input, ctx) => {
          emit(ctx);
          return { ok: true };
        },
      });
      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);
      const result = await handler({}, makeServerContext({ log }));
      return { log, result };
    }

    it.each([
      ['debug', (ctx: any) => ctx.log.debug('msg', { k: 1 })],
      ['info', (ctx: any) => ctx.log.info('msg', { k: 1 })],
      ['notice', (ctx: any) => ctx.log.notice('msg', { k: 1 })],
      ['warning', (ctx: any) => ctx.log.warning('msg', { k: 1 })],
      ['error', (ctx: any) => ctx.log.error('msg', undefined, { k: 1 })],
    ])('mirrors ctx.log.%s onto ctx.mcpReq.log at the RFC 5424 level', async (level, emit) => {
      const { log } = await logOnce(emit);

      expect(log).toHaveBeenCalledWith(level, { message: 'msg', k: 1 });
    });

    it('carries the Error message alongside the data on the error level', async () => {
      const { log } = await logOnce((ctx) => ctx.log.error('failed', new Error('boom'), { k: 1 }));

      expect(log).toHaveBeenCalledWith('error', { message: 'failed', k: 1, error: 'boom' });
    });

    it('sends the message alone when the call carried no data payload', async () => {
      const { log } = await logOnce((ctx) => ctx.log.info('bare'));

      expect(log).toHaveBeenCalledWith('info', { message: 'bare' });
    });

    it('still writes to the process logger', async () => {
      await logOnce((ctx) => ctx.log.info('msg', { k: 1 }));

      expect(mockLogger.info).toHaveBeenCalledWith(
        'msg',
        expect.objectContaining({ extra: expect.objectContaining({ k: 1 }) }),
      );
    });

    it('does not fail the handler when the wire log rejects', async () => {
      // A log that cannot flush (client gone, stream never upgraded) must never
      // turn a successful tool call into an error.
      const rejecting = makeWireLog(async () => {
        throw new Error('stream closed');
      });
      const { result } = await logOnce((ctx) => ctx.log.warning('degraded'), rejecting);

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ ok: true });
    });
  });

  // -----------------------------------------------------------------------
  // Advertised vs. effective output schema (#241)
  // -----------------------------------------------------------------------

  describe('advertisedOutputSchema (#241)', () => {
    const searchTool = tool('advertised_search', {
      description: 'Search with a declared error contract.',
      input: z.object({ q: z.string().describe('q') }),
      output: z.object({
        items: z.array(z.string()).describe('matches'),
        cursor: z.string().optional().describe('next page cursor'),
      }),
      enrichment: { totalCount: z.number().describe('total before limit') },
      errors: [
        {
          reason: 'no_match',
          code: JsonRpcErrorCode.NotFound,
          when: 'No items match the query',
          recovery: 'Broaden the query and try again.',
        },
        {
          reason: 'rate_limited',
          code: JsonRpcErrorCode.RateLimited,
          when: 'Upstream rate limit hit',
          retryable: true,
          recovery: 'Wait a few seconds before retrying.',
        },
      ],
      handler: (_input, ctx) => {
        ctx.enrich.total(0);
        return { items: [] };
      },
    });

    const plainTool = tool('advertised_plain', {
      description: 'Search with no declared error contract.',
      input: z.object({ q: z.string().describe('q') }),
      output: z.object({ items: z.array(z.string()).describe('matches') }),
      handler: () => ({ items: [] }),
    });

    /** The JSON Schema a client actually receives in `tools/list`. */
    function emitted(def: AnyToolDefinition): Record<string, any> {
      return z.toJSONSchema(advertisedOutputSchema(def)) as Record<string, any>;
    }

    it('keeps the root an object rather than an anyOf-only union', () => {
      // A discriminated union emits `anyOf` with no `type`, which SEP-2106's
      // legacy projection rewrites to `{ result: … }` — breaking the success
      // path for 2025-era clients to fix the error path.
      const schema = emitted(searchTool as AnyToolDefinition);

      expect(schema.type).toBe('object');
      expect(schema.oneOf).toBeUndefined();
    });

    it('makes every success field optional so an error envelope can never be missing one', () => {
      const schema = emitted(searchTool as AnyToolDefinition);

      expect(schema.required).toBeUndefined();
      expect(Object.keys(schema.properties).sort()).toEqual([
        'cursor',
        'error',
        'items',
        'totalCount',
      ]);
    });

    it('declares the error envelope with code, message, and a loose optional data', () => {
      const error = emitted(searchTool as AnyToolDefinition).properties.error;

      expect(error.type).toBe('object');
      expect(error.required).toEqual(['code', 'message']);
      expect(error.properties.data.type).toBe('object');
      // Loose at every level — a throw site's arbitrary keys must not recreate
      // on the error path the very -32602 this envelope exists to prevent.
      expect(error.additionalProperties).toEqual({});
      expect(error.properties.data.additionalProperties).toEqual({});
      expect(error.required).not.toContain('data');
    });

    it("documents the definition's declared reasons without constraining data.reason", () => {
      const reason = emitted(searchTool as AnyToolDefinition).properties.error.properties.data
        .properties.reason;

      // Annotations, not a constraint. An enum would reject every failure a
      // service raises below the handler with its own `data.reason` — the very
      // `-32602` the widened schema exists to prevent.
      expect(reason.enum).toBeUndefined();
      expect(reason.type).toBe('string');
      expect(reason.examples).toEqual(['no_match', 'rate_limited']);
      expect(reason.description).toContain('no_match');
      expect(reason.description).toContain('No items match the query');
    });

    it('validates an envelope whose reason came from below the handler', () => {
      const validate = new AjvJsonSchemaValidator().getValidator(
        emitted(searchTool as AnyToolDefinition),
      );
      // What the SQL gate, the YAML parser, or any other service throws: a
      // `data.reason` the tool's own `errors[]` never declared.
      const envelope = buildToolErrorResult(
        JsonRpcErrorCode.ValidationError,
        'Function not permitted.',
        { reason: 'denied_function' },
      ).structuredContent;

      expect(validate(envelope).valid).toBe(true);
    });

    describe('declared-reason description punctuation (#389)', () => {
      /** The advertised `error.data.reason` description for a contract of these `when` texts. */
      function reasonDescription(...whens: string[]): string {
        const def = tool('reason_punctuation_tool', {
          description: 'Declares a contract whose `when` texts vary in punctuation.',
          input: z.object({ q: z.string().describe('q') }),
          output: z.object({ ok: z.boolean().describe('ok') }),
          errors: whens.map((when, index) => ({
            reason: `reason_${index}`,
            code: JsonRpcErrorCode.NotFound,
            when,
            recovery: 'Correct the identifier and call the tool again.',
          })),
          handler: () => ({ ok: true }),
        });
        return emitted(def as AnyToolDefinition).properties.error.properties.data.properties.reason
          .description;
      }

      const trailer = 'Other values are possible when a failure originates below the handler.';

      it('terminates an unpunctuated `when` before the trailing sentence', () => {
        expect(
          reasonDescription('Single-candidate lookup by candidate_id returned no record'),
        ).toBe(
          'Machine-readable failure mode. Declared by this tool: `reason_0`: ' +
            `Single-candidate lookup by candidate_id returned no record. ${trailer}`,
        );
      });

      it.each(['.', '?', '!'])('adds no second terminator after a trailing `%s`', (mark) => {
        expect(reasonDescription(`The lookup returned no record${mark}`)).toBe(
          'Machine-readable failure mode. Declared by this tool: `reason_0`: ' +
            `The lookup returned no record${mark} ${trailer}`,
        );
      });

      it.each([
        ['a closing backtick', 'No record for the supplied `candidate_id`'],
        ['a closing parenthesis', 'No record matched (for the current tenant)'],
      ])('puts the period after %s', (_label, when) => {
        expect(reasonDescription(when)).toBe(
          `Machine-readable failure mode. Declared by this tool: \`reason_0\`: ${when}. ${trailer}`,
        );
      });

      it('trims trailing whitespace before deciding on a terminator', () => {
        expect(reasonDescription('The lookup returned no record.   ')).toBe(
          'Machine-readable failure mode. Declared by this tool: `reason_0`: ' +
            `The lookup returned no record. ${trailer}`,
        );
      });

      it('terminates every entry of a three-reason contract', () => {
        expect(
          reasonDescription(
            'Called without any scoping filter at all',
            'min_date or max_date given without both a type and a date_kind',
            'The requested date_kind is not a date this document type records',
          ),
        ).toBe(
          'Machine-readable failure mode. Declared by this tool: ' +
            '`reason_0`: Called without any scoping filter at all. ' +
            '`reason_1`: min_date or max_date given without both a type and a date_kind. ' +
            '`reason_2`: The requested date_kind is not a date this document type records. ' +
            trailer,
        );
      });

      it('leaves the bare description in place when nothing is declared', () => {
        const empty = tool('empty_contract_tool', {
          description: 'Declares an empty contract.',
          input: z.object({ q: z.string().describe('q') }),
          output: z.object({ ok: z.boolean().describe('ok') }),
          errors: [],
          handler: () => ({ ok: true }),
        });

        expect(
          emitted(plainTool as AnyToolDefinition).properties.error.properties.data.properties.reason
            .description,
        ).toBe('Machine-readable failure mode.');
        expect(
          emitted(empty as AnyToolDefinition).properties.error.properties.data.properties.reason
            .description,
        ).toBe('Machine-readable failure mode.');
      });

      it('changes nothing else about the advertised envelope', () => {
        const schema = emitted(searchTool as AnyToolDefinition);
        const data = schema.properties.error.properties.data;

        expect(data.properties.reason.type).toBe('string');
        expect(data.properties.reason.examples).toEqual(['no_match', 'rate_limited']);
        expect(data.properties.reason.enum).toBeUndefined();
        expect(schema.properties.error.required).toEqual(['code', 'message']);
        expect(schema.properties.error.additionalProperties).toEqual({});
        expect(schema.anyOf).toEqual([
          { not: { required: ['error'] }, required: ['items', 'totalCount'] },
          { required: ['error'] },
        ]);
      });
    });

    it('leaves data.reason an open string when no contract is declared', () => {
      const reason = emitted(plainTool as AnyToolDefinition).properties.error.properties.data
        .properties.reason;

      expect(reason.type).toBe('string');
      expect(reason.enum).toBeUndefined();
    });

    it('carries the two-branch anyOf refinement that the dropped `required` no longer expresses', () => {
      expect(emitted(searchTool as AnyToolDefinition).anyOf).toEqual([
        { not: { required: ['error'] }, required: ['items', 'totalCount'] },
        { required: ['error'] },
      ]);
      expect(emitted(plainTool as AnyToolDefinition).anyOf).toEqual([
        { not: { required: ['error'] }, required: ['items'] },
        { required: ['error'] },
      ]);
    });

    it('accepts a real error envelope and rejects an empty result', () => {
      const validate = new AjvJsonSchemaValidator().getValidator(
        emitted(searchTool as AnyToolDefinition),
      );
      const envelope = buildToolErrorResult(JsonRpcErrorCode.NotFound, 'No items returned', {
        reason: 'no_match',
        recovery: { hint: 'Broaden the query and try again.' },
        retryable: false,
      }).structuredContent;

      expect(validate(envelope).valid).toBe(true);
      expect(validate({ items: [], totalCount: 0 }).valid).toBe(true);
      // `{}` — a handler that returned nothing — is what the success-only
      // schema never caught either.
      expect(validate({}).valid).toBe(false);
    });

    it.each([
      [
        'refine',
        z
          .object({ a: z.string().describe('a'), b: z.number().describe('b') })
          .refine((v) => v.a.length > 0, 'a must be set'),
      ],
      [
        'superRefine',
        z
          .object({ a: z.string().describe('a'), b: z.number().describe('b') })
          .superRefine(() => {}),
      ],
    ])('widens an output schema carrying a .%s() check', (_label, output) => {
      // `.refine()` / `.superRefine()` return a ZodObject, so `tool()` accepts
      // them — and Zod rejects `.partial()` on one. Widening through `.partial()`
      // therefore threw during registration and took the server down at startup.
      const refinedTool = tool('refined_output_tool', {
        description: 'Declares a refined output schema.',
        input: z.object({ q: z.string().describe('q') }),
        output: output as never,
        handler: () => ({ a: 'x', b: 1 }) as never,
      });

      const emittedSchema = z.toJSONSchema(
        advertisedOutputSchema(refinedTool as AnyToolDefinition),
        { io: 'output' },
      ) as { properties: Record<string, unknown>; required?: string[] };

      expect(Object.keys(emittedSchema.properties).sort()).toEqual(['a', 'b', 'error']);
      expect(emittedSchema.required).toBeUndefined();
    });

    it('leaves effectiveOutputSchema strict — the authoring check is unchanged', async () => {
      const strict = effectiveOutputSchema(searchTool as AnyToolDefinition);

      expect(Object.keys(strict.shape).sort()).toEqual(['cursor', 'items', 'totalCount']);
      expect(strict.safeParse({ items: [], totalCount: 0 }).success).toBe(true);
      // The advertised schema drops `required`; the parse schema does not.
      expect(strict.safeParse({ items: [] }).success).toBe(false);
      expect(strict.safeParse({ error: { code: -32001, message: 'x' } }).success).toBe(false);
    });

    it('still fails the call when a required enrichment field is never populated', async () => {
      const forgetful = tool('forgets_enrichment', {
        description: 'Declares enrichment but never populates it.',
        input: z.object({ q: z.string().describe('q') }),
        output: z.object({ items: z.array(z.string()).describe('items') }),
        enrichment: { totalCount: z.number().describe('required total') },
        handler: () => ({ items: [] }),
      });
      const handler = createToolHandler(forgetful as AnyToolDefinition, services, notifiers);

      const result = await handler({ q: 'x' }, makeServerContext());

      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Measured region coverage (#346)
  // -----------------------------------------------------------------------

  describe('post-handler failures stay inside the measured region (#346)', () => {
    /**
     * Whether the callback handed to `measureToolExecution` rejected. A
     * post-handler failure that settles outside it leaves the callback
     * resolved, so the call is recorded as a success while the client is told
     * it failed.
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

    const brokenOutput = tool('broken_output', {
      description: 'Returns a value that fails its own output contract.',
      input: z.object({}),
      output: z.object({ value: z.number().describe('A number the handler never returns.') }),
      handler: () => ({}) as { value: number },
    });

    const brokenFormat = tool('broken_format', {
      description: 'Returns a valid value whose formatter throws.',
      input: z.object({}),
      output: z.object({ value: z.number().describe('A number.') }),
      handler: () => ({ value: 1 }),
      format: () => {
        throw new Error('formatter blew up');
      },
    });

    const brokenEnrichment = tool('broken_enrichment', {
      description: 'Declares a required enrichment field the handler never populates.',
      input: z.object({}),
      output: z.object({ value: z.number().describe('A number.') }),
      enrichment: { total: z.number().describe('Required enrichment field.') },
      handler: (_input, ctx) => {
        ctx.enrich({ other: 'populates a different key' } as never);
        return { value: 1 };
      },
    });

    const brokenTrailer = tool('broken_trailer', {
      description: 'Declares a trailer renderer that throws.',
      input: z.object({}),
      output: z.object({ value: z.number().describe('A number.') }),
      enrichment: { total: z.number().describe('Populated enrichment field.') },
      enrichmentTrailer: {
        total: {
          render: () => {
            throw new Error('trailer render blew up');
          },
        },
      },
      handler: (_input, ctx) => {
        ctx.enrich({ total: 1 });
        return { value: 1 };
      },
    });

    it.each([
      ['output-schema validation', brokenOutput],
      ['format()', brokenFormat],
      ['the enrichment merge', brokenEnrichment],
      ['a trailer render()', brokenTrailer],
    ])('measures a failure in %s', async (_surface, def) => {
      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);

      const result = await handler({}, makeServerContext());

      expect(result.isError).toBe(true);
      await expect(measuredCallbackRejected()).resolves.toBe(true);
    });

    it('leaves a successful call resolving through the measured region', async () => {
      const def = tool('measured_success', {
        description: 'Succeeds.',
        input: z.object({}),
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: () => ({ ok: true }),
      });
      const handler = createToolHandler(def as AnyToolDefinition, services, notifiers);

      const result = await handler({}, makeServerContext());

      expect(result.structuredContent).toEqual({ ok: true });
      await expect(measuredCallbackRejected()).resolves.toBe(false);
    });
  });
});

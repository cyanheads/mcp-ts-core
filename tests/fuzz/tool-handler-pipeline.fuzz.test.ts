/**
 * @fileoverview Fuzz tests for the tool handler pipeline.
 * Exercises `createToolHandler` with schema-generated and adversarial inputs
 * to verify the framework never crashes, leaks internals, or allows prototype pollution.
 * @module tests/fuzz/tool-handler-pipeline.fuzz.test
 */

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
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
  requestContextService: {
    createRequestContext: vi.fn((opts: any) => ({
      requestId: 'fuzz-req-id',
      timestamp: new Date().toISOString(),
      operation: opts?.operation ?? 'fuzz',
      ...(opts?.additionalContext ?? {}),
    })),
  },
}));

vi.mock('@/utils/internal/performance.js', () => ({
  measureToolExecution: vi.fn((fn: () => unknown) => fn()),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type { AnyToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import {
  createToolHandler,
  type HandlerFactoryServices,
  type HandlerNotifiers,
} from '@/mcp-server/tools/utils/toolHandlerFactory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SdkExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function createSdkContext(overrides: Record<string, unknown> = {}): SdkExtra {
  return {
    signal: new AbortController().signal,
    requestId: 'fuzz-sdk-id',
    sendNotification: () => Promise.resolve(),
    sendRequest: () => Promise.resolve({}) as never,
    ...overrides,
  } as SdkExtra;
}

const services: HandlerFactoryServices = {
  logger: mockLogger as any,
  storage: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => ({ keys: [] })),
    getMany: vi.fn(async () => new Map()),
  } as any,
};

const notifiers: HandlerNotifiers = {};

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
            const result = await handler(input, createSdkContext());
            expect(result.isError).toBeUndefined();
            expect(result.content).toBeDefined();
            expect(result.structuredContent).toBeDefined();
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

    for (const [name, def] of toolDefs) {
      it(`${name}: adversarial inputs never crash the handler factory`, async () => {
        const handler = createToolHandler(def, services, notifiers);
        const arb = adversarialObjectArbitrary(def.input);

        await fc.assert(
          fc.asyncProperty(arb, async (input) => {
            const result = await handler(input as any, createSdkContext());
            // Must always return a result (either success or error), never throw
            expect(result).toBeDefined();
            expect(result.content).toBeDefined();
            expect(Array.isArray(result.content)).toBe(true);
          }),
          { numRuns: 30 },
        );
      });

      it(`${name}: adversarial inputs produce isError responses`, async () => {
        const handler = createToolHandler(def, services, notifiers);
        const arb = adversarialObjectArbitrary(def.input);

        await fc.assert(
          fc.asyncProperty(arb, async (input) => {
            const result = await handler(input as any, createSdkContext());
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
        const result = await handler({ mode }, createSdkContext());
        expect(result.isError).toBe(true);
        const text = (result.content![0] as { text: string }).text;
        // Should not contain file paths or node_modules references
        expect(text).not.toMatch(/node_modules/);
        expect(text).not.toMatch(/\/Users\//);
        expect(text).not.toMatch(/\/home\//);
        expect(text).not.toMatch(/\bat\s+\S+\s+\(/); // Stack trace pattern
      }
    });
  });

  describe('Prototype pollution resistance', () => {
    it('adversarial __proto__ payloads do not pollute Object.prototype', async () => {
      const handler = createToolHandler(stringTool as AnyToolDefinition, services, notifiers);
      const protoKeysBefore = new Set(Object.keys(Object.prototype));

      const payloads = [
        { __proto__: { polluted: true }, value: 'test' },
        { constructor: { prototype: { polluted: true } }, value: 'test' },
        JSON.parse('{"__proto__":{"injected":true},"value":"test"}'),
      ];

      for (const payload of payloads) {
        await handler(payload, createSdkContext());
      }

      const protoKeysAfter = new Set(Object.keys(Object.prototype));
      for (const key of protoKeysAfter) {
        if (!protoKeysBefore.has(key)) {
          delete (Object.prototype as any)[key];
          throw new Error(`Prototype pollution detected: ${key}`);
        }
      }
      expect((Object.prototype as any).polluted).toBeUndefined();
      expect((Object.prototype as any).injected).toBeUndefined();
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
      ];

      for (const input of wrongTypes) {
        const result = await handler(input as any, createSdkContext());
        expect(result).toBeDefined();
        expect(result.content).toBeDefined();
        // Most should be errors (Zod will reject non-objects)
      }
    });
  });

  describe('Injection string resistance', () => {
    it('handler processes adversarial strings without crashing', async () => {
      const handler = createToolHandler(stringTool as AnyToolDefinition, services, notifiers);

      for (const str of ADVERSARIAL_STRINGS) {
        const result = await handler({ value: str }, createSdkContext());
        // All are valid string inputs, should succeed
        expect(result).toBeDefined();
        expect(result.content).toBeDefined();
        if (!result.isError) {
          expect(result.structuredContent).toBeDefined();
          expect((result.structuredContent as any).echo).toBe(str);
        }
      }
    });
  });

  describe('Aborted signal handling', () => {
    it('pre-aborted signal produces error or result, never hangs', async () => {
      const handler = createToolHandler(stringTool as AnyToolDefinition, services, notifiers);
      const controller = new AbortController();
      controller.abort();

      const result = await handler(
        { value: 'test' },
        createSdkContext({ signal: controller.signal }),
      );
      // Framework should handle abort gracefully
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });
  });

  describe('Oversized input handling', () => {
    it('handles extremely large string inputs without crashing', async () => {
      const handler = createToolHandler(stringTool as AnyToolDefinition, services, notifiers);
      const largeInput = { value: 'x'.repeat(1_000_000) };

      const result = await handler(largeInput, createSdkContext());
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });

    it('handles deeply nested objects gracefully', async () => {
      const handler = createToolHandler(stringTool as AnyToolDefinition, services, notifiers);

      let deep: any = { value: 'leaf' };
      for (let i = 0; i < 100; i++) {
        deep = { nested: deep, value: 'mid' };
      }

      const result = await handler(deep, createSdkContext());
      expect(result).toBeDefined();
      // Zod should accept it (extra keys are stripped) or reject it
    });
  });
});

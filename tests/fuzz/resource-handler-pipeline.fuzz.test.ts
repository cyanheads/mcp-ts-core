/**
 * @fileoverview Property-based coverage for the production resource-handler pipeline.
 * @module tests/fuzz/resource-handler-pipeline.fuzz.test
 */

import type { ReadResourceResult } from '@modelcontextprotocol/server';
import fc from 'fast-check';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AnyResourceDefinition } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
import {
  createResourceHandler,
  type ResourceHandlerFactoryServices,
} from '@/mcp-server/resources/utils/resourceHandlerFactory.js';
import { adversarialObjectArbitrary, loadFc, zodToArbitrary } from '@/testing/fuzz.js';
import { McpError } from '@/types-global/errors.js';
import { measureResourceExecution } from '@/utils/internal/performance.js';
import { makeServerContext } from '../helpers/server-context.js';

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
    mcpSessionMode: 'auto',
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
    createRequestContext: vi.fn((options: { additionalContext?: Record<string, unknown> }) => ({
      requestId: 'resource-fuzz-request',
      timestamp: new Date().toISOString(),
      ...(options.additionalContext ?? {}),
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
  measureResourceExecution: vi.fn(
    (
      fn: (spanContext: unknown, recordOutput: (payload: unknown) => void) => unknown,
      context: unknown,
    ) => fn(context, () => {}),
  ),
}));

function serverContext() {
  return makeServerContext({ requestId: 'resource-fuzz-sdk', method: 'resources/read' });
}

const services: ResourceHandlerFactoryServices = {
  logger: mockLogger as never,
  storage: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => ({ keys: [] })),
    getMany: vi.fn(async () => new Map()),
  } as never,
};

const paramsSchema = z.object({
  id: z.string().min(1).max(80).describe('Item ID'),
  revision: z
    .string()
    .regex(/^\d{1,4}$/)
    .describe('Revision'),
});

const definition = resource('fuzz://{id}', {
  description: 'Resource definition for pipeline fuzzing.',
  params: paramsSchema,
  output: z.object({
    id: z.string().describe('Item ID'),
    revision: z.string().describe('Revision'),
  }),
  handler: (params) => params,
});

describe('resource handler pipeline fuzzing', () => {
  beforeAll(() => loadFc());

  it('returns schema-valid content for generated resource variables', async () => {
    const handler = createResourceHandler(definition as AnyResourceDefinition, services, {});
    const arbitrary = zodToArbitrary(paramsSchema) as fc.Arbitrary<z.infer<typeof paramsSchema>>;

    await fc.assert(
      fc.asyncProperty(arbitrary, async (raw) => {
        const parsed = paramsSchema.safeParse(raw);
        if (!parsed.success) return;
        const result = (await handler(
          new URL(`fuzz://${encodeURIComponent(parsed.data.id)}`),
          parsed.data,
          serverContext(),
        )) as ReadResourceResult;
        const content = result.contents[0] as { text: string };
        expect(JSON.parse(content.text)).toEqual(parsed.data);
      }),
      { numRuns: 75, seed: 20_260_802 },
    );
  });

  it('normalizes adversarial variables to McpError instead of leaking raw failures', async () => {
    const handler = createResourceHandler(definition as AnyResourceDefinition, services, {});
    const arbitrary = adversarialObjectArbitrary(paramsSchema);

    await fc.assert(
      fc.asyncProperty(arbitrary, async (variables) => {
        try {
          await handler(new URL('fuzz://adversarial'), variables as never, serverContext());
        } catch (error) {
          expect(error).toBeInstanceOf(McpError);
          expect((error as McpError).message).not.toMatch(/node_modules|\/Users\/|\/home\//);
        }
      }),
      { numRuns: 60, seed: 20_260_803 },
    );
  });

  it('keeps post-handler failures inside the measured region (#346)', async () => {
    /**
     * Whether the callback handed to `measureResourceExecution` rejected. A
     * post-handler failure that settles outside it is recorded as a successful
     * read while the client is handed an error.
     */
    async function measuredCallbackRejected(): Promise<boolean> {
      const last = vi.mocked(measureResourceExecution).mock.results.at(-1);
      if (!last) throw new Error('measureResourceExecution was never called');
      if (last.type === 'throw') return true;
      return await Promise.resolve(last.value).then(
        () => false,
        () => true,
      );
    }

    const brokenOutput = resource('fuzz://broken-output/{id}', {
      description: 'Violates its declared output schema.',
      params: z.object({ id: z.string().describe('Item ID') }),
      output: z.object({ count: z.number().describe('A number the handler never returns') }),
      handler: () => ({}) as { count: number },
    });

    const brokenFormat = resource('fuzz://broken-format/{id}', {
      description: 'Formatter throws.',
      params: z.object({ id: z.string().describe('Item ID') }),
      handler: (params) => params,
      format: () => {
        throw new Error('formatter blew up');
      },
    });

    for (const def of [brokenOutput, brokenFormat]) {
      const handler = createResourceHandler(def as AnyResourceDefinition, services, {});

      await fc.assert(
        fc.asyncProperty(fc.string({ minLength: 1, maxLength: 40 }), async (id) => {
          await expect(
            handler(new URL('fuzz://broken/item'), { id }, serverContext()),
          ).rejects.toBeInstanceOf(McpError);
          expect(await measuredCallbackRejected()).toBe(true);
        }),
        { numRuns: 25, seed: 20_260_805 },
      );
    }
  });

  it('classifies arbitrary handler errors without exposing stack traces', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (message) => {
        const failing = resource('fuzz://failure', {
          description: 'Throws an upstream-style error.',
          handler: () => {
            throw new Error(message);
          },
        });
        const handler = createResourceHandler(failing as AnyResourceDefinition, services, {});

        await expect(handler(new URL('fuzz://failure'), {}, serverContext())).rejects.toSatisfy(
          (error: unknown) =>
            error instanceof McpError && !/node_modules|\/Users\/|\/home\//.test(error.message),
        );
      }),
      { numRuns: 75, seed: 20_260_804 },
    );
  });
});

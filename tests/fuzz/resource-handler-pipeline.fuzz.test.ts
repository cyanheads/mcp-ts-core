/**
 * @fileoverview Property-based coverage for the production resource-handler pipeline.
 * @module tests/fuzz/resource-handler-pipeline.fuzz.test
 */

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
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
  requestContextService: {
    createRequestContext: vi.fn((options: { additionalContext?: Record<string, unknown> }) => ({
      requestId: 'resource-fuzz-request',
      timestamp: new Date().toISOString(),
      ...(options.additionalContext ?? {}),
    })),
  },
}));

vi.mock('@/utils/internal/performance.js', () => ({
  measureResourceExecution: vi.fn((fn: () => unknown) => fn()),
}));

type SdkExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function sdkExtra(): SdkExtra {
  return {
    signal: new AbortController().signal,
    requestId: 'resource-fuzz-sdk',
    sendNotification: () => Promise.resolve(),
    sendRequest: () => Promise.resolve({}) as never,
  } as SdkExtra;
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
        const result = await handler(
          new URL(`fuzz://${encodeURIComponent(parsed.data.id)}`),
          parsed.data,
          sdkExtra(),
        );
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
          await handler(new URL('fuzz://adversarial'), variables as never, sdkExtra());
        } catch (error) {
          expect(error).toBeInstanceOf(McpError);
          expect((error as McpError).message).not.toMatch(/node_modules|\/Users\/|\/home\//);
        }
      }),
      { numRuns: 60, seed: 20_260_803 },
    );
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

        await expect(handler(new URL('fuzz://failure'), {}, sdkExtra())).rejects.toSatisfy(
          (error: unknown) =>
            error instanceof McpError && !/node_modules|\/Users\/|\/home\//.test(error.message),
        );
      }),
      { numRuns: 75, seed: 20_260_804 },
    );
  });
});

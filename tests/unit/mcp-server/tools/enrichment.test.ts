/**
 * @fileoverview Tests for the `enrichment` block end-to-end: `tool()` infers the
 * field types into `ctx.enrich`, the handler factory merges enrichment into
 * `structuredContent`, mirrors it into a `content[]` trailer (Resolution B —
 * domain payload rendered once, trailer always appended), and the field-helpers
 * kind-tag the trailer. Also covers service-layer enrich, the required-field
 * parse guard, the no-block no-op, and the `createMockContext`/`getEnrichment`
 * test surface.
 * @module tests/unit/mcp-server/tools/enrichment.test
 */

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Module mocks — mirror toolHandlerFactory.test.ts so createToolHandler runs
// against the real createContext (enrichment wiring) with stubbed I/O.
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

vi.mock('@/config/index.js', () => ({ config: mockConfig }));

vi.mock('@/utils/internal/logger.js', () => ({
  logger: mockLogger,
  Logger: { getInstance: () => mockLogger },
}));

vi.mock('@/utils/internal/requestContext.js', () => ({
  requestContextService: {
    createRequestContext: vi.fn((opts: any) => ({
      requestId: 'test-req-id',
      timestamp: new Date().toISOString(),
      operation: opts?.operation ?? 'test',
      ...(opts?.additionalContext ?? {}),
    })),
  },
}));

// Pass the success-attributes thunk through so the factory's enrichment-detection
// closure still runs, but otherwise just execute the handler logic.
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
  effectiveOutputSchema,
  type HandlerFactoryServices,
  type HandlerNotifiers,
} from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { createMockContext, getEnrichment } from '@/testing/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockSdkContext = RequestHandlerExtra<ServerRequest, ServerNotification>;

function createMockSdkContext(overrides: Record<string, unknown> = {}): MockSdkContext {
  return {
    signal: new AbortController().signal,
    requestId: 'sdk-request-id',
    sendNotification: () => Promise.resolve(),
    sendRequest: () => Promise.resolve({}) as never,
    ...overrides,
  } as MockSdkContext;
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

/** Trailing content[] block text (the enrichment trailer, when present). */
function lastText(content: unknown): string {
  const blocks = content as Array<{ text?: string }>;
  return blocks.at(-1)?.text ?? '';
}

function allText(content: unknown): string[] {
  return (content as Array<{ text?: string }>).map((b) => b.text ?? '');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichment block', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.mcpSessionMode = 'auto';
  });

  describe('type inference', () => {
    it('types ctx.enrich against the declared fields; loose when no block', () => {
      tool('typed_enrich', {
        description: 'demo',
        input: z.object({ q: z.string().describe('q') }),
        output: z.object({ items: z.array(z.string()).describe('items') }),
        enrichment: {
          totalCount: z.number().describe('total'),
          notice: z.string().optional().describe('notice'),
        },
        handler: (_input, ctx) => {
          ctx.enrich({ totalCount: 1 });
          ctx.enrich({ notice: 'ok' });
          // @ts-expect-error — totalCount must be a number
          ctx.enrich({ totalCount: 'nope' });
          // Field-helpers are always available.
          ctx.enrich.total(2);
          return { items: [] };
        },
      });

      tool('no_enrich', {
        description: 'demo',
        input: z.object({ q: z.string().describe('q') }),
        output: z.object({ items: z.array(z.string()).describe('items') }),
        handler: (_input, ctx) => {
          // Loose enrich on base Context — accepts any record (service-callable).
          expectTypeOf(ctx.enrich).toBeFunction();
          ctx.enrich({ anything: 1 });
          return { items: [] };
        },
      });
    });
  });

  describe('structuredContent merge + content[] trailer', () => {
    it('merges enrichment into structuredContent and appends a trailer (no format)', async () => {
      const search = tool('search', {
        description: 'Search.',
        input: z.object({ q: z.string().describe('q') }),
        output: z.object({ items: z.array(z.string()).describe('items') }),
        enrichment: {
          effectiveQuery: z.string().describe('parsed query'),
          totalCount: z.number().describe('total before limit'),
          notice: z.string().optional().describe('empty-result notice'),
        },
        handler: (input, ctx) => {
          ctx.enrich({ effectiveQuery: input.q.trim(), totalCount: 0 });
          ctx.enrich({ notice: `No matches for "${input.q.trim()}".` });
          return { items: [] };
        },
      });

      const handler = createToolHandler(search as AnyToolDefinition, services, notifiers);
      const result = await handler({ q: '  widget ' }, createMockSdkContext());

      expect(result.isError).toBeUndefined();
      // Enrichment merged into structuredContent (accumulates across enrich calls).
      expect(result.structuredContent).toEqual({
        items: [],
        effectiveQuery: 'widget',
        totalCount: 0,
        notice: 'No matches for "widget".',
      });
      // content[] = domain JSON block + enrichment trailer block.
      expect(result.content!.length).toBe(2);
      const domain = (result.content![0] as { text: string }).text;
      expect(JSON.parse(domain)).toEqual({ items: [] }); // domain payload only — no enrichment in the JSON
      const trailer = lastText(result.content);
      expect(trailer).toContain('effectiveQuery');
      expect(trailer).toContain('No matches for "widget".');
    });

    it('field-helpers kind-tag the trailer (notice → blockquote, total → "N total", echo → "Query: …")', async () => {
      const search = tool('search_helpers', {
        description: 'Search.',
        input: z.object({ q: z.string().describe('q') }),
        output: z.object({ items: z.array(z.string()).describe('items') }),
        enrichment: {
          effectiveQuery: z.string().describe('parsed query'),
          totalCount: z.number().describe('total'),
          notice: z.string().optional().describe('notice'),
        },
        handler: (_input, ctx) => {
          ctx.enrich.echo('parsed terms');
          ctx.enrich.total(42);
          ctx.enrich.notice('No matches — try broader terms.');
          return { items: [] };
        },
      });

      const handler = createToolHandler(search as AnyToolDefinition, services, notifiers);
      const result = await handler({ q: 'x' }, createMockSdkContext());

      const trailer = lastText(result.content);
      expect(trailer).toContain('Query: parsed terms');
      expect(trailer).toContain('42 total');
      expect(trailer).toContain('> No matches — try broader terms.');
      // Helpers write the conventional keys into structuredContent.
      expect(result.structuredContent).toMatchObject({
        effectiveQuery: 'parsed terms',
        totalCount: 42,
        notice: 'No matches — try broader terms.',
      });
    });

    it('renders the domain payload once via format() and still appends the trailer (no double-render)', async () => {
      const search = tool('search_fmt', {
        description: 'Search.',
        input: z.object({ q: z.string().describe('q') }),
        output: z.object({ items: z.array(z.string()).describe('items') }),
        enrichment: { totalCount: z.number().describe('total') },
        handler: (_input, ctx) => {
          ctx.enrich.total(7);
          return { items: ['a', 'b'] };
        },
        format: (r) => [{ type: 'text', text: `Items: ${r.items.join(', ')}` }],
      });

      const handler = createToolHandler(search as AnyToolDefinition, services, notifiers);
      const result = await handler({ q: 'x' }, createMockSdkContext());

      const texts = allText(result.content);
      // format() rendered the domain payload exactly once — and without enrichment in it.
      expect(texts[0]).toBe('Items: a, b');
      expect(texts.filter((t) => t.includes('Items: a, b'))).toHaveLength(1);
      // Trailer appended after the domain content.
      expect(texts.some((t) => t.includes('7 total'))).toBe(true);
      // structuredContent carries the merge.
      expect(result.structuredContent).toEqual({ items: ['a', 'b'], totalCount: 7 });
    });

    it('reaches structuredContent when enriched from the service layer (loose ctx)', async () => {
      // A service helper that only knows the loose Context shape.
      function runService(ctx: { enrich: (fields: Record<string, unknown>) => void }): string[] {
        ctx.enrich({ totalCount: 99 });
        return ['x'];
      }

      const t = tool('svc_enrich', {
        description: 'Search.',
        input: z.object({ q: z.string().describe('q') }),
        output: z.object({ items: z.array(z.string()).describe('items') }),
        enrichment: { totalCount: z.number().describe('total') },
        handler: (_input, ctx) => ({ items: runService(ctx) }),
      });

      const handler = createToolHandler(t as AnyToolDefinition, services, notifiers);
      const result = await handler({ q: 'x' }, createMockSdkContext());

      expect(result.structuredContent).toEqual({ items: ['x'], totalCount: 99 });
      expect(lastText(result.content)).toContain('99');
    });
  });

  describe('guards and no-op behavior', () => {
    it('fails the effective-output parse when a required enrichment field is never populated', async () => {
      const t = tool('missing_required_enrich', {
        description: 'Search.',
        input: z.object({ q: z.string().describe('q') }),
        output: z.object({ items: z.array(z.string()).describe('items') }),
        enrichment: { totalCount: z.number().describe('required total') },
        handler: () => ({ items: [] }), // never calls ctx.enrich → totalCount missing
      });

      const handler = createToolHandler(t as AnyToolDefinition, services, notifiers);
      const result = await handler({ q: 'x' }, createMockSdkContext());

      // Surfaces as a tool error rather than silently dropping the contract.
      expect(result.isError).toBe(true);
    });

    it('is a silent no-op when enrich is called on a tool with no enrichment block', async () => {
      const t = tool('no_block', {
        description: 'Search.',
        input: z.object({ q: z.string().describe('q') }),
        output: z.object({ items: z.array(z.string()).describe('items') }),
        handler: (_input, ctx) => {
          ctx.enrich({ ignored: 'dropped' }); // no block → nothing reads it
          return { items: ['a'] };
        },
      });

      const handler = createToolHandler(t as AnyToolDefinition, services, notifiers);
      const result = await handler({ q: 'x' }, createMockSdkContext());

      expect(result.structuredContent).toEqual({ items: ['a'] }); // no 'ignored'
      expect(result.content).toHaveLength(1); // domain only — no trailer
    });
  });

  describe('effectiveOutputSchema', () => {
    it('extends output with enrichment when declared, else returns output as-is', () => {
      const withEnrich = tool('with_enrich', {
        description: 'x',
        input: z.object({ q: z.string().describe('q') }),
        output: z.object({ items: z.array(z.string()).describe('items') }),
        enrichment: { totalCount: z.number().describe('total') },
        handler: (_i, ctx) => {
          ctx.enrich.total(1);
          return { items: [] };
        },
      });
      const extended = effectiveOutputSchema(withEnrich as AnyToolDefinition);
      expect(() => extended.parse({ items: [], totalCount: 3 })).not.toThrow();
      expect(Object.keys(extended.shape).sort()).toEqual(['items', 'totalCount']);

      const plain = tool('plain', {
        description: 'x',
        input: z.object({ q: z.string().describe('q') }),
        output: z.object({ items: z.array(z.string()).describe('items') }),
        handler: () => ({ items: [] }),
      });
      expect(effectiveOutputSchema(plain as AnyToolDefinition)).toBe(plain.output);
    });
  });

  describe('createMockContext + getEnrichment', () => {
    it('captures enrichment a handler accumulated for assertion', async () => {
      const t = tool('mock_enrich', {
        description: 'x',
        input: z.object({ q: z.string().describe('q') }),
        output: z.object({ items: z.array(z.string()).describe('items') }),
        enrichment: {
          effectiveQuery: z.string().describe('parsed'),
          totalCount: z.number().describe('total'),
        },
        handler: (input, ctx) => {
          ctx.enrich.echo(input.q);
          ctx.enrich.total(5);
          return { items: [] };
        },
      });

      const ctx = createMockContext();
      await t.handler(t.input.parse({ q: 'hi' }), ctx);
      expect(getEnrichment(ctx)).toEqual({ effectiveQuery: 'hi', totalCount: 5 });
    });

    it('returns an empty object when nothing was enriched', () => {
      const ctx = createMockContext();
      expect(getEnrichment(ctx)).toEqual({});
    });
  });
});

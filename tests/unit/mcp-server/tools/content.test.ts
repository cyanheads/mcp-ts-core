/**
 * @fileoverview Tests for `ctx.content` end-to-end (#239): the handler factory
 * prepends blocks collected via `ctx.content(...)` onto `content[]` after
 * `format()` runs and never places them in `structuredContent` — so a tool can
 * emit image/audio bytes for the calling model without the base64 duplicating
 * into the typed output. Covers the image/audio helpers, the raw-block escape
 * hatch, insertion order, coexistence with the enrichment trailer, the
 * never-called no-op (output byte-identical), the error-path drop, and the
 * `createMockContext`/`getContentBlocks` test surface.
 * @module tests/unit/mcp-server/tools/content.test
 */

import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { makeServerContext } from '../../../helpers/server-context.js';

// ---------------------------------------------------------------------------
// Module mocks — mirror enrichment.test.ts so createToolHandler runs against the
// real createContext (content wiring) with stubbed I/O.
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
import { createMockContext, getContentBlocks } from '@/testing/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * `content[]` of a completed tool result. Narrows off the `input_required`
 * branch of the handler's return union, which carries no `content`.
 */
function blocks(result: Awaited<ReturnType<ReturnType<typeof createToolHandler>>>): ContentBlock[] {
  return (result as CallToolResult).content ?? [];
}

/** A tiny base64 payload (decodes to "hello") — stands in for image/audio bytes. */
const BYTES = 'aGVsbG8=';

/** The default-formatter JSON block for a domain payload. */
function domainJson(payload: unknown): { type: 'text'; text: string } {
  return { type: 'text', text: JSON.stringify(payload, null, 2) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ctx.content', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.mcpSessionMode = 'auto';
  });

  describe('content[] prepend + structuredContent exclusion', () => {
    it('prepends an image block to content[] and keeps the bytes out of structuredContent', async () => {
      const render = tool('render_image', {
        description: 'Render an image.',
        input: z.object({ text: z.string().describe('caption text') }),
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: (_input, ctx) => {
          ctx.content.image(BYTES, 'image/png');
          return { ok: true };
        },
      });

      const handler = createToolHandler(render as AnyToolDefinition, services, notifiers);
      const result = await handler({ text: 'hi' }, makeServerContext());

      expect(result.isError).toBeUndefined();
      // The bytes never enter structuredContent — the whole point of #239.
      expect(result.structuredContent).toEqual({ ok: true });
      // content[] = [image block, domain JSON].
      expect(result.content).toEqual([
        { type: 'image', data: BYTES, mimeType: 'image/png' },
        domainJson({ ok: true }),
      ]);
    });

    it('prepends collected blocks before format() output', async () => {
      const render = tool('render_fmt', {
        description: 'Render with a custom formatter.',
        input: z.object({ text: z.string().describe('caption text') }),
        output: z.object({ caption: z.string().describe('caption') }),
        handler: (input, ctx) => {
          ctx.content.image(BYTES, 'image/png');
          return { caption: input.text };
        },
        format: (r) => [{ type: 'text', text: `Caption: ${r.caption}` }],
      });

      const handler = createToolHandler(render as AnyToolDefinition, services, notifiers);
      const result = await handler({ text: 'a cat' }, makeServerContext());

      expect(result.content).toEqual([
        { type: 'image', data: BYTES, mimeType: 'image/png' },
        { type: 'text', text: 'Caption: a cat' },
      ]);
      expect(result.structuredContent).toEqual({ caption: 'a cat' });
    });

    it('emits an audio block via the audio helper', async () => {
      const speak = tool('speak', {
        description: 'Synthesize speech.',
        input: z.object({ text: z.string().describe('text to speak') }),
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: (_input, ctx) => {
          ctx.content.audio(BYTES, 'audio/mpeg');
          return { ok: true };
        },
      });

      const handler = createToolHandler(speak as AnyToolDefinition, services, notifiers);
      const result = await handler({ text: 'hello' }, makeServerContext());

      expect(blocks(result)[0]).toEqual({ type: 'audio', data: BYTES, mimeType: 'audio/mpeg' });
      expect(result.structuredContent).toEqual({ ok: true });
    });

    it('pushes an arbitrary block via the raw-block escape hatch', async () => {
      const link = tool('link', {
        description: 'Return a resource link.',
        input: z.object({ id: z.string().describe('id') }),
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: (_input, ctx) => {
          ctx.content({
            type: 'resource_link',
            uri: 'https://example.com/report.pdf',
            name: 'report.pdf',
            mimeType: 'application/pdf',
          });
          return { ok: true };
        },
      });

      const handler = createToolHandler(link as AnyToolDefinition, services, notifiers);
      const result = await handler({ id: 'x' }, makeServerContext());

      expect(blocks(result)[0]).toEqual({
        type: 'resource_link',
        uri: 'https://example.com/report.pdf',
        name: 'report.pdf',
        mimeType: 'application/pdf',
      });
      expect(result.structuredContent).toEqual({ ok: true });
    });

    it('accumulates multiple blocks in insertion order, ahead of the domain content', async () => {
      const multi = tool('multi', {
        description: 'Emit several blocks.',
        input: z.object({ n: z.number().describe('n') }),
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: (_input, ctx) => {
          ctx.content.image(BYTES, 'image/png');
          ctx.content.audio(BYTES, 'audio/mpeg');
          return { ok: true };
        },
      });

      const handler = createToolHandler(multi as AnyToolDefinition, services, notifiers);
      const result = await handler({ n: 1 }, makeServerContext());

      expect(result.content).toEqual([
        { type: 'image', data: BYTES, mimeType: 'image/png' },
        { type: 'audio', data: BYTES, mimeType: 'audio/mpeg' },
        domainJson({ ok: true }),
      ]);
    });
  });

  describe('coexistence with enrichment', () => {
    it('orders [content blocks, domain, enrichment trailer] and excludes bytes from structuredContent', async () => {
      const render = tool('render_enriched', {
        description: 'Render with enrichment.',
        input: z.object({ text: z.string().describe('text') }),
        output: z.object({ items: z.array(z.string()).describe('items') }),
        enrichment: { totalCount: z.number().describe('total') },
        handler: (_input, ctx) => {
          ctx.content.image(BYTES, 'image/png');
          ctx.enrich.total(3);
          return { items: ['a'] };
        },
      });

      const handler = createToolHandler(render as AnyToolDefinition, services, notifiers);
      const result = await handler({ text: 'hi' }, makeServerContext());

      const content = result.content as Array<{ type: string; text?: string }>;
      // [image block, domain JSON, enrichment trailer].
      expect(content).toHaveLength(3);
      expect(content[0]).toEqual({ type: 'image', data: BYTES, mimeType: 'image/png' });
      expect(JSON.parse(content[1]!.text!)).toEqual({ items: ['a'] }); // domain only — no enrichment, no bytes
      expect(content[2]!.text).toContain('3 total'); // enrichment trailer last
      // structuredContent carries the enrichment merge but never the base64.
      expect(result.structuredContent).toEqual({ items: ['a'], totalCount: 3 });
    });
  });

  describe('no-op and error path', () => {
    it('leaves content[] and structuredContent unchanged when ctx.content is never called', async () => {
      const plain = tool('plain', {
        description: 'No content blocks.',
        input: z.object({ text: z.string().describe('text') }),
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: () => ({ ok: true }),
      });

      const handler = createToolHandler(plain as AnyToolDefinition, services, notifiers);
      const result = await handler({ text: 'hi' }, makeServerContext());

      // Byte-identical to pre-#239: structuredContent is the domain output, content[] is domain-only.
      expect(result.structuredContent).toEqual({ ok: true });
      expect(result.content).toEqual([domainJson({ ok: true })]);
    });

    it('drops collected blocks when the handler throws (the error path never reads the store)', async () => {
      const failing = tool('failing', {
        description: 'Emit a block, then throw.',
        input: z.object({ text: z.string().describe('text') }),
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: (_input, ctx) => {
          ctx.content.image(BYTES, 'image/png');
          throw new Error('boom');
        },
      });

      const handler = createToolHandler(failing as AnyToolDefinition, services, notifiers);
      const result = await handler({ text: 'hi' }, makeServerContext());

      expect(result.isError).toBe(true);
      // Only the error text block — the partial image is dropped, not half-emitted.
      const content = result.content as Array<{ type: string; data?: string }>;
      expect(content.every((b) => b.type !== 'image')).toBe(true);
    });
  });

  describe('createMockContext + getContentBlocks', () => {
    it('captures the blocks a handler emitted for assertion', async () => {
      const render = tool('mock_content', {
        description: 'Render.',
        input: z.object({ text: z.string().describe('text') }),
        output: z.object({ ok: z.boolean().describe('ok') }),
        handler: (_input, ctx) => {
          ctx.content.image(BYTES, 'image/png');
          return { ok: true };
        },
      });

      const ctx = createMockContext();
      await render.handler(render.input.parse({ text: 'hi' }), ctx);
      expect(getContentBlocks(ctx)).toEqual([
        { type: 'image', data: BYTES, mimeType: 'image/png' },
      ]);
    });

    it('returns an empty array when no blocks were emitted', () => {
      expect(getContentBlocks(createMockContext())).toEqual([]);
    });
  });
});

/**
 * @fileoverview `renderToolContent` — the content[] rendering shared by the
 * tool handler pipeline and the test kit's `runToolContract`.
 * @module tests/unit/mcp-server/tools/utils/renderToolContent.test
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AnyToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { renderToolContent } from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { createMockContext } from '@/testing/index.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

const output = z.object({ ok: z.boolean().describe('ok') });

describe('renderToolContent', () => {
  it('falls back to pretty-printed JSON when the definition has no format()', () => {
    const def = tool('plain', {
      description: 'No formatter.',
      input: z.object({}),
      output,
      handler: () => ({ ok: true }),
    });

    expect(renderToolContent(def as AnyToolDefinition, { ok: true }, createMockContext())).toEqual([
      { type: 'text', text: JSON.stringify({ ok: true }, null, 2) },
    ]);
  });

  it('prepends blocks collected via ctx.content ahead of the formatted text', () => {
    const def = tool('media', {
      description: 'Formats.',
      input: z.object({}),
      output,
      handler: () => ({ ok: true }),
      format: () => [{ type: 'text', text: 'done' }],
    });
    const ctx = createMockContext();
    ctx.content.image('AAAA', 'image/png');

    const content = renderToolContent(def as AnyToolDefinition, { ok: true }, ctx);

    expect(content.map((block) => block.type)).toEqual(['image', 'text']);
  });

  it('wraps a formatter failure as InternalError and keeps the original as cause', () => {
    const formatterError = new Error('formatter exploded');
    const def = tool('boom', {
      description: 'Throws while formatting.',
      input: z.object({}),
      output,
      handler: () => ({ ok: true }),
      format: () => {
        throw formatterError;
      },
    });

    let thrown: unknown;
    try {
      renderToolContent(def as AnyToolDefinition, { ok: true }, createMockContext());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(McpError);
    const error = thrown as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(error.message).toBe('Output formatting failed: formatter exploded');
    expect(error.cause).toBe(formatterError);
  });
});

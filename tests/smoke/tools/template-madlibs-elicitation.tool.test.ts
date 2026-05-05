/**
 * @fileoverview Tests for the Mad Libs elicitation tool.
 * @module tests/examples/tools/template-madlibs-elicitation.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { madlibsElicitationTool } from '../../../examples/mcp-server/tools/definitions/template-madlibs-elicitation.tool.js';

describe('madlibsElicitationTool', () => {
  it('generates story with all inputs provided', async () => {
    const ctx = createMockContext();
    const input = madlibsElicitationTool.input.parse({
      noun: 'cat',
      verb: 'jumped',
      adjective: 'fluffy',
    });
    const result = await madlibsElicitationTool.handler(input, ctx);
    expect(result.story).toBe('The fluffy cat jumped over the lazy dog.');
    expect(result.noun).toBe('cat');
    expect(result.verb).toBe('jumped');
    expect(result.adjective).toBe('fluffy');
  });

  it('throws ServiceUnavailable when elicitation is unavailable and inputs missing', async () => {
    const ctx = createMockContext();
    const input = madlibsElicitationTool.input.parse({});
    const err = await Promise.resolve(madlibsElicitationTool.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
  });

  it('elicits missing words from user', async () => {
    const elicitFn = vi.fn().mockResolvedValue({
      action: 'accept',
      content: { value: 'elicited-word' },
    });
    const ctx = createMockContext({ elicit: elicitFn });
    const input = madlibsElicitationTool.input.parse({});
    const result = await madlibsElicitationTool.handler(input, ctx);
    expect(elicitFn).toHaveBeenCalledTimes(3);
    expect(result.noun).toBe('elicited-word');
    expect(result.verb).toBe('elicited-word');
    expect(result.adjective).toBe('elicited-word');
  });

  it('throws ValidationError when user declines elicitation', async () => {
    const ctx = createMockContext({
      elicit: vi.fn().mockResolvedValue({ action: 'decline' }),
    });
    const input = madlibsElicitationTool.input.parse({});
    const err = await Promise.resolve(madlibsElicitationTool.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { partOfSpeech: 'noun', action: 'decline' },
    });
  });

  it('formats output as story and JSON', () => {
    const result = {
      story: 'The big dog ran over the lazy dog.',
      noun: 'dog',
      verb: 'ran',
      adjective: 'big',
    };
    const blocks = madlibsElicitationTool.format!(result);
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as { text: string }).text).toBe(result.story);
    expect((blocks[1] as { text: string }).text).toContain('"noun": "dog"');
  });
});

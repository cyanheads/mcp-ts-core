/**
 * @fileoverview Tests for the Mad Libs multi-round-trip input tool.
 * @module tests/smoke/tools/template-madlibs-elicitation.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  expectInputRequired,
  type MockContextOptions,
} from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { madlibsElicitationTool } from '../../../examples/mcp-server/tools/definitions/template-madlibs-elicitation.tool.js';

type ToolInput = Parameters<typeof madlibsElicitationTool.handler>[0];

/** An accepted `elicitation/create` response as a retried request carries it. */
const accepted = (value: string) => ({ action: 'accept', content: { value } });

/** Invokes the handler with a context typed against the tool's `errors[]` contract. */
async function runHandler(input: ToolInput, options: Omit<MockContextOptions, 'errors'> = {}) {
  const ctx = createMockContext({ ...options, errors: madlibsElicitationTool.errors });
  return await madlibsElicitationTool.handler(input, ctx);
}

describe('madlibsElicitationTool', () => {
  it('generates story with all inputs provided', async () => {
    const input = madlibsElicitationTool.input.parse({
      noun: 'cat',
      verb: 'jumped',
      adjective: 'fluffy',
    });
    const result = await runHandler(input);
    expect(result.story).toBe('The fluffy cat jumped over the lazy dog.');
    expect(result.noun).toBe('cat');
    expect(result.verb).toBe('jumped');
    expect(result.adjective).toBe('fluffy');
  });

  it('requests every missing part on the first round', async () => {
    const input = madlibsElicitationTool.input.parse({});
    const result = await expectInputRequired(() => runHandler(input));

    expect(result.resultType).toBe('input_required');
    expect(Object.keys(result.inputRequests ?? {})).toEqual(['noun', 'verb', 'adjective']);
    expect(result.inputRequests?.noun).toMatchObject({
      method: 'elicitation/create',
      params: {
        message: 'I need a noun. Please provide one below.',
        mode: 'form',
        requestedSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      },
    });
  });

  it('requests only the parts the input omitted', async () => {
    const input = madlibsElicitationTool.input.parse({ noun: 'cat' });
    const result = await expectInputRequired(() => runHandler(input));
    expect(Object.keys(result.inputRequests ?? {})).toEqual(['verb', 'adjective']);
  });

  it.each([
    [{}, 'Or call again with noun, verb, and adjective supplied.'],
    [{ noun: 'cat' }, 'Or call again with verb and adjective supplied.'],
    [{ noun: 'cat', verb: 'ran' }, 'Or call again with adjective supplied.'],
  ])(
    'offers the parts it asked for as the capability-refusal fallback for %j',
    async (args, fallbackHint) => {
      // The refusal a client without elicitation gets is shaped by the framework's
      // gate; what the tool owns is the sentence naming the arguments that can
      // stand in for the answers it asked for.
      const ctx = createMockContext({ errors: madlibsElicitationTool.errors });
      const requestInput = vi.spyOn(ctx, 'requestInput');

      const result = await expectInputRequired(() =>
        madlibsElicitationTool.handler(madlibsElicitationTool.input.parse(args), ctx),
      );

      expect(requestInput).toHaveBeenCalledTimes(1);
      expect(requestInput.mock.calls[0]?.[1]).toEqual({ fallbackHint });
      // The option shapes a refusal only; it never rides the input_required result.
      expect(JSON.stringify(result)).not.toContain('call again');
    },
  );

  it('treats an empty string from a form-based client as not supplied', async () => {
    const input = madlibsElicitationTool.input.parse({ noun: '', verb: 'ran', adjective: 'big' });
    const result = await expectInputRequired(() => runHandler(input));
    expect(Object.keys(result.inputRequests ?? {})).toEqual(['noun']);
  });

  it('completes the story from the responses carried by the retried request', async () => {
    const input = madlibsElicitationTool.input.parse({});
    const result = await runHandler(input, {
      inputResponses: {
        noun: accepted('aardvark'),
        verb: accepted('vaulted'),
        adjective: accepted('sleepy'),
      },
    });

    expect(result.story).toBe('The sleepy aardvark vaulted over the lazy dog.');
    expect(result).toMatchObject({ noun: 'aardvark', verb: 'vaulted', adjective: 'sleepy' });
  });

  it('re-requests a part whose response failed the answer schema', async () => {
    const input = madlibsElicitationTool.input.parse({ verb: 'ran', adjective: 'big' });
    // `value` is `.min(1)`, so an empty string is not usable content.
    const result = await expectInputRequired(() =>
      runHandler(input, { inputResponses: { noun: accepted('') } }),
    );
    expect(Object.keys(result.inputRequests ?? {})).toEqual(['noun']);
  });

  it('fails with input_declined when the user declines a prompt', async () => {
    const input = madlibsElicitationTool.input.parse({});
    const run = runHandler(input, { inputResponses: { noun: { action: 'decline' } } });

    await expect(run).rejects.toBeInstanceOf(McpError);
    await expect(run).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidRequest,
      data: {
        reason: 'input_declined',
        partOfSpeech: 'noun',
        action: 'decline',
        recovery: { hint: expect.stringContaining('accept the prompt') },
      },
    });
  });

  it('fails with input_declined when the user cancels a prompt', async () => {
    const input = madlibsElicitationTool.input.parse({ noun: 'cat' });
    await expect(
      runHandler(input, { inputResponses: { verb: { action: 'cancel' } } }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidRequest,
      data: {
        reason: 'input_declined',
        partOfSpeech: 'verb',
        action: 'cancel',
        recovery: { hint: expect.stringContaining('accept the prompt') },
      },
    });
  });

  it('formats the story and every word as markdown', () => {
    const result = {
      story: 'The big dog ran over the lazy dog.',
      noun: 'dog',
      verb: 'ran',
      adjective: 'big',
    };
    const blocks = madlibsElicitationTool.format!(result);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain(result.story);
    expect(text).toContain('**Noun:** dog');
    expect(text).toContain('**Verb:** ran');
    expect(text).toContain('**Adjective:** big');
  });
});

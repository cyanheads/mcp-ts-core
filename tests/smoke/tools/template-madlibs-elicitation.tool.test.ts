/**
 * @fileoverview Tests for the Mad Libs multi-round-trip input tool.
 * @module tests/examples/tools/template-madlibs-elicitation.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, type MockContextOptions } from '@cyanheads/mcp-ts-core/testing';
import type { InputRequiredResult } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { isInputRequiredSignal } from '@/mcp-server/inputRequired.js';
import { madlibsElicitationTool } from '../../../examples/mcp-server/tools/definitions/template-madlibs-elicitation.tool.js';

type ToolInput = Parameters<typeof madlibsElicitationTool.handler>[0];

/** An accepted `elicitation/create` response as a retried request carries it. */
const accepted = (value: string) => ({ action: 'accept', content: { value } });

async function runHandler(input: ToolInput, options: MockContextOptions = {}) {
  return await madlibsElicitationTool.handler(input, createMockContext(options));
}

/**
 * Runs the handler expecting it to ask for more input, and returns the
 * `input_required` result the handler factory would send back to the client.
 */
async function requestedInput(
  input: ToolInput,
  options: MockContextOptions = {},
): Promise<InputRequiredResult> {
  try {
    await runHandler(input, options);
  } catch (error) {
    if (isInputRequiredSignal(error)) return error.result;
    throw error;
  }
  throw new Error('Expected the handler to request input.');
}

/** Runs the handler expecting a domain failure, and returns the thrown error. */
async function thrownError(input: ToolInput, options: MockContextOptions = {}): Promise<unknown> {
  try {
    await runHandler(input, options);
  } catch (error) {
    return error;
  }
  throw new Error('Expected the handler to throw.');
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
    const result = await requestedInput(input);

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
    const result = await requestedInput(input);
    expect(Object.keys(result.inputRequests ?? {})).toEqual(['verb', 'adjective']);
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
    const result = await requestedInput(input, {
      inputResponses: { noun: accepted('') },
    });
    expect(Object.keys(result.inputRequests ?? {})).toEqual(['noun']);
  });

  it('throws ValidationError when the user declines a prompt', async () => {
    const input = madlibsElicitationTool.input.parse({});
    const error = await thrownError(input, { inputResponses: { noun: { action: 'decline' } } });

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { partOfSpeech: 'noun', action: 'decline' },
    });
  });

  it('throws ValidationError when the user cancels a prompt', async () => {
    const input = madlibsElicitationTool.input.parse({ noun: 'cat' });
    const error = await thrownError(input, { inputResponses: { verb: { action: 'cancel' } } });

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        partOfSpeech: 'verb',
        action: 'cancel',
        recovery: { hint: expect.stringContaining('cannot prompt the user mid-call') },
      },
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
